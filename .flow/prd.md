# PRD：M2 正式 MVP — XLSX/Parquet + 模式 A 可信聚合发布 + 授权与审计

> 事实源：`.flow/proposal.md`（v1.0，§4.2/§6.7/§10/§11/§13.2/§14 为 M2 权威条款）+ `.flow/red-team.md`（M2 聚焦）。
> 基线：M0/M1 已交付（db70d28）。本 PRD 只做 M2 增量，不重开已定决策（G1–G16 继续有效）。

## Problem Statement

模式 S 让计算留在本地，但模型永远无法解读真实结果——用户只能把聚合数字手工粘进对话：不受控、无审计、绕过工具全部边界承诺，"明确的数据边界"在最需要的地方失效。同时 CSV-only 挡住了大量真实业务文件（xlsx/Parquet）。

## Solution

1. **文件支持补全（F01）**：register/profile/execute 全链路接受 CSV、规范表格型 `.xlsx`、Parquet；病态文件（空表头/重复列名/合并单元格错位/宏）显式拒绝且报错可懂。
2. **模式 A 可信聚合发布**：`PublicationPlan`（YAML 草案→用户批准）→ 可信发布服务在**同版本数据上按模板重算**（绝不采信任意 Python 输出）→ 策略校验（维度白名单/最小主体数/行数上限/数值精度/禁自由文本）→ 本地预览 → 显式授权（绑定载荷摘要+数据版本+目标模型+策略版本+次数+期限）→ `ModelSafeEnvelope` 经唯一出站网关发送 → 模型解释回复只落本地与审计。
3. **授权生命周期（P08/P10）**：撤消、过期、次数上限、替换检测——任一失配即阻断，不回退。
4. **补 M1 披露项**：任务取消（未运行态 cancel + 会话 SIGINT 终止内核）、F02 机检扩展（日期/金额口径）、matplotlib 共享字体缓存。

## User Stories

1. As a 数据分析人员, I want 登记规范 `.xlsx` 与 Parquet 文件并走完整模式 S 闭环, so that 不必先转 CSV。
2. As a 数据分析人员, I want 病态表格（空表头/重复列/合并单元格）被明确拒绝并指出问题, so that 不会在错位数据上得出看似成功的错误结果。
3. As a 隐私敏感用户, I want 在一份可编辑的发布计划草案上定义指标/维度/主体字段/最小主体数, so that 出境内容在我批准前完全确定。
4. As a 隐私敏感用户, I want 发布预览逐值展示将外发的聚合结果与被压制的分组, so that 维度值（如品类名）的暴露是逐值知情的。
5. As a 隐私敏感用户, I want 授权绑定载荷摘要、数据版本、目标模型与期限, so that 任何替换（P08）都会让旧授权失效。
6. As a 隐私敏感用户, I want 撤销授权后一切后续发送立即停止（P10）, so that 失误授权可止血（已发送内容无法收回，工具如实说明）。
7. As a 数据分析人员, I want 模型只依据已发布证据给出解释且解释落本地/审计, so that 不会出现"模型声称读了未发布数据"。
8. As a 数据分析人员, I want 单人分组/重复行冒充主体数被压制或阻断（P07）, so that 小群体不被变相曝光。
9. As a 任何用户, I want 把明细伪装成聚合或编码进数字的尝试在网关被结构性拒绝（P06）, so that "聚合"通道不开后门。
10. As a 任何用户, I want 未运行任务可取消、会话可中断且状态真实, so that 误操作不必跑完。
11. As a 隐私敏感用户, I want 日期/金额字段的口径（F02）在确认与发布时被机检, so that 时间边界与精度错误不静默通过。
12. As a 开发者, I want 发布审计可查每次发送的计划摘要/载荷哈希/目标/结果, so that 多次发布的组合暴露可人工复盘。

## Implementation Decisions

**范围**：M2 = 发布管道 + F01 全量 + F02 机检 + 取消 + 共享字体缓存。SQL 发布模板、跨数据集 join 发布、组合差分查询自动防护（§6.7 本版已声明不承诺）、GUI → 后置。

**文件格式**：xlsx = `pandas.read_excel(dtype=str, sheet_name=0)` + openpyxl（新依赖）；Parquet = DuckDB `read_parquet` → `.df()` → `astype(str)`（**不引 pyarrow**）。读取前预检：表头非空、列名唯一、首行非全空；失败给格式专项错误。`ctx.datasets` 与 profiler 按扩展名分发，契约不变（DataFrame dtype=str）。

**首批发布模板**（§13.2「已定义指标与聚合模板」的落地）：
- 聚合：`sum` / `count` / `count_distinct` / `avg`（field 必须在批准卡内）。
- 维度：批准卡内字段 + 唯一内置派生维 `month(<date_field>)`（§12 需要；不开放任意表达式）。
- 筛选：`field in [...]` / `eq` / `between`（值由用户书写）。
- 同计划多指标（§12 三指标一次发布）。

**PublicationPlan（YAML 草案→approve）**：`purpose / datasets / target_model / subject_field / min_subjects(默认5) / max_sends(1–10) / expires_hours(1–168, 默认24) / precision(0–6, 默认2) / metrics[] / dimensions[] / filters[]`。plan 经 canonical-JSON sha256 作为 `plan_digest`（=策略版本）。

**可信发布服务**：新 worker 模块 `worker/publish.py`——纯模板执行器（pandas），沙箱内一次性运行，输入 `{datasets:{alias:{path,version}}, plan}`，输出结构化 JSON：每指标按维度分组值 + 每组 `subject_count`（按 subject_field 去重）+ `suppressed_group_count`（主体数 < min_subjects 的组被丢弃并计数）。绝不执行模型生成代码，绝不读 worker 其他输出。

**Host 策略校验（prepare 阶段，先于预览）**：维度⊆卡列（或 month() 作用于日期样列）、指标字段存在、subject_field 在卡内、行数上限（默认 200）、精度与数值类型（metric 值仅数字）、维度值 string≤64 字符且无换行、禁自由文本字段。任一失败 → `blocked` + 原因（§11.4：发布被阻断≠分析失败）。

**发布状态机（§11.3）**：`local_only → prepared → awaiting_approval → sent / blocked / expired`，存 `publications` 表。

**授权（approvals 表）**：`prepare` 产候选包与预览 → 用户 `approve` 绑定：`payload_sha256`（canonical-JSON、键排序——防键序漂移绕过）、`data_versions`、`target_model`、`plan_digest`、`max_sends`、`expires_at`、`sent_count`、`revoked_at`。**发送时逐项复验**：现场重算摘要、重哈希数据文件、比对目标模型与当前 env、过期/撤销/次数检查——任一失配 → 阻断（默认拒绝，P08/P10）。

**模式 A 信封（egress gateway 新增 `completeModeA`）**：`{system(模式 A 解释契约), user_goal(=purpose), datasets(批准卡), allowed_libraries, publication{plan_digest, metrics 分组值, suppressed_group_count, subject_field, min_subjects, data_versions, generated_at}, authorization{approval_id, payload_sha256}}`。`assertEnvelopeIsModeA` 严格形状：metric 值仅数字、维度键/值受限字符串、其余字段固定标签——结构上不存在自由文本槽位（P06：任意 Python 输出无路径进入）。模型解释回复：存审计与 publication 记录、终端展示，**不做自动多轮**（M2 单次；多次发送=人工再触发且计入 max_sends）。

**取消**：`xanthil cancel <taskId>`（awaiting_confirmation/ready → cancelled）；session 命令装 SIGINT 处理器终止内核并如实置任务状态。

**F02 机检**：profiler 全量扫描判定日期样列（解析率≥99%）；卡新增可选 `checks{date_fields[], amount_fields[], precision}`——approve 校验字段存在与类型；发布取 plan.precision（缺省继承卡 checks）。

**共享字体缓存**：`MPLCONFIGDIR` 指向 workspace 级 `tmp-mpl/`（纳入沙箱可写与读例外），首渲 ~8s 只付一次。

**预算**：模式 A 调用复用网关三线（轮次不适用=单次、单调用超时、会话墙钟）+ max_sends 硬顶。

**审计**：`model_calls` 增加 purpose=`mode_a_publication`；publication JSONL 全文落 `logs/egress/`（与模式 S 同库同构，P09 分离原则不变）。

## Testing Decisions

- 接缝不变：模型边界（FixtureProvider 捕获）／隔离后端／CLI e2e；发布管道加**可信发布服务模块接缝**（worker 单测：模板计算、主体计数、压组、精度）。
- F01：三类病态 xlsx（空表头/重复列/合并单元格）+ Parquet 往返（duckdb 写→读）端到端。
- P06：对抗——伪 `aggregate=true` 输出、非白名单维度、自由文本字段、数字编码字符串全部在网关断言层被拒。
- P07：单人分组（subject=1）被压制且计数入信封；重复行不抬 subject_count（去重测试）。
- P08：批准后换目标模型/改数据/等过期/重放他人 approval → 全部 blocked；键序重排不改摘要（canonical 化测试）。
- P10：revoke 后 send 被 blocked；sent_count 达 max_sends 后 blocked。
- 快照复现：publication 记录含 data_versions + plan_digest，重放可核对。
- 既有 26+21 测试保持全绿（回归即范围护栏）。

## Out of Scope（后置 M3+）

SQL/自定义表达式发布模板、跨数据集 join 发布、组合差分查询自动防护（审计+人工复盘，§6.7 声明）、模式 A 自动多轮解释、GUI/授权界面图形化、Desktop 集成、xlsx 宏/多表头自动理解（显式拒绝即可）。

## Further Notes

**验收映射**：F01（全量）、F02（机检扩展）、P06、P07、P08、P10、P11（扩展至模式 A 形状默认拒绝）、§13.2「文件支持/模型协作（模式 A 单独授权）/结果发布（模板可信发布）/审计」行、§11.3 发布状态机、§11.4「聚合包不符合政策→保留本地结果+解释原因」。
**AGENT-RUNTIME**：模式 A 仍为工人模式单次调用；无新偏离。
**红队缓解**：KA-M2-1 由 §12 三指标 e2e 测试直接裁决；KA-M2-2 由 P06 对抗套件；KA-M2-3 由病态 xlsx 测试；KA-M2-4 由 P08/P10 用例；KA-M2-5 由本 PRD Out of Scope 硬边界控制。

---

## GRILL Resolved Decisions（M2 自拷问决议，2026-09-30）

> proposal 已定决策为约束；以下仅覆盖 M2 留白，全部自答推荐制，无冲突不升级。

- **H1 xlsx 工作表**：仅读第一个表；LocalProfile 记录全部 sheet 名（本地信息）并在多表时提示。
- **H2 Parquet 嵌套类型**：register/profile 预检拒绝 list/struct 列（报错指明列名），不做展开。
- **H3 维度基数护栏**：prepare 时任一维度去重值 >50 → blocked（防 order_id 被误选为维度变相泄露明细；配合 min_subjects 双保险）。
- **H4 month() 派生**：`pd.to_datetime(str).dt.strftime('%Y-%m')`；该列日期解析率不足（F02 机检）→ blocked。
- **H5 解释回复去向**：终端打印 + 存 publication 记录与审计 JSONL；`xanthil publication show <id>` 可复查。
- **H6 命令族**：`publish plan <alias>`（产草案 YAML）→ `publish prepare`（校验+重算+预览，态 prepared）→ `publish approve <pubId>` → `publish send <pubId>` → `publish revoke <pubId>`；`publications` 列表。文件在 `.xanthil/publications/`。
- **H7 target_model 校验**：approve 声明字符串；send 时与 `XANTHIL_LLM_MODEL`（或 fixture 标识 `fixture`）比对，未配置/不匹配 → blocked（P08）。
- **H8 双摘要**：`plan_digest`=计划 canonical-JSON sha256（策略版本）；`payload_sha256`=可信重算输出 canonical-JSON sha256。**send 时现场重跑可信重算并比对 payload_sha256**——重算不一致即阻断（防数据/模板漂移，P06/P08 核心）。
- **H9 fixture**：模式 A 发送消耗 fixture 一轮（解释回复），沿既有跨进程消费状态。
- **H10 卡扩展 `checks`**：schema 卡新增可选键 `checks{date_fields[], amount_fields[], precision}`——仅字段名与整数，形状校验后允许进入信封（无值无自由文本）。
- **H11 取消边界**：cancel 仅覆盖未运行态；session（异步路径）装 SIGINT 终止内核；一次性 `run` 为同步阻塞进程，Ctrl-C 可能遗留沙箱子进程——如实写入 README 已知限制（概率低、无外发通道）。
- **H12 共享 mpl 缓存**：`<workspace>/tmp-mpl/`，init 创建；runIsolated 增补 extraWritableDirs 透传（kernel 已有），并列入读例外。

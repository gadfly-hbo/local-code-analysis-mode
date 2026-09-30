# PRD：Xanthil 本地化数据处理工具 — M0 边界验证 + M1 CSV 核心闭环

> 事实源：`.flow/proposal.md`（产品方案 v1.0，优先级最高）+ `.flow/red-team.md`。
> 本 PRD 只细化、不推翻 proposal 决策；工程范围收窄为方案 §17.1 的 **M0 + M1**（CSV-only）。
> 无项目 issue tracker（空项目），按 dev-flow 降级规则写入本文件。

## Problem Statement

数据分析与业务人员需要云端大模型帮忙编写分析代码，但不愿意让交易明细、客户信息等业务数据进入模型上下文。现有做法只能二选一：把数据（或样本）上传给模型换取消费级洞察，或者放弃模型辅助手工写 Python/SQL。同时，「不上传」的承诺无法被用户核验——工具输出、报错、图表随时可能把真实数据带出去。用户需要一个能核验「模型到底收到了什么」的本地分析工具。

## Solution

一个本地优先的 CLI 工具：用户登记本地 CSV → 本地画像与表结构确认（Schema 卡）→ 云端模型**只拿到获准的结构与口径**（模式 S）生成 Python 分析代码 → Host 审核后在受限隔离的 Python Worker 中对真实数据执行 → 结果/图表/明细只落本地工件库 → 全部模型出站经唯一网关并留可核对审计。第二轮分析复用同一持久内核中的数据句柄与变量（M1）。核心承诺可被对抗测试验证：模型上下文里除获准结构外没有任何数据派生值。

## User Stories

1. As a 数据分析人员, I want 登记一个本地 CSV 并获得逻辑别名（如 `dataset://sales`）, so that 后续分析引用稳定标识而不暴露绝对路径。
2. As a 数据分析人员, I want 工具本地推断字段类型并允许我修正（含前导零 ID、日期格式）, so that 模型生成代码时用的是正确类型而非碰运气的猜测。
3. As a 数据分析人员, I want 在一份可编辑的 Schema 卡草案上确认行粒度、金额口径、主键与去重规则, so that 模型不会用错分母或重复计数。
4. As a 隐私敏感用户, I want 完整本地画像（行数、空值、分布）只存在本地, so that 统计信息不会随结构信息一起发给模型。
5. As a 隐私敏感用户, I want 每次模型调用前能查看「模型将收到什么」的准确内容, so that 我不需要信任一句「不上传」的口号。
6. As a 数据分析人员, I want 用自然语言描述分析目标并得到模型生成的 pandas/DuckDB 代码与执行计划, so that 不必手写完整脚本。
7. As a 数据分析人员, I want 在执行前查看并确认分析计划（数据范围、口径、代码）, so that 高风险操作不会静默发生。
8. As a 数据分析人员, I want 代码在本地受限 Worker 中执行且源文件只读, so that 原始数据不会被覆盖或外传。
9. As a 数据分析人员, I want 执行超时/取消/失败时看到真实原因而非伪造的成功, so that 我能判断结果可信度。
10. As a 数据分析人员, I want 失败时模型只收到结构性诊断（字段不存在、语法错误、缺库名）, so that 修复循环不泄露单元格值或 traceback。
11. As a 数据分析人员, I want 修复循环有轮次上限（默认 3 轮）, so that 不会无限烧钱重试。
12. As a 数据分析人员, I want 结果表、图表、明细只在本地查看与导出, so that 本地可见不等于模型可见。
13. As a 数据分析人员, I want 同一会话第二轮分析复用已加载数据与中间变量（M1 持久内核）, so that 「换个维度看」不需要重新读文件重算。
14. As a 数据分析人员, I want 数据文件变化后旧结果与旧内核状态被标记失效, so that 不会拿旧数据解释新问题。
15. As a 隐私敏感用户, I want 内核输出（stdout/stderr/异常/富媒体）永不自动进入模型上下文, so that `print(df)` 不会变成数据泄漏通道。
16. As a 隐私敏感用户, I want 一条审计记录展示每次模型调用的完整出入站载荷摘要, so that 任何外发都可事后核对。
17. As a 隐私敏感用户, I want Worker 进程默认无网络、文件访问限于授权输入与任务输出目录, so that 生成代码即使恶意也无法外传或越权读取。
18. As a 隐私敏感用户, I want 隔离后端先通过逃逸自检（联网/越权读/越权写）再被允许执行真实数据, so that 未验证的平台不会静默承担敏感数据。
19. As a 开发者, I want 工件（清洗表/汇总表/图表/代码/执行记录）带执行 ID、数据版本、敏感等级登记, so that 结果可追溯可复现。
20. As a 开发者, I want 用合成标记数据跑对抗测试验证「模型上下文无数据派生值」, so that 隐私声明有工程证据。
21. As a 开发者, I want 模型层可用夹具回放（record→replay）跑全部测试, so that 测试不依赖真实 API 与费用。
22. As a 开发者, I want Host 与 Worker 是不同进程、Worker 拿不到模型密钥, so that 受限侧即使被攻陷也偷不到凭据。
23. As a 任何用户, I want DuckDB 在 Worker 内被加固（禁扩展自动加载/安装、禁远程文件系统）, so that 生成 SQL 无法借 SQL 通道逃逸。
24. As a 任何用户, I want 导出（结果文件/代码/执行记录）是显式操作, so that 导出行为与模型授权是两件事。
25. As a 任何用户, I want 无凭据/无网络时已确认的代码仍可本地执行, so that 模型服务不可用不阻塞本地计算。

## Implementation Decisions

**范围**：本 flow 交付方案 §17.1 的 M0（合成数据全链路 + 出站捕获证据）与 M1 的最小核心（Dataset Catalog、持久内核、任务契约、本地结果与基础校验）。CSV-only；XLSX/Parquet、模式 A 可信发布、授权界面、Desktop 适配全部后置（见 Out of Scope）。

**仓库形态**：monorepo，两种语言两个包：
- `host/`（TypeScript，Node ≥22）：CLI、Egress Gateway、Dataset Catalog、任务契约、审计、Worker 编排。技术栈遵循全局 AGENT-RUNTIME 标准。
- `worker/`（Python ≥3.12，uv 管理）：受限执行侧运行时（pandas + DuckDB + matplotlib），由 Host 作为子进程拉起。
- 顶层由一个统一 verify 脚本串联两侧测试。

**模型接入（遵守 AGENT-RUNTIME v1.0）**：
- 形态为**工人模式**：流程可预先画出（schema 上下文 → 单次生成 → schema 校验输出），无 agent 循环、无模型工具调用、无模型自批。命中标准 §5 决策矩阵第①分支。
- 批准栈 `@earendil-works/pi-ai` **钉死 0.86.1**，进程内使用；全部依赖收敛在 `host/src/llm/` 适配层，业务代码零直接 import（§4.1）。
- **Egress Gateway 即适配层**：所有模型调用只经此处。职责：按模式 S 装配上下文（仅获准 Schema 卡 + 用户目标 + 结构性诊断白名单）、校验出站载荷、限请求体、写审计事件。PI 风格的供应商怪癖在适配层收敛。
- **预算三线封顶**（§P4）：修复轮次上限（默认 3）、单调用超时、会话墙钟上限；可配置。
- **审计**（§P5）：每次模型调用（入站上下文、出站请求、响应、阻断原因）落 SQLite + JSONL 双记录，可回放。
- **夹具回放**（§P6）：`FixtureProvider` 实现与真实 Provider 同一接口，测试 100% 走夹具；真实调用仅手动冒烟。
- 凭据经环境变量注入，仅 Host 进程持有；Worker 环境变量白名单不含任何密钥。

**模式 S 执行语义**：
- 模型输出 = 结构化 `AnalysisTaskSpec`（含代码、口径、校验项）+ 生成代码，JSON schema 校验后才进入确认环节。
- **结构性诊断通道**：Host 将执行失败归类为白名单结构信息（语法错误行号、缺失库名、未注册字段名/数据集别名）才可回传模型；其余（异常值、traceback、stdout）只落本地。
- **内核输出永不进模型上下文**：Worker 的 stdout/stderr/结果对象只写本地工件库与本地日志；这是架构不变量，由 Egress Gateway 的上下文装配白名单保证（默认拒绝任何未登记内容）。

**Dataset Catalog**：SQLite（Host 单写入方）。`dataset_id` + 逻辑别名 + 绝对路径映射（模型只见 `dataset://别名`）+ `sha256` 内容版本 + schema 版本。文件内容变化 → 新版本；任务/结果绑定版本；仅文件名不作为版本判定。源文件只读（以只读方式打开）。

**Schema 卡双对象**：`LocalProfile`（行数/空值/分布/异常值，仅本地）与 `ModelSchemaCard`（别名/类型/语义/粒度/关联，可出站）。profiler 产出草案 YAML，用户编辑后 `approve` 命令固化；抽样推断与全量扫描分开标注。

**Worker 执行与隔离（可插拔后端）**：
- 接口 `IsolationBackend`：为一次执行构造受限进程（网络默认拒绝；读限于注册输入；写限于该 run 输出目录；超时与进程树可杀）。
- darwin 首选后端：`sandbox-exec`（seatbelt profile，已验证本机可用）。Linux 后端占位（后续 bubblewrap/容器）。
- **后端自检门**：每个后端须先通过内置逃逸测试（尝试 HTTP/DNS、读授权外文件、写越界路径、fork 炸弹防护）才被启用；自检失败则该后端不可用于真实数据（方案 §8.2）。
- Worker 内 DuckDB 加固：`SET autoload_known_extensions=false; autoinstall_known_extensions=false`，不注册 httpfs 等远程扩展，仅对注册数据集建视图。
- M0 用一次性 Worker 进程；M1 升级为**持久 Worker 进程 + 最小自有 stdio JSON-RPC 协议**（非 Jupyter 协议——方案 §9.3 明示不必照搬）：execute/interrupt/health/restart/资源统计、变量命名空间跨轮复用、数据版本失效即拒绝访问旧句柄（方案 §11.2）。同会话可变执行串行。

**本地工件库**：workspace 目录（`datasets/` 快照、`artifacts/`、`runs/`、`db.sqlite`、`logs/`）。工件登记含随机 ID、执行 ID、数据版本、类型、敏感等级；引用只是本地句柄。导出为显式命令。HTML/SVG 图表查看为本地文件操作（本 flow 无 GUI 渲染器，安全渲染约束记录为 M2 注意项）。

**CLI（独立形态最小入口）**：`xanthil` 命令族——`init` / `register` / `profile` / `schema approve` / `ask`（目标→计划→代码，含修复轮）/ `confirm` / `run` / `artifacts` / `audit`（查模型实际收到什么）/ `export` / `kernel restart`。交互遵循「确认分析计划」环节（方案 §5.1 第 5 步）。CLI 文案英文，README 双语。

**测试接缝（seams，待用户确认）**：
- **主接缝 = 模型边界**：`FixtureProvider` 捕获全部出站请求 → 断言上下文仅含获准内容（P01/P02/P09 的机制核心）。所有隐私断言都打在这个最高接缝上。
- 次接缝 = 隔离后端边界：逃逸测试直接打 `IsolationBackend`。
- 端到端 = CLI 子进程级（真实文件系统 + 合成 CSV）。
- 不为内部函数造接缝；外部行为优先。

## Testing Decisions

- 只测外部行为：CLI 级端到端、Provider 边界断言、后端逃逸测试；不测内部函数实现细节。
- TS 侧 vitest、Python 侧 pytest；统一 `pnpm verify` 串联（typecheck + lint + 双侧测试），此即 dev-flow VERIFY 命令。
- 隐私对抗测试（合成标记值）：生成含唯一标记（如内嵌随机 canary 字符串/数值）的合成 CSV，运行全链路后断言：全部捕获的模型请求载荷中 canary 零命中（P01/P02 机制版）；审计记录完整（P09 会话恢复不回灌）。
- 隔离逃逸测试（P04/P05 机制版）：Worker 内尝试 `urllib` 联网、读 `~/.ssh`、写工作区外路径——断言全部失败且留本地记录；darwin 后端真实运行，其他平台 skip 并标注。
- 正确性基准（F01–F03/F08 子集，CSV-only）：合成销售数据集（订单行粒度、退款、前导零 ID、混合类型坑），确定性基准值写死在测试里；F05/F06 复用与失效在 M1 内核测试覆盖。
- 夹具：`FixtureProvider` 回放录制的模型响应（含成功计划、缺字段失败、超轮失败三类剧本）；record 模式留手动冒烟脚本。
- 基线：无既有测试（greenfield）。

## Out of Scope（本 flow 不做，后置到对应里程碑）

- XLSX / Parquet 支持与格式专项错误处理（M2，F01 后半）。
- 模式 A 全链路：可信发布服务、发布计划、授权界面、`ModelSafeEnvelope`（M2；本 flow 中 Egress Gateway 对一切数据派生内容**默认拒绝**，即模式 S-only 强制）。
- P06/P07/P08（伪装聚合/主体数/授权替换）依赖发布链路，随 M2 落地。
- Xanthil Desktop 集成、GUI 工作台、安全 HTML 渲染器（M2/M3）。
- polars / scipy / statsmodels / sklearn；性能与内存基准（§14.3）；多工作区并发隔离（P12 仅单工作区进程内保证）。
- 多模型供应商路由、本地模型接入（M4）。
- Linux/Windows 隔离后端实现（接口占位）。

## Further Notes

**验收映射**（本 flow 覆盖 → 方案编号）：F01（CSV 部分）、F02、F03、F04（金额对账基础校验）、F05、F06、F07（取消/超时/崩溃状态真实）、F08（复现）；P01、P02、P03（文件不外发；渲染部分限本地文件）、P04、P05、P09（审计与会话日志分离）、P11（网关默认拒绝）、P12（单工作区内）。
**发布阻断继承**（§17.3 全条适用于本 flow 产出）：任何一条不满足即不得宣称可跑真实敏感数据。
**AGENT-RUNTIME 合规**：工人模式 + 适配层 + 三线预算 + 审计 + 夹具回放 + Worker 外部隔离（§4.7），无偏离项；模型无工具调用面，§8 拴绳闸门不适用。
**红队缓解**：KA1（模式 S 可用性）由 M0 合成基准直接度量并记录成功率；KA2（darwin 隔离）由后端自检门解决（自检不过即禁真实数据）；KA3（范围）由本 PRD 的 Out of Scope 硬边界控制；KA4（凭据）由 FixtureProvider 使测试不依赖真实 key，真实调用留手动冒烟；KA5（内核复杂度）由 M0 一次性进程 → M1 持久化的两步走控制。

---

## GRILL Resolved Decisions（自拷问决议，2026-09-30）

> proposal.md 已记录的决策为约束不重开；以下仅覆盖其留白。全部为自答推荐制（用户预批「全部按推荐」），无 proposal 冲突、无不可逆项，故未升级。

- **G1 CLI 框架与审批交互**：commander；非交互优先——`ask` 产出任务计划（代码+口径+校验项）并落盘打印，`confirm <task>` 显式批准，`run <task>` 只执行已确认任务。理由：审批是显式动作而非回车惯性，且 CI/测试友好。
- **G2 仓库工具链**：pnpm workspace（TS）+ worker/ 独立 uv 项目；TS 侧 ESM + tsc typecheck + tsx 运行 + vitest；biome（TS）与 ruff（Python）做 lint；顶层 `pnpm verify` 串联全部检查（即 dev-flow VERIFY 命令）。
- **G3 Python 版本与依赖钉死**：Python 3.12（uv venv；3.14 过新，数据分析库兼容面 3.12 最稳）；pandas ≥2.2、duckdb ≥1.1、matplotlib（Agg 后端）；两侧 lockfile 均提交。
- **G4 Worker 协议**：NDJSON over stdio（每行一条 JSON：`{id, method, params}` / `{id, ok, result|error}`）。M0 方法集 `execute/health/shutdown`；M1 追加 `interrupt/restart/list-variables/invalidate`。不采用 LSP 式帧（复杂度无收益）。
- **G5 数据句柄注入**：Host 解析「别名→绝对路径」经协议参数传 Worker；Worker bootstrap 预置 `ctx`（`ctx.datasets[别名]` 懒加载 reader + DuckDB 只读视图）后才执行生成代码；代码仅经 ctx 访问数据。落实「只访问登记数据对象」，模型可见代码只含别名。
- **G6 结构性诊断白名单**：Worker 捕获异常→结构化 `{kind: syntax|missing_lib|unknown_dataset|unknown_field|timeout|oom|runtime, safe_detail}`；仅 syntax/missing_lib/unknown_* 附安全细节（符号/库/字段名，字段名须为 Schema 卡登记名），runtime 只报类别不报值；Host 二次过滤后才可进 Egress。
- **G7 seatbelt profile 细节**：deny network*；读允许 = Python 解释器/stdlib/venv + 注册输入 + run 目录；写允许 = 仅 run 目录（含内部 tmp）；`limit process`/`limit-thread` 防 fork 炸弹；附 Darwin 通用加固子句。自检测试跑真实逃逸尝试；过严致库崩溃由功能测试共同验证。
- **G8 数据版本**：M0/M1 = 内容 sha256（proposal 允许「不可变快照或经校验的内容版本」二选一）；`--snapshot` 复制入 workspace 为 M1 可选项、默认关。任务绑定 hash，执行前复验不一致即拒绝（F06）。
- **G9 模型端点配置**：环境变量 `XANTHIL_LLM_BASE_URL/API_KEY/MODEL`；未配置时 `ask` 报错退出（fixture 模式除外）；真实冒烟手动（GLM OpenAI 兼容端点）；密钥不落库、审计不明文。
- **G10 审计存储**：SQLite `model_calls`（id/at/direction/payload_sha256/purpose/outcome）+ `logs/egress/<id>.jsonl` 全文；`audit` 命令查摘要与全文路径。本地日志与模型会话存储物理分离（P09）。
- **G11 默认预算**：修复轮 3；单次模型调用超时 90s；单 ask 墙钟 10min；单次执行超时 120s；内存上限 darwin 尽力（无 cgroups，如实标注）。
- **G12 git init**：IMPLEMENT 首入口 `git init` + 初始提交，使 REVIEW 独立审查可用（review_base 非 null）；dev-flow SHIP 本身授权提交。空仓库新建 git 属标准做法，已明示。
- **G13 仓库级规则**：写仓库根 `AGENTS.md`（verify 命令、双语言栈、隐私不变量、AGENT-RUNTIME 合规要点），供后续会话遵循。
- **G14 canary 对抗测试**：合成 CSV 每行嵌高熵 canary；断言采用**强于 canary 扫描**的精确信封匹配——出站上下文必须逐字段等于获准模板（证明无任何数据派生内容进入）；同时本地审计文件确实含 canary（证明「本地有、模型无」的通道分离）。含 `print(df)` 异常剧本。
- **G15 模式 S 出站信封**：固定四元组 system(角色+输出契约) / 用户目标 / 数据集别名+ModelSchemaCard JSON / 允许库列表（+可选结构性诊断）。出站前 Host 断言信封之外零字段。
- **G16 任务状态机**：按 proposal §11.3 三线状态；本 flow 发布态恒 `local_only`（无模式 A），字段保留以对齐 §10.1 契约。

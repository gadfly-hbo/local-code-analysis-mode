# M2 正式 MVP — 退出证据报告

日期：2026-09-30｜对应方案 §17.1 M2 退出条件：**第 13、14 节的 MVP 和关键验收项通过**。基线：M0/M1（db70d28）。

## 结论：通过（限定条件见文末）

交付：XLSX/Parquet 全链路（F01 全量）、模式 A 可信聚合发布与授权生命周期（P06/P07/P08/P10）、发布阻断不伤本地分析（§11.4）、F02 机检、任务取消、共享字体缓存。

## 证据（`pnpm verify` 全绿；host 43 项 + worker 31 项测试，含审查修复周期新增回归）

| 验收 | 证据 | 测试 |
|---|---|---|
| F01 全量 | xlsx/parquet 完整模式 S 闭环与 CSV 数值对拍；空表头/重复列/合并单元格/嵌套 Parquet 显式拒绝 | `host/test/f01-formats.test.ts`、`worker test_readers.py` |
| F02 扩展 | profiler 全量扫描 date_like（≥99% 解析率）；checks.date_fields 非日期列被机检拒绝；发布精度继承卡 checks | `host/test/m2-baseline.test.ts` "F02…"、`worker test_publish.py` "filters_and_precision" |
| §13.2 结果发布 | 模板集 sum/count/count_distinct/avg × 维度（含 month() 派生）× in/eq/between 筛选；§12 三指标（净额/去重订单/按品类×月份）一次发布 | `worker test_publish.py`、`host test/publication.test.ts` |
| P06 | 信封结构上无自由文本槽：assertEnvelopeIsModeA 拒绝额外字段/字符串数字/换行维度值/坏摘要；发送前可信重算比对授权摘要 | `host/test/publication-send.test.ts` "P06…"、"approve -> send…" |
| P07 | subject_field 去重计数 + min_subjects 压组（单人组丢弃；suppressed_group_count 按组去重计数入信封）；重复行不抬主体数 | `worker test_publish.py` "suppression"、"duplicate_rows" |
| P08 | 四向量全阻断：数据版本漂移、静默改文件（重算摘要失配）、目标模型替换、过期；canonical-JSON 键序稳定 | `host/test/publication-send.test.ts` "P08…"、"canonicalJson…" |
| P10 | 撤销后无活动授权即拒发；max_sends 到顶拒发 | 同文件 "P10…" |
| §11.3 发布状态机 | prepared→awaiting_approval→sent / blocked / expired 落库可查（local_only 为 prepare 前的瞬时态，不落库） | `publications` 表 + CLI |
| §11.4 | 发布被阻断不改任务状态、原因可读；blocked 与 provider 可用性无关（检查先于 caller 构造）；send 期重算崩溃也优雅阻断（不裸抛） | "P08…" 全部向量在 fixture 缺失时仍返回 block_reason |
| §5.3 授权页语义 | preview 文件逐值展示将外发聚合与被压组；approve 绑定摘要/版本/模型/次数/期限 | `publication.test.ts` preview 断言 |

## 架构落点（复用 M0/M1 边界）

- 唯一出站口不变：模式 A 走同一 EgressGateway（`completeModeA`），信封断言+双审计+预算三线复用；purpose=`mode_a_publication` 可审计。
- 可信发布服务：`worker/publish.py` 沙箱内模板执行器，从注册数据重算——任意 Python 输出与 worker stdout 无路径进入模式 A 信封（结构性保证）。
- 发送时六项复验 + 现场重算比对（H8 双摘要），失配即 blocked。
- 修复 M1 潜伏缺陷：幂等 register 现将 current_version 回切至重注册内容（否则回退文件后授权/卡片悬空）。

## 审查修复周期 1（2026-09-30）

独立子代理审查（verdict FAIL）发现 16 项，全部 blocking 与可低成本修复项已修：撤销单活动授权不变式（approve×2→revoke→send 必拒回归）、prepare 阶段行数上限 200 与维度值边界、多次真实发送计入 max_sends（不再造态）、awaiting_approval/expired 状态、xlsx sheet 名入画像、suppressed 按组计数、mode-A 信封复用模式 S 卡校验、send 时文件级哈希、recompute 崩溃优雅阻断、show 对 blocked 可用、AGENTS.md 不变量补模式 A、病态 xlsx CLI 端到端、tasks.md M2 版恢复、`:memory>` 清理。记录不改：completeModeS/A 重复代码（重构味道）；UNVERIFIED 两项（信封 schema_card 是否纳入授权绑定、并发 sent_count 竞态）转 M3 议题。

## 已知边界（如实声明）

- 模式 A 为单数据集、固定模板（无 SQL/join/自定义表达式）；解释单次（max_sends 界定人工多次）。
- 组合差分查询防护=审计+人工复盘（§6.7 声明本版不承诺差分隐私）。
- 维度值本身进入模型（经 preview 逐值确认 + 基数≤50 + min_subjects 双保险）；"零泄漏"仅指本报告限定测试集。
- 一次性 `run` 的 Ctrl-C 仍可能遗留沙箱子进程（同步阻塞进程；session 路径已装 SIGINT 收敛）。
- 真实端点解释质量未测（需 key，`scripts/smoke-real.sh` 已含发布路径）。

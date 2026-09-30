# Tasks：M2 正式 MVP（tracer-bullet 垂直切片）

> 来源：`.flow/prd.md`（M2 PRD + GRILL 决议 H1–H12；G1–G16 继续有效）。上一流程（M0+M1，10 片）见 git 历史 db70d28 的本文件版本。

- [x] 0. 基线扩展：openpyxl 依赖、共享 mpl 缓存管道、任务取消、publications/approvals 迁移、卡 checks 键
- [x] 1. F01：XLSX/Parquet 全链路（分发 + 预检 + 病态拒绝）
- [x] 2. 发布计划与可信重算（plan→validate→worker.publish 模板执行→prepare/preview）
- [x] 3. 授权与模式 A 发送（approve 绑定、send 复算比对、网关 completeModeA、信封断言）
- [x] 4. 对抗与生命周期验收（P06/P07/P08/P10 + §12 三指标 e2e）
- [x] 5. F02 机检（profiler 日期样列、checks 批准校验、发布精度继承）
- [x] 6. 文档与 M2 退出报告（README 收敛、m2-exit-report、smoke 扩展）

---

## 0. 基线扩展

验收：cancel 仅未运行态且二次拒绝；session SIGINT 后任务态如实；tmp-mpl 共享（二次图表无字体缓存重建）；含 checks 的卡通过 approve 且信封接受；既有 26+21 回归全绿。
证据：`host/test/m2-baseline.test.ts`（cancel/checks/mpl/迁移）。

## 1. F01：XLSX/Parquet 全链路

验收：xlsx/parquet 完整模式 S 闭环且聚合与 CSV 对拍；病态 xlsx（空表头/重复列/合并单元格）与嵌套 Parquet 显式拒绝；LocalProfile 报 sheet 名（多表提示）；前导零跨格式保持。
证据：`worker tests/test_readers.py`、`host test/f01-formats.test.ts`。

## 2. 发布计划与可信重算

验收：§12 数据三指标（sum/count_distinct × 品类×月份）一次 plan 手算字面值正确；min_subjects 压组 + 计数；重复行不抬主体数；非白名单维度/基数>50/坏字段/越界参数 → blocked 且不 fail 任务；month() 分桶正确、非日期列 blocked。
证据：`worker tests/test_publish.py`、`host test/publication.test.ts`。

## 3. 授权与模式 A 发送

验收：approve→send 全链路出站=模式 S 信封 + 批准 publication 块 + authorization 引用；发送时重算与批准摘要不一致 → blocked；信封断言拒绝自由文本/字符串数字/未批准字段；撤销/过期/超次/换模型 → blocked。
证据：`host test/publication-send.test.ts`。

## 4. 对抗与生命周期验收

验收：P06 未批准字符串到不了 provider 边界；P07 单人组压制、重复行不冒充；P08 四向量全阻断 + 键序稳定；P10 撤销/次数停止；§12 e2e。
证据：`publication-send.test.ts`（P06/P08/P10 + happy path=§12）、`test_publish.py`（P07）。

## 5. F02 机检

验收：日期样列（≥99% 解析率）被标记；checks.date_fields 指向非日期列被拒；发布精度继承卡 checks；前导零/边界回归绿。
证据：`m2-baseline.test.ts` "F02…"、`test_publish.py` "filters_and_precision"。

## 6. 文档与 M2 退出报告

验收：m2-exit-report 覆盖 F01/F02/P06–P08/P10 与 §13.2 行且无绝对零泄漏措辞；README 命令族与实际一致；`pnpm verify` 全绿。
证据：`docs/m2-exit-report.md`、README、`scripts/smoke-real.sh`。

---

## 修复周期 1 追加项（REVIEW 发现，2026-09-30）

- [x] R1（P1）撤销绕过：approve 建立单活动授权不变式（新 approve 撤销旧活动授权）；revoke 撤销该发布全部活动授权；回归测试 approve×2→revoke→send 必拒
- [x] R2（P1）prepare 阶段策略校验补全：行数上限 200 + 维度键值长度/换行约束 → 违规在 prepare 即 blocked（§11.4）
- [x] R3（P2）send 语义：移除 sent 早退，多次人工发送计入 max_sends（测试走真实路径，不再 SQL 造态）
- [x] R4（P2）状态机：approve→awaiting_approval；过期阻断→expired；报告措辞与实测数字修正
- [x] R5（P2/H1）profile 记录 sheet_names，多表提示
- [x] R6（P2）tasks.md M2 版本恢复（本文件）
- [x] R7（P2）`:memory>` 拼写修复，垃圾文件清除
- [x] R8（P3）suppressed_group_count 按组去重（不再 组×指标）
- [x] R9（P3）assertEnvelopeIsModeA 复用卡校验覆盖 datasets 子树
- [x] R12（P3）send 时现算数据文件 sha256 与绑定版本比对
- [x] R13（P3）send 期重算异常 → blocked + 原因（不裸抛）
- [x] R14（P3）publication show 对 blocked/expired 可用（payload 可选）
- [x] R15（P3）AGENTS.md 不变量补模式 A 信封
- [x] R16（P3）病态 xlsx CLI 端到端断言
- 记录不改：R10（completeModeS/A 重复代码，重构味道）；UNVERIFIED（信封 schema_card 是否纳入授权绑定、并发 sent_count 竞态 → M3 议题）


---

# M3（适配层先行）切片与修复记录（2026-09-30）

- [x] 0. 适配层核心：createXanthilCore facade + 参数式 caller + 接缝 e2e/canary
- [x] 1. Desktop 参考接线（REFERENCE）+ INTEGRATION.md runbook
- [x] 2. README 适配层章节 + docs/m3-exit-report.md
- 修复周期 1（审查 P0/P1）：literal-key auth + worker env 剥离实测；模式 A 注入 caller 全链；J8/导出/UserError/去重；reference 诚实化

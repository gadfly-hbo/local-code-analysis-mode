# Tasks：M0 边界验证 + M1 CSV 核心闭环（tracer-bullet 垂直切片）

> 来源：`.flow/prd.md`（含 GRILL 决议 G1–G16）。每片纵切全层、独立可演示/可验证。
> 无 issue tracker（空项目）→ 本文件即任务事实源。验收编号对齐 proposal §14（F=功能 / P=数据边界）。

- [x] 0. 仓库骨架与统一验证命令（prefactor）
- [x] 1. Workspace + Dataset 注册与内容版本（register/list）
- [x] 2. 本地画像与 Schema 卡流水线（profile → 编辑 → approve，Worker 一次性执行引导）
- [x] 3. 隔离后端 + 逃逸自检门（IsolationBackend / seatbelt，P04/P05）
- [x] 4. 模型出站网关 + FixtureProvider + 审计（模式 S 信封，P01/P09 机制）
- [x] 5. ask→confirm→run 闭环（任务状态机 + 受限执行 + 工件库 + 结构性诊断修复轮）
- [x] 6. Canary 隐私对抗套件（M0 退出证据：精确信封断言，P01/P02/P03/P09）
- [x] 7. M1 持久内核（NDJSON 协议、跨轮复用 F05、版本失效 F06、取消/超时/重启 F07）
- [x] 8. 正确性基准与导出（F02/F03/F04/F08 + export + DuckDB 加固验证）
- [x] 9. 文档、真实冒烟与模式 S 成功率度量（KA1 证据、README、AGENTS.md）

---

## 0. 仓库骨架与统一验证命令（prefactor）

### What to build
Monorepo 骨架：pnpm workspace 的 TS 包（host）+ uv 管理的 Python 包（worker）+ 顶层 `pnpm verify` 一条命令跑通 biome、tsc、vitest、ruff、pytest（各含最小冒烟测试）。git init + 初始提交（G12）。仓库根 AGENTS.md（G13）。

### Acceptance criteria
- [ ] `pnpm verify` 在全新 clone 后一次通过（含双侧零警告 lint + 双侧测试绿）
- [ ] TS 与 Python 包可互相独立构建；worker venv 由 uv 管理、Python 3.12、lockfile 提交
- [ ] git 仓库建立，初始提交完成（此即 dev-flow review_base）
- [ ] 仓库根 AGENTS.md 记录 verify 命令、双语言栈约束、隐私不变量、AGENT-RUNTIME 合规要点

### Blocked by
None - can start immediately

---

## 1. Workspace + Dataset 注册与内容版本

### What to build
`xanthil init`（建 workspace：SQLite + datasets/artifacts/runs/logs 目录）；`xanthil register <csv> --alias sales`（登记 dataset_id/别名/绝对路径映射/sha256 内容版本/schema 版本占位）；`xanthil datasets`（列表展示）。模型侧只见 `dataset://sales`。重复 register 同一文件幂等；文件内容变化产生新版本（G8）。

### Acceptance criteria
- [ ] init 后 workspace 结构与 SQLite 就绪，重复 init 不破坏已有数据
- [ ] register 后别名可解析、sha256 正确；同内容重复注册幂等（同版本），内容变更注册产生新版本记录
- [ ] CLI 层测试：init/register/list 全路径（真实临时目录 + 真实 CSV）——F01（CSV 部分）
- [ ] 路径与 hash 只存本地 catalog，任何输出不含绝对路径的模型可见形态（为后续信封断言打基础）

### Blocked by
- 0

---

## 2. 本地画像与 Schema 卡流水线

### What to build
Host 拉起一次性 Python Worker（无隔离，本片先通协议）执行 profiler：`xanthil profile <alias>` 产出 `LocalProfile`（行数/空值/分布/异常值/抽样 vs 全量标注，仅本地 JSON）与 `ModelSchemaCard` 草案 YAML（别名/类型/语义占位/粒度占位）；用户编辑草案后 `xanthil schema approve <alias>` 固化卡并升 schema 版本。前导零 ID 不被类型推断破坏（proposal §6.2）。

### Acceptance criteria
- [ ] profile 输出的 LocalProfile 含行数/空值统计，且**不进入** Schema 卡草案（结构性断言：卡内无任何统计字段）
- [ ] 草案→编辑→approve 流程可重复；approve 后 schema 版本递增
- [ ] 前导零 ID、混合类型列被正确标注为待确认项而非静默强制转换（F02 前置）
- [ ] 抽样推断与全量扫描分开标注，未全量时行数标记为估算

### Blocked by
- 1

---

## 3. 隔离后端 + 逃逸自检门

### What to build
`IsolationBackend` 可插拔接口（G7）+ darwin seatbelt 实现：为一次执行构造受限进程（deny network*；读=解释器/venv/注册输入/run 目录；写=仅 run 目录；进程数上限）。内置逃逸自检套件（Worker 内真实尝试：HTTP/DNS 联网、读授权外文件如 ~/.ssh、写 workspace 外路径、进程风暴），后端自检全过才被启用；未过则拒绝执行真实数据并明示。profile/rask 执行路径改经后端。

### Acceptance criteria
- [ ] 逃逸测试全部被阻断且留本地记录（P04/P05 机制版：联网、越权读、越权写）
- [ ] 自检失败的后端不可用于执行（fail-closed，G7/方案 §8.2）
- [ ] 正常 pandas/DuckDB/matplotlib 工作负载在后端内可运行（过严即修 profile）
- [ ] Linux 后端占位接口存在（skip 实现，标注 Out of Scope）

### Blocked by
- 2（复用其 Worker 执行通道）

---

## 4. 模型出站网关 + FixtureProvider + 审计

### What to build
`host/src/llm/` 适配层（AGENT-RUNTIME §4.1）：pi-ai 钉 0.86.1 的 Provider + 同接口 FixtureProvider（record/replay，G14 相关）；EgressGateway：按模式 S 装配**固定四元组信封**（system 契约/用户目标/别名+SchemaCard JSON/允许库列表，+可选结构性诊断）（G15），出站前逐字段断言信封之外零内容；每次调用写 SQLite model_calls + logs/egress/<id>.jsonl（G10）；`xanthil audit` 命令查摘要与全文路径。预算三线（G11）挂载。无凭据时 ask 报错退出（G9）。

### Acceptance criteria
- [ ] 信封断言测试：合法信封通过；夹带任意额外字段（traceback/stdout/数值）即拒绝（P02/P11 机制版）
- [ ] FixtureProvider 回放三类剧本（成功计划/缺字段失败/超轮失败）；测试零真实网络
- [ ] 审计双记录（SQLite + JSONL）可查、payload 有 sha256；本地日志与模型消息路径物理分离（P09）
- [ ] 轮次/超时/墙钟三线上限在 gateway 层生效（超限即停，不无限循环）

### Blocked by
- 2（需要 SchemaCard 类型与数据集别名）

---

## 5. ask→confirm→run 闭环（M0 主干）

### What to build
`xanthil ask "目标"`：经 EgressGateway 调模型（测试走 Fixture）→ 返回结构化 `AnalysisTaskSpec`（代码/口径/校验项，JSON schema 校验，proposal §10）→ 任务落盘 draft→awaiting_confirmation；`xanthil confirm <task>` 显式批准（G1）；`xanthil run <task>`：hash 复验→经隔离后端在 Worker 执行（ctx.datasets 注入，G5）→ stdout/stderr/异常只落本地（G6 结构化诊断分类）→ 失败时仅白名单诊断回传模型修复（≤3 轮，G11）→ 工件（结果表/图表/执行记录）登记入 artifacts；`xanthil artifacts` 查看。任务状态机按 proposal §11.3（发布态恒 local_only，G16）。

### Acceptance criteria
- [ ] 未 confirm 的任务不可 run；已 confirm 任务执行前后数据 hash 一致性校验（F06 前置）
- [ ] fixture 剧本「缺字段→诊断→修复→成功」全链路绿：诊断内容仅含结构字段名（P02）
- [ ] 超轮（3 轮）后明确失败并停止，不再调用模型
- [ ] Worker 的 stdout/stderr/结果对象只出现在本地工件与本地日志，模型上下文断言不含（15 号故事机制）
- [ ] 执行产物（CSV 结果/图表 PNG/执行记录 JSON）带执行 ID/数据版本/类型/敏感等级登记（19 号故事）
- [ ] 端到端 CLI 测试：合成销售 CSV 从 register 到 artifacts 全路径

### Blocked by
- 3, 4

---

## 6. Canary 隐私对抗套件（M0 退出证据）

### What to build
端到端对抗测试（G14）：合成 CSV 每行嵌高熵 canary；fixture 剧本包含恶意/失误代码（`print(df)`、把单元格值拼进「摘要」、把明细写成图表标签）；断言（1）全部出站载荷**逐字段等于**获准信封（强于 canary 扫描）；（2）本地工件与审计 JSONL 中 canary 存在（通道分离证明）；（3）运行时异常剧本（NameError 带值）时诊断只含结构信息。形成 M0 退出报告（测试输出即证据）。

### Acceptance criteria
- [ ] P01：模式 S 全链路完成后，捕获的全部模型请求中 canary 零命中且信封精确匹配
- [ ] P02：print/head/异常原值剧本下，模型上下文不含单元格值
- [ ] P03：图表/文件不外发（载荷中无工件内容）
- [ ] P09：审计/会话恢复路径不把本地敏感日志写入模型上下文（重放审计对比）
- [ ] M0 退出报告（.flow 或 docs 下 markdown：测试名+结果）

### Blocked by
- 5

---

## 7. M1 持久内核

### What to build
Worker 常驻进程化（NDJSON over stdio：execute/health/shutdown/interrupt/restart/list-variables/invalidate，G4）；Host KernelManager 生命周期管理；同会话第二轮任务复用已加载数据/变量（F05）；数据文件变化→句柄失效→拒绝旧结果引用（F06）；取消/超时/崩溃状态真实（F07）；同会话可变执行串行。

### Acceptance criteria
- [ ] 同一会话两次执行：第二次复用已注册 dataset 句柄（验证方式：执行记录含 reuse 标记/加载计数），无跨会话串数据（F05）
- [ ] 数据文件内容变化后：旧句柄访问被拒、相关缓存结果标记失效（F06）
- [ ] interrupt/超时/kill -9 内核：状态真实上报、进程树可清理、restart 后可重跑（F07）
- [ ] 崩溃后的持久工件仍可列取；内核状态丢失被明确标注（proposal §11.1）
- [ ] 持久路径与一次性路径经同一 IsolationBackend（不因持久化弱化隔离）

### Blocked by
- 5

---

## 8. 正确性基准与导出

### What to build
合成销售数据生成器（订单商品行粒度/退款/前导零 ID/混合日期坑，canary 兼容）；确定性基准测试（写死期望值）：聚合/去重/关联/退款处理（F03）、金额对账（分组=总额，F04）、前导零与时间边界（F02）、同数据同代码重跑一致（F08）；任务校验项（aggregation_reconciles 等）在执行中真实运行；Worker 内 DuckDB 加固验证（禁自动扩展安装、无远程 fs，方案 §8.3）；`xanthil export <artifact> --out <path>` 显式导出（24 号故事）。

### Acceptance criteria
- [ ] F02/F03/F04 基准全绿（与人工推算的确定性基准比对，非自证）
- [ ] F08：相同数据+代码+环境重跑结果一致
- [ ] 关联膨胀场景被校验项捕获并标记 failed/needs_review（proposal §11.4）
- [ ] DuckDB 在 Worker 内无法 autoload/autoinstall 扩展、无法 attach 远程源（测试证明）
- [ ] export 只做本地复制且为显式命令；导出记录入审计

### Blocked by
- 6（用其对抗套件基础设施）、7（F05/F06 相关校验）

---

## 9. 文档、真实冒烟与模式 S 成功率度量

### What to build
双语 README（架构图、快速开始、隐私边界声明与已知限制——含「泄漏为 0 仅指限定测试集」措辞，proposal §14.2/§18）；真实模型手动冒烟脚本（env 配置 GLM OpenAI 兼容端点，G9）；KA1 度量 harness：对 N 个合成任务记录首轮/≤3 轮成功率（fixture 可跑、真实可选）；仓库 AGENTS.md 终稿。

### Acceptance criteria
- [ ] README 含隐私承诺的准确边界表述（不宣称绝对零泄漏）
- [ ] 冒烟脚本可一键以真实端点跑通 ask→run（手动、需用户 key）
- [ ] KA1 harness 产出成功率报告（fixture 剧本全量可跑）
- [ ] dev-flow 全程产物核对：tasks.md 全勾、verify 证据在案

### Blocked by
- 8

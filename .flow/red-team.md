# Red-Team: M3 Desktop 产品化（跨仓库集成）

评审日期：2026-09-30｜对象：proposal §1.3/§16/§17.1-M3 + 实勘 `~/JuanerAI`（apps/desktop、packages/contracts/xanthil-desktop-ipc.ts、AGENTS.md 宪法）。

## 实勘结论（先于假设）

- **Desktop 存在且活跃**：Electron 应用（main/preload/renderer + case-assistant 工作台），IPC 契约 18 个请求类型（openSession/startAnalysis/decideAssistanceDisclosure/…），main 分支今天仍有提交（#48/#49）。
- **治理约束**：JuanerAI 宪法（AGENTS.md）权威链要求用户批准 > 宪法/Blueprint > OpenSpec > 设计 > 测试；开发走 Change/PR 流程；且宪法明言「pending Xanthil Desktop 与 Model Pack 开发计划已于 2026-09-18 撤回作废」。UI 须复用 PX-2026-004/006 契约模式。
- **我们这边**：工具核心（CLI + 模式 S/A 边界）已交付且对抗验证（M0–M2）；但尚无**程序化入口**（只有 CLI 进程界面），Desktop 无法以库形式复用。

## Top Kill-Assumptions

### KA-M3-1. 跨仓库写入策略（最大风险）
- **Claim**: M3 = 把工具核心接入 Desktop。
- **Fails if**: 未经 JuanerAI 自身流程直接改写其治理仓库（甚至提交 main）——违反其宪法与用户全局规则（写入限授权范围）；PR 流程也无法在本会话内由我单方完成。
- **处置**: 本 flow 不直接写 JuanerAI。产出=①本仓库的**适配层包**（稳定 TS facade，Desktop 可作依赖消费）+ ②Desktop 侧**参考接线代码**（以独立文件/补丁形态随本仓库交付，附集成 runbook，由用户走其 Change/PR 流程采纳）。此为范围重解释，交 PRD diff 门裁决。

### KA-M3-2. 复用而不重建
- **Claim**: §1.3「复用现有会话、Agent、模型配置和工作区，不再建设第二套」。
- **Fails if**: 适配层自行造会话/密钥/UI。落地：适配层只暴露数据集/Schema/任务/发布/审计的编程 API；模型凭据仍由调用方（Desktop 的 provider 设置）注入 env；不新建任何模型通道（一切出站仍走本仓库唯一网关）。

### KA-M3-3. 不引入旁路数据出站（M3 退出条件）
- **Claim**: 接入 Desktop 后边界不变。
- **Steelsman**: 适配层是进程内薄封装（调用与 CLI 相同的核心模块），不新增文件读取/网络/日志路径；对抗测试在**适配层接缝**复跑（信封精确断言 + canary）。
- **Fails if**: 为了「报告交付」把工件内容直接递给 Desktop 的模型会话。落地：报告交付=本地工件路径/预览引用 + 用户显式导出；给模型的只有经网关的模式 S/A 信封。

### KA-M3-4. 进程模型
- Desktop（Electron main）调用方式：适配层以**库**形态同进程调用，还是 spawn CLI 子进程？库形态=最优（类型安全、状态共享）；但 worker 沙箱子进程本就是核心一部分，无碍。选库形态，CLI 保留为薄入口。

### KA-M3-5. 范围与预算
- Electron UI 全面改造不在本 flow（那是 JuanerAI 侧 Change）。本 flow 交付=适配层 + 参考接线 + 契约测试 + runbook。

## What's Well-Reasoned

- proposal §1.3 早已预判「不是先做大型独立应用再集成」——适配层先行正合本意。
- 核心边界（网关/沙箱/审计）已被 M0–M2 对抗验证，M3 只是加一个进程内消费者，不改边界本身。
- Desktop IPC 契约中 decideAssistanceDisclosure 的「逐次披露」语义与本工具模式 A 的授权语义天然对齐。

## What I Couldn't Assess

- JuanerAI 侧 UI 契约（PX-2026-004/006）细节与 Change 流程的实际周期——参考接线只能力求「可采纳」而非「已采纳」。
- Desktop 内嵌模型会话的 provider 机制细节（参考接线按 env 注入设计，留适配点）。

## Verdict

**go（附范围重解释 KA-M3-1，交 PRD diff 门裁决）**——Desktop 前提成立；跨仓库治理约束决定「适配层先行、不写对方仓库」的路径。无 kill 准则被满足。

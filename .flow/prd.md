# PRD：M3 Desktop 产品化 — 适配层先行（adapter-first）

> 事实源：`.flow/proposal.md` §1.3/§16/§17.1-M3 + `.flow/red-team.md`（含实勘）。基线：M0–M2（00c67e5）。G1–G16 / H1–H12 继续有效。

## Problem Statement

Xanthil Desktop 已存在且活跃（Electron + IPC 契约 + 案例工作台），但本工具只有 CLI 进程界面——Desktop 无法以库形态复用工具核心；同时 JuanerAI 是宪法治理的独立仓库（OpenSpec/Change/PR 流程），本 flow 无权直接改写其代码。M3 需要在不越权写对方仓库的前提下，让 Desktop 具备「零成本采纳」的接入面。

## Solution（范围重解释，见 diff 门）

1. **适配层包（本仓库 `host/src/adapter/`）**：稳定 TS facade `createXanthilCore()`——进程内暴露 workspace/dataset/profile+schema approve/ask+confirm+run/session/publication(plan→prepare→approve→send→revoke)/audit/export 的编程 API；模型凭据由调用方注入（env 透传），无任何新增模型通道/文件/网络路径。
2. **Desktop 参考接线（本仓库 `desktop-adapter/`，非 JuanerAI 写入）**：按其 IPC 契约（xanthil-desktop-ipc.ts 的请求类型）给出的参考实现文件（如 `analysis-adapter.reference.ts`）+ `INTEGRATION.md` runbook（如何在 JuanerAI 走 Change/PR 采纳、会话/凭据如何桥接、报告交付=本地工件引用而非内容直传模型）。
3. **接缝级对抗回归**：适配层入口复跑 canary/信封精确断言（证明「不引入旁路数据出站」对库消费者同样成立）。
4. CLI 与适配层共用同一核心模块（CLI 变薄壳，防止两套行为漂移）。

## User Stories

1. As a Desktop 开发者, I want 以库形态调用工具核心（含沙箱 worker 与持久内核）, so that 不必解析 CLI stdout。
2. As a Desktop 开发者, I want 参考接线与 runbook 对齐我家 IPC 契约, so that 采纳是一条 Change 的事而非重写。
3. As a 隐私敏感用户, I want 从 Desktop 触发的每条模型调用仍只经唯一网关且可审计, so that 接入不产生新出站路径。
4. As a 隐私敏感用户, I want 报告交付拿到的是本地工件引用/预览, so that 报告生成不会变成数据出口。
5. As a Desktop 开发者, I want 适配层的错误/阻断（blocked/expired/drift）以结构化结果返回, so that UI 能如实呈现而非崩溃。
6. As a 任何用户, I want 既有 CLI 行为零变化, so that M0–M2 的全部证据继续有效。

## Implementation Decisions

- **形态**：adapter 为 host 内模块（`host/src/adapter/xanthil-core.ts` 导出 `createXanthilCore(opts)`），复用 catalog/schema/orchestrator/publication/isolation 全部现有实现；**零新依赖、零新进程形态**（worker/内核沙箱机制原样）。CLI 改为调用 adapter（同核收敛）。
- **API 面**（全部同步返回结构化结果或抛 UserError 子类）：`initWorkspaceAt(dir)`、`registerDataset`、`profileDataset`、`approveSchemaCard`、`ask`、`confirmTask`、`runTask`、`runSessionTasks`、`cancelTask`、`planPublication`/`preparePublication`/`approvePublication`/`sendPublication`/`revokePublication`、`listPublications`/`getPublication`、`listArtifacts`/`exportArtifact`、`auditTrail`。caller 注入：`{model: {fixturePath} | {baseUrl, model, apiKey}}`——apiKey 仅存活于适配层进程 env，不落盘。
- **参考接线**：`desktop-adapter/xanthil-analysis.adapter.reference.ts`（对齐 xanthil-desktop-ipc 请求类型中与分析相关的 startAnalysis/cancelAnalysis/readProjection 语义映射）+ `desktop-adapter/INTEGRATION.md`（采纳步骤/凭据桥接/工件交付语义/不变量清单）。**不写 ~/JuanerAI 任何文件**。
- **测试接缝**：新增「adapter 接缝」= `createXanthilCore` 公共 API；canary 对抗（ask→run→publication 全链，经 adapter 入口）断言与 CLI 级一致；CLI 全部既有测试不动即回归护栏（CLI 与 adapter 同核的证明）。
- **Out of scope**：JuanerAI 仓库任何写入、Electron UI 改造、Desktop 内嵌会话/报告 UI、PX UI 契约实现（由其 Change 流程承担）、新增数据格式/模板。

## Testing Decisions

- adapter 级 e2e：fixture 全链（register→profile→approve→ask→confirm→run→publication prepare/approve/send）经 `createXanthilCore`，断言与 CLI 路径产物一致（同数据版本、同信封摘要）。
- canary 对抗复跑于 adapter 入口（P01/P02 语义）；auditTrail 返回的每条调用可还原完整出站载荷摘要。
- CLI 既有 43+31 测试零修改通过（同核收敛证明）。

## Further Notes

**验收映射**：M3 退出条件「工具核心复用」（adapter 即复用面 + CLI 同核）与「不引入旁路数据出站」（接缝级 canary + 信封断言 + adapter 零新增 IO 路径审查）；§1.3「复用现有会话/模型配置/工作区」（凭据由 Desktop 注入、workspace 路径由调用方指定）；§16 Desktop 行「优先复用现有会话与模型配置」。
**红队缓解**：KA-M3-1 由本 PRD 范围裁定；KA-M3-2/3 由 API 面设计+对抗测试；KA-M3-4 库形态；KA-M3-5 Out of scope 硬边界。


---

## GRILL Resolved Decisions（M3 自拷问决议，2026-09-30）

> diff 门（跨仓库策略）已呈现未应答，按推荐项执行：适配层先行、零写入 ~/JuanerAI。

- **J1 API 形态**：沿用核心函数既有签名（ask/run 为 async、目录操作同步）；全部返回结构化对象或抛 UserError。
- **J2 caller 注入**：新增参数式 `createCaller(params)`（fixture 或 openai-compatible 三元组）；现有 env 版改为包一层。apiKey 仅存于内存中的 caller 实例，不落盘不入审计。
- **J5 同核收敛方式**：adapter 与 CLI 共享同一批核心模块（orchestrator/publication/catalog/…）实现同核，而非 CLI 重写为 adapter 消费者——避免末期无谓重构回归；同核性由「相同 fixture 下产物一致」测试证明。
- **J6 参考接线定位**：`desktop-adapter/*.reference.ts` 为参考代码（不参与 host 构建/不编译），对齐 xanthil-desktop-ipc 的 startAnalysis/cancelAnalysis/readProjection 语义映射，头部注明 REFERENCE。
- **J7 审计 API**：listModelCalls / listPublications / listArtifacts 分立暴露，不做聚合投影（投影属 Desktop 侧职责）。
- **J8 发布计划对象化**：adapter 接受 plan 对象（内部 canonical YAML 序列化后走既有校验），文件路径版保留给 CLI。
# Xanthil Desktop 集成手册（M3 交付物）

本目录是 **参考接线**，不属于 host 构建。采纳 = 在 JuanerAI 仓库走其 Change/PR 流程把 `xanthil-analysis.adapter.reference.ts` 的映射落到 `adapters/` 并按需调整契约字段。

## 前提

- 本工具以**库形态**被消费：`createXanthilCore({ workspaceDir, model })`（`host/src/adapter/xanthil-core.ts`）。
- `workspaceDir` = `.xanthil` 工作区目录（Desktop 决定位置，例如项目目录下）。
- `model` 凭据由 Desktop 的 provider 设置注入（`openai-compatible` 三元组或 fixture）；密钥只存活于进程内存，不落盘、不入审计。
- worker/内核沙箱机制原样生效（seatbelt）；`xanthil sandbox check` 语义经 `core.sandbox.selfCheck()` 可用。

## 语义映射（xanthil-desktop-ipc ⇄ 工具核心）

| IPC 请求 | 工具核心 | 边界说明 |
|---|---|---|
| startAnalysis | tasks.ask → confirm → run（模式 S） | confirm 必须由 Desktop 确认流驱动（reference 示例中的自动 confirm 仅为骨架）；goal 实际取自 revision.question_text，数据集取自确认快照 |
| cancelAnalysis | tasks.cancel / session 中断 | 仅未运行态可取消（与 CLI 一致） |
| readProjection | tasks/publications/modelCalls 只读列举 | 投影状态由 Desktop 持有；本桥只供给事实 |
| prepareAssistanceDisclosure / decide… / startAssistance | publications.prepare → approve → send（模式 A） | 「逐次披露」≙ 逐发布授权：preview 逐值、批准绑定摘要+版本+目标+期限 |
| cancelAssistance | publications.revoke | 撤销阻止后续发送（已发送不可收回，如实呈现） |

## 报告交付语义（关键不变量）

- 分析产物 = **本地工件引用**（artifact id + 本地路径 + 类型）。Desktop 渲染报告时读本地文件；**任何工件内容不得进入模型上下文**。
- 给模型的唯一通道仍是模式 S/A 信封（经本工具唯一出站网关）；Desktop 侧不得把工件文本拼进其模型会话 —— 违反即「旁路数据出站」，破坏 M3 退出条件。

## 采纳步骤（JuanerAI 侧）

1. 以 Change 提案引入本仓库为依赖（或 vendored adapter）。
2. 把 reference 文件的映射实现进 `adapters/`（按契约真实字段名补齐 projection 构造）。
3. provider 设置桥接：把 Desktop 的模型配置转成 `model` 参数注入；不新增 env 约定。
4. 在其测试里复用本仓库的接缝级 canary 断言（adapter.test.ts 可直接搬运）。
5. UI 文案沿用其披露语义（「本次将向模型发送指定聚合指标；不发送原始记录」）。

## 已验证的边界（本仓库证据）

- adapter 与 CLI 同核（共享 orchestrator/publication 等模块；相同 fixture 产物一致）。
- canary 经 adapter 入口零外发（`host/test/adapter.test.ts`）；审计逐条可查（`core.audit.modelCalls()`）。

# M3 Desktop 产品化（适配层先行）— 退出证据报告

日期：2026-09-30｜对应方案 §17.1-M3 退出条件：**工具核心复用，不引入旁路数据出站。**

## 结论：通过（限定：JuanerAI 侧采纳属其 Change/PR 流程，本 flow 交付“零成本采纳面”）

范围重解释（红队 KA-M3-1，PRD diff 门按推荐项执行）：不写 ~/JuanerAI；交付适配层 + 参考接线 + runbook。

## 证据

| 退出条件 | 证据 |
|---|---|
| 工具核心复用 | `host/src/adapter/xanthil-core.ts`：进程内 facade 复用与 CLI 完全相同的核心模块（catalog/schema/orchestrator/publication/isolation）；接缝测试用与 CLI 路径同构的 fixture 断言确定性产物（未做同 fixture 双路径对拍——同核性由共享模块构造保证，措辞如实） |
| 不引入旁路数据出站 | adapter 零新增 IO 路径；canary 经 adapter 入口对抗零命中；模型凭据仅内存（参数式 caller → pi-ai literal-key auth，不写 process.env）；**深度防御实测**：父进程含 XANTHIL_LLM_* 时沙箱子进程环境为零（isolation.ts 剥离，grep 计数=0）；模式 A 经适配层可用注入 caller 完成 prepare→approve→send（P1 回归测试） |
| §1.3 复用现有会话/模型配置/工作区 | workspaceDir 由宿主指定；model 由宿主 provider 注入；无第二套会话/密钥体系 |
| 参考接线 | `desktop-adapter/xanthil-analysis.adapter.reference.ts`（对齐 xanthil-desktop-ipc 的 startAnalysis/cancelAnalysis/readProjection 与披露→模式 A 映射）+ `INTEGRATION.md` runbook（含报告交付不变量：工件=本地引用，内容不得进模型上下文） |
| 回归护栏 | CLI 既有测试零修改全绿（同核性由共享模块构造保证） |

## 已知边界

- 参考接线未对照 JuanerAI 真实 projection 字段编译验证（REFERENCE 文件，不参与构建）；采纳时需按其契约补齐投影构造。
- Desktop UI 改造、PX UI 契约实现、其 Change 流程周期 —— 均属 JuanerAI 侧，本 flow 不触及。
- 适配层为进程内同进程调用；若 Desktop 未来要求跨进程服务化（daemon/RPC），另行立项。


## 审查修复周期 1（2026-09-30）

独立审查 FAIL→修复：**P0** apiKey 曾经 process.env 泄入 Worker 环境（§8.2 违反）→ 改 pi-ai literal-key auth + isolation.ts 强制剥离 XANTHIL_LLM_*（实测 worker env 计数 0）；**P1** 模式 A 发送绕开注入 caller → sendPublication 接受注入 caller、目标模型比对用 caller 身份，适配层 e2e 补 publication 全链；J8 plan 对象入口、confirm 抛 UserError、artifacts.export、caller 构造去重（index.ts 委托 createCaller）；reference 接线诚实化（确认门/字段来源/id 形态注明）。J8 之外的取舍与已知边界已在上文如实声明。

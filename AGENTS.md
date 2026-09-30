# local-code-analysis-mode — Xanthil 本地化数据处理工具

基于《Xanthil 本地化数据处理工具产品方案 v1.0》的工程实现（规格见 `.flow/proposal.md`，PRD 见 `.flow/prd.md`）。

## 结构

- `host/` — TypeScript Host：CLI、Egress Gateway、Dataset Catalog、任务契约、审计、Worker 编排（Node ≥22，ESM，pnpm）
- `worker/` — Python Worker：受限执行侧运行时（Python 3.12，uv 管理）
- `.flow/` — dev-flow 流程产物（proposal/prd/tasks/review 等；`state.json` 为本机状态，不入库）

## 验证命令

```
pnpm verify        # biome + tsc + vitest (host) + ruff + pytest (worker)
```

任何改动以 `pnpm verify` 全绿为完成标准（dev-flow VERIFY 亦运行此命令）。

## 硬性约束（实现任何功能前必读）

1. **隐私不变量**：模型上下文只能包含经用户确认的模式 S 信封（system 契约 / 用户目标 / 数据集别名 + ModelSchemaCard / 允许库列表 / 可选结构性诊断）。内核输出（stdout/stderr/异常值/结果）永不进入模型上下文。所有模型调用只经 `host/src/llm/` 出站网关，出站前逐字段断言信封。
2. **AGENT-RUNTIME 合规**（全局标准 `~/.zcode/standards/AGENT-RUNTIME.md`）：工人模式；pi-ai 钉 0.86.1 且只经适配层引用；预算三线封顶（轮次/超时/墙钟）；审计可回放；夹具回放为测试基线。
3. **隔离**：生成代码只能经 IsolationBackend 构造的受限进程执行；后端须先过逃逸自检才可跑真实数据；模型密钥只存在 Host 进程。
4. **测试接缝**：隐私断言打在模型边界（FixtureProvider 捕获）；隔离断言打在 IsolationBackend；端到端走 CLI 子进程。不测内部实现细节。

## 约定

- TS：严格模式、ESM、biome 格式化；Python：ruff、src 布局。
- CLI 文案英文；文档双语。模型侧标识一律用 `dataset://别名`，不出现绝对路径。

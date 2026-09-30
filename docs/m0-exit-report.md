# M0 边界验证 — 退出证据报告

日期：2026-09-30｜对应方案 §17.1 M0 退出条件：**证明基本链路可行；无未经批准的模型输出回传。**

## 结论：通过（限定条件与已知边界见文末）

完整链路（合成 CSV → 注册 → 本地画像 → Schema 卡确认 → 模型生成代码 → 沙箱执行 → 本地工件与校验 → 出站捕获审计）已跑通，且经对抗测试证明：除获准模式 S 信封外，无任何数据派生内容到达模型边界。

## 证据（全部为可重复执行的自动化测试，`pnpm verify` 全绿）

| 退出条件 | 证据 | 测试 |
|---|---|---|
| 基本链路可行 | ask→confirm→run 端到端产出正确聚合工件（确定性基准值） | `host/test/loop.test.ts` "ask -> confirm -> run…"；worker 侧 `test_execute.py` |
| 结构性诊断修复轮受限 | 缺列→诊断→修复→成功；纯运行时错误不重试；轮次上限 3 | `loop.test.ts` "structural failure…" |
| P01 模式 S 不外发数据派生值 | 全部出站载荷逐字段等于获准信封（精确匹配，强于 canary 扫描）；canary 零命中 | `host/test/privacy.test.ts` P01 |
| P02 print/head/异常原值不进入模型 | `print(df)` 只落本地 run.log；KeyError 夹带单元格值被降级为不透明 runtime（诊断只回显模型自身代码中出现过的 token） | P02 + `test_execute.py` "print_of_dataframe_stays_in_local_log" |
| P03 图表/文件不外发 | matplotlib PNG 只在本地工件库；出站载荷无工件路径/字节 | P03 |
| P04 Worker 联网阻断 | 沙箱内 TCP connect/bind 被拒（deny network*） | `host/test/sandbox.test.ts` "sandbox check blocks…" |
| P05 越权读/写阻断 | /Users 读禁令 + 全局写禁令（仅放行 run 目录）；探针实测被拒；沙箱后端缺失时 fail-closed | 同上 + "missing sandbox-exec binary fails closed" |
| P09 审计与本地日志分离 | 本地 run.log 含 canary；模型审计 JSONL 零 canary（物理不同文件树） | P01 断言两侧 |
| P11 网关默认拒绝 | 信封断言拒绝任何额外字段/统计键 | `host/test/egress.test.ts` "envelope guard rejects…" |
| F01(CSV)/F02 前置 | 注册幂等 + 内容版本；前导零 ID 保持 string | `catalog.test.ts`、`profile.test.ts`、worker `test_profile.py` |
| F06 前置 | 数据漂移后任务拒绝执行 | `loop.test.ts` "…input drift fails the task" |

## 实现要点（与方案条款对应）

- 唯一模型出站口：`host/src/llm/egress.ts`（模式 S 信封装配 + 出站前逐字段断言 + SQLite/JSONL 双审计 + 超时预算）。信封结构见 `envelope.ts`（G15 四元组；`assertEnvelopeIsModeS` 同时供对抗套件复用）。
- 隔离：`host/src/isolation.ts` deny-first seatbelt profile（deny network* / 全局 deny file-write*（放行 run 目录）/ deny 读 /Users（放行解释器树、venv、worker、注册输入、run 目录））；所有路径 realpath 归一（/tmp→/private/tmp）；profile 落盘于 run 目录供审计；`sandbox check` 逃逸自检可重复执行。
- Worker（`worker/src/worker/`）：一次性 NDJSON 模块（profile / execute / sandbox_check）；生成代码仅见 `ctx`（懒加载数据集 + 工件保存器）；stdout/stderr 只进本地 run.log；异常按 G6 白名单结构化（syntax / missing_lib / unknown_dataset / unknown_field / runtime）。
- AGENT-RUNTIME 合规：工人模式（无 agent 循环/无模型工具调用）；pi-ai 0.86.1 仅在 `llm/pi-caller.ts` 适配层引用；修复轮次（3）/单调用超时（90s）双线预算；夹具回放（`FixtureCaller`，消费状态跨进程持久化）。

## 已知边界（如实声明，非零泄漏承诺）

- 隔离验证仅覆盖 **darwin/seatbelt**（本机实测）；Linux 后端为接口占位。进程数上限（fork 炸弹防护）未实现——`(limit process N)` 在当前 macOS 的 SBPL 中不可用，属资源加固项而非 P04/P05 数据通道。
- "泄漏为 0" 仅指本报告所列限定测试集与受控运行条件（方案 §14.2 措辞）。
- mach-lookup 在 profile 中保持默认允许（系统服务调用）；网络出口由 socket 层禁令阻断。
- 诊断通道的 token 回显白名单 = 模型自身代码子串；字段名/别名来自已批准 Schema 卡——语义上仍属用户批准范围（§4.5）。
- matplotlib 首次渲染需构建字体缓存（约 8–10s/新 run 目录）；M1 计划共享预热缓存目录。

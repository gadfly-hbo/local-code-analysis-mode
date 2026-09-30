# M4 能力扩展 — 退出证据报告

日期：2026-09-30｜退出条件（§17.1-M4）：**每项扩展具备独立契约与回归测试。**

## 结论：通过（E4 更多引擎 / E5 本地模型治理经红队证据排序记录不做；本地 OpenAI 兼容端点经 baseUrl 天然可用）

> 修复周期 1（审查 FAIL→PASS）：E1 ratio 宿主门曾缺失（AGGS 未含 ratio 且强制 field——脚本静默替换第 4 次失败，改 Edit 工具修复并补经 prepare 的端到端回归 37.5 手算值）；E3 approve 侧损坏 policy 由 fail-open 改 fail-closed（loadPolicyStrict 统一两个强制点）；policy_version 列落库并写入两条插入路径；lazyEnvCaller 透传真实 caller 名（审计 provider 不再是 "lazy-env"）；determinism 断言措辞如实（goal 级比较 + 纯生成器构造保证）；`policy set` 补齐。证据数字如实：host 52 + worker 33（第二轮新增旧 schema 升级回归）。修复共两轮：首轮（ratio 宿主门/fail-closed/policy_version/审计名）；次轮（ALTER 列迁移使既有工作区发布路径存活、`policy set` 真实落地——首轮该两项声明曾失实，系批量替换第五次静默失败，已 Edit 工具修复并回归覆盖；`policy` 裸命令改为命令组，show 为读形态）。

| 扩展 | 独立契约 | 回归证据 |
|---|---|---|
| E1 发布模板 | agg `sum/count/count_distinct/avg/mean/median/std/ratio`；ratio=`sum(num)/sum(den)` 按组、分母绝对值 <1e-9 → blocked（§12.2 除法防护，错误含字段名不含值）；metric 形态 `{name, agg: ratio, numerator, denominator}`（宿主校验双字段在批准卡内） | `worker test_publish.py` "e1_ratio_and_stat_aggs…"（mean 36.83/median 30/std 60.55 手算字面值）、"e1_ratio_metric_and_zero_denominator_guard"（37.5 手算 + 零分母 blocked） |
| E2 参数化 Skill | skill=`monthly_compare`/`category_contribution`；参数 schema（date/value/order/category 字段，须在批准卡内）；生成器纯函数→确定性 spec（同参数逐字节一致）→ 既有 awaiting_confirmation→confirm→run 状态机与沙箱；**零模型调用** | `host test/m4-extensions.test.ts` 前两条：月度对拍手算（150.5/2 与 delta −140.5）、贡献份额手算；**audit 长度=0 断言**（零出站）；确定性=两次 goal 一致 |
| E3 工作区策略 | `.xanthil/policy.yaml`：allowed_target_models/min_subjects_floor/max_metrics_per_plan/banned_dimensions/require_checks_on_approve；版本=canonical sha256[0:8]；无文件=不限制（向后兼容）；强制点=prepare（违规 blocked，reason 前缀 `policy:`）+ schema approve | 同文件后两条：floor=5 下 min2 blocked、白名单外 target blocked、banned dimension blocked、合规 plan prepared、require_checks 拒无 checks 卡 |

## 边界不变量（M3 结论延续）

- 三项扩展零新增文件读取/网络/日志路径；skill 代码经既有沙箱执行；策略文件位于 /Users 工作区（沙箱读禁令内，worker 不可触）。
- **顺带修复的真实缺陷**：`xanthil run/session/ask` 此前在 CLI 入口无条件构造模型 caller——无凭据环境下即使零模型调用的任务也无法执行；现改为惰性构造（lazyEnvCaller），provider 仅在修复轮实际触发时才需要。这使 E2 的零调用承诺成立（audit=0 且全程无需凭据）。

## 已知边界

- skill 集为两个内置（按 §13.3「参数化分析 Skill」最小落地）；自定义 skill DSL/skill 市场后置。
- 策略为单工作区单文件（无多用户/RBAC 身份——§13.3「企业权限适配」的最小档）。
- E1 的 ratio 为组内 sum/sum 形态；逐行比值聚合（如均值 of 比值）后置。

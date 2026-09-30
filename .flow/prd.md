# PRD：M4 能力扩展 — 发布模板扩展 + 参数化 Skill + 工作区策略

> 事实源：`.flow/proposal.md` §6.7/§13.3/§17.1-M4 + `.flow/red-team.md`（候选证据排序）。基线：M0–M3（3b6a99b）。既有决议（G/H/J 系）继续有效。
> M4 退出条件（§17.1）：**每项扩展具备独立契约与回归测试。**

## Problem Statement

三个由已交付产品自身暴露的缺口：① §12 示例的客单价（比率指标）无法用单模板表达，均值/波动类解读缺 agg；② 高频分析（月度对比、品类贡献）每次都消耗模型调用与修复轮，且不可参数化复用；③ 方案 §10.3 的 `policy_version`/§6.7 的「政策」从未落地为工作区级强制配置——min_subjects、目标模型等散落在用户每次手填的 plan 里，无企业级下限。

## Solution（三项扩展，各自独立契约）

**E1 发布模板扩展**：worker/publish.py 新增 agg `mean/median/std` 与派生指标 `ratio{numerator, denominator}`（两字段均为已批准卡内字段）；分母为零或绝对值 <1e-9 → 该 plan blocked（§12.2 除法防护），错误信息结构性（字段名，无值）。信封/校验/精度链路全部复用既有模式 A 管道。

**E2 参数化分析 Skill（本地确定性）**：内置 skill `monthly_compare`（日期字段+值字段+主体 → 逐月 sum/count_distinct + 环比的分析任务 spec）与 `category_contribution`（品类贡献分解）。`xanthil skill run <name> --param k=v` 与适配层 `core.skills.run(name, params)`：**本地确定性生成 AnalysisTaskSpec → 落库 awaiting_confirmation → 走既有 confirm/run 状态机**；零模型调用（出站审计零增长）；生成的代码使用与模型生成完全相同的 ctx 契约与沙箱。

**E3 工作区策略**：`.xanthil/policy.yaml`（Host 单写方；`xanthil policy set/show`；版本=canonical sha256 前 8 位）：`allowed_target_models[]`、`min_subjects_floor`、`max_metrics_per_plan`、`banned_dimensions[]`、`require_checks_on_approve`。强制点：publish plan 校验（违规 prepare 即 blocked，reason 前缀 `policy:`）；approve 卡校验（require_checks）。无 policy 文件=不限制（向后兼容）。策略文件位于 /Users 工作区内——沙箱读禁令已保证 worker 不可读写。

## User Stories

1. As a 数据分析人员, I want 客单价类比率指标一次模板发布, so that 不必拆两条指标让模型心算除法。
2. As a 数据分析人员, I want 月度对比/品类贡献开箱即用且零模型调用, so that 高频分析快且可复现。
3. As a 隐私负责人, I want 工作区级 min_subjects 下限与目标模型白名单, so that 个别 plan 手滑不能突破组织底线。
4. As a 隐私负责人, I want 违规 plan 在 prepare 即被阻断并注明违反的 policy, so that 策略可解释。
5. As a 开发者, I want 三项扩展各有独立契约与回归测试, so that M4 退出条件可逐项核销。
6. As a 任何用户, I want 扩展不新增任何 IO/出站路径, so that M3 的边界结论继续成立。

## Implementation Decisions

- **E1**：publish.py `execute_plan` 扩展；ratio 按组计算（组内 sum(num)/sum(den)，精度取整复用 plan.precision）；metric 形态 `{name, agg: ratio, numerator, denominator}`（宿主校验两字段均在卡内）。信封 metrics 块结构不变（value 仍为数字）。
- **E2**：`host/src/skills.ts`——注册表 `{name, params schema, generator}`；生成器纯函数（参数+批准卡 → AnalysisTaskSpec）；spec 经既有 createTask 落库（goal 前缀 `[skill:<name>]`）；CLI `skills` 列表 + `skill run`；适配层 `core.skills.list/run`。确认门不变。
- **E3**：`host/src/policy.ts`——loadPolicy(ws)（无文件→null）；强制点接入 `parsePublicationPlan`（min_subjects < floor / metrics 超量 / banned dimension / target_model 非白名单 → UserError，prepare 捕获后 blocked reason `policy:…`）与 `approveSchemaCard`（require_checks 且卡无 checks → 拒）。policy_version 记入 publications 行（迁移：CREATE TABLE 已含列定义则跳过；运行时 try/catch ALTER ADD COLUMN）。
- **边界不变量**：三项扩展零新增文件读取/网络/日志路径；E2 生成代码走既有沙箱。
- **Out of scope**：SQLite/JSON 输入（E4，弱据）；Model Pack/本地模型治理（E5——适配层 baseUrl 已可接本地 OpenAI 兼容端点，README 补一句）；skill 市场/自定义 DSL；RBAC 多用户身份。

## Testing Decisions

- E1：worker 单测——§12 数据 ratio（客单价 110.5/2=55.25 手算字面值）；分母零 blocked；mean/median/std 字面值。
- E2：skill spec 确定性（同参数两次逐字节一致）；端到端 skill run→confirm→run→artifacts 正确且 **audit 模型调用数=0**。
- E3：e2e——floor=5 后 min_subjects=2 的 plan prepare 即 blocked（reason 含 `policy:`）；白名单外 target_model 拒；banned dimension 拒；require_checks 触发卡拒绝；无 policy 时既有全部测试不变（回归护栏）。
- 全量 `pnpm verify` 保持绿（既有断言语义零削弱；一处既有 worker 测试的 bad_agg 用例从 "median" 改为 "percentile"——median 现为合法 agg，属必要更新）。

## Further Notes

**验收映射**：M4 退出条件逐项核销——E1（模板 schema+基准）、E2（skill 参数契约+零调用回归）、E3（policy schema+强制点回归）；§13.3「参数化分析 Skill」「统计方法」行落地；§6.7「政策」与 §10.3 `policy_version` 落地。
**红队缓解**：KA-M4-1 三项小切口；KA-M4-2 由 E2 零出站断言 + 既有对抗套件全绿证明。

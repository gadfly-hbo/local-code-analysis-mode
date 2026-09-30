# M4 Review Findings（独立子代理审查 + 修复周期，2026-09-30）

## 首轮（verdict FAIL：2×P0 + 2×P1 + 4×P2 + 4×P3）

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| P0-1 | E1 不可达 | ratio 宿主门缺失（AGGS 无 ratio 且强制 field；worker 测试绕过宿主门；退出报告失实） | **修复**：AGGS+ratio 分支（numerator/denominator 卡内校验，免 field）；新增经 `publish prepare` 的 ratio e2e（37.5 手算值） |
| P0-2 | 证据失实 | verify 记录 31 worker vs 实测 33；PRD「零修改」表述 | **修复**：如实记录 51+33；PRD 改「断言语义零削弱」并注明 bad_agg 用例必要更新 |
| P1-1 | fail-open | 损坏 policy.yaml 使 require_checks 静默失效（schema.ts 内联复制读取逻辑） | **修复**：loadPolicyStrict 统一（存在但坏 → 拒绝且报错可读），两个强制点均 fail-closed |
| P1-2 | 契约缺角 | policy_version 未记入 publications 行（PRD/§6.9/§10.3） | **修复**：列迁移 + 两条插入路径写入 |
| P2 | 确定性断言空 / lazy-env 审计名 / policy set 缺失 | | **修复**：断言措辞如实、name getter 透传、`policy set <json>` 落地 |
| P3 | 错误信息过期 agg 列表 / 测试死代码 / DB-返回不一致 / skills 接线重复 / 未转义内插 | 错误信息已随 P0-1 更新；其余记录不改（非阻断） |
| UNVERIFIED | prepare→send 之间收紧策略不阻断已批发送（规格只定两强制点——确认为有意设计：授权四元组绑定即 §5.3 语义）；month 非字典序对齐 | 记录：send 侧强制点列为 M5 候选；groupby 行序依赖已由手算基准覆盖当前数据 |

**复检轮 2**：FAIL（收窄 2 项）——ALTER 迁移缺失（旧工作区 prepare 硬崩）+ `policy set` 未实现但三处声明已修（批量替换第五次静默失败）。
**复检轮 3（终审）**：**PASS（APPROVE_WITH_COMMENTS）**——ALTER 迁移与 policy set 实证修复（旧 11 列表重建后 blocked/prepared 双路径插入携带 policy_version；set→show→floor 阻断链）；52+33 与重跑一致；残留 P3（policy set 值形态校验、测试死代码、goal 级确定性断言等）披露不改或已顺手闭合。

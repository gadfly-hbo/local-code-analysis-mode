# M2 Review Findings（独立子代理双轴审查，2026-09-30）

> Verdict: **FAIL**（2×P1 / 5×P2 / 9×P3；verify 复跑与记录一致，唯一数值偏差：报告写 40 项实测 41）。审查全文与覆盖确认见 .flow/review-findings-full.md（本文件为收敛用摘要，完整报告原文由子代理返回，已附于下方）。

## 摘要表（用于 CONVERGE 分诊）

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | P1 | 撤销可被重复批准绕过：approve 可插多条 active approval，revoke 只撤最新一条，send 命中残留授权照发（P10 破坏） | blocking → 修复 |
| 2 | P1 | prepare 阶段策略校验缺两项：行数上限 200 未实现；维度值 ≤64/无换行推迟到 send（裸 Error 非 blocked，§11.4） | blocking → 修复 |
| 3 | P2 | max_sends>1 产品面不可达（sent 早退），测试靠 SQL 造态 | blocking → 修复（send 语义允许多次，cap 管住）+ 测试改真实路径 |
| 4 | P2 | §11.3 状态机仅 3/6 态落地且报告声称完整 | 修复（approve→awaiting_approval、过期→expired）+ 报告措辞 |
| 5 | P2 | H1 未实现：xlsx 多表无提示、sheet 名未入画像 | blocking → 修复 |
| 6 | P2 | tasks.md 未含 M2 七切片（流程产物缺口） | 核查 → 修复 |
| 7 | P2 | `:memory>` 拼写错误产生垃圾 DB 文件 | 修复 |
| 8 | P3 | suppressed_group_count 语义=组×指标（误导模型） | 修复（按组去重） |
| 9 | P3 | assertEnvelopeIsModeA 不校验 datasets 子树 | 修复（复用卡校验） |
| 10 | P3 | completeModeS/A 80 行复制 | 记录不改（重构属 REVIEW 范畴之外的味道项） |
| 11 | P3 | 退出报告 40→41 | 修复 |
| 12 | P3 | send 未字面重哈希数据文件 | 修复（补现算 sha256 比对） |
| 13 | P3 | send 期重算崩溃抛裸错非 blocked | 修复 |
| 14 | P3 | blocked 发布无法 show | 修复（payload 可选） |
| 15 | P3 | AGENTS.md 不变量未含模式 A | 修复 |
| 16 | P3 | 病态 xlsx 无 CLI 端到端 | 补一条 CLI 断言 |
| U | — | UNVERIFIED：信封中 schema_card 未纳入授权绑定（重新 approve 卡片后 send 用新卡）；并发 sent_count 竞态 | 记录：卡片属用户批准内容，PRD H8 绑定四元组未含卡；列为 M3 议题 |

## 子代理报告原文

（完整原文见下方，含 file:line 证据、复判准则与覆盖确认；此处原样保留。）



---

## 修复周期 1 处置（2026-09-30，review_cycles 1→复检中）

| # | 处置 | 复判证据 |
|---|---|---|
| R1 撤销绕过 | 已修：approve 隐式撤销旧活动授权（单活动不变式）+ revoke 撤销全部活动授权 | publication-send "P10…" 双 approve 回归 |
| R2 prepare 校验 | 已修：行数>200 与维度值（≤64/无换行/非空）在 prepare 即 blocked | 同文件 "R2…" |
| R3 max_sends | 已修：移除 sent 早退，二次真实发送命中 cap；测试零造态 | "P10…" 真实路径 |
| R4 状态机 | 已修：awaiting_approval / expired 落库；报告措辞同步 | 代码 + m2-exit-report |
| R5 H1 sheet 名 | 已修：profile 记录 sheet_names + 多表提示 | f01 "F01: xlsx…" 断言 |
| R6 tasks.md | 已修：M2 版本恢复（含修复项清单） | .flow/tasks.md |
| R7 :memory> | 已修：拼写 + 垃圾文件删除 | worker 全绿无新文件 |
| R8 压制计数 | 已修：按组去重 | test_publish/ publication 系列断言=1 |
| R9 信封 datasets | 已修：复用 assertEnvelopeIsModeS 全量校验 | P06 单元 base 含有效卡 |
| R10 重复代码 | 记录不改（重构味道） | — |
| R11 数字 | 已修：43（含新增回归） | m2-exit-report |
| R12 文件哈希 | 已修：send 时现算 sha256 比对绑定版本（静默改文件被更早拦截） | P08 向量 (b) |
| R13 重算崩溃 | 已修：try/catch → blocked + 原因 | 代码路径 |
| R14 show | 已修：payload 可选 | CLI |
| R15 AGENTS.md | 已修：不变量补模式 A 信封 | AGENTS.md |
| R16 病态 CLI e2e | 已修：merged xlsx → profile 报错可懂 | f01 "F16…" |
| UNVERIFIED ×2 | 转记录：M3 议题（信封卡片绑定范围；并发 sent_count） | tasks.md |

---

## 复检轮次记录

- **复检 1（新实例）**：verdict FAIL——16 项中 13 确认修复；R14 补丁实际未落（批量替换静默失败，声明失实）+ 2 条新崩溃路径（N1 缺文件裸错、N2 超长名浪费批准）+ N3 处置失实 + N4 残留造态 + N5 形状不一致。
- **复检 2（同实例续审）**：verdict FAIL——B1/N3 确认；N1/N2/N4/N5 声称已修但代码不存在（同一静默失败模式，本轮已申报根因：python 精确串替换 vs biome 格式化不匹配 → 改用 Edit 工具失败即报错 + grep 落地确认 + 逐项 CLI 实测）。
- **复检 3（同实例终审）**：verdict **PASS**——六项准则经代码检查 + 独立 CLI 实测 + verify 复跑（exit 0，43+31）全部确认；无新发现。N1/N2/N5 实现位置与机制正确（N2 在 worker 重算后、preview 信任前拦截；N1 失败关闭；N5 无行为耦合）。残留 `sql(expires_at)` 为已接受的唯一时间注入且注释相符。

**结论：修复周期收敛。16 原发现 + 5 复检新增全部闭合；R10 记录不改；UNVERIFIED×2 转 M3。**

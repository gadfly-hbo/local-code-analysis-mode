# Review Findings（REVIEW 阶段，2026-09-30）

> **降级模式声明**：dev-flow REVIEW 本应 spawn 独立 code-reviewer 子代理（fresh context）；本次因子代理使用限额不可用，按 SKILL 契约回退为 inline 审查（同一会话执行双轴审查）。证据核对已独立复跑：`pnpm verify` exit 0，24 host + 21 worker tests 与记录一致。此降级在 DONE 总结中再次披露。

**结论：FAIL（存在 3 项 blocking 发现，进入修复周期）** —— 无 P0（未发现伪造证据、无凭据硬编码、验证命令复跑一致）。

## Spec 轴（对照 proposal.md / prd.md / tasks.md）

### R1｜P1（blocking）沙箱读范围过宽，违反 §8.2「仅授权当前任务输入」
- 证据：`host/src/isolation.ts` profile 为 `(allow default)` + 仅 `deny file-read-data (subpath "/Users")`；实测（本审查中复现）：沙箱内代码可读取 `/private/var/folders/**`（系统临时目录）中**其他进程**写入的文件（`OTHER-PROC-SECRET` 读出成功）。P05 自检探针只覆盖 HOME，未覆盖系统临时区。
- 归属：spec（§8.2 文件控制面）+ implementation。
- 复判准则：沙箱内读取系统临时目录中未授权文件必须失败（新增逃逸探针），且全量测试保持绿。

### R2｜P1（blocking）信封禁用键扫描误伤合法列名
- 证据：`host/src/llm/envelope.ts` `scanBannedKeys` 深扫所有键名；实测：Schema 卡列名 `count`/`values`（合法、用户已批准的列）触发 `data-derived key "count"` 拒绝 → 含此类列的 CSV 无法走 ask 流程。
- 归属：implementation（正确性缺陷）。
- 复判准则：列名为 `count/values/min/max/sum` 的获准卡片通过信封断言；统计值注入 `schema_card` 顶层仍被拒绝。

### R3｜P1（blocking）会话墙钟预算线定义未执行（AGENT-RUNTIME P4「三线封顶缺一禁上线」）
- 证据：`host/src/llm/egress.ts` `DEFAULT_EGRESS_BUDGET.sessionWallClockMs: 600_000` 无任何引用点（grep 仅定义处）。轮次与单调用超时已生效，第三线缺失。
- 归属：spec（G11 / 标准 P4）。
- 复判准则：网关在同一实例生命周期内跨调用累计墙钟，超限拒绝并记审计 outcome=wall_clock。

### R4｜P2 持久内核可写范围=整个 `.xanthil/runs` 树
- 证据：`host/src/kernel.ts` `buildSeatbeltProfile(allowedReads, kernelDir, [join(ws.root, "runs")])`——任一任务的生成代码可写其他任务的 run 目录（本地影响，无外发通道，但超出任务输出目录的粒度）。
- 归属：spec（§8.2 写入任务输出目录）/implementation 取舍。
- 复判准则：内核执行仅可写当前任务 runDir + kernelDir（会话预建各任务 runDir 并精确放行）。

### R5｜P2 F07「interrupt（用户可触发的取消）」未实现（超时/崩溃状态真实）
- 证据：`worker/src/worker/kernel.py` 仅 execute/health；无取消命令。超时由 host call timeout 覆盖、崩溃由 exit 事件覆盖且任务状态诚实收敛。
- 归属：PRD slice 7 验收部分达成。
- 复判准则：README 已知限制中明示「取消=终止会话（M2 提供交互取消）」。

### R6｜P2 F02 的时间边界/金额精度确认规则未在 profile/approve 强制（仅前导零有检测标记）
- 归属：spec（F02 部分达成——列级类型修正已有，口径规则属用户确认语义，未做机检）。
- 复判准则：README/tasks 披露该部分为 M2。

## Standards 轴（对照仓库 AGENTS.md + smell 基线）

- R7｜P3 模型可控的工件名未做标识符校验（`worker/src/worker/execute.py` `save_result`）：路径穿越被沙箱写范围兜住（kernel 模式下限 runs 树），但属卫生问题。→ 修复：名称白名单 `^[A-Za-z0-9_.-]+$` 且禁 `..`。
- R8｜P3 `scripts/measure-mode-s.sh` 输出 `avg_rounds_placeholder` 字样未替换为真实均值语义标注。
- 正面确认：无 Mysterious Name/投机泛型等显著 smell；双语言结构清晰；测试均为行为级断言、基准为独立手算字面值（非同义反复）；无秘钥进入代码/测试/日志。


---

## 修复周期 1 处置（2026-09-30，review_cycles 0→1）

| 发现 | 处置 | 复判证据 |
|---|---|---|
| R1 系统临时区可读 | **已修复**：profile 增加定向 `deny /private/var/folders`（其后放行 realpath 的工作区路径）；全枚举方案实测触发 `python -m` 静默 SIGABRT 故弃用（系统性根因记录在 isolation.ts 注释）。自检新增 system_read_probe（passed 纳入）；实测原泄露场景现 BLOCKED | `sandbox.test.ts` system_read_blocked 断言 + runIsolated 实测 BLOCKED |
| R2 列名误伤 | **已修复**：columns 子树的键名豁免禁用键扫描（列名属获准 Schema）；统计注入卡顶层仍拒 | `egress.test.ts` "legitimate column names like count/min/sum…" + 原统计注入用例仍绿 |
| R3 墙钟未执行 | **已修复**：网关实例级 sessionStartedAt，超限拒绝（三线齐备：轮次/单调用超时/墙钟） | `egress.test.ts` "session wall clock is the third enforced budget line" |
| R4 内核可写范围 | **已修复**：KernelManager 按 taskIds 限定 run 根目录（不再放行整个 runs 树） | `session.test.ts` 全绿（内核执行在新范围内工作） |
| R5 interrupt 缺失 | **披露**：README 已知限制明示（取消=终止会话，M2 交互取消） | README「已知限制」 |
| R6 F02 口径机检缺失 | **披露**：README 已知限制明示 | README「已知限制」 |
| R7 工件名未校验 | **已修复**：save_result/save_chart 标识符白名单 | worker 全测试绿 |
| R8 脚本占位标注 | **已修复**：输出字段改名 model_call_rounds_total | scripts/measure-mode-s.sh |

修复后全量验证：`pnpm verify` exit 0（host 24+2 新增、worker 全绿）。

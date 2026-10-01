# M5 Review Findings（独立子代理审查 + 修复周期，2026-10-01）

## 首轮（verdict FAIL：P0 + 4×P1 + 5×建议）

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| P0 | UI 断裂 | 结果渲染进游离节点（getElementById 误传 CSS 选择器）；succeeded 任务从不拉取工件 | **修复**：querySelector + succeeded 自动 loadTaskArtifacts；实测：demo 工作台 skill 任务 confirm→run→工件表格/导出按钮齐 |
| P1 | 盲签 | GET /api/tasks/:id 路由缺失，确认前看不到计划/代码 | **修复**：路由补齐（实测 has spec=True） |
| P1 | 越权写 | /api/schema 的 alias 未校验即拼路径（可出工作区）；无 content-type 校验 | **修复**：ALIAS_PATTERN 前置校验（实测 bad-alias 400）+ parseJsonBody 统一入口 |
| P1 | 任意路径 | export 接受任意 outPath；planPath 路由为死攻击面（文件探测 oracle） | **修复**：export 限定 workspace/exports/；planPath 路由删除（UI 走 /object） |
| P1 | 启动器错配 | serve 未指定 --workspace → 浏览器落在仓库根空 .xanthil | **修复**：--workspace "$WS/.xanthil"（CLI 约定为 .xanthil 目录本身）；根目录垃圾清除 + gitignore |
| P2 | — | JSON 体错误 500、沙箱自检每 5s 起子进程、schema 编辑器不产 checks（require_checks 策略下必 400）、授权弹窗缺内容摘要、测试名不符 | **修复**：4xx 化；60s 缓存；编辑器按语义/列名自动产 checks；测试名如实（弹窗摘要维持卡片内指标表——布局取舍，未逐字复述） |
| P3 | — | skill-run 绕 facade 复刻逻辑；CURRENT_MODEL 模块全局；canary 缺本地存在断言；50MB 实为 36MB；CSV 引号列错分 | **修复**：facade 化；canary 双向断言（run.log 含标记）；报告口径改 36MB；其余记录（CURRENT_MODEL 单实例语义、引号列展示） |

## 复检（终审）

修复后实测链（非夹具）：launcher 一键启动 → 工作台含 demo 数据集 + GLM-5.3-Flash + 沙箱 passed → skill 任务 detail/confirm/run/工件（月度 2026-07 280.5/3、2026-08 300.0/3，手算一致）→ `open` 浏览器触发。`pnpm verify` exit 0（62+33）。浏览器实操（点击/渲染）为 UNVERIFIED——API 接缝断言 + 源码级修复复检覆盖行为面，如实声明。

# M5 本地 Web 工作台 — 退出证据报告

日期：2026-10-01｜范围：用户裁定（本地 Web 工作台，deep-research 同构）。

## 结论：通过

| 验收 | 证据 |
|---|---|
| 非技术用户闭环（上传→口径确认→提问→按钮运行→结果/导出→授权发布） | `host/public/`（index.html/app.js/style.css，无构建链 W2）+ HTTP API（`host/src/server.ts`，node:http 零新依赖 W1）；API 级全链 e2e（上传 base64→schema 卡对象批准→ask→confirm→run→工件 raw 渲染→skill 零调用）`host/test/web-workbench.test.ts` 4 项全绿 |
| 确认门不可弱化（W3） | run 前必须 confirm（API 测试断言早跑 400）；UI"确认并运行"= 一键完成 confirm+run，无跳过选项 |
| UI 不是第二出站边界（KA-M5-1） | 全部模型调用经服务端适配层/唯一网关；Web canary 测试：上传含标记 CSV→全链→审计与出站 JSONL 零标记，且本地 run.log 确含标记（通道分离双向断言） |
| 上传安全（KA-M5-2） | 路径分隔符拒绝、扩展名白名单、base64 体 50MB 上限（有效文件约 36MB）、服务端定路径——对抗用例 4xx |
| 仅本机（KA-M5-3） | 默认 127.0.0.1；`--host` 保留但文档声明仅本机 |
| 状态条/审计可视化 | /api/state 聚合（模型目标/沙箱自检/最近出站/技能清单）；UI 顶栏 + 审计弹窗 |
| 一键启动 | `启动本地分析.command` 深度研究同构：起 serve → 探活 → `open` 浏览器；--check 含 serve 冒烟 |
| 回归护栏 | 既有 58+33 零修改全绿（62+33 终态） |

## 已知边界

- UI 为原生单页（无构建链）；浏览器自动化不在验证门（API 接缝承担全部行为断言）。
- run 为同步长请求（沙箱 120s 上限，本地单用户足够；W7）；多任务并发跑未做队列。
- 发布区 UI 为表单化最小集（ratio 的分子/分母以逗号字段表达）；无鉴权（本地单用户，如实声明）。


## 审查修复周期 1（2026-10-01）

首轮 FAIL（P0+4×P1+建议项）：**P0** UI 结果渲染进游离节点（getElementById 误传选择器）→ querySelector + succeeded 任务自动拉取工件；**P1** 补 GET /api/tasks/:id（确认前可见计划）；alias 越权写（校验后才落盘）；export 限定 exports/ 目录 + 删除死 planPath 路由；启动器 serve 补 --workspace（根目录垃圾 .xanthil 已清除并入 gitignore）。**建议项**：JSON 体错误 4xx、沙箱自检 60s 缓存、schema 编辑器产 checks（require_checks 策略兼容）、canary 补本地存在断言、skill-run 走适配层门面、测试名如实。

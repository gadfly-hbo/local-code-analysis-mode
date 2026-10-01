# PRD：M5 本地 Web 工作台

> 事实源：用户裁定（本地 Web 工作台，deep-research 同构）+ `.flow/red-team.md`（聚焦版）。基线：fba5bd9。产品原则与硬边界（proposal §3/§5/§8）不变。

## Problem Statement

工具只有 CLI 入口，非技术用户（数据分析/业务人员）无法使用：他们需要浏览器里上传文件、看结构确认口径、输入问题、点按钮运行、看结果，以及必要时授权发布聚合结果。

## Solution

`xanthil serve`（默认 127.0.0.1:4170）+ 单页原生 HTML/JS 工作台（`host/public/`，无构建链）：

**四个区（对应 CLI 全流程）**
1. **数据区（左）**：拖拽/选择上传（CSV/XLSX/Parquet，base64 JSON 上传）→ 自动 register+profile → Schema 卡表格化编辑（grain、字段语义、checks）→ 批准。多 sheet 提示、病态文件错误直接展示。
2. **分析区（中）**：问题输入 → ask（展示计划：goal/假设/代码只读视图）→ **确认运行**按钮（每任务显式）→ 状态轮询 → 结果渲染（CSV→表格、PNG→图）+ 导出。内置 Skill 下拉（零模型调用）。
3. **发布区（右）**：发布计划表单 → prepare → 逐值预览（被压制分组灰显+计数）→ 授权弹窗（明示目标模型/期限/次数/内容摘要）→ 发送 → 解读展示；撤销。
4. **边界状态条（顶）**：当前模式、模型目标、最近出站记录、沙箱状态；audit 展开。

**服务端（`host/src/server.ts`，node:http 零新依赖）**：JSON API 全部经 `createXanthilCore` + 少量同域模块调用；静态同源；仅 127.0.0.1。

## API 面

GET /api/state；POST /api/datasets {alias,filename,contentB64}→register+profile；POST /api/schema {alias,card}→approve；POST /api/ask；POST /api/skill-run；POST /api/tasks/:id/confirm|run|cancel；GET /api/tasks/:id/artifacts；GET /api/artifacts/:id/raw；POST /api/artifacts/:id/export；POST /api/publications {plan}→prepare；POST /api/publications/:id/approve|send|revoke；GET /api/audit

## GRILL 决议（W 系）

- **W1 零新依赖**：node:http 手写路由 + base64 上传（弃 multipart）。
- **W2 UI 无构建链**：原生 ES 模块 JS+CSS；表格/表单/卡片三原语。
- **W3 确认门不可弱化**：run 必先 confirm；无"跳过确认"；自动跑仅指确认后免重复点击。
- **W4 上传安全**：文件名清洗、服务端定路径、50MB 上限、扩展名白名单。
- **W5 仅 127.0.0.1**：无鉴权（本地单用户，如实声明）。
- **W6 API 语义**：业务态（blocked/expired）200+status 字段；错误 4xx/5xx {error}。
- **W7 同步 run**：HTTP run 同步返回终态（沙箱 120s 上限，单用户本地足够）。
- **W8 凭据**：serve 复用 with-llm-env 检测逻辑；状态条显示模型或"未配置"。

## Testing Decisions

主接缝=HTTP API：vitest 起真服务（随机端口）fetch 全链 e2e（fixture）；canary 对抗（上传含标记 CSV→全链→出站审计零标记）；上传安全用例（穿越名/超限/坏扩展 4xx）。UI 不进 verify 门。

## Out of Scope

React/vite/Electron、任务队列/WebSocket、多用户鉴权、Desktop 合流、远程绑定。

## 验收映射

非技术用户闭环=M5 核心；边界不变=API canary+既有 58+33 回归；§5.1 主流程 1–10 步全有 UI 入口；§5.3 授权语义落发布弹窗。

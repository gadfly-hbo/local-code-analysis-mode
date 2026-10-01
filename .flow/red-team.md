# Red-Team: M5 本地 Web 工作台（聚焦版）

日期：2026-10-01｜范围：用户已裁定（本地 Web 工作台，deep-research 同构）——只攻击实施承重假设，不再议路线。

## Top Kill-Assumptions

### KA-M5-1. UI 不成为第二套边界（最大风险）
- **Claim**: 工作台只是操作入口，隐私边界仍在库层。
- **Fails if**: 为「预览图表/导出/展示」方便，UI 层直接把工件内容、stdout 或画像统计拼进任何模型请求；或确认门被「自动跑」弱化成勾选默认。
- **防线**：服务端所有模型调用仍经 EgressGateway（adapter 内置）；UI 的"运行"必须逐任务点击确认（提案 §5.1 第 5 步不可省）；API 层复跑 canary 对抗（上传含标记的 CSV → 全链 → 断言出站载荷零标记）。
- **Kill criterion**: Web API 接缝 canary 失败 → 不发布。

### KA-M5-2. 上传通道安全
- **Claim**: 拖拽上传 CSV/XLSX/Parquet（JSON+base64，无 multipart 依赖）。
- **Fails if**: 任意路径写入（客户端传路径）或超大文件 DoS。防线：文件名白名单、服务端生成路径、大小上限（如 50MB）、仅写 workspace/datasets/。
- **Kill criterion**: 路径穿越/超限上传被拒的测试。

### KA-M5-3. 服务面收窄
- 仅绑定 127.0.0.1；无 DNS 重绑定防护需求（本地单用户工具，如实声明）；无跨域（同源静态服务）；API 不接受 workspace 外路径参数。

### KA-M5-4. 无构建链的 UI 可达产品级
- **Claim**: 单页原生 HTML/JS/CSS（无 vite/React）可交付「上传→确认→提问→运行→结果→发布」完整体验。
- **Fails if**: 交互复杂度失控。防线：表格/表单/卡片三类原语覆盖全部场景；图表复用 worker 生成的 PNG 工件；CSV 工件前端渲染表格。
- 若实施中发现 UI 面失控 → 允许中途升级 vite（记录于 history）。

### KA-M5-5. 预算
- 会话已极长；M5 切片压到 4 片（API 骨架+e2e / 数据+分析 UI / 发布+审计 UI / 启动器集成+文档），测试打在 HTTP API 接缝，UI 自动化不进 verify 门。

## Verdict

**go**——路线已由用户裁定；最大风险 KA-M5-1 有现成对抗测试模式可复用；无构建链选择保留逃生口。

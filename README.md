# Xanthil 本地化数据处理工具（local-code-analysis-mode）

基于《Xanthil 本地化数据处理工具产品方案 v1.0》的本地优先分析执行工具实现。**模型理解结构，代码接触数据，用户决定结果是否提供给模型。**

当前交付范围：方案 §17.1 的 **M0（边界验证）+ M1 最小核心（CSV、持久内核）**。退出证据见 [docs/m0-exit-report.md](docs/m0-exit-report.md)。

## 隐私边界（准确声明，非绝对承诺）

- 默认**模式 S（结构编程）**：云端模型只收到经用户确认的模式 S 信封——system 契约、分析目标、数据集别名 + Schema 卡（字段类型/语义/粒度）、允许库列表，以及（失败修复轮中）**结构性诊断白名单**（语法错误/缺失库名/未注册字段名，且回显 token 仅限模型自身代码中出现过的）。
- **内核输出永不进入模型上下文**：stdout/stderr/异常原值/图表/明细只落本地（run.log / 工件库 / 审计 JSONL）。每次调用可经 `xanthil audit` 核对实际出站载荷。
- 生成代码在 **seatbelt 沙箱**内执行（deny network*；写仅限 run 目录；读 /Users 仅放行解释器/venv/worker/注册数据集），后端须先过逃逸自检（`xanthil sandbox check`）。
- “泄漏为 0”仅指限定测试集（P01–P03/P09/P11 对抗测试）与受控运行条件，不构成所有攻击与部署环境下的绝对承诺。隔离验证目前仅覆盖 darwin/seatbelt。

## 快速开始

```bash
pnpm install && (cd worker && uv sync)   # 安装依赖（TS host + Python worker）
pnpm verify                               # biome + tsc + vitest + ruff + pytest
```

典型流程（模式 S 闭环）：

```bash
xanthil init                                   # 工作区（.xanthil/）
xanthil register sales.csv --alias sales       # 登记数据集（sha256 内容版本）
xanthil profile sales                          # 本地画像 + Schema 卡草案（YAML）
$EDITOR .xanthil/datasets/sales.schema.yaml    # 确认 grain/字段语义
xanthil schema approve sales
XANTHIL_LLM_BASE_URL=... XANTHIL_LLM_MODEL=... XANTHIL_LLM_API_KEY=... \
  xanthil ask "按品类汇总净销售额" --dataset sales
xanthil confirm <taskId>
xanthil run <taskId>                           # 沙箱执行；失败时最多 3 轮结构性诊断修复
xanthil artifacts <taskId>                     # 本地工件
xanthil export <artifactId> --out out.csv      # 显式导出
xanthil audit                                  # 模型实际收到了什么
xanthil session <t1> <t2>                      # 持久内核：多任务复用已加载数据（M1）
xanthil sandbox check                          # 隔离后端逃逸自检
```

离线/测试：`XANTHIL_LLM_FIXTURE=<file.jsonl>` 夹具回放（每行一个模型响应，消费状态跨进程持久）。真实端点冒烟：`scripts/smoke-real.sh`；模式 S 成功率度量：`scripts/measure-mode-s.sh`。

## 架构

```
CLI (host/, TypeScript)
 ├─ catalog/schema   数据集目录（SQLite）、内容版本、Schema 卡（本地画像与模型可见卡分离）
 ├─ llm/             唯一模型出站网关（模式 S 信封 + 出站前逐字段断言 + 双审计 + 预算）
 │                    pi-ai 0.86.1 钉版，仅在适配层引用（AGENT-RUNTIME 合规，工人模式）
 ├─ isolation.ts     可插拔隔离后端（darwin/seatbelt，deny-first profile，路径 realpath 归一）
 ├─ kernel.ts        持久内核管理（NDJSON over stdio，沙箱内守护进程）
 └─ orchestrator.ts  ask/confirm/run/session 状态机与修复轮
worker/ (Python 3.12, uv)
 ├─ execute.py       受限执行：ctx.datasets（懒加载）/ ctx.duckdb()（加固）/ 工件保存
 ├─ kernel.py        持久内核守护（变量与数据句柄跨轮复用、版本失效）
 ├─ profile.py       本地画像 + 无统计 Schema 卡草案
 └─ sandbox_check.py 逃逸自探针（联网/越权读/越权写）
```

规格链：`.flow/proposal.md`（v1.0 方案，事实源）→ `.flow/prd.md`（含 GRILL 决议 G1–G16）→ `.flow/tasks.md`（10 个垂直切片）。

## 已知限制（诚实清单）

- 文件支持仅 CSV；XLSX/Parquet、模式 A 可信聚合发布、GUI、Desktop 集成属 M2/M3。
- Linux/Windows 隔离后端为接口占位；未过后端自检的平台拒绝执行（fail-closed）。
- 内核作用域固定为启动时已注册数据集；新增注册需新内核。
- **取消（interrupt）尚无用户级命令**：终止会话即丢弃内核状态（超时/崩溃状态真实收敛；交互式取消属 M2）。
- **F02 时间边界/金额精度口径为用户确认语义，未做机检**（仅前导零 ID 有自动标记）。
- 读隔离采用定向禁令（/Users 与系统临时区 /private/var/folders 默认拒读、显式放行）：全枚举读在 macOS seatbelt 下会触发 `python -m` 静默崩溃，故系统其余区域（/usr 等）保持可读——不包含用户数据，但如实声明非最小读集。
- 进程数上限（fork 炸弹防护）未实现（当前 macOS SBPL 不支持 `limit process`）。
- matplotlib 首次渲染需建字体缓存（~8s/新 run 目录）。

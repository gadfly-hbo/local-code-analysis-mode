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
xanthil cancel <taskId>                        # 取消未运行任务
xanthil sandbox check                          # 隔离后端逃逸自检
```

模式 A（授权聚合解读，M2）——在模式 S 结果之上：

```bash
xanthil publish plan sales                     # 发布计划草案（指标/维度/主体/阈值/期限）
$EDITOR <plan_path>                            # 定义 sum/count/count_distinct/avg 与维度（含 month()）
xanthil publish prepare <plan.yaml>            # 可信服务重算 + 策略校验 + 本地预览（prepared/blocked）
xanthil publication <pubId>                    # 逐值检查将外发的聚合与被压制的分组
xanthil publish approve <pubId>                # 绑定：载荷摘要+数据版本+目标模型+次数+期限
xanthil publish send <pubId>                   # 发送前现场重算比对 + 六项复验，通过才出站
xanthil publish revoke <pubId>                 # 撤销（阻止后续发送；已发送内容无法收回）
xanthil publications                           # 发布清单与状态
```

支持 CSV / 规范表格型 `.xlsx` / Parquet（病态文件显式拒绝）。

离线/测试：`XANTHIL_LLM_FIXTURE=<file.jsonl>` 夹具回放（每行一个模型响应，消费状态跨进程持久）。真实端点冒烟：`scripts/smoke-real.sh`；模式 S 成功率度量：`scripts/measure-mode-s.sh`。

## 架构

```
CLI (host/, TypeScript)
 ├─ catalog/schema   数据集目录（SQLite）、内容版本、Schema 卡（本地画像与模型可见卡分离，checks 机检）
 ├─ llm/             唯一模型出站网关（模式 S/A 信封 + 出站前逐字段断言 + 双审计 + 预算三线）
 │                    pi-ai 0.86.1 钉版，仅在适配层引用（AGENT-RUNTIME 合规，工人模式）
 ├─ isolation.ts     可插拔隔离后端（darwin/seatbelt，定向禁令 + realpath 归一 + 逃逸自检）
 ├─ kernel.ts        持久内核管理（NDJSON over stdio，沙箱内守护进程）
 ├─ publication.ts   模式 A：计划校验/授权绑定/发送复验（六项）/撤销
 └─ orchestrator.ts  ask/confirm/run/session 状态机与修复轮
worker/ (Python 3.12, uv)
 ├─ readers.py       统一读取：CSV/XLSX/Parquet（dtype=str 契约 + 病态预检）
 ├─ execute.py       受限执行：ctx.datasets（懒加载）/ ctx.duckdb()（加固）/ 工件保存
 ├─ publish.py       可信发布执行器：模板重算/主体计数压组/精度（绝不执行生成代码）
 ├─ kernel.py        持久内核守护（变量与数据句柄跨轮复用、版本失效）
 ├─ profile.py       本地画像 + 无统计 Schema 卡草案
 └─ sandbox_check.py 逃逸自探针（联网/越权读/越权写）
```

规格链：`.flow/proposal.md`（v1.0 方案，事实源）→ `.flow/prd.md`（M1 G1–G16 + M2 H1–H12 决议）→ `.flow/tasks.md`。退出证据：[docs/m0-exit-report.md](docs/m0-exit-report.md)、[docs/m2-exit-report.md](docs/m2-exit-report.md)。

## 已知限制（诚实清单）

- 模式 A 发布为单数据集、固定模板（sum/count/count_distinct/avg × 维度 + month() + 基础筛选）；SQL/join/自定义表达式、组合差分查询自动防护（§6.7 本版声明不承诺）、解释自动多轮 → 后置。
- GUI、Desktop 集成、XLSX 宏/多表头自动理解（显式拒绝）→ M3+。
- Linux/Windows 隔离后端为接口占位；未过后端自检的平台拒绝执行（fail-closed）。
- 内核作用域固定为启动时已注册数据集；新增注册需新内核。
- 取消覆盖未运行态（cancel 命令）与会话中断（SIGINT）；一次性 `run` 为同步进程，Ctrl-C 可能遗留沙箱子进程（无外发通道，见 m2-exit-report）。
- 读隔离采用定向禁令（/Users 与系统临时区 /private/var/folders 默认拒读、显式放行）：全枚举读在 macOS seatbelt 下会触发 `python -m` 静默崩溃，故系统其余区域（/usr 等）保持可读——不包含用户数据，但如实声明非最小读集。
- 进程数上限（fork 炸弹防护）未实现（当前 macOS SBPL 不支持 `limit process`）。
- matplotlib 首渲已共享 workspace 级字体缓存（首次 ~8s，之后免）。

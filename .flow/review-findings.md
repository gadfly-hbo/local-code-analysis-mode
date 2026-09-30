# M3 Review Findings（独立子代理双轴审查 + 修复周期，2026-09-30）

## 首轮（verdict FAIL：1×P0 + 1×P1 + 5×P2 + 3×P3）

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| P0 | 凭据泄露 | apiKey 经 process.env 全量透传 Worker 环境（§8.2 违反，注释失实） | **修复**：pi-ai literal-key auth（resolve 返回固定凭证，caller.ts 零 process.env 写入）+ isolation.ts 强制剥离 XANTHIL_LLM_*；复检方独立实证 worker env 命中=0 |
| P1 | 功能断裂 | 模式 A 发送绕开注入 caller（适配层 publication.send 必败） | **修复**：sendPublication 接受注入 caller；target-model 绑定用 caller 身份（modelIdentityOf）；新增适配层 prepare→approve→send e2e |
| P2a | PRD 落实 | J8 plan 对象入口被静默丢弃 | **修复**：publications.prepare 接受对象（YAML round-trip 同一校验）；测试覆盖 |
| P2b | 声明失实 | "CLI-identical" 无同 fixture 对拍证据 | **修复**：退出报告措辞如实（同核性=共享模块构造） |
| P2c | 参考接线失真 | goal/dataset 来源、confirm 门、run_id 形态与真实契约不符 | **修复**：reference 头部诚实化 + INTEGRATION.md 同步 |
| P2d | 行为漂移 | confirm 裸 Error；revoke 循环复制 | **修复/接受**：UserError；revoke 空集返回 [] 属库幂等语义（复检方裁定不阻断），下沉共享函数记为后续 |
| P3a | 重复 | index.ts 与 caller.ts 重复 fixture 解析 | **修复**：index.ts 委托 createCaller |
| P3b | 缺 API | PRD 列 exportArtifact 未实现 | **修复**：artifacts.export |
| P3c | 流程产物 | tasks.md 无 M3 节 | **修复**：补 M3 节 |

## 复检（verdict **PASS**，2026-09-30）

四项复查标准全部由复检方独立验证（env 实证、caller.ts 全文无 env 写入、模式 A 适配层 e2e 通过、文档措辞）。残留 P3 全部闭合于本轮：
- README 适配层章节（此前 python 替换再次静默失败——与本 flow 教训一致，已用 Edit 工具补上并改限制清单措辞）
- J8 临时 plan 文件移入 publications/ 目录
- 测试名/退出报告旧措辞（CLI-identical → CLI-parity/共享模块构造）
- 记录不改：适配层 tasks.run 无 CLI 式 running 兜底 settle（边缘健壮性，后续）；真实 provider（非 fixture）注入 caller 全链 e2e 维持 UNVERIFIED（需活端点）；撤销循环下沉共享函数（后续重构）

**结论：M3 修复周期收敛，PASS。**

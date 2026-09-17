# Repository Instructions

- 这是单个 npm 包形式的 Pi 扩展；运行入口只有 `index.ts`，由 `package.json` 的 `pi.extensions` 注册。没有构建脚本，也不需要提交构建产物。
- Node.js 要求为 `>=22.19.0`；开发依赖固定 Pi `0.85.1`、TypeScript `5.9.3` 和 Node 类型 `22.19.19`。安装依赖使用 `npm ci`，以匹配 `package-lock.json`。
- 可用的验证命令是：`npm test`（Node 内置测试运行器）、`npm run check`（严格 TypeScript 检查）、`npm run pack:check`（检查 npm 包内容）和 `npm run smoke`（离线启动 Pi 并显式加载 `./index.ts`）。
- 测试文件是 `test/*.test.mjs`，直接导入 TypeScript 入口；测试通过 Node 的可控时钟和定时器 mock 运行，不调用模型 API。
- 实现只能通过 Pi 扩展/软件包 API 工作：指标状态写入 `ctx.ui.setStatus()`，并在 `ctx.hasUI` 为假时不创建计时器或输出状态；不要加入模型请求、持久化或其他运行时依赖。
- 统计仅保存在内存中；`session_start` 和 `session_tree` 会重置会话统计，结束 turn/agent 或关闭 session 时必须清理计时器和状态。
- `usage.output` 已包含 reasoning token，不要再累加 `usage.reasoning`。只有带可观测输出且以 `stop`、`length` 或 `toolUse` 完成的响应计入 AVG/TTFT；错误、取消、延期和空响应不计入。

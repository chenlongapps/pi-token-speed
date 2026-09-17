# @chenlongapps/pi-token-speed

一个轻量级的 [Pi Coding Agent](https://pi.dev/) 扩展，在 Pi 的终端状态栏显示实时 LLM token 生成指标。

```text
TPS: 42.0 · AVG: 38.5 · TTFT: 1.2
```

参考 [OpenCode Token Speed](https://github.com/chenlongapps/opencode-token-speed) 的指标和滑动窗口设计，使用 Pi 官方扩展 API 实现。单个 TypeScript 文件，无额外运行时依赖，无需构建。

## 安装

本地安装（将路径替换为实际仓库路径）：

```bash
pi install /absolute/path/to/pi-token-speed
```

只为当前项目安装时，加上 `-l`。安装后重新启动 Pi；修改扩展后可执行 `/reload`。

在仓库目录临时体验，不修改安装配置：

```bash
pi -e ./index.ts
```

发布到 npm 后，也可以安装：

```bash
pi install npm:@chenlongapps/pi-token-speed@latest
```

已使用 Pi `0.85.1` 验证。开发和测试要求 Node.js `>=22.19.0`。

通过 `pi config` 可以停用扩展；本地安装的扩展可用 `pi remove /absolute/path/to/pi-token-speed` 卸载（项目级安装加上 `-l`）。

## 显示

指标通过 `ctx.ui.setStatus()` 放在 Pi 原生底部状态栏，文本使用当前主题的暗色（`dim`），布局和窄终端截断由 Pi 管理。有可观测输出后才显示状态栏，TPS 位于最前；单个尚无数据的指标显示 `-`。

流式输出期间每 100 ms 更新一次；超过 1.5 秒没有输出、执行工具或进入空闲时，TPS 保留最近有效读数。完成响应后，TPS 切换为该次完整响应的生成速度。print / JSON 模式不创建计时器或输出状态栏内容。

## 指标

- **TPS**：流式生成时，最近 5 秒输出的估算 token 数 ÷ 窗口时长（最少按 1 秒计算），单位为 token/秒。
- **AVG**：本次会话统计期间，所有成功完成的模型响应的 token 总数 ÷ 生成时间总和。它是按时长加权的平均值，不是各次 TPS 的算术平均。
- **TTFT**：这些响应从 `before_provider_request` 到首个可观测输出（文本、思考或工具调用）的平均延迟，单位为秒。自定义 provider 未触发该钩子时，使用 `turn_start` 作为起点。

流式 token 数按 UTF-8 输出每 5 字节约 1 token 估算；完成后，优先使用 provider 返回的 `usage.output` 计算该次 TPS 和 AVG，缺失、无效或为 0 时使用累计字节估算。Pi 的 `usage.reasoning` 是 `usage.output` 的子集，不会重复相加，也不会计入输入或缓存 token。

生成时长从首个可观测输出算到 `message_end`，排除首 token 等待、工具执行和用户空闲时间。单次响应最少按 250 ms 计算，以减少极短响应的数值尖峰。正常结束、达到输出上限和工具调用响应参与平均；出错、取消、延期响应，以及未观测到输出的响应不参与平均。

这些指标用于观察趋势，不是模型基准测试：字节估算受语言和内容影响；网络缓冲、隐藏思考、扩展执行和 provider 内部重试也可能影响计时。

统计数据只保存在内存中，在新建、恢复、派生会话、重新加载扩展或 `/tree` 导航时重置，不从历史消息重建。退出时会清理计时器和状态栏。

## 开发验证

```bash
npm ci
npm test
npm run check
npm run pack:check
```

测试使用 Node 内置测试运行器和可控时钟，不调用模型 API。覆盖窗口采样、字节估算、官方 token 校准、TTFT、工具调用、取消重试和会话生命周期。类型检查使用真实 Pi 类型；打包检查确保 npm 包包含扩展入口。

交互式加载检查：

```bash
npm run smoke
```

## 参考文档

- [Pi 文档](https://pi.dev/docs/latest)
- [Pi 扩展](https://pi.dev/docs/latest/extensions)
- [Pi 包](https://pi.dev/docs/latest/packages)

## 许可证

MIT

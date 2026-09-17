# @chenlongapps/pi-token-speed

[English](README.md) · [npm](https://www.npmjs.com/package/@chenlongapps/pi-token-speed) · [GitHub](https://github.com/chenlongapps/pi-token-speed)

一个轻量级的 [Pi Coding Agent](https://pi.dev/) 扩展，在 Pi 的终端状态栏显示实时 LLM token 生成指标。

```text
TPS: 42.0 · AVG: 38.5 · TTFT: 1.2
```

参考 [OpenCode Token Speed](https://github.com/chenlongapps/opencode-token-speed) 的指标和滑动窗口设计，使用 Pi 官方扩展 API 实现。单个 TypeScript 文件，无额外运行时依赖，无需构建。

## 安装


```bash
pi install npm:@chenlongapps/pi-token-speed@latest
```


## 指标

- **TPS**：流式生成时，最近 5 秒输出的估算 token 数 ÷ 窗口时长（最少按 1 秒计算），单位为 token/秒。
- **AVG**：本次会话统计期间，所有成功完成的模型响应的 token 总数 ÷ 生成时间总和。它是按时长加权的平均值，不是各次 TPS 的算术平均。
- **TTFT**：这些响应从 `before_provider_request` 到首个可观测输出（文本、思考或工具调用）的平均延迟，单位为秒。自定义 provider 未触发该钩子时，使用 `turn_start` 作为起点。

流式 token 数按 UTF-8 输出每 5 字节约 1 token 估算；完成后，优先使用 provider 返回的 `usage.output` 计算该次 TPS 和 AVG，缺失、无效或为 0 时使用累计字节估算。Pi 的 `usage.reasoning` 是 `usage.output` 的子集，不会重复相加，也不会计入输入或缓存 token。

## 许可证

MIT

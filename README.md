# @chenlongapps/pi-token-speed

[中文文档](README.zh-CN.md) · [npm](https://www.npmjs.com/package/@chenlongapps/pi-token-speed) · [GitHub](https://github.com/chenlongapps/pi-token-speed)

A lightweight [Pi Coding Agent](https://pi.dev/) extension that displays real-time LLM token generation metrics in Pi's terminal status bar.

```text
TPS: 42.0 · AVG: 38.5 · TTFT: 1.2
```

Inspired by the metrics and sliding-window design of [OpenCode Token Speed](https://github.com/chenlongapps/opencode-token-speed), this extension uses Pi's official extension API. It consists of a single TypeScript file, has no additional runtime dependencies, and requires no build step.

## Installation

```bash
pi install npm:@chenlongapps/pi-token-speed@latest
```

## Metrics

- **TPS**: During streaming, the estimated number of tokens output in the last 5 seconds divided by the window duration, with a minimum duration of 1 second. Measured in tokens per second.
- **AVG**: Across the current session's statistics, the total tokens from all successfully completed model responses divided by their total generation time. This is a duration-weighted average, not the arithmetic mean of individual TPS values.
- **TTFT**: The average delay from `before_provider_request` to the first observable output (text, thinking, or a tool call) for those responses, measured in seconds. If a custom provider does not trigger this hook, `turn_start` is used as the starting point.

Streaming token counts are estimated at approximately one token per 5 bytes of UTF-8 output. After completion, the provider's `usage.output` is preferred for calculating TPS and AVG for that response; if it is missing, invalid, or zero, the accumulated byte estimate is used instead. Pi's `usage.reasoning` is a subset of `usage.output`, so it is not counted twice and input or cached tokens are excluded.

## License

MIT

# @chenlongapps/pi-token-speed

[中文文档](README.zh-CN.md) · [npm](https://www.npmjs.com/package/@chenlongapps/pi-token-speed) · [GitHub](https://github.com/chenlongapps/pi-token-speed)

A lightweight [Pi Coding Agent](https://pi.dev/) extension that displays real-time LLM token generation metrics in Pi's terminal status bar.

```text
TPS: ~42.0 · AVG: 38.5 · TTFT: 1.2
```

Inspired by the throughput calculations of [OpenCode Token Usage](https://github.com/chenlongapps/opencode-token-usage), this extension uses Pi's official extension API. It consists of a single TypeScript file, has no additional runtime dependencies, and requires no build step.

## Installation

```bash
pi install npm:@chenlongapps/pi-token-speed@latest
```

## Metrics

- **TPS (streaming)**: Text, thinking and tool argument deltas from the last **2 seconds** are estimated at **one token per 4 UTF-8 bytes**, then divided by the time between the window's first and last samples. At least two distinct sample timestamps are required; there is no minimum duration. Rates are smoothed with an exponentially weighted moving average (EWMA, **α = 0.35**) and marked with `~`.
- **TPS (completed)**: The response's `usage.output` divided by the full request duration, from `before_provider_request` to `message_end`. If a custom provider omits the request hook, timing starts at `turn_start`. All providers use this same calculation.
- **AVG**: The total output tokens from successful responses divided by their total request duration. This duration-weighted average includes the wait before the first output and excludes tool execution and user waiting between requests.
- **TTFT**: The average delay from request start to the first observable output (text, thinking or a tool call), measured in seconds, for those successful responses.

The 100 ms refresh timer recalculates live TPS only when new deltas arrive. Pauses retain the last valid reading; each request starts a fresh window and EWMA. Tool names and missing content supplied at block completion count toward TTFT and the byte fallback, with duplicates removed, but do not create live delta samples.

When final `usage.output` is missing, invalid or zero, the fallback is `ceil(total UTF-8 bytes / 4)`, rounded once for the whole response. That response's TPS keeps `~`; AVG also keeps `~` if any included response used the fallback, until session statistics reset. Pi's `usage.output` already includes reasoning tokens, so `usage.reasoning` is never added again. Input and cached tokens are excluded.

Streaming TPS estimates observable output speed. Completed TPS measures throughput over the client's full request duration, including network waiting and hidden reasoning; it is not a measurement of pure server generation speed. Hidden token counts are not inferred, and no model-specific multipliers are used. For example, a 12-second request whose first output arrives at 10 seconds and whose `usage.output` is 1200 ends at `TPS: 100 · AVG: 100 · TTFT: 10.0` when it is the session's only sample.

Only responses with observable output, positive request duration and a `stop`, `length` or `toolUse` completion enter AVG and TTFT. Errors, cancellations, deferred responses and empty output are excluded. Statistics stay in memory and reset on session start/reload/replacement or tree navigation. Print/JSON mode produces no status updates or timers.

## License

MIT

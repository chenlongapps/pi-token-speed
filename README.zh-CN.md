# @chenlongapps/pi-token-speed

[English](README.md) · [npm](https://www.npmjs.com/package/@chenlongapps/pi-token-speed) · [GitHub](https://github.com/chenlongapps/pi-token-speed)

一个轻量级的 [Pi Coding Agent](https://pi.dev/) 扩展，在 Pi 的终端状态栏显示实时 LLM token 生成指标。

```text
TPS: ~42.0 · AVG: 38.5 · TTFT: 1.2
```

参考 [OpenCode Token Usage](https://github.com/chenlongapps/opencode-token-usage) 的吞吐量计算方式，使用 Pi 官方扩展 API 实现。单个 TypeScript 文件，无额外运行时依赖，无需构建。

## 安装

```bash
pi install npm:@chenlongapps/pi-token-speed@latest
```

## 指标

- **TPS（流式）**：取最近 **2 秒**的文本、thinking 和工具参数 delta，按 **UTF-8 字节数 ÷ 4** 估算 token，再除以窗口内首末样本的时间差，单位为 token/秒。至少需要两个不同时间戳的样本，没有时长下限。使用指数加权移动平均（EWMA，**α = 0.35**）平滑，并以 `~` 标记估算值。
- **TPS（完成后）**：该响应的 `usage.output` ÷ 请求全程耗时，从 `before_provider_request` 计时至 `message_end`。自定义 provider 未触发请求钩子时，回退到 `turn_start`。所有 provider 使用同一口径。
- **AVG**：成功响应的输出 token 总数 ÷ 请求耗时总和，按时长加权。包含首个输出前的等待，不包含请求之间的工具执行和用户等待。
- **TTFT**：这些成功响应从请求开始到首个可观测输出（文本、思考或工具调用）的平均延迟，单位为秒。

100ms 刷新定时器只在收到新 delta 时重新计算实时 TPS。停顿期间保留最后有效读数，每次请求重置窗口和 EWMA。工具名称及块结束时补全的缺失内容参与 TTFT 判定和字节兜底，并保持去重，但不作为新的流式 delta 样本。

最终 `usage.output` 缺失、无效或为零时，使用 `ceil(累计 UTF-8 字节数 / 4)` 兜底，仅对整个响应取整一次。该响应的 TPS 保留 `~`；AVG 中只要包含字节估算响应，也会一直保留 `~`，直到会话统计重置。Pi 的 `usage.output` 已包含 reasoning token，不会再累加 `usage.reasoning`，也不会计入输入或缓存 token。

实时 TPS 估算可观测输出的速度；完成后的 TPS 衡量客户端测得的请求全程吞吐量，包含网络等待和隐藏推理阶段，不代表服务端纯生成速度。不推测隐藏 token，也不使用模型专属倍率。例如，请求耗时 12 秒、首个输出出现在第 10 秒、`usage.output` 为 1200，作为会话中的唯一样本时，最终显示 `TPS: 100 · AVG: 100 · TTFT: 10.0`。

只有带可观测输出、请求耗时为正，且以 `stop`、`length` 或 `toolUse` 完成的响应计入 AVG 和 TTFT。错误、取消、延期和空输出不计入。统计仅保存在内存中，会话开始、重载、替换或树导航时重置。Print/JSON 模式不输出状态，也不创建定时器。

## 许可证

MIT

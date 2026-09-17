import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "token-speed";
const WINDOW_MS = 5_000;
const STALE_MS = 1_500;
const REFRESH_MS = 100;
const MIN_GENERATION_MS = 250;
const BYTES_PER_TOKEN = 5;
const encoder = new TextEncoder();

type Sample = { at: number; tokens: number };
type ResponseTiming = {
  requestAt: number;
  firstTokenAt?: number;
  bytes: number;
  samples: Sample[];
  // Final block events can contain output that was never emitted as a delta.
  blockBytes: Map<number, number>;
};

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function formatRate(value: number | undefined): string {
  if (value === undefined || !positive(value)) return "-";
  return value >= 100 ? String(Math.round(value)) : value.toFixed(value >= 10 ? 1 : 2);
}

/** A single in-memory tracker per loaded extension/session; no model calls or runtime dependencies. */
export default function tokenSpeed(pi: ExtensionAPI): void {
  let current: ResponseTiming | undefined;
  let lastTps: number | undefined;
  let totalTokens = 0;
  let totalGenerationMs = 0;
  let totalTtftMs = 0;
  let completedResponses = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastStatus: string | undefined;

  const stopTimer = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const clearStatus = (ctx: ExtensionContext) => {
    if (ctx.hasUI && lastStatus !== undefined) ctx.ui.setStatus(STATUS_KEY, undefined);
    lastStatus = undefined;
  };

  const render = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (lastTps === undefined) {
      clearStatus(ctx);
      return;
    }
    const average = totalGenerationMs > 0 ? (totalTokens * 1_000) / totalGenerationMs : undefined;
    const ttft = completedResponses > 0 ? (totalTtftMs / completedResponses / 1_000).toFixed(1) : "-";
    const status = ctx.ui.theme.fg(
      "dim",
      `TPS: ${formatRate(lastTps)} · AVG: ${formatRate(average)} · TTFT: ${ttft}`,
    );
    // Pi handles footer layout and terminal resizing; the status uses the theme's dim color.
    if (status !== lastStatus) {
      ctx.ui.setStatus(STATUS_KEY, status);
      lastStatus = status;
    }
  };

  const updateLive = (now: number) => {
    if (!current) return;
    const samples = current.samples;
    while (samples.length > 0 && now - samples[0]!.at > WINDOW_MS) samples.shift();
    const first = samples[0];
    const last = samples[samples.length - 1];
    // Preserve the last useful reading during pauses, tool execution and idle time.
    if (!first || !last || now - last.at > STALE_MS) return;
    const tokens = samples.reduce((sum, sample) => sum + sample.tokens, 0);
    const rate = (tokens * 1_000) / Math.max(now - first.at, 1_000);
    if (positive(rate)) lastTps = rate;
  };

  const record = (bytes: number, index: number, ctx: ExtensionContext) => {
    if (!current || bytes <= 0) return;
    const now = performance.now();
    current.firstTokenAt ??= now;
    current.bytes += bytes;
    current.blockBytes.set(index, (current.blockBytes.get(index) ?? 0) + bytes);
    // Do not round each delta: splitting the same text into smaller chunks must
    // not inflate the token estimate. Only the final fallback total is rounded.
    const tokens = bytes / BYTES_PER_TOKEN;
    const previous = current.samples[current.samples.length - 1];
    if (previous && now - previous.at < REFRESH_MS) previous.tokens += tokens;
    else current.samples.push({ at: now, tokens });
    if (timer === undefined) {
      updateLive(now);
      render(ctx);
      timer = setInterval(() => {
        updateLive(performance.now());
        render(ctx);
      }, REFRESH_MS);
      timer.unref();
    }
  };

  const reset = (_event: unknown, ctx: ExtensionContext) => {
    stopTimer();
    current = undefined;
    lastTps = undefined;
    totalTokens = 0;
    totalGenerationMs = 0;
    totalTtftMs = 0;
    completedResponses = 0;
    clearStatus(ctx);
  };

  pi.on("session_start", reset);
  pi.on("session_tree", reset);

  pi.on("turn_start", (_event, ctx) => {
    stopTimer();
    current = ctx.hasUI
      ? { requestAt: performance.now(), bytes: 0, samples: [], blockBytes: new Map() }
      : undefined;
  });

  pi.on("before_provider_request", () => {
    // This hook runs closer to the actual request than turn_start. Ignore
    // background requests (e.g. compaction) with no active assistant turn.
    if (current && current.firstTokenAt === undefined) current.requestAt = performance.now();
  });

  pi.on("message_update", (event, ctx) => {
    if (!current || event.message.role !== "assistant") return;
    const update = event.assistantMessageEvent;
    switch (update.type) {
      case "text_delta":
      case "thinking_delta":
      case "toolcall_delta":
        record(encoder.encode(update.delta).byteLength, update.contentIndex, ctx);
        break;
      case "toolcall_start": {
        const block = event.message.content[update.contentIndex];
        if (block?.type !== "toolCall") break;
        const initialArgs = Object.keys(block.arguments).length > 0 ? JSON.stringify(block.arguments) : "";
        record(encoder.encode(block.name + initialArgs).byteLength, update.contentIndex, ctx);
        break;
      }
      case "text_end":
      case "thinking_end":
      case "toolcall_end": {
        const text = update.type === "toolcall_end"
          ? update.toolCall.name + JSON.stringify(update.toolCall.arguments)
          : update.content;
        const missingBytes = encoder.encode(text).byteLength - (current.blockBytes.get(update.contentIndex) ?? 0);
        record(missingBytes, update.contentIndex, ctx);
        break;
      }
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant" || !current) return;
    const timing = current;
    const message = event.message;
    stopTimer();
    current = undefined;
    // Incomplete/error responses do not contribute to either session average.
    const completed = message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse";
    if (completed && timing.firstTokenAt !== undefined) {
      // Pi's output already includes reasoning tokens; never add them again.
      const tokens = positive(message.usage.output) ? message.usage.output : Math.ceil(timing.bytes / BYTES_PER_TOKEN);
      const generationMs = Math.max(performance.now() - timing.firstTokenAt, MIN_GENERATION_MS);
      if (positive(tokens)) {
        lastTps = (tokens * 1_000) / generationMs;
        totalTokens += tokens;
        totalGenerationMs += generationMs;
        totalTtftMs += Math.max(timing.firstTokenAt - timing.requestAt, 0);
        completedResponses++;
      }
    }
    render(ctx);
  });

  const endTurn = (_event: unknown, ctx: ExtensionContext) => {
    stopTimer();
    current = undefined;
    render(ctx);
  };
  pi.on("turn_end", endTurn);
  pi.on("agent_end", endTurn);

  pi.on("session_shutdown", (_event, ctx) => {
    stopTimer();
    current = undefined;
    clearStatus(ctx);
  });
}

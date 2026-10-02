import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "token-speed";
const WINDOW_MS = 2_000;
const REFRESH_MS = 100;
const EWMA_ALPHA = 0.35;
const BYTES_PER_TOKEN = 4;
const encoder = new TextEncoder();

type Sample = { at: number; tokens: number };
type ResponseTiming = {
  requestAt: number;
  firstTokenAt?: number;
  bytes: number;
  samples: Sample[];
  hasNewSamples: boolean;
  smoothedTps?: number;
  // Final block events can contain output that was never emitted as a delta.
  blockBytes: Map<number, number>;
};

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function formatRate(value: number | undefined, estimated = false): string {
  if (value === undefined || !positive(value)) return "-";
  const rate = value >= 100 ? String(Math.round(value)) : value.toFixed(value >= 10 ? 1 : 2);
  return estimated ? `~${rate}` : rate;
}

/** A single in-memory tracker per loaded extension/session; no model calls or runtime dependencies. */
export default function tokenSpeed(pi: ExtensionAPI): void {
  let current: ResponseTiming | undefined;
  let lastTps: number | undefined;
  let lastTpsEstimated = false;
  let totalTokens = 0;
  let totalRequestMs = 0;
  let averageEstimated = false;
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
    const average = totalRequestMs > 0 ? (totalTokens * 1_000) / totalRequestMs : undefined;
    const ttft = completedResponses > 0 ? (totalTtftMs / completedResponses / 1_000).toFixed(1) : "-";
    const status = ctx.ui.theme.fg(
      "dim",
      `TPS: ${formatRate(lastTps, lastTpsEstimated)} · AVG: ${formatRate(average, averageEstimated)} · TTFT: ${ttft}`,
    );
    // Pi handles footer layout and terminal resizing; the status uses the theme's dim color.
    if (status !== lastStatus) {
      ctx.ui.setStatus(STATUS_KEY, status);
      lastStatus = status;
    }
  };

  const updateLive = (now: number) => {
    // Timer ticks without new deltas must not decay the rate or reapply EWMA.
    if (!current?.hasNewSamples) return false;
    current.hasNewSamples = false;
    const samples = current.samples;
    while (samples.length > 0 && now - samples[0]!.at > WINDOW_MS) samples.shift();
    const first = samples[0];
    const last = samples[samples.length - 1];
    // A single timestamp cannot measure throughput. Keep the last useful reading.
    if (!first || !last || last.at <= first.at) return false;
    const tokens = samples.reduce((sum, sample) => sum + sample.tokens, 0);
    const rate = (tokens * 1_000) / (last.at - first.at);
    if (!positive(rate)) return false;
    current.smoothedTps = current.smoothedTps === undefined
      ? rate
      : EWMA_ALPHA * rate + (1 - EWMA_ALPHA) * current.smoothedTps;
    lastTps = current.smoothedTps;
    lastTpsEstimated = true;
    return true;
  };

  const record = (bytes: number, index: number, ctx: ExtensionContext, isDelta = false) => {
    if (!ctx.hasUI || !current || bytes <= 0) return;
    const now = performance.now();
    current.firstTokenAt ??= now;
    current.bytes += bytes;
    current.blockBytes.set(index, (current.blockBytes.get(index) ?? 0) + bytes);
    // Tool metadata and block completions count toward TTFT and the fallback
    // total, but have no delta timing from which to estimate live throughput.
    if (!isDelta) return;
    // Do not round each delta: splitting the same text into smaller chunks must
    // not inflate the token estimate. Only the final fallback total is rounded.
    const tokens = bytes / BYTES_PER_TOKEN;
    const previous = current.samples[current.samples.length - 1];
    if (previous && now === previous.at) previous.tokens += tokens;
    else current.samples.push({ at: now, tokens });
    current.hasNewSamples = true;
    if (timer === undefined) {
      timer = setInterval(() => {
        if (updateLive(performance.now())) render(ctx);
      }, REFRESH_MS);
      timer.unref();
    }
  };

  const reset = (_event: unknown, ctx: ExtensionContext) => {
    stopTimer();
    current = undefined;
    lastTps = undefined;
    lastTpsEstimated = false;
    totalTokens = 0;
    totalRequestMs = 0;
    averageEstimated = false;
    totalTtftMs = 0;
    completedResponses = 0;
    clearStatus(ctx);
  };

  pi.on("session_start", reset);
  pi.on("session_tree", reset);

  const startRequest = (ctx: ExtensionContext) => {
    stopTimer();
    current = ctx.hasUI
      ? { requestAt: performance.now(), bytes: 0, samples: [], hasNewSamples: false, blockBytes: new Map() }
      : undefined;
  };

  pi.on("turn_start", (_event, ctx) => startRequest(ctx));

  pi.on("before_provider_request", (_event, ctx) => {
    // This hook runs closer to the actual request than turn_start. Ignore
    // background requests (e.g. compaction) with no active assistant turn.
    // Each attempt also gets a fresh delta window, byte total and EWMA state.
    if (current) startRequest(ctx);
  });

  pi.on("message_update", (event, ctx) => {
    if (!current || event.message.role !== "assistant") return;
    const update = event.assistantMessageEvent;
    switch (update.type) {
      case "text_delta":
      case "thinking_delta":
      case "toolcall_delta":
        record(encoder.encode(update.delta).byteLength, update.contentIndex, ctx, true);
        break;
      case "toolcall_start": {
        const block = event.message.content[update.contentIndex];
        if (block?.type !== "toolCall") break;
        const initialArgs = Object.keys(block.arguments).length > 0 ? JSON.stringify(block.arguments) : "";
        const missingBytes = encoder.encode(block.name + initialArgs).byteLength
          - (current.blockBytes.get(update.contentIndex) ?? 0);
        record(missingBytes, update.contentIndex, ctx);
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
      const output = message.usage?.output;
      const estimated = !positive(output);
      const tokens = estimated ? Math.ceil(timing.bytes / BYTES_PER_TOKEN) : output;
      // Include the wait for the first output and any hidden reasoning phase.
      const requestMs = performance.now() - timing.requestAt;
      if (positive(tokens) && positive(requestMs)) {
        lastTps = (tokens * 1_000) / requestMs;
        lastTpsEstimated = estimated;
        totalTokens += tokens;
        totalRequestMs += requestMs;
        averageEstimated ||= estimated;
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

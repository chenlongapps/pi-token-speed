import assert from "node:assert/strict";
import { test } from "node:test";
import tokenSpeed from "../index.ts";

function harness(t, hasUI = true) {
  let now = 0;
  const handlers = new Map();
  const timers = new Map();
  const statuses = [];
  const ctx = {
    hasUI,
    ui: {
      theme: {
        fg(color, text) {
          assert.equal(color, "dim");
          return text;
        },
      },
      setStatus(key, text) {
        assert.equal(key, "token-speed");
        statuses.push(text);
      },
    },
  };
  t.mock.method(performance, "now", () => now);
  t.mock.method(globalThis, "setInterval", (callback, delay) => {
    assert.equal(delay, 100);
    const handle = { unref() {} };
    timers.set(handle, callback);
    return handle;
  });
  t.mock.method(globalThis, "clearInterval", (handle) => timers.delete(handle));
  tokenSpeed({ on: (name, handler) => handlers.set(name, handler) });
  const emit = (name, data = {}) => {
    const result = handlers.get(name)?.({ type: name, ...data }, ctx);
    assert.equal(result, undefined, "metrics must not replace messages or provider payloads");
  };
  const message = (output = 0, stopReason = "stop", content = []) => ({
    role: "assistant",
    content,
    stopReason,
    usage: { output, reasoning: output / 2, input: 100_000, cacheRead: 50_000, totalTokens: 150_000 + output },
  });
  const update = (type, fields = {}, content = []) => emit("message_update", {
    message: message(0, "pending", content),
    assistantMessageEvent: { type, contentIndex: 0, ...fields },
  });
  const delta = (text, type = "text_delta", contentIndex = 0) => update(type, { delta: text, contentIndex });
  return {
    timers, statuses, emit, update, delta, message,
    status: () => statuses.at(-1),
    advance(ms, tick = true) {
      now += ms;
      if (tick) for (const callback of timers.values()) callback();
    },
    begin() {
      emit("turn_start");
      emit("before_provider_request", { payload: {} });
    },
    end(output, reason = "stop") {
      emit("message_end", { message: message(output, reason) });
    },
  };
}

test("waits for two sample timestamps, then reconciles with official output without double-counting reasoning", (t) => {
  const h = harness(t);
  h.emit("session_start");
  assert.equal(h.status(), undefined);
  h.begin();
  h.advance(1_200);
  h.delta("x".repeat(40));
  assert.equal(h.status(), undefined);
  h.advance(1_000);
  assert.equal(h.status(), undefined);
  h.delta("x".repeat(40));
  h.advance(0);
  assert.equal(h.status(), "TPS: ~20.0 · AVG: - · TTFT: -");
  h.advance(1_000);
  h.end(100);
  assert.equal(h.status(), "TPS: 31.3 · AVG: 31.3 · TTFT: 1.2");
  assert.equal(h.timers.size, 0);
  h.advance(60_000);
  assert.equal(h.status(), "TPS: 31.3 · AVG: 31.3 · TTFT: 1.2");
});

test("hidden reasoning is included in the full request duration for final TPS and AVG", (t) => {
  const h = harness(t);
  h.begin();
  h.advance(10_000);
  h.delta("visible text");
  h.advance(2_000);
  h.end(1_200);
  assert.equal(h.status(), "TPS: 100 · AVG: 100 · TTFT: 10.0");
});

test("long TTFT does not dilute live throughput and sub-second samples have no duration floor", (t) => {
  const h = harness(t);
  h.begin();
  h.advance(10_000);
  h.delta("x".repeat(40));
  h.advance(50, false);
  h.delta("x".repeat(40), "thinking_delta", 1);
  h.advance(50);
  // 20 estimated tokens over the samples' 50 ms span, independent of timer time.
  assert.equal(h.status(), "TPS: ~400 · AVG: - · TTFT: -");
});

test("a single sample or several deltas at one timestamp cannot produce a live rate", (t) => {
  const h = harness(t);
  h.begin();
  h.delta("x");
  h.delta("x");
  h.advance(100);
  assert.equal(h.status(), undefined);
  h.delta("xx");
  h.advance(0);
  assert.equal(h.status(), "TPS: ~10.0 · AVG: - · TTFT: -");
  // New bytes at the same latest timestamp still update a measurable window.
  h.delta("xxxx");
  h.advance(0);
  assert.equal(h.status(), "TPS: ~13.5 · AVG: - · TTFT: -");
});

test("averages are weighted by full request duration and exclude tool and user wait time", (t) => {
  const h = harness(t);
  h.begin();
  h.advance(1_000);
  h.delta("first");
  h.advance(1_000);
  h.end(100, "toolUse");
  h.emit("turn_end");
  h.advance(120_000);
  h.emit("message_end", { message: { role: "toolResult", content: [] } });
  h.begin();
  h.advance(3_000);
  h.delta("second");
  h.advance(3_000);
  h.end(30);
  assert.equal(h.status(), "TPS: 5.00 · AVG: 16.3 · TTFT: 2.0");
});

test("TTFT starts at the provider hook, not stream start or empty block metadata", (t) => {
  const h = harness(t);
  h.emit("turn_start");
  h.advance(5_000);
  h.emit("before_provider_request");
  h.advance(1_000);
  h.emit("message_start", { message: h.message() });
  h.update("text_start");
  h.update("thinking_start");
  h.delta("");
  assert.equal(h.timers.size, 0);
  h.advance(1_000);
  h.delta("reasoning", "thinking_delta");
  h.advance(1_000);
  h.end(50);
  assert.equal(h.status(), "TPS: 16.7 · AVG: 16.7 · TTFT: 2.0");
});

test("falls back to turn timing when a custom provider omits the request hook", (t) => {
  const h = harness(t);
  h.emit("turn_start");
  h.advance(500);
  h.delta("hello");
  h.advance(1_000);
  h.end(20);
  assert.equal(h.status(), "TPS: 13.3 · AVG: 13.3 · TTFT: 0.5");
});

test("tool-only responses start TTFT at the tool name and count arguments once", (t) => {
  const h = harness(t);
  const toolCall = { type: "toolCall", id: "call-1", name: "bash", arguments: {} };
  h.begin();
  h.advance(500);
  h.update("toolcall_start", {}, [toolCall]);
  assert.equal(h.timers.size, 0);
  h.advance(500);
  h.delta('{"command":"pwd"}', "toolcall_delta");
  h.update("toolcall_end", { toolCall: { ...toolCall, arguments: { command: "pwd" } } });
  h.advance(500);
  assert.equal(h.status(), undefined, "tool metadata must not act as a second delta");
  h.end(0, "toolUse");
  assert.equal(h.status(), "TPS: ~4.00 · AVG: ~4.00 · TTFT: 0.5");
});

test("complete tool arguments and repeated start/end events are counted only once", (t) => {
  const h = harness(t);
  const toolCall = { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } };
  h.begin();
  h.update("toolcall_start", {}, [toolCall]);
  h.update("toolcall_start", {}, [toolCall]);
  h.advance(1_000);
  h.update("toolcall_end", { toolCall });
  h.update("toolcall_end", { toolCall });
  assert.equal(h.timers.size, 0);
  h.end(0, "toolUse");
  assert.equal(h.status(), "TPS: ~6.00 · AVG: ~6.00 · TTFT: 0.0");
});

test("tool argument deltas contribute to live TPS, while tool names and completions do not", (t) => {
  const h = harness(t);
  const toolCall = { type: "toolCall", id: "call-1", name: "x".repeat(400), arguments: {} };
  h.begin();
  h.update("toolcall_start", {}, [toolCall]);
  h.delta(" ".repeat(40), "toolcall_delta");
  h.advance(1_000, false);
  h.delta("{}" + " ".repeat(38), "toolcall_delta");
  h.advance(0);
  assert.equal(h.status(), "TPS: ~20.0 · AVG: - · TTFT: -");
  h.update("toolcall_end", { toolCall });
  h.advance(100);
  assert.equal(h.status(), "TPS: ~20.0 · AVG: - · TTFT: -");
});

test("UTF-8 fallback includes Chinese, emoji and thinking without rounding individual chunks", (t) => {
  const h = harness(t);
  const text = "你好，世界！hello🙂🚀";
  for (const chunks of [[text], [...text]]) {
    h.emit("session_start");
    h.begin();
    for (const chunk of chunks) h.delta(chunk, "thinking_delta");
    h.update("thinking_end", { content: text });
    h.advance(1_000);
    h.end(0);
    // 31 UTF-8 bytes become 8 tokens only after rounding the response total.
    assert.equal(h.status(), "TPS: ~8.00 · AVG: ~8.00 · TTFT: 0.0");
  }
});

test("live estimates measure UTF-8 bytes rather than JavaScript string length", (t) => {
  const h = harness(t);
  h.begin();
  h.delta("你🙂");
  h.advance(100, false);
  h.delta("你🙂", "thinking_delta", 1);
  h.advance(0);
  assert.equal(h.status(), "TPS: ~35.0 · AVG: - · TTFT: -");
});

test("block completions fill missing bytes once per block without generating live samples", (t) => {
  const h = harness(t);
  h.begin();
  h.delta("ab");
  h.advance(1_000, false);
  h.delta("cd");
  h.advance(0);
  assert.equal(h.status(), "TPS: ~1.00 · AVG: - · TTFT: -");
  for (let i = 0; i < 2; i++) {
    h.update("text_end", { content: "abcdefgh" });
    h.update("thinking_end", { content: "🙂", contentIndex: 1 });
    h.update("toolcall_end", {
      contentIndex: 2,
      toolCall: { type: "toolCall", id: "call-1", name: "a", arguments: {} },
    });
  }
  h.advance(1_000);
  assert.equal(h.status(), "TPS: ~1.00 · AVG: - · TTFT: -");
  h.end(0);
  // 8 text + 4 thinking + 3 tool bytes => 4 tokens over the full 2 seconds.
  assert.equal(h.status(), "TPS: ~2.00 · AVG: ~2.00 · TTFT: 0.0");
});

test("block-only output establishes TTFT and a final fallback without starting a timer", (t) => {
  const h = harness(t);
  h.begin();
  h.advance(500);
  h.update("text_end", { content: "你好" });
  h.advance(500);
  h.update("text_end", { content: "你好" });
  h.update("thinking_end", { content: "🙂", contentIndex: 1 });
  assert.equal(h.status(), undefined);
  assert.equal(h.timers.size, 0);
  h.advance(1_000);
  h.end(0);
  assert.equal(h.status(), "TPS: ~1.50 · AVG: ~1.50 · TTFT: 0.5");
});

test("the two-second window evicts old samples and applies EWMA only on new deltas", (t) => {
  const h = harness(t);
  h.begin();
  h.delta("x".repeat(400));
  h.advance(1_000, false);
  h.delta("x".repeat(40));
  h.advance(0);
  assert.equal(h.status(), "TPS: ~110 · AVG: - · TTFT: -");
  h.advance(1_000, false);
  h.delta("x".repeat(40));
  h.advance(0);
  // The first sample is still on the 2 s boundary: 0.35 * 60 + 0.65 * 110.
  assert.equal(h.status(), "TPS: ~92.5 · AVG: - · TTFT: -");
  h.advance(1_000, false);
  h.delta("x".repeat(40));
  h.advance(0);
  // The large first sample has expired: 0.35 * 15 + 0.65 * 92.5.
  assert.equal(h.status(), "TPS: ~65.4 · AVG: - · TTFT: -");
  const frozen = h.status();
  const count = h.statuses.length;
  for (let i = 0; i < 10; i++) h.advance(100);
  h.advance(10_000);
  assert.equal(h.status(), frozen);
  assert.equal(h.statuses.length, count);
  h.delta("x".repeat(40));
  h.advance(0);
  assert.equal(h.status(), frozen, "one fresh sample after a pause cannot replace the rate");
  h.advance(1_000, false);
  h.delta("x".repeat(40));
  h.advance(0);
  assert.equal(h.status(), "TPS: ~49.5 · AVG: - · TTFT: -");
  h.emit("agent_end");
  assert.equal(h.timers.size, 0);
});

test("empty, failed, aborted and deferred responses do not pollute session averages", (t) => {
  const h = harness(t);
  h.begin();
  h.advance(1_000);
  h.delta("baseline");
  h.advance(1_000);
  h.end(50);
  for (const reason of ["error", "aborted", "deferred", "pending"]) {
    h.begin();
    h.advance(5_000);
    h.delta("partial output");
    h.advance(1_000);
    h.end(0, reason);
    assert.match(h.status(), /AVG: 25\.0 · TTFT: 1\.0$/);
    assert.equal(h.timers.size, 0);
  }
  h.begin();
  h.advance(2_000);
  h.end(100);
  assert.match(h.status(), /AVG: 25\.0 · TTFT: 1\.0$/);
});

test("retries reset request timing and token samples", (t) => {
  const h = harness(t);
  h.begin();
  h.advance(1_000);
  h.delta("bad".repeat(100));
  h.end(500, "error");
  h.advance(20_000);
  h.begin();
  h.advance(500);
  h.emit("before_provider_request");
  h.advance(1_000);
  h.delta("hello");
  h.advance(1_000);
  h.end(20);
  assert.equal(h.status(), "TPS: 10.0 · AVG: 10.0 · TTFT: 1.0");
});

test("a new provider attempt resets bytes, TTFT, the live window and smoothing within a turn", (t) => {
  const h = harness(t);
  h.begin();
  h.delta("x".repeat(400));
  h.advance(100, false);
  h.delta("x".repeat(400));
  h.advance(0);
  assert.equal(h.status(), "TPS: ~2000 · AVG: - · TTFT: -");
  h.advance(500);
  h.emit("before_provider_request");
  assert.equal(h.timers.size, 0);
  h.advance(500);
  h.delta("x".repeat(4));
  h.advance(100, false);
  h.delta("x".repeat(4));
  h.advance(0);
  assert.equal(h.status(), "TPS: ~20.0 · AVG: - · TTFT: -");
  h.advance(400);
  h.end(0);
  assert.equal(h.status(), "TPS: ~2.00 · AVG: ~2.00 · TTFT: 0.5");
});

test("each new turn starts a fresh live window and EWMA", (t) => {
  const h = harness(t);
  for (const [bytes, expected] of [[400, "2000"], [4, "20.0"]]) {
    h.begin();
    h.delta("x".repeat(bytes));
    h.advance(100, false);
    h.delta("x".repeat(bytes));
    h.advance(0);
    assert.equal(h.status(), `TPS: ~${expected} · AVG: - · TTFT: -`);
    h.emit("turn_end");
  }
});

test("session replacement, reload and tree navigation reset statistics and stop timers", (t) => {
  const h = harness(t);
  for (const event of ["session_start", "session_tree"]) {
    h.begin();
    h.delta("hello");
    h.advance(1_000);
    h.end(0);
    assert.equal(h.status(), "TPS: ~2.00 · AVG: ~2.00 · TTFT: 0.0");
    h.begin();
    h.delta("still streaming");
    h.emit(event);
    assert.equal(h.status(), undefined);
    assert.equal(h.timers.size, 0);
    h.end(100);
    assert.equal(h.status(), undefined);
    h.begin();
    h.delta("official");
    h.advance(1_000);
    h.end(10);
    assert.equal(h.status(), "TPS: 10.0 · AVG: 10.0 · TTFT: 0.0");
    h.emit(event);
  }
  h.begin();
  h.delta("exit");
  h.emit("session_shutdown");
  assert.equal(h.status(), undefined);
  assert.equal(h.timers.size, 0);
});

test("responses without observable output do not invent a TTFT", (t) => {
  const h = harness(t);
  h.emit("session_start");
  h.begin();
  h.update("text_start");
  h.update("thinking_start");
  h.delta("");
  h.update("text_end", { content: "" });
  h.update("thinking_end", { content: "", contentIndex: 1 });
  h.advance(5_000);
  h.end(100);
  assert.equal(h.status(), undefined);
});

test("non-positive durations do not invent a TPS or enter AVG and TTFT", (t) => {
  const h = harness(t);
  for (const elapsed of [0, -100]) {
    h.emit("session_start");
    h.begin();
    h.delta("hello");
    h.advance(elapsed);
    h.end(0, "length");
    assert.equal(h.status(), undefined);
    assert.equal(h.timers.size, 0);
    h.begin();
    h.advance(500);
    h.delta("valid");
    h.advance(500);
    h.end(10);
    assert.equal(h.status(), "TPS: 10.0 · AVG: 10.0 · TTFT: 0.5");
  }
});

test("short positive durations have no floor and length-limited responses count", (t) => {
  const h = harness(t);
  h.begin();
  h.advance(10);
  h.delta("hello");
  h.advance(40);
  h.end(20, "length");
  assert.equal(h.status(), "TPS: 400 · AVG: 400 · TTFT: 0.0");
});

test("missing, zero and invalid usage use a marked byte fallback", (t) => {
  const h = harness(t);
  const usages = [undefined, null, {}, ...[0, NaN, Infinity, -Infinity, -10, null, "20"].map((output) => ({ output }))];
  for (const usage of usages) {
    h.emit("session_start");
    h.begin();
    h.delta("hello");
    h.advance(1_000);
    h.emit("message_end", { message: { ...h.message(), usage } });
    assert.equal(h.status(), "TPS: ~2.00 · AVG: ~2.00 · TTFT: 0.0");
  }
});

test("AVG remains marked after any estimated response even when later TPS uses official usage", (t) => {
  const h = harness(t);
  for (const [output, expected] of [
    [100, "TPS: 100 · AVG: 100 · TTFT: 0.0"],
    [0, "TPS: ~2.00 · AVG: ~51.0 · TTFT: 0.0"],
    [100, "TPS: 100 · AVG: ~67.3 · TTFT: 0.0"],
  ]) {
    h.begin();
    h.delta("hello");
    h.advance(1_000);
    h.end(output);
    assert.equal(h.status(), expected);
  }
});

test("does not track user messages or background provider calls outside a turn", (t) => {
  const h = harness(t);
  h.emit("session_start");
  h.emit("before_provider_request");
  h.delta("background response");
  h.end(100);
  assert.equal(h.status(), undefined);
  assert.equal(h.timers.size, 0);
  h.begin();
  h.emit("message_update", { message: { role: "user" } });
  h.emit("message_end", { message: { role: "user" } });
  h.advance(500);
  h.delta("assistant");
  h.advance(1_000);
  h.end(10);
  assert.equal(h.status(), "TPS: 6.67 · AVG: 6.67 · TTFT: 0.5");
});

test("print/JSON mode creates no timers or UI calls", (t) => {
  const h = harness(t, false);
  h.emit("session_start");
  h.begin();
  h.delta("hello");
  h.update("thinking_end", { content: "thinking", contentIndex: 1 });
  h.update("toolcall_start", {}, [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }]);
  h.advance(1_000);
  h.end(100);
  h.emit("agent_end");
  h.emit("turn_end");
  h.emit("session_tree");
  h.emit("session_shutdown");
  assert.equal(h.statuses.length, 0);
  assert.equal(h.timers.size, 0);
});

test("turn and agent end clear active tracking and timers so late output is ignored", (t) => {
  const h = harness(t);
  for (const event of ["turn_end", "agent_end"]) {
    h.emit("session_start");
    h.begin();
    h.delta("hello");
    h.emit(event);
    assert.equal(h.timers.size, 0);
    h.advance(1_000);
    h.delta("late output");
    h.end(100);
    assert.equal(h.timers.size, 0);
    assert.equal(h.status(), undefined);
  }
});

test("refreshes are throttled and duplicate completion is ignored", (t) => {
  const h = harness(t);
  h.begin();
  h.delta("hello");
  const count = h.statuses.length;
  for (let i = 0; i < 100; i++) {
    h.advance(1, false);
    h.delta("world");
  }
  assert.equal(h.statuses.length, count);
  assert.equal(h.timers.size, 1);
  h.advance(0);
  assert.equal(h.statuses.length, count + 1);
  h.advance(900);
  h.end(100);
  const final = h.status();
  h.end(900);
  assert.equal(h.status(), final);
  assert.equal(h.timers.size, 0);
});

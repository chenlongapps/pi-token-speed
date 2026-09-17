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
  t.mock.method(globalThis, "setInterval", (callback) => {
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

test("waits for output, then reconciles with official output without double-counting reasoning", (t) => {
  const h = harness(t);
  h.emit("session_start");
  assert.equal(h.status(), undefined);
  h.begin();
  h.advance(1_200);
  h.delta("x".repeat(50));
  assert.equal(h.status(), "TPS: 10.0 · AVG: - · TTFT: -");
  h.advance(1_000);
  h.delta("x".repeat(50));
  h.advance(1_000);
  h.end(100);
  assert.equal(h.status(), "TPS: 50.0 · AVG: 50.0 · TTFT: 1.2");
  assert.equal(h.timers.size, 0);
  h.advance(60_000);
  assert.equal(h.status(), "TPS: 50.0 · AVG: 50.0 · TTFT: 1.2");
});

test("averages are weighted by generation duration and exclude tool and user wait time", (t) => {
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
  assert.equal(h.status(), "TPS: 10.0 · AVG: 32.5 · TTFT: 2.0");
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
  assert.equal(h.status(), "TPS: 50.0 · AVG: 50.0 · TTFT: 2.0");
});

test("falls back to turn timing when a custom provider omits the request hook", (t) => {
  const h = harness(t);
  h.emit("turn_start");
  h.advance(500);
  h.delta("hello");
  h.advance(1_000);
  h.end(20);
  assert.equal(h.status(), "TPS: 20.0 · AVG: 20.0 · TTFT: 0.5");
});

test("tool-only responses start TTFT at the tool name and count arguments once", (t) => {
  const h = harness(t);
  const toolCall = { type: "toolCall", id: "call-1", name: "bash", arguments: {} };
  h.begin();
  h.advance(500);
  h.update("toolcall_start", {}, [toolCall]);
  h.advance(500);
  h.delta('{"command":"pwd"}', "toolcall_delta");
  h.update("toolcall_end", { toolCall: { ...toolCall, arguments: { command: "pwd" } } });
  h.advance(500);
  h.end(0, "toolUse");
  assert.equal(h.status(), "TPS: 5.00 · AVG: 5.00 · TTFT: 0.5");
});

test("complete tool arguments present at start do not get counted again at end", (t) => {
  const h = harness(t);
  const toolCall = { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } };
  h.begin();
  h.update("toolcall_start", {}, [toolCall]);
  h.advance(1_000);
  h.update("toolcall_end", { toolCall });
  h.end(0, "toolUse");
  assert.equal(h.status(), "TPS: 5.00 · AVG: 5.00 · TTFT: 0.0");
});

test("UTF-8 estimates include thinking and are independent of chunk splitting", (t) => {
  const h = harness(t);
  const text = "你好，世界！hello";
  const expectedTokens = Math.ceil(new TextEncoder().encode(text).length / 5);
  for (const chunks of [[text], [...text]]) {
    h.emit("session_start");
    h.begin();
    for (const chunk of chunks) h.delta(chunk, "thinking_delta");
    h.update("thinking_end", { content: text });
    h.advance(1_000);
    h.end(0);
    assert.equal(h.status(), `TPS: ${expectedTokens.toFixed(2)} · AVG: ${expectedTokens.toFixed(2)} · TTFT: 0.0`);
  }
});

test("rolling TPS drops old samples and freezes when streaming stalls", (t) => {
  const h = harness(t);
  h.begin();
  h.delta("x".repeat(500));
  for (let i = 0; i < 6; i++) {
    h.advance(1_000, false);
    h.delta("x".repeat(50));
  }
  h.advance(0);
  assert.equal(h.status(), "TPS: 12.0 · AVG: - · TTFT: -");
  h.advance(1_000);
  const frozen = h.status();
  h.advance(10_000);
  assert.equal(h.status(), frozen);
  h.delta("x".repeat(100));
  h.advance(0);
  assert.equal(h.status(), "TPS: 20.0 · AVG: - · TTFT: -");
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
    h.end(1_000, reason);
    assert.match(h.status(), /AVG: 50\.0 · TTFT: 1\.0$/);
    assert.equal(h.timers.size, 0);
  }
  h.begin();
  h.end(0);
  assert.match(h.status(), /AVG: 50\.0 · TTFT: 1\.0$/);
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
  assert.equal(h.status(), "TPS: 20.0 · AVG: 20.0 · TTFT: 1.0");
});

test("session replacement, reload and tree navigation reset statistics and stop timers", (t) => {
  const h = harness(t);
  for (const event of ["session_start", "session_tree"]) {
    h.begin();
    h.delta("hello");
    h.advance(1_000);
    h.end(10);
    h.begin();
    h.delta("still streaming");
    h.emit(event);
    assert.equal(h.status(), undefined);
    assert.equal(h.timers.size, 0);
    h.end(100);
    assert.equal(h.status(), undefined);
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
  h.advance(5_000);
  h.end(100);
  assert.equal(h.status(), undefined);
});

test("zero-time/short responses have finite rates and length-limited responses count", (t) => {
  const h = harness(t);
  h.begin();
  h.delta("hello");
  h.end(20, "length");
  assert.equal(h.status(), "TPS: 80.0 · AVG: 80.0 · TTFT: 0.0");
  for (const output of [NaN, Infinity, -10]) {
    h.emit("session_start");
    h.begin();
    h.delta("hello");
    h.advance(1_000);
    h.end(output);
    assert.equal(h.status(), "TPS: 1.00 · AVG: 1.00 · TTFT: 0.0");
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
  assert.equal(h.status(), "TPS: 10.0 · AVG: 10.0 · TTFT: 0.5");
});

test("print/JSON mode creates no timers or UI calls", (t) => {
  const h = harness(t, false);
  h.emit("session_start");
  h.begin();
  h.delta("hello");
  h.advance(1_000);
  h.end(100);
  h.emit("agent_end");
  h.emit("session_shutdown");
  assert.equal(h.statuses.length, 0);
  assert.equal(h.timers.size, 0);
});

test("refreshes are throttled and duplicate completion is ignored", (t) => {
  const h = harness(t);
  h.begin();
  h.delta("hello");
  const count = h.statuses.length;
  for (let i = 0; i < 100; i++) h.delta("world");
  assert.equal(h.statuses.length, count);
  assert.equal(h.timers.size, 1);
  h.advance(1_000);
  h.end(100);
  const final = h.status();
  h.end(900);
  assert.equal(h.status(), final);
  assert.equal(h.timers.size, 0);
});

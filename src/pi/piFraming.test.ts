import { expect, test } from "vite-plus/test";
import type { WorldBinding } from "../protocol/bridge.js";
import { JudgmentQueue } from "../runtime/judgmentQueue.js";
import { defaultMaxFrameBytes, encodeJsonLine, JsonLineDecoder } from "../transport/jsonLines.js";
import {
  createPiJsonLineDecoder,
  encodePiJsonLine,
  maxPiFrameBytes,
  maxPiJudgmentBytes,
} from "./piFraming.js";

const world: WorldBinding = {
  worldId: "world-a",
  playerId: "player-a",
  worldSessionId: "session-a",
};

function judgment(messages: string[]): string {
  const queue = new JudgmentQueue(world);
  for (const message of messages) queue.enqueueMessage(world, message);
  return JSON.stringify(queue.take());
}

function userMessage(text: string) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Number.MAX_SAFE_INTEGER,
  };
}

function receive(frame: Buffer): unknown[] {
  const decoder = createPiJsonLineDecoder();
  const values: unknown[] = [];
  const onLine = (line: string) => values.push(JSON.parse(line) as unknown);
  decoder.push(frame.subarray(0, 17), onLine);
  decoder.push(frame.subarray(17), onLine);
  decoder.finish();
  return values;
}

test("reserves 256 bytes beyond doubled batch JSON for verified Pi envelopes", () => {
  const user = userMessage("");
  const envelopes = [
    { id: String(Number.MAX_VALUE), type: "prompt", message: "" },
    { type: "message_start", message: user },
    { type: "message_end", message: user },
    { type: "agent_end", messages: [user], willRetry: false },
  ];
  const bytes = envelopes.map((value) => Buffer.byteLength(JSON.stringify(value)));
  expect(bytes).toEqual([61, 117, 115, 134]);
  expect(Math.max(...bytes)).toBeLessThanOrEqual(256);
  expect(maxPiJudgmentBytes).toBe(defaultMaxFrameBytes);
  expect(maxPiFrameBytes).toBe(2 * defaultMaxFrameBytes + 256);
  // Includes LF; the existing pending-send ceiling is still 4 MiB.
  expect(maxPiFrameBytes + 1).toBeLessThan(4 * 1024 * 1024);
});

test("carries a full 1 MiB admitted JSON batch through prompt and user echo", () => {
  const messages = [...Array<string>(32).fill('"'.repeat(16_000)), ""];
  const remaining = defaultMaxFrameBytes - Buffer.byteLength(judgment(messages));
  messages[32] = '"'.repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
  expect(messages.every((text) => text.length <= 16_000)).toBe(true);
  const message = judgment(messages);
  expect(Buffer.byteLength(message)).toBe(defaultMaxFrameBytes);
  expect(Buffer.byteLength(message)).toBeLessThanOrEqual(maxPiJudgmentBytes);
  const prompt = { id: String(Number.MAX_VALUE), type: "prompt", message };
  const frame = encodePiJsonLine(prompt);
  expect(frame.length - 1).toBeGreaterThan(defaultMaxFrameBytes);
  expect(receive(frame)).toEqual([prompt]);
  const echo = { type: "message_start", message: userMessage(message) };
  expect(receive(encodePiJsonLine(echo))).toEqual([echo]);
});

test("decodes quote-heavy user echoes and a representative aggregated agent_end", () => {
  const message = judgment(Array<string>(17).fill('"'.repeat(16_000)));
  const user = userMessage(message);
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: "Ready." }],
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1000,
  };
  const events = [
    { type: "message_start", message: user },
    { type: "message_end", message: user },
    { type: "agent_end", messages: [user, assistant], willRetry: false },
  ];
  expect(receive(Buffer.concat(events.map((event) => encodePiJsonLine(event))))).toEqual(events);
  // Aggregation is not a universal delivery guarantee: inbound Pi JSON remains bounded.
  const oversized = {
    type: "agent_end",
    messages: [user, { ...assistant, content: [{ type: "text", text: message }] }],
    willRetry: false,
  };
  const inbound = Buffer.from(`${JSON.stringify(oversized)}\n`);
  expect(inbound.length - 1).toBeGreaterThan(maxPiFrameBytes);
  expect(() => receive(inbound)).toThrow("JSONL frame exceeds byte limit");
});

test("keeps the global and TCP codec at its existing 1 MiB default", () => {
  const prompt = {
    id: "1",
    type: "prompt",
    message: judgment(Array<string>(17).fill('"'.repeat(16_000))),
  };
  const frame = encodePiJsonLine(prompt);
  expect(defaultMaxFrameBytes).toBe(1024 * 1024);
  expect(() => encodeJsonLine(prompt)).toThrow("JSONL frame exceeds byte limit");
  expect(() => new JsonLineDecoder().push(frame, () => {})).toThrow(
    "JSONL frame exceeds byte limit",
  );
});

test("accepts exactly the finite Pi byte limit and rejects one byte more", () => {
  const exact = "x".repeat(maxPiFrameBytes - 2);
  const frame = encodePiJsonLine(exact);
  expect(frame.length - 1).toBe(maxPiFrameBytes);
  expect(receive(frame)).toEqual([exact]);
  expect(() => encodePiJsonLine(exact + "x")).toThrow("JSONL frame exceeds byte limit");
  const over = Buffer.from(`${JSON.stringify(exact + "x")}\n`);
  expect(() => receive(over)).toThrow("JSONL frame exceeds byte limit");
  expect(() => receive(over.subarray(0, -1))).toThrow("JSONL frame exceeds byte limit");
});

test("rejects unsupported raw control escaping instead of granting a 6 MiB allowance", () => {
  const message = "\0".repeat(Math.ceil((2 * defaultMaxFrameBytes + 256) / 6));
  expect(Buffer.byteLength(message)).toBeLessThan(defaultMaxFrameBytes);
  expect(() => encodePiJsonLine({ id: "1", type: "prompt", message })).toThrow(
    "JSONL frame exceeds byte limit",
  );
});

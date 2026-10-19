import { afterEach, expect, test, vi } from "vite-plus/test";
import { writeCliLog } from "./cliLog.js";

afterEach(() => vi.restoreAllMocks());

test("CLI diagnostics are readable, timestamped, stderr-only, and safe for terminals", () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const stdout = vi.spyOn(process.stdout, "write");
  writeCliLog("tool_execution_start", {
    toolName: "send_message",
    toolCallId: "call-1",
    args: { text: "hello\n\u001b[2J\u009b2J\u2028\u2029" },
  });
  expect(stderr).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(
      /^\[\d{4}-\d{2}-\d{2}T[^\]]+Z\] Tool started: send_message \(call-1\)\n  Arguments: /,
    ),
  );
  const output = String(stderr.mock.calls[0]![0]);
  expect(output).toContain("hello\\n");
  expect(output.replaceAll("\n", "")).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
  expect(output).not.toContain("tool_execution_start");
  expect(stdout).not.toHaveBeenCalled();
});

test.each([
  [
    "game.attached",
    { worldId: "world-1", playerId: "player-1", language: "ja_jp", paused: false },
    ["Game connected", "World: world-1", "Player: player-1", "Language: ja_jp", "State: Playing"],
  ],
  ["game.attached", { paused: true }, ["Game connected", "State: Paused"]],
  ["game.detached", { worldId: "world-1" }, ["Game disconnected", "World: world-1"]],
  ["game.status", { paused: true }, ["Game paused"]],
  ["game.status", { paused: false }, ["Game resumed"]],
  [
    "run.requested",
    {
      initial: true,
      poll: true,
      playerMessages: ["こんにちは"],
      hooks: ["hook-1"],
      observations: 2,
    },
    [
      "Run requested",
      "Initial run: Yes",
      "Periodic check: Yes",
      "Player messages: [ 'こんにちは' ]",
      "Hooks: [ 'hook-1' ]",
      "Observations: 2",
    ],
  ],
  [
    "run.invalidated",
    { reason: "world_detached" },
    ["Run cancellation requested", "Reason: world detached"],
  ],
  ["pi.ready", { provider: "test", model: "native" }, ["Pi ready", "Model: test/native"]],
  ["pi.prompt_submitted", {}, ["Run sent to Pi"]],
  ["pi.agent_settled", { aborted: false }, ["Run finished"]],
  ["pi.agent_settled", { aborted: true }, ["Run cancelled"]],
] as const)("%s is described in plain language", (event, details, expected) => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  writeCliLog(event, details);
  const output = String(stderr.mock.calls[0]![0]);
  for (const text of expected) expect(output).toContain(text);
  expect(output).not.toContain(event);
  expect(output).not.toContain("undefined");
});

test("empty run reasons and internal binding fields do not clutter logs", () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  writeCliLog("run.requested", {
    sessionId: "session-1",
    initial: false,
    poll: false,
    playerMessages: [],
    hooks: [],
    observations: 0,
  });
  const output = String(stderr.mock.calls[0]![0]);
  expect(output).toContain("Run requested");
  expect(output).not.toMatch(/session-1|Initial run|Periodic check|Player messages|Hooks/);
});

test.each([
  [
    {
      content: [{ type: "text", text: '{"displayed":true}' }],
      details: { displayed: true },
    },
    "Result: { displayed: true }",
  ],
  [[], "Result: []"],
  [null, "Result: null"],
] as const)("tool results show the payload once, including empty results", (result, expected) => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  writeCliLog("tool_execution_end", {
    toolName: "send_message",
    toolCallId: "call-1",
    result,
  });
  const output = String(stderr.mock.calls[0]![0]);
  expect(output).toContain(expected);
  expect(output).not.toMatch(/content:|details:|Duration:/);
});

test("terminal controls in headings are escaped too", () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  writeCliLog("tool_execution_start", {
    toolName: "send_message\n\u001b[2J\u009b2J\u2028\u2029",
    toolCallId: "call\r\b-1",
    args: {},
  });
  const output = String(stderr.mock.calls[0]![0]);
  expect(output).toContain("Tool started: send_message\\n");
  expect(output.replaceAll("\n", "")).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
  expect(output.split("\n")).toHaveLength(3);
});

test("large tool results are bounded with an explicit truncation marker", () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  writeCliLog("tool_execution_end", {
    toolName: "get_game_state",
    toolCallId: "call-1",
    result: "x".repeat(100_000),
  });
  const output = String(stderr.mock.calls[0]![0]);
  expect(output).toContain("Tool completed: get_game_state (call-1)");
  expect(output).toContain("Result:");
  expect(output.length).toBeLessThan(4_300);
  expect(output).toContain("[truncated]");
  expect(output.endsWith("\n")).toBe(true);
});

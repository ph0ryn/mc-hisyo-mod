import { execFile, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vite-plus/test";
import { encodePiJsonLine } from "./piFraming.js";
import { supportedPiVersion } from "./piPolicy.js";
import { PiRunError, startPiRpcClient } from "./piRpcClient.js";
import { writeCliLog } from "../cliLog.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));

const model = { provider: "test", id: "native", api: "openai-responses" };
type Command = { id: string; type: string; message?: string };

// Literal stdio peer: no process, provider, bridge, files or real deadlines.
class ManualChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly commands: Command[] = [];
  readonly pending: Command[] = [];
  readonly waiters = new Map<string, (command: Command) => void>();
  readonly kill = vi.fn(() => true);
  readonly stdin = new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      const command = JSON.parse(chunk.toString()) as Command;
      this.commands.push(command);
      switch (command.type) {
        case "get_available_models":
          this.reply(command, { models: [model] });
          break;
        case "get_available_thinking_levels":
          this.reply(command, { levels: ["medium"] });
          break;
        case "get_state":
          this.reply(command, {
            model,
            thinkingLevel: "medium",
            isStreaming: false,
            isCompacting: false,
            autoCompactionEnabled: false,
            pendingMessageCount: 0,
          });
          break;
        default: {
          const waiter = this.waiters.get(command.type);
          if (waiter) {
            this.waiters.delete(command.type);
            waiter(command);
          } else this.pending.push(command);
        }
      }
      done();
    },
  });

  next(type: string): Promise<Command> {
    const index = this.pending.findIndex((command) => command.type === type);
    if (index !== -1) return Promise.resolve(this.pending.splice(index, 1)[0]!);
    return new Promise((resolve) => this.waiters.set(type, resolve));
  }

  send(value: unknown): void {
    this.stdout.write(encodePiJsonLine(value));
  }

  reply(command: Command, data?: unknown): void {
    this.send({ type: "response", id: command.id, command: command.type, success: true, data });
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function setup(onLog?: (event: string, details?: Record<string, unknown>) => void) {
  const child = new ManualChild();
  vi.mocked(execFile).mockImplementation((...args) => {
    const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void;
    callback(null, supportedPiVersion, "");
    return child as unknown as ChildProcess;
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const client = await startPiRpcClient({
    executable: "unused-pi",
    args: [],
    cwd: "/unused",
    env: {},
    model,
    isAgentReady: () => true,
    requestTimeoutMs: 100,
    judgmentTimeoutMs: 1_000,
    shutdownTimeoutMs: 10,
    ...(onLog ? { onLog } : {}),
  });
  onTestFinished(async () => {
    child.emit("close");
    await client.close();
  });
  await client.initialize(new AbortController().signal);
  return { child, client };
}

test("prompt ACK and agent_end cannot release a judgment; agent_settled can", async () => {
  const { child, client } = await setup();
  const run = client.run("first");
  const prompt = await child.next("prompt");
  expect(prompt.message).toBe("first");
  child.reply(prompt, { disposition: "started" });
  child.send({ type: "agent_end", messages: [], willRetry: false });
  await vi.advanceTimersByTimeAsync(0);
  await expect(client.run("overlap")).rejects.toThrow("not settled");
  child.send({ type: "agent_settled", aborted: false });
  await expect(run).resolves.toEqual({ status: "settled", aborted: false });
  const next = client.run("next");
  child.reply(await child.next("prompt"), { disposition: "started" });
  child.send({ type: "agent_settled", aborted: false });
  await expect(next).resolves.toEqual({ status: "settled", aborted: false });
});

test.each([false, true])(
  "Pi tool events reach CLI stderr, including isError=%s",
  async (isError) => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    onTestFinished(() => stderr.mockRestore());
    const { child, client } = await setup(writeCliLog);
    const run = client.run("PRIVATE_PROMPT");
    child.reply(await child.next("prompt"), { disposition: "started" });
    const tool = { toolCallId: "call-1", toolName: "send_message" };
    child.stderr.write("PRIVATE_CHILD_STDERR");
    child.send({ type: "message_end", message: { role: "assistant", content: "PRIVATE_PROSE" } });
    child.send({ type: "unknown_event", token: "PRIVATE_TOKEN" });
    child.send({
      type: "tool_execution_start",
      ...tool,
      args: isError ? null : { text: "こんにちは\n\u001b[2J" },
      token: "PRIVATE_TOKEN",
    });
    child.send({
      type: "tool_execution_end",
      ...tool,
      result: { content: [{ type: "text", text: isError ? "Display failed" : "Displayed" }] },
      isError,
      durationMs: 12,
    });
    child.send({ type: "agent_settled", aborted: false });
    await expect(run).resolves.toEqual({ status: "settled", aborted: false });
    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("Pi ready");
    expect(output).toContain("Model: test/native");
    expect(output).toContain("Judgment sent to Pi");
    expect(output).toContain("Tool started: send_message (call-1)");
    expect(output).toContain(isError ? "Arguments: null" : "Arguments: { text: 'こんにちは\\n");
    expect(output).toContain("Duration: 12 ms");
    expect(output).toContain(`Tool ${isError ? "failed" : "completed"}: send_message (call-1)`);
    expect(output).toContain("Result:");
    expect(output).toContain(isError ? "Display failed" : "Displayed");
    expect(output).toContain("Judgment finished");
    expect(output).not.toMatch(/pi\.ready|pi\.prompt_submitted|tool_execution_|pi\.agent_settled/);
    expect(output).not.toContain("PRIVATE_");
    expect(output).not.toContain("\u001b");
    expect(client.diagnostics).toBe("PRIVATE_CHILD_STDERR");
  },
);

test("malformed tool diagnostics fail closed before being displayed", async () => {
  const onLog = vi.fn();
  const { child, client } = await setup(onLog);
  const run = client.run("first");
  const failed = expect(run).rejects.toBeInstanceOf(PiRunError);
  child.reply(await child.next("prompt"), { disposition: "started" });
  child.send({
    type: "tool_execution_end",
    toolCallId: 1,
    toolName: "send_message",
    isError: "no",
  });
  await failed;
  expect(client.isRetired).toBe(true);
  expect(onLog.mock.calls.some(([event]) => event.startsWith("tool_execution"))).toBe(false);
});

test("cancellation before submission is not_started and writes no prompt", async () => {
  const { child, client } = await setup();
  await expect(client.run("cancelled", AbortSignal.abort())).resolves.toEqual({
    status: "not_started",
  });
  expect(child.commands.some(({ type }) => type === "prompt")).toBe(false);
  expect(client.isRetired).toBe(false);
});

test("cancellation during prompt preflight needs a fresh abort after started ACK", async () => {
  const { child, client } = await setup();
  const signal = new AbortController();
  const run = client.run("first", signal.signal);
  const prompt = await child.next("prompt");
  signal.abort();
  child.reply(await child.next("abort"));
  child.reply(await child.next("clear_queue"), { steering: [], followUp: [] });
  child.reply(prompt, { disposition: "started" });
  const freshAbort = await child.next("abort");
  child.send({ type: "agent_settled", aborted: true });
  await vi.advanceTimersByTimeAsync(0);
  await expect(client.run("overlap")).rejects.toThrow("not settled");
  child.reply(freshAbort);
  await expect(run).resolves.toEqual({ status: "settled", aborted: true });
  expect(child.commands.filter(({ type }) => type === "abort")).toHaveLength(2);
});

test("settlement still holds the slot until cancellation and queue-clear ACKs", async () => {
  const { child, client } = await setup();
  const run = client.run("first");
  const completed = vi.fn();
  void run.then(completed, completed);
  const prompt = await child.next("prompt");
  child.reply(prompt, { disposition: "started" });
  await vi.advanceTimersByTimeAsync(0);
  const cancel = client.cancel();
  const abort = await child.next("abort");
  const clear = await child.next("clear_queue");
  child.send({ type: "agent_settled", aborted: true });
  child.reply(abort);
  await vi.advanceTimersByTimeAsync(0);
  expect(completed).not.toHaveBeenCalled();
  await expect(client.run("overlap")).rejects.toThrow("not settled");
  child.reply(clear, { steering: [], followUp: [] });
  await expect(run).resolves.toEqual({ status: "settled", aborted: true });
  await expect(cancel).resolves.toBeUndefined();
});

test.each([
  ["unmatched ID", "Uncorrelated Pi response"],
  ["wrong command", "Uncorrelated Pi response"],
  ["malformed response", "Invalid Pi response"],
  ["invalid settlement", "Unexpected Pi settlement"],
  ["missing event type", "Invalid Pi stdout event"],
] as const)("%s fails closed instead of releasing a healthy slot", async (name, message) => {
  const { child, client } = await setup();
  const faults = vi.fn();
  client.on("fault", faults);
  const run = client.run("first");
  const prompt = await child.next("prompt");
  const response = { type: "response", id: prompt.id, command: "prompt", success: true };
  const values = {
    "unmatched ID": { ...response, id: "unknown" },
    "wrong command": { ...response, command: "abort" },
    "malformed response": { ...response, success: "yes" },
    "invalid settlement": { type: "agent_settled", aborted: "yes" },
    "missing event type": {},
  };
  const failed = expect(run).rejects.toBeInstanceOf(PiRunError);
  child.send(values[name]);
  await failed;
  expect(client.isRetired).toBe(true);
  expect(faults).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message }));
  await expect(client.run("next")).rejects.toThrow("retired");
});

test("shutdown is shared and waits for confirmed exit after escalating signals", async () => {
  const { child, client } = await setup();
  const close = client.close();
  expect(client.close()).toBe(close);
  let closed = false;
  void close.then(() => {
    closed = true;
  });
  await vi.advanceTimersByTimeAsync(10);
  expect(child.stdin.writableEnded).toBe(true);
  expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
  expect(closed).toBe(false);
  await vi.advanceTimersByTimeAsync(10);
  expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  expect(closed).toBe(false);
  child.emit("close");
  await close;
  expect(closed).toBe(true);
});

import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test } from "vite-plus/test";
import { startPiRpcClient } from "./piRpcClient.js";

async function fixture(
  fake: Record<string, unknown> = {},
  ready = () => true,
  limits: {
    requestTimeoutMs?: number;
    judgmentTimeoutMs?: number;
    shutdownTimeoutMs?: number;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "mc-hisyo-stdio-"));
  const capture = join(directory, "capture.jsonl");
  const control = join(directory, "control");
  writeFileSync(capture, "");
  writeFileSync(control, "");
  const records = () => readFileSync(capture, "utf8");
  const client = await startPiRpcClient({
    executable: process.execPath,
    prefixArgs: [fileURLToPath(new URL("./fixtures/fakePi.mjs", import.meta.url))],
    args: [],
    cwd: directory,
    env: {
      MC_HISYO_CAPTURE: capture,
      MC_HISYO_CONTROL: control,
      MC_HISYO_FAKE: JSON.stringify(fake),
    },
    model: { provider: "local", id: "director", api: "openai-completions" },
    isAgentReady: ready,
    requestTimeoutMs: 1_000,
    judgmentTimeoutMs: 2_000,
    shutdownTimeoutMs: 100,
    ...limits,
  });
  onTestFinished(() => client.close());
  return { client, records, send: (command: string) => appendFileSync(control, `${command}\n`) };
}

test("prompt ACK and agent_end do not release the single-flight slot", async () => {
  const f = await fixture();
  let completed = false;
  const run = f.client.run("Inspect progress").then((result) => {
    completed = true;
    return result;
  });
  await expect.poll(f.records).toContain('"agent_end"');
  expect(completed).toBe(false);
  await expect(f.client.run("Do not overlap")).rejects.toThrow(/settled/);
  expect(f.records().match(/"type":"prompt"/g)).toHaveLength(1);
  f.send("settle");
  await expect(run).resolves.toEqual({ status: "settled", aborted: false });
});

const gateCases = {
  provider: { state: { model: { provider: "other", id: "director", api: "openai-completions" } } },
  model: { state: { model: { provider: "local", id: "fallback", api: "openai-completions" } } },
  api: { state: { model: { provider: "local", id: "director", api: "google-generative-ai" } } },
  catalog: { models: [] },
  unsupported: { models: [{ provider: "local", id: "director", api: "google-generative-ai" }] },
  duplicate: {
    models: Array(2).fill({ provider: "local", id: "director", api: "openai-completions" }),
  },
  "missing-medium": { levels: ["low", "high"] },
  clamped: { state: { thinkingLevel: "low" } },
  streaming: { state: { isStreaming: true } },
  compacting: { state: { isCompacting: true } },
  compaction: { state: { autoCompactionEnabled: true } },
  queue: { state: { pendingMessageCount: 1 } },
  malformed: { state: { model: null } },
};
for (const [name, config] of Object.entries(gateCases)) {
  test(`metadata gate refuses ${name} without submitting a prompt`, async () => {
    const f = await fixture(config);
    await expect(f.client.run("Must not submit")).rejects.toMatchObject({ mayHaveStarted: false });
    expect(f.records()).not.toContain('"type":"prompt"');
    expect(f.client.isRetired).toBe(true);
  });
}

test("wrong exact executable version fails before the stdio child starts", async () => {
  await expect(fixture({ version: "1.2.1" })).rejects.toThrow("Pi 1.2.0 is required");
});

for (const [name, ready] of Object.entries({
  missing: (): boolean => false,
  lost: (() => {
    let checks = 0;
    return () => ++checks === 1;
  })(),
})) {
  test(`authenticated extension readiness ${name} refuses a prompt`, async () => {
    const f = await fixture({}, ready);
    await expect(f.client.run("Must not submit")).rejects.toMatchObject({ mayHaveStarted: false });
    expect(f.records()).not.toContain('"type":"prompt"');
  });
}

for (const mode of ["auto", "split", "settled-first", "coalesced"]) {
  test(`${mode}: captures terminal before ACK consumption and rechecks the next judgment`, async () => {
    const f = await fixture({ mode });
    await expect(f.client.run("First")).resolves.toEqual({ status: "settled", aborted: false });
    await expect(f.client.run("Second")).resolves.toEqual({ status: "settled", aborted: false });
    const lines = f.records();
    expect(lines.match(/"type":"get_state"/g)).toHaveLength(2);
    expect(lines.match(/"type":"prompt"/g)).toHaveLength(2);
    expect(lines).not.toContain("streamingBehavior");
    expect(lines).not.toContain('"type":"send_message"');
  });
}

test("already-cancelled judgment is explicitly not_started, without poisoning the child", async () => {
  const f = await fixture({ mode: "auto" });
  await expect(f.client.run("Never sent", AbortSignal.abort())).resolves.toEqual({
    status: "not_started",
  });
  expect(f.records()).toBe("");
  await expect(f.client.run("Next")).resolves.toEqual({ status: "settled", aborted: false });
});

test("cancellation while metadata awaits is not_started, not fabricated settled", async () => {
  const f = await fixture({ mode: "delay-state" });
  const signal = new AbortController();
  const run = f.client.run("Never sent", signal.signal);
  await expect.poll(f.records).toContain('"type":"get_state"');
  signal.abort();
  f.send("release-state");
  await expect(run).resolves.toEqual({ status: "not_started" });
  expect(f.records()).not.toContain('"type":"prompt"');
  expect(f.records()).not.toContain('"type":"abort"');
  expect(f.client.isRetired).toBe(false);
});

test("cancel before prompt ACK: abort ACK does not release slot or imply settled", async () => {
  const f = await fixture({ mode: "no-ack" });
  const signal = new AbortController();
  let completed = false;
  const run = f.client.run("Wait for authoritative terminal", signal.signal).then((result) => {
    completed = true;
    return result;
  });
  await expect.poll(f.records).toContain('"type":"prompt"');
  signal.abort();
  const cancelled = f.client.cancel();
  await expect.poll(f.records).toContain('"command":"abort"');
  await expect.poll(f.records).toContain('"command":"clear_queue"');
  expect(completed).toBe(false);
  await expect(f.client.run("No reuse yet")).rejects.toThrow(/settled/);
  f.send("settle");
  f.send("ack");
  await expect(run).resolves.toEqual({ status: "settled", aborted: true });
  await cancelled;
  expect(f.records().match(/"type":"abort"/g)).toHaveLength(1);
});

test("preflight cancellation aborts again after the submitted prompt actually starts", async () => {
  const f = await fixture({ mode: "preflight" });
  const run = f.client.run("Wait for preflight").then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  await expect.poll(f.records).toContain('"type":"prompt"');
  const cancelled = f.client.cancel();
  await expect.poll(f.records).toContain('"command":"clear_queue"');
  expect(f.records()).not.toContain('"agent_settled"');
  f.send("ack");
  await expect.poll(() => f.records().match(/"type":"abort"/g)?.length).toBe(2);
  await expect(run).resolves.toEqual({ result: { status: "settled", aborted: true } });
  await cancelled;
});

for (const disposition of ["handled", "queued", "unknown"]) {
  test(`non-exclusive prompt disposition ${disposition} retires without waiting for nonexistent terminal`, async () => {
    const f = await fixture({ disposition });
    await expect(f.client.run("Inspect")).rejects.toMatchObject({ mayHaveStarted: true });
    expect(f.client.isRetired).toBe(true);
  });
}

for (const mode of [
  "malformed",
  "batch",
  "utf8",
  "oversized",
  "truncated",
  "wrong-id",
  "wrong-command",
  "rpc-error",
  "timeout",
]) {
  test(`${mode} protocol failure retires the child before any prompt`, async () => {
    const f = await fixture({ mode });
    const faults: unknown[] = [];
    f.client.on("fault", (error) => faults.push(error));
    await expect(f.client.run("Must not submit")).rejects.toMatchObject({ mayHaveStarted: false });
    expect(f.records()).not.toContain('"type":"prompt"');
    expect(faults).toHaveLength(1);
    await expect(f.client.run("No reuse")).rejects.toThrow(/retired/);
  });
}

for (const mode of ["no-ack", "exit", "manual"]) {
  test(`${mode}: failure after write is unknown-started, never not_started`, async () => {
    const f = await fixture({ mode }, () => true, { judgmentTimeoutMs: 150 });
    await expect(f.client.run("Inspect")).rejects.toMatchObject({ mayHaveStarted: true });
    expect(f.records().match(/"type":"prompt"/g)).toHaveLength(1);
    await expect(f.client.run("No reuse")).rejects.toThrow(/retired/);
  });
}

test("nonempty cancellation queues are an invariant failure, not silently discarded", async () => {
  const f = await fixture({ queued: ["Unowned input"] });
  const run = f.client.run("Inspect").then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  await expect.poll(f.records).toContain('"agent_end"');
  await f.client.cancel();
  await expect(run).resolves.toMatchObject({ error: { mayHaveStarted: true } });
  expect(f.client.isRetired).toBe(true);
});

test("close bounds cancellation; EOF is not converted into a successful settlement", async () => {
  const f = await fixture();
  const run = f.client.run("Inspect").then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  await expect.poll(f.records).toContain('"agent_end"');
  await f.client.close();
  await expect(run).resolves.toMatchObject({ error: { mayHaveStarted: true } });
  expect(f.records()).not.toContain('"type":"agent_settled"');
  expect(f.records()).toContain('"eof":true');
});

test("shutdown escalates ignored EOF and SIGTERM to bounded child termination", async () => {
  const f = await fixture({ mode: "ignore-stop" });
  const run = f.client.run("Inspect");
  await expect.poll(f.records).toContain('"agent_end"');
  f.send("settle");
  await run;
  await f.client.close();
  expect(f.records()).toContain('"eof":true');
  expect(f.records()).toContain('"term":true');
  await f.client.close();
});

for (const [name, config] of Object.entries({
  duplicate: { mode: "duplicate" },
  invalid: { mode: "auto", terminal: { aborted: null } },
})) {
  test(`${name} terminal cannot become a successful judgment`, async () => {
    const f = await fixture(config);
    await expect(f.client.run("Inspect")).rejects.toMatchObject({ mayHaveStarted: true });
    expect(f.client.isRetired).toBe(true);
  });
}

test("stderr diagnostics are bounded and do not become protocol or game output", async () => {
  const f = await fixture({ mode: "stderr" });
  const run = f.client.run("Inspect");
  await expect.poll(f.records).toContain('"agent_end"');
  await expect.poll(() => f.client.diagnostics.endsWith("END")).toBe(true);
  expect(Buffer.byteLength(f.client.diagnostics)).toBe(16_384);
  f.send("settle");
  await expect(run).resolves.toEqual({ status: "settled", aborted: false });
});

test("hung version preflight is killed without starting the protocol child", async () => {
  await expect(fixture({ version: "hang" }, () => true, { requestTimeoutMs: 150 })).rejects.toThrow(
    "Pi version preflight failed",
  );
});

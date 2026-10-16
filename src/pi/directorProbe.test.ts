import assert from "node:assert/strict";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { sendProviderResponse, type ProviderApi } from "./fixtures/localProvider.mjs";

type ProcessExit = { code: number | null; signal: NodeJS.Signals | null };
interface TraceEntry extends Record<string, unknown> {
  source: string;
  type: string;
  body?: Record<string, unknown>;
}
type TraceRecord = TraceEntry & { seq: number };
const requestSchema = Type.Object({
  tools: Type.Optional(
    Type.Array(
      Type.Object({
        function: Type.Optional(Type.Object({ name: Type.String() })),
        name: Type.Optional(Type.String()),
      }),
    ),
  ),
});
const stateSchema = Type.Object({
  model: Type.Object({ provider: Type.String(), id: Type.String(), api: Type.String() }),
  thinkingLevel: Type.String(),
  autoCompactionEnabled: Type.Boolean(),
  isStreaming: Type.Boolean(),
});
const promptSchema = Type.Object({ disposition: Type.String() });

// Optional real-PATH-Pi boundary test; never contacts a real model provider.
const extensionPath = fileURLToPath(new URL("./fixtures/directorProbe.mjs", import.meta.url));
const apis: ProviderApi[] = ["openai-completions", "openai-responses", "anthropic-messages"];
const scenarios = ["success", "throw-only", "abort-first", "abort-second"];
let preflight: { version: SpawnSyncReturns<string>; output: string } | undefined;
const results: Awaited<ReturnType<typeof run>>[] = [];

// Collection must not execute even the Pi version preflight.
beforeAll(() => {
  const version = spawnSync("pi", ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, `PATH pi --version failed: ${version.error ?? version.stderr}`);
  assert.equal(version.stdout.trim(), "1.2.0", "Only the validated Pi 1.2.0 is supported");
  preflight = { version, output: mkdtempSync(join(tmpdir(), "mc-hisyo-pi-")) };
});

async function run(scenario: string, api: ProviderApi) {
  assert.ok(preflight);
  const folder = join(preflight.output, api, scenario);
  for (const name of ["", "agent", "sessions", "home", "cwd", "tmp"])
    mkdirSync(join(folder, name), { recursive: true, mode: 0o700 });
  const promptPath = join(folder, "system.md");
  // Director-owned scratch settings only, never the user's agent directory.
  writeFileSync(
    join(folder, "agent", "settings.json"),
    JSON.stringify({ compaction: { enabled: false }, cacheWarming: "off" }, null, 2),
    { mode: 0o600 },
  );
  writeFileSync(
    promptPath,
    "You are a local feasibility probe. Use only the game Tool stub. Never run OS commands.\n",
  );
  const records: TraceRecord[] = [];
  const waiters = new Set<() => void>();
  const http: { path: string; body: Record<string, unknown> }[] = [];
  let stdout = "";
  let stderr = "";
  let failure: string | undefined;
  let closeResult: ProcessExit | undefined;
  let providerCount = 0;
  let stateCount = 0;
  let gameCount = 0;
  let hostActive = true;
  let failureProviderCount: number | undefined;
  let failureGameCount: number | undefined;
  const record = (entry: TraceEntry) => {
    records.push({ seq: records.length + 1, ...entry });
    for (const waiter of waiters) waiter();
  };
  function waitFor(
    predicate: (record: TraceRecord) => boolean,
    label: string,
  ): Promise<TraceRecord> {
    const prior = records.find(predicate);
    if (prior) return Promise.resolve(prior);
    return new Promise<TraceRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`Timeout waiting for ${label}`));
      }, 12000);
      const check = () => {
        const found = records.find(predicate);
        if (found) {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(found);
        }
      };
      waiters.add(check);
    });
  }
  const server = createServer(async (req, res) => {
    try {
      assert.ok(req.url);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      assert.ok(Check(Type.Record(Type.String(), Type.Unknown()), body));
      http.push({ path: req.url, body });
      if (req.url.startsWith("/provider/")) {
        assert.ok(Check(requestSchema, body));
        providerCount++;
        record({
          source: "http",
          type: "provider_request",
          number: providerCount,
          path: req.url,
          tools: body.tools?.map((tool) => tool.function?.name ?? tool.name),
        });
        if (api === "openai-completions") assert.equal(req.url, "/provider/v1/chat/completions");
        else if (api === "openai-responses") assert.equal(req.url, "/provider/v1/responses");
        else assert.ok(req.url.startsWith("/provider/v1/messages"));
        sendProviderResponse(res, {
          api,
          toolCalls:
            providerCount === 1
              ? [{ id: "call_stub", name: "send_message", arguments: { text: "local dummy only" } }]
              : [],
          text: "Local probe complete.",
        });
        return;
      }
      if (req.url === "/state") {
        stateCount++;
        const failAt = scenario === "abort-second" ? 2 : scenario === "success" ? -1 : 1;
        if (stateCount === failAt) {
          if (scenario !== "throw-only") hostActive = false;
          failureProviderCount = providerCount;
          failureGameCount = gameCount;
          record({
            source: "http",
            type: "latest_state_failed",
            stateCount,
            providerCount,
            gameCount,
            hostActive,
          });
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Required latest state unavailable (local fixture)" }));
          return;
        }
      }
      if (req.url === "/message") {
        if (!hostActive) {
          record({ source: "http", type: "host_rejected_side_effect" });
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid run" }));
          return;
        }
        gameCount++;
        record({ source: "http", type: "game_stub_message", number: gameCount });
      } else record({ source: "http", type: req.url.slice(1), body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          req.url === "/state"
            ? { tick: 42 + stateCount, health: 20, snapshot: stateCount }
            : { ok: true },
        ),
      );
    } catch (error) {
      record({ source: "harness", type: "server_error", path: req.url, error: String(error) });
      failure ??= `Fixture error at ${req.url}: ${String(error)}`;
      if (res.headersSent) res.destroy(error instanceof Error ? error : new Error(String(error)));
      else {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const args = [
    "--mode",
    "rpc",
    "--offline",
    "--no-extensions",
    "--extension",
    extensionPath,
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--append-system-prompt",
    "",
    "--system-prompt",
    promptPath,
    "--no-approve",
    "--no-builtin-tools",
    "--tools",
    "send_message",
    "--session-dir",
    join(folder, "sessions"),
    "--model",
    "scratch-local/dummy-model",
    "--thinking",
    "medium",
    "--api-key",
    "dummy-not-a-real-provider-key",
  ];
  const env = {
    PATH: process.env.PATH,
    HOME: join(folder, "home"),
    USER: "pi-local-probe",
    TMPDIR: join(folder, "tmp"),
    PI_CODING_AGENT_DIR: join(folder, "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(folder, "sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    PI_PROBE_ORIGIN: origin,
    PI_PROBE_SCENARIO: scenario,
    PI_PROBE_API: api,
  };
  writeFileSync(
    join(folder, "command.json"),
    JSON.stringify({ command: "pi", args, env, cwd: join(folder, "cwd") }, null, 2),
  );
  const child = spawn("pi", args, {
    cwd: join(folder, "cwd"),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise<ProcessExit>((resolve) =>
    child.once("close", (code, signal) => {
      closeResult = { code, signal };
      record({ source: "process", type: "exit", ...closeResult });
      resolve(closeResult);
    }),
  );
  child.on("error", (error) =>
    record({ source: "process", type: "spawn_error", error: String(error) }),
  );
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const text = decoder.write(chunk);
    stdout += text;
    buffer += text;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        const message: unknown = JSON.parse(line);
        assert.ok(message && typeof message === "object" && "type" in message);
        assert.ok(typeof message.type === "string");
        record({ ...message, source: "rpc", type: message.type });
      } catch (error) {
        record({ source: "harness", type: "invalid_stdout", line, error: String(error) });
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  let serial = 0;
  async function rpc<S extends TSchema>(
    type: string,
    schema: S,
    data: Record<string, unknown> = {},
  ): Promise<TraceRecord & { data: Static<S> }> {
    const id = `req-${++serial}`;
    const response = waitFor(
      (r) => r.source === "rpc" && r.type === "response" && r.id === id,
      `${type} response`,
    );
    child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
    const result = await response;
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(Check(schema, result.data));
    return { ...result, data: result.data };
  }
  try {
    const startup = await waitFor(
      (r) => r.source === "http" && r.type === "startup",
      "extension startup",
    );
    assert.ok(startup.body);
    assert.deepEqual(startup.body.tools, ["send_message"]);
    assert.equal(startup.body.mode, "rpc");
    const state = await rpc("get_state", stateSchema);
    assert.equal(state.data.model.provider, "scratch-local");
    assert.equal(state.data.model.id, "dummy-model");
    // Runtime gate before binding or a paid-capable prompt: reject unknown APIs.
    assert.equal(state.data.model.api, api);
    assert.ok(
      ["openai-completions", "openai-responses", "anthropic-messages"].includes(
        state.data.model.api,
      ),
    );
    assert.equal(state.data.thinkingLevel, "medium");
    assert.equal(
      state.data.autoCompactionEnabled,
      false,
      "Auto-compaction must be off before prompts",
    );
    const levels = await rpc(
      "get_available_thinking_levels",
      Type.Object({ levels: Type.Array(Type.String()) }),
    );
    assert.ok(levels.data.levels.includes("medium"));
    const binding = { worldSessionId: "scratch-world-session", runId: `run-${scenario}` };
    const bind = await rpc("prompt", promptSchema, {
      message: `/bind-run ${JSON.stringify(binding)}`,
    });
    assert.equal(bind.data.disposition, "handled");
    await waitFor((r) => r.source === "http" && r.type === "bound", "binding ACK");
    assert.equal(providerCount, 0, "No provider before binding");
    assert.equal(
      records.filter((r) => r.type === "agent_settled").length,
      0,
      "Handled command must not start a run",
    );
    // Install final lifecycle subscription before sending the prompt.
    const settledPromise = waitFor(
      (r) => r.source === "rpc" && r.type === "agent_settled",
      "agent_settled",
    );
    const prompt = await rpc("prompt", promptSchema, {
      message: "Run the local game Tool stub once.",
    });
    assert.equal(prompt.data.disposition, "started");
    const settled = await settledPromise;
    const after = await rpc("get_state", stateSchema);
    const queue = await rpc(
      "clear_queue",
      Type.Object({ steering: Type.Array(Type.Unknown()), followUp: Type.Array(Type.Unknown()) }),
    );
    assert.equal(after.data.isStreaming, false);
    assert.deepEqual(queue.data.steering, []);
    assert.deepEqual(queue.data.followUp, []);
    const messages = await rpc("get_messages", Type.Unknown());
    assert.ok(
      !JSON.stringify(messages.data).includes("LATEST_STATE"),
      "Transient state must not persist in conversation",
    );
    if (scenario === "success") {
      const requests = http.filter((r) => r.path.startsWith("/provider/"));
      for (const request of requests)
        assert.equal(JSON.stringify(request.body).match(/LATEST_STATE/g)?.length, 1);
      const [first, second] = requests;
      assert.ok(first && second);
      assert.ok(JSON.stringify(first.body).includes('snapshot\\\":1'));
      assert.ok(JSON.stringify(second.body).includes('snapshot\\\":2'));
    }
    if (scenario.startsWith("abort")) {
      assert.equal(settled.aborted, true);
      assert.equal(
        providerCount,
        failureProviderCount,
        "No provider requests after latest-state failure",
      );
      assert.equal(gameCount, failureGameCount, "No game effects after latest-state failure");
      assert.ok(
        records.some(
          (r) =>
            r.type === "event" &&
            r.body?.type === "context_abort" &&
            r.body.abortedSynchronously === true,
        ),
      );
      const stale = await rpc("prompt", promptSchema, { message: "/probe-stale" });
      assert.equal(stale.data.disposition, "handled");
      assert.ok(records.some((r) => r.type === "event" && r.body?.type === "stale_tool_rejected"));
      assert.equal(
        http.filter((r) => r.path === "/message").length,
        failureGameCount,
        "Stale Tool rejected before bridge HTTP",
      );
      if (scenario === "abort-first") assert.equal(providerCount, 0);
      else {
        assert.equal(providerCount, 1);
        assert.equal(gameCount, 1);
        assert.equal(stateCount, 2);
      }
    } else {
      assert.equal(settled.aborted, false);
      assert.equal(providerCount, 2);
      assert.equal(gameCount, 1);
      assert.equal(stateCount, 2);
    }
    const end = records.find((r) => r.source === "rpc" && r.type === "agent_end");
    assert.ok(end && end.seq < settled.seq, "agent_end precedes final settled");
    assert.equal(records.filter((r) => r.source === "rpc" && r.type === "agent_settled").length, 1);
    assert.ok(!records.some((r) => r.type === "invalid_stdout"));
  } catch (error) {
    failure = error instanceof Error ? (error.stack ?? String(error)) : String(error);
  } finally {
    child.stdin.end();
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(deadline);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  writeFileSync(join(folder, "stdout.jsonl"), stdout);
  writeFileSync(join(folder, "stderr.txt"), stderr);
  writeFileSync(join(folder, "trace.json"), JSON.stringify(records, null, 2));
  writeFileSync(join(folder, "http.json"), JSON.stringify(http, null, 2));
  assert.ok(closeResult);
  const result = {
    api,
    scenario,
    passed: !failure && closeResult.code === 0,
    providerCount,
    stateCount,
    gameCount,
    failureProviderCount,
    failureGameCount,
    exit: closeResult,
    failure,
    folder,
  };
  writeFileSync(join(folder, "result.json"), JSON.stringify(result, null, 2));
  return result;
}
for (const api of apis)
  for (const scenario of scenarios) {
    test(`${api}: ${scenario}`, async () => {
      const result = await run(scenario, api);
      results.push(result);
      assert.equal(result.passed, true, JSON.stringify(result, null, 2));
    });
  }

afterAll(() => {
  if (!preflight) return;
  const { version, output } = preflight;
  const resultsPath = join(output, "results.json");
  writeFileSync(
    resultsPath,
    JSON.stringify(
      { version: version.stdout.trim(), versionExit: version.status, results },
      null,
      2,
    ),
  );
  console.log(`RESULTS ${resultsPath}`);
});

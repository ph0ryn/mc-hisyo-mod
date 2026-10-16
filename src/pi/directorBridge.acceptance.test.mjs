import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test } from "vite-plus/test";
import { DirectorBridge } from "../bridge/directorBridge.js";
import { EventCatalog } from "../events/eventCatalog.js";
import { EventLog } from "../events/eventLog.js";
import { ResponseHooks } from "../hooks/responseHooks.js";
import { gameEventDefinitions } from "../protocol/gameEvent.js";
import { openDatabase } from "../storage/database.js";
import { JsonLineDecoder } from "../transport/jsonLines.js";
import { RpcPeer } from "../transport/rpcPeer.js";
import { sendProviderResponse } from "../../tests/pi/localProvider.mjs";

const tools = [
  "get_game_state",
  "send_message",
  "list_event_types",
  "get_recent_events",
  "add_response_hook",
  "remove_response_hook",
  "list_response_hooks",
].sort();
const apis = ["openai-completions", "openai-responses", "anthropic-messages"];
const snapshot = JSON.parse(
  readFileSync(new URL("../../tests/fixtures/protocol/gameSnapshot.json", import.meta.url), "utf8"),
);
const extension = fileURLToPath(new URL("../../dist/directorBridge.mjs", import.meta.url));
const scope = { worldId: "scratch-world", playerId: "scratch-player" };

function texts(value) {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(texts);
}

async function fixture(api, options = {}) {
  const version = spawnSync("pi", ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, `Pi preflight failed: ${version.error ?? version.stderr}`);
  assert.equal(version.stdout.trim(), "1.2.0");
  const folder = mkdtempSync(join(tmpdir(), "mc-hisyo-built-pi-"));
  for (const name of ["home", "cwd", "agent", "sessions", "tmp"])
    mkdirSync(join(folder, name), { mode: 0o700 });
  writeFileSync(
    join(folder, "agent", "settings.json"),
    JSON.stringify({ compaction: { enabled: false }, cacheWarming: "off" }),
    { mode: 0o600 },
  );
  const promptPath = join(folder, "system.md");
  writeFileSync(
    promptPath,
    "You are a single-player game director. Only send_message speaks in game.\n",
    {
      mode: 0o600,
    },
  );
  let db;
  let bridge;
  let game;
  let server;
  let child;
  let closed;
  let httpError;
  let stderr = "";
  const records = [];
  const requests = [];
  // Register before acquiring handles so a failed setup cannot leak listeners or SQLite.
  onTestFinished(async () => {
    let exit;
    if (child) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      exit = await closed;
      clearTimeout(timer);
    }
    game?.close();
    await bridge?.close();
    db?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    writeFileSync(join(folder, "rpc.json"), JSON.stringify(records, null, 2), { mode: 0o600 });
    writeFileSync(join(folder, "stderr.txt"), stderr, { mode: 0o600 });
    writeFileSync(join(folder, "http.json"), JSON.stringify(requests, null, 2), { mode: 0o600 });
    if (exit) expect(exit).toEqual({ code: 0, signal: null });
    if (httpError) throw httpError;
  });
  db = openDatabase(":memory:");
  const catalog = new EventCatalog(gameEventDefinitions);
  const eventLog = new EventLog(db, catalog);
  const hooks = new ResponseHooks(db, catalog);
  const token = randomBytes(32).toString("base64url");
  bridge = new DirectorBridge({ token, eventLog, hooks });
  let agentReady = false;
  bridge.on("agentReady", () => {
    agentReady = true;
  });
  const address = await bridge.listen();
  const socket = createConnection(address);
  await once(socket, "connect");
  game = new RpcPeer(socket);
  const stateRequests = [];
  const displays = [];
  game.handle("game.run.bind", (binding) => binding);
  game.handle("game.run.clear", () => {});
  game.handle("game.message.send", (params) => {
    displays.push(params.text);
    const { text: _text, ...binding } = params;
    return { ...binding, displayed: true };
  });
  game.handle("game.state.get", async (params) => {
    stateRequests.push(params);
    const state = { ...snapshot, tick: 120 + stateRequests.length };
    const { query: _query, ...binding } = params;
    if (options.state)
      return options.state({ binding, state, number: stateRequests.length, bridge, game, world });
    return { ...binding, state };
  });
  await game.call("bridge.hello", { protocolVersion: 1, role: "game", token });
  const world = await game.call("game.attach", {
    ...scope,
    supportedEvents: ["block_broken"],
    paused: false,
  });
  await game.call("game.ready", world);
  await game.call("game.event", {
    ...world,
    event: "block_broken",
    seq: 1,
    tick: 1,
    observedAt: 1,
    dimension: "minecraft:overworld",
    position: [0, 64, 0],
    data: { blockId: "minecraft:stone", position: [0, 64, 1] },
  });
  server = createServer(async (req, res) => {
    try {
      // No proxy and no remote endpoint: only this disposable loopback server is advertised.
      assert.equal(
        req.url,
        api === "anthropic-messages"
          ? "/v1/messages?beta=true"
          : api === "openai-responses"
            ? "/v1/responses"
            : "/v1/chat/completions",
      );
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);
      const names = body.tools.map((tool) => tool.function?.name ?? tool.name).sort();
      assert.deepEqual(names, tools);
      const toolCalls = options.plan
        ? options.plan(body, requests.length)
        : requests.length === 1
          ? [{ id: "call_message", name: "send_message", arguments: { text: "explicit display" } }]
          : [];
      sendProviderResponse(res, { api, toolCalls, text: "This text must never display in game." });
    } catch (error) {
      httpError = error;
      if (res.headersSent) res.destroy();
      else res.writeHead(500).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(
    join(folder, "agent", "models.json"),
    JSON.stringify({
      providers: {
        "scratch-local": {
          api,
          baseUrl: `${origin}${api === "anthropic-messages" ? "" : "/v1"}`,
          apiKey: "dummy-local-key",
          models: [
            {
              id: "dummy-model",
              name: "Local dummy only",
              reasoning: true,
              input: ["text"],
              contextWindow: 32768,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              compat: { supportsDeveloperRole: false, supportsStore: false },
            },
          ],
        },
      },
    }),
    { mode: 0o600 },
  );
  const env = {
    PATH: process.env.PATH,
    HOME: join(folder, "home"),
    TMPDIR: join(folder, "tmp"),
    PI_CODING_AGENT_DIR: join(folder, "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(folder, "sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    PI_TEST_ORIGIN: origin,
    PI_TEST_API: api,
    MC_HISYO_BRIDGE: JSON.stringify({
      ...address,
      protocolVersion: 1,
      token,
      ...options.bootstrap,
    }),
  };
  const waiters = new Set();
  let nextId = 0;
  function waitFor(predicate) {
    const check = () => records.find(predicate);
    if (check()) return Promise.resolve(check());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(update);
        reject(new Error(`Pi boundary timeout; logs: ${folder}; stderr: ${stderr}`));
      }, 10_000);
      const update = () => {
        const found = check();
        if (found) {
          clearTimeout(timer);
          waiters.delete(update);
          resolve(found);
        }
      };
      waiters.add(update);
    });
  }
  const ready = once(bridge, "agentReady", { signal: AbortSignal.timeout(3_000) });
  // Observe rejection immediately even when an intentionally denied startup is tested later.
  void ready.catch(() => {});
  child = spawn(
    "pi",
    [
      "--mode",
      "rpc",
      "--offline",
      "--no-extensions",
      "--extension",
      extension,
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
      tools.join(","),
      "--session-dir",
      join(folder, "sessions"),
      "--model",
      "scratch-local/dummy-model",
      "--thinking",
      "medium",
      "--api-key",
      "dummy-local-key",
    ],
    { cwd: join(folder, "cwd"), env, stdio: ["pipe", "pipe", "pipe"] },
  );
  closed = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const decoder = new JsonLineDecoder();
  child.stdout.on("data", (chunk) =>
    decoder.push(chunk, (line) => {
      records.push(JSON.parse(line));
      for (const waiter of waiters) waiter();
    }),
  );
  child.stdout.on("end", () => decoder.finish());
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  async function rpc(type, data = {}) {
    const id = `request-${++nextId}`;
    const response = waitFor((r) => r.type === "response" && r.id === id);
    child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
    const result = await response;
    assert.equal(result.success, true, JSON.stringify(result));
    return result.data;
  }
  async function prompt() {
    const startIndex = records.length;
    const settled = waitFor((r) => records.indexOf(r) >= startIndex && r.type === "agent_settled");
    const ack = await rpc("prompt", { message: "Inspect current play and decide." });
    assert.equal(ack.disposition, "started", "Prompt ACK is not completion");
    return settled;
  }
  async function run() {
    const run = await bridge.beginRun();
    const result = await prompt();
    bridge.finishRun(run);
    return result;
  }
  return {
    ready,
    get agentReady() {
      return agentReady;
    },
    rpc,
    prompt,
    run,
    bridge,
    game,
    world,
    hooks,
    requests,
    stateRequests,
    displays,
    records,
    folder,
  };
}

for (const api of apis) {
  test(`${api}: built tools and fresh transient state, explicit display only, then another bound run`, async () => {
    const f = await fixture(api);
    await f.ready;
    const state = await f.rpc("get_state");
    expect(state.model.api).toBe(api);
    expect(state.thinkingLevel).toBe("medium");
    expect(state.autoCompactionEnabled).toBe(false);
    expect((await f.run()).aborted).toBe(false);
    expect(f.requests).toHaveLength(2);
    expect(f.displays).toEqual(["explicit display"]);
    expect(f.stateRequests).toHaveLength(2);
    for (const [index, body] of f.requests.entries()) {
      const current = texts(body).filter((text) => text.startsWith("CURRENT_GAME_STATE\n"));
      expect(current).toHaveLength(1);
      expect(JSON.parse(current[0].slice("CURRENT_GAME_STATE\n".length)).tick).toBe(121 + index);
    }
    expect(JSON.stringify(await f.rpc("get_messages"))).not.toContain("CURRENT_GAME_STATE");
    expect((await f.run()).aborted).toBe(false);
    expect(f.requests).toHaveLength(3);
    expect(f.stateRequests).toHaveLength(3);
    expect(f.stateRequests[2].runId).not.toBe(f.stateRequests[0].runId);
    expect(f.displays).toHaveLength(1);
  });

  test(`${api}: seven bundled tools execute CRUD/history and reject scope injection`, async () => {
    let hookId;
    const f = await fixture(api, {
      plan(body, number) {
        if (number === 1)
          return [
            { id: "types", name: "list_event_types", arguments: {} },
            {
              id: "history",
              name: "get_recent_events",
              arguments: { query: { event: "block_broken", limit: 1 } },
            },
            { id: "state", name: "get_game_state", arguments: { query: {} } },
            {
              id: "add",
              name: "add_response_hook",
              arguments: {
                event: "block_broken",
                filter: { blockId: "minecraft:stone" },
                instruction: "Inspect progress",
              },
            },
          ];
        if (number === 2) {
          const outputs = texts(body)
            .filter((text) => text.startsWith("{"))
            .map((text) => JSON.parse(text));
          const added = outputs.find(
            (value) => value.instruction === "Inspect progress" && value.id,
          );
          assert.ok(added, "Persisted hook result must reach the model");
          hookId = added.id;
          const history = outputs.find(
            (value) => value.through === 1 && Array.isArray(value.events),
          );
          assert.equal(history.events.length, 1);
          assert.equal(history.events[0].observation.data.blockId, "minecraft:stone");
          return [
            { id: "list", name: "list_response_hooks", arguments: { limit: 8 } },
            { id: "remove", name: "remove_response_hook", arguments: { id: hookId } },
            {
              id: "invalid",
              name: "send_message",
              arguments: { text: "must not display", worldId: "injected" },
            },
            { id: "display", name: "send_message", arguments: { text: "explicit display" } },
          ];
        }
        return [];
      },
    });
    await f.ready;
    expect((await f.run()).aborted).toBe(false);
    expect(f.requests).toHaveLength(3);
    expect(f.stateRequests).toHaveLength(4);
    expect(f.displays).toEqual(["explicit display"]);
    expect(f.hooks.list(scope).hooks).toEqual([]);
    expect(f.records.filter((r) => r.type === "tool_execution_end" && r.isError)).toHaveLength(1);
  });
}

for (const [name, bootstrap] of Object.entries({
  "missing token": { token: undefined },
  "invalid token": { token: "A".repeat(43) },
  "non-loopback host": { host: "127.0.0.2" },
  "wrong protocol": { protocolVersion: 2 },
  "unknown field": { pid: 1 },
})) {
  test(`startup rejects ${name} and later prompts stay closed`, async () => {
    const f = await fixture("openai-completions", { bootstrap });
    await f.rpc("get_state"); // Stdio attaches only after session_start has finished.
    expect(f.agentReady).toBe(false);
    await expect(f.bridge.beginRun()).rejects.toThrow();
    expect((await f.prompt()).aborted).toBe(true);
    expect(f.requests).toEqual([]);
    expect(f.stateRequests).toEqual([]);
    expect(f.displays).toEqual([]);
  });
}

for (const scenario of [
  "missing-first",
  "missing-second",
  "stale",
  "pause",
  "detach",
  "disconnect",
  "timeout",
]) {
  test(`required state failure ${scenario}: no subsequent model call or side effect`, async () => {
    const f = await fixture("openai-completions", {
      async state({ binding, state, number, game, world }) {
        if (scenario === "missing-first" || (scenario === "missing-second" && number === 2))
          return { ...binding, state: {} };
        if (scenario === "stale") return { ...binding, runId: "stale", state };
        if (scenario === "pause") await game.call("game.status", { ...world, paused: true });
        if (scenario === "detach") await game.call("game.detach", world);
        if (scenario === "disconnect") game.close();
        if (scenario === "timeout") return new Promise(() => {});
        return { ...binding, state };
      },
    });
    await f.ready;
    expect((await f.run()).aborted).toBe(true);
    expect(f.requests).toHaveLength(scenario === "missing-second" ? 1 : 0);
    expect(f.displays).toEqual(scenario === "missing-second" ? ["explicit display"] : []);
    // An idle abort is not a persistent guard: a deliberately attempted later prompt must also fail closed.
    expect((await f.prompt()).aborted).toBe(true);
    expect(f.requests).toHaveLength(scenario === "missing-second" ? 1 : 0);
    expect(f.displays).toEqual(scenario === "missing-second" ? ["explicit display"] : []);
  });
}

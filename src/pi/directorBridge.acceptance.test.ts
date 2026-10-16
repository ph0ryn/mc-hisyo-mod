import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { expect, onTestFinished, test } from "vite-plus/test";
import { DirectorBridge } from "../bridge/directorBridge.js";
import { EventCatalog } from "../events/eventCatalog.js";
import { EventLog } from "../events/eventLog.js";
import { ResponseHooks } from "../hooks/responseHooks.js";
import {
  GameStateRequestSchema,
  SendMessageSchema,
  WorldBindingSchema,
  type RunBinding,
  type WorldBinding,
} from "../protocol/bridge.js";
import { gameEventDefinitions } from "../protocol/gameEvent.js";
import { GameSnapshotSchema, type GameSnapshot } from "../protocol/gameSnapshot.js";
import { openDatabase } from "../storage/database.js";
import { JsonLineDecoder } from "../transport/jsonLines.js";
import { RpcPeer } from "../transport/rpcPeer.js";
import { startPiSession } from "../runtime/piSession.js";
import {
  sendProviderResponse,
  type ProviderApi,
  type ProviderToolCall,
} from "./fixtures/localProvider.mjs";
import { startPiRpcClient } from "./piRpcClient.js";

type PiDriver = Awaited<ReturnType<typeof startPiRpcClient>>;
type PiSession = Awaited<ReturnType<typeof startPiSession>>;
type ProcessExit = { code: number | null; signal: NodeJS.Signals | null };
const requestSchema = Type.Object({
  tools: Type.Array(
    Type.Object({
      function: Type.Optional(Type.Object({ name: Type.String() })),
      name: Type.Optional(Type.String()),
    }),
  ),
});
const recordSchema = Type.Object({
  type: Type.String(),
  id: Type.Optional(Type.String()),
  success: Type.Optional(Type.Boolean()),
  data: Type.Optional(Type.Unknown()),
  aborted: Type.Optional(Type.Boolean()),
  isError: Type.Optional(Type.Boolean()),
});
type PiRecord = Static<typeof recordSchema>;
const stateSchema = Type.Object({
  model: Type.Object({ api: Type.String() }),
  thinkingLevel: Type.String(),
  autoCompactionEnabled: Type.Boolean(),
});
const promptSchema = Type.Object({ disposition: Type.String() });
interface FixtureOptions {
  session?: boolean;
  driver?: boolean;
  thinking?: string;
  expectedModel?: string;
  bootstrap?: Record<string, unknown>;
  plan?: (body: Static<typeof requestSchema>, number: number) => ProviderToolCall[];
  // Failure scenarios deliberately return malformed or stale state responses.
  state?: (context: {
    binding: RunBinding;
    state: GameSnapshot;
    number: number;
    bridge: DirectorBridge;
    game: RpcPeer;
    world: WorldBinding;
  }) => unknown;
}

const tools = [
  "get_game_state",
  "send_message",
  "list_event_types",
  "get_recent_events",
  "add_response_hook",
  "remove_response_hook",
  "list_response_hooks",
].sort();
const apis: ProviderApi[] = ["openai-completions", "openai-responses", "anthropic-messages"];
const snapshot = (() => {
  const value: unknown = JSON.parse(
    readFileSync(new URL("../protocol/fixtures/gameSnapshot.json", import.meta.url), "utf8"),
  );
  assert.ok(Check(GameSnapshotSchema, value));
  return value;
})();
const extension = fileURLToPath(new URL("../../dist/directorBridge.mjs", import.meta.url));
const scope = { worldId: "scratch-world", playerId: "scratch-player" };

function texts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(texts);
}

async function fixture(api: ProviderApi, options: FixtureOptions = {}) {
  if (!options.session) {
    const version = spawnSync("pi", ["--version"], { encoding: "utf8" });
    assert.equal(version.status, 0, `Pi preflight failed: ${version.error ?? version.stderr}`);
    assert.equal(version.stdout.trim(), "1.2.0");
  }
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
  const owned: {
    db?: ReturnType<typeof openDatabase>;
    bridge?: DirectorBridge;
    game?: RpcPeer;
    server?: ReturnType<typeof createServer>;
  } = {};
  let child: ChildProcessWithoutNullStreams | undefined;
  let driver: PiDriver | undefined;
  let session: PiSession | undefined;
  let closed: Promise<ProcessExit> | undefined;
  let httpError: unknown;
  let stderr = "";
  const records: PiRecord[] = [];
  const requests: Static<typeof requestSchema>[] = [];
  // Register before acquiring handles so a failed setup cannot leak listeners or SQLite.
  onTestFinished(async () => {
    let exit: ProcessExit | undefined;
    if (session) {
      await session.close();
      stderr = session.diagnostics;
    }
    if (driver) {
      await driver.close();
      stderr = driver.diagnostics;
    }
    if (child) {
      const running = child;
      running.stdin.end();
      const timer = setTimeout(() => running.kill("SIGKILL"), 2_000);
      exit = await closed;
      clearTimeout(timer);
    }
    owned.game?.close();
    await owned.bridge?.close();
    owned.db?.close();
    if (owned.server) {
      const server = owned.server;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    writeFileSync(join(folder, "rpc.json"), JSON.stringify(records, null, 2), { mode: 0o600 });
    writeFileSync(join(folder, "stderr.txt"), stderr, { mode: 0o600 });
    writeFileSync(join(folder, "http.json"), JSON.stringify(requests, null, 2), { mode: 0o600 });
    if (exit) expect(exit).toEqual({ code: 0, signal: null });
    if (httpError) throw httpError;
  });
  const db = (owned.db = openDatabase(":memory:"));
  const catalog = new EventCatalog(gameEventDefinitions);
  const eventLog = new EventLog(db, catalog);
  const hooks = new ResponseHooks(db, catalog);
  const token = randomBytes(32).toString("base64url");
  const bridge = (owned.bridge = new DirectorBridge({ token, eventLog, hooks }));
  let agentReady = false;
  bridge.on("agentReady", () => {
    agentReady = true;
  });
  bridge.on("peerClosed", (role) => {
    if (role === "agent") agentReady = false;
  });
  const address = await bridge.listen();
  const socket = createConnection(address);
  await once(socket, "connect");
  const game = (owned.game = new RpcPeer(socket));
  const stateRequests: Static<typeof GameStateRequestSchema>[] = [];
  const displays: string[] = [];
  game.handle("game.run.bind", (binding) => binding);
  game.handle("game.run.clear", () => {});
  game.handle("game.message.send", (params) => {
    assert.ok(Check(SendMessageSchema, params));
    displays.push(params.text);
    const { text: _text, ...binding } = params;
    return { ...binding, displayed: true };
  });
  game.handle("game.state.get", async (params) => {
    assert.ok(Check(GameStateRequestSchema, params));
    stateRequests.push(params);
    const state = { ...snapshot, tick: 120 + stateRequests.length };
    const { query: _query, ...binding } = params;
    if (options.state)
      return options.state({ binding, state, number: stateRequests.length, bridge, game, world });
    return { ...binding, state };
  });
  await game.call("bridge.hello", { protocolVersion: 1, role: "game", token });
  const attached = await game.call("game.attach", {
    ...scope,
    supportedEvents: ["block_broken"],
    paused: false,
  });
  assert.ok(Check(WorldBindingSchema, attached));
  const world = attached;
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
  const server = (owned.server = createServer(async (req, res) => {
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
      if (options.session)
        assert.equal(
          req.headers[api === "anthropic-messages" ? "x-api-key" : "authorization"],
          `${api === "anthropic-messages" ? "" : "Bearer "}!inert-$local-key`,
        );
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.ok(Check(requestSchema, body));
      requests.push(body);
      const names = body.tools
        .map((tool) => {
          const name = tool.function?.name ?? tool.name;
          assert.ok(typeof name === "string");
          return name;
        })
        .sort();
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
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const providerAddress = server.address();
  assert.ok(providerAddress && typeof providerAddress === "object");
  const origin = `http://127.0.0.1:${providerAddress.port}`;
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
  const waiters = new Set<() => void>();
  let nextId = 0;
  function waitFor(predicate: (record: PiRecord) => boolean): Promise<PiRecord> {
    const check = () => records.find(predicate);
    const prior = check();
    if (prior) return Promise.resolve(prior);
    return new Promise<PiRecord>((resolve, reject) => {
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
  const args = [
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
    options.thinking ?? "medium",
    "--api-key",
    "dummy-local-key",
  ];
  async function startSession(binding: WorldBinding = world) {
    session = await startPiSession({
      dataDirectory: join(folder, "data"),
      bridge,
      world: binding,
      connection: { ...address, protocolVersion: 1, token, pid: process.pid },
      executable: "pi",
      bundledExtension: extension,
      model: {
        provider: "scratch-local",
        id: "dummy-model",
        api,
        baseUrl: `${origin}${api === "anthropic-messages" ? "" : "/v1"}`,
        apiKey: "!inert-$local-key",
        definition: {
          name: "Local dummy only",
          reasoning: true,
          input: ["text"],
          contextWindow: 32768,
          maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      },
    });
    return session;
  }
  if (options.session) {
    await startSession();
  } else if (options.driver) {
    driver = await startPiRpcClient({
      executable: "pi",
      args,
      cwd: join(folder, "cwd"),
      env,
      model: { provider: "scratch-local", id: options.expectedModel ?? "dummy-model", api },
      isAgentReady: () => agentReady,
    });
    driver.on("fault", () => bridge.invalidateRun("Pi stdio driver failed"));
  } else {
    const running = (child = spawn("pi", args, {
      cwd: join(folder, "cwd"),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }));
    closed = new Promise<ProcessExit>((resolve) =>
      running.once("close", (code, signal) => resolve({ code, signal })),
    );
    const decoder = new JsonLineDecoder();
    child.stdout.on("data", (chunk: Buffer) =>
      decoder.push(chunk, (line) => {
        const record: unknown = JSON.parse(line);
        assert.ok(Check(recordSchema, record));
        records.push(record);
        for (const waiter of waiters) waiter();
      }),
    );
    child.stdout.on("end", () => decoder.finish());
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
  }
  async function rpc<S extends TSchema>(
    type: string,
    schema: S,
    data: Record<string, unknown> = {},
  ): Promise<Static<S>> {
    const id = `request-${++nextId}`;
    const response = waitFor((r) => r.type === "response" && r.id === id);
    assert.ok(child);
    child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
    const result = await response;
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(Check(schema, result.data));
    return result.data;
  }
  async function prompt() {
    const startIndex = records.length;
    const settled = waitFor((r) => records.indexOf(r) >= startIndex && r.type === "agent_settled");
    const ack = await rpc("prompt", promptSchema, { message: "Inspect current play and decide." });
    assert.equal(ack.disposition, "started", "Prompt ACK is not completion");
    const result = await settled;
    assert.ok(typeof result.aborted === "boolean");
    return { ...result, aborted: result.aborted };
  }
  async function run(message = "Inspect current play and decide.") {
    if (session) {
      const result = await session.judge(message);
      assert.ok(result.status === "settled");
      return result;
    }
    const run = await bridge.beginRun();
    try {
      if (!driver) return await prompt();
      const result = await driver.run("Inspect current play and decide.");
      assert.ok(result.status === "settled");
      return result;
    } catch (error) {
      // Unknown-started failures are not a reusable bridge slot until the child is terminated.
      if (driver) await driver.close();
      throw error;
    } finally {
      bridge.finishRun(run);
    }
  }
  return {
    ready,
    get driver() {
      assert.ok(driver);
      return driver;
    },
    get session() {
      assert.ok(session);
      return session;
    },
    startSession,
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
  test(`${api}: isolated owner resumes real Pi only within the world/player scope`, async () => {
    const f = await fixture(api, { session: true, plan: () => [] });
    const firstPath = f.session.sessionPath;
    const sentinel = "remember-private-world-player-7b81";
    expect(await f.run(sentinel)).toEqual({ status: "settled", aborted: false });
    expect(f.requests).toHaveLength(1);
    expect(readFileSync(firstPath, "utf8")).toContain(sentinel);
    const saved = readFileSync(firstPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(texts(saved).filter((text) => text.startsWith("CURRENT_GAME_STATE\n"))).toEqual([]);
    await f.session.close();
    await f.game.call("game.detach", f.world);
    const reattached = await f.game.call("game.attach", {
      ...scope,
      supportedEvents: ["block_broken"],
      paused: false,
    });
    assert.ok(Check(WorldBindingSchema, reattached));
    await f.game.call("game.ready", reattached);
    await f.startSession(reattached);
    expect(f.session.sessionPath).toBe(firstPath);
    await f.game.call("game.status", { ...reattached, paused: true });
    await expect(f.run("Do not run paused")).rejects.toThrow();
    expect(f.session.isRetired).toBe(false);
    expect(f.requests).toHaveLength(1);
    await f.game.call("game.status", { ...reattached, paused: false });
    expect(await f.run("Continue this conversation")).toEqual({
      status: "settled",
      aborted: false,
    });
    expect(texts(f.requests[1])).toContain(sentinel);
    const current = texts(f.requests[1]).filter((text) => text.startsWith("CURRENT_GAME_STATE\n"));
    expect(current).toHaveLength(1);
    assert.ok(current[0]);
    expect(JSON.parse(current[0].slice("CURRENT_GAME_STATE\n".length)).tick).toBe(122);
    assert.ok(f.stateRequests[1] && f.stateRequests[0]);
    expect(f.stateRequests[1].runId).not.toBe(f.stateRequests[0].runId);
    await f.session.close();
    await f.game.call("game.detach", reattached);
    const other = await f.game.call("game.attach", {
      ...scope,
      playerId: "other-player",
      supportedEvents: [],
      paused: false,
    });
    assert.ok(Check(WorldBindingSchema, other));
    await f.game.call("game.ready", other);
    await f.startSession(other);
    expect(f.session.sessionPath).not.toBe(firstPath);
    expect(await f.run("Separate player")).toEqual({ status: "settled", aborted: false });
    expect(JSON.stringify(f.requests[2])).not.toContain(sentinel);
    expect(f.displays).toEqual([]);
  });

  test(`${api}: stdio driver gates actual Pi and completes two scoped judgments`, async () => {
    const f = await fixture(api, { driver: true });
    await f.ready;
    expect(await f.run()).toEqual({ status: "settled", aborted: false });
    expect(f.requests).toHaveLength(2);
    expect(f.displays).toEqual(["explicit display"]);
    expect(await f.run()).toEqual({ status: "settled", aborted: false });
    expect(f.requests).toHaveLength(3);
    expect(f.stateRequests).toHaveLength(3);
    assert.ok(f.stateRequests[2] && f.stateRequests[0]);
    expect(f.stateRequests[2].runId).not.toBe(f.stateRequests[0].runId);
    expect(f.displays).toHaveLength(1);
    expect(f.driver.isRetired).toBe(false);
  });

  for (const [gate, options] of Object.entries({
    model: { expectedModel: "wrong-model" },
    medium: { thinking: "low" },
  })) {
    test(`${api}: stdio driver ${gate} refusal makes zero provider calls`, async () => {
      const f = await fixture(api, { driver: true, ...options });
      await f.ready;
      await expect(f.run()).rejects.toMatchObject({ mayHaveStarted: false });
      expect(f.requests).toHaveLength(0);
      expect(f.stateRequests).toHaveLength(0);
      expect(f.displays).toHaveLength(0);
      expect(f.driver.isRetired).toBe(true);
    });
  }

  test(`${api}: built tools and fresh transient state, explicit display only, then another bound run`, async () => {
    const f = await fixture(api);
    await f.ready;
    const state = await f.rpc("get_state", stateSchema);
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
      assert.ok(current[0]);
      expect(JSON.parse(current[0].slice("CURRENT_GAME_STATE\n".length)).tick).toBe(121 + index);
    }
    expect(JSON.stringify(await f.rpc("get_messages", Type.Unknown()))).not.toContain(
      "CURRENT_GAME_STATE",
    );
    expect((await f.run()).aborted).toBe(false);
    expect(f.requests).toHaveLength(3);
    expect(f.stateRequests).toHaveLength(3);
    assert.ok(f.stateRequests[2] && f.stateRequests[0]);
    expect(f.stateRequests[2].runId).not.toBe(f.stateRequests[0].runId);
    expect(f.displays).toHaveLength(1);
  });

  test(`${api}: seven bundled tools execute CRUD/history and reject scope injection`, async () => {
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
            .map((text): unknown => JSON.parse(text));
          const addedSchema = Type.Object({ instruction: Type.String(), id: Type.String() });
          const added = outputs.find(
            (value) =>
              Check(addedSchema, value) && value.instruction === "Inspect progress" && value.id,
          );
          assert.ok(added, "Persisted hook result must reach the model");
          assert.ok(Check(addedSchema, added));
          const hookId = added.id;
          const historySchema = Type.Object({
            through: Type.Number(),
            events: Type.Array(
              Type.Object({
                observation: Type.Object({ data: Type.Object({ blockId: Type.String() }) }),
              }),
            ),
          });
          const history = outputs.find(
            (value) =>
              Check(historySchema, value) && value.through === 1 && Array.isArray(value.events),
          );
          assert.ok(Check(historySchema, history));
          assert.equal(history.events.length, 1);
          const [firstEvent] = history.events;
          assert.ok(firstEvent);
          assert.equal(firstEvent.observation.data.blockId, "minecraft:stone");
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
    await f.rpc("get_state", stateSchema); // Stdio attaches only after session_start has finished.
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

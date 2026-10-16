import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished, vi } from "vite-plus/test";
import { DirectorBridge } from "../../bridge/directorBridge.js";
import { EventCatalog } from "../../events/eventCatalog.js";
import { EventLog } from "../../events/eventLog.js";
import { ResponseHooks } from "../../hooks/responseHooks.js";
import type { WorldBinding } from "../../protocol/bridge.js";
import { gameEventDefinitions } from "../../protocol/gameEvent.js";
import { openDatabase } from "../../storage/database.js";
import { RpcPeer } from "../../transport/rpcPeer.js";
import { startPiSession } from "../piSession.js";

/** Actual game TCP peer, SQLite history and executable Pi fixture; no provider calls. */
export async function piFixture(config: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mc-hisyo-session-"));
  const capture = join(directory, "capture.jsonl");
  const control = join(directory, "control");
  const configFile = join(directory, "fake.json");
  writeFileSync(capture, "");
  writeFileSync(control, "");
  writeFileSync(
    configFile,
    JSON.stringify({ capture, control, bridge: true, mode: "auto", ...config }),
  );
  const db = openDatabase(":memory:");
  const catalog = new EventCatalog(gameEventDefinitions);
  const token = randomBytes(32).toString("base64url");
  const eventLog = new EventLog(db, catalog);
  const hooks = new ResponseHooks(db, catalog);
  const bridge = new DirectorBridge({ token, eventLog, hooks });
  const sessions: Awaited<ReturnType<typeof startPiSession>>[] = [];
  let game: RpcPeer | undefined;
  onTestFinished(async () => {
    await Promise.all(sessions.map((session) => session.close()));
    game?.close();
    await bridge.close();
    db.close();
    vi.unstubAllEnvs();
  });
  const address = await bridge.listen();
  const socket = createConnection(address);
  await once(socket, "connect");
  game = new RpcPeer(socket);
  let bind: (params: unknown) => unknown = (params) => params;
  game.handle("game.run.bind", (params) => bind(params));
  game.handle("game.run.clear", () => {});
  await game.call("bridge.hello", { protocolVersion: 1, role: "game", token });
  const world = (await game.call("game.attach", {
    worldId: "world-a",
    playerId: "player-a",
    supportedEvents: [],
    paused: false,
  })) as WorldBinding;
  await game.call("game.ready", world);
  const options = {
    dataDirectory: join(directory, "data"),
    bridge,
    world,
    connection: { ...address, protocolVersion: 1 as const, token, pid: process.pid },
    executable: process.execPath,
    bundledExtension: fileURLToPath(new URL("../../../dist/directorBridge.mjs", import.meta.url)),
    prefixArgs: [
      fileURLToPath(new URL("../../pi/fixtures/fakePi.mjs", import.meta.url)),
      "--fixture",
      configFile,
    ],
    model: {
      provider: "local",
      id: "director",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9",
      apiKey: "!inert-$credential",
      definition: {
        name: "Fixture only",
        reasoning: true,
        input: ["text"] as ("text" | "image")[],
        contextWindow: 32768,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    },
    requestTimeoutMs: 500,
    judgmentTimeoutMs: 2_000,
    shutdownTimeoutMs: 50,
    readyTimeoutMs: 1_000,
  };
  async function start(overrides: Partial<typeof options> = {}) {
    const session = await startPiSession({ ...options, ...overrides });
    sessions.push(session);
    return session;
  }
  return {
    options,
    directory,
    bridge,
    game,
    world,
    hooks,
    eventLog,
    start,
    setBind: (handler: typeof bind) => {
      bind = handler;
    },
    configure: (change: Record<string, unknown>) =>
      writeFileSync(
        configFile,
        JSON.stringify({ capture, control, bridge: true, mode: "auto", ...change }),
      ),
    records: () => readFileSync(capture, "utf8"),
    send: (command: string) => appendFileSync(control, `${command}\n`),
  };
}

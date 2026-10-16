import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { DirectorBridge } from "./directorBridge.js";
import { EventCatalog } from "../events/eventCatalog.js";
import { EventLog } from "../events/eventLog.js";
import { ResponseHooks } from "../hooks/responseHooks.js";
import type { RunBinding, WorldBinding } from "../protocol/bridge.js";
import { gameEventDefinitions } from "../protocol/gameEvent.js";
import type { GameSnapshot } from "../protocol/gameSnapshot.js";
import { openDatabase } from "../storage/database.js";
import { defaultMaxFrameBytes, encodeJsonLine } from "../transport/jsonLines.js";
import { RpcPeer } from "../transport/rpcPeer.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const scope = { worldId: "world-a", playerId: "player-a" };
const attachParams = { ...scope, supportedEvents: ["block_broken"], paused: false };
const snapshot = JSON.parse(
  readFileSync(new URL("../../tests/fixtures/protocol/gameSnapshot.json", import.meta.url), "utf8"),
) as GameSnapshot;

async function fixture() {
  const db = openDatabase(":memory:");
  const catalog = new EventCatalog(gameEventDefinitions);
  const eventLog = new EventLog(db, catalog);
  const hooks = new ResponseHooks(db, catalog);
  const token = randomBytes(32).toString("base64url");
  const bridge = new DirectorBridge({ token, eventLog, hooks });
  const address = await bridge.listen();
  const clients: RpcPeer[] = [];
  cleanup.push(async () => {
    for (const peer of clients) peer.close();
    await bridge.close();
    db.close();
  });
  async function connect(role?: "game" | "agent") {
    const socket = createConnection(address);
    await once(socket, "connect");
    const peer = new RpcPeer(socket);
    clients.push(peer);
    if (role) {
      peer.handle(role === "game" ? "game.run.bind" : "director.run.bind", (params) => params);
      if (role === "game") peer.handle("game.run.clear", () => {});
      await peer.call("bridge.hello", { protocolVersion: 1, role, token });
      if (role === "agent") await peer.call("director.ready", {});
    }
    return peer;
  }
  async function attach(game: RpcPeer, params = attachParams) {
    const binding = (await game.call("game.attach", params)) as WorldBinding;
    await game.call("game.ready", binding);
    return binding;
  }
  return { bridge, eventLog, hooks, token, connect, attach };
}

function observation(binding: WorldBinding, seq = 1) {
  return {
    ...binding,
    seq,
    tick: 10,
    observedAt: 1000 + seq,
    event: "block_broken",
    dimension: "minecraft:overworld",
    position: [0, 64, 0],
    data: { blockId: "minecraft:stone", position: [1, 64, 0] },
  };
}

describe("authenticated director bridge over real TCP", () => {
  test("rejects unauthenticated and wrong-role operations; bad credentials close without a session", async () => {
    const f = await fixture();
    const stranger = await f.connect();
    await expect(stranger.call("game.attach", attachParams)).rejects.toMatchObject({
      code: -32010,
    });
    for (const hello of [
      { protocolVersion: 1, role: "game", token: "x".repeat(43) },
      { protocolVersion: 2, role: "game", token: f.token },
      { protocolVersion: 1, role: "unknown", token: f.token },
      { protocolVersion: 1, role: "game", token: f.token, extra: true },
    ]) {
      const invalid = await f.connect();
      await expect(invalid.call("bridge.hello", hello)).rejects.toThrow();
      expect(invalid.isClosed).toBe(true);
      expect(f.bridge.currentWorld).toBeUndefined();
    }
    const agent = await f.connect("agent");
    await expect(agent.call("game.attach", attachParams)).rejects.toMatchObject({ code: -32010 });
    const game = await f.connect("game");
    const duplicate = await f.connect();
    await expect(
      duplicate.call("bridge.hello", { protocolVersion: 1, role: "game", token: f.token }),
    ).rejects.toMatchObject({ code: -32002 });
    expect((await f.attach(game)).worldSessionId).toEqual(expect.any(String));
  });

  test("persists every observation before hook delivery and exposes only advertised capabilities", async () => {
    const f = await fixture();
    const game = await f.connect("game");
    const world = await f.attach(game);
    const agent = await f.connect("agent");
    const run = await f.bridge.beginRun();
    const hook = (await agent.call("director.hooks.add", {
      ...run,
      event: "block_broken",
      filter: { blockId: "minecraft:stone" },
      instruction: "Inspect progress",
    })) as { id: string };
    const delivered = once(f.bridge, "observation");
    game.notify("game.event", observation(world));
    const [stored, matched] = await delivered;
    expect(stored.observation).toEqual(observation(world));
    expect(matched).toEqual([expect.objectContaining({ id: hook.id })]);
    expect(f.eventLog.search(scope).events).toHaveLength(1);
    expect(await agent.call("director.events.get", { ...run, query: {} })).toMatchObject({
      events: [expect.objectContaining({ observation: observation(world) })],
      hasKnownGaps: false,
    });
    expect(await agent.call("director.events.list", run)).toMatchObject({
      events: [
        expect.objectContaining({
          name: "block_broken",
          observation: "confirmed",
          filterFields: ["blockId"],
        }),
      ],
    });
    await expect(
      agent.call("director.hooks.add", {
        ...run,
        event: "health_changed",
        instruction: "Not observed",
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await agent.call("director.hooks.remove", { ...run, id: hook.id });
    expect(await agent.call("director.hooks.list", run)).toEqual({ hooks: [] });
    game.notify("game.event", observation(world, 2));
    await game.call("game.status", { ...world, paused: false });
    expect(f.eventLog.search(scope).events).toHaveLength(2);
  });

  test.each([
    ["empty state", {}],
    ["missing inventory", { ...snapshot, inventory: undefined }],
    ["missing capture time", { ...snapshot, observedAt: undefined }],
    ["missing position", { ...snapshot, position: undefined }],
    ["unsupported state version", { ...snapshot, version: 2 }],
    ["unrecognized state field", { ...snapshot, guessed: true }],
    ["nonintegral tick", { ...snapshot, tick: 1.5 }],
    ["unsafe capture time", { ...snapshot, observedAt: Number.MAX_SAFE_INTEGER + 1 }],
    ["invalid health", { ...snapshot, health: null }],
    ["negative health", { ...snapshot, health: -1 }],
    ["incomplete coordinates", { ...snapshot, position: [1, 64] }],
    [
      "missing main slot",
      { ...snapshot, inventory: { ...snapshot.inventory, main: snapshot.inventory.main.slice(1) } },
    ],
    [
      "invalid selected slot",
      { ...snapshot, inventory: { ...snapshot.inventory, selectedSlot: 9 } },
    ],
    [
      "missing equipment",
      { ...snapshot, inventory: { ...snapshot.inventory, equipment: undefined } },
    ],
    [
      "missing body slot",
      {
        ...snapshot,
        inventory: {
          ...snapshot.inventory,
          equipment: { ...snapshot.inventory.equipment, body: undefined },
        },
      },
    ],
    [
      "missing block coverage",
      { ...snapshot, nearby: { ...snapshot.nearby, blocksComplete: undefined } },
    ],
    [
      "oversized block sample",
      {
        ...snapshot,
        nearby: { ...snapshot.nearby, blocks: Array(730).fill(snapshot.nearby.blocks[0]) },
      },
    ],
    [
      "oversized entity sample",
      {
        ...snapshot,
        nearby: { ...snapshot.nearby, entities: Array(65).fill(snapshot.nearby.entities[0]) },
      },
    ],
  ])("rejects %s instead of forwarding an unusable required snapshot", async (_label, state) => {
    const f = await fixture();
    const game = await f.connect("game");
    await f.attach(game);
    const agent = await f.connect("agent");
    const run = await f.bridge.beginRun();
    game.handle("game.state.get", () => ({ ...run, state }));
    await expect(agent.call("game.state.get", { ...run, query: {} })).rejects.toMatchObject({
      code: -32603,
    });
  });

  test.each([false, true])(
    "accepts complete snapshots with explicit unknown coverage=%s",
    async (unknown) => {
      const f = await fixture();
      const game = await f.connect("game");
      await f.attach(game);
      const agent = await f.connect("agent");
      const run = await f.bridge.beginRun();
      const state = unknown
        ? {
            ...snapshot,
            biomeId: null,
            nearby: { ...snapshot.nearby, blocksComplete: false, entitiesTruncated: true },
          }
        : snapshot;
      game.handle("game.state.get", () => ({ ...run, state }));
      expect(snapshot.inventory.main).toHaveLength(36);
      expect(await agent.call("game.state.get", { ...run, query: {} })).toEqual({ ...run, state });
    },
  );

  test.each(["界", "\u0000"])(
    "maximum snapshot fits real TCP framing for %j identifiers",
    async (character) => {
      const f = await fixture();
      const game = await f.connect("game");
      await f.attach(game);
      const agent = await f.connect("agent");
      const run = await f.bridge.beginRun();
      const identifier = character.repeat(128);
      const counter = Number.MAX_SAFE_INTEGER;
      const position = [-Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE];
      const item = { itemId: identifier, count: counter };
      const state = {
        ...snapshot,
        tick: counter,
        observedAt: counter,
        dayTime: -counter,
        dimension: identifier,
        biomeId: identifier,
        position,
        health: Number.MAX_VALUE,
        maxHealth: Number.MAX_VALUE,
        foodLevel: counter,
        saturation: Number.MAX_VALUE,
        experience: { level: counter, progress: 1, total: counter },
        inventory: {
          selectedSlot: 8,
          main: Array(36).fill(item),
          equipment: Object.fromEntries(
            Object.keys(snapshot.inventory.equipment).map((slot) => [slot, item]),
          ),
        },
        nearby: {
          blockRadius: 4,
          blocksComplete: true,
          blocks: Array(729).fill({ blockId: identifier, position: [-counter, counter, counter] }),
          entityRadius: 16,
          entitiesTruncated: true,
          entities: Array(64).fill({ entityId: identifier, entityType: identifier, position }),
        },
      };
      // Budget maximum binding lengths and a decimal-string ID, as generated by RpcPeer.
      const budgetEnvelope = {
        jsonrpc: "2.0",
        id: String(counter),
        result: {
          worldId: identifier,
          playerId: identifier,
          worldSessionId: identifier,
          runId: identifier,
          state,
        },
      };
      expect(encodeJsonLine(budgetEnvelope).length - 1).toBeLessThanOrEqual(defaultMaxFrameBytes);
      game.handle("game.state.get", () => ({ ...run, state }));
      expect(await agent.call("game.state.get", { ...run, query: {} })).toEqual({ ...run, state });
    },
  );

  test("rejects an unimplemented query before requesting game state", async () => {
    const f = await fixture();
    const game = await f.connect("game");
    await f.attach(game);
    const agent = await f.connect("agent");
    const run = await f.bridge.beginRun();
    let requests = 0;
    game.handle("game.state.get", () => {
      requests++;
      return { ...run, state: snapshot };
    });
    await expect(
      agent.call("game.state.get", { ...run, query: { inventory: true } }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(requests).toBe(0);
  });

  test("pause invalidates tools immediately but a new run waits for settled confirmation", async () => {
    const f = await fixture();
    const game = await f.connect("game");
    const world = await f.attach(game);
    const agent = await f.connect("agent");
    const old = await f.bridge.beginRun();
    await game.call("game.status", { ...world, paused: true });
    await expect(agent.call("director.hooks.list", old)).rejects.toMatchObject({ code: -32001 });
    await game.call("game.status", { ...world, paused: false });
    await expect(f.bridge.beginRun()).rejects.toThrow(/settled/);
    expect(f.bridge.finishRun(old)).toBe(true);
    const current = await f.bridge.beginRun();
    expect(current.runId).not.toBe(old.runId);
    expect(f.bridge.finishRun(old)).toBe(false);
    expect(await agent.call("director.hooks.list", current)).toEqual({ hooks: [] });
  });

  test("rejects a late old-world response and isolates the next world's hooks and history", async () => {
    const f = await fixture();
    const game = await f.connect("game");
    const oldWorld = await f.attach(game);
    const agent = await f.connect("agent");
    const old = await f.bridge.beginRun();
    await agent.call("director.hooks.add", {
      ...old,
      event: "block_broken",
      instruction: "Old world",
    });
    let release!: (value: unknown) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    game.handle("game.state.get", () => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const pending = agent.call("game.state.get", { ...old, query: {} });
    const rejected = expect(pending).rejects.toMatchObject({ code: -32001 });
    await entered;
    game.notify("game.detach", oldWorld);
    const nextWorld = await f.attach(game, { ...attachParams, worldId: "world-b" });
    expect(nextWorld.worldSessionId).not.toBe(oldWorld.worldSessionId);
    expect(f.bridge.finishRun(old)).toBe(true);
    const current = await f.bridge.beginRun();
    release({ ...old, state: snapshot });
    await rejected;
    expect(await agent.call("director.hooks.list", current)).toEqual({ hooks: [] });
    expect(await agent.call("director.events.get", { ...current, query: {} })).toMatchObject({
      events: [],
    });
    await expect(
      agent.call("director.hooks.list", { ...current, worldId: old.worldId }),
    ).rejects.toMatchObject({ code: -32001 });
  });

  test("waits for both binding acknowledgments and forwards only matching, explicit display results", async () => {
    const f = await fixture();
    const game = await f.connect();
    const controls: string[] = [];
    game.handle("game.run.bind", (params) => {
      controls.push("game_bound");
      return params;
    });
    game.handle("game.run.clear", () => {
      controls.push("game_cleared");
    });
    game.handle("game.message.send", (params) => {
      controls.push("displayed");
      const { text: _text, ...binding } = params as RunBinding & { text: string };
      return { ...binding, displayed: true };
    });
    await game.call("bridge.hello", { protocolVersion: 1, role: "game", token: f.token });
    await f.attach(game);
    const agent = await f.connect();
    agent.handle("director.run.bind", (params) => {
      controls.push("agent_bound");
      return params;
    });
    await agent.call("bridge.hello", { protocolVersion: 1, role: "agent", token: f.token });
    await agent.call("director.ready", {});
    const run = await f.bridge.beginRun();
    expect(controls).toEqual(["game_bound", "agent_bound"]);
    expect(await agent.call("game.message.send", { ...run, text: "Hello" })).toEqual({
      ...run,
      displayed: true,
    });
    expect(controls).toEqual(["game_bound", "agent_bound", "displayed"]);
    expect(f.bridge.finishRun(run)).toBe(true);
    await expect(agent.call("game.message.send", { ...run, text: "Stale" })).rejects.toMatchObject({
      code: -32001,
    });
    expect(controls.filter((value) => value === "displayed")).toHaveLength(1);
  });

  test("startup interrupted by close never leaves a listening bridge", async () => {
    const db = openDatabase(":memory:");
    const catalog = new EventCatalog(gameEventDefinitions);
    const bridge = new DirectorBridge({
      token: randomBytes(32).toString("base64url"),
      eventLog: new EventLog(db, catalog),
      hooks: new ResponseHooks(db, catalog),
    });
    cleanup.push(async () => {
      await bridge.close();
      db.close();
    });
    const opening = bridge.listen();
    const rejected = expect(opening).rejects.toThrow(/closed/);
    await bridge.close();
    await rejected;
    await expect(bridge.listen()).rejects.toThrow(/closed/);
  });

  test("large durable hook collections remain enumerable through bounded pages", async () => {
    const f = await fixture();
    const game = await f.connect("game");
    await f.attach(game);
    const agent = await f.connect("agent");
    const run = await f.bridge.beginRun();
    const expected: string[] = [];
    for (let index = 0; index < 70; index++) {
      const hook = (await agent.call("director.hooks.add", {
        ...run,
        event: "block_broken",
        instruction: "石".repeat(16_000),
      })) as { id: string };
      expected.push(hook.id);
    }
    type Page = { hooks: Array<{ id: string }>; nextCursor?: string };
    let page = (await agent.call("director.hooks.list", run)) as Page;
    const found: string[] = [];
    for (;;) {
      expect(page.hooks.length).toBeLessThanOrEqual(8);
      found.push(...page.hooks.map((hook) => hook.id));
      if (!page.nextCursor) break;
      expect(page.nextCursor).toBe(page.hooks.at(-1)?.id);
      await agent.call("director.hooks.remove", { ...run, id: page.nextCursor });
      page = (await agent.call("director.hooks.list", {
        ...run,
        query: { after: page.nextCursor },
      })) as Page;
    }
    expect(found.toSorted()).toEqual(expected.toSorted());
    await expect(
      agent.call("director.hooks.list", { ...run, query: { limit: 9 } }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  test("attach cannot start a run before the game has installed and acknowledged its session", async () => {
    const f = await fixture();
    const game = await f.connect("game");
    await f.connect("agent");
    const attached: unknown[] = [];
    f.bridge.on("attach", (world) => {
      attached.push(world);
    });
    const binding = (await game.call("game.attach", attachParams)) as WorldBinding;
    expect(attached).toEqual([]);
    await expect(f.bridge.beginRun()).rejects.toThrow(/not ready/);
    await game.call("game.ready", binding);
    expect(attached).toHaveLength(1);
    expect(await f.bridge.beginRun()).toMatchObject(binding);
  });

  test("a forged raw observation closes the game without persisting another scope", async () => {
    const f = await fixture();
    const game = await f.connect("game");
    const world = await f.attach(game);
    const closed = once(game, "close");
    game.notify("game.event", { ...observation(world), worldId: "forged-world" });
    await closed;
    expect(f.eventLog.search(scope).events).toEqual([]);
    expect(f.eventLog.search({ ...scope, worldId: "forged-world" }).events).toEqual([]);
    expect(f.bridge.currentWorld).toBeUndefined();
  });
});

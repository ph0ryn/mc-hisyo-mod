import type { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vite-plus/test";
import { startBridgeRuntime } from "../runtime/bridgeRuntime.js";

const ports = vi.hoisted(() => ({
  openRaw: vi.fn(),
  openSummary: vi.fn(),
  publish: vi.fn(),
  discoveryClose: vi.fn(),
  bridgeOptions: vi.fn(),
  bridge: {} as object,
}));
vi.mock("./database.js", () => ({ openDatabase: ports.openRaw }));
vi.mock("./summaryDatabase.js", async (original) => ({
  ...(await original<typeof import("./summaryDatabase.js")>()),
  openSummaryDatabase: ports.openSummary,
}));
vi.mock("../runtime/privateDataDirectory.js", () => ({
  PrivateDataDirectory: class {
    databasePath = "/unit/history.sqlite";
    summaryDatabasePath = "/unit/summaries.sqlite";
    assertStorageFiles() {}
  },
}));
vi.mock("../runtime/connectionFile.js", () => ({
  ConnectionFile: class {
    publish = ports.publish;
    close = ports.discoveryClose;
  },
}));
vi.mock("../bridge/directorBridge.js", () => ({
  DirectorBridge: vi.fn(function (options: unknown) {
    ports.bridgeOptions(options);
    return ports.bridge;
  }),
}));

function fixture() {
  vi.clearAllMocks();
  const raw = { close: vi.fn(), prepare: () => ({ get: () => undefined }) };
  const summary = { close: vi.fn() };
  ports.openRaw.mockReset().mockReturnValue(raw);
  ports.openSummary.mockReset().mockReturnValue(summary);
  ports.discoveryClose.mockReset();
  const bridge = Object.assign(new EventEmitter(), {
    close: vi.fn(async () => {}),
    listen: vi.fn(async () => ({ host: "127.0.0.1", port: 1 })),
  });
  ports.bridge = bridge;
  const start = () =>
    startBridgeRuntime({
      dataDirectory: "/unit",
      signal: new AbortController().signal,
      onFault: vi.fn(),
    });
  return { raw, summary, bridge, start };
}

test("runtime opens separate stores, injects the summary store, and closes both exactly once", async () => {
  const f = fixture();
  const runtime = await f.start();
  expect(ports.openRaw).toHaveBeenCalledExactlyOnceWith("/unit/history.sqlite");
  expect(ports.openSummary).toHaveBeenCalledExactlyOnceWith("/unit/summaries.sqlite");
  const options = ports.bridgeOptions.mock.calls[0]![0];
  expect(options.history.db).toBe(f.summary);
  expect(options.history.log).toBe(options.eventLog);
  expect(options.eventLog.db).toBe(f.raw);
  expect(runtime.close()).toBe(runtime.close());
  await runtime.close();
  expect(f.bridge.close).toHaveBeenCalledOnce();
  expect(f.raw.close).toHaveBeenCalledOnce();
  expect(f.summary.close).toHaveBeenCalledOnce();
  expect(ports.discoveryClose).toHaveBeenCalledOnce();
});

test("failure opening the summary store still closes raw storage", async () => {
  const f = fixture();
  ports.openSummary.mockImplementation(() => {
    throw new Error("summary open failed");
  });
  await expect(f.start()).rejects.toThrow("summary open failed");
  expect(f.raw.close).toHaveBeenCalledOnce();
  expect(f.summary.close).not.toHaveBeenCalled();
  expect(ports.discoveryClose).toHaveBeenCalledOnce();
});

test("legacy import or listen failure closes both connections before rejecting startup", async () => {
  for (const stage of ["import", "listen"]) {
    const f = fixture();
    if (stage === "import") {
      const raw = f.raw as unknown as DatabaseSync;
      vi.spyOn(raw, "prepare").mockImplementation(() => {
        throw new Error("import failed");
      });
    } else f.bridge.listen.mockRejectedValue(new Error("listen failed"));
    await expect(f.start()).rejects.toThrow(`${stage} failed`);
    expect(f.raw.close).toHaveBeenCalledOnce();
    expect(f.summary.close).toHaveBeenCalledOnce();
    expect(ports.discoveryClose).toHaveBeenCalledOnce();
  }
});

test("startup preserves its cause and aggregates resource cleanup failures", async () => {
  const f = fixture();
  const startup = new Error("summary open failed");
  const cleanup = new Error("raw close failed");
  ports.openSummary.mockImplementation(() => {
    throw startup;
  });
  f.raw.close.mockImplementation(() => {
    throw cleanup;
  });
  await expect(f.start()).rejects.toMatchObject({
    errors: [startup, { errors: [cleanup] }],
  });
  expect(ports.discoveryClose).toHaveBeenCalledOnce();
});

test("shutdown attempts both stores and discovery even when every close fails", async () => {
  const f = fixture();
  const runtime = await f.start();
  const failures = ["bridge", "summary", "raw", "discovery"].map((name) => new Error(name));
  f.bridge.close.mockRejectedValue(failures[0]!);
  f.summary.close.mockImplementation(() => {
    throw failures[1]!;
  });
  f.raw.close.mockImplementation(() => {
    throw failures[2]!;
  });
  ports.discoveryClose.mockImplementation(() => {
    throw failures[3]!;
  });
  await expect(runtime.close()).rejects.toMatchObject({ errors: failures });
});

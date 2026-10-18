import { EventEmitter } from "node:events";
import { expect, test, vi } from "vite-plus/test";
import { startBridgeRuntime } from "../runtime/bridgeRuntime.js";

const ports = vi.hoisted(() => ({
  openRaw: vi.fn(),
  openActivity: vi.fn(),
  openSummary: vi.fn(),
  assertStorageFiles: vi.fn(),
  publish: vi.fn(),
  discoveryClose: vi.fn(),
  bridgeOptions: vi.fn(),
  bridge: {} as object,
}));
vi.mock("./database.js", () => ({ openDatabase: ports.openRaw }));
vi.mock("./activityDatabase.js", () => ({ openActivityDatabase: ports.openActivity }));
vi.mock("./summaryDatabase.js", async (original) => ({
  ...(await original<typeof import("./summaryDatabase.js")>()),
  openSummaryDatabase: ports.openSummary,
}));
vi.mock("../runtime/privateDataDirectory.js", () => ({
  PrivateDataDirectory: class {
    databasePath = "/unit/history.sqlite";
    activityDatabasePath = "/unit/activities.sqlite";
    summaryDatabasePath = "/unit/summaries.sqlite";
    assertStorageFiles = ports.assertStorageFiles;
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
  const raw = { close: vi.fn() };
  const activity = { close: vi.fn() };
  const summary = { close: vi.fn() };
  ports.openRaw.mockReset().mockReturnValue(raw);
  ports.openActivity.mockReset().mockReturnValue(activity);
  ports.openSummary.mockReset().mockReturnValue(summary);
  ports.assertStorageFiles.mockReset();
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
  return { raw, activity, summary, bridge, start };
}

test("runtime opens three independent stores, injects their owners, and closes each exactly once", async () => {
  const f = fixture();
  const runtime = await f.start();
  expect(ports.openRaw).toHaveBeenCalledExactlyOnceWith("/unit/history.sqlite");
  expect(ports.openSummary).toHaveBeenCalledExactlyOnceWith("/unit/summaries.sqlite");
  expect(ports.openActivity).toHaveBeenCalledExactlyOnceWith("/unit/activities.sqlite");
  expect(ports.assertStorageFiles).toHaveBeenCalledTimes(2);
  const options = ports.bridgeOptions.mock.calls[0]![0];
  expect(options.history.db).toBe(f.summary);
  expect(options.history.log).toBe(options.eventLog);
  expect(options.eventLog.db).toBe(f.raw);
  expect(options.activityLog.db).toBe(f.activity);
  expect(options.hooks.db).toBe(f.activity);
  expect(runtime.close()).toBe(runtime.close());
  await runtime.close();
  expect(f.bridge.close).toHaveBeenCalledOnce();
  expect(f.raw.close).toHaveBeenCalledOnce();
  expect(f.summary.close).toHaveBeenCalledOnce();
  expect(f.activity.close).toHaveBeenCalledOnce();
  expect(ports.discoveryClose).toHaveBeenCalledOnce();
});

test("failure opening the summary store still closes raw and activity storage", async () => {
  const f = fixture();
  ports.openSummary.mockImplementation(() => {
    throw new Error("summary open failed");
  });
  await expect(f.start()).rejects.toThrow("summary open failed");
  expect(f.raw.close).toHaveBeenCalledOnce();
  expect(f.summary.close).not.toHaveBeenCalled();
  expect(f.activity.close).toHaveBeenCalledOnce();
  expect(ports.discoveryClose).toHaveBeenCalledOnce();
});

test("failure opening activity storage closes raw storage before rejecting startup", async () => {
  const f = fixture();
  ports.openActivity.mockImplementation(() => {
    throw new Error("activity open failed");
  });
  await expect(f.start()).rejects.toThrow("activity open failed");
  expect(f.raw.close).toHaveBeenCalledOnce();
  expect(f.activity.close).not.toHaveBeenCalled();
  expect(ports.openSummary).not.toHaveBeenCalled();
  expect(ports.discoveryClose).toHaveBeenCalledOnce();
});

test.each(["privacy", "listen", "publish"])(
  "%s failure closes all three stores before rejecting startup",
  async (stage) => {
    const f = fixture();
    const error = new Error(`${stage} failed`);
    if (stage === "privacy")
      ports.assertStorageFiles
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
          throw error;
        });
    else if (stage === "listen") f.bridge.listen.mockRejectedValue(error);
    else
      ports.publish.mockImplementationOnce(() => {
        throw error;
      });
    await expect(f.start()).rejects.toBe(error);
    expect(f.raw.close).toHaveBeenCalledOnce();
    expect(f.activity.close).toHaveBeenCalledOnce();
    expect(f.summary.close).toHaveBeenCalledOnce();
    expect(ports.discoveryClose).toHaveBeenCalledOnce();
    if (stage === "privacy") expect(ports.bridgeOptions).not.toHaveBeenCalled();
    else expect(f.bridge.close).toHaveBeenCalledOnce();
  },
);

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

test("shutdown attempts all three stores and discovery even when every close fails", async () => {
  const f = fixture();
  const runtime = await f.start();
  const failures = ["bridge", "summary", "activity", "raw", "discovery"].map(
    (name) => new Error(name),
  );
  f.bridge.close.mockRejectedValue(failures[0]!);
  f.summary.close.mockImplementation(() => {
    throw failures[1]!;
  });
  f.activity.close.mockImplementation(() => {
    throw failures[2]!;
  });
  f.raw.close.mockImplementation(() => {
    throw failures[3]!;
  });
  ports.discoveryClose.mockImplementation(() => {
    throw failures[4]!;
  });
  await expect(runtime.close()).rejects.toMatchObject({ errors: failures });
});

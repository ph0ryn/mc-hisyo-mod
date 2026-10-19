import { EventEmitter } from "node:events";
import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { SummaryScheduler, type SummarySchedulerOptions } from "./summaryScheduler.js";
import type { AttachedSession } from "../bridge/bridgeServer.js";
import type { SummarySource } from "../events/summaryInput.js";
import type { SessionBinding } from "../protocol/bridge.js";

const binding = { worldId: "world", playerId: "player", sessionId: "session" };
const scope = { worldId: "world", playerId: "player" };
function fixture({ minutes = [120_000, 60_000, 0], wallNow = 180_000, paused = false } = {}) {
  let nextId = 1;
  const remaining: SummarySource[] = [];
  const add = (minuteStart: number) => {
    const id = nextId++;
    const source: SummarySource = {
      after: id - 1,
      through: id,
      sourceSessionId: "source-session",
      sourceCount: 1,
      firstObservedAt: minuteStart + 1,
      lastObservedAt: minuteStart + 59_000,
      input: `minute ${minuteStart}`,
    };
    remaining.push(source);
    return source;
  };
  for (const minute of minutes) add(minute);
  const pending: {
    binding: SessionBinding;
    input: string;
    signal: AbortSignal;
    resolve: (text: string) => void;
    reject: (error: Error) => void;
  }[] = [];
  const bridge = Object.assign(new EventEmitter(), {
    readySession: {
      binding,
      paused,
      supportedEvents: [],
      language: "ja_jp",
    } as AttachedSession | undefined,
    summaries: {
      next: vi.fn((_scope: typeof scope, now: number): { source: SummarySource } | undefined => {
        const cutoff = Math.floor(now / 60_000) * 60_000;
        const source = remaining
          .filter((source) => source.lastObservedAt < cutoff)
          .toSorted((a, b) => b.firstObservedAt - a.firstObservedAt)[0];
        return source ? { source } : undefined;
      }),
      save: vi.fn(
        (_scope: typeof scope, source: SummarySource, _text: string, _createdAt: number) => {
          const index = remaining.indexOf(source);
          if (index < 0) throw new Error("Source already consumed");
          remaining.splice(index, 1);
        },
      ),
    },
  });
  const summarize = vi.fn(
    (binding: SessionBinding, input: string, signal: AbortSignal) =>
      new Promise<string>((resolve, reject) =>
        pending.push({ binding, input, signal, resolve, reject }),
      ),
  );
  const summaryScheduler = new SummaryScheduler({
    bridge: bridge as unknown as SummarySchedulerOptions["bridge"],
    summarize,
    wallNow: () => wallNow,
  });
  const fault = vi.fn();
  summaryScheduler.on("fault", fault);
  onTestFinished(async () => {
    const closing = summaryScheduler.close();
    for (const request of pending) request.resolve("discarded during cleanup");
    await closing;
  });
  return {
    summaryScheduler,
    bridge,
    summarize,
    pending,
    remaining,
    fault,
    add,
    at: (value: number) => {
      wallNow = value;
    },
    pause: (paused: boolean) => {
      // BridgeServer emits a clone instead of mutating the previously attached value.
      bridge.readySession = { ...bridge.readySession!, paused };
      bridge.emit("status", bridge.readySession);
    },
    detach: () => {
      const binding = bridge.readySession!.binding;
      bridge.readySession = undefined;
      bridge.emit("detach", binding);
    },
    replace: (next: SessionBinding) => {
      bridge.readySession = { binding: next, paused, supportedEvents: [], language: "ja_jp" };
      bridge.emit("attach", bridge.readySession);
    },
    settle: () => new Promise<void>((resolve) => setImmediate(resolve)),
  };
}

test("saved batches immediately drain the next source without another minute poll", async () => {
  const f = fixture();
  expect(f.summaryScheduler.poll(binding)).toBe(true);
  await f.settle();
  expect(f.pending.map((request) => request.input)).toEqual(["minute 120000"]);
  expect(f.bridge.summaries.next).toHaveBeenCalledExactlyOnceWith(scope, 180_000);
  for (const [index, minute] of [120_000, 60_000, 0].entries()) {
    expect(f.pending[index]!.input).toBe(`minute ${minute}`);
    f.pending[index]!.resolve(`summary ${minute}`);
    await f.settle();
  }
  expect(f.pending.map((request) => request.input)).toEqual([
    "minute 120000",
    "minute 60000",
    "minute 0",
  ]);
  expect(f.bridge.summaries.save.mock.calls.map((call) => call[2])).toEqual([
    "summary 120000",
    "summary 60000",
    "summary 0",
  ]);
  expect(f.bridge.summaries.save.mock.calls.every((call) => call[3] === 180_000)).toBe(true);
  expect(f.remaining).toEqual([]);
  expect(f.bridge.summaries.next).toHaveBeenCalledTimes(4);
  await f.settle();
  expect(f.bridge.summaries.next).toHaveBeenCalledTimes(4);
  expect(f.fault).not.toHaveBeenCalled();
});

test("selection receives current wall time without waiting for an elapsed-minute gate", async () => {
  const f = fixture({ minutes: [300_000], wallNow: 359_999 });
  expect(f.summaryScheduler.poll(binding)).toBe(false);
  await f.settle();
  expect(f.bridge.summaries.next).toHaveBeenLastCalledWith(scope, 359_999);
  expect(f.summarize).not.toHaveBeenCalled();
  f.at(360_000);
  expect(f.summaryScheduler.poll(binding)).toBe(true);
  await f.settle();
  expect(f.pending[0]!.input).toBe("minute 300000");
  f.at(360_001);
  f.pending[0]!.resolve("completed minute");
  await f.settle();
  expect(f.bridge.summaries.save.mock.calls[0]![3]).toBe(360_001);
  expect(f.bridge.summaries.next).toHaveBeenLastCalledWith(scope, 360_001);
});

test("a newly completed minute wins after the current older request finishes", async () => {
  const f = fixture();
  f.summaryScheduler.poll(binding);
  await f.settle();
  f.pending[0]!.resolve("latest");
  await f.settle();
  expect(f.pending[1]!.input).toBe("minute 60000");
  f.add(180_000);
  f.at(240_000);
  f.bridge.emit("runRequested", {});
  for (let index = 0; index < 3; index++) expect(f.summaryScheduler.poll(binding)).toBe(false);
  expect(f.pending[1]!.signal.aborted).toBe(false);
  expect(f.bridge.summaries.next).toHaveBeenCalledTimes(2);
  f.pending[1]!.resolve("older request completed");
  await f.settle();
  expect(f.pending[2]!.input).toBe("minute 180000");
  expect(f.bridge.summaries.next).toHaveBeenLastCalledWith(scope, 240_000);
  f.pending[2]!.resolve("new latest");
  await f.settle();
  expect(f.pending[3]!.input).toBe("minute 0");
  f.pending[3]!.resolve("oldest");
  await f.settle();
  expect(f.remaining).toEqual([]);
  expect(f.fault).not.toHaveBeenCalled();
});

test.each([false, true])(
  "pause never blocks or cancels the summary drain; initiallyPaused=%s",
  async (paused) => {
    const f = fixture({ minutes: [60_000, 0], paused });
    expect(f.summaryScheduler.poll(binding)).toBe(true);
    await f.settle();
    f.pause(true);
    expect(f.pending[0]!.signal.aborted).toBe(false);
    f.pending[0]!.resolve("first");
    await f.settle();
    expect(f.pending[1]!.input).toBe("minute 0");
    f.pause(false);
    f.pause(true);
    expect(f.pending[1]!.signal.aborted).toBe(false);
    f.pending[1]!.resolve("second");
    await f.settle();
    expect(f.bridge.summaries.save).toHaveBeenCalledTimes(2);
    expect(f.fault).not.toHaveBeenCalled();
  },
);

test.each([false, true])(
  "an empty selection stays idle until the next external poll; paused=%s",
  async (paused) => {
    const f = fixture({ minutes: [], paused });
    expect(f.summaryScheduler.poll(binding)).toBe(false);
    await f.settle();
    await f.settle();
    expect(f.bridge.summaries.next).toHaveBeenCalledOnce();
    expect(f.summarize).not.toHaveBeenCalled();
    f.add(0);
    expect(f.summaryScheduler.poll(binding)).toBe(true);
    await f.settle();
    expect(f.pending).toHaveLength(1);
    f.pending[0]!.resolve("newly available work");
    await f.settle();
    expect(f.bridge.summaries.next).toHaveBeenCalledTimes(3);
    expect(f.fault).not.toHaveBeenCalled();
  },
);

test("stale or non-ready bindings never select or dispatch work", async () => {
  const f = fixture();
  expect(f.summaryScheduler.poll({ ...binding, sessionId: "stale" })).toBe(false);
  f.bridge.readySession = undefined;
  expect(f.summaryScheduler.poll(binding)).toBe(false);
  await f.settle();
  expect(f.bridge.summaries.next).not.toHaveBeenCalled();
  expect(f.summarize).not.toHaveBeenCalled();
});

test("readiness is checked again after selection and before every next dispatch", async () => {
  const f = fixture();
  const select = f.bridge.summaries.next.getMockImplementation()!;
  f.bridge.summaries.next.mockImplementationOnce((...args) => {
    const pending = select(...args);
    f.bridge.readySession = undefined;
    return pending;
  });
  f.summaryScheduler.poll(binding);
  await f.settle();
  expect(f.summarize).not.toHaveBeenCalled();
  f.bridge.readySession = { binding, paused: false, supportedEvents: [], language: "ja_jp" };
  expect(f.summaryScheduler.poll(binding)).toBe(true);
  await f.settle();
  const save = f.bridge.summaries.save.getMockImplementation()!;
  f.bridge.summaries.save.mockImplementationOnce((...args) => {
    save(...args);
    f.bridge.readySession = undefined;
  });
  f.pending[0]!.resolve("saved before readiness changed");
  await f.settle();
  expect(f.pending).toHaveLength(1);
  expect(f.bridge.summaries.next).toHaveBeenCalledTimes(2);
  expect(f.fault).not.toHaveBeenCalled();
});

test.each(["resolve", "reject"] as const)(
  "replacement wakes once only after the old cancelled request settles: %s",
  async (settlement) => {
    const f = fixture({ minutes: [0] });
    f.summaryScheduler.poll(binding);
    await f.settle();
    f.detach();
    const next = { ...binding, sessionId: "replacement" };
    f.replace(next);
    expect(f.pending[0]!.signal.aborted).toBe(true);
    for (let index = 0; index < 3; index++) expect(f.summaryScheduler.poll(next)).toBe(false);
    expect(f.bridge.summaries.next).toHaveBeenCalledOnce();
    expect(f.pending).toHaveLength(1);
    if (settlement === "resolve") f.pending[0]!.resolve("stale output");
    else f.pending[0]!.reject(new Error("cancelled old provider"));
    await f.settle();
    expect(f.bridge.summaries.save).not.toHaveBeenCalled();
    expect(f.pending).toHaveLength(2);
    expect(f.pending[1]!.binding).toEqual(next);
    expect(f.pending[1]!.signal.aborted).toBe(false);
    f.pending[1]!.resolve("replacement output");
    await f.settle();
    expect(f.bridge.summaries.save).toHaveBeenCalledOnce();
    expect(f.bridge.summaries.next).toHaveBeenCalledTimes(3);
    await f.settle();
    expect(f.bridge.summaries.next).toHaveBeenCalledTimes(3);
    expect(f.fault).not.toHaveBeenCalled();
  },
);

test("detach discards late output without flushing or restarting work", async () => {
  const f = fixture();
  f.summaryScheduler.poll(binding);
  await f.settle();
  f.detach();
  f.pending[0]!.resolve("late output");
  await f.settle();
  expect(f.pending[0]!.signal.aborted).toBe(true);
  expect(f.bridge.summaries.save).not.toHaveBeenCalled();
  expect(f.bridge.summaries.next).toHaveBeenCalledOnce();
  expect(f.summaryScheduler.poll(binding)).toBe(false);
  expect(f.fault).not.toHaveBeenCalled();
});

test.each(["generation", "save"] as const)(
  "a %s failure faults once and stops the drain without retry",
  async (stage) => {
    const f = fixture();
    const failure = new Error(`${stage} failed`);
    if (stage === "save")
      f.bridge.summaries.save.mockImplementationOnce(() => {
        throw failure;
      });
    f.summaryScheduler.poll(binding);
    await f.settle();
    if (stage === "generation") f.pending[0]!.reject(failure);
    else f.pending[0]!.resolve("cannot save");
    await f.settle();
    expect(f.fault).toHaveBeenCalledExactlyOnceWith(failure);
    expect(f.remaining).toHaveLength(3);
    expect(f.bridge.summaries.next).toHaveBeenCalledOnce();
    expect(f.summaryScheduler.poll(binding)).toBe(false);
    expect(f.pending).toHaveLength(1);
  },
);

test.each(["initial", "after save"] as const)(
  "selection failure is fatal once: %s",
  async (stage) => {
    const f = fixture();
    const failure = new Error("selection failed");
    const fail = () => {
      throw failure;
    };
    if (stage === "initial") f.bridge.summaries.next.mockImplementationOnce(fail);
    f.summaryScheduler.poll(binding);
    await f.settle();
    if (stage === "after save") {
      f.bridge.summaries.next.mockImplementationOnce(fail);
      f.pending[0]!.resolve("saved");
      await f.settle();
    }
    expect(f.fault).toHaveBeenCalledExactlyOnceWith(failure);
    expect(f.summaryScheduler.poll(binding)).toBe(false);
    expect(f.bridge.summaries.save).toHaveBeenCalledTimes(stage === "initial" ? 0 : 1);
  },
);

test("synchronous generation failure does not retain or restart a flight", async () => {
  const f = fixture();
  const failure = new Error("synchronous dispatch failure");
  f.summarize.mockImplementationOnce(() => {
    throw failure;
  });
  f.summaryScheduler.poll(binding);
  await f.settle();
  expect(f.fault).toHaveBeenCalledExactlyOnceWith(failure);
  expect(f.summaryScheduler.poll(binding)).toBe(false);
  expect(f.bridge.summaries.save).not.toHaveBeenCalled();
});

test("selection can reenter poll and close without losing the published flight", async () => {
  const f = fixture();
  const select = f.bridge.summaries.next.getMockImplementation()!;
  let closing!: Promise<void>;
  let nestedPoll: boolean | undefined;
  f.bridge.summaries.next.mockImplementationOnce((...args) => {
    nestedPoll = f.summaryScheduler.poll(binding);
    closing = f.summaryScheduler.close();
    return select(...args);
  });
  f.summaryScheduler.poll(binding);
  expect(nestedPoll).toBe(false);
  expect(f.summaryScheduler.close()).toBe(closing);
  await closing;
  expect(f.summarize).not.toHaveBeenCalled();
  expect(f.bridge.summaries.save).not.toHaveBeenCalled();
  expect(f.bridge.summaries.next).toHaveBeenCalledOnce();
});

test("close during synchronous generation entry still awaits provider settlement", async () => {
  const f = fixture();
  const generate = f.summarize.getMockImplementation()!;
  let closing!: Promise<void>;
  let closed = false;
  f.summarize.mockImplementationOnce((...args) => {
    const result = generate(...args);
    closing = f.summaryScheduler.close();
    void closing.then(() => {
      closed = true;
    });
    return result;
  });
  f.summaryScheduler.poll(binding);
  await f.settle();
  expect(f.pending[0]!.signal.aborted).toBe(true);
  expect(closed).toBe(false);
  expect(f.summaryScheduler.close()).toBe(closing);
  f.pending[0]!.resolve("late completion");
  await closing;
  expect(closed).toBe(true);
  expect(f.bridge.summaries.save).not.toHaveBeenCalled();
  expect(f.bridge.summaries.next).toHaveBeenCalledOnce();
});

test("close during save prevents the next selection", async () => {
  const f = fixture();
  const save = f.bridge.summaries.save.getMockImplementation()!;
  let closing!: Promise<void>;
  f.bridge.summaries.save.mockImplementationOnce((...args) => {
    save(...args);
    closing = f.summaryScheduler.close();
  });
  f.summaryScheduler.poll(binding);
  await f.settle();
  f.pending[0]!.resolve("saved before close");
  await f.settle();
  await closing;
  expect(f.bridge.summaries.save).toHaveBeenCalledOnce();
  expect(f.bridge.summaries.next).toHaveBeenCalledOnce();
  expect(f.remaining).toHaveLength(2);
});

test("close aborts synchronously, awaits late work, removes listeners, and is idempotent", async () => {
  const f = fixture();
  f.summaryScheduler.poll(binding);
  await f.settle();
  let closed = false;
  const closing = f.summaryScheduler.close();
  void closing.then(() => {
    closed = true;
  });
  expect(f.summaryScheduler.close()).toBe(closing);
  expect(f.pending[0]!.signal.aborted).toBe(true);
  await f.settle();
  expect(closed).toBe(false);
  f.pending[0]!.resolve("late output");
  await closing;
  expect(closed).toBe(true);
  expect(f.bridge.summaries.save).not.toHaveBeenCalled();
  expect(f.bridge.summaries.next).toHaveBeenCalledOnce();
  expect(f.summaryScheduler.poll(binding)).toBe(false);
  expect(f.bridge.listenerCount("attach")).toBe(0);
  expect(f.bridge.listenerCount("status")).toBe(0);
  expect(f.bridge.listenerCount("detach")).toBe(0);
});

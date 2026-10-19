import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, onTestFinished, test } from "vite-plus/test";
import { RunInbox } from "./runInbox.js";
import { RunQueueFullError } from "./runQueue.js";

const binding = { worldId: "world", playerId: "player", sessionId: "first" };

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "hisyo-inbox-"));
  const database = join(directory, "conversation.sqlite");
  let harness: Harness | undefined;
  const open = async (session = binding, maxBytes?: number) => {
    harness = await Harness.open(
      await openNodeSqliteStorage(database),
      {
        models: createModels(),
        registry: createRegistry(),
      },
      BACKGROUND_CONTEXT,
    );
    return new RunInbox(await harness.root(BACKGROUND_CONTEXT), session, maxBytes);
  };
  const close = async () => {
    await harness?.close(BACKGROUND_CONTEXT);
    harness = undefined;
  };
  onTestFinished(async () => {
    await close();
    // This exact temporary directory is owned by this fixture, never a configured path.
    rmSync(directory, { recursive: true });
  });
  return { open, close };
}

test("accepted duplicate chats survive reopen and retain their ordering", async () => {
  const f = await fixture();
  const first = await f.open();
  await first.update((queue) => {
    queue.enqueueMessage(binding, "same");
    queue.enqueueMessage(binding, "same");
  });
  await f.close();
  const nextBinding = { ...binding, sessionId: "reconnected" };
  const reopened = await f.open(nextBinding);
  const dispatch = await reopened.take();
  expect(dispatch?.batch).toMatchObject({ binding: nextBinding, playerMessages: ["same", "same"] });
});

test("reservation survives a take/submit crash window with the same request ID", async () => {
  const f = await fixture();
  const inbox = await f.open();
  await inbox.update((queue) => queue.enqueueStart());
  const reserved = await inbox.take();
  await inbox.update((queue) => queue.enqueueMessage(binding, "next"));
  await f.close();
  const reopened = await f.open();
  expect(await reopened.take()).toEqual(reserved);
  await reopened.complete(reserved!.requestId);
  const next = await reopened.take();
  expect(next?.requestId).not.toBe(reserved?.requestId);
  expect(next?.batch.playerMessages).toEqual(["next"]);
});

test("explicit detach clearing differs from host close preserving work", async () => {
  const f = await fixture();
  const inbox = await f.open();
  await inbox.update((queue) => queue.enqueueMessage(binding, "old"));
  await inbox.clear();
  await f.close();
  expect(await (await f.open()).take()).toBeUndefined();
});

test("over-budget admission rolls back without losing earlier durable input", async () => {
  const f = await fixture();
  const inbox = await f.open(binding, 300);
  await inbox.update((queue) => queue.enqueueMessage(binding, "kept"));
  await expect(
    inbox.update((queue) => queue.enqueueMessage(binding, "x".repeat(500))),
  ).rejects.toBeInstanceOf(RunQueueFullError);
  await f.close();
  expect((await (await f.open()).take())?.batch.playerMessages).toEqual(["kept"]);
});

test("hook completion cancels only pending poll and preserves player input", async () => {
  const f = await fixture();
  const inbox = await f.open();
  await inbox.update((queue) => queue.enqueueStart());
  const active = await inbox.take();
  await inbox.update((queue) => {
    queue.enqueuePoll();
    queue.enqueueMessage(binding, "keep");
  });
  await inbox.complete(active!.requestId, true);
  expect((await inbox.take())?.batch).toMatchObject({ poll: false, playerMessages: ["keep"] });
});

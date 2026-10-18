import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, test, vi } from "vite-plus/test";
import type { DirectorBridge } from "../bridge/directorBridge.js";
import { startPiRpcClient } from "../pi/piRpcClient.js";
import { refreshPiOAuth } from "./piOAuth.js";
import { startPiSession } from "./piSession.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: execute }),
}));
vi.mock("../pi/piRpcClient.js", async (original) => ({
  ...(await original<typeof import("../pi/piRpcClient.js")>()),
  startPiRpcClient: vi.fn(),
}));
const directory = mkdtempSync(join(tmpdir(), "director-oauth-"));
const authPath = join(directory, "auth.json");
afterEach(() => {
  execute.mockReset();
  rmSync(authPath, { force: true });
});
// Only the owned mkdtemp directory is removed after this file's tests finish.
afterAll(() => rmSync(directory, { recursive: true }));

test.each(["ja_jp", "en_us"])("launches proactive guidance in %s", async (language) => {
  const world = { worldId: "w", playerId: "p", worldSessionId: "s" };
  const hash = createHash("sha256")
    .update(JSON.stringify([world.worldId, world.playerId]))
    .digest("hex");
  const scope = join(directory, "state", "pi", hash);
  mkdirSync(scope, { recursive: true, mode: 0o700 });
  const legacy = join(scope, "session.jsonl");
  writeFileSync(legacy, "old hidden-world transcript", { mode: 0o600 });
  const bridge = Object.assign(new EventEmitter(), {
    isAgentReady: false,
    currentWorld: { binding: world, language },
    readyWorld: { binding: world, status: { worldState: { ready: true } } },
    beginRun: vi.fn(async () => ({ ...world, runId: "run" })),
    finishRun: vi.fn(),
    invalidateRun: vi.fn(),
  });
  let privateAuth = "",
    promptPath = "";
  const languageInstruction = `Write player-facing messages in the language specified by Minecraft language code "${language}".`;
  const seen: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    initialize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    run: vi.fn(async () => {
      expect(readFileSync(promptPath, "utf8")).toContain(languageInstruction);
      seen.push(JSON.parse(readFileSync(privateAuth, "utf8")).openai.key);
      return { status: "settled" as const, aborted: false };
    }),
  });
  vi.mocked(startPiRpcClient).mockImplementationOnce(async (launch) => {
    privateAuth = join(launch.env.PI_CODING_AGENT_DIR!, "auth.json");
    expect(JSON.parse(readFileSync(privateAuth, "utf8")).openai.key).toBe("startup-token");
    expect(launch.env.MC_HISYO_MODEL_API_KEY).toBeUndefined();
    const sessionPath = launch.args![launch.args!.indexOf("--session") + 1]!;
    expect(sessionPath).toBe(join(realpathSync(scope), "session-observable-v1.jsonl"));
    expect(readFileSync(legacy, "utf8")).toBe("old hidden-world transcript");
    promptPath = launch.args![launch.args!.indexOf("--system-prompt") + 1]!;
    expect(readFileSync(promptPath, "utf8")).toContain(languageInstruction);
    expect(readFileSync(promptPath, "utf8")).not.toContain("CURRENT_GAME_STATE.language");
    const prompt = readFileSync(promptPath, "utf8");
    expect(prompt).toContain("Keep the player continuously directed toward a concrete goal");
    expect(prompt).toContain("single action or several steps");
    expect(prompt).toContain(
      "Do not enforce a fixed instruction count or require a message on every judgment",
    );
    expect(prompt).toContain("Do not wait for a player question or a new event");
    expect(prompt).toContain("completed, blocked or no longer appropriate");
    expect(prompt).toContain(
      "While the current instructions remain appropriate and are being carried out, let them stand without repeating or replacing them, even on polls",
    );
    expect(prompt).toContain("You may also initiate casual conversation");
    expect(prompt).toContain("while the player follows existing instructions");
    expect(prompt).toContain(
      "Not every message needs an instruction or a connection to the current goal",
    );
    expect(prompt).toContain(
      "Once your intended guidance or conversation for this judgment is complete",
    );
    expect(prompt).not.toContain(
      "Once the needed guidance has been delivered, finish the judgment",
    );
    expect(prompt).toContain("Set or update needed hooks before send_message");
    expect(prompt).not.toContain("Stay silent when there is no useful new information");
    expect(prompt).not.toContain("send one concise, actionable instruction");
    expect(prompt).not.toContain("After a successful send_message, finish this judgment");
    expect(prompt).toContain("A refreshed snapshot or tool acknowledgement is background data");
    expect(prompt).toContain("Do not narrate routine HUD values or list inventory");
    expect(
      JSON.parse(readFileSync(join(launch.env.PI_CODING_AGENT_DIR!, "models.json"), "utf8")),
    ).toEqual({ providers: {} });
    bridge.isAgentReady = true;
    bridge.emit("agentReady");
    return client as unknown as Awaited<ReturnType<typeof startPiRpcClient>>;
  });
  execute.mockResolvedValueOnce({ stdout: "startup-token" });
  const session = await startPiSession({
    dataDirectory: join(directory, "state"),
    world,
    bridge: bridge as unknown as DirectorBridge,
    connection: { protocolVersion: 1, host: "127.0.0.1", port: 1, token: "bridge-token", pid: 1 },
    executable: "/trusted/pi",
    bundledExtension: "/trusted/extension.mjs",
    model: { provider: "openai", id: "gpt-6-luna", apiKey: "expired-token" },
    oauthAgentDirectory: "/original/agent",
  });
  try {
    bridge.currentWorld.language = language === "ja_jp" ? "en_us" : "ja_jp";
    for (const token of ["judgment-A", "judgment-B"]) {
      execute.mockResolvedValueOnce({ stdout: token });
      await expect(session.judge("prompt")).resolves.toEqual({
        status: "settled",
        aborted: false,
      });
    }
    expect(seen).toEqual(["judgment-A", "judgment-B"]);
    execute.mockRejectedValueOnce(new Error("refresh-secret"));
    await expect(session.judge("blocked")).rejects.toThrow(
      "Unable to refresh ChatGPT authentication through Pi.",
    );
    expect(bridge.beginRun).toHaveBeenCalledTimes(2);
    expect(client.run).toHaveBeenCalledTimes(2);
    let persist!: (value: { stdout: string }) => void;
    execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          persist = resolve;
        }),
    );
    const judgment = session.judge("cancelled during refresh");
    const closing = session.close();
    await Promise.resolve();
    expect(() => readFileSync(privateAuth)).not.toThrow();
    persist({ stdout: "unused-fresh-token" });
    await expect(judgment).resolves.toEqual({ status: "not_started" });
    await closing;
    expect(client.run).toHaveBeenCalledTimes(2);
  } finally {
    await session.close();
  }
  expect(client.close).toHaveBeenCalledOnce();
  expect(() => readFileSync(privateAuth)).toThrow();
});

const refresh = (signal = new AbortController().signal) =>
  refreshPiOAuth("/trusted/pi", "/original/agent", authPath, 300_000, signal);

test("rotates private access-only credentials and uses Pi's native expiry guarantee", async () => {
  for (const token of ["bearer-A", "bearer-B"]) {
    execute.mockResolvedValueOnce({ stdout: `${token}\n` });
    await refresh();
    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
      openai: { type: "api_key", key: token },
    });
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
  }
  const [command, args, options] = execute.mock.calls[0]!;
  expect(command).toBe("/trusted/pi");
  expect(args).toEqual([
    "auth",
    "print-bearer-token",
    "--provider",
    "openai",
    "--min-expiry",
    "600000ms",
  ]);
  expect(options.env.PI_CODING_AGENT_DIR).toBe("/original/agent");
  expect(options.env.OPENAI_API_KEY).toBeUndefined();
  expect(options.signal).toBeUndefined();
  expect(options.timeout).toBeUndefined();
});

test.each(["", "!command", "${SECRET}", "bearer\nextra"])(
  "rejects unsafe credential output without replacing a working token: %s",
  async (stdout) => {
    execute.mockResolvedValueOnce({ stdout: "working-token" });
    await refresh();
    execute.mockResolvedValueOnce({ stdout });
    await expect(refresh()).rejects.toThrow("Unable to refresh ChatGPT authentication through Pi.");
    expect(JSON.parse(readFileSync(authPath, "utf8")).openai.key).toBe("working-token");
  },
);

test("helper failures redact stdout/stderr and have no nested cause", async () => {
  execute.mockRejectedValueOnce(
    Object.assign(new Error("SECRET_SENTINEL"), {
      stdout: "access-secret",
      stderr: "refresh-secret",
    }),
  );
  const error = await refresh().catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("Unable to refresh ChatGPT authentication through Pi.");
  expect((error as Error).cause).toBeUndefined();
  expect(() => readFileSync(authPath)).toThrow();
});

test("cancellation waits for native grant persistence, then suppresses the private handoff", async () => {
  let complete!: (value: { stdout: string }) => void;
  execute.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const stop = new AbortController();
  let settled = false;
  const pending = refresh(stop.signal).catch(() => {
    settled = true;
  });
  stop.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  complete({ stdout: "fresh-token" });
  await pending;
  expect(settled).toBe(true);
  expect(() => readFileSync(authPath)).toThrow();
});

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { WorldBinding } from "./protocol/bridge.js";
import { RpcPeer } from "./transport/rpcPeer.js";

const directories = new Set<string>();
const processes = new Map<ChildProcessWithoutNullStreams, Promise<unknown>>();
const peers = new Set<RpcPeer>();
afterEach(async () => {
  for (const peer of peers) peer.close();
  peers.clear();
  for (const child of processes.keys()) child.kill("SIGKILL");
  await Promise.all(processes.values());
  processes.clear();
  for (const directory of directories) {
    expect(realpathSync(directory)).toBe(directory);
    expect(basename(directory)).toMatch(/^mc-hisyo-cli-/);
    rmSync(directory, { recursive: true });
  }
  directories.clear();
});

function temporaryDirectory() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "mc-hisyo-cli-")));
  directories.add(directory);
  return directory;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["dist/cli.mjs", ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 5_000,
  });
}

function startCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ["dist/cli.mjs", ...args], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once("close", (code, signal) => {
      processes.delete(child);
      done({ code, signal });
    });
  });
  processes.set(child, exited);
  const ready = new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`CLI readiness timed out: ${stderr}`)), 4_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("Bridge ready at 127.0.0.1:")) {
        clearTimeout(timer);
        done();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once("close", () => {
      clearTimeout(timer);
      fail(new Error(`CLI exited before readiness: ${stderr}`));
    });
  });
  return { child, ready, exited, output: () => ({ stdout, stderr }) };
}

interface Discovery {
  protocolVersion: number;
  host: string;
  port: number;
  token: string;
  pid: number;
}
function discovery(directory: string): Discovery {
  return JSON.parse(readFileSync(join(directory, "connection.json"), "utf8"));
}

async function connectGame(info: Discovery) {
  const socket = createConnection({ host: info.host, port: info.port });
  await once(socket, "connect");
  const peer = new RpcPeer(socket);
  peers.add(peer);
  await peer.call("bridge.hello", { protocolVersion: 1, role: "game", token: info.token });
  return peer;
}

describe("packaged CLI", () => {
  it("prints usage without touching state or starting Pi", () => {
    const root = temporaryDirectory();
    const bin = join(root, "bin");
    const marker = join(root, "pi-started");
    const data = join(root, "data");
    mkdirSync(bin, { mode: 0o700 });
    writeFileSync(
      join(bin, "pi"),
      "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.PI_MARKER, 'started');\n",
      { mode: 0o700 },
    );
    const result = runCli(["--help", "--data-dir", data], {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      PI_MARKER: marker,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: ai-director");
    expect(result.stdout).toContain("--bridge-only");
    expect(result.stderr).toBe("");
    expect(existsSync(data)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("reports unsupported arguments instead of pretending to run", () => {
    const result = runCli(["--unknown"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown option");
  });

  it("requires explicit bridge-only mode until production Pi is integrated", () => {
    const home = temporaryDirectory();
    const result = runCli([], { HOME: home });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--bridge-only");
    expect(readdirSync(home)).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("private CLI bridge lifecycle", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "publishes private discovery, persists real TCP observations, and stops on %s",
    async (signal) => {
      const directory = join(temporaryDirectory(), "private state");
      const app = startCli(["--bridge-only", "--data-dir", directory]);
      await app.ready;
      const info = discovery(directory);
      expect(info).toEqual({
        protocolVersion: 1,
        host: "127.0.0.1",
        port: expect.any(Number),
        token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        pid: app.child.pid,
      });
      expect(info.port).toBeGreaterThan(0);
      expect(lstatSync(directory).mode & 0o777).toBe(0o700);
      for (const name of readdirSync(directory)) {
        const stat = lstatSync(join(directory, name));
        expect(stat.isFile()).toBe(true);
        expect(stat.mode & 0o777).toBe(0o600);
        expect(stat.uid).toBe(process.getuid!());
      }
      const game = await connectGame(info);
      const binding = (await game.call("game.attach", {
        worldId: "cli-world",
        playerId: "cli-player",
        supportedEvents: ["block_broken"],
        paused: false,
      })) as WorldBinding;
      await game.call("game.ready", binding);
      const observation = {
        ...binding,
        event: "block_broken",
        seq: 1,
        tick: 10,
        observedAt: 1_000,
        dimension: "minecraft:overworld",
        position: [0, 64, 0],
        data: { blockId: "minecraft:stone", position: [1, 64, 0] },
      };
      await game.call("game.event", observation);
      const contender = runCli(["--bridge-only", "--data-dir", directory]);
      expect(contender.status).toBe(1);
      expect(contender.stderr).toContain("already exists");
      expect(discovery(directory)).toEqual(info);
      expect(contender.stderr).not.toContain(info.token);
      app.child.kill(signal);
      expect(await app.exited).toEqual({ code: 0, signal: null });
      expect(game.isClosed).toBe(true);
      expect(existsSync(join(directory, "connection.json"))).toBe(false);
      expect(readdirSync(directory)).toEqual(["history.sqlite"]);
      expect(app.output().stdout + app.output().stderr).not.toContain(info.token);
      const db = new DatabaseSync(join(directory, "history.sqlite"), { readOnly: true });
      try {
        const row = db.prepare("SELECT observation_json FROM events").get();
        expect(JSON.parse(row?.observation_json as string)).toEqual(observation);
      } finally {
        db.close();
      }
      const restarted = startCli(["--bridge-only", "--data-dir", directory]);
      await restarted.ready;
      expect(discovery(directory).token).not.toBe(info.token);
      restarted.child.kill(signal);
      expect(await restarted.exited).toEqual({ code: 0, signal: null });
      expect(readdirSync(directory)).toEqual(["history.sqlite"]);
    },
  );

  it("cleans published discovery if its output pipe closes before readiness", async () => {
    const directory = join(temporaryDirectory(), "data");
    const app = startCli(["--bridge-only", "--data-dir", directory]);
    app.child.stdout.destroy();
    await expect(app.ready).rejects.toThrow("CLI exited before readiness");
    expect(await app.exited).toEqual({ code: 1, signal: null });
    expect(app.output().stderr).toContain("EPIPE");
    expect(readdirSync(directory)).toEqual(["history.sqlite"]);
  });

  it("uses a private directory in HOME by default", async () => {
    const home = temporaryDirectory();
    const app = startCli(["--bridge-only"], { HOME: home });
    await app.ready;
    expect(discovery(join(home, ".mc-hisyo")).pid).toBe(app.child.pid);
    app.child.kill("SIGTERM");
    expect(await app.exited).toEqual({ code: 0, signal: null });
  });

  it.each([0o755, 0o750])("refuses existing directory mode %s without chmod", (mode) => {
    const directory = join(temporaryDirectory(), "data");
    mkdirSync(directory, { mode });
    chmodSync(directory, mode);
    const result = runCli(["--bridge-only", "--data-dir", directory]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("0700");
    expect(lstatSync(directory).mode & 0o777).toBe(mode);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("rejects a symlink data directory rather than changing its target", () => {
    const root = temporaryDirectory();
    const target = join(root, "target");
    const link = join(root, "link");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, link);
    const result = runCli(["--bridge-only", "--data-dir", link]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("directory");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readdirSync(target)).toEqual([]);
  });

  it.each(["file", "symlink", "directory"])("preserves existing discovery %s", (kind) => {
    const root = temporaryDirectory();
    const directory = join(root, "data");
    mkdirSync(directory, { mode: 0o700 });
    const file = join(directory, "connection.json");
    const secret = "existing private discovery; never include in diagnostics";
    if (kind === "directory") mkdirSync(file, { mode: 0o700 });
    else if (kind === "symlink") {
      const target = join(root, "secret");
      writeFileSync(target, secret, { mode: 0o600 });
      symlinkSync(target, file);
    } else writeFileSync(file, secret, { mode: 0o600 });
    const result = runCli(["--bridge-only", "--data-dir", directory]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists");
    expect(result.stderr).not.toContain(secret);
    expect(readdirSync(directory)).toEqual(["connection.json"]);
    if (kind === "directory") expect(lstatSync(file).isDirectory()).toBe(true);
    else {
      expect(readFileSync(file, "utf8")).toBe(secret);
      expect(lstatSync(file).isSymbolicLink()).toBe(kind === "symlink");
    }
  });

  it.each(["history.sqlite", "history.sqlite-wal", "history.sqlite-shm", "history.sqlite-journal"])(
    "rejects a symlink %s before opening SQLite",
    (name) => {
      const root = temporaryDirectory();
      const directory = join(root, "data");
      const target = join(root, "unrelated");
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(target, "unrelated bytes", { mode: 0o600 });
      symlinkSync(target, join(directory, name));
      const result = runCli(["--bridge-only", "--data-dir", directory]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/regular|symlink/);
      expect(readFileSync(target, "utf8")).toBe("unrelated bytes");
      expect(readdirSync(directory)).toEqual([name]);
    },
  );

  it.each(["mode", "hardlink"])("rejects unsafe regular SQLite file %s", (kind) => {
    const root = temporaryDirectory();
    const directory = join(root, "data");
    mkdirSync(directory, { mode: 0o700 });
    const file = join(directory, "history.sqlite");
    writeFileSync(file, "not a database; leave untouched", { mode: 0o600 });
    if (kind === "mode") chmodSync(file, 0o644);
    else linkSync(file, join(root, "alias"));
    const result = runCli(["--bridge-only", "--data-dir", directory]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("0600");
    expect(readFileSync(file, "utf8")).toBe("not a database; leave untouched");
    expect(readdirSync(directory)).toEqual(["history.sqlite"]);
    expect(lstatSync(file).mode & 0o777).toBe(kind === "mode" ? 0o644 : 0o600);
    expect(lstatSync(file).nlink).toBe(kind === "hardlink" ? 2 : 1);
  });

  it.each(["rename", "unlink/recreate"])(
    "preserves discovery replaced by %s and reports the failed ownership check",
    async (kind) => {
      const root = temporaryDirectory();
      const directory = join(root, "data");
      const app = startCli(["--bridge-only", "--data-dir", directory]);
      await app.ready;
      const file = join(directory, "connection.json");
      const saved = join(directory, "saved-connection.json");
      for (const path of [file, saved]) {
        expect(resolve(path)).toBe(path);
        expect(relative(root, path)).not.toMatch(/^\.\.(?:\/|$)/);
      }
      if (kind === "rename") renameSync(file, saved);
      else unlinkSync(file);
      writeFileSync(file, "replacement", { mode: 0o600, flag: "wx" });
      app.child.kill("SIGTERM");
      expect(await app.exited).toEqual({ code: 1, signal: null });
      expect(app.output().stderr).toContain("replaced");
      expect(readFileSync(file, "utf8")).toBe("replacement");
      expect(existsSync(saved)).toBe(kind === "rename");
    },
  );

  it("cleans failed startup without publishing discovery or changing unknown database versions", () => {
    const directory = join(temporaryDirectory(), "data");
    mkdirSync(directory, { mode: 0o700 });
    const file = join(directory, "history.sqlite");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA user_version = 99");
    db.close();
    chmodSync(file, 0o600);
    const result = runCli(["--bridge-only", "--data-dir", directory]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unsupported database version: 99");
    expect(readdirSync(directory)).toEqual(["history.sqlite"]);
    const unchanged = new DatabaseSync(file, { readOnly: true });
    try {
      expect(unchanged.prepare("PRAGMA user_version").get()?.user_version).toBe(99);
    } finally {
      unchanged.close();
    }
  });
});

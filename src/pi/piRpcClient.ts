import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { createPiJsonLineDecoder, encodePiJsonLine, maxPiJudgmentBytes } from "./piFraming.js";
import { checkNativePiModel, type NativePiModelSelector } from "./nativePiModel.js";
import { supportedPiVersion } from "./piPolicy.js";

export interface PiLaunchOptions {
  executable: string;
  prefixArgs?: readonly string[];
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  model: NativePiModelSelector;
  /** Known bundled extension, authenticated and ready on the owning bridge. */
  isAgentReady: () => boolean;
  requestTimeoutMs?: number;
  judgmentTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  onLog?: (event: string, details?: Record<string, unknown>) => void;
}
export type PiJudgment = { status: "not_started" } | { status: "settled"; aborted: boolean };
export class PiRunError extends Error {
  constructor(
    message: string,
    readonly mayHaveStarted: boolean,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "PiRunError";
  }
}

const responseSchema = Type.Union([
  Type.Object({
    type: Type.Literal("response"),
    id: Type.String(),
    command: Type.String(),
    success: Type.Literal(true),
    data: Type.Optional(Type.Unknown()),
  }),
  Type.Object({
    type: Type.Literal("response"),
    id: Type.String(),
    command: Type.String(),
    success: Type.Literal(false),
    error: Type.String(),
  }),
]);
const eventSchema = Type.Object({ type: Type.String({ minLength: 1 }) });
const settledSchema = Type.Object({ type: Type.Literal("agent_settled"), aborted: Type.Boolean() });
const queueSchema = Type.Object({
  steering: Type.Array(Type.String()),
  followUp: Type.Array(Type.String()),
});
const promptSchema = Type.Object({ disposition: Type.Literal("started") });
const toolEventFields = {
  toolCallId: Type.String({ minLength: 1 }),
  toolName: Type.String({ minLength: 1 }),
};
const toolStartSchema = Type.Object({
  ...toolEventFields,
  args: Type.Unknown(),
});
const toolEndSchema = Type.Object({
  ...toolEventFields,
  result: Type.Unknown(),
  isError: Type.Boolean(),
  durationMs: Type.Optional(Type.Number({ minimum: 0 })),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Terminal = { aborted: boolean } | { error: Error };
interface JudgmentSlot {
  sent: boolean;
  cancelled: boolean;
  sawSettled: boolean;
  terminal: ReturnType<typeof deferred<Terminal>>;
  done: ReturnType<typeof deferred<void>>;
  cancellation?: Promise<void>;
  timer?: NodeJS.Timeout;
}
interface Pending {
  command: string;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Launch policy (isolated settings/resources/tools) belongs to the trusted session owner. */
export async function startPiRpcClient(options: PiLaunchOptions): Promise<PiRpcClient> {
  for (const limit of [
    options.requestTimeoutMs,
    options.judgmentTimeoutMs,
    options.shutdownTimeoutMs,
  ])
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
      throw new Error("Invalid Pi lifecycle timeout");
  const prefix = options.prefixArgs ?? [];
  const version = await new Promise<string>((resolve, reject) => {
    execFile(
      options.executable,
      [...prefix, "--version"],
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.requestTimeoutMs ?? 5_000,
        maxBuffer: 4_096,
        killSignal: "SIGKILL",
      },
      (error, stdout) => {
        if (error) reject(new Error("Pi version preflight failed", { cause: error }));
        else resolve(stdout.trim());
      },
    );
  });
  if (version !== supportedPiVersion) throw new Error(`Pi ${supportedPiVersion} is required`);
  const child = spawn(options.executable, [...prefix, ...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new PiRpcClient(child, options);
}

/** Pi's own stdio protocol, NOT the authenticated bridge's JSON-RPC protocol. */
class PiRpcClient extends EventEmitter {
  readonly #decoder = createPiJsonLineDecoder();
  readonly #pending = new Map<string, Pending>();
  readonly #exited = deferred<void>();
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #options: PiLaunchOptions;
  #nextId = 0;
  #modelApi: string | undefined;
  #run: JudgmentSlot | undefined;
  #failure: Error | undefined;
  #stopping = false;
  #closed = false;
  #termination: Promise<void> | undefined;
  #shutdown: Promise<void> | undefined;
  #stderr: Buffer = Buffer.alloc(0);

  /** Use startPiRpcClient so the same executable's exact version is checked first. */
  constructor(child: ChildProcessWithoutNullStreams, options: PiLaunchOptions) {
    super();
    this.#child = child;
    this.#options = { ...options, model: { ...options.model } };
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.#failure) return;
      try {
        this.#decoder.push(chunk, (line) => this.#receive(line));
      } catch (error) {
        this.#fail(error);
      }
    });
    child.stdout.on("end", () => {
      try {
        this.#decoder.finish();
      } catch (error) {
        this.#fail(error);
      }
      if (!this.#stopping || this.#run) this.#fail(new Error("Pi stdout ended before shutdown"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const bytes = Buffer.concat([this.#stderr, chunk]);
      this.#stderr = bytes.subarray(Math.max(0, bytes.length - 16_384));
    });
    child.on("error", (error) => this.#fail(error));
    child.stdin.on("error", (error) => {
      if (!this.#stopping || this.#pending.size) this.#fail(error);
    });
    child.stdout.on("error", (error) => this.#fail(error));
    child.stderr.on("error", (error) => this.#fail(error));
    child.on("close", () => {
      this.#closed = true;
      this.#exited.resolve();
      if (!this.#stopping || this.#run) this.#fail(new Error("Pi exited before judgment settled"));
    });
  }

  get isRetired(): boolean {
    return this.#stopping;
  }
  /** Bounded stderr only; never automatically display it or stdout prose in game. */
  get diagnostics(): string {
    return this.#stderr.toString("utf8");
  }

  /** The session owner's existing readiness deadline also bounds the startup RPC gate. */
  async initialize(signal: AbortSignal): Promise<void> {
    const abort = () => this.#fail(new Error("Pi readiness aborted"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await this.#gate();
      signal.throwIfAborted();
      this.#options.onLog?.("pi.ready", {
        provider: this.#options.model.provider,
        model: this.#options.model.id,
      });
    } catch (error) {
      this.#fail(error);
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  run(message: string, signal?: AbortSignal): Promise<PiJudgment> {
    if (this.#stopping)
      return Promise.reject(new PiRunError("Pi client is retired", false, this.#failure));
    if (this.#run)
      return Promise.reject(new PiRunError("Previous Pi judgment has not settled", false));
    if (
      typeof message !== "string" ||
      !message.length ||
      Buffer.byteLength(message) > maxPiJudgmentBytes
    )
      return Promise.reject(new PiRunError("Invalid Pi judgment message", false));
    const slot: JudgmentSlot = {
      sent: false,
      cancelled: signal?.aborted ?? false,
      sawSettled: false,
      terminal: deferred<Terminal>(),
      done: deferred<void>(),
    };
    this.#run = slot;
    const cancel = () => this.#cancel(slot);
    signal?.addEventListener("abort", cancel, { once: true });
    return this.#execute(slot, message).finally(() => {
      clearTimeout(slot.timer);
      signal?.removeEventListener("abort", cancel);
      if (this.#run === slot) this.#run = undefined;
      slot.done.resolve();
    });
  }

  async #execute(slot: JudgmentSlot, message: string): Promise<PiJudgment> {
    try {
      if (slot.cancelled) return { status: "not_started" };
      await this.#gate(slot);
      if (slot.cancelled) return { status: "not_started" };
      const ack = await this.#request("prompt", { message }, () => {
        // write(false) still submits; never retry a frame after backpressure.
        slot.sent = true;
        this.#options.onLog?.("pi.prompt_submitted");
        slot.timer = setTimeout(
          () => this.#fail(new Error("Pi judgment did not settle")),
          this.#options.judgmentTimeoutMs ?? 300_000,
        );
      });
      if (!Check(promptSchema, ack)) throw new Error("Pi prompt was not started exclusively");
      if (slot.cancelled) {
        await slot.cancellation;
        // Pi may ACK an idle abort during prompt preflight, then reset its abort flag at start.
        // A started ACK proves that preflight is past; keep this slot until the fresh abort ACK.
        if (!slot.sawSettled) await this.#request("abort");
      }
      const terminal = await slot.terminal.promise;
      if ("error" in terminal) throw terminal.error;
      if (slot.cancellation) await slot.cancellation;
      if (this.#failure) throw this.#failure;
      return { status: "settled", aborted: terminal.aborted };
    } catch (error) {
      this.#fail(error);
      throw new PiRunError("Pi judgment failed", slot.sent, error);
    }
  }

  async #gate(slot?: JudgmentSlot): Promise<void> {
    const api = await checkNativePiModel(
      this.#options.model,
      (command) => this.#request(command),
      () => {
        if (slot?.cancelled) return false;
        if (this.#failure) throw this.#failure;
        if (!this.#options.isAgentReady())
          throw new Error("Authenticated Pi extension is not ready");
        return true;
      },
      this.#modelApi,
    );
    if (api !== undefined) this.#modelApi = api;
  }

  #cancel(slot: JudgmentSlot): void {
    slot.cancelled = true;
    if (slot.sent && !slot.cancellation) {
      slot.cancellation = (async () => {
        const [, queues] = await Promise.all([
          this.#request("abort"),
          this.#request("clear_queue"),
        ]);
        if (!Check(queueSchema, queues) || queues.steering.length || queues.followUp.length)
          throw new Error("Unexpected Pi queued input during cancellation");
      })();
      void slot.cancellation.catch((error: unknown) => this.#fail(error));
    }
  }

  /** The run promise (not abort ACK) reports settled or failed. Owner invalidates binding first. */
  async cancel(): Promise<void> {
    const slot = this.#run;
    if (!slot) return;
    this.#cancel(slot);
    await slot.done.promise;
  }

  #request(
    command: string,
    args: Record<string, unknown> = {},
    beforeWrite?: () => void,
  ): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      const id = String(++this.#nextId);
      const frame = encodePiJsonLine({ id, type: command, ...args });
      if (
        this.#pending.size >= 64 ||
        this.#child.stdin.writableLength + frame.length > 4 * 1024 * 1024
      )
        throw new Error("Pi outgoing request limit exceeded");
      const timer = setTimeout(
        () => this.#fail(new Error(`Pi ${command} response timed out`)),
        this.#options.requestTimeoutMs ?? 5_000,
      );
      this.#pending.set(id, { command, resolve, reject, timer });
      beforeWrite?.();
      this.#child.stdin.write(frame, (error) => {
        if (error) this.#fail(error);
      });
    });
  }

  #receive(line: string): void {
    if (this.#failure) return;
    const value: unknown = JSON.parse(line);
    if (!Check(eventSchema, value)) throw new Error("Invalid Pi stdout event");
    if (value.type === "response") {
      if (!Check(responseSchema, value)) throw new Error("Invalid Pi response");
      const pending = this.#pending.get(value.id);
      if (!pending || pending.command !== value.command)
        throw new Error("Uncorrelated Pi response");
      if (!value.success) throw new Error(`Pi ${pending.command} command failed`);
      clearTimeout(pending.timer);
      this.#pending.delete(value.id);
      pending.resolve(value.data);
    } else if (value.type === "agent_settled") {
      const slot = this.#run;
      if (!Check(settledSchema, value) || !slot?.sent || slot.sawSettled)
        throw new Error("Unexpected Pi settlement");
      slot.sawSettled = true;
      this.#options.onLog?.("pi.agent_settled", { aborted: value.aborted });
      slot.terminal.resolve({ aborted: value.aborted });
    } else if (value.type === "tool_execution_start") {
      if (!Check(toolStartSchema, value)) throw new Error("Invalid Pi tool execution start");
      this.#options.onLog?.(value.type, {
        toolCallId: value.toolCallId,
        toolName: value.toolName,
        args: value.args,
      });
    } else if (value.type === "tool_execution_end") {
      if (!Check(toolEndSchema, value)) throw new Error("Invalid Pi tool execution end");
      this.#options.onLog?.(value.isError ? "tool_execution_error" : value.type, {
        toolCallId: value.toolCallId,
        toolName: value.toolName,
        isError: value.isError,
        durationMs: value.durationMs,
        result: value.result,
      });
    }
    // Assistant prose, raw stderr and unrelated RPC fields are deliberately not logged.
  }

  #fail(cause: unknown): void {
    if (this.#failure) return;
    const error = cause instanceof Error ? cause : new Error("Pi protocol failed", { cause });
    this.#failure = error;
    this.#stopping = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#run?.terminal.resolve({ error });
    this.emit("fault", error);
    // Cleanup errors remain observable through close(), without unhandled rejections.
    void this.#terminate().catch(() => {});
  }

  close(): Promise<void> {
    this.#stopping = true;
    return (this.#shutdown ??= (async () => {
      const timer =
        this.#run &&
        setTimeout(
          () => this.#fail(new Error("Pi did not settle during shutdown")),
          this.#options.shutdownTimeoutMs ?? 1_000,
        );
      try {
        await this.cancel();
      } finally {
        if (timer) clearTimeout(timer);
      }
      await this.#terminate();
    })());
  }

  #terminate(): Promise<void> {
    return (this.#termination ??= (async () => {
      if (this.#closed) return;
      this.#child.stdin.end();
      if (await this.#waitForExit()) return;
      this.#child.kill("SIGTERM");
      if (await this.#waitForExit()) return;
      this.#child.kill("SIGKILL");
      if (!(await this.#waitForExit())) throw new Error("Pi child did not terminate");
    })());
  }

  #waitForExit(): Promise<boolean> {
    if (this.#closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), this.#options.shutdownTimeoutMs ?? 1_000);
      void this.#exited.promise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

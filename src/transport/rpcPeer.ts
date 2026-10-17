import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { Check } from "typebox/value";
import {
  RpcIdSchema,
  RpcMethodSchema,
  RpcNotificationSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  type RpcId,
  type RpcNotification,
  type RpcParams,
  type RpcRequest,
} from "../protocol/jsonRpc.js";
import { defaultMaxFrameBytes, encodeJsonLine, JsonLineDecoder } from "./jsonLines.js";

type Handler = (params: unknown) => unknown;
interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface PeerOptions {
  maxFrameBytes?: number;
  timeoutMs?: number;
}
const maxPendingRequests = 64;
const maxQueuedBytes = 4 * defaultMaxFrameBytes;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Bidirectional local JSON-RPC; authentication and world/run binding belong to its owner. */
export class RpcPeer extends EventEmitter<{ close: [reason: Error] }> {
  readonly #socket: Socket;
  readonly #decoder: JsonLineDecoder;
  readonly #timeoutMs: number;
  readonly #pending = new Map<RpcId, Pending>();
  readonly #incoming = new Set<RpcId>();
  readonly #handlers = new Map<string, Handler>();
  #nextId = 0;
  #asyncNotifications = 0;
  #failure: Error | undefined;

  constructor(socket: Socket, options: PeerOptions = {}) {
    super();
    this.#socket = socket;
    this.#decoder = new JsonLineDecoder(options.maxFrameBytes);
    this.#timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1)
      throw new Error("Invalid RPC timeout");
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      if (this.isClosed) return;
      try {
        this.#decoder.push(chunk, (line) => {
          if (!this.isClosed) this.#receive(line);
        });
      } catch (error) {
        this.close(asError(error));
      }
    });
    socket.on("end", () => {
      try {
        this.#decoder.finish();
      } catch (error) {
        this.close(asError(error));
        return;
      }
      this.close(new Error("RPC connection ended"));
    });
    socket.on("error", (error) => this.close(error));
    socket.on("close", () => this.close(new Error("RPC connection closed")));
  }

  get isClosed(): boolean {
    return this.#failure !== undefined;
  }

  handle(method: string, handler: Handler): void {
    if (this.#failure) throw this.#failure;
    if (!Check(RpcMethodSchema, method)) throw new Error("Invalid RPC method");
    if (this.#handlers.has(method)) throw new Error(`Duplicate RPC handler: ${method}`);
    this.#handlers.set(method, handler);
  }

  async call(method: string, params: RpcParams): Promise<unknown> {
    if (this.#failure) throw this.#failure;
    if (this.#pending.size >= maxPendingRequests)
      throw new Error("RPC pending request limit reached");
    const id = String(++this.#nextId);
    const message = { jsonrpc: "2.0", id, method, params };
    if (!Check(RpcRequestSchema, message)) throw new Error("Invalid outgoing RPC request");
    const frame = encodeJsonLine(message, this.#decoder.maxFrameBytes);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.close(new Error(`RPC request ${method} timed out`)),
        this.#timeoutMs,
      );
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#write(frame);
      } catch (error) {
        this.close(asError(error));
      }
    });
  }

  notify(method: string, params: RpcParams): void {
    const message = { jsonrpc: "2.0", method, params };
    if (!Check(RpcNotificationSchema, message))
      throw new Error("Invalid outgoing RPC notification");
    this.#write(encodeJsonLine(message, this.#decoder.maxFrameBytes));
  }

  close(reason = new Error("RPC peer closed")): void {
    if (this.isClosed) return;
    this.#failure = reason;
    this.#socket.destroy();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.#pending.clear();
    this.#incoming.clear();
    this.#handlers.clear();
    this.emit("close", reason);
  }

  #write(frame: Buffer): void {
    if (this.#failure) throw this.#failure;
    if (this.#socket.writableLength + frame.length > maxQueuedBytes) {
      const error = new Error("RPC outgoing byte queue limit reached");
      this.close(error);
      throw error;
    }
    this.#socket.write(frame);
  }

  #receive(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#replyError(null, new RpcError(-32700, "Parse error"));
      return;
    }
    if (Check(RpcRequestSchema, message)) {
      this.#request(message);
      return;
    }
    if (Check(RpcNotificationSchema, message)) {
      this.#notification(message);
      return;
    }
    if (Check(RpcResponseSchema, message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        this.close(new Error("Unexpected RPC response ID"));
        return;
      }
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if ("error" in message)
        pending.reject(new RpcError(message.error.code, message.error.message, message.error.data));
      else pending.resolve(message.result);
      return;
    }
    let id: RpcId = null;
    if (message && typeof message === "object") {
      if ("result" in message || "error" in message) {
        this.close(new Error("Malformed RPC response"));
        return;
      }
      if ("method" in message && !("id" in message)) {
        this.close(new Error("Malformed RPC notification"));
        return;
      }
      if ("id" in message && Check(RpcIdSchema, message.id)) id = message.id;
    }
    this.#replyError(id, new RpcError(-32600, "Invalid request"));
  }

  #request(message: RpcRequest): void {
    if (this.#incoming.has(message.id)) {
      this.close(new Error("Duplicate active RPC request ID"));
      return;
    }
    if (this.#incoming.size >= maxPendingRequests) {
      this.#replyError(message.id, new RpcError(-32000, "RPC incoming request limit reached"));
      return;
    }
    const handler = this.#handlers.get(message.method);
    if (!handler) {
      this.#replyError(message.id, new RpcError(-32601, "Method not found"));
      return;
    }
    this.#incoming.add(message.id);
    try {
      const result = handler(message.params);
      void Promise.resolve(result).then(
        (value) => {
          this.#incoming.delete(message.id);
          if (this.isClosed) return;
          try {
            if (value === undefined) throw new Error("RPC request handler returned no result");
            this.#write(
              encodeJsonLine(
                { jsonrpc: "2.0", id: message.id, result: value },
                this.#decoder.maxFrameBytes,
              ),
            );
          } catch (error) {
            this.#replyError(message.id, error);
          }
        },
        (error: unknown) => {
          this.#incoming.delete(message.id);
          this.#replyError(message.id, error);
        },
      );
    } catch (error) {
      this.#incoming.delete(message.id);
      this.#replyError(message.id, error);
    }
  }

  #notification(message: RpcNotification): void {
    const handler = this.#handlers.get(message.method);
    if (!handler || this.#asyncNotifications >= maxPendingRequests) {
      this.close(new Error("Unsupported or overloaded RPC notification"));
      return;
    }
    try {
      const result = handler(message.params);
      if (result instanceof Promise) {
        this.#asyncNotifications++;
        void result.then(
          () => {
            this.#asyncNotifications--;
          },
          (error: unknown) => this.close(asError(error)),
        );
      }
    } catch (error) {
      this.close(asError(error));
    }
  }

  #replyError(id: RpcId, error: unknown): void {
    if (this.isClosed) return;
    const failure = error instanceof RpcError ? error : new RpcError(-32603, "Internal error");
    const data = failure.data === undefined ? {} : { data: failure.data };
    try {
      this.#write(
        encodeJsonLine(
          { jsonrpc: "2.0", id, error: { code: failure.code, message: failure.message, ...data } },
          this.#decoder.maxFrameBytes,
        ),
      );
    } catch (sendError) {
      this.close(asError(sendError));
    }
  }
}

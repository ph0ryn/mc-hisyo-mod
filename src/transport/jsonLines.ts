import { TextDecoder } from "node:util";

export const defaultMaxFrameBytes = 1024 * 1024;

export function encodeJsonLine(value: unknown, maxFrameBytes = defaultMaxFrameBytes): Buffer {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Value cannot be encoded as JSON");
  const frame = Buffer.from(`${json}\n`, "utf8");
  if (frame.length - 1 > maxFrameBytes) throw new Error("JSONL frame exceeds byte limit");
  return frame;
}

/** LF framing is byte-based, so split multibyte UTF-8 is decoded only after a complete frame. */
export class JsonLineDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(readonly maxFrameBytes = defaultMaxFrameBytes) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1)
      throw new Error("Invalid frame byte limit");
  }

  push(chunk: Buffer, onLine: (line: string) => void): void {
    const data = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    let start = 0;
    for (let end = data.indexOf(10, start); end !== -1; end = data.indexOf(10, start)) {
      if (end - start > this.maxFrameBytes) throw new Error("JSONL frame exceeds byte limit");
      onLine(this.#decoder.decode(data.subarray(start, end)));
      start = end + 1;
    }
    this.#buffer = data.subarray(start);
    if (this.#buffer.length > this.maxFrameBytes) throw new Error("JSONL frame exceeds byte limit");
  }

  finish(): void {
    if (this.#buffer.length) throw new Error("Incomplete JSONL frame at EOF");
  }
}

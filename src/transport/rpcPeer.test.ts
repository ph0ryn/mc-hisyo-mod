import { once } from "node:events";
import { connect, createServer, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { RpcError, RpcPeer } from "./rpcPeer.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function sockets(): Promise<{ raw: Socket; accepted: Socket }> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  const incoming = once(server, "connection");
  const raw = connect(address.port, "127.0.0.1");
  await once(raw, "connect");
  const [accepted] = (await incoming) as [Socket];
  cleanup.push(async () => {
    raw.destroy();
    accepted.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return { raw, accepted };
}

async function peers(
  options: { timeoutMs?: number } = {},
): Promise<{ client: RpcPeer; server: RpcPeer }> {
  const { raw, accepted } = await sockets();
  const client = new RpcPeer(raw, options);
  const server = new RpcPeer(accepted);
  return { client, server };
}

describe("local JSONL JSON-RPC over real TCP", () => {
  test("correlates simultaneous bidirectional requests, including reversed replies", async () => {
    const { client, server } = await peers();
    let release: ((value: unknown) => void) | undefined;
    server.handle(
      "slow",
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    server.handle("fast", (params) => params);
    client.handle("reverse", (params) => params);
    const slow = client.call("slow", {});
    expect(await client.call("fast", { value: 2 })).toEqual({ value: 2 });
    expect(await server.call("reverse", ["server request"])).toEqual(["server request"]);
    expect(release).toBeDefined();
    release?.({ value: 1 });
    expect(await slow).toEqual({ value: 1 });
  });

  test("preserves notifications, coalesced frames, and multibyte UTF-8 split between TCP chunks", async () => {
    const { raw, accepted } = await sockets();
    const server = new RpcPeer(accepted);
    const values: unknown[] = [];
    let complete!: () => void;
    const delivered = new Promise<void>((resolve) => {
      complete = resolve;
    });
    server.handle("observe", (params) => {
      values.push(params);
      if (values.length === 3) complete();
    });
    const first = Buffer.from('{"jsonrpc":"2.0","method":"observe","params":{"text":"石"}}\n');
    const split = first.indexOf(Buffer.from("石")) + 1;
    const received = once(accepted, "data");
    raw.write(first.subarray(0, split));
    await received;
    expect(values).toEqual([]);
    raw.write(
      Buffer.concat([
        first.subarray(split),
        Buffer.from(
          '{"jsonrpc":"2.0","method":"observe","params":[2]}\n{"jsonrpc":"2.0","method":"observe","params":[3]}\n',
        ),
      ]),
    );
    await delivered;
    expect(values).toEqual([{ text: "石" }, [2], [3]]);
  });

  test("returns method and application errors without losing the connection", async () => {
    const { client, server } = await peers();
    server.handle("blocked", () => {
      throw new RpcError(-32001, "Stale run", { runId: "old" });
    });
    server.handle("echo", (params) => params);
    await expect(client.call("unknown", {})).rejects.toMatchObject({ code: -32601 });
    await expect(client.call("blocked", {})).rejects.toMatchObject({
      code: -32001,
      message: "Stale run",
      data: { runId: "old" },
    });
    expect(await client.call("echo", { alive: true })).toEqual({ alive: true });
  });

  test("returns explicit JSON-RPC errors for malformed JSON, invalid requests, and unsupported batches", async () => {
    const { raw, accepted } = await sockets();
    new RpcPeer(accepted);
    let buffered = "";
    const responses: unknown[] = [];
    const delivered = new Promise<void>((resolve) => {
      raw.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) responses.push(JSON.parse(line));
        if (responses.length === 3) resolve();
      });
    });
    raw.write('{broken\n{"jsonrpc":"2.0","id":42,"method":7}\n[]\n');
    await delivered;
    expect(responses).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { jsonrpc: "2.0", id: 42, error: { code: -32600, message: "Invalid request" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } },
    ]);
  });

  test("fails pending requests on disconnect and never replays a side effect", async () => {
    const { client, server } = await peers();
    let effects = 0;
    server.handle("display", () => {
      effects++;
      server.close(new Error("Disconnected after display"));
      return { displayed: true };
    });
    await expect(client.call("display", { text: "once" })).rejects.toThrow();
    await expect(client.call("display", { text: "once" })).rejects.toThrow();
    expect(effects).toBe(1);
    expect(client.isClosed).toBe(true);
  });

  test("timeout closes the peer and fails every pending request", async () => {
    const { client, server } = await peers({ timeoutMs: 40 });
    server.handle("stalled", () => new Promise(() => {}));
    const results = await Promise.allSettled([
      client.call("stalled", {}),
      client.call("stalled", {}),
    ]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(String(result.reason)).toContain("timed out");
    }
    expect(client.isClosed).toBe(true);
  });

  test("bounds unterminated frames and reports truncated EOF instead of fabricating an event", async () => {
    for (const oversized of [true, false]) {
      const { raw, accepted } = await sockets();
      const server = new RpcPeer(accepted, { maxFrameBytes: 128 });
      let observations = 0;
      server.handle("observe", () => {
        observations++;
      });
      const closed = once(server, "close");
      if (oversized) raw.write("x".repeat(129));
      else raw.end('{"jsonrpc":"2.0","method":"observe"');
      const [reason] = await closed;
      expect(String(reason)).toMatch(oversized ? /frame.*limit/i : /incomplete/i);
      expect(observations).toBe(0);
    }
  });

  test("bounds outgoing pending requests rather than silently queueing indefinitely", async () => {
    const { client, server } = await peers();
    server.handle("stalled", () => new Promise(() => {}));
    const calls = Array.from({ length: 64 }, () => client.call("stalled", {}));
    const finished = Promise.allSettled(calls);
    await expect(client.call("stalled", {})).rejects.toThrow(/pending request/i);
    client.close();
    expect((await finished).every((result) => result.status === "rejected")).toBe(true);
  });

  test("malformed notifications close before subsequent observations can hide their loss", async () => {
    const { raw, accepted } = await sockets();
    const server = new RpcPeer(accepted);
    let observations = 0;
    const outcome = new Promise<string>((resolve) => {
      server.once("close", () => resolve("closed"));
      server.handle("observe", () => {
        observations++;
        resolve("delivered");
      });
    });
    raw.write(
      '{"jsonrpc":"2.0","method":"observe","params":null}\n{"jsonrpc":"2.0","method":"observe","params":{}}\n',
    );
    expect(await outcome).toBe("closed");
    expect(observations).toBe(0);
  });

  test("rejects unexpected response IDs and invalid UTF-8 without executing following frames", async () => {
    for (const invalidEncoding of [false, true]) {
      const { raw, accepted } = await sockets();
      const server = new RpcPeer(accepted);
      let observations = 0;
      server.handle("observe", () => {
        observations++;
      });
      const closed = once(server, "close");
      raw.write(
        Buffer.concat([
          invalidEncoding
            ? Buffer.from([0xc3, 0x28, 10])
            : Buffer.from('{"jsonrpc":"2.0","id":"unknown","result":true}\n'),
          Buffer.from('{"jsonrpc":"2.0","method":"observe","params":{}}\n'),
        ]),
      );
      const [reason] = await closed;
      expect(String(reason)).toMatch(invalidEncoding ? /encoding|utf/i : /response ID/);
      expect(observations).toBe(0);
    }
  });

  test("rejects oversized calls locally and returns explicit errors for oversized or absent results", async () => {
    const { raw, accepted } = await sockets();
    const client = new RpcPeer(raw, { maxFrameBytes: 128 });
    const server = new RpcPeer(accepted, { maxFrameBytes: 128 });
    let calls = 0;
    server.handle("echo", (params) => {
      calls++;
      return params;
    });
    server.handle("large", () => "x".repeat(200));
    server.handle("absent", () => undefined);
    await expect(client.call("echo", { text: "x".repeat(200) })).rejects.toThrow(/frame.*limit/i);
    expect(calls).toBe(0);
    await expect(client.call("large", {})).rejects.toMatchObject({ code: -32603 });
    await expect(client.call("absent", {})).rejects.toMatchObject({ code: -32603 });
    expect(await client.call("echo", { stillConnected: true })).toEqual({ stillConnected: true });
  });
});

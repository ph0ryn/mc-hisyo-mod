import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { expect, test, vi } from "vite-plus/test";
import { RpcPeer } from "./rpcPeer.js";

function fixture() {
  const socket = Object.assign(new EventEmitter(), {
    writableLength: 0,
    write: vi.fn(() => true),
    destroy: vi.fn(),
    setNoDelay: vi.fn(),
  });
  return { socket, peer: new RpcPeer(socket as unknown as Socket) };
}

test("a long per-call model deadline does not change the normal five-second RPC deadline", async () => {
  vi.useFakeTimers();
  const { peer, socket } = fixture();
  try {
    const summary = peer.call("hisyo.summary.create", {}, 300_000);
    await vi.advanceTimersByTimeAsync(5001);
    expect(peer.isClosed).toBe(false);
    socket.emit(
      "data",
      Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: "1", result: "summary" })}\n`),
    );
    expect(await summary).toBe("summary");
    expect(vi.getTimerCount()).toBe(0);
    const normal = peer.call("game.state.get", {});
    const rejected = expect(normal).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(4999);
    expect(peer.isClosed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(socket.destroy).toHaveBeenCalledOnce();
  } finally {
    peer.close();
    vi.useRealTimers();
  }
});

test("long completions still expire and close their pending transport", async () => {
  vi.useFakeTimers();
  const { peer } = fixture();
  try {
    const pending = peer.call("hisyo.summary.create", {}, 300_000);
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(300_000);
    await rejected;
    expect(peer.isClosed).toBe(true);
  } finally {
    peer.close();
    vi.useRealTimers();
  }
});

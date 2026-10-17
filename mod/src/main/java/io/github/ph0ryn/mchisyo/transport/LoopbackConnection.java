package io.github.ph0ryn.mchisyo.transport;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** One owned connection, no reconnect/replay. Construction has no I/O or worker startup.
 * Keep this owner before start(), register handlers on peer(), then await ready asynchronously.
 * Ready means TCP only, NOT authenticated/attached/game-ready. Never join it on a game thread. */
public final class LoopbackConnection implements AutoCloseable {
    private static final int CONNECT_TIMEOUT_MILLIS = 5000;
    private final Object state = new Object();
    private final int port;
    private final RpcPeer peer;
    private final CompletableFuture<RpcPeer> ready = new CompletableFuture<>();
    private final ArrayDeque<byte[]> writes = new ArrayDeque<>();
    private boolean started;
    private boolean retired;
    private boolean connected;
    private int queuedBytes; // Includes the frame currently being written.
    private Socket socket;
    private ScheduledThreadPoolExecutor deadlines;
    private Thread reader;
    private Thread writer;

    public LoopbackConnection(int port) {
        if (port < 1 || port > 65535) throw new IllegalArgumentException("Invalid loopback port");
        this.port = port;
        this.peer = new RpcPeer(new RpcPeer.Port() {
            public void write(byte[] frame) { enqueue(frame); }
            public RpcPeer.Deadline schedule(long delay, Runnable expiry) { return scheduleDeadline(delay, expiry); }
            public void close() { retire(); }
        });
    }

    public RpcPeer peer() { return peer; }
    public CompletionStage<RpcPeer> ready() { return ready.minimalCompletionStage(); }

    /** Start once; returns immediately. The owner remains closable while connect is in progress. */
    public CompletionStage<RpcPeer> start() {
        RuntimeException failure = null;
        synchronized (state) {
            if (retired || started) throw new IllegalStateException("Connection already started or closed");
            started = true;
            deadlines = new ScheduledThreadPoolExecutor(1, task -> daemon("mc-hisyo-rpc-deadline", task));
            deadlines.setRemoveOnCancelPolicy(true);
            deadlines.setExecuteExistingDelayedTasksAfterShutdownPolicy(false);
            reader = daemon("mc-hisyo-rpc-reader", this::readLoop);
            writer = daemon("mc-hisyo-rpc-writer", this::writeLoop);
            // Start retirement first: it can close a blocked connect/write even after partial startup.
            try {
                daemon("mc-hisyo-rpc-retire", this::retireLoop).start();
                writer.start();
                reader.start();
            } catch (RuntimeException startupFailure) { failure = new IllegalStateException("RPC worker startup failed"); }
        }
        if (failure != null) peer.close(failure);
        return ready();
    }

    @Override public void close() { peer.close(); }

    private static Thread daemon(String name, Runnable task) {
        Thread thread = new Thread(task, name);
        thread.setDaemon(true);
        return thread;
    }

    private void enqueue(byte[] frame) {
        synchronized (state) {
            if (retired || !connected) throw new IllegalStateException("RPC socket is not ready");
            if (frame.length > RpcPeer.MAX_QUEUED_BYTES - queuedBytes) throw new IllegalStateException("RPC outgoing byte queue limit reached");
            writes.addLast(frame); queuedBytes += frame.length;
            state.notifyAll();
        }
    }

    private RpcPeer.Deadline scheduleDeadline(long delay, Runnable expiry) {
        synchronized (state) {
            if (retired || !connected) throw new IllegalStateException("RPC socket is not ready");
            var future = deadlines.schedule(expiry, delay, TimeUnit.MILLISECONDS);
            return () -> future.cancel(false);
        }
    }

    private void readLoop() {
        try {
            Socket opened = new Socket();
            boolean alreadyRetired;
            synchronized (state) {
                alreadyRetired = retired;
                if (!alreadyRetired) socket = opened;
            }
            if (alreadyRetired) { opened.close(); return; }
            // A literal address has no DNS or arbitrary-host path.
            opened.connect(new InetSocketAddress(InetAddress.getByAddress(new byte[] {127, 0, 0, 1}), port), CONNECT_TIMEOUT_MILLIS);
            opened.setTcpNoDelay(true);
            synchronized (state) {
                if (retired) return;
                connected = true;
                state.notifyAll();
            }
            ready.complete(peer);
            InputStream input = opened.getInputStream();
            byte[] chunk = new byte[8192];
            for (int count; !peer.isClosed() && (count = input.read(chunk)) != -1;) {
                peer.receive(Arrays.copyOf(chunk, count));
            }
            peer.endOfInput();
        } catch (IOException | RuntimeException fault) { peer.close(new IllegalStateException("RPC socket read/connect failed")); }
    }

    private void writeLoop() {
        try {
            while (true) {
                byte[] frame;
                Socket opened;
                synchronized (state) {
                    while (!retired && (!connected || writes.isEmpty())) state.wait();
                    if (retired) return;
                    frame = writes.removeFirst(); opened = socket;
                }
                OutputStream output = opened.getOutputStream();
                output.write(frame);
                synchronized (state) { if (!retired) queuedBytes -= frame.length; }
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            peer.close(new IllegalStateException("RPC writer interrupted"));
        } catch (IOException | RuntimeException fault) { peer.close(new IllegalStateException("RPC socket write failed")); }
    }

    /** Only memory fencing/wakeup here: Socket.close and executor shutdown belong to retireLoop. */
    private void retire() {
        synchronized (state) {
            if (retired) return;
            retired = true; connected = false;
            writes.clear(); queuedBytes = 0;
            state.notifyAll();
        }
        ready.completeExceptionally(new IllegalStateException("RPC connection closed before ready"));
    }

    private void retireLoop() {
        Socket owned;
        synchronized (state) {
            boolean interrupted = false;
            while (!retired) {
                try { state.wait(); } catch (InterruptedException stop) { interrupted = true; }
            }
            if (interrupted) Thread.currentThread().interrupt();
            owned = socket;
        }
        try {
            if (owned != null) owned.close();
        } catch (IOException closeFailure) {
            // The peer is already failed; do not replace its first reason or expose socket causes.
        } finally {
            deadlines.shutdownNow();
            reader.interrupt(); writer.interrupt();
        }
    }
}

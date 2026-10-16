package io.github.ph0ryn.mchisyo.transport;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.Strictness;
import io.github.ph0ryn.mchisyo.protocol.JsonRpc;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;

/** Bidirectional RPC only. Authentication and world/run lifetime gates belong to its owner. */
public final class RpcPeer implements AutoCloseable {
    public static final int MAX_PENDING = 64;
    public static final int MAX_QUEUED_BYTES = 4 * JsonLineCodec.DEFAULT_MAX_FRAME_BYTES;
    public static final long DEFAULT_TIMEOUT_MILLIS = 5000;
    private static final Gson JSON = new GsonBuilder().setStrictness(Strictness.STRICT).create();

    @FunctionalInterface public interface Deadline { void cancel(); }
    /** Nonblocking owner port. Write must atomically reject above 4 MiB queued + in-flight bytes.
     * Close must fence new writes immediately and retire I/O asynchronously; never block a game thread.
     * Schedule must not run expiry inline. No payload logging. */
    public interface Port {
        void write(byte[] frame);
        Deadline schedule(long delayMillis, Runnable expiry);
        void close();
    }
    /** Invoked on the reader, outside state locks; return promptly and dispatch game work asynchronously. */
    @FunctionalInterface public interface Handler { CompletionStage<JsonElement> apply(JsonElement params); }

    private final Object state = new Object();
    private final Object output = new Object();
    private final Port port;
    private final long timeoutMillis;
    private final JsonLineCodec.Decoder decoder = new JsonLineCodec.Decoder();
    private final Map<String, Pending> pending = new HashMap<>();
    private final Set<Id> incoming = new HashSet<>();
    private final Map<String, Handler> handlers = new HashMap<>();
    private final CompletableFuture<RuntimeException> closed = new CompletableFuture<>();
    private volatile RuntimeException failure;
    private long nextId;
    private int notifications;

    private static final class Pending {
        final CompletableFuture<JsonElement> result = new CompletableFuture<>();
        Deadline deadline;
    }
    // Active identity matches TS JSON.parse/Set; the original ID is retained separately for echo.
    private record Id(int kind, String value) {
        static Id of(JsonElement id) {
            if (id.isJsonNull()) return new Id(0, "");
            if (id.getAsJsonPrimitive().isString()) return new Id(1, id.getAsString());
            double number = id.getAsDouble(); // Already validated finite by JsonRpc.
            return new Id(2, Double.toString(number == 0.0 ? 0.0 : number)); // SameValueZero merges ±0.
        }
    }

    public RpcPeer(Port port) { this(port, DEFAULT_TIMEOUT_MILLIS); }
    public RpcPeer(Port port, long timeoutMillis) {
        this.port = Objects.requireNonNull(port);
        if (timeoutMillis < 1) throw new IllegalArgumentException("Invalid RPC timeout");
        this.timeoutMillis = timeoutMillis;
    }
    public boolean isClosed() { return failure != null; }
    /** Completes with the first local close reason, outside state locks. */
    public CompletionStage<RuntimeException> closed() { return closed.minimalCompletionStage(); }

    public void handle(String method, Handler handler) {
        outgoing(method, null); // Reuse the sole envelope/method validator.
        Objects.requireNonNull(handler);
        synchronized (state) {
            requireOpen();
            if (handlers.containsKey(method)) throw new IllegalArgumentException("Duplicate RPC handler");
            handlers.put(method, handler);
        }
    }

    /** Java null params omit the member; explicit JsonNull is invalid per the wire schema. */
    public CompletableFuture<JsonElement> call(String method, JsonElement params) {
        JsonObject message = outgoing(method, params);
        Pending entry = new Pending();
        String id;
        byte[] frame;
        synchronized (state) {
            requireOpen();
            if (pending.size() >= MAX_PENDING) throw new IllegalStateException("RPC pending request limit reached");
            nextId = Math.incrementExact(nextId);
            id = Long.toString(nextId);
            message.addProperty("id", id);
            frame = JsonLineCodec.encode(message);
            pending.put(id, entry);
        }
        try {
            Deadline deadline = port.schedule(timeoutMillis, () -> fail(new IllegalStateException("RPC request timed out"), entry));
            boolean active;
            synchronized (state) {
                active = pending.get(id) == entry;
                if (active) entry.deadline = deadline;
            }
            if (!active) deadline.cancel();
            send(frame);
        } catch (RuntimeException fault) {
            close(fault);
        }
        return entry.result;
    }

    public void notify(String method, JsonElement params) { send(JsonLineCodec.encode(outgoing(method, params))); }

    /** Single-reader seam; production owner alone supplies bytes/EOF. Never call concurrently. */
    public void receive(byte[] bytes) {
        if (isClosed()) return;
        try { decoder.push(bytes, line -> { if (!isClosed()) receiveLine(line); }); }
        catch (RuntimeException fault) { close(fault); }
    }
    public void endOfInput() {
        if (isClosed()) return;
        try { decoder.finish(); close(new IllegalStateException("RPC connection ended")); }
        catch (RuntimeException fault) { close(fault); }
    }

    @Override public void close() { close(new IllegalStateException("RPC peer closed")); }
    public void close(RuntimeException reason) { fail(reason, null); }
    private void fail(RuntimeException reason, Pending timedOut) {
        Objects.requireNonNull(reason);
        ArrayList<Pending> abandoned;
        synchronized (state) {
            if (isClosed() || (timedOut != null && !pending.containsValue(timedOut))) return;
            failure = reason;
            abandoned = new ArrayList<>(pending.values());
            pending.clear(); incoming.clear(); handlers.clear(); notifications = 0;
        }
        // No handler, future completion, scheduler or owner callbacks execute under the state lock.
        try { synchronized (output) { port.close(); } }
        finally {
            for (Pending entry : abandoned) {
                if (entry.deadline != null) entry.deadline.cancel();
                entry.result.completeExceptionally(reason);
            }
            closed.complete(reason);
        }
    }

    private static JsonObject outgoing(String method, JsonElement params) {
        JsonObject message = new JsonObject();
        message.addProperty("jsonrpc", "2.0"); message.addProperty("method", method);
        if (params != null) message.add("params", params);
        return JsonRpc.validate(message);
    }
    private void requireOpen() { if (failure != null) throw failure; }
    private void send(byte[] frame) {
        try {
            synchronized (output) { requireOpen(); port.write(frame); }
        } catch (RuntimeException fault) { close(fault); throw fault; }
    }

    private void receiveLine(String line) {
        JsonElement raw;
        try {
            // Parse once before shared validation to distinguish syntax (-32700) from envelope (-32600).
            if (line.isBlank() || line.startsWith("\ufeff")) throw new IllegalArgumentException("Invalid JSON syntax");
            raw = JSON.fromJson(line, JsonElement.class);
        } catch (RuntimeException invalid) { replyError(JsonNull.INSTANCE, new RpcError(-32700, "Parse error")); return; }
        JsonObject message;
        try { message = JsonRpc.validate(raw); }
        catch (IllegalArgumentException invalid) { invalidMessage(raw); return; }
        if (message.has("method")) {
            if (message.has("id")) request(message); else notification(message);
        } else response(message);
    }

    private void invalidMessage(JsonElement raw) {
        JsonElement id = JsonNull.INSTANCE;
        if (raw != null && raw.isJsonObject()) {
            JsonObject object = raw.getAsJsonObject();
            if (object.has("result") || object.has("error")) { close(new IllegalStateException("Malformed RPC response")); return; }
            if (object.has("method") && !object.has("id")) { close(new IllegalStateException("Malformed RPC notification")); return; }
            if (object.has("id")) {
                // Validate the ID through the same authority, not a narrowed local schema.
                JsonObject probe = new JsonObject(); probe.addProperty("jsonrpc", "2.0");
                probe.add("id", object.get("id")); probe.add("result", JsonNull.INSTANCE);
                try { id = JsonRpc.validate(probe).get("id"); } catch (IllegalArgumentException ignored) { /* invalid ID replies null */ }
            }
        }
        replyError(id, new RpcError(-32600, "Invalid request"));
    }

    private void response(JsonObject message) {
        Pending entry;
        JsonElement id = message.get("id");
        synchronized (state) {
            if (isClosed()) return;
            entry = id.isJsonPrimitive() && id.getAsJsonPrimitive().isString() ? pending.remove(id.getAsString()) : null;
        }
        if (entry == null) { close(new IllegalStateException("Unexpected RPC response ID")); return; }
        if (entry.deadline != null) entry.deadline.cancel();
        if (message.has("error")) {
            JsonObject error = message.getAsJsonObject("error");
            entry.result.completeExceptionally(new RpcError(error.get("code"), error.get("message").getAsString(), error.get("data")));
        } else entry.result.complete(message.get("result"));
    }

    private void request(JsonObject message) {
        JsonElement id = message.get("id");
        Id key = Id.of(id);
        Handler handler;
        int rejection = 0;
        synchronized (state) {
            if (isClosed()) return;
            handler = handlers.get(message.get("method").getAsString());
            if (incoming.contains(key)) rejection = 1;
            else if (incoming.size() >= MAX_PENDING) rejection = 2;
            else if (handler == null) rejection = 3;
            else incoming.add(key);
        }
        if (rejection == 1) { close(new IllegalStateException("Duplicate active RPC request ID")); return; }
        if (rejection == 2) { replyError(id, new RpcError(-32000, "RPC incoming request limit reached")); return; }
        if (rejection == 3) { replyError(id, new RpcError(-32601, "Method not found")); return; }
        try {
            Objects.requireNonNull(handler.apply(message.get("params"))).whenComplete((value, error) -> {
                synchronized (state) { incoming.remove(key); }
                if (isClosed()) return;
                if (error != null) { replyError(id, unwrap(error)); return; }
                try {
                    if (value == null) throw new IllegalArgumentException("Missing RPC handler result");
                    JsonObject result = new JsonObject(); result.addProperty("jsonrpc", "2.0");
                    result.add("id", id); result.add("result", value);
                    send(JsonLineCodec.encode(JsonRpc.validate(result)));
                } catch (RuntimeException fault) { replyError(id, fault); }
            });
        } catch (RuntimeException fault) {
            synchronized (state) { incoming.remove(key); }
            replyError(id, fault);
        }
    }

    private void notification(JsonObject message) {
        Handler handler;
        synchronized (state) {
            if (isClosed()) return;
            handler = notifications >= MAX_PENDING ? null : handlers.get(message.get("method").getAsString());
            if (handler != null) notifications++;
        }
        if (handler == null) { close(new IllegalStateException("Unsupported or overloaded RPC notification")); return; }
        try {
            Objects.requireNonNull(handler.apply(message.get("params"))).whenComplete((value, error) -> {
                synchronized (state) { if (!isClosed()) notifications--; }
                if (error != null) close(new IllegalStateException("RPC notification handler failed"));
            });
        } catch (RuntimeException fault) { close(new IllegalStateException("RPC notification handler failed")); }
    }

    private static Throwable unwrap(Throwable error) {
        while (error instanceof CompletionException && error.getCause() != null) error = error.getCause();
        return error;
    }
    private void replyError(JsonElement id, Throwable error) {
        if (isClosed()) return;
        RpcError fault = error instanceof RpcError rpc ? rpc : new RpcError(-32603, "Internal error");
        JsonObject body = new JsonObject(); body.add("code", fault.code()); body.addProperty("message", fault.getMessage());
        if (fault.data() != null) body.add("data", fault.data());
        JsonObject message = new JsonObject(); message.addProperty("jsonrpc", "2.0"); message.add("id", id); message.add("error", body);
        try { send(JsonLineCodec.encode(JsonRpc.validate(message))); }
        catch (RuntimeException sendFailure) { close(sendFailure); }
    }
}

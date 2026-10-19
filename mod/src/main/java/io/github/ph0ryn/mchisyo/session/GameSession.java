package io.github.ph0ryn.mchisyo.session;

import com.google.gson.*;
import io.github.ph0ryn.mchisyo.observation.ObservedEvent;
import io.github.ph0ryn.mchisyo.protocol.RunBinding;
import io.github.ph0ryn.mchisyo.protocol.SessionBinding;
import io.github.ph0ryn.mchisyo.reference.PackagedReferences;
import io.github.ph0ryn.mchisyo.transport.JsonLineCodec;
import io.github.ph0ryn.mchisyo.transport.RpcError;
import io.github.ph0ryn.mchisyo.transport.RpcPeer;
import java.util.*;
import java.util.concurrent.*;

/** One directly composed RPC attachment. No game objects, scheduling, reconnect, or replay. */
public final class GameSession implements AutoCloseable {
    /** One genuine native JOIN, retained only until admission or identity/lifetime invalidation. */
    public static final class PendingJoin {
        private Object server, player;
        private UUID id;
        private ObservedEvent fact;
        public synchronized void capture(Object server, Object player, UUID id, ObservedEvent fact) {
            this.server = Objects.requireNonNull(server); this.player = Objects.requireNonNull(player);
            this.id = Objects.requireNonNull(id); this.fact = Objects.requireNonNull(fact);
        }
        public synchronized void retain(Object server, Object player, UUID id) {
            if (this.server == server && (this.player != player || !Objects.equals(this.id, id))) retire(server);
        }
        public synchronized ObservedEvent take(Object server, Object player, UUID id) {
            if (this.server != server) return null;
            ObservedEvent taken = this.player == player && Objects.equals(this.id, id) ? fact : null;
            retire(server); return taken;
        }
        public synchronized void retire(Object server) {
            if (server == null || this.server == server) { this.server = null; player = null; id = null; fact = null; }
        }
    }
    public interface GamePort {
        CompletionStage<Void> initialize();
        CompletionStage<JsonObject> snapshot(Capture capture);
        CompletionStage<Void> display(Capture capture, String text);
        CompletionStage<JsonObject> reference(Capture capture, String method, JsonObject query);
    }
    public final class Capture {
        private final Object identity;
        private final RunBinding binding;
        private Capture(Object identity, RunBinding binding) { this.identity = identity; this.binding = binding; }
        public void requireCurrent() {
            synchronized (state) {
                if (closed || !ready || runIdentity != identity || !binding.equals(run)) throw stale();
            }
        }
    }
    private static final Gson JSON = new GsonBuilder().serializeNulls().create();
    private final Object state = new Object();
    private final RpcPeer peer;
    private final GamePort game;
    private final String worldId, playerId, language;
    private final List<String> events;
    private boolean started, closed, ready, paused, reportedPaused;
    private SessionBinding sessionBinding;
    private RunBinding run;
    private Object runIdentity;
    private long seq;
    private static final long OBSERVATION_INTERVAL_NANOS = TimeUnit.SECONDS.toNanos(1);
    private static final int EVENT_BATCH_BYTES = JsonLineCodec.DEFAULT_MAX_FRAME_BYTES - 256; // RPC envelope headroom.
    private record QueuedObservation(JsonObject value, int bytes) {}
    private final ArrayDeque<QueuedObservation> observations = new ArrayDeque<>();
    private int observationBytes;
    private boolean eventPending;
    private long lastEventFlush = System.nanoTime();
    private final ArrayDeque<JsonObject> statuses = new ArrayDeque<>();
    private CompletableFuture<Void> statusPublished = CompletableFuture.completedFuture(null);

    public GameSession(RpcPeer peer, GamePort game, String worldId, String playerId, String language, List<String> events, boolean paused) {
        this.peer = Objects.requireNonNull(peer); this.game = Objects.requireNonNull(game);
        this.worldId = worldId; this.playerId = playerId; this.language = language; this.events = List.copyOf(events); this.paused = paused;
        peer.handle("game.run.bind", params -> {
            RunBinding binding = binding(params, Set.of());
            synchronized (state) {
                requireSession(binding.sessionBinding());
                // Pause only controls scheduler dispatch, never native binding or tools.
                if (run != null && !run.equals(binding)) throw stale();
                if (run == null) { run = binding; runIdentity = new Object(); }
            }
            return CompletableFuture.completedFuture(binding.toJson());
        });
        peer.handle("game.run.clear", params -> {
            RunBinding binding = binding(params, Set.of());
            synchronized (state) { if (binding.equals(run)) invalidateRun(); }
            return CompletableFuture.completedFuture(binding.toJson());
        });
        peer.handle("game.state.get", params -> {
            RunBinding binding = binding(params, Set.of("query"));
            JsonElement query = params.getAsJsonObject().get("query");
            if (!query.isJsonObject() || !query.getAsJsonObject().isEmpty()) throw invalid();
            Capture capture = capture(binding);
            return game.snapshot(capture).thenApply(snapshot -> {
                capture.requireCurrent();
                if (snapshot == null || snapshot.isEmpty()) throw new IllegalStateException("Missing game snapshot");
                JsonObject result = binding.toJson(); result.add("state", snapshot); return result;
            });
        });
        peer.handle("game.message.send", params -> {
            RunBinding binding = binding(params, Set.of("text"));
            String text = text(params.getAsJsonObject().get("text"));
            Capture capture = capture(binding);
            return game.display(capture, text).thenApply(ignored -> {
                capture.requireCurrent(); JsonObject result = binding.toJson(); result.addProperty("displayed", true); return result;
            });
        });
        for (String method : List.of("game.files.list", "game.files.read", "game.files.search")) peer.handle(method, params -> {
            RunBinding binding = binding(params, Set.of("query"));
            JsonElement value = params.getAsJsonObject().get("query");
            if (value == null || !value.isJsonObject()) throw invalid();
            JsonObject query = value.getAsJsonObject().deepCopy();
            PackagedReferences.validate(method, query);
            Capture capture = capture(binding); capture.requireCurrent();
            return game.reference(capture, method, query).thenApply(reference -> {
                capture.requireCurrent();
                if (reference == null) throw new IllegalStateException("Missing reference result");
                JsonObject result = binding.toJson(); result.add("reference", reference); PackagedReferences.budget(result); capture.requireCurrent(); return result;
            });
        });
        peer.closed().thenAccept(reason -> invalidate());
    }
    public CompletionStage<Void> start(CompletionStage<RpcPeer> tcp, String token) {
        synchronized (state) { if (started || closed) throw stale(); started = true; }
        JsonObject hello = new JsonObject(); hello.addProperty("protocolVersion", 2); hello.addProperty("role", "game"); hello.addProperty("token", token);
        CompletionStage<Void> result = tcp.thenCompose(ignored -> { requireActive(); return peer.call("bridge.hello", hello); })
            .thenCompose(ack -> {
                requireActive(); exact(ack, Set.of("protocolVersion", "role"));
                if (!new JsonPrimitive(2).equals(ack.getAsJsonObject().get("protocolVersion"))
                        || !new JsonPrimitive("game").equals(ack.getAsJsonObject().get("role"))) throw invalid();
                JsonObject attach = new JsonObject(); attach.addProperty("worldId", worldId); attach.addProperty("playerId", playerId);
                attach.addProperty("language", language);
                attach.add("supportedEvents", JSON.toJsonTree(events));
                synchronized (state) { reportedPaused = paused; attach.addProperty("paused", paused); }
                return peer.call("game.attach", attach);
            }).thenCompose(ack -> {
                requireActive(); SessionBinding attached;
                try { attached = SessionBinding.fromJson(ack); } catch (IllegalArgumentException error) { throw invalid(); }
                if (!attached.worldId().equals(worldId) || !attached.playerId().equals(playerId)) throw stale();
                synchronized (state) { if (closed) throw stale(); sessionBinding = attached; }
                return game.initialize();
            }).thenCompose(ignored -> {
                SessionBinding binding;
                // CLI may synchronously bind while handling game.ready: local owner is ready first.
                synchronized (state) { if (closed) throw stale(); ready = true; binding = sessionBinding; }
                // Synchronize pause changes retained during initialization before admission.
                // Wait for publication, not the ACK, including a concurrent status drainer.
                return reportPause().thenCompose(published -> peer.call("game.ready", binding.toJson()));
            }).thenAccept(ack -> { requireActive(); flag(ack, "ready", true); });
        result.whenComplete((ignored, failure) -> { if (failure != null) close(); });
        return result;
    }
    public boolean isReady() { synchronized (state) { return ready && !closed; } }
    private void requireActive() { synchronized (state) { if (closed) throw stale(); } }
    private void requireSession(SessionBinding binding) { if (closed || !ready || !binding.equals(sessionBinding)) throw stale(); }
    private Capture capture(RunBinding binding) {
        synchronized (state) {
            requireSession(binding.sessionBinding()); if (!binding.equals(run)) throw stale();
            return new Capture(runIdentity, binding);
        }
    }
    public CompletionStage<Void> playerMessage(String value) {
        String text = text(new JsonPrimitive(value)); SessionBinding binding;
        synchronized (state) { if (closed || !ready) throw stale(); binding = sessionBinding; }
        JsonObject params = binding.toJson(); params.addProperty("text", text);
        CompletionStage<Void> result = request("game.player_message", params).thenAccept(ack -> {
            synchronized (state) { requireSession(binding); } flag(ack, "accepted", true);
        });
        result.whenComplete((ignored, error) -> { if (error != null) close(); });
        return result;
    }
    public void pause(boolean value) {
        synchronized (state) { if (closed) return; paused = value; }
        reportPause();
    }
    private CompletionStage<Void> reportPause() {
        JsonObject params;
        CompletableFuture<Void> published;
        synchronized (state) {
            // Before readiness, retain only the latest state; pause is never a startup failure.
            if (closed || !ready || reportedPaused == paused) return statusPublished;
            reportedPaused = paused;
            if (statuses.size() >= 32) params = null;
            else {
                params = sessionBinding.toJson(); params.addProperty("paused", paused); statuses.addLast(params);
                // The head stays queued while its sole drainer calls the peer, outside this lock.
                if (statuses.size() > 1) return statusPublished;
                statusPublished = new CompletableFuture<>();
            }
            published = statusPublished;
        }
        if (params == null) { close(); return published; }
        do {
            boolean expected = params.get("paused").getAsBoolean();
            request("game.status", params).thenAccept(ack -> { try { flag(ack, "paused", expected); } catch (RuntimeException error) { close(); } });
            synchronized (state) { statuses.pollFirst(); params = closed ? null : statuses.peekFirst(); }
        } while (params != null);
        published.complete(null);
        return published;
    }
    public void observation(ObservedEvent event) {
        try {
            synchronized (state) {
                if (closed || !ready) return;
                if (seq >= 9007199254740991L) throw new IllegalStateException("Observation sequence exhausted");
                JsonObject params = sessionBinding.toJson(); params.addProperty("seq", ++seq);
                params.addProperty("event", event.name()); params.addProperty("dimension", event.dimension());
                params.add("position", JSON.toJsonTree(event.position())); params.addProperty("tick", event.tick());
                params.addProperty("observedAt", event.observedAt()); params.add("data", JSON.toJsonTree(event.data()));
                int bytes = JsonLineCodec.encode(params, EVENT_BATCH_BYTES - 1).length; // LF budgets the array comma.
                if (observationBytes + bytes > RpcPeer.MAX_QUEUED_BYTES) throw new IllegalStateException("Observation queue byte limit reached");
                observations.addLast(new QueuedObservation(params, bytes)); observationBytes += bytes;
            }
        } catch (IllegalArgumentException | IllegalStateException error) { peer.close(error); }
    }
    public void flushObservations(long nowNanos) {
        JsonArray batch = new JsonArray();
        synchronized (state) {
            if (closed || !ready || eventPending || observations.isEmpty() || nowNanos - lastEventFlush < OBSERVATION_INTERVAL_NANOS) return;
            // ponytail: one <=1024-event / 1 MiB batch per second; drain faster if measured sustained traffic needs it.
            int bytes = 0;
            while (!observations.isEmpty() && batch.size() < 1024 && bytes + observations.peekFirst().bytes() <= EVENT_BATCH_BYTES) {
                QueuedObservation event = observations.removeFirst(); batch.add(event.value());
                bytes += event.bytes(); observationBytes -= event.bytes();
            }
            eventPending = true; lastEventFlush = nowNanos;
        }
        JsonObject params = new JsonObject(); params.add("events", batch);
        request("game.events", params).whenComplete((ack, error) -> {
            if (error == null) {
                try {
                    exact(ack, Set.of("stored"));
                    if (safeCounter(ack.getAsJsonObject().get("stored"), false) != batch.size()) throw invalid();
                } catch (RuntimeException invalidAck) { close(); }
            }
            synchronized (state) { eventPending = false; }
        });
    }
    private CompletionStage<JsonElement> request(String method, JsonObject params) {
        try {
            var result = peer.call(method, params); result.whenComplete((ack, error) -> { if (error != null) close(); }); return result;
        } catch (RuntimeException error) { close(); return CompletableFuture.failedFuture(stale()); }
    }
    private void invalidateRun() { run = null; runIdentity = null; }
    private void invalidate() { synchronized (state) { closed = true; ready = false; invalidateRun(); statuses.clear(); statusPublished.completeExceptionally(stale()); observations.clear(); observationBytes = 0; } }
    @Override public void close() { invalidate(); peer.close(); }
    public static RpcError stale() { return new RpcError(-32001, "Inactive or stale execution binding"); }
    private static RpcError invalid() { return new RpcError(-32602, "Invalid method parameters"); }
    private static RunBinding binding(JsonElement params, Set<String> extra) {
        Set<String> keys = new HashSet<>(Set.of("worldId", "playerId", "sessionId", "runId")); keys.addAll(extra); exact(params, keys);
        JsonObject copy = params.getAsJsonObject().deepCopy(); extra.forEach(copy::remove);
        try { return RunBinding.fromJson(copy); } catch (IllegalArgumentException error) { throw invalid(); }
    }
    private static void exact(JsonElement value, Set<String> keys) {
        if (value == null || !value.isJsonObject() || !value.getAsJsonObject().keySet().equals(keys)) throw invalid();
    }
    private static String text(JsonElement value) {
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) throw invalid();
        String text = value.getAsString();
        if (text.codePoints().allMatch(c -> Character.isWhitespace(c) || Character.isSpaceChar(c) || c == 0xfeff)
                || text.codePointCount(0, text.length()) > 16000) throw invalid();
        return text;
    }
    private static void flag(JsonElement value, String key, boolean expected) {
        exact(value, Set.of(key)); if (!new JsonPrimitive(expected).equals(value.getAsJsonObject().get(key))) throw invalid();
    }
    public static long safeCounter(JsonElement value, boolean signed) {
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) throw invalid();
        try { long number = value.getAsBigDecimal().longValueExact(); if (number < (signed ? -9007199254740991L : 0) || number > 9007199254740991L) throw invalid(); return number; }
        catch (ArithmeticException error) { throw invalid(); }
    }
}

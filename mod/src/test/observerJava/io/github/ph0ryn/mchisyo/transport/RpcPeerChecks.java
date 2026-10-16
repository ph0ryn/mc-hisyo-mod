package io.github.ph0ryn.mchisyo.transport;

import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;

/** Pure public wire behavior: manual bytes/deadlines and deferred stages, never socket/timer/thread I/O. */
public final class RpcPeerChecks {
    private static int checks;

    public static void main(String[] args) {
        equal(null, RpcPeerChecks.class.getClassLoader().getResource("net/minecraft/server/MinecraftServer.class"), "no game runtime");
        equal(null, RpcPeerChecks.class.getClassLoader().getResource("net/fabricmc/loader/api/FabricLoader.class"), "no Fabric runtime");
        correlation();
        dispatch();
        invalidForms();
        limitsAndRetirement();
        System.out.println("RpcPeerChecks: " + checks + " assertions passed (pure manual ports/deadlines only)");
    }

    private static void correlation() {
        Manual port = new Manual();
        RpcPeer peer = new RpcPeer(port);
        var first = peer.call("read", json("{\"x\":null}"));
        var second = peer.call("read", json("[]"));
        equal(json("{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"read\",\"params\":{\"x\":null}}"), port.frame(0), "literal outgoing request/string ID");
        equal(5000L, port.timers.get(0).delay, "default timeout");
        feed(peer, "{\"jsonrpc\":\"2.0\",\"id\":\"2\",\"result\":null}\n");
        equal(JsonNull.INSTANCE, second.join(), "out-of-order explicit null result");
        equal(false, first.isDone(), "other request remains pending");
        feed(peer, "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"error\":{\"code\":1e100,\"message\":\"denied\",\"data\":[null,{}]}}\n");
        RpcError error = (RpcError) failure(first);
        equal(json("1e100"), error.code(), "no error-code narrowing");
        equal("denied", error.getMessage(), "remote error message");
        equal(json("[null,{}]"), error.data(), "error data preserved");
        equal(true, port.timers.stream().allMatch(t -> t.cancelled), "settled timers cancelled");
        port.timers.get(0).expiry.run(); // Already-dispatched cancellation race, without a real timer/thread.
        equal(false, peer.isClosed(), "late deadline for settled call is suppressed");
        peer.notify("event", null);
        equal(json("{\"jsonrpc\":\"2.0\",\"method\":\"event\"}"), port.frame(2), "omitted params distinct from null");
        rejects(() -> peer.notify("event", JsonNull.INSTANCE), "null params invalid");
        rejects(() -> peer.call("", null), "empty outgoing method");
        equal(false, peer.isClosed(), "local validation errors do not close");
        peer.close();
    }

    private static void dispatch() {
        Manual port = new Manual();
        RpcPeer peer = new RpcPeer(port);
        CompletableFuture<JsonElement> deferred = new CompletableFuture<>();
        peer.handle("wait", params -> deferred);
        peer.handle("echo", params -> CompletableFuture.completedFuture(params == null ? JsonNull.INSTANCE : params));
        peer.handle("secret", params -> { throw new IllegalStateException("token/source/params"); });
        peer.handle("domain", params -> CompletableFuture.failedFuture(new RpcError(-32602, "Bad params", JsonNull.INSTANCE)));
        rejects(() -> peer.handle("echo", params -> deferred), "duplicate handler");
        for (String id : List.of("null", "1.25", "1e100", "1e-2147483649", "9007199254740993", "\"\"", "\"" + "x".repeat(256) + "\"")) {
            feed(peer, "{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"method\":\"echo\",\"params\":{\"日\":null}}\n");
            JsonObject response = port.frame(port.frames.size() - 1).getAsJsonObject();
            equal(json(id), response.get("id"), "inbound ID preserved");
            equal(json("{\"日\":null}"), response.get("result"), "reverse request result");
        }
        feed(peer, "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"wait\"}\n");
        int before = port.frames.size();
        equal(false, deferred.isDone(), "handler does not block reader");
        feed(peer, "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"missing\"}\n");
        equal(-32601, code(port.frame(before)), "unknown method request");
        deferred.complete(JsonNull.INSTANCE);
        equal(JsonNull.INSTANCE, port.frame(before + 1).getAsJsonObject().get("result"), "deferred null response");
        feed(peer, "{\"jsonrpc\":\"2.0\",\"id\":10,\"method\":\"secret\"}\n");
        equal(json("{\"jsonrpc\":\"2.0\",\"id\":10,\"error\":{\"code\":-32603,\"message\":\"Internal error\"}}"), port.frame(before + 2), "internal cause never exposed");
        feed(peer, "{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"domain\"}\n");
        equal(JsonNull.INSTANCE, port.frame(before + 3).getAsJsonObject().getAsJsonObject("error").get("data"), "explicit null error data");
        int[] notifications = {0};
        peer.handle("event", params -> { notifications[0]++; return CompletableFuture.completedFuture(null); });
        feed(peer, "{\"jsonrpc\":\"2.0\",\"method\":\"event\"}\n");
        equal(1, notifications[0], "reverse notification dispatched");
        equal(before + 4, port.frames.size(), "notification sends no response");
        peer.close();
    }

    private static void invalidForms() {
        for (String syntax : List.of("", " ", "{", "/*x*/{}", "{\"x\":1,}", "{} {}", "\ufeff{}")) {
            Manual p = new Manual(); RpcPeer peer = new RpcPeer(p);
            // The decoder removes one BOM; two BOMs must remain a parse error.
            feed(peer, (syntax.startsWith("\ufeff") ? "\ufeff" : "") + syntax + "\n");
            equal(-32700, code(p.frame(0)), "strict parse error");
            equal(false, peer.isClosed(), "parse error reply keeps peer usable");
            peer.close();
        }
        for (String invalid : List.of("null", "[]", "{}", "{\"jsonrpc\":\"1.0\",\"id\":1.25,\"method\":\"a\"}",
                "{\"jsonrpc\":\"2.0\",\"id\":true,\"method\":\"a\"}", "{\"jsonrpc\":\"2.0\",\"id\":1e400,\"method\":\"a\"}",
                "{\"jsonrpc\":\"2.0\",\"id\":\"a\",\"method\":\"a\",\"params\":null}")) {
            Manual p = new Manual(); RpcPeer peer = new RpcPeer(p); feed(peer, invalid + "\n");
            equal(-32600, code(p.frame(0)), "invalid request reply");
            equal(false, peer.isClosed(), "invalid request not fail-stop"); peer.close();
        }
        for (String malformed : List.of("{\"jsonrpc\":\"2.0\",\"method\":\"a\",\"params\":null}",
                "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"result\":null,\"extra\":0}",
                "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"error\":{\"code\":1.5,\"message\":\"x\"}}",
                "{\"jsonrpc\":\"2.0\",\"id\":\"unknown\",\"result\":0}",
                "{\"jsonrpc\":\"2.0\",\"method\":\"unknown\"}")) {
            Manual p = new Manual(); RpcPeer peer = new RpcPeer(p); feed(peer, malformed + "\n");
            equal(true, peer.isClosed(), "malformed/unexpected/unsupported fail-stop");
            equal(0, p.frames.size(), "no malformed reply");
        }
        Manual p = new Manual(); RpcPeer peer = new RpcPeer(p);
        feed(peer, "{\"jsonrpc\":\"1.0\",\"id\":1.25,\"method\":\"a\"}\n");
        equal(json("1.25"), p.frame(0).getAsJsonObject().get("id"), "invalid request echoes valid ID"); peer.close();
    }

    private static void limitsAndRetirement() {
        Manual p = new Manual(); RpcPeer peer = new RpcPeer(p);
        List<CompletableFuture<JsonElement>> calls = new ArrayList<>();
        for (int i = 0; i < 64; i++) calls.add(peer.call("a", null));
        rejects(() -> peer.call("a", null), "64 pending cap");
        equal(false, peer.isClosed(), "local pending cap is rejection, not disconnect");
        p.timers.get(0).fire();
        equal(true, peer.isClosed(), "deadline fail-closes");
        equal(true, calls.stream().allMatch(CompletableFuture::isCompletedExceptionally), "timeout rejects every pending");
        equal(true, p.timers.stream().allMatch(t -> t.cancelled), "timeout cancels every timer");
        int count = p.frames.size();
        feed(peer, "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"result\":null}\n");
        peer.close(); peer.endOfInput();
        equal(count, p.frames.size(), "late response/EOF/close suppressed");
        equal(1, p.closes, "idempotent port close");
        rejects(() -> peer.handle("a", x -> CompletableFuture.completedFuture(x)), "closed registration");
        rejects(() -> peer.call("a", null), "closed call");
        rejects(() -> peer.notify("a", null), "closed notify");
        for (boolean notification : List.of(false, true)) {
            Manual port = new Manual(); RpcPeer bounded = new RpcPeer(port);
            CompletableFuture<JsonElement> deferred = new CompletableFuture<>();
            bounded.handle("wait", x -> deferred);
            for (int i = 0; i < 64; i++) feed(bounded, request(i, notification));
            equal(0, port.frames.size(), "64 active async jobs accepted");
            feed(bounded, request(64, notification));
            equal(notification, bounded.isClosed(), "notification overload closes; request overload replies");
            if (!notification) equal(-32000, code(port.frame(0)), "inbound request cap error");
            bounded.close(); int sent = port.frames.size(); deferred.complete(JsonNull.INSTANCE);
            equal(sent, port.frames.size(), "late handlers send nothing");
        }
        Manual duplicate = new Manual(); RpcPeer dupe = new RpcPeer(duplicate);
        dupe.handle("wait", x -> new CompletableFuture<>());
        feed(dupe, request(1, false)); feed(dupe, request(1, false));
        equal(true, dupe.isClosed(), "duplicate active ID closes");
        RpcPeer equivalent = new RpcPeer(new Manual());
        equivalent.handle("wait", x -> new CompletableFuture<>());
        feed(equivalent, request(1, false));
        feed(equivalent, "{\"jsonrpc\":\"2.0\",\"id\":1.0,\"method\":\"wait\"}\n");
        equal(true, equivalent.isClosed(), "equivalent numeric active IDs collide");
        RpcPeer exact = new RpcPeer(new Manual());
        exact.handle("wait", x -> new CompletableFuture<>());
        feed(exact, "{\"jsonrpc\":\"2.0\",\"id\":9007199254740992,\"method\":\"wait\"}\n");
        feed(exact, "{\"jsonrpc\":\"2.0\",\"id\":9007199254740993,\"method\":\"wait\"}\n");
        equal(false, exact.isClosed(), "numeric IDs not narrowed through double/integer width"); exact.close();
        Manual notificationFailure = new Manual(); RpcPeer rejected = new RpcPeer(notificationFailure);
        rejected.handle("a", x -> CompletableFuture.failedFuture(new IllegalStateException("private")));
        feed(rejected, "{\"jsonrpc\":\"2.0\",\"method\":\"a\"}\n");
        equal(true, rejected.isClosed(), "async notification failure closes");
        equal(0, notificationFailure.frames.size(), "notification failure never replies with private cause");
        for (byte[] fault : List.of(new byte[] {(byte) 0xff, 10}, new byte[1024 * 1024 + 1])) {
            RpcPeer wire = new RpcPeer(new Manual()); wire.receive(fault); equal(true, wire.isClosed(), "wire fault closes");
        }
        RpcPeer eof = new RpcPeer(new Manual()); feed(eof, "{}"); eof.endOfInput(); equal(true, eof.isClosed(), "partial EOF closes");
        Manual broken = new Manual(); broken.failWrite = true; RpcPeer failed = new RpcPeer(broken);
        equal(true, failed.call("a", null).isCompletedExceptionally(), "write failure rejects call");
        equal(true, failed.isClosed(), "write failure closes");
        Manual overflow = new Manual(); RpcPeer bytes = new RpcPeer(overflow);
        JsonElement large = json("{\"x\":\"" + "a".repeat(1024 * 1024 - 100) + "\"}");
        for (int i = 0; i < 4; i++) bytes.notify("a", large);
        rejects(() -> bytes.notify("a", large), "4 MiB owner byte cap");
        equal(true, bytes.isClosed(), "unsafe output overload closes");
        Manual badResult = new Manual(); RpcPeer bad = new RpcPeer(badResult);
        bad.handle("a", x -> CompletableFuture.completedFuture(null)); feed(bad, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"a\"}\n");
        equal(-32603, code(badResult.frame(0)), "missing Java result is internal error, not JSON null"); bad.close();
    }

    private static String request(int id, boolean notification) {
        return "{\"jsonrpc\":\"2.0\"," + (notification ? "" : "\"id\":" + id + ",") + "\"method\":\"wait\"}\n";
    }
    private static JsonElement json(String value) { return JsonParser.parseString(value); }
    private static void feed(RpcPeer peer, String wire) { peer.receive(wire.getBytes(StandardCharsets.UTF_8)); }
    private static int code(JsonElement frame) { return frame.getAsJsonObject().getAsJsonObject("error").get("code").getAsInt(); }
    private static Throwable failure(CompletableFuture<?> future) {
        try { future.join(); } catch (CompletionException expected) { checks++; return expected.getCause(); }
        throw new AssertionError("Expected failed future");
    }
    private static void rejects(Runnable action, String label) {
        try { action.run(); } catch (RuntimeException expected) { checks++; return; }
        throw new AssertionError("Expected rejection: " + label);
    }
    private static void equal(Object expected, Object actual, String label) {
        if (!Objects.equals(expected, actual)) throw new AssertionError(label + ": expected=" + expected + ", actual=" + actual);
        checks++;
    }

    private static final class Manual implements RpcPeer.Port {
        final List<byte[]> frames = new ArrayList<>();
        final List<Timer> timers = new ArrayList<>();
        int closes;
        int queuedBytes;
        boolean failWrite;
        public void write(byte[] frame) {
            if (failWrite || queuedBytes + frame.length > RpcPeer.MAX_QUEUED_BYTES) throw new IllegalStateException("Manual write rejected");
            queuedBytes += frame.length; frames.add(frame.clone());
        }
        public RpcPeer.Deadline schedule(long delay, Runnable expiry) { Timer timer = new Timer(delay, expiry); timers.add(timer); return timer; }
        public void close() { closes++; }
        JsonElement frame(int index) { return json(new String(frames.get(index), StandardCharsets.UTF_8)); }
    }
    private static final class Timer implements RpcPeer.Deadline {
        final long delay; final Runnable expiry; boolean cancelled;
        Timer(long delay, Runnable expiry) { this.delay = delay; this.expiry = expiry; }
        public void cancel() { cancelled = true; }
        void fire() { if (!cancelled) expiry.run(); }
    }
}

package io.github.ph0ryn.mchisyo.session;

import static org.junit.jupiter.api.Assertions.*;

import com.google.gson.*;
import io.github.ph0ryn.mchisyo.protocol.RunBinding;
import io.github.ph0ryn.mchisyo.observation.ObservedEvent;
import io.github.ph0ryn.mchisyo.transport.RpcPeer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;

/** Literal wire/manual queued game work only; no resource adapters are instantiated. */
public final class GameSessionTest {
    private static final String WORLD = "00000000-0000-0000-0000-000000000001";
    private static final String PLAYER = "00000000-0000-0000-0000-000000000002";
    private static final RunBinding RUN = new RunBinding(WORLD, PLAYER, "session", "run");
    private static JsonObject json(String text) { return JsonParser.parseString(text).getAsJsonObject(); }
    private static void rejects(Runnable work) {
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class, work::run);
        assertFalse(error.toString().contains("SECRET"));
    }
    private static final class Wire implements RpcPeer.Port {
        final List<JsonObject> sent = new ArrayList<>();
        Runnable beforeSchedule = () -> {};
        public void write(byte[] bytes) { sent.add(json(new String(bytes, StandardCharsets.UTF_8))); }
        public RpcPeer.Deadline schedule(long delay, Runnable work) { beforeSchedule.run(); return () -> {}; }
        public void close() {}
        JsonObject last() { return sent.getLast(); }
    }
    private static final class Game implements GameSession.GamePort {
        final ArrayDeque<Runnable> queue = new ArrayDeque<>();
        int displayed;
        Runnable afterRead = () -> {};
        boolean queuedInitialize;
        public CompletionStage<Void> initialize() {
            if (!queuedInitialize) return CompletableFuture.completedFuture(null);
            CompletableFuture<Void> result = new CompletableFuture<>(); queue.add(() -> result.complete(null)); return result;
        }
        public CompletionStage<JsonObject> snapshot(GameSession.Capture capture) {
            CompletableFuture<JsonObject> result = new CompletableFuture<>();
            queue.add(() -> { try { capture.requireCurrent(); JsonObject copy = json("{\"version\":1}"); afterRead.run(); result.complete(copy); } catch (RuntimeException e) { result.completeExceptionally(e); } });
            return result;
        }
        int references;
        public CompletionStage<JsonObject> reference(GameSession.Capture capture, String method, JsonObject query) {
            capture.requireCurrent(); CompletableFuture<JsonObject> result = new CompletableFuture<>();
            queue.add(() -> { try { capture.requireCurrent(); references++; afterRead.run(); result.complete(json("{\"kind\":\"roots\",\"roots\":[],\"nextCursor\":null}")); } catch (RuntimeException error) { result.completeExceptionally(error); } });
            return result;
        }
        public CompletionStage<Void> display(GameSession.Capture capture, String text) {
            CompletableFuture<Void> result = new CompletableFuture<>();
            queue.add(() -> { try { capture.requireCurrent(); displayed++; result.complete(null); } catch (RuntimeException e) { result.completeExceptionally(e); } });
            return result;
        }
    }
    private static void receive(RpcPeer peer, String method, JsonObject params, int id) {
        JsonObject frame = json("{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"method\":\"" + method + "\"}"); frame.add("params", params);
        peer.receive((frame + "\n").getBytes(StandardCharsets.UTF_8));
    }
    private static void reply(RpcPeer peer, Wire wire, JsonObject result) {
        JsonObject frame = json("{\"jsonrpc\":\"2.0\"}"); frame.add("id", wire.last().get("id")); frame.add("result", result);
        peer.receive((frame + "\n").getBytes(StandardCharsets.UTF_8));
    }
    @Test
    void initialJoinIsAdmittedOnlyAfterReadyAndForCurrentIdentity() {
        Object server = new Object(), player = new Object(); UUID id = UUID.fromString(PLAYER);
        GameSession.PendingJoin pending = new GameSession.PendingJoin();
        List<Double> position = new ArrayList<>(List.of(3d, 4d, 5d));
        Map<String, Object> data = new HashMap<>(Map.of("state", "joined"));
        ObservedEvent joined = new ObservedEvent("player_connection_changed", "minecraft:the_nether", position, 17, 23, data);
        pending.capture(server, player, id, joined); position.set(0, 99d); data.put("state", "leaving");
        Wire wire = new Wire(); RpcPeer peer = new RpcPeer(wire); Game game = new Game(); game.queuedInitialize = true;
        GameSession session = new GameSession(peer, game, WORLD, PLAYER, List.of("player_connection_changed"), false);
        boolean[] current = {true}, baseline = {false};
        CompletionStage<Void> start = session.start(CompletableFuture.completedFuture(peer), "a".repeat(43));
        Runnable admission = () -> {
            if (!current[0] || !session.isReady()) return;
            ObservedEvent fact = pending.take(server, player, id);
            if (fact != null) session.observation(fact);
            if (current[0] && session.isReady()) baseline[0] = true;
        };
        start.thenRun(() -> game.queue.add(admission));
        reply(peer, wire, json("{\"protocolVersion\":1,\"role\":\"game\"}")); reply(peer, wire, RUN.worldBinding().toJson());
        receive(peer, "game.run.bind", RUN.toJson(), 501);
        assertTrue(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32001);
        assertTrue(!session.isReady()); assertTrue(!baseline[0]); game.queue.remove().run();
        JsonElement readyId = wire.last().get("id");
        assertTrue(session.isReady()); assertTrue(!start.toCompletableFuture().isDone()); assertTrue(!baseline[0]); assertTrue(game.queue.isEmpty());
        receive(peer, "game.run.bind", RUN.toJson(), 502); assertTrue(wire.last().get("result").equals(RUN.toJson()));
        JsonObject ack = json("{\"jsonrpc\":\"2.0\",\"result\":{\"ready\":true}}"); ack.add("id", readyId);
        peer.receive((ack + "\n").getBytes(StandardCharsets.UTF_8)); assertTrue(!baseline[0]); assertTrue(game.queue.size() == 1);
        game.queue.remove().run(); assertTrue(baseline[0]);
        JsonObject admitted = wire.last().getAsJsonObject("params");
        assertTrue(admitted.get("seq").getAsInt() == 1); assertTrue(admitted.get("dimension").getAsString().equals("minecraft:the_nether"));
        assertTrue(admitted.get("tick").getAsLong() == 17); assertTrue(admitted.get("observedAt").getAsLong() == 23);
        assertTrue(admitted.getAsJsonArray("position").get(0).getAsDouble() == 3);
        assertTrue(admitted.getAsJsonObject("data").get("state").getAsString().equals("joined"));
        assertTrue(pending.take(server, player, id) == null); // Unknown event ACK never retains/replays JOIN.
        reply(peer, wire, json("{\"stored\":1}"));
        session.observation(new ObservedEvent("health_changed", "minecraft:overworld", List.of(30d, 40d, 50d), 99, 101, Map.of("previous", 20, "current", 19)));
        assertTrue(wire.last().getAsJsonObject("params").get("seq").getAsInt() == 2);
        assertTrue(wire.last().getAsJsonObject("params").get("event").getAsString().equals("health_changed")); session.close();
        pending.capture(server, player, id, joined); pending.retain(server, new Object(), id); assertTrue(pending.take(server, player, id) == null);
        pending.capture(server, player, id, joined); assertTrue(pending.take(server, player, UUID.randomUUID()) == null); assertTrue(pending.take(server, player, id) == null);
        pending.capture(server, player, id, joined); assertTrue(pending.take(new Object(), player, id) == null); assertTrue(pending.take(server, player, id) == joined);
        pending.capture(server, player, id, joined); pending.retire(server); assertTrue(pending.take(server, player, id) == null);
        pending.capture(server, player, id, joined); pending.retire(null); assertTrue(pending.take(server, player, id) == null);
        // Retired queued admission cannot reopen a replacement owner, even with identical textual binding.
        current[0] = false; baseline[0] = false; Object replacementServer = new Object();
        pending.capture(replacementServer, player, id, joined); pending.retire(server); game.queue.add(admission);
        game.queue.remove().run(); assertTrue(!baseline[0]); assertTrue(pending.take(replacementServer, player, id) == joined);
        assertTrue(pending.take(new Object(), player, id) == null);
        Wire failedWire = new Wire(); RpcPeer failedPeer = new RpcPeer(failedWire); Game failedGame = new Game();
        GameSession failed = new GameSession(failedPeer, failedGame, WORLD, PLAYER, List.of(), false);
        failed.start(CompletableFuture.completedFuture(failedPeer), "a".repeat(43));
        reply(failedPeer, failedWire, json("{\"protocolVersion\":1,\"role\":\"game\"}")); reply(failedPeer, failedWire, RUN.worldBinding().toJson());
        reply(failedPeer, failedWire, json("{\"ready\":true}"));
        pending.capture(server, player, id, joined); baseline[0] = false;
        failedWire.beforeSchedule = failed::close;
        failedGame.queue.add(() -> {
            ObservedEvent taken = pending.take(server, player, id); failed.observation(taken);
            if (failed.isReady()) baseline[0] = true;
        });
        failedGame.queue.remove().run(); assertTrue(!baseline[0]);
        assertTrue(!failed.isReady()); assertTrue(pending.take(server, player, id) == null); assertTrue(failedWire.sent.size() == 3);
        Wire badWire = new Wire(); RpcPeer badPeer = new RpcPeer(badWire); Game badGame = new Game();
        GameSession bad = new GameSession(badPeer, badGame, WORLD, PLAYER, List.of(), false);
        pending.capture(server, player, id, joined);
        CompletionStage<Void> badStart = bad.start(CompletableFuture.completedFuture(badPeer), "a".repeat(43));
        badStart.whenComplete((ignored, error) -> { if (error != null) pending.retire(server); else badGame.queue.add(admission); });
        reply(badPeer, badWire, json("{\"protocolVersion\":1,\"role\":\"game\"}")); reply(badPeer, badWire, RUN.worldBinding().toJson());
        reply(badPeer, badWire, json("{\"ready\":false}"));
        assertTrue(badStart.toCompletableFuture().isCompletedExceptionally()); assertTrue(!bad.isReady());
        assertTrue(badGame.queue.isEmpty()); assertTrue(pending.take(server, player, id) == null);
    }
    @Test
    void runtimeIsAbsent() {
        assertThrows(ClassNotFoundException.class, () -> Class.forName("net.minecraft.client.Minecraft"));
    }

    @Test
    void directorFilesRejectInvalidValuesWithoutLeakingSecrets() {
        String connection = "{\"protocolVersion\":1,\"host\":\"127.0.0.1\",\"port\":1234,\"token\":\"" + "a".repeat(43) + "\",\"pid\":1}";
        assertTrue(DirectorFiles.parseConnection(connection).port() == 1234);
        assertTrue(!DirectorFiles.parseConnection(connection).toString().contains("a".repeat(43)));
        rejects(() -> DirectorFiles.parseConnection(connection + "{}"));
        rejects(() -> DirectorFiles.parseConnection(connection.replace("1234", "65536")));
        rejects(() -> DirectorFiles.parseConnection(connection.replace("1234", "1.5")));
        rejects(() -> DirectorFiles.parseConnection(connection.replace("\"protocolVersion\":1", "\"protocolVersion\":2")));
        rejects(() -> DirectorFiles.parseConnection(connection.replace("a".repeat(43), "SECRET")));
        rejects(() -> DirectorFiles.parseConnection(connection.replace("127.0.0.1", "localhost")));
        rejects(() -> DirectorFiles.parseConnection(connection.replace("1234", "0")));
        rejects(() -> DirectorFiles.parseConnection(connection.replace("\"pid\":1", "\"pid\":\"SECRET\"")));
        rejects(() -> DirectorFiles.parseConnection(connection.replace("\"pid\":1", "\"pid\":1,\"pid\":2")));
        rejects(() -> DirectorFiles.parseConnection(connection.replace("\"pid\":1", "\"pid\":1,\"extra\":true")));
        assertTrue(DirectorFiles.parseSettings("{\"dataDirectory\":\"/tmp/director\"}").equals(Path.of("/tmp/director")));
        rejects(() -> DirectorFiles.parseSettings("{\"dataDirectory\":\"relative\"}"));
        rejects(() -> DirectorFiles.parseSettings("{}"));
        assertTrue(DirectorFiles.parseWorldId(WORLD + "\n").equals(WORLD));
        rejects(() -> DirectorFiles.parseWorldId(WORLD));
        rejects(() -> DirectorFiles.parseWorldId("0-0-0-0-1\n"));
    }

    @Test
    void sessionLifecycleFencesQueuedWork() {
        Wire wire = new Wire(); RpcPeer peer = new RpcPeer(wire); Game game = new Game();
        GameSession session = new GameSession(peer, game, WORLD, PLAYER, List.of("block_broken"), false);
        receive(peer, "game.run.bind", RUN.toJson(), 1); assertTrue(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32001);
        CompletionStage<Void> started = session.start(CompletableFuture.completedFuture(peer), "a".repeat(43));
        assertTrue(wire.last().get("method").getAsString().equals("bridge.hello"));
        reply(peer, wire, json("{\"protocolVersion\":1,\"role\":\"game\"}"));
        assertTrue(wire.last().get("method").getAsString().equals("game.attach"));
        reply(peer, wire, RUN.worldBinding().toJson());
        assertTrue(session.isReady()); assertTrue(wire.last().get("method").getAsString().equals("game.ready"));
        receive(peer, "game.run.bind", RUN.toJson(), 2); assertTrue(wire.last().get("result").equals(RUN.toJson()));
        JsonObject readyReply = json("{\"jsonrpc\":\"2.0\",\"id\":\"3\",\"result\":{\"ready\":true}}"); peer.receive((readyReply+"\n").getBytes(StandardCharsets.UTF_8));
        started.toCompletableFuture().join(); assertTrue(session.isReady());
        receive(peer, "game.run.bind", RUN.toJson(), 20); assertTrue(wire.last().get("result").equals(RUN.toJson()));
        JsonObject referenceRequest = RUN.toJson(); referenceRequest.add("query", json("{}"));
        receive(peer, "game.files.list", referenceRequest, 301); assertTrue(game.references == 0); game.queue.remove().run();
        assertTrue(game.references == 1); assertTrue(wire.last().getAsJsonObject("result").get("runId").getAsString().equals(RUN.runId()));
        receive(peer, "game.files.list", referenceRequest, 302); session.pause(true); game.queue.remove().run();
        assertTrue(game.references == 1); assertTrue(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32001);
        session.pause(false); receive(peer, "game.run.bind", RUN.toJson(), 303);
        game.afterRead = () -> session.pause(true); receive(peer, "game.files.list", referenceRequest, 304); game.queue.remove().run();
        assertTrue(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32001); game.afterRead = () -> {};
        session.pause(false); receive(peer, "game.run.bind", RUN.toJson(), 305);
        JsonObject invalidReference = RUN.toJson(); invalidReference.add("query", json("{\"root\":\"minecraft:0\",\"path\":\"../SECRET\"}"));
        receive(peer, "game.files.read", invalidReference, 306); assertTrue(game.queue.isEmpty()); assertTrue(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32602);
        for (String method : List.of("game.files.list", "game.files.read", "game.files.search")) {
            JsonObject request = RUN.toJson();
            request.add("query", method.endsWith("list") ? json("{}") : method.endsWith("read") ? json("{\"root\":\"minecraft:0\",\"path\":\"x.json\"}") : json("{\"root\":\"minecraft:0\",\"path\":\"\",\"text\":\"needle\"}"));
            int readCount = game.references;
            receive(peer, method, request, 310); assertTrue(game.queue.size() == 1);
            receive(peer, "game.run.clear", RUN.toJson(), 311); receive(peer, "game.run.bind", RUN.toJson(), 312);
            game.queue.remove().run(); assertTrue(game.references == readCount);
            assertTrue(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32001); assertTrue(game.queue.isEmpty());
            game.afterRead = () -> session.pause(true); receive(peer, method, request, 313); game.queue.remove().run();
            assertTrue(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32001);
            game.afterRead = () -> {}; session.pause(false); receive(peer, "game.run.bind", RUN.toJson(), 314);
            request.addProperty("host", "/SECRET"); receive(peer, method, request, 315);
            assertTrue(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32602); assertTrue(game.queue.isEmpty());
        }
        CompletionStage<Void> accepted = session.playerMessage("日本語");
        assertTrue(wire.last().get("method").getAsString().equals("game.player_message"));
        assertTrue(wire.last().getAsJsonObject("params").get("worldSessionId").getAsString().equals("session"));
        reply(peer, wire, json("{\"accepted\":true}")); accepted.toCompletableFuture().join();
        ObservedEvent fact = new ObservedEvent("block_broken", "minecraft:overworld", List.of(0d, 1d, 2d), 4, 5, Map.of());
        session.observation(fact); assertTrue(wire.last().getAsJsonObject("params").get("seq").getAsInt() == 1);
        reply(peer, wire, json("{\"stored\":1}")); session.observation(fact);
        assertTrue(wire.last().getAsJsonObject("params").get("seq").getAsInt() == 2); reply(peer, wire, json("{\"stored\":2}"));
        receive(peer, "game.run.bind", new RunBinding(WORLD, PLAYER, "session", "other").toJson(), 3);
        assertTrue(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32001);
        JsonObject message = RUN.toJson(); message.addProperty("text", "hello");
        receive(peer, "game.message.send", message, 4); assertTrue(game.displayed == 0); game.queue.remove().run();
        assertTrue(game.displayed == 1); assertTrue(wire.last().getAsJsonObject("result").get("displayed").getAsBoolean());
        JsonObject state = RUN.toJson(); state.add("query", json("{}")); receive(peer, "game.state.get", state, 5);
        session.pause(true); game.queue.remove().run(); assertTrue(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32001);
        session.pause(false); receive(peer, "game.message.send", message, 6); assertTrue(game.queue.isEmpty());
        receive(peer, "game.run.bind", RUN.toJson(), 7);
        receive(peer, "game.run.clear", new RunBinding(WORLD, PLAYER, "session", "old").toJson(), 8);
        receive(peer, "game.message.send", message, 9); assertTrue(game.queue.size() == 1);
        receive(peer, "game.run.clear", RUN.toJson(), 10);
        receive(peer, "game.run.bind", RUN.toJson(), 21); // Same textual binding must not revive a queued capture (ABA).
        game.queue.remove().run(); assertTrue(game.displayed == 1);
        assertTrue(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32001);
        receive(peer, "game.run.bind", RUN.toJson(), 11);
        JsonObject bad = state.deepCopy(); bad.getAsJsonObject("query").addProperty("raw", true); receive(peer, "game.state.get", bad, 12);
        assertTrue(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32602);
        receive(peer, "game.state.get", state, 22); game.queue.remove().run();
        assertTrue(wire.last().getAsJsonObject("result").getAsJsonObject("state").get("version").getAsInt() == 1);
        assertTrue(wire.last().getAsJsonObject("result").get("runId").getAsString().equals("run"));
        game.afterRead = () -> session.pause(true);
        receive(peer, "game.state.get", state, 23); game.queue.remove().run();
        assertTrue(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32001);
        session.pause(false); receive(peer, "game.run.bind", RUN.toJson(), 24);
        JsonObject oversize = message.deepCopy(); oversize.addProperty("text", "😀".repeat(16001));
        receive(peer, "game.message.send", oversize, 25); assertTrue(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32602);
        oversize.addProperty("text", " \t"); receive(peer, "game.message.send", oversize, 26);
        assertTrue(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32602);
        oversize.addProperty("text", "\u00a0\t\ufeff"); receive(peer, "game.message.send", oversize, 28);
        assertTrue(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32602);
        oversize.addProperty("text", "😀".repeat(16000)); receive(peer, "game.message.send", oversize, 27);
        assertTrue(game.queue.size() == 1); game.queue.remove().run(); assertTrue(game.displayed == 2);
        receive(peer, "game.message.send", message, 13); int oldFrames = wire.sent.size(); session.close();
        Wire replacementWire = new Wire(); RpcPeer replacementPeer = new RpcPeer(replacementWire); Game replacementGame = new Game();
        GameSession replacement = new GameSession(replacementPeer, replacementGame, "new-world", PLAYER, List.of(), false);
        replacement.start(CompletableFuture.completedFuture(replacementPeer), "a".repeat(43));
        reply(replacementPeer, replacementWire, json("{\"protocolVersion\":1,\"role\":\"game\"}"));
        JsonObject newWorld = RUN.worldBinding().toJson(); newWorld.addProperty("worldId", "new-world");
        reply(replacementPeer, replacementWire, newWorld); reply(replacementPeer, replacementWire, json("{\"ready\":true}"));
        game.queue.remove().run(); assertTrue(game.displayed == 2); assertTrue(!session.isReady());
        assertTrue(replacement.isReady()); assertTrue(replacementGame.displayed == 0); assertTrue(wire.sent.size() == oldFrames); replacement.close();
    }

    @Test
    void wrongHandshakeRoleClosesPeer() {
        Wire badWire = new Wire(); RpcPeer badPeer = new RpcPeer(badWire); GameSession badSession = new GameSession(badPeer, new Game(), WORLD, PLAYER, List.of(), false);
        badSession.start(CompletableFuture.completedFuture(badPeer), "a".repeat(43)); reply(badPeer, badWire, json("{\"protocolVersion\":1,\"role\":\"agent\"}")); assertTrue(badPeer.isClosed());
    }

    @Test
    void observationOverloadClosesPeer() {
        ObservedEvent fact = new ObservedEvent("block_broken", "minecraft:overworld", List.of(0d, 1d, 2d), 4, 5, Map.of());
        Wire overloadWire = new Wire(); RpcPeer overloadPeer = new RpcPeer(overloadWire);
        GameSession overload = new GameSession(overloadPeer, new Game(), WORLD, PLAYER, List.of("block_broken"), false);
        overload.start(CompletableFuture.completedFuture(overloadPeer), "a".repeat(43));
        reply(overloadPeer, overloadWire, json("{\"protocolVersion\":1,\"role\":\"game\"}"));
        reply(overloadPeer, overloadWire, RUN.worldBinding().toJson()); reply(overloadPeer, overloadWire, json("{\"ready\":true}"));
        for (int i = 1; i <= 32; i++) { overload.observation(fact); assertTrue(overloadWire.last().getAsJsonObject("params").get("seq").getAsInt() == i); }
        int before = overloadWire.sent.size(); overload.observation(fact); assertTrue(overloadPeer.isClosed()); assertTrue(overloadWire.sent.size() == before);
    }

    @Test
    void wrongAttachedWorldClosesPeer() {
        Wire wrongWire = new Wire(); RpcPeer wrongPeer = new RpcPeer(wrongWire);
        GameSession wrong = new GameSession(wrongPeer, new Game(), WORLD, PLAYER, List.of(), false);
        wrong.start(CompletableFuture.completedFuture(wrongPeer), "a".repeat(43)); reply(wrongPeer, wrongWire, json("{\"protocolVersion\":1,\"role\":\"game\"}"));
        JsonObject wrongWorld = RUN.worldBinding().toJson(); wrongWorld.addProperty("worldId", "other");
        reply(wrongPeer, wrongWire, wrongWorld); assertTrue(wrongPeer.isClosed()); assertTrue(!wrong.isReady());
    }

    @Test
    void invalidPlayerMessageAcknowledgmentClosesPeer() {
        Wire ackWire = new Wire(); RpcPeer ackPeer = new RpcPeer(ackWire);
        GameSession ackSession = new GameSession(ackPeer, new Game(), WORLD, PLAYER, List.of(), false);
        ackSession.start(CompletableFuture.completedFuture(ackPeer), "a".repeat(43)); reply(ackPeer, ackWire, json("{\"protocolVersion\":1,\"role\":\"game\"}"));
        reply(ackPeer, ackWire, RUN.worldBinding().toJson()); reply(ackPeer, ackWire, json("{\"ready\":true}"));
        CompletionStage<Void> invalidAck = ackSession.playerMessage("hello"); reply(ackPeer, ackWire, json("{\"accepted\":false}"));
        assertTrue(invalidAck.toCompletableFuture().isCompletedExceptionally()); assertTrue(ackPeer.isClosed());
    }

    @Test
    void pauseTransitionsAreOrderedAndBounded() {
        JsonObject message = RUN.toJson(); message.addProperty("text", "hello");
        Wire orderedWire = new Wire(); RpcPeer orderedPeer = new RpcPeer(orderedWire); Game orderedGame = new Game();
        GameSession ordered = new GameSession(orderedPeer, orderedGame, WORLD, PLAYER, List.of(), false);
        ordered.start(CompletableFuture.completedFuture(orderedPeer), "a".repeat(43));
        reply(orderedPeer, orderedWire, json("{\"protocolVersion\":1,\"role\":\"game\"}"));
        reply(orderedPeer, orderedWire, RUN.worldBinding().toJson()); reply(orderedPeer, orderedWire, json("{\"ready\":true}"));
        receive(orderedPeer, "game.run.bind", RUN.toJson(), 100);
        receive(orderedPeer, "game.message.send", message, 101);
        orderedWire.beforeSchedule = () -> {
            orderedWire.beforeSchedule = () -> {};
            // RpcPeer has reserved the true request but has not written it: the other caller resumes.
            ordered.pause(false);
            orderedGame.queue.remove().run();
            assertTrue(orderedGame.displayed == 0);
            assertTrue(orderedWire.last().getAsJsonObject("error").get("code").getAsInt() == -32001);
        };
        ordered.pause(true);
        List<JsonObject> statuses = orderedWire.sent.stream().filter(frame -> frame.has("method")
                && frame.get("method").getAsString().equals("game.status")).toList();
        assertTrue(statuses.size() == 2);
        assertTrue(statuses.getFirst().getAsJsonObject("params").get("paused").getAsBoolean());
        assertTrue(!statuses.getLast().getAsJsonObject("params").get("paused").getAsBoolean());
        assertTrue(statuses.stream().allMatch(frame -> {
            JsonObject params = frame.getAsJsonObject("params").deepCopy(); params.remove("paused");
            return params.equals(RUN.worldBinding().toJson());
        }));
        int orderedFrames = orderedWire.sent.size(); ordered.pause(false);
        assertTrue(orderedWire.sent.size() == orderedFrames); assertTrue(ordered.isReady());
        orderedWire.beforeSchedule = () -> {
            orderedWire.beforeSchedule = () -> {};
            for (int i = 0; i < 31; i++) ordered.pause(i % 2 != 0);
            assertTrue(!orderedPeer.isClosed()); // Head + 31 waiting transitions fit; the next must fail closed.
            ordered.pause(true); assertTrue(orderedPeer.isClosed());
        };
        ordered.pause(true); // Closing reentrantly during scheduling must safely retire the drainer too.
        assertTrue(!ordered.isReady()); assertTrue(orderedWire.sent.size() == orderedFrames);
        ordered.pause(false); assertTrue(orderedWire.sent.size() == orderedFrames);
    }
}

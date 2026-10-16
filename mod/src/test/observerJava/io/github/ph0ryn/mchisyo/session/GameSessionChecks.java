package io.github.ph0ryn.mchisyo.session;

import com.google.gson.*;
import io.github.ph0ryn.mchisyo.protocol.RunBinding;
import io.github.ph0ryn.mchisyo.observation.ObservedEvent;
import io.github.ph0ryn.mchisyo.transport.RpcPeer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;

/** Literal wire/manual queued game work only; no resource adapters are instantiated. */
public final class GameSessionChecks {
    private static int checks;
    private static final String WORLD = "00000000-0000-0000-0000-000000000001";
    private static final String PLAYER = "00000000-0000-0000-0000-000000000002";
    private static final RunBinding RUN = new RunBinding(WORLD, PLAYER, "session", "run");
    private static void check(boolean value) { checks++; if (!value) throw new AssertionError("check " + checks); }
    private static JsonObject json(String text) { return JsonParser.parseString(text).getAsJsonObject(); }
    private static void rejects(Runnable work) { try { work.run(); throw new AssertionError("accepted"); } catch (IllegalArgumentException expected) { check(!expected.toString().contains("SECRET")); } }
    private static final class Wire implements RpcPeer.Port {
        final List<JsonObject> sent = new ArrayList<>();
        public void write(byte[] bytes) { sent.add(json(new String(bytes, StandardCharsets.UTF_8))); }
        public RpcPeer.Deadline schedule(long delay, Runnable work) { return () -> {}; }
        public void close() {}
        JsonObject last() { return sent.getLast(); }
    }
    private static final class Game implements GameSession.GamePort {
        final ArrayDeque<Runnable> queue = new ArrayDeque<>();
        int displayed;
        Runnable afterRead = () -> {};
        public CompletionStage<Void> initialize() { return CompletableFuture.completedFuture(null); }
        public CompletionStage<JsonObject> snapshot(GameSession.Capture capture) {
            CompletableFuture<JsonObject> result = new CompletableFuture<>();
            queue.add(() -> { try { capture.requireCurrent(); JsonObject copy = json("{\"version\":1}"); afterRead.run(); result.complete(copy); } catch (RuntimeException e) { result.completeExceptionally(e); } });
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
    public static void main(String[] args) {
        try { Class.forName("net.minecraft.client.Minecraft"); throw new AssertionError("game runtime present"); } catch (ClassNotFoundException expected) { check(true); }
        String connection = "{\"protocolVersion\":1,\"host\":\"127.0.0.1\",\"port\":1234,\"token\":\"" + "a".repeat(43) + "\",\"pid\":1}";
        check(DirectorFiles.parseConnection(connection).port() == 1234);
        check(!DirectorFiles.parseConnection(connection).toString().contains("a".repeat(43)));
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
        check(DirectorFiles.parseSettings("{\"dataDirectory\":\"/tmp/director\"}").equals(Path.of("/tmp/director")));
        rejects(() -> DirectorFiles.parseSettings("{\"dataDirectory\":\"relative\"}"));
        rejects(() -> DirectorFiles.parseSettings("{}"));
        check(DirectorFiles.parseWorldId(WORLD + "\n").equals(WORLD));
        rejects(() -> DirectorFiles.parseWorldId(WORLD));
        rejects(() -> DirectorFiles.parseWorldId("0-0-0-0-1\n"));
        Wire wire = new Wire(); RpcPeer peer = new RpcPeer(wire); Game game = new Game();
        GameSession session = new GameSession(peer, game, WORLD, PLAYER, List.of("block_broken"), false);
        receive(peer, "game.run.bind", RUN.toJson(), 1); check(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32001);
        CompletionStage<Void> started = session.start(CompletableFuture.completedFuture(peer), "a".repeat(43));
        check(wire.last().get("method").getAsString().equals("bridge.hello"));
        reply(peer, wire, json("{\"protocolVersion\":1,\"role\":\"game\"}"));
        check(wire.last().get("method").getAsString().equals("game.attach"));
        reply(peer, wire, RUN.worldBinding().toJson());
        check(session.isReady()); check(wire.last().get("method").getAsString().equals("game.ready"));
        receive(peer, "game.run.bind", RUN.toJson(), 2); check(wire.last().get("result").equals(RUN.toJson()));
        JsonObject readyReply = json("{\"jsonrpc\":\"2.0\",\"id\":\"3\",\"result\":{\"ready\":true}}"); peer.receive((readyReply+"\n").getBytes(StandardCharsets.UTF_8));
        started.toCompletableFuture().join(); check(session.isReady());
        receive(peer, "game.run.bind", RUN.toJson(), 20); check(wire.last().get("result").equals(RUN.toJson()));
        CompletionStage<Void> accepted = session.playerMessage("日本語");
        check(wire.last().get("method").getAsString().equals("game.player_message"));
        check(wire.last().getAsJsonObject("params").get("worldSessionId").getAsString().equals("session"));
        reply(peer, wire, json("{\"accepted\":true}")); accepted.toCompletableFuture().join();
        ObservedEvent fact = new ObservedEvent("block_broken", "minecraft:overworld", List.of(0d, 1d, 2d), 4, 5, Map.of());
        session.observation(fact); check(wire.last().getAsJsonObject("params").get("seq").getAsInt() == 1);
        reply(peer, wire, json("{\"stored\":1}")); session.observation(fact);
        check(wire.last().getAsJsonObject("params").get("seq").getAsInt() == 2); reply(peer, wire, json("{\"stored\":2}"));
        receive(peer, "game.run.bind", new RunBinding(WORLD, PLAYER, "session", "other").toJson(), 3);
        check(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32001);
        JsonObject message = RUN.toJson(); message.addProperty("text", "hello");
        receive(peer, "game.message.send", message, 4); check(game.displayed == 0); game.queue.remove().run();
        check(game.displayed == 1); check(wire.last().getAsJsonObject("result").get("displayed").getAsBoolean());
        JsonObject state = RUN.toJson(); state.add("query", json("{}")); receive(peer, "game.state.get", state, 5);
        session.pause(true); game.queue.remove().run(); check(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32001);
        session.pause(false); receive(peer, "game.message.send", message, 6); check(game.queue.isEmpty());
        receive(peer, "game.run.bind", RUN.toJson(), 7);
        receive(peer, "game.run.clear", new RunBinding(WORLD, PLAYER, "session", "old").toJson(), 8);
        receive(peer, "game.message.send", message, 9); check(game.queue.size() == 1);
        receive(peer, "game.run.clear", RUN.toJson(), 10);
        receive(peer, "game.run.bind", RUN.toJson(), 21); // Same textual binding must not revive a queued capture (ABA).
        game.queue.remove().run(); check(game.displayed == 1);
        check(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32001);
        receive(peer, "game.run.bind", RUN.toJson(), 11);
        JsonObject bad = state.deepCopy(); bad.getAsJsonObject("query").addProperty("raw", true); receive(peer, "game.state.get", bad, 12);
        check(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32602);
        receive(peer, "game.state.get", state, 22); game.queue.remove().run();
        check(wire.last().getAsJsonObject("result").getAsJsonObject("state").get("version").getAsInt() == 1);
        check(wire.last().getAsJsonObject("result").get("runId").getAsString().equals("run"));
        game.afterRead = () -> session.pause(true);
        receive(peer, "game.state.get", state, 23); game.queue.remove().run();
        check(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32001);
        session.pause(false); receive(peer, "game.run.bind", RUN.toJson(), 24);
        JsonObject oversize = message.deepCopy(); oversize.addProperty("text", "😀".repeat(16001));
        receive(peer, "game.message.send", oversize, 25); check(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32602);
        oversize.addProperty("text", " \t"); receive(peer, "game.message.send", oversize, 26);
        check(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32602);
        oversize.addProperty("text", "\u00a0\t\ufeff"); receive(peer, "game.message.send", oversize, 28);
        check(wire.last().getAsJsonObject("error").get("code").getAsInt() == -32602);
        oversize.addProperty("text", "😀".repeat(16000)); receive(peer, "game.message.send", oversize, 27);
        check(game.queue.size() == 1); game.queue.remove().run(); check(game.displayed == 2);
        receive(peer, "game.message.send", message, 13); int oldFrames = wire.sent.size(); session.close();
        Wire replacementWire = new Wire(); RpcPeer replacementPeer = new RpcPeer(replacementWire); Game replacementGame = new Game();
        GameSession replacement = new GameSession(replacementPeer, replacementGame, "new-world", PLAYER, List.of(), false);
        replacement.start(CompletableFuture.completedFuture(replacementPeer), "a".repeat(43));
        reply(replacementPeer, replacementWire, json("{\"protocolVersion\":1,\"role\":\"game\"}"));
        JsonObject newWorld = RUN.worldBinding().toJson(); newWorld.addProperty("worldId", "new-world");
        reply(replacementPeer, replacementWire, newWorld); reply(replacementPeer, replacementWire, json("{\"ready\":true}"));
        game.queue.remove().run(); check(game.displayed == 2); check(!session.isReady());
        check(replacement.isReady()); check(replacementGame.displayed == 0); check(wire.sent.size() == oldFrames); replacement.close();
        Wire badWire = new Wire(); RpcPeer badPeer = new RpcPeer(badWire); GameSession badSession = new GameSession(badPeer, new Game(), WORLD, PLAYER, List.of(), false);
        badSession.start(CompletableFuture.completedFuture(badPeer), "a".repeat(43)); reply(badPeer, badWire, json("{\"protocolVersion\":1,\"role\":\"agent\"}")); check(badPeer.isClosed());
        Wire overloadWire = new Wire(); RpcPeer overloadPeer = new RpcPeer(overloadWire);
        GameSession overload = new GameSession(overloadPeer, new Game(), WORLD, PLAYER, List.of("block_broken"), false);
        overload.start(CompletableFuture.completedFuture(overloadPeer), "a".repeat(43));
        reply(overloadPeer, overloadWire, json("{\"protocolVersion\":1,\"role\":\"game\"}"));
        reply(overloadPeer, overloadWire, RUN.worldBinding().toJson()); reply(overloadPeer, overloadWire, json("{\"ready\":true}"));
        for (int i = 1; i <= 32; i++) { overload.observation(fact); check(overloadWire.last().getAsJsonObject("params").get("seq").getAsInt() == i); }
        int before = overloadWire.sent.size(); overload.observation(fact); check(overloadPeer.isClosed()); check(overloadWire.sent.size() == before);
        Wire wrongWire = new Wire(); RpcPeer wrongPeer = new RpcPeer(wrongWire);
        GameSession wrong = new GameSession(wrongPeer, new Game(), WORLD, PLAYER, List.of(), false);
        wrong.start(CompletableFuture.completedFuture(wrongPeer), "a".repeat(43)); reply(wrongPeer, wrongWire, json("{\"protocolVersion\":1,\"role\":\"game\"}"));
        JsonObject wrongWorld = RUN.worldBinding().toJson(); wrongWorld.addProperty("worldId", "other");
        reply(wrongPeer, wrongWire, wrongWorld); check(wrongPeer.isClosed()); check(!wrong.isReady());
        Wire ackWire = new Wire(); RpcPeer ackPeer = new RpcPeer(ackWire);
        GameSession ackSession = new GameSession(ackPeer, new Game(), WORLD, PLAYER, List.of(), false);
        ackSession.start(CompletableFuture.completedFuture(ackPeer), "a".repeat(43)); reply(ackPeer, ackWire, json("{\"protocolVersion\":1,\"role\":\"game\"}"));
        reply(ackPeer, ackWire, RUN.worldBinding().toJson()); reply(ackPeer, ackWire, json("{\"ready\":true}"));
        CompletionStage<Void> invalidAck = ackSession.playerMessage("hello"); reply(ackPeer, ackWire, json("{\"accepted\":false}"));
        check(invalidAck.toCompletableFuture().isCompletedExceptionally()); check(ackPeer.isClosed());
        System.out.println("GameSessionChecks: " + checks + " assertions (pure/manual ports only)");
    }
}

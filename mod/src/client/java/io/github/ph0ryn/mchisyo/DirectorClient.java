package io.github.ph0ryn.mchisyo;

import com.google.gson.JsonObject;
import com.mojang.brigadier.arguments.StringArgumentType;
import io.github.ph0ryn.mchisyo.observation.ObservedEvent;
import io.github.ph0ryn.mchisyo.observation.ServerGameState;
import io.github.ph0ryn.mchisyo.observation.ServerObservations;
import io.github.ph0ryn.mchisyo.reference.PackagedReferences;
import io.github.ph0ryn.mchisyo.session.DirectorFiles;
import io.github.ph0ryn.mchisyo.session.GameSession;
import io.github.ph0ryn.mchisyo.transport.LoopbackConnection;
import io.github.ph0ryn.mchisyo.transport.RpcError;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.function.Supplier;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandManager;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.storage.LevelResource;

/** Native Fabric composition. Game/client queues own game access; one bounded worker owns bootstrap I/O. */
final class DirectorClient {
    private final Minecraft client;
    private final Path configDir;
    private final ThreadPoolExecutor bootstrap = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(1), task -> { Thread thread = new Thread(task, "mc-hisyo-bootstrap"); thread.setDaemon(true); return thread; });
    private final ServerObservations observations;
    private final GameSession.PendingJoin pendingJoin = new GameSession.PendingJoin();
    private volatile Attempt active;
    private volatile Attempt baselineOwner;
    private IntegratedServer seenServer; // Client-thread admission: once per world entry, never auto-reconnect.
    private boolean stopping;

    private static final class Attempt {
        final IntegratedServer server;
        final UUID player;
        volatile boolean retired;
        volatile GameSession session;
        volatile LoopbackConnection connection;
        boolean probing, began, feedbackSent;
        PackagedReferences references; // Owned only by the existing bounded bootstrap worker.
        Attempt(IntegratedServer server, UUID player) { this.server = server; this.player = player; }
    }
    DirectorClient(Minecraft client, Path configDir) {
        this.client = client; this.configDir = configDir;
        observations = ServerObservations.register(player -> {
            if (localServerPlayer(player)) pendingJoin.retain(player.level().getServer(), player, player.getUUID());
            Attempt a = active;
            if (a != null && a.server == player.level().getServer() && a.server.isPublished()) retire(a);
            return a != null && active == a && !a.retired && baselineOwner == a && a.session != null
                    && a.session.isReady() && a.server == player.level().getServer() && a.player.equals(player.getUUID());
        }, event -> {
            Attempt a = active;
            if (a != null && !a.retired && a.server.isSameThread() && !a.server.isPublished()
                    && baselineOwner == a && a.session != null) a.session.observation(event);
        }, ServerObservations.DEFAULT_MOVEMENT_SAMPLING, this::nativeConnection);
        ClientTickEvents.END_CLIENT_TICK.register(ignored -> tick());
        ClientPlayConnectionEvents.DISCONNECT.register((handler, minecraft) -> { pendingJoin.retire(null); retire(active); seenServer = null; });
        ServerLifecycleEvents.SERVER_STOPPING.register(server -> { pendingJoin.retire(server); Attempt a = active; if (a != null && a.server == server) retire(a); });
        ClientLifecycleEvents.CLIENT_STOPPING.register(ignored -> { stopping = true; pendingJoin.retire(null); retire(active); bootstrap.shutdownNow(); });
        ClientCommandRegistrationCallback.EVENT.register((dispatcher, registry) -> {
            if (dispatcher.getRoot().getChild("ai") != null) throw new IllegalStateException("Client command /ai is already registered");
            dispatcher.register(ClientCommandManager.literal("ai")
                    .executes(context -> { feedback("Usage: /ai <message>"); return 0; })
                    .then(ClientCommandManager.argument("message", StringArgumentType.greedyString())
                            .executes(context -> submit(StringArgumentType.getString(context, "message")))));
        });
    }
    private static boolean localServerPlayer(ServerPlayer player) {
        return player.level().getServer() instanceof IntegratedServer server && server.getSingleplayerProfile() != null
                && server.getSingleplayerProfile().id().equals(player.getUUID());
    }
    private void nativeConnection(ServerPlayer player, ObservedEvent event) {
        if (!localServerPlayer(player)) return;
        IntegratedServer server = (IntegratedServer) player.level().getServer();
        if (event.data().get("state").equals("leaving")) { pendingJoin.retire(server); return; }
        Attempt a = active;
        if (!server.isPublished() && (a == null || a.server != server || (!a.retired && baselineOwner != a))) {
            pendingJoin.capture(server, player, player.getUUID(), event);
        }
    }
    private boolean local(Attempt a) {
        return a != null && active == a && !a.retired && client.isSingleplayer() && client.getSingleplayerServer() == a.server
                && client.player != null && client.level != null && client.player.getUUID().equals(a.player);
    }
    private void requireClient(Attempt a) {
        if (!local(a)) { retire(a); throw GameSession.stale(); }
        if (client.isPaused() && a.session != null) a.session.pause(true);
    }
    private ServerPlayer requireServer(Attempt a) {
        if (!a.server.isSameThread()) throw new IllegalStateException("Server thread required");
        if (active != a || a.retired || a.server.isPublished() || !a.server.isRunning() || a.server.isStopped()) {
            retire(a); throw GameSession.stale();
        }
        ServerPlayer player = a.server.getPlayerList().getPlayer(a.player);
        if (player == null) { pendingJoin.retire(a.server); throw GameSession.stale(); }
        pendingJoin.retain(a.server, player, a.player);
        return player;
    }
    private void tick() {
        if (stopping) return;
        if (!client.isSingleplayer() || client.player == null || client.level == null) {
            retire(active); if (client.getSingleplayerServer() == null) { pendingJoin.retire(null); seenServer = null; } return;
        }
        IntegratedServer server = client.getSingleplayerServer(); Attempt a = active;
        if (a != null && (a.server != server || !a.player.equals(client.player.getUUID()))) { retire(a); a = null; }
        if (a == null && seenServer != server) {
            seenServer = server; a = new Attempt(server, client.player.getUUID());
            synchronized (this) { active = a; }
        }
        if (a == null) return;
        if (a.session != null) { a.session.pause(client.isPaused()); return; }
        if (a.probing || a.began || !server.isReady()) return;
        a.probing = true; Attempt captured = a;
        server.submit(() -> {
            if (captured.retired || active != captured || server.isPublished()) throw GameSession.stale();
            ServerPlayer player = server.getPlayerList().getPlayer(captured.player);
            if (player == null) return null;
            if (!player.getUUID().equals(captured.player)) throw GameSession.stale();
            return server.getWorldPath(LevelResource.ROOT);
        }).whenComplete((root, failure) -> client.execute(() -> {
            captured.probing = false;
            if (!local(captured)) { retire(captured); return; }
            if (failure != null) { failed(captured); return; }
            if (root == null) return; // STARTED can precede local-player readiness; no I/O has started.
            captured.began = true;
            try {
                bootstrap.execute(() -> {
                    if (captured.retired) return;
                    try {
                        DirectorFiles.Bootstrap files = DirectorFiles.load(configDir, root);
                        client.execute(() -> connect(captured, files));
                    } catch (Exception error) { client.execute(() -> failed(captured)); }
                });
            } catch (RejectedExecutionException full) { failed(captured); }
        }));
    }
    private void connect(Attempt a, DirectorFiles.Bootstrap files) {
        if (!local(a)) { retire(a); return; }
        try {
            LoopbackConnection connection = new LoopbackConnection(files.connection().port());
            GameSession session = new GameSession(connection.peer(), new GameSession.GamePort() {
                public CompletionStage<Void> initialize() {
                    return serverTask(a, () -> { observations.clearBaselines(); baselineOwner = null; return null; });
                }
                public CompletionStage<JsonObject> snapshot(GameSession.Capture capture) {
                    return serverTask(a, () -> {
                        if (a.server.isPaused()) { a.session.pause(true); throw GameSession.stale(); }
                        capture.requireCurrent(); JsonObject snapshot = ServerGameState.snapshot(requireServer(a));
                        requireServer(a); capture.requireCurrent(); return snapshot;
                    });
                }
                public CompletionStage<JsonObject> reference(GameSession.Capture capture, String method, JsonObject query) {
                    capture.requireCurrent();
                    CompletableFuture<JsonObject> result = new CompletableFuture<>();
                    try { bootstrap.execute(() -> {
                        try {
                            Runnable guard = () -> { if (a.retired || active != a) throw GameSession.stale(); capture.requireCurrent(); };
                            guard.run();
                            if (a.references == null) {
                                ArrayList<PackagedReferences.Root> selected = new ArrayList<>();
                                guard.run();
                                for (var mod : FabricLoader.getInstance().getAllMods()) {
                                    guard.run();
                                    if (selected.size() >= 4096) throw new RpcError(-32004, "Reference root limit exceeded");
                                    String id = mod.getMetadata().getId();
                                    List<Path> paths;
                                    try { guard.run(); paths = mod.getRootPaths(); }
                                    catch (RuntimeException unavailable) { guard.run(); selected.add(new PackagedReferences.Root(id + ":0", null, null)); continue; }
                                    guard.run();
                                    if (paths.isEmpty()) selected.add(new PackagedReferences.Root(id + ":0", null, null));
                                    for (int i = 0; i < paths.size(); i++) {
                                        if (selected.size() >= 4096) throw new RpcError(-32004, "Reference root limit exceeded");
                                        selected.add(new PackagedReferences.Root(id + ":" + i, paths.get(i), null));
                                    }
                                }
                                guard.run(); a.references = new PackagedReferences(selected);
                            }
                            JsonObject reference = a.references.query(method, query, guard); guard.run(); result.complete(reference);
                        } catch (RuntimeException error) { result.completeExceptionally(error); }
                    }); } catch (RejectedExecutionException full) { result.completeExceptionally(new RpcError(-32004, "Reference worker unavailable")); }
                    return result;
                }
                public CompletionStage<Void> display(GameSession.Capture capture, String text) {
                    CompletableFuture<Void> result = new CompletableFuture<>();
                    client.execute(() -> {
                        try {
                            requireClient(a); capture.requireCurrent();
                            client.gui.getChat().addMessage(Component.literal(text)); result.complete(null);
                        } catch (RuntimeException error) { result.completeExceptionally(error); }
                    });
                    return result;
                }
            }, files.worldId(), a.player.toString(), ServerObservations.supportedEvents(), client.isPaused());
            synchronized (a) { if (!a.retired) { a.connection = connection; a.session = session; } }
            if (a.retired) { session.close(); connection.close(); return; }
            if (!local(a)) { retire(a); return; }
            connection.peer().closed().thenAccept(reason -> {
                retire(a); client.execute(() -> feedbackIfCurrentWorld(a, "Director disconnected. Leave and rejoin to reconnect."));
            });
            session.start(connection.start(), files.connection().token()).whenComplete((ignored, error) -> {
                if (error != null) { retire(a); client.execute(() -> feedbackIfCurrentWorld(a, "Director connection failed. Check the CLI and settings, then rejoin.")); }
                else serverTask(a, () -> {
                    ServerPlayer player = requireServer(a);
                    if (a.session != session || !session.isReady()) throw GameSession.stale();
                    ObservedEvent joined = pendingJoin.take(a.server, player, a.player);
                    if (joined != null) session.observation(joined);
                    // Sending can synchronously fail/retire the owner; never reopen its baseline afterwards.
                    if (requireServer(a) != player || a.session != session || !session.isReady()) throw GameSession.stale();
                    baselineOwner = a; return null;
                }).whenComplete((admitted, failure) -> {
                    if (failure != null) retire(a);
                    else client.execute(() -> { if (local(a)) feedback("Director connected. Observations while disconnected are not recorded."); });
                });
            });
        } catch (RuntimeException error) { failed(a); }
    }
    private <T> CompletionStage<T> serverTask(Attempt a, Supplier<T> task) {
        return a.server.submit(() -> { requireServer(a); T value = task.get(); requireServer(a); return value; });
    }
    private int submit(String text) {
        Attempt a = active;
        if (!local(a) || a.session == null || !a.session.isReady() || client.isPaused()) { feedback("Director is not ready in this singleplayer world."); return 0; }
        if (text.isBlank() || text.codePointCount(0, text.length()) > 16000) { feedback("Enter 1–16000 characters after /ai."); return 0; }
        try {
            requireClient(a);
            a.session.playerMessage(text).whenComplete((ignored, error) -> {
                if (error != null) client.execute(() -> { if (local(a)) feedback("Director did not accept the message."); });
            });
            return 1;
        } catch (RuntimeException error) { feedback("Director did not accept the message."); return 0; }
    }
    private void failed(Attempt a) { if (active == a) { retire(a); feedbackIfCurrentWorld(a, "Director unavailable. Check the CLI and settings, then rejoin."); } }
    private void feedbackIfCurrentWorld(Attempt a, String text) {
        if (!a.feedbackSent && !stopping && seenServer == a.server && client.isSingleplayer()
                && client.getSingleplayerServer() == a.server && client.player != null && client.player.getUUID().equals(a.player)) {
            a.feedbackSent = true; feedback(text);
        }
    }
    private void feedback(String text) { client.gui.getChat().addMessage(Component.literal("[mc-hisyo] " + text)); }
    private void retire(Attempt a) {
        if (a == null) return;
        synchronized (a) { if (a.retired) return; a.retired = true; }
        // Fence captured work before cleanup. No waits, file/socket operations, or joins on game threads.
        synchronized (this) { if (active == a) active = null; }
        pendingJoin.retire(a.server);
        if (a.session != null) a.session.close();
        if (a.connection != null) a.connection.close();
        a.server.execute(() -> { if (baselineOwner == a) { observations.clearBaselines(); baselineOwner = null; } });
    }
}

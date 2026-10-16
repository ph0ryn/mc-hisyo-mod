package io.github.ph0ryn.mchisyo.observation;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.Consumer;
import java.util.function.Predicate;
import net.fabricmc.fabric.api.entity.event.v1.ServerEntityWorldChangeEvents;
import net.fabricmc.fabric.api.entity.event.v1.ServerLivingEntityEvents;
import net.fabricmc.fabric.api.entity.event.v1.ServerPlayerEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.event.player.PlayerBlockBreakEvents;
import net.fabricmc.fabric.api.event.player.UseEntityCallback;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.Vec3;

/**
 * Common/server-only observations. Register once, not once per connection. No client entry point is installed.
 * Predicates and sinks run on the server thread; the sink must enqueue immutable facts without blocking.
 * A bridge attaching one player/session must restrict the predicate to that player, and clear baselines
 * when its binding changes even if the same player UUID remains scoped across the change.
 */
public final class ServerObservations {
    public static final SnapshotDeltaTracker.MovementSampling DEFAULT_MOVEMENT_SAMPLING =
            new SnapshotDeltaTracker.MovementSampling(20, 1.0);

    private static final List<String> SUPPORTED_EVENTS = List.of(
            "block_broken", "inventory_slot_changed", "health_changed", "food_changed",
            "experience_changed", "held_item_changed", "player_location_changed", "dimension_changed",
            "player_died", "player_respawned", "player_connection_changed", "living_damage_processed",
            "entity_use_attempted");

    private final Predicate<ServerPlayer> isScopedPlayer;
    private final Consumer<ObservedEvent> sink;
    private final SnapshotDeltaTracker tracker;

    private ServerObservations(Predicate<ServerPlayer> isScopedPlayer, Consumer<ObservedEvent> sink,
            SnapshotDeltaTracker.MovementSampling movementSampling) {
        this.isScopedPlayer = Objects.requireNonNull(isScopedPlayer);
        this.sink = Objects.requireNonNull(sink);
        this.tracker = new SnapshotDeltaTracker(movementSampling);
    }

    public static ServerObservations register(Predicate<ServerPlayer> isScopedPlayer, Consumer<ObservedEvent> sink) {
        return register(isScopedPlayer, sink, DEFAULT_MOVEMENT_SAMPLING);
    }

    public static ServerObservations register(Predicate<ServerPlayer> isScopedPlayer, Consumer<ObservedEvent> sink,
            SnapshotDeltaTracker.MovementSampling movementSampling) {
        ServerObservations observations = new ServerObservations(isScopedPlayer, sink, movementSampling);
        observations.registerCallbacks();
        return observations;
    }

    public static List<String> supportedEvents() {
        return SUPPORTED_EVENTS;
    }

    /** Call on the server thread when attaching/detaching/replacing the external world/session binding. */
    public void clearBaselines() {
        tracker.clear();
    }

    private void registerCallbacks() {
        PlayerBlockBreakEvents.AFTER.register((level, player, pos, state, blockEntity) -> {
            if (player instanceof ServerPlayer serverPlayer && scoped(serverPlayer)) {
                emit(serverPlayer, "block_broken", Map.of(
                        "blockId", BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString(),
                        "position", List.of(pos.getX(), pos.getY(), pos.getZ())));
            }
        });
        ServerTickEvents.END_SERVER_TICK.register(server -> {
            requireServerThread(server);
            for (ServerPlayer player : server.getPlayerList().getPlayers()) {
                if (scoped(player)) tracker.observe(player.getUUID(), snapshot(player)).forEach(sink);
            }
        });
        ServerPlayerEvents.JOIN.register(player -> {
            tracker.reset(player.getUUID());
            if (scoped(player)) {
                emit(player, "player_connection_changed", Map.of("state", "joined"));
                tracker.rebaseline(player.getUUID(), snapshot(player));
            }
        });
        ServerPlayerEvents.LEAVE.register(player -> {
            tracker.reset(player.getUUID());
            if (scoped(player)) emit(player, "player_connection_changed", Map.of("state", "leaving"));
        });
        ServerPlayerEvents.AFTER_RESPAWN.register((oldPlayer, newPlayer, alive) -> {
            tracker.reset(oldPlayer.getUUID());
            tracker.reset(newPlayer.getUUID());
            if (scoped(newPlayer)) {
                emit(newPlayer, "player_respawned", Map.of("alive", alive));
                tracker.rebaseline(newPlayer.getUUID(), snapshot(newPlayer));
            }
        });
        ServerEntityWorldChangeEvents.AFTER_PLAYER_CHANGE_WORLD.register((player, origin, destination) -> {
            tracker.reset(player.getUUID());
            if (scoped(player)) {
                emit(player, "dimension_changed", Map.of(
                        "fromDimension", origin.dimension().identifier().toString(),
                        "toDimension", destination.dimension().identifier().toString()));
                tracker.rebaseline(player.getUUID(), snapshot(player));
            }
        });
        ServerLivingEntityEvents.AFTER_DEATH.register((entity, source) -> {
            if (entity instanceof ServerPlayer player && scoped(player)) {
                emit(player, "player_died", damageSource(source));
            }
        });
        // Fabric excludes lethal damage. These raw callback amounts are NOT final health loss.
        ServerLivingEntityEvents.AFTER_DAMAGE.register(this::afterDamage);
        UseEntityCallback.EVENT.register((player, level, hand, entity, hitResult) -> {
            if (player instanceof ServerPlayer serverPlayer && scoped(serverPlayer)) {
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("entityId", entity.getUUID().toString());
                data.put("entityType", entityType(entity));
                data.put("hand", hand == InteractionHand.MAIN_HAND ? "main_hand" : "off_hand");
                data.put("hitPosition", hitResult == null ? null : position(hitResult.getLocation()));
                emit(serverPlayer, "entity_use_attempted", data);
            }
            // Preflight only: never intercept or claim the later vanilla interaction succeeded.
            return InteractionResult.PASS;
        });
        ServerLifecycleEvents.SERVER_STOPPED.register(server -> {
            requireServerThread(server);
            tracker.clear();
        });
    }

    private void afterDamage(LivingEntity victim, DamageSource source, float baseDamageTaken,
            float damageTaken, boolean blocked) {
        // AFTER_DAMAGE is server-only; assert before reading the damage source or checking scope.
        requireServerThread(victim.level().getServer());
        ServerPlayer receiver = victim instanceof ServerPlayer player && scoped(player) ? player : null;
        ServerPlayer causingPlayer = source.getEntity() instanceof ServerPlayer player && scoped(player) ? player : null;
        if (receiver != null) {
            emitDamage(receiver, victim, source, baseDamageTaken, damageTaken, blocked,
                    receiver == causingPlayer ? "both" : "received");
        }
        if (causingPlayer != null && causingPlayer != receiver) {
            emitDamage(causingPlayer, victim, source, baseDamageTaken, damageTaken, blocked, "dealt");
        }
    }

    private void emitDamage(ServerPlayer player, LivingEntity victim, DamageSource source,
            float baseDamageTaken, float damageTaken, boolean blocked, String relationship) {
        Map<String, Object> data = damageSource(source);
        data.put("relationship", relationship);
        data.put("victimId", victim.getUUID().toString());
        data.put("victimType", entityType(victim));
        data.put("baseDamageTaken", baseDamageTaken);
        data.put("damageTaken", damageTaken);
        data.put("blocked", blocked);
        emit(player, "living_damage_processed", data);
    }

    private boolean scoped(ServerPlayer player) {
        requireServerThread(player.level().getServer());
        if (isScopedPlayer.test(player)) return true;
        tracker.reset(player.getUUID());
        return false;
    }

    private static void requireServerThread(MinecraftServer server) {
        if (server == null || !server.isSameThread()) {
            throw new IllegalStateException("Gameplay observations require the server thread");
        }
    }

    private void emit(ServerPlayer player, String name, Map<String, Object> data) {
        sink.accept(new ObservedEvent(name, player.level().dimension().identifier().toString(),
                position(player.position()), player.level().getGameTime(), System.currentTimeMillis(), data));
    }

    private static PlayerSnapshot snapshot(ServerPlayer player) {
        List<PlayerSnapshot.Item> inventory = new ArrayList<>(player.getInventory().getContainerSize());
        for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
            inventory.add(item(player.getInventory().getItem(slot)));
        }
        String biomeId = ServerGameState.biomeId(player.level(), player.blockPosition());
        return new PlayerSnapshot(player.level().dimension().identifier().toString(), position(player.position()), biomeId,
                player.level().getGameTime(), System.currentTimeMillis(), inventory, player.getHealth(),
                player.getFoodData().getFoodLevel(), player.getFoodData().getSaturationLevel(),
                player.experienceLevel, player.experienceProgress, player.totalExperience,
                player.getInventory().getSelectedSlot(), item(player.getMainHandItem()), item(player.getOffhandItem()));
    }

    private static PlayerSnapshot.Item item(ItemStack stack) {
        return stack.isEmpty() ? new PlayerSnapshot.Item("minecraft:air", 0)
                : new PlayerSnapshot.Item(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString(), stack.getCount());
    }

    private static Map<String, Object> damageSource(DamageSource source) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("damageType", source.typeHolder().unwrapKey().orElseThrow().identifier().toString());
        Entity causing = source.getEntity();
        Entity direct = source.getDirectEntity();
        data.put("causingEntityId", causing == null ? null : causing.getUUID().toString());
        data.put("causingEntityType", causing == null ? null : entityType(causing));
        data.put("directEntityId", direct == null ? null : direct.getUUID().toString());
        data.put("directEntityType", direct == null ? null : entityType(direct));
        return data;
    }

    private static String entityType(Entity entity) {
        return BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
    }

    private static List<Double> position(Vec3 position) {
        return List.of(position.x, position.y, position.z);
    }
}

package io.github.ph0ryn.mchisyo.observation;

import com.google.gson.Gson;
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
import net.fabricmc.fabric.api.entity.event.v1.effect.ServerMobEffectEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.event.player.PlayerBlockBreakEvents;
import net.fabricmc.fabric.api.event.player.UseBlockCallback;
import net.fabricmc.fabric.api.event.player.UseEntityCallback;
import net.fabricmc.fabric.api.event.player.UseItemCallback;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.gameevent.GameEvent;
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
            "entity_use_attempted", "status_effects_sampled", "status_effect_changed", "equipment_slot_changed",
            "nearby_sampled", "structures_sampled", "weather_changed", "day_clock_phase_changed",
            "advancement_criterion_granted", "advancement_completed", "block_placed", "item_picked_up",
            "item_dropped", "grid_result_taken", "furnace_result_taken", "block_use_attempted", "item_use_attempted");

    private static volatile ServerObservations active;
    private static final Gson JSON = new Gson();

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
        if (active != null) throw new IllegalStateException("Server observations already registered");
        observations.registerCallbacks();
        active = observations;
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
        UseItemCallback.EVENT.register((player, level, hand) -> {
            if (player instanceof ServerPlayer serverPlayer && scoped(serverPlayer)) {
                emit(serverPlayer, "item_use_attempted", usedItem(serverPlayer, hand));
            }
            return InteractionResult.PASS;
        });
        UseBlockCallback.EVENT.register((player, level, hand, hit) -> {
            if (player instanceof ServerPlayer serverPlayer && scoped(serverPlayer)) {
                Map<String, Object> data = usedItem(serverPlayer, hand);
                BlockPos pos = hit.getBlockPos();
                data.put("blockPosition", blockPosition(pos));
                data.put("hitPosition", position(hit.getLocation()));
                data.put("face", hit.getDirection().getName());
                String loadedBlockId = null;
                if (!serverPlayer.level().isOutsideBuildHeight(pos)) {
                    var chunk = serverPlayer.level().getChunkSource().getChunkNow(pos.getX() >> 4, pos.getZ() >> 4);
                    if (chunk != null) loadedBlockId = BuiltInRegistries.BLOCK.getKey(chunk.getBlockState(pos).getBlock()).toString();
                }
                data.put("loadedBlockId", loadedBlockId);
                emit(serverPlayer, "block_use_attempted", data);
            }
            return InteractionResult.PASS;
        });
        ServerTickEvents.END_SERVER_TICK.register(server -> {
            requireServerThread(server);
            for (ServerPlayer player : server.getPlayerList().getPlayers()) {
                if (scoped(player)) {
                    PlayerSnapshot snapshot = snapshot(player);
                    tracker.observe(player.getUUID(), snapshot).forEach(sink);
                    if (tracker.worldSampleDue(player.getUUID(), snapshot)) sampleWorld(player, snapshot);
                }
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
        ServerMobEffectEvents.AFTER_ADD.register((effect, entity, context) -> afterEffect(entity, effect, "added"));
        ServerMobEffectEvents.AFTER_REMOVE.register((effect, entity, context) -> afterEffect(entity, effect, "removed"));
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

    // ponytail: equipment is tick-end ID/count only (7 slots), missing component-only/same-tick reversals.
    // World cadence20: <=729 block probes, <=65 entity matches/64 copied, <=256 baseline effects;
    // nearby is neither sight nor nearest/complete; weather/clock miss subinterval reversals. Widen only after measurement.
    @SuppressWarnings("unchecked")
    private void sampleWorld(ServerPlayer player, PlayerSnapshot snapshot) {
        Map<String, Object> nearby = JSON.fromJson(ServerGameState.nearby(player), Map.class);
        nearby.put("sampleIntervalTicks", SnapshotDeltaTracker.WORLD_SAMPLE_INTERVAL);
        List<Map<String, Object>> effects = player.getActiveEffects().stream().limit(256).map(ServerObservations::effect).toList();
        tracker.observeWorld(player.getUUID(), snapshot, player.level().isRaining(), player.level().isThundering(),
                player.level().getDayTime(), player.level().dimensionType().hasFixedTime(), nearby,
                ServerGameState.containingStructures(player), effects, player.getActiveEffects().size() > 256).forEach(sink);
    }

    public static boolean accepts(ServerPlayer player) {
        ServerObservations observations = active;
        return observations != null && observations.scoped(player);
    }

    public static void effectUpdated(LivingEntity entity, MobEffectInstance effect, boolean changed) {
        ServerObservations observations = active;
        if (changed && observations != null) observations.afterEffect(entity, effect, "updated");
    }

    private void afterEffect(LivingEntity entity, MobEffectInstance instance, String change) {
        if (entity instanceof ServerPlayer player && scoped(player)) {
            Map<String, Object> data = new LinkedHashMap<>(effect(instance));
            data.put("change", change);
            emit(player, "status_effect_changed", data);
        }
    }

    private static Map<String, Object> effect(MobEffectInstance instance) {
        return Map.of("effectId", instance.getEffect().unwrapKey().orElseThrow().identifier().toString(),
                "amplifier", instance.getAmplifier(), "duration", instance.getDuration(), "ambient", instance.isAmbient(),
                "visible", instance.isVisible(), "showIcon", instance.showIcon());
    }

    public static void advancementAwarded(ServerPlayer player, String advancementId, String criterion,
            boolean granted, boolean beforeDone, boolean afterDone) {
        ServerObservations observations = active;
        if (observations != null && observations.scoped(player)) {
            Map<String, Object> data = Map.of("advancementId", advancementId, "criterion", criterion, "afterDone", afterDone);
            SnapshotDeltaTracker.advancementEvents(granted, beforeDone, afterDone)
                    .forEach(name -> observations.emit(player, name, data));
        }
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

    /** Called only after the native placement game-event invocation has completed. */
    public static void blockPlaced(BlockItem item, BlockPos pos, GameEvent.Context context) {
        ServerObservations observations = active;
        if (observations == null || !(context.sourceEntity() instanceof ServerPlayer player)
                || !observations.scoped(player)) return;
        observations.emit(player, "block_placed", Map.of(
                "blockId", BuiltInRegistries.BLOCK.getKey(context.affectedState().getBlock()).toString(),
                "itemId", BuiltInRegistries.ITEM.getKey(item).toString(), "position", blockPosition(pos)));
    }

    public static void itemPickedUp(ServerPlayer player, ItemEntity entity, String itemId,
            int before, int remaining, boolean succeeded) {
        ServerObservations observations = active;
        if (observations == null || !observations.scoped(player)) return;
        int count = SnapshotDeltaTracker.consumedAmount(succeeded, before, remaining);
        if (count == 0) return;
        observations.emit(player, "item_picked_up", Map.of("itemId", itemId, "count", count,
                "remainingCount", remaining, "entityId", entity.getUUID().toString(),
                "entityPosition", position(entity.position()), "infiniteMaterials", player.hasInfiniteMaterials()));
    }

    public static void itemDropped(LivingEntity source, Entity entity, boolean succeeded, boolean spread, boolean trace) {
        ServerObservations observations = active;
        if (observations == null || !(source instanceof ServerPlayer player) || !observations.scoped(player)
                || !(entity instanceof ItemEntity dropped)) return;
        PlayerSnapshot.Item item = item(dropped.getItem());
        int count = SnapshotDeltaTracker.successfulCount(succeeded, item.count());
        if (count == 0) return;
        observations.emit(player, "item_dropped", Map.of("itemId", item.itemId(), "count", count,
                "entityId", entity.getUUID().toString(), "entityPosition", position(entity.position()),
                "spread", spread, "trace", trace));
    }

    public static void resultTaken(ServerPlayer player, Slot slot, ItemStack output, int nativeCount, boolean furnace) {
        ServerObservations observations = active;
        if (observations == null || !observations.scoped(player)) return;
        int count = SnapshotDeltaTracker.successfulCount(true, nativeCount);
        if (count == 0) return;
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("itemId", BuiltInRegistries.ITEM.getKey(output.getItem()).toString());
        data.put("count", count);
        data.put("menuId", player.containerMenu.slots.contains(slot) ? player.containerMenu.containerId : null);
        data.put("slot", slot.index);
        if (furnace) data.put("furnacePosition", slot.container instanceof BlockEntity blockEntity
                ? blockPosition(blockEntity.getBlockPos()) : null);
        observations.emit(player, furnace ? "furnace_result_taken" : "grid_result_taken", data);
    }

    private static Map<String, Object> usedItem(ServerPlayer player, InteractionHand hand) {
        PlayerSnapshot.Item held = item(player.getItemInHand(hand));
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("hand", hand == InteractionHand.MAIN_HAND ? "main_hand" : "off_hand");
        data.put("itemId", held.itemId());
        data.put("count", held.count());
        return data;
    }

    private static List<Integer> blockPosition(BlockPos pos) {
        return List.of(pos.getX(), pos.getY(), pos.getZ());
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
        Map<String, PlayerSnapshot.Item> equipment = new LinkedHashMap<>();
        ServerGameState.EQUIPMENT_SLOTS.forEach((name, slot) -> equipment.put(name, item(player.getItemBySlot(slot))));
        String biomeId = ServerGameState.biomeId(player.level(), player.blockPosition());
        return new PlayerSnapshot(player.level().dimension().identifier().toString(), position(player.position()), biomeId,
                player.level().getGameTime(), System.currentTimeMillis(), inventory, player.getHealth(),
                player.getFoodData().getFoodLevel(), player.getFoodData().getSaturationLevel(),
                player.experienceLevel, player.experienceProgress, player.totalExperience,
                player.getInventory().getSelectedSlot(), item(player.getMainHandItem()), item(player.getOffhandItem()), equipment);
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

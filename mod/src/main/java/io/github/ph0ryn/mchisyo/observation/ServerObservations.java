package io.github.ph0ryn.mchisyo.observation;

import com.google.gson.Gson;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import java.util.function.Predicate;
import java.util.function.Supplier;
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
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ContainerListener;
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
            "item_dropped", "grid_result_taken", "furnace_result_taken", "block_use_attempted", "item_use_attempted",
            "container_opened", "container_slot_changed", "container_closed");

    private static volatile ServerObservations active;
    private static final Gson JSON = new Gson();

    private final Predicate<ServerPlayer> isScopedPlayer;
    private final Consumer<ObservedEvent> sink;
    private final SnapshotDeltaTracker tracker;
    private final Map<ServerPlayer, MenuWatch> menus = new IdentityHashMap<>();
    private long nextMenuId;

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
        return register(isScopedPlayer, sink, movementSampling, (player, event) -> {});
    }

    /** Native connection facts reach this callback before ready-only observation admission. */
    public static ServerObservations register(Predicate<ServerPlayer> isScopedPlayer, Consumer<ObservedEvent> sink,
            SnapshotDeltaTracker.MovementSampling movementSampling, BiConsumer<ServerPlayer, ObservedEvent> nativeConnection) {
        Objects.requireNonNull(nativeConnection);
        ServerObservations observations = new ServerObservations(isScopedPlayer, sink, movementSampling);
        if (active != null) throw new IllegalStateException("Server observations already registered");
        observations.registerCallbacks(nativeConnection);
        active = observations;
        return observations;
    }

    public static List<String> supportedEvents() {
        return SUPPORTED_EVENTS;
    }

    /** Call on the server thread when attaching/detaching/replacing the external world/session binding. */
    public void clearBaselines() {
        new ArrayList<>(menus.keySet()).forEach(this::forgetMenu);
        tracker.clear();
    }

    private void registerCallbacks(BiConsumer<ServerPlayer, ObservedEvent> nativeConnection) {
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
            new ArrayList<>(menus.keySet()).forEach(player -> { if (!scoped(player)) forgetMenu(player); });
            for (ServerPlayer player : server.getPlayerList().getPlayers()) {
                if (scoped(player)) {
                    PlayerSnapshot snapshot = snapshot(player);
                    tracker.observe(player.getUUID(), snapshot).forEach(sink);
                    if (tracker.worldSampleDue(player.getUUID(), snapshot)) sampleWorld(player, snapshot);
                }
            }
        });
        ServerPlayerEvents.JOIN.register(player -> {
            requireServerThread(player.level().getServer());
            ObservedEvent joined = fact(player, "player_connection_changed", Map.of("state", "joined"));
            nativeConnection.accept(player, joined);
            forgetMenu(player);
            tracker.clearMenuContext(player);
            tracker.reset(player.getUUID());
            if (scoped(player)) {
                sink.accept(joined);
                tracker.rebaseline(player.getUUID(), snapshot(player));
            }
        });
        ServerPlayerEvents.LEAVE.register(player -> {
            requireServerThread(player.level().getServer());
            ObservedEvent leaving = fact(player, "player_connection_changed", Map.of("state", "leaving"));
            nativeConnection.accept(player, leaving);
            forgetMenu(player);
            tracker.clearMenuContext(player);
            tracker.reset(player.getUUID());
            if (scoped(player)) sink.accept(leaving);
        });
        ServerPlayerEvents.AFTER_RESPAWN.register((oldPlayer, newPlayer, alive) -> {
            forgetMenu(oldPlayer);
            forgetMenu(newPlayer);
            tracker.clearMenuContext(oldPlayer);
            tracker.clearMenuContext(newPlayer);
            tracker.reset(oldPlayer.getUUID());
            tracker.reset(newPlayer.getUUID());
            if (scoped(newPlayer)) {
                emit(newPlayer, "player_respawned", Map.of("alive", alive));
                tracker.rebaseline(newPlayer.getUUID(), snapshot(newPlayer));
            }
        });
        ServerEntityWorldChangeEvents.AFTER_PLAYER_CHANGE_WORLD.register((player, origin, destination) -> {
            forgetMenu(player);
            tracker.clearMenuContext(player);
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
            clearBaselines();
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
            int before, int remaining) {
        ServerObservations observations = active;
        if (observations == null || !observations.scoped(player)) return;
        int count = SnapshotDeltaTracker.consumedAmount(before, remaining);
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

    /** Lexical clicked-block context only; no second open event or world lookup. */
    public static <T> T withMenuPosition(ServerPlayer player, BlockPos pos, Supplier<T> operation) {
        ServerObservations observations = active;
        return observations != null && observations.scoped(player)
                ? observations.tracker.withMenuPosition(player, blockPosition(pos), operation) : operation.get();
    }

    /** initMenu RETURN uses the argument: ordinary openMenu assigns containerMenu only afterwards. */
    public static void menuInitialized(ServerPlayer player, AbstractContainerMenu menu) {
        ServerObservations observations = active;
        if (observations == null || !observations.scoped(player) || menu == player.inventoryMenu) return;
        MenuWatch old = observations.menus.get(player);
        if (old != null && old.baseline.matches(player, menu)) return;
        observations.forgetMenu(player);
        Map<String, Object> initial = contents(player, menu);
        MenuWatch watch = observations.new MenuWatch(player, menu, ++observations.nextMenuId, initial);
        observations.menus.put(player, watch);
        observations.emit(player, "container_opened", watch.data(initial));
        // Native addSlotListener inherently broadcasts. Never request an extra sync/flush ourselves.
        if (watch.available && observations.menus.get(player) == watch) menu.addSlotListener(watch);
    }

    /** Only normal doCloseContainer completion confirms an actual native close, including replacements/removal. */
    public static void menuClosed(ServerPlayer player, AbstractContainerMenu oldMenu) {
        ServerObservations observations = active;
        if (observations == null || !observations.scoped(player) || player.containerMenu != player.inventoryMenu) return;
        MenuWatch watch = observations.menus.get(player);
        if (watch == null || !watch.baseline.matches(player, oldMenu)) return;
        Map<String, Object> data = watch.data(contents(player, oldMenu));
        data.put("finalState", "post_removal");
        observations.forgetMenu(player);
        observations.emit(player, "container_closed", data);
    }

    private void forgetMenu(ServerPlayer player) {
        MenuWatch watch = menus.remove(player);
        if (watch != null) {
            watch.baseline.reset();
            if (watch.available) watch.menu.removeSlotListener(watch);
        }
    }

    private static SnapshotDeltaTracker.MenuSlot menuSlot(ServerPlayer player, AbstractContainerMenu menu, int index, ItemStack stack) {
        Slot slot = menu.slots.get(index);
        PlayerSnapshot.Item copied = item(stack);
        return new SnapshotDeltaTracker.MenuSlot(slot.index, slot.getContainerSlot(), slot.container == player.getInventory(),
                copied.itemId(), copied.count());
    }

    private static Map<String, Object> contents(ServerPlayer player, AbstractContainerMenu menu) {
        return SnapshotDeltaTracker.menuContents(menu.slots.size(), i -> menuSlot(player, menu, i, menu.slots.get(i).getItem()));
    }

    private final class MenuWatch implements ContainerListener {
        private final ServerPlayer player;
        private final AbstractContainerMenu menu;
        private final long menuId;
        private final String menuType;
        private final List<Integer> blockPos;
        private final String positionSource;
        private final SnapshotDeltaTracker.MenuBaseline baseline;
        private final boolean available;

        private MenuWatch(ServerPlayer player, AbstractContainerMenu menu, long menuId, Map<String, Object> initial) {
            this.player = player; this.menu = menu; this.menuId = menuId;
            menuType = SnapshotDeltaTracker.menuType(() -> BuiltInRegistries.MENU.getKey(menu.getType()).toString());
            List<Integer> position = tracker.menuPosition(player);
            String source = position == null ? "unknown" : "clicked_block";
            // ponytail: inspect at most 256 already-available slot containers, never discover/re-read world blocks.
            if (position == null && menu.slots.size() <= SnapshotDeltaTracker.MAX_MENU_SLOTS) {
                for (Slot slot : menu.slots) {
                    if (slot.container instanceof BlockEntity blockEntity) {
                        position = blockPosition(blockEntity.getBlockPos()); source = "slot_block_entity"; break;
                    }
                }
            }
            blockPos = position; positionSource = source;
            available = initial.get("status").equals("available");
            baseline = new SnapshotDeltaTracker.MenuBaseline(player, menu, initial);
        }
        private Map<String, Object> data(Map<String, Object> contents) {
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("menuId", menuId); data.put("containerId", menu.containerId); data.put("menuType", menuType);
            data.put("blockPosition", blockPos); data.put("positionSource", positionSource); data.put("contents", contents);
            return data;
        }
        @Override public void slotChanged(AbstractContainerMenu changedMenu, int slot, ItemStack stack) {
            if (menus.get(player) != this || changedMenu != menu || !isScopedPlayer.test(player)
                    || slot < 0 || slot >= menu.slots.size()) return;
            Map<String, Object> change = baseline.change(menuSlot(player, menu, slot, stack));
            if (change != null) {
                Map<String, Object> data = new LinkedHashMap<>(change);
                data.put("menuId", menuId); data.put("containerId", menu.containerId);
                emit(player, "container_slot_changed", data);
            }
        }
        @Override public void dataChanged(AbstractContainerMenu ignored, int id, int value) { }
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
        forgetMenu(player);
        tracker.clearMenuContext(player);
        tracker.reset(player.getUUID());
        return false;
    }

    private static void requireServerThread(MinecraftServer server) {
        if (server == null || !server.isSameThread()) {
            throw new IllegalStateException("Gameplay observations require the server thread");
        }
    }

    private void emit(ServerPlayer player, String name, Map<String, Object> data) {
        sink.accept(fact(player, name, data));
    }

    private static ObservedEvent fact(ServerPlayer player, String name, Map<String, Object> data) {
        return new ObservedEvent(name, player.level().dimension().identifier().toString(),
                position(player.position()), player.level().getGameTime(), System.currentTimeMillis(), data);
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

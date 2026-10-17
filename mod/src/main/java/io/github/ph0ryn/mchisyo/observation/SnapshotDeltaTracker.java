package io.github.ph0ryn.mchisyo.observation;

import com.google.gson.Gson;
import java.nio.charset.StandardCharsets;
import java.util.IdentityHashMap;
import java.util.function.IntFunction;
import java.util.function.Supplier;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/** Pure snapshot comparison; owned by one server thread. No Minecraft classes are loaded. */
public final class SnapshotDeltaTracker {
    /** Sample server ticks; minimumDistance is 3-D displacement in blocks from the last emitted baseline. */
    public record MovementSampling(int intervalTicks, double minimumDistance) {
        public MovementSampling {
            if (intervalTicks < 1 || !Double.isFinite(minimumDistance) || minimumDistance < 0) {
                throw new IllegalArgumentException("Invalid movement sampling policy");
            }
        }
    }

    private record Baseline(PlayerSnapshot previous, PlayerSnapshot movementAnchor, long lastMovementSampleTick) {}

    public static final int MAX_MENU_SLOTS = 256;
    public static final int MAX_MENU_CONTENT_BYTES = 65536;
    private static final Gson MENU_JSON = new Gson().newBuilder().serializeNulls().create();
    private record MenuPosition(List<Integer> value) {}
    private final Map<Object, MenuPosition> menuPositions = new IdentityHashMap<>();

    public record MenuSlot(int slot, int containerSlot, boolean playerInventory, String itemId, int count) {
        public MenuSlot {
            if (slot < 0 || containerSlot < 0 || itemId == null || itemId.isEmpty() || itemId.length() > 128 || count < 0)
                throw new IllegalArgumentException("Invalid copied menu slot");
        }
        public Map<String, Object> data() {
            return Map.of("slot", slot, "containerSlot", containerSlot, "playerInventory", playerInventory,
                    "itemId", itemId, "count", count);
        }
    }

    /** Hard bound BEFORE invoking the copier; unavailable never masquerades as a truncated full snapshot. */
    public static Map<String, Object> menuContents(int slotCount, IntFunction<MenuSlot> copySlot) {
        if (slotCount < 0) throw new IllegalArgumentException("Negative slot count");
        List<Map<String, Object>> slots = new ArrayList<>();
        String status = slotCount > MAX_MENU_SLOTS ? "slot_limit" : "available";
        if (status.equals("available")) {
            for (int i = 0; i < slotCount; i++) {
                MenuSlot slot = copySlot.apply(i);
                if (slot.slot() != i) throw new IllegalArgumentException("Non-native menu index");
                slots.add(slot.data());
            }
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("status", status); result.put("slotCount", slotCount);
        result.put("maxSlots", MAX_MENU_SLOTS); result.put("maxSerializedBytes", MAX_MENU_CONTENT_BYTES);
        result.put("slots", status.equals("available") ? List.copyOf(slots) : null);
        if (status.equals("available") && MENU_JSON.toJson(result).getBytes(StandardCharsets.UTF_8).length > MAX_MENU_CONTENT_BYTES) {
            result.put("status", "serialized_limit"); result.put("slots", null);
        }
        return java.util.Collections.unmodifiableMap(result);
    }

    /** One copied baseline, bound to exact native objects rather than reusable numeric container IDs. */
    public static final class MenuBaseline {
        private final Object player, menu;
        private final List<Map<String, Object>> slots;
        private boolean active = true;
        @SuppressWarnings("unchecked")
        public MenuBaseline(Object player, Object menu, Map<String, Object> contents) {
            this.player = Objects.requireNonNull(player); this.menu = Objects.requireNonNull(menu);
            slots = contents.get("slots") == null ? null : new ArrayList<>((List<Map<String, Object>>)contents.get("slots"));
        }
        public boolean matches(Object player, Object menu) { return active && this.player == player && this.menu == menu; }
        public void reset() { active = false; if (slots != null) slots.clear(); }
        public Map<String, Object> change(MenuSlot next) {
            if (!active || slots == null || next.slot() >= slots.size()) return null;
            Map<String, Object> before = slots.set(next.slot(), next.data());
            if (before.equals(next.data())) return null;
            return Map.of("slot", next.slot(), "containerSlot", next.containerSlot(), "playerInventory", next.playerInventory(),
                    "beforeItemId", before.get("itemId"), "beforeCount", before.get("count"),
                    "afterItemId", next.itemId(), "afterCount", next.count());
        }
    }

    /** Only the documented absent-menu-type exception is converted to explicit unknown. */
    public static String menuType(Supplier<String> read) {
        try { return read.get(); } catch (UnsupportedOperationException absentNativeType) { return null; }
    }

    public List<Integer> menuPosition(Object player) {
        MenuPosition context = menuPositions.get(player);
        return context == null ? null : context.value();
    }
    public <T> T withMenuPosition(Object player, List<Integer> position, Supplier<T> operation) {
        List<Integer> copy = List.copyOf(position);
        if (copy.size() != 3) throw new IllegalArgumentException("Block position requires three coordinates");
        MenuPosition current = new MenuPosition(copy);
        MenuPosition previous = menuPositions.put(player, current);
        try { return operation.get(); }
        finally {
            if (menuPositions.get(player) == current) {
                if (previous == null) menuPositions.remove(player); else menuPositions.put(player, previous);
            }
        }
    }

    private final MovementSampling movementSampling;
    private final Map<UUID, Baseline> baselines = new HashMap<>();
    private final Map<UUID, ObservedEvent> worldBaselines = new HashMap<>();
    public static final int WORLD_SAMPLE_INTERVAL = 20;

    public SnapshotDeltaTracker(MovementSampling movementSampling) {
        this.movementSampling = Objects.requireNonNull(movementSampling);
    }

    /** Initial snapshots and world/tick generation changes seed a baseline, not acquisition events. */
    public List<ObservedEvent> observe(UUID playerId, PlayerSnapshot snapshot) {
        Objects.requireNonNull(playerId);
        Objects.requireNonNull(snapshot);
        Baseline baseline = baselines.get(playerId);
        if (baseline == null || !baseline.previous().dimension().equals(snapshot.dimension())
                || snapshot.tick() < baseline.previous().tick()) {
            rebaseline(playerId, snapshot);
            return List.of();
        }
        PlayerSnapshot before = baseline.previous();
        if (before.inventory().size() != snapshot.inventory().size()) {
            throw new IllegalStateException("Inventory layout changed; explicit rebaseline required");
        }
        List<ObservedEvent> events = new ArrayList<>();
        for (int slot = 0; slot < snapshot.inventory().size(); slot++) {
            PlayerSnapshot.Item oldItem = before.inventory().get(slot);
            PlayerSnapshot.Item newItem = snapshot.inventory().get(slot);
            if (!oldItem.equals(newItem)) {
                events.add(event("inventory_slot_changed", snapshot, Map.of(
                        "slot", slot, "beforeItemId", oldItem.itemId(), "beforeCount", oldItem.count(),
                        "afterItemId", newItem.itemId(), "afterCount", newItem.count())));
            }
        }
        if (Double.compare(before.health(), snapshot.health()) != 0) {
            events.add(event("health_changed", snapshot, Map.of("before", before.health(), "after", snapshot.health())));
        }
        if (before.foodLevel() != snapshot.foodLevel() || Double.compare(before.saturation(), snapshot.saturation()) != 0) {
            events.add(event("food_changed", snapshot, Map.of(
                    "beforeFoodLevel", before.foodLevel(), "afterFoodLevel", snapshot.foodLevel(),
                    "beforeSaturation", before.saturation(), "afterSaturation", snapshot.saturation())));
        }
        if (before.experienceLevel() != snapshot.experienceLevel()
                || Double.compare(before.experienceProgress(), snapshot.experienceProgress()) != 0
                || before.totalExperience() != snapshot.totalExperience()) {
            events.add(event("experience_changed", snapshot, Map.of(
                    "beforeLevel", before.experienceLevel(), "afterLevel", snapshot.experienceLevel(),
                    "beforeProgress", before.experienceProgress(), "afterProgress", snapshot.experienceProgress(),
                    "beforeTotalExperience", before.totalExperience(), "afterTotalExperience", snapshot.totalExperience())));
        }
        if (!before.equipment().keySet().equals(snapshot.equipment().keySet())) {
            throw new IllegalStateException("Equipment layout changed; explicit rebaseline required");
        }
        snapshot.equipment().forEach((slot, after) -> {
            PlayerSnapshot.Item old = before.equipment().get(slot);
            if (!old.equals(after)) events.add(event("equipment_slot_changed", snapshot, Map.of(
                    "slot", slot, "beforeItemId", old.itemId(), "beforeCount", old.count(),
                    "afterItemId", after.itemId(), "afterCount", after.count())));
        });
        heldDelta(events, snapshot, "main_hand", before.mainHand(), snapshot.mainHand(),
                before.selectedSlot(), snapshot.selectedSlot());
        heldDelta(events, snapshot, "off_hand", before.offHand(), snapshot.offHand(), null, null);

        PlayerSnapshot anchor = baseline.movementAnchor();
        long lastSampleTick = baseline.lastMovementSampleTick();
        if (snapshot.tick() - lastSampleTick >= movementSampling.intervalTicks()) {
            lastSampleTick = snapshot.tick();
            double distanceSquared = 0;
            for (int axis = 0; axis < 3; axis++) {
                double delta = snapshot.position().get(axis) - anchor.position().get(axis);
                distanceSquared += delta * delta;
            }
            boolean moved = distanceSquared > 0
                    && distanceSquared >= movementSampling.minimumDistance() * movementSampling.minimumDistance();
            if (moved || !Objects.equals(anchor.biomeId(), snapshot.biomeId())) {
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("beforePosition", anchor.position());
                data.put("afterPosition", snapshot.position());
                data.put("beforeBiomeId", anchor.biomeId());
                data.put("afterBiomeId", snapshot.biomeId());
                data.put("sampleIntervalTicks", movementSampling.intervalTicks());
                data.put("minimumDistance", movementSampling.minimumDistance());
                data.put("elapsedTicks", snapshot.tick() - anchor.tick());
                events.add(event("player_location_changed", snapshot, data));
                anchor = snapshot;
            }
        }
        baselines.put(playerId, new Baseline(snapshot, anchor, lastSampleTick));
        return List.copyOf(events);
    }

    private static void heldDelta(List<ObservedEvent> events, PlayerSnapshot snapshot, String hand,
            PlayerSnapshot.Item before, PlayerSnapshot.Item after, Integer beforeSlot, Integer afterSlot) {
        if (before.equals(after) && Objects.equals(beforeSlot, afterSlot)) return;
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("hand", hand);
        data.put("beforeSlot", beforeSlot);
        data.put("afterSlot", afterSlot);
        data.put("beforeItemId", before.itemId());
        data.put("beforeCount", before.count());
        data.put("afterItemId", after.itemId());
        data.put("afterCount", after.count());
        events.add(event("held_item_changed", snapshot, data));
    }

    private static ObservedEvent event(String name, PlayerSnapshot snapshot, Map<String, Object> data) {
        return new ObservedEvent(name, snapshot.dimension(), snapshot.position(), snapshot.tick(), snapshot.observedAt(), data);
    }

    public boolean worldSampleDue(UUID playerId, PlayerSnapshot snapshot) {
        ObservedEvent previous = worldBaselines.get(playerId);
        return previous == null || !previous.dimension().equals(snapshot.dimension())
                || snapshot.tick() < previous.tick() || snapshot.tick() - previous.tick() >= WORLD_SAMPLE_INTERVAL;
    }

    public List<ObservedEvent> observeWorld(UUID playerId, PlayerSnapshot snapshot, boolean raining,
            boolean thundering, long dayTime, boolean fixedTime, Map<String, Object> nearby,
            Map<String, Object> structures, List<Map<String, Object>> effects, boolean effectsTruncated) {
        if (!worldSampleDue(playerId, snapshot)) return List.of();
        ObservedEvent previous = worldBaselines.get(playerId);
        boolean initial = previous == null || !previous.dimension().equals(snapshot.dimension()) || snapshot.tick() < previous.tick();
        String phase = clockPhase(dayTime);
        List<ObservedEvent> events = new ArrayList<>();
        if (initial) events.add(event("status_effects_sampled", snapshot,
                Map.of("baseline", true, "effects", effects, "effectsTruncated", effectsTruncated)));
        events.add(event("nearby_sampled", snapshot, nearby));
        events.add(event("structures_sampled", snapshot, structures));
        if (!initial) {
            Map<String, Object> old = previous.data();
            if (!old.get("raining").equals(raining) || !old.get("thundering").equals(thundering)) {
                events.add(event("weather_changed", snapshot, Map.of("sampleIntervalTicks", WORLD_SAMPLE_INTERVAL,
                        "beforeRaining", old.get("raining"), "afterRaining", raining,
                        "beforeThundering", old.get("thundering"), "afterThundering", thundering)));
            }
            if (!old.get("phase").equals(phase)) {
                events.add(event("day_clock_phase_changed", snapshot, Map.of("sampleIntervalTicks", WORLD_SAMPLE_INTERVAL,
                        "beforePhase", old.get("phase"), "afterPhase", phase, "dayTime", dayTime, "fixedTime", fixedTime)));
            }
        }
        worldBaselines.put(playerId, event("world_baseline", snapshot,
                Map.of("raining", raining, "thundering", thundering, "phase", phase)));
        return List.copyOf(events);
    }

    public static String clockPhase(long dayTime) {
        return Math.floorMod(dayTime, 24000) < 12000 ? "day" : "night";
    }

    public static List<String> advancementEvents(boolean granted, boolean beforeDone, boolean afterDone) {
        if (!granted) return List.of();
        return !beforeDone && afterDone ? List.of("advancement_criterion_granted", "advancement_completed")
                : List.of("advancement_criterion_granted");
    }

    /** Immediate entity remainder, before playerTouch restores a fully consumed stack's count.
     * Inventory.add may return false after partial consumption and a final no-progress retry. */
    public static int consumedAmount(int before, int remaining) {
        return before > 0 && remaining >= 0 && remaining < before ? before - remaining : 0;
    }

    public static int successfulCount(boolean succeeded, int count) {
        return succeeded && count > 0 ? count : 0;
    }

    public void rebaseline(UUID playerId, PlayerSnapshot snapshot) {
        worldBaselines.remove(playerId);
        baselines.put(Objects.requireNonNull(playerId), new Baseline(snapshot, snapshot, snapshot.tick()));
    }

    public void reset(UUID playerId) {
        baselines.remove(playerId);
        worldBaselines.remove(playerId);
    }

    public void clearMenuContext(Object player) { menuPositions.remove(player); }
    public void clearMenuContexts() { menuPositions.clear(); }

    public void clear() {
        clearMenuContexts();
        baselines.clear();
        worldBaselines.clear();
    }
}

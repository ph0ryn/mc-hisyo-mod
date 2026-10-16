package io.github.ph0ryn.mchisyo.observation;

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

    private final MovementSampling movementSampling;
    private final Map<UUID, Baseline> baselines = new HashMap<>();

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

    public void rebaseline(UUID playerId, PlayerSnapshot snapshot) {
        baselines.put(Objects.requireNonNull(playerId), new Baseline(snapshot, snapshot, snapshot.tick()));
    }

    public void reset(UUID playerId) {
        baselines.remove(playerId);
    }

    public void clear() {
        baselines.clear();
    }
}

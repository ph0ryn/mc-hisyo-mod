package io.github.ph0ryn.mchisyo.observation;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Dependency-free test entry point: throws on failure; never loads Minecraft runtime classes. */
public final class ObserverChecks {
    private static final UUID PLAYER = UUID.fromString("f4ebaf24-0b69-4132-9103-18a054c38ee8");
    private static final PlayerSnapshot.Item AIR = new PlayerSnapshot.Item("minecraft:air", 0);
    private static final PlayerSnapshot.Item STONE = new PlayerSnapshot.Item("minecraft:stone", 3);
    private static final Gson JSON = new Gson().newBuilder().serializeNulls().create();
    private static int checks;

    public static void main(String[] args) throws Exception {
        equal(null, ObserverChecks.class.getClassLoader().getResource("net/minecraft/server/MinecraftServer.class"),
                "Minecraft runtime is absent from the pure test classpath");
        equal(null, ObserverChecks.class.getClassLoader().getResource("net/fabricmc/loader/api/FabricLoader.class"),
                "Fabric runtime is absent from the pure test classpath");
        JsonArray fixtures = JsonParser.parseString(Files.readString(Path.of(args[0]))).getAsJsonArray();
        matchesSharedSnapshotFixtures(fixtures);
        initialAndUnchangedAreSilent();
        ordinaryDeltasAreNotMovementThrottled();
        independentScalarChangesAreObservable();
        movementSamplingAndAccumulationAreExplicit();
        resetsAndWorldChangesDoNotInventDeltas();
        snapshotsAndEmittedEventsAreImmutable();
        offHandHasNoInventedInventorySlot();
        policiesRejectInvalidValues();
        roundTripsAllSharedFacts(fixtures);
        System.out.println("ObserverChecks: " + checks + " assertions passed (pure Java; no Minecraft launch)");
    }

    private static SnapshotDeltaTracker tracker() {
        return new SnapshotDeltaTracker(new SnapshotDeltaTracker.MovementSampling(20, 1));
    }

    private static PlayerSnapshot snapshot(long tick, double x, String biome, boolean changed) {
        return snapshot(tick, x, biome, changed, "minecraft:overworld", AIR);
    }

    private static PlayerSnapshot snapshot(long tick, double x, String biome, boolean changed,
            String dimension, PlayerSnapshot.Item offHand) {
        return new PlayerSnapshot(dimension, List.of(x, 64.0, 0.0), biome, tick, 1000,
                List.of(changed ? STONE : AIR, STONE), changed ? 18 : 20,
                changed ? 18 : 20, changed ? 4 : 5, changed ? 1 : 0,
                changed ? 0.5 : 0, changed ? 10 : 0, changed ? 1 : 0,
                changed ? STONE : AIR, offHand);
    }

    private static void matchesSharedSnapshotFixtures(JsonArray fixtures) {
        SnapshotDeltaTracker tracker = tracker();
        equal(List.of(), tracker.observe(PLAYER, snapshot(100, 0, "minecraft:plains", false)), "initial baseline");
        List<ObservedEvent> actual = tracker.observe(PLAYER, snapshot(120, 2, "minecraft:forest", true));
        equal(6, actual.size(), "observable snapshot delta count");
        equal(Set.of("inventory_slot_changed", "health_changed", "food_changed", "experience_changed",
                "held_item_changed", "player_location_changed"),
                Set.copyOf(actual.stream().map(ObservedEvent::name).toList()), "exact observable event kinds");
        for (ObservedEvent event : actual) {
            JsonObject expected = fixture(fixtures, event.name());
            equal(expected.get("data"), JSON.toJsonTree(event.data()), event.name() + " shared payload");
            equal(expected.get("position"), JSON.toJsonTree(event.position()), event.name() + " position");
            equal(expected.get("dimension").getAsString(), event.dimension(), "dimension");
            equal(expected.get("tick").getAsLong(), event.tick(), "tick");
            equal(expected.get("observedAt").getAsLong(), event.observedAt(), "observedAt");
        }
        expectThrows(UnsupportedOperationException.class, () -> actual.clear());
    }

    private static void initialAndUnchangedAreSilent() {
        SnapshotDeltaTracker tracker = tracker();
        equal(List.of(), tracker.observe(PLAYER, snapshot(100, 0, "minecraft:plains", false)), "no initial acquisition");
        equal(List.of(), tracker.observe(PLAYER, snapshot(140, 0, "minecraft:plains", false)), "no unchanged movement");
        equal(List.of(), tracker.observe(UUID.randomUUID(), snapshot(160, 2, "minecraft:forest", true)), "isolated player baseline");
    }

    private static void ordinaryDeltasAreNotMovementThrottled() {
        SnapshotDeltaTracker tracker = tracker();
        tracker.observe(PLAYER, snapshot(100, 0, "minecraft:plains", false));
        List<ObservedEvent> actual = tracker.observe(PLAYER, snapshot(101, 2, "minecraft:forest", true));
        equal(5, actual.size(), "inventory/health/food/XP/held observe every tick");
        check(actual.stream().noneMatch(event -> event.name().equals("player_location_changed")), "movement interval honored");
    }

    private static void independentScalarChangesAreObservable() {
        List<PlayerSnapshot.Item> empty = List.of(AIR, AIR);
        PlayerSnapshot before = state(100, empty, 5, 0, 0, 0, 0);
        onlyDelta(before, state(101, empty, 4, 0, 0, 0, 0), "food_changed");
        onlyDelta(before, state(101, empty, 5, 1, 0, 0, 0), "experience_changed");
        onlyDelta(before, state(101, empty, 5, 0, 0.5, 0, 0), "experience_changed");
        onlyDelta(before, state(101, empty, 5, 0, 0, 10, 0), "experience_changed");
        onlyDelta(before, state(101, empty, 5, 0, 0, 0, 1), "held_item_changed");
        PlayerSnapshot countBefore = state(100, List.of(new PlayerSnapshot.Item("minecraft:stone", 1), AIR), 5, 0, 0, 0, 1);
        onlyDelta(countBefore, state(101, List.of(STONE, AIR), 5, 0, 0, 0, 1), "inventory_slot_changed");
    }

    private static PlayerSnapshot state(long tick, List<PlayerSnapshot.Item> inventory, double saturation,
            int level, double progress, int total, int selectedSlot) {
        return new PlayerSnapshot("minecraft:overworld", List.of(0.0, 64.0, 0.0), "minecraft:plains",
                tick, 1000, inventory, 20, 20, saturation, level, progress, total, selectedSlot,
                inventory.get(selectedSlot), AIR);
    }

    private static void onlyDelta(PlayerSnapshot before, PlayerSnapshot after, String name) {
        SnapshotDeltaTracker tracker = tracker();
        tracker.observe(PLAYER, before);
        equal(List.of(name), tracker.observe(PLAYER, after).stream().map(ObservedEvent::name).toList(),
                "independent scalar delta: " + name);
    }

    private static void movementSamplingAndAccumulationAreExplicit() {
        SnapshotDeltaTracker tracker = tracker();
        tracker.observe(PLAYER, snapshot(100, 0, "minecraft:plains", false));
        equal(List.of(), tracker.observe(PLAYER, snapshot(110, 0.5, "minecraft:plains", false)), "not due");
        equal(List.of(), tracker.observe(PLAYER, snapshot(120, 0.75, "minecraft:plains", false)), "below threshold");
        equal(List.of(), tracker.observe(PLAYER, snapshot(130, 1.5, "minecraft:plains", false)), "sampling remains periodic");
        List<ObservedEvent> moved = tracker.observe(PLAYER, snapshot(140, 1.5, "minecraft:plains", false));
        equal(1, moved.size(), "slow movement accumulates against last emitted position");
        equal(40L, moved.getFirst().data().get("elapsedTicks"), "actual elapsed interval");
        equal(20, moved.getFirst().data().get("sampleIntervalTicks"), "configured sample interval");
        equal(1.0, moved.getFirst().data().get("minimumDistance"), "configured distance threshold");
        equal(List.of(), tracker.observe(PLAYER, snapshot(160, 1.5, "minecraft:plains", false)), "stationary is silent");
        List<ObservedEvent> biome = tracker.observe(PLAYER, snapshot(180, 1.5, "minecraft:forest", false));
        equal(1, biome.size(), "biome delta need not exceed movement threshold");
        equal("minecraft:forest", biome.getFirst().data().get("afterBiomeId"), "observed biome");
    }

    private static void resetsAndWorldChangesDoNotInventDeltas() {
        SnapshotDeltaTracker tracker = tracker();
        PlayerSnapshot initial = snapshot(100, 0, "minecraft:plains", false);
        PlayerSnapshot changed = snapshot(120, 2, "minecraft:forest", true);
        tracker.observe(PLAYER, initial);
        tracker.rebaseline(PLAYER, changed);
        equal(List.of(), tracker.observe(PLAYER, changed), "replacement/respawn rebaseline");
        tracker.reset(PLAYER);
        equal(List.of(), tracker.observe(PLAYER, initial), "leave/reset starts fresh");
        tracker.clear();
        equal(List.of(), tracker.observe(PLAYER, changed), "new binding clears baseline");
        equal(List.of(), tracker.observe(PLAYER,
                snapshot(140, 20, "minecraft:nether_wastes", false, "minecraft:the_nether", AIR)), "dimension change rebaseline");
        equal(List.of(), tracker.observe(PLAYER,
                snapshot(1, 30, "minecraft:nether_wastes", true, "minecraft:the_nether", AIR)), "backwards world tick rebaseline");
    }

    private static void snapshotsAndEmittedEventsAreImmutable() {
        List<PlayerSnapshot.Item> sourceItems = new ArrayList<>(List.of(AIR, STONE));
        List<Double> sourcePosition = new ArrayList<>(List.of(0.0, 64.0, 0.0));
        PlayerSnapshot baseline = new PlayerSnapshot("minecraft:overworld", sourcePosition, "minecraft:plains",
                100, 1000, sourceItems, 20, 20, 5, 0, 0, 0, 0, AIR, AIR);
        SnapshotDeltaTracker tracker = tracker();
        tracker.observe(PLAYER, baseline);
        sourceItems.set(0, STONE);
        sourcePosition.set(0, 500.0);
        equal(AIR, baseline.inventory().getFirst(), "copied inventory baseline");
        equal(0.0, baseline.position().getFirst(), "copied position baseline");
        check(tracker.observe(PLAYER, snapshot(120, 2, "minecraft:forest", true)).stream()
                .anyMatch(event -> event.name().equals("inventory_slot_changed")), "external list mutation cannot erase slot delta");
        expectThrows(UnsupportedOperationException.class, () -> baseline.inventory().clear());

        List<Object> nested = new ArrayList<>(List.of(1, 2, 3));
        Map<String, Object> sourceData = new LinkedHashMap<>();
        sourceData.put("nested", nested);
        sourceData.put("unknown", null);
        sourceData.put("child", new HashMap<>(Map.of("count", 1)));
        ObservedEvent fact = new ObservedEvent("test", "minecraft:overworld", sourcePosition, 100, 1000, sourceData);
        String before = JSON.toJson(fact);
        nested.clear();
        sourceData.clear();
        sourcePosition.clear();
        equal(before, JSON.toJson(fact), "deep immutable emitted fact");
        expectThrows(UnsupportedOperationException.class, () -> fact.data().clear());
        expectThrows(UnsupportedOperationException.class, () -> ((List<?>) fact.data().get("nested")).clear());
        expectThrows(UnsupportedOperationException.class, () -> ((Map<?, ?>) fact.data().get("child")).clear());
        expectThrows(UnsupportedOperationException.class, () -> fact.position().clear());
    }

    private static void offHandHasNoInventedInventorySlot() {
        SnapshotDeltaTracker tracker = tracker();
        tracker.observe(PLAYER, snapshot(100, 0, "minecraft:plains", false));
        List<ObservedEvent> events = tracker.observe(PLAYER,
                snapshot(101, 0, "minecraft:plains", false, "minecraft:overworld", STONE));
        equal(1, events.size(), "only off-hand delta");
        Map<String, Object> data = events.getFirst().data();
        equal("off_hand", data.get("hand"), "off-hand label");
        check(data.containsKey("beforeSlot") && data.get("beforeSlot") == null, "no guessed off-hand inventory index");
        check(data.containsKey("afterSlot") && data.get("afterSlot") == null, "no guessed after slot");
    }

    private static void policiesRejectInvalidValues() {
        expectThrows(IllegalArgumentException.class, () -> new SnapshotDeltaTracker.MovementSampling(0, 1));
        expectThrows(IllegalArgumentException.class, () -> new SnapshotDeltaTracker.MovementSampling(20, -1));
        expectThrows(IllegalArgumentException.class, () -> new SnapshotDeltaTracker.MovementSampling(20, Double.NaN));
        expectThrows(IllegalArgumentException.class, () -> new ObservedEvent("test", "minecraft:overworld",
                List.of(Double.NaN, 0.0, 0.0), 1, 1, Map.of()));
    }

    private static void roundTripsAllSharedFacts(JsonArray fixtures) {
        equal(13, fixtures.size(), "all shared fixture kinds");
        for (var element : fixtures) {
            JsonObject fixture = element.getAsJsonObject();
            List<Double> position = new ArrayList<>();
            fixture.getAsJsonArray("position").forEach(value -> position.add(value.getAsDouble()));
            @SuppressWarnings("unchecked")
            Map<String, Object> data = JSON.fromJson(fixture.get("data"), Map.class);
            ObservedEvent fact = new ObservedEvent(fixture.get("event").getAsString(),
                    fixture.get("dimension").getAsString(), position, fixture.get("tick").getAsLong(),
                    fixture.get("observedAt").getAsLong(), data);
            equal(fixture.get("data"), JSON.toJsonTree(fact.data()), "Java DTO shared payload roundtrip: " + fact.name());
        }
    }

    private static JsonObject fixture(JsonArray fixtures, String name) {
        for (var element : fixtures) {
            JsonObject fixture = element.getAsJsonObject();
            if (fixture.get("event").getAsString().equals(name)) return fixture;
        }
        throw new AssertionError("Missing shared fixture: " + name);
    }

    private static void check(boolean condition, String message) {
        checks++;
        if (!condition) throw new AssertionError(message);
    }

    private static void equal(Object expected, Object actual, String message) {
        check(java.util.Objects.equals(expected, actual), message + ": expected " + expected + ", got " + actual);
    }

    private static void expectThrows(Class<? extends Throwable> type, Runnable action) {
        checks++;
        try {
            action.run();
        } catch (Throwable error) {
            if (type.isInstance(error)) return;
            throw new AssertionError("Expected " + type.getSimpleName() + ", got " + error, error);
        }
        throw new AssertionError("Expected " + type.getSimpleName());
    }
}

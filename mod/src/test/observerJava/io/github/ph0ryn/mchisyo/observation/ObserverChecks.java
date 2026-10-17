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
        equipmentDeltasAreSampledAndCopied(fixtures);
        sampledWorldAndOutcomeEdges(fixtures);
        nativeItemOutcomeEdges(fixtures);
        menuValueContracts(fixtures);
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
                changed ? STONE : AIR, offHand, Map.of());
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
                inventory.get(selectedSlot), AIR, Map.of());
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
        UUID other = new UUID(0, 2);
        tracker.clear();
        for (UUID player : List.of(PLAYER, other)) {
            tracker.observe(player, initial);
            tracker.observeWorld(player, initial, false, false, 0, false, Map.of(), Map.of(), List.of(), false);
        }
        tracker.reset(PLAYER);
        check(tracker.worldSampleDue(PLAYER, initial), "player reset clears world cadence");
        check(!tracker.worldSampleDue(other, initial), "other player retains world cadence");
        equal(List.of(), tracker.observe(PLAYER, changed), "player reset cannot invent a delta");
        check(!tracker.observe(other, changed).isEmpty(), "other player retains observation baseline");
    }

    private static void snapshotsAndEmittedEventsAreImmutable() {
        List<PlayerSnapshot.Item> sourceItems = new ArrayList<>(List.of(AIR, STONE));
        List<Double> sourcePosition = new ArrayList<>(List.of(0.0, 64.0, 0.0));
        PlayerSnapshot baseline = new PlayerSnapshot("minecraft:overworld", sourcePosition, "minecraft:plains",
                100, 1000, sourceItems, 20, 20, 5, 0, 0, 0, 0, AIR, AIR, Map.of());
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

    private static PlayerSnapshot equipped(long tick, Map<String, PlayerSnapshot.Item> equipment) {
        return new PlayerSnapshot("minecraft:overworld", List.of(0.0, 64.0, 0.0), "minecraft:plains",
                tick, 1000, List.of(AIR, AIR), 20, 20, 5, 0, 0, 0, 0, AIR, AIR, equipment);
    }

    private static void equipmentDeltasAreSampledAndCopied(JsonArray fixtures) {
        SnapshotDeltaTracker tracker = tracker();
        Map<String, PlayerSnapshot.Item> source = new HashMap<>(Map.of("head", AIR));
        PlayerSnapshot first = equipped(100, source);
        source.put("head", STONE);
        equal(AIR, first.equipment().get("head"), "copied equipment baseline");
        expectThrows(UnsupportedOperationException.class, () -> first.equipment().clear());
        equal(List.of(), tracker.observe(PLAYER, first), "initial equipment is not acquisition");
        List<ObservedEvent> changed = tracker.observe(PLAYER, equipped(101, source));
        equal(List.of("equipment_slot_changed"), changed.stream().map(ObservedEvent::name).toList(), "equipment is not movement-throttled");
        equal(fixture(fixtures, "equipment_slot_changed").get("data"), JSON.toJsonTree(changed.getFirst().data()), "shared equipment payload");
        equal(List.of(), tracker.observe(PLAYER, equipped(102, Map.of("head", new PlayerSnapshot.Item("minecraft:stone", 3)))), "equal ID/count stays silent");
        source.put("head", new PlayerSnapshot.Item("minecraft:stone", 2));
        equal(2, tracker.observe(PLAYER, equipped(103, source)).getFirst().data().get("afterCount"), "count-only change");
        tracker.reset(PLAYER);
        equal(List.of(), tracker.observe(PLAYER, equipped(104, source)), "respawn/leave reset equipment baseline");
    }

    @SuppressWarnings("unchecked")
    private static void sampledWorldAndOutcomeEdges(JsonArray fixtures) {
        SnapshotDeltaTracker tracker = tracker();
        PlayerSnapshot first = snapshot(100, 0, "minecraft:plains", false);
        equal(true, tracker.worldSampleDue(PLAYER, first), "initial world sample due");
        Map<String, Object> nearby = JSON.fromJson(fixture(fixtures, "nearby_sampled").get("data"), Map.class);
        Map<String, Object> structures = JSON.fromJson(fixture(fixtures, "structures_sampled").get("data"), Map.class);
        List<Map<String, Object>> effects = List.of(Map.of("effectId", "minecraft:speed", "amplifier", 0,
                "duration", 200, "ambient", false, "visible", true, "showIcon", true));
        List<ObservedEvent> baseline = tracker.observeWorld(PLAYER, first, false, false, 0, false,
                nearby, structures, effects, false);
        equal(List.of("status_effects_sampled", "nearby_sampled", "structures_sampled"),
                baseline.stream().map(ObservedEvent::name).toList(), "baseline is sample, not acquisition/achievement");
        for (ObservedEvent event : baseline) equal(fixture(fixtures, event.name()).get("data"),
                JSON.toJsonTree(event.data()), "baseline shared payload: " + event.name());
        equal(false, tracker.worldSampleDue(PLAYER, snapshot(119, 0, "minecraft:plains", false)), "20 tick cadence");
        equal(List.of(), tracker.observeWorld(PLAYER, snapshot(119, 0, "minecraft:plains", false), true, true, 12000, false,
                nearby, structures, effects, false), "subinterval observations cannot move baseline");
        PlayerSnapshot next = snapshot(120, 2, "minecraft:forest", false);
        equal(true, tracker.worldSampleDue(PLAYER, next), "sample due at20");
        List<ObservedEvent> transitions = tracker.observeWorld(PLAYER, next, true, true, 12000, false,
                nearby, structures, effects, false);
        equal(List.of("nearby_sampled", "structures_sampled", "weather_changed", "day_clock_phase_changed"),
                transitions.stream().map(ObservedEvent::name).toList(), "world transitions");
        for (ObservedEvent event : transitions) equal(fixture(fixtures, event.name()).get("data"),
                JSON.toJsonTree(event.data()), "sample shared payload: " + event.name());
        equal(List.of("nearby_sampled", "structures_sampled"), tracker.observeWorld(PLAYER,
                snapshot(140, 2, "minecraft:forest", false), true, true, 12001, false,
                nearby, structures, effects, false).stream().map(ObservedEvent::name).toList(), "unchanged weather/phase silent");
        List<ObservedEvent> rainOnly = tracker.observeWorld(PLAYER, snapshot(160, 2, "minecraft:forest", false),
                false, true, 12002, false, nearby, structures, effects, false);
        equal(List.of("nearby_sampled", "structures_sampled", "weather_changed"), rainOnly.stream().map(ObservedEvent::name).toList(), "independent rain change");
        equal(true, rainOnly.getLast().data().get("beforeThundering"), "raw thunder is independent of rain");
        List<ObservedEvent> thunderOnly = tracker.observeWorld(PLAYER, snapshot(180, 2, "minecraft:forest", false),
                false, false, 12003, false, nearby, structures, effects, false);
        equal(List.of("nearby_sampled", "structures_sampled", "weather_changed"), thunderOnly.stream().map(ObservedEvent::name).toList(), "independent thunder change");
        List<ObservedEvent> fixed = tracker.observeWorld(PLAYER, snapshot(200, 2, "minecraft:forest", false),
                false, false, 24000, true, nearby, structures, effects, false);
        equal("day_clock_phase_changed", fixed.getLast().name(), "clock wrap transition");
        equal(true, fixed.getLast().data().get("fixedTime"), "fixed-time dimension explicit");
        equal("day", SnapshotDeltaTracker.clockPhase(11999), "last day tick");
        equal("night", SnapshotDeltaTracker.clockPhase(12000), "first night tick");
        equal("night", SnapshotDeltaTracker.clockPhase(-1), "negative day time floorMod");
        equal("day", SnapshotDeltaTracker.clockPhase(-24000), "negative whole day");
        equal(List.of(), SnapshotDeltaTracker.advancementEvents(false, false, true), "failed grant is not achievement");
        equal(List.of("advancement_criterion_granted"), SnapshotDeltaTracker.advancementEvents(true, true, true), "no repeated completion");
        equal(List.of("advancement_criterion_granted", "advancement_completed"),
                SnapshotDeltaTracker.advancementEvents(true, false, true), "new criterion plus done edge");
        equal(List.of("advancement_criterion_granted"), SnapshotDeltaTracker.advancementEvents(true, false, false), "partial criterion not completed");
        PlayerSnapshot dimension = snapshot(201, 2, "minecraft:nether_wastes", false, "minecraft:the_nether", AIR);
        equal(true, tracker.worldSampleDue(PLAYER, dimension), "dimension change samples immediately");
        equal(List.of("status_effects_sampled", "nearby_sampled", "structures_sampled"), tracker.observeWorld(PLAYER,
                dimension, true, true, -1, true, nearby, structures, effects, true).stream().map(ObservedEvent::name).toList(), "dimension rebaseline is not weather/clock transition");
        equal(true, tracker.worldSampleDue(PLAYER, snapshot(1, 0, "minecraft:plains", false)), "tick rollback samples immediately");
        tracker.rebaseline(PLAYER, next);
        equal(true, tracker.worldSampleDue(PLAYER, next), "explicit respawn/dimension rebaseline clears world samples");
        tracker.observeWorld(PLAYER, next, true, true, 12000, false, nearby, structures, effects, false);
        equal(true, tracker.worldSampleDue(UUID.randomUUID(), next), "player samples remain isolated");
        tracker.reset(PLAYER); equal(true, tracker.worldSampleDue(PLAYER, next), "reset world baseline");
        tracker.observeWorld(PLAYER, next, true, true, 12000, false, nearby, structures, effects, false);
        tracker.clear(); equal(true, tracker.worldSampleDue(PLAYER, next), "binding clear world baseline");
    }

    private static void nativeItemOutcomeEdges(JsonArray fixtures) {
        equal(3, SnapshotDeltaTracker.consumedAmount(5, 2), "partial consumption survives false final no-progress retry");
        equal(3, SnapshotDeltaTracker.consumedAmount(5, 2), "partial entity consumption");
        equal(5, SnapshotDeltaTracker.consumedAmount(5, 0), "full consumption before native count restoration");
        // Correct the old false/5/0 assertion: the immediate consumed quantity, not add's return, is authoritative.
        equal(5, SnapshotDeltaTracker.consumedAmount(5, 0), "full entity consumption regardless of add return; not net inventory gain");
        equal(0, SnapshotDeltaTracker.consumedAmount(5, 5), "no consumption");
        equal(0, SnapshotDeltaTracker.consumedAmount(5, 6), "growth not pickup");
        equal(0, SnapshotDeltaTracker.consumedAmount(-1, 0), "negative original rejected");
        equal(0, SnapshotDeltaTracker.consumedAmount(5, -1), "negative remainder rejected");
        equal(0, SnapshotDeltaTracker.consumedAmount(0, 0), "empty pickup rejected");
        equal(Integer.MAX_VALUE, SnapshotDeltaTracker.consumedAmount(Integer.MAX_VALUE, 0), "no amount overflow");
        equal(0, SnapshotDeltaTracker.successfulCount(false, 2), "failed insertion not drop");
        equal(0, SnapshotDeltaTracker.successfulCount(true, 0), "reset native credit not double counted");
        equal(0, SnapshotDeltaTracker.successfulCount(true, -1), "negative credit rejected");
        equal(2, SnapshotDeltaTracker.successfulCount(true, 2), "positive committed native count");
        equal(fixture(fixtures, "item_picked_up").getAsJsonObject("data").get("count").getAsInt(),
                SnapshotDeltaTracker.consumedAmount(5, 2), "shared partial-pickup count");
        equal(fixture(fixtures, "grid_result_taken").getAsJsonObject("data").get("count").getAsInt(),
                SnapshotDeltaTracker.successfulCount(true, 4), "shared grid credited take count");
        equal(fixture(fixtures, "furnace_result_taken").getAsJsonObject("data").get("count").getAsInt(),
                SnapshotDeltaTracker.successfulCount(true, 2), "shared furnace/SWAP positive take count");
    }

    private static void menuValueContracts(JsonArray fixtures) {
        record NativeKey(int reusableId) {}
        Object player = new NativeKey(1), menu = new NativeKey(1), other = new NativeKey(1);
        var stone = new SnapshotDeltaTracker.MenuSlot(0, 7, false, "minecraft:stone", 3);
        var full = SnapshotDeltaTracker.menuContents(1, i -> stone);
        equal("available", full.get("status"), "full initial contents");
        equal(fixture(fixtures, "container_opened").getAsJsonObject("data").get("contents"), JSON.toJsonTree(full), "Java initial contents match strict shared fixture");
        equal("available", SnapshotDeltaTracker.menuContents(0, i -> { throw new AssertionError("empty copied"); }).get("status"), "empty full is available");
        equal("available", SnapshotDeltaTracker.menuContents(256, i -> new SnapshotDeltaTracker.MenuSlot(i, i, true, "minecraft:air", 0)).get("status"), "inclusive slot cap");
        var baseline = new SnapshotDeltaTracker.MenuBaseline(player, menu, full);
        check(baseline.matches(player, menu), "exact menu/player identity");
        check(!baseline.matches(other, menu) && !baseline.matches(player, other), "identity not value IDs");
        equal(null, baseline.change(stone), "registration callback is not a delta");
        var air = new SnapshotDeltaTracker.MenuSlot(0, 7, false, "minecraft:air", 0);
        var delta = baseline.change(air);
        equal(3, delta.get("beforeCount"), "delta uses own before baseline");
        equal(0, delta.get("afterCount"), "delta copies after count");
        Map<String, Object> sharedDelta = new java.util.LinkedHashMap<>(delta);
        sharedDelta.put("menuId", 1); sharedDelta.put("containerId", 2);
        equal(fixture(fixtures, "container_slot_changed").get("data"), JSON.toJsonTree(sharedDelta), "Java delta matches strict shared fixture");
        equal(fixture(fixtures, "container_closed").getAsJsonObject("data").get("contents"),
                JSON.toJsonTree(SnapshotDeltaTracker.menuContents(1, i -> air)), "final post-removal value copy is separate from initial");
        equal(null, baseline.change(air), "equal callback suppressed");
        baseline.reset();
        check(!baseline.matches(player, menu), "reset invalidates object binding");
        equal(null, baseline.change(stone), "reset never invents a new before baseline");
        equal(3, ((Map<?, ?>)((List<?>)full.get("slots")).getFirst()).get("count"), "initial copy unchanged");
        var unavailable = SnapshotDeltaTracker.menuContents(257, i -> { throw new AssertionError("overbound materialized"); });
        equal("slot_limit", unavailable.get("status"), "slot cap explicit, no truncated full snapshot");
        equal(null, unavailable.get("slots"), "unavailable has no pretend full slots");
        equal(null, new SnapshotDeltaTracker.MenuBaseline(player, menu, unavailable).change(stone), "unavailable cannot invent before");
        equal("serialized_limit", SnapshotDeltaTracker.menuContents(256,
                i -> new SnapshotDeltaTracker.MenuSlot(i, i, false, "\u0001".repeat(128), 1)).get("status"), "serialized cap");
        expectThrows(IllegalArgumentException.class, () -> new SnapshotDeltaTracker.MenuSlot(-1, 0, false, "x", 1));
        expectThrows(IllegalArgumentException.class, () -> new SnapshotDeltaTracker.MenuSlot(0, -1, false, "x", 1));
        expectThrows(IllegalArgumentException.class, () -> new SnapshotDeltaTracker.MenuSlot(0, 0, false, "", 1));
        expectThrows(IllegalArgumentException.class, () -> new SnapshotDeltaTracker.MenuSlot(0, 0, false, "x", -1));
        equal(null, SnapshotDeltaTracker.menuType(() -> { throw new UnsupportedOperationException(); }), "absent native type explicit");
        equal("minecraft:chest", SnapshotDeltaTracker.menuType(() -> "minecraft:chest"), "known type retained");
        expectThrows(IllegalStateException.class, () -> SnapshotDeltaTracker.menuType(() -> { throw new IllegalStateException(); }));
        var tracker = tracker();
        var a = List.of(1, 2, 3); var b = List.of(4, 5, 6);
        equal(null, tracker.menuPosition(player), "no guessed position");
        tracker.withMenuPosition(player, a, () -> {
            equal(a, tracker.menuPosition(player), "exact lexical player context");
            equal(null, tracker.menuPosition(other), "other player cannot consume context");
            tracker.withMenuPosition(player, b, () -> { equal(b, tracker.menuPosition(player), "reentrant override"); return null; });
            equal(a, tracker.menuPosition(player), "reentrant restore");
            expectThrows(IllegalStateException.class, () -> tracker.withMenuPosition(player, b, () -> { throw new IllegalStateException(); }));
            equal(a, tracker.menuPosition(player), "failure restores outer context");
            return null;
        });
        equal(null, tracker.menuPosition(player), "lexical cleanup");
        tracker.withMenuPosition(player, a, () -> { tracker.clear(); return null; });
        equal(null, tracker.menuPosition(player), "reset never restores stale context");
        tracker.withMenuPosition(player, a, () -> {
            tracker.withMenuPosition(other, b, () -> { tracker.clearMenuContext(other); return null; });
            equal(a, tracker.menuPosition(player), "other-player reset preserves exact context");
            tracker.withMenuPosition(player, b, () -> { tracker.clearMenuContext(player); return null; });
            equal(null, tracker.menuPosition(player), "nested reset cannot resurrect outer context");
            return null;
        });
        equal(null, tracker.menuPosition(player), "outer finally preserves reset");
    }

    private static void roundTripsAllSharedFacts(JsonArray fixtures) {
        equal(32, fixtures.size(), "all shared fixture kinds including menus");
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

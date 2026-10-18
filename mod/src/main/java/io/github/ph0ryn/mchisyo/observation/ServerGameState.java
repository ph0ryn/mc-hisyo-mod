package io.github.ph0ryn.mchisyo.observation;

import com.google.gson.*;
import io.github.ph0ryn.mchisyo.session.GameSession;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.QuartPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.boss.enderdragon.EnderDragonPart;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.entity.EntityTypeTest;
import net.minecraft.world.level.levelgen.structure.StructureStart;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/** Server-thread copies from already-loaded data only; no chunk requests or history. */
public final class ServerGameState {
    private ServerGameState() {}
    static final Map<String, EquipmentSlot> EQUIPMENT_SLOTS = Map.of(
            "feet", EquipmentSlot.FEET, "legs", EquipmentSlot.LEGS, "chest", EquipmentSlot.CHEST,
            "head", EquipmentSlot.HEAD, "offHand", EquipmentSlot.OFFHAND,
            "body", EquipmentSlot.BODY, "saddle", EquipmentSlot.SADDLE);
    public static String biomeId(ServerLevel level, BlockPos position) {
        if (!level.getServer().isSameThread()) throw new IllegalStateException("Server thread required");
        var biome = level.getBiomeManager().withDifferentSource((x, y, z) -> {
            var chunk = level.getChunkSource().getChunkNow(QuartPos.toSection(x), QuartPos.toSection(z));
            return chunk == null ? null : chunk.getNoiseBiome(x, y, z);
        }).getBiome(position);
        return biome == null ? null : biome.unwrapKey().map(key -> id(key.identifier().toString())).orElse(null);
    }
    public static JsonObject snapshot(ServerPlayer player) {
        ServerLevel level = player.level();
        if (!level.getServer().isSameThread()) throw new IllegalStateException("Server thread required");
        JsonObject state = new JsonObject(); state.addProperty("version", 2);
        count(state, "tick", level.getGameTime()); count(state, "observedAt", System.currentTimeMillis());
        long day = level.getDayTime(); GameSession.safeCounter(new JsonPrimitive(day), true); state.addProperty("dayTime", day);
        state.addProperty("dimension", id(level.dimension().identifier().toString())); state.add("position", position(player.position()));
        String biome = biomeId(level, player.blockPosition()); state.add("biomeId", biome == null ? JsonNull.INSTANCE : new JsonPrimitive(biome));
        number(state, "health", player.getHealth(), 0, Double.MAX_VALUE); number(state, "maxHealth", player.getMaxHealth(), 0, Double.MAX_VALUE);
        count(state, "foodLevel", player.getFoodData().getFoodLevel()); number(state, "saturation", player.getFoodData().getSaturationLevel(), 0, Double.MAX_VALUE);
        JsonObject experience = new JsonObject(); count(experience, "level", player.experienceLevel); count(experience, "total", player.totalExperience);
        number(experience, "progress", player.experienceProgress, 0, 1); state.add("experience", experience);
        JsonObject inventory = new JsonObject(); int selected = player.getInventory().getSelectedSlot();
        if (selected < 0 || selected > 8) throw new IllegalStateException("Invalid selected slot");
        inventory.addProperty("selectedSlot", selected); JsonArray main = new JsonArray();
        for (int slot = 0; slot < 36; slot++) main.add(item(player.getInventory().getItem(slot)));
        inventory.add("main", main); JsonObject equipment = new JsonObject();
        EQUIPMENT_SLOTS.forEach((name, slot) -> equipment.add(name, item(player.getItemBySlot(slot))));
        inventory.add("equipment", equipment); state.add("inventory", inventory);
        state.add("nearby", nearby(player)); return state;
    }
    public static JsonObject nearby(ServerPlayer player) {
        ServerLevel level = player.level();
        if (!level.getServer().isSameThread()) throw new IllegalStateException("Server thread required");
        BlockGetter view = loadedView(level);
        JsonObject nearby = new JsonObject(); nearby.addProperty("visibility", "unobstructed");
        nearby.addProperty("blockRadius", 4); JsonArray blocks = new JsonArray(); boolean complete = true;
        BlockPos center = player.blockPosition();
        for (int x = -4; x <= 4; x++) for (int y = -4; y <= 4; y++) for (int z = -4; z <= 4; z++) {
            BlockPos pos = center.offset(x, y, z); if (level.isOutsideBuildHeight(pos)) continue;
            var chunk = level.getChunkSource().getChunkNow(pos.getX() >> 4, pos.getZ() >> 4);
            if (chunk == null) { complete = false; continue; }
            var block = chunk.getBlockState(pos);
            if (block.isAir() || !unobstructed(view, player, Vec3.atCenterOf(pos), pos)) continue;
            JsonObject entry = new JsonObject(); entry.addProperty("blockId", id(BuiltInRegistries.BLOCK.getKey(block.getBlock()).toString()));
            JsonArray coords = new JsonArray(); coords.add(pos.getX()); coords.add(pos.getY()); coords.add(pos.getZ()); entry.add("position", coords); blocks.add(entry);
        }
        nearby.addProperty("blocksComplete", complete); nearby.add("blocks", blocks); nearby.addProperty("entityRadius", 16);
        Vec3 origin = player.position(); List<Entity> found = new ArrayList<>(65);
        level.getEntities(EntityTypeTest.forClass(Entity.class), new AABB(origin.x-16, origin.y-16, origin.z-16, origin.x+16, origin.y+16, origin.z+16),
                entity -> entity != player && !(entity instanceof EnderDragonPart) && entity.position().distanceToSqr(origin) <= 256, found, 65);
        JsonArray entities = new JsonArray();
        for (int i = 0; i < Math.min(64, found.size()); i++) {
            Entity entity = found.get(i);
            if (entity.isSpectator() || entity.isInvisibleTo(player)
                    || !unobstructed(view, player, entity.getEyePosition(), null)) continue;
            JsonObject entry = new JsonObject(); entry.addProperty("entityId", id(entity.getUUID().toString()));
            entry.addProperty("entityType", id(BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString())); entry.add("position", position(entity.position())); entities.add(entry);
        }
        nearby.addProperty("entitiesTruncated", found.size() > 64); nearby.add("entities", entities); return nearby;
    }

    /** Native shape queries must never fall back to Level.getBlockState(), which loads chunks. */
    private static BlockGetter loadedView(ServerLevel level) {
        return new BlockGetter() {
            public int getHeight() { return level.getHeight(); }
            public int getMinY() { return level.getMinY(); }
            public BlockState getBlockState(BlockPos pos) {
                if (level.isOutsideBuildHeight(pos)) return Blocks.VOID_AIR.defaultBlockState();
                var chunk = level.getChunkSource().getChunkNow(pos.getX() >> 4, pos.getZ() >> 4);
                if (chunk == null) return Blocks.STONE.defaultBlockState();
                var state = chunk.getBlockState(pos);
                // Pending block-entity NBT is not materialized; unknown dynamic shapes occlude.
                return state.hasBlockEntity() && !chunk.getBlockEntities().containsKey(pos)
                        ? Blocks.STONE.defaultBlockState() : state;
            }
            public FluidState getFluidState(BlockPos pos) { return getBlockState(pos).getFluidState(); }
            public BlockEntity getBlockEntity(BlockPos pos) {
                var chunk = level.getChunkSource().getChunkNow(pos.getX() >> 4, pos.getZ() >> 4);
                return chunk == null ? null : chunk.getBlockEntities().get(pos);
            }
        };
    }

    // ponytail: conservative center rays, not FOV/lighting; client observation needed for exact perception.
    private static boolean unobstructed(BlockGetter view, ServerPlayer player, Vec3 target, BlockPos block) {
        Vec3 eye = player.getEyePosition();
        if (eye.distanceToSqr(target) > 256) return false;
        // Native clip checks only traversed cells; moving-piston shapes protrude into adjacent cells.
        // ponytail: 27 loaded-only probes per ray cell; cache per sample if profiling warrants.
        if (BlockGetter.traverseBlocks(eye, target, player.level(), (level, pos) -> {
            for (var neighbor : BlockPos.betweenClosed(pos.offset(-1, -1, -1), pos.offset(1, 1, 1))) {
                var chunk = level.getChunkSource().getChunkNow(neighbor.getX() >> 4, neighbor.getZ() >> 4);
                if (chunk != null && chunk.getBlockState(neighbor).is(Blocks.MOVING_PISTON)) return true;
            }
            return null;
        }, level -> false)) return false;
        var outline = view.clip(new ClipContext(eye, target, ClipContext.Block.OUTLINE, ClipContext.Fluid.ANY, player));
        if (block == null ? outline.getType() != HitResult.Type.MISS
                : outline.getType() != HitResult.Type.BLOCK || !outline.getBlockPos().equals(block)) return false;
        // OUTLINE misses moving-piston shapes; COLLIDER alone misses opaque non-colliders.
        var collider = view.clip(new ClipContext(eye, target, ClipContext.Block.COLLIDER, ClipContext.Fluid.ANY, player));
        return collider.getType() == HitResult.Type.MISS
                || block != null && collider.getBlockPos().equals(block);
    }

    public static Map<String, Object> containingStructures(ServerPlayer player) {
        ServerLevel level = player.level();
        if (!level.getServer().isSameThread()) throw new IllegalStateException("Server thread required");
        BlockPos position = player.blockPosition();
        var chunk = level.getChunkSource().getChunkNow(position.getX() >> 4, position.getZ() >> 4);
        var registry = level.registryAccess().lookupOrThrow(Registries.STRUCTURE);
        LinkedHashSet<String> ids = new LinkedHashSet<>();
        int starts = 0, references = 0, unloaded = 0, keys = 0;
        boolean startsTruncated = false, referencesTruncated = false;
        // ponytail: 64 current starts + 64 reference keys/chunk checks (<=128 starts), bounding-box metadata only;
        // keep skipped/truncated explicit; widen measured budgets if needed, never load/search chunks.
        if (chunk != null) {
            for (var entry : chunk.getAllStarts().entrySet()) {
                if (starts == 64) { startsTruncated = true; break; }
                starts++;
                if (contains(entry.getValue(), position)) ids.add(registry.getKey(entry.getKey()).toString());
            }
            outer: for (var entry : chunk.getAllReferences().entrySet()) {
                if (keys++ == 64) { referencesTruncated = true; break; }
                for (long reference : entry.getValue()) {
                    if (references == 64) { referencesTruncated = true; break outer; }
                    references++;
                    var startChunk = level.getChunkSource().getChunkNow(ChunkPos.getX(reference), ChunkPos.getZ(reference));
                    if (startChunk == null) { unloaded++; continue; }
                    StructureStart start = startChunk.getAllStarts().get(entry.getKey());
                    if (start != null) {
                        starts++;
                        if (contains(start, position)) ids.add(registry.getKey(entry.getKey()).toString());
                    }
                }
            }
        }
        return Map.of("sampleIntervalTicks", SnapshotDeltaTracker.WORLD_SAMPLE_INTERVAL,
                "structureIds", List.copyOf(ids), "incomplete", true, "currentChunkLoaded", chunk != null,
                "startsInspected", starts, "referenceChunksChecked", references, "unloadedReferences", unloaded,
                "startsTruncated", startsTruncated, "referencesTruncated", referencesTruncated);
    }

    private static boolean contains(StructureStart start, BlockPos position) {
        return start.isValid() && start.getBoundingBox().isInside(position);
    }
    private static JsonObject item(ItemStack stack) {
        JsonObject result = new JsonObject(); result.addProperty("itemId", stack.isEmpty() ? "minecraft:air" : id(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString()));
        count(result, "count", stack.isEmpty() ? 0 : stack.getCount()); return result;
    }
    private static JsonArray position(Vec3 vector) {
        JsonArray result = new JsonArray(); for (double coordinate : new double[]{vector.x, vector.y, vector.z}) {
            if (!Double.isFinite(coordinate)) throw new IllegalStateException("Invalid game position"); result.add(coordinate);
        } return result;
    }
    private static String id(String value) { if (value.isEmpty() || value.codePointCount(0, value.length()) > 128) throw new IllegalStateException("Invalid registry identifier"); return value; }
    private static void count(JsonObject object, String key, long value) { GameSession.safeCounter(new JsonPrimitive(value), false); object.addProperty(key, value); }
    private static void number(JsonObject object, String key, double value, double min, double max) {
        if (!Double.isFinite(value) || value < min || value > max) throw new IllegalStateException("Invalid game number"); object.addProperty(key, value);
    }
}

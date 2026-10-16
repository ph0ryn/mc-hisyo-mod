package io.github.ph0ryn.mchisyo.observation;

import com.google.gson.*;
import io.github.ph0ryn.mchisyo.session.GameSession;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.QuartPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.boss.enderdragon.EnderDragonPart;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.entity.EntityTypeTest;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/** On-demand server-thread copy only; no chunk requests, history, or mutable objects escape. */
public final class ServerGameState {
    private ServerGameState() {}
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
        JsonObject state = new JsonObject(); state.addProperty("version", 1);
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
        equipment.add("feet", item(player.getItemBySlot(EquipmentSlot.FEET))); equipment.add("legs", item(player.getItemBySlot(EquipmentSlot.LEGS)));
        equipment.add("chest", item(player.getItemBySlot(EquipmentSlot.CHEST))); equipment.add("head", item(player.getItemBySlot(EquipmentSlot.HEAD)));
        equipment.add("offHand", item(player.getItemBySlot(EquipmentSlot.OFFHAND))); equipment.add("body", item(player.getItemBySlot(EquipmentSlot.BODY)));
        equipment.add("saddle", item(player.getItemBySlot(EquipmentSlot.SADDLE))); inventory.add("equipment", equipment); state.add("inventory", inventory);
        JsonObject nearby = new JsonObject(); nearby.addProperty("blockRadius", 4); JsonArray blocks = new JsonArray(); boolean complete = true;
        BlockPos center = player.blockPosition();
        for (int x = -4; x <= 4; x++) for (int y = -4; y <= 4; y++) for (int z = -4; z <= 4; z++) {
            BlockPos pos = center.offset(x, y, z); if (level.isOutsideBuildHeight(pos)) continue;
            var chunk = level.getChunkSource().getChunkNow(pos.getX() >> 4, pos.getZ() >> 4);
            if (chunk == null) { complete = false; continue; }
            var block = chunk.getBlockState(pos); if (block.isAir()) continue;
            JsonObject entry = new JsonObject(); entry.addProperty("blockId", id(BuiltInRegistries.BLOCK.getKey(block.getBlock()).toString()));
            JsonArray coords = new JsonArray(); coords.add(pos.getX()); coords.add(pos.getY()); coords.add(pos.getZ()); entry.add("position", coords); blocks.add(entry);
        }
        nearby.addProperty("blocksComplete", complete); nearby.add("blocks", blocks); nearby.addProperty("entityRadius", 16);
        Vec3 origin = player.position(); List<Entity> found = new ArrayList<>(65);
        level.getEntities(EntityTypeTest.forClass(Entity.class), new AABB(origin.x-16, origin.y-16, origin.z-16, origin.x+16, origin.y+16, origin.z+16),
                entity -> entity != player && !(entity instanceof EnderDragonPart) && entity.position().distanceToSqr(origin) <= 256, found, 65);
        JsonArray entities = new JsonArray();
        for (int i = 0; i < Math.min(64, found.size()); i++) {
            Entity entity = found.get(i); JsonObject entry = new JsonObject(); entry.addProperty("entityId", id(entity.getUUID().toString()));
            entry.addProperty("entityType", id(BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString())); entry.add("position", position(entity.position())); entities.add(entry);
        }
        nearby.addProperty("entitiesTruncated", found.size() > 64); nearby.add("entities", entities); state.add("nearby", nearby); return state;
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

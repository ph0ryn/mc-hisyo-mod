package io.github.ph0ryn.mchisyo.protocol;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.Set;

/** Immutable world/player/session identifiers; the wire schema does not require UUID syntax. */
public record WorldBinding(String worldId, String playerId, String worldSessionId) {
    public WorldBinding {
        JsonRpc.identifier(worldId);
        JsonRpc.identifier(playerId);
        JsonRpc.identifier(worldSessionId);
    }

    public static WorldBinding fromJson(JsonElement value) {
        JsonObject object = JsonRpc.object(value);
        JsonRpc.keys(object, Set.of("worldId", "playerId", "worldSessionId"), Set.of());
        return new WorldBinding(JsonRpc.string(object.get("worldId")), JsonRpc.string(object.get("playerId")),
                JsonRpc.string(object.get("worldSessionId")));
    }

    public JsonObject toJson() {
        JsonObject result = new JsonObject();
        result.addProperty("worldId", worldId);
        result.addProperty("playerId", playerId);
        result.addProperty("worldSessionId", worldSessionId);
        return result;
    }
}

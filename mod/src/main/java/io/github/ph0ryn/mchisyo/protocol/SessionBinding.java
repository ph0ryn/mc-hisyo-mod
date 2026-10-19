package io.github.ph0ryn.mchisyo.protocol;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.Set;

/** Immutable world/player/session identifiers; the wire schema does not require UUID syntax. */
public record SessionBinding(String worldId, String playerId, String sessionId) {
    public SessionBinding {
        JsonRpc.identifier(worldId);
        JsonRpc.identifier(playerId);
        JsonRpc.identifier(sessionId);
    }

    public static SessionBinding fromJson(JsonElement value) {
        JsonObject object = JsonRpc.object(value);
        JsonRpc.keys(object, Set.of("worldId", "playerId", "sessionId"), Set.of());
        return new SessionBinding(JsonRpc.string(object.get("worldId")), JsonRpc.string(object.get("playerId")),
                JsonRpc.string(object.get("sessionId")));
    }

    public JsonObject toJson() {
        JsonObject result = new JsonObject();
        result.addProperty("worldId", worldId);
        result.addProperty("playerId", playerId);
        result.addProperty("sessionId", sessionId);
        return result;
    }
}

package io.github.ph0ryn.mchisyo.protocol;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.Set;

/** Capture this immutable value when a run starts; never relabel old work with a new run. */
public record RunBinding(String worldId, String playerId, String worldSessionId, String runId) {
    public RunBinding {
        JsonRpc.identifier(worldId);
        JsonRpc.identifier(playerId);
        JsonRpc.identifier(worldSessionId);
        JsonRpc.identifier(runId);
    }

    public WorldBinding worldBinding() {
        return new WorldBinding(worldId, playerId, worldSessionId);
    }

    public static RunBinding fromJson(JsonElement value) {
        JsonObject object = JsonRpc.object(value);
        JsonRpc.keys(object, Set.of("worldId", "playerId", "worldSessionId", "runId"), Set.of());
        return new RunBinding(JsonRpc.string(object.get("worldId")), JsonRpc.string(object.get("playerId")),
                JsonRpc.string(object.get("worldSessionId")), JsonRpc.string(object.get("runId")));
    }

    public JsonObject toJson() {
        JsonObject result = worldBinding().toJson();
        result.addProperty("runId", runId);
        return result;
    }
}

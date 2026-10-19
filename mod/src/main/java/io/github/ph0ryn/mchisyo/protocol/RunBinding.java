package io.github.ph0ryn.mchisyo.protocol;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.Set;

/** Capture this immutable value when a run starts; never relabel old work with a new run. */
public record RunBinding(String worldId, String playerId, String sessionId, String runId) {
    public RunBinding {
        JsonRpc.identifier(worldId);
        JsonRpc.identifier(playerId);
        JsonRpc.identifier(sessionId);
        JsonRpc.identifier(runId);
    }

    public SessionBinding sessionBinding() {
        return new SessionBinding(worldId, playerId, sessionId);
    }

    public static RunBinding fromJson(JsonElement value) {
        JsonObject object = JsonRpc.object(value);
        JsonRpc.keys(object, Set.of("worldId", "playerId", "sessionId", "runId"), Set.of());
        return new RunBinding(JsonRpc.string(object.get("worldId")), JsonRpc.string(object.get("playerId")),
                JsonRpc.string(object.get("sessionId")), JsonRpc.string(object.get("runId")));
    }

    public JsonObject toJson() {
        JsonObject result = sessionBinding().toJson();
        result.addProperty("runId", runId);
        return result;
    }
}

package io.github.ph0ryn.mchisyo.transport;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import io.github.ph0ryn.mchisyo.protocol.JsonRpc;

/** Deliberately public wire error. Only these errors may expose a handler message/data. */
public final class RpcError extends RuntimeException {
    private final JsonElement code;
    private final JsonElement data;

    public RpcError(int code, String message) { this(new JsonPrimitive(code), message, null); }
    public RpcError(int code, String message, JsonElement data) { this(new JsonPrimitive(code), message, data); }

    public RpcError(JsonElement code, String message, JsonElement data) {
        super(message);
        JsonObject error = new JsonObject();
        error.add("code", code);
        error.addProperty("message", message);
        if (data != null) error.add("data", data);
        JsonObject envelope = new JsonObject();
        envelope.addProperty("jsonrpc", "2.0");
        envelope.add("id", com.google.gson.JsonNull.INSTANCE);
        envelope.add("error", error);
        JsonObject validated = JsonRpc.validate(envelope).getAsJsonObject("error");
        this.code = validated.get("code");
        this.data = validated.get("data");
    }

    public JsonElement code() { return code.deepCopy(); }
    /** Java null means absent; JsonNull means explicitly present null. */
    public JsonElement data() { return data == null ? null : data.deepCopy(); }
}

package io.github.ph0ryn.mchisyo.protocol;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.Strictness;
import java.util.Set;

/** Pure JSON-RPC 2.0 envelope validation matching src/protocol/jsonRpc.ts, not method dispatch. */
public final class JsonRpc {
    private static final Gson JSON = new GsonBuilder().setStrictness(Strictness.STRICT).create();

    private JsonRpc() {}

    public static JsonObject parse(String json) {
        if (json == null) throw new IllegalArgumentException("Missing JSON-RPC frame");
        // Framing already removes one UTF-8 BOM. Gson would silently consume a second one.
        if (json.startsWith("\ufeff")) throw new IllegalArgumentException("Unexpected BOM in JSON-RPC JSON");
        try {
            return validate(JSON.fromJson(json, JsonElement.class));
        } catch (JsonParseException invalid) {
            throw new IllegalArgumentException("Invalid JSON-RPC JSON", invalid);
        }
    }

    /** Returns an owned copy; callers retain no mutable references into the validated message. */
    public static JsonObject validate(JsonElement value) {
        JsonObject message = object(value);
        if (!"2.0".equals(string(message.get("jsonrpc")))) invalid();
        if (message.has("method")) {
            keys(message, Set.of("jsonrpc", "method"), Set.of("id", "params"));
            identifier(string(message.get("method")));
            if (message.has("params")) {
                JsonElement params = message.get("params");
                if (!params.isJsonObject() && !params.isJsonArray()) invalid();
            }
        } else if (message.has("result")) {
            keys(message, Set.of("jsonrpc", "id", "result"), Set.of());
        } else if (message.has("error")) {
            keys(message, Set.of("jsonrpc", "id", "error"), Set.of());
            JsonObject error = object(message.get("error"));
            keys(error, Set.of("code", "message"), Set.of("data"));
            double code = number(error.get("code"));
            if (code != Math.rint(code)) invalid();
            string(error.get("message"));
        } else {
            invalid();
        }
        if (message.has("id")) {
            JsonElement id = message.get("id");
            if (!id.isJsonNull() && !(id.isJsonPrimitive() && id.getAsJsonPrimitive().isString())) number(id);
        }
        return message.deepCopy();
    }

    static JsonObject object(JsonElement value) {
        if (value == null || !value.isJsonObject()) throw new IllegalArgumentException("Expected JSON object");
        return value.getAsJsonObject();
    }

    static String string(JsonElement value) {
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            throw new IllegalArgumentException("Expected JSON string");
        }
        return value.getAsString();
    }

    static void identifier(String value) {
        if (value == null || value.isEmpty() || value.codePointCount(0, value.length()) > 128) {
            throw new IllegalArgumentException("Identifier must contain 1 to 128 Unicode code points");
        }
    }

    static void keys(JsonObject value, Set<String> required, Set<String> optional) {
        if (!value.keySet().containsAll(required)) invalid();
        for (String key : value.keySet()) {
            if (!required.contains(key) && !optional.contains(key)) invalid();
        }
    }

    private static double number(JsonElement value) {
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
            throw new IllegalArgumentException("Expected finite JSON number");
        }
        double number = value.getAsDouble();
        if (!Double.isFinite(number)) invalid();
        return number;
    }

    private static void invalid() {
        throw new IllegalArgumentException("Invalid JSON-RPC value or object fields");
    }
}

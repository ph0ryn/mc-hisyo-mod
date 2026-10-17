package io.github.ph0ryn.mchisyo.transport;

import static org.junit.jupiter.api.Assertions.*;

import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import io.github.ph0ryn.mchisyo.protocol.JsonRpc;
import io.github.ph0ryn.mchisyo.protocol.RunBinding;
import io.github.ph0ryn.mchisyo.protocol.WorldBinding;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Literal byte/value unit checks only: no game, network, child process or database. */
public final class TransportTest {

    @Test
    void runtimeIsAbsent() {
        assertNull(TransportTest.class.getClassLoader().getResource("net/minecraft/server/MinecraftServer.class"), "no Minecraft runtime");
        assertNull(TransportTest.class.getClassLoader().getResource("net/fabricmc/loader/api/FabricLoader.class"), "no Fabric runtime");
    }

    @Test
    void framing() {
        byte[] wire = "{\"text\":\"日本語😀\"}\n{\"result\":null}\n".getBytes(StandardCharsets.UTF_8);
        for (int split = 0; split <= wire.length; split++) {
            var decoder = new JsonLineCodec.Decoder();
            List<String> lines = new ArrayList<>();
            decoder.push(Arrays.copyOfRange(wire, 0, split), lines::add);
            decoder.push(Arrays.copyOfRange(wire, split, wire.length), lines::add);
            decoder.finish();
            assertEquals(List.of("{\"text\":\"日本語😀\"}", "{\"result\":null}"), lines, "every byte split including Japanese");
        }
        var bytewise = new JsonLineCodec.Decoder();
        List<String> lines = new ArrayList<>();
        for (byte value : wire) bytewise.push(new byte[] { value }, lines::add);
        bytewise.finish();
        assertEquals(2, lines.size(), "one byte at a time");
        var boundaries = new JsonLineCodec.Decoder(3);
        lines.clear();
        boundaries.push("日\nabc\n\n".getBytes(StandardCharsets.UTF_8), lines::add);
        boundaries.finish();
        assertEquals(List.of("日", "abc", ""), lines, "limit excludes LF; empty frames reach parser");
        assertThrows(IllegalArgumentException.class, () -> new JsonLineCodec.Decoder(0), "zero frame budget");
        assertThrows(IllegalArgumentException.class, () -> new JsonLineCodec.Decoder(-1), "negative frame budget");
        assertThrows(IllegalArgumentException.class, () -> new JsonLineCodec.Decoder(2).push("日\n".getBytes(StandardCharsets.UTF_8), s -> {}), "byte not character budget");
        assertThrows(IllegalArgumentException.class, () -> new JsonLineCodec.Decoder(3).push("abcd".getBytes(StandardCharsets.UTF_8), s -> {}), "unterminated overflow");
        var incomplete = new JsonLineCodec.Decoder();
        incomplete.push(new byte[] { (byte) 0xe6 }, s -> {});
        assertThrows(IllegalArgumentException.class, incomplete::finish, "partial UTF8 EOF is incomplete frame");
        var noLf = new JsonLineCodec.Decoder();
        noLf.push("{}".getBytes(StandardCharsets.UTF_8), s -> {});
        assertThrows(IllegalArgumentException.class, noLf::finish, "JSON without LF rejected at EOF");
        for (byte[] invalid : List.of(new byte[] { (byte) 0xff, 10 }, new byte[] { (byte) 0xc0, (byte) 0xaf, 10 },
                new byte[] { (byte) 0xed, (byte) 0xa0, (byte) 0x80, 10 }, new byte[] { (byte) 0xe6, 10 })) {
            assertThrows(IllegalArgumentException.class, () -> new JsonLineCodec.Decoder().push(invalid, s -> {}), "fatal UTF8");
        }
        lines.clear();
        new JsonLineCodec.Decoder().push("\ufeff{}\r\n\ufeff{}\n".getBytes(StandardCharsets.UTF_8), lines::add);
        assertEquals(List.of("{}\r", "{}"), lines, "TextDecoder-compatible BOM handling and LF-only framing");
        JsonObject value = JsonParser.parseString("{\"text\":\"日本語\\n<>&\",\"value\":null}").getAsJsonObject();
        byte[] encoded = JsonLineCodec.encode(value);
        assertEquals("{\"text\":\"日本語\\n<>&\",\"value\":null}\n", new String(encoded, StandardCharsets.UTF_8), "encoding preserves null, UTF8 and embedded newline");
        assertEquals("null\n", new String(JsonLineCodec.encode(JsonNull.INSTANCE), StandardCharsets.UTF_8), "literal null encoding");
        assertThrows(IllegalArgumentException.class, () -> JsonLineCodec.encode(new JsonPrimitive(Double.NaN)), "invalid producer NaN fails explicitly");
        JsonObject nonfinite = new JsonObject();
        nonfinite.addProperty("value", Double.POSITIVE_INFINITY);
        assertThrows(IllegalArgumentException.class, () -> JsonLineCodec.encode(nonfinite), "nested invalid producer infinity fails explicitly");
        assertEquals("\"\\ud800\"\n", new String(JsonLineCodec.encode(new JsonPrimitive("\ud800")), StandardCharsets.UTF_8), "lone surrogate survives as JSON escape");
        JsonElement separators = new JsonPrimitive("\u2028\u2029\\u2028");
        assertEquals(separators, JsonParser.parseString(new String(JsonLineCodec.encode(separators), StandardCharsets.UTF_8)), "line separators and escaped text roundtrip without spelling policy");
        assertEquals("\"日\"\n", new String(JsonLineCodec.encode(new JsonPrimitive("日"), 5), StandardCharsets.UTF_8), "exact encoded budget");
        assertThrows(IllegalArgumentException.class, () -> JsonLineCodec.encode(new JsonPrimitive("日"), 4), "encoded UTF8 overflow");
        assertEquals(1024 * 1024, JsonLineCodec.DEFAULT_MAX_FRAME_BYTES, "TCP budget not Pi budget");
        var maximum = new JsonLineCodec.Decoder();
        maximum.push("x".repeat(1024 * 1024).getBytes(StandardCharsets.UTF_8), s -> {});
        maximum.push(new byte[] { 10 }, s -> assertEquals(1024 * 1024, s.length(), "exact default frame"));
        maximum.finish();
        assertThrows(IllegalArgumentException.class, () -> new JsonLineCodec.Decoder().push(new byte[1024 * 1024 + 1], s -> {}), "default overflow");
    }

    @Test
    void envelopes() {
        for (String id : List.of("null", "0", "-1", "1.25", "1e100", "1.7976931348623157e308", "\"\"", "\"" + "x".repeat(256) + "\"")) {
            for (String body : List.of("\"method\":\"game.state.get\"", "\"result\":null", "\"error\":{\"code\":-32602,\"message\":\"\",\"data\":null}")) {
                String json = "{\"jsonrpc\":\"2.0\",\"id\":" + id + "," + body + "}";
                assertEquals(JsonParser.parseString(json), JsonRpc.parse(json), "all ID forms and explicit nulls");
                assertEquals(JsonParser.parseString(json), JsonRpc.parse(new String(JsonLineCodec.encode(JsonRpc.parse(json)), StandardCharsets.UTF_8)), "wire roundtrip preserves null ID/result/error data");
            }
        }
        for (String params : List.of("{}", "[]", "{\"unknown\":[null,true,1,\"日\"]}")) {
            String json = "{\"jsonrpc\":\"2.0\",\"method\":\"future.method\",\"params\":" + params + "}";
            assertEquals(JsonParser.parseString(json), JsonRpc.parse(json), "generic envelope accepts unknown method and nested params");
        }
        JsonRpc.parse("{\"jsonrpc\":\"2.0\",\"method\":\"" + "😀".repeat(128) + "\"}");
        JsonRpc.parse("{\"jsonrpc\":\"2.0\",\"id\":0,\"error\":{\"code\":1e100,\"message\":\"x\",\"data\":[null,{}]}}");
        JsonRpc.parse("{\"jsonrpc\":\"2.0\",\"method\":\"a\",\"params\":{\"unconstrainedNumber\":1e400}}");
        assertThrows(IllegalArgumentException.class, () -> JsonRpc.parse("\ufeff{\"jsonrpc\":\"2.0\",\"method\":\"a\"}"), "JSON.parse rejects BOM remaining after framing");
        for (String invalid : List.of("null", "[]", "[{}]", "true", "{}", "{\"jsonrpc\":2,\"method\":\"a\"}",
                "{\"jsonrpc\":\"1.0\",\"method\":\"a\"}", "{\"jsonrpc\":\"2.0\",\"method\":\"\"}",
                "{\"jsonrpc\":\"2.0\",\"method\":\"" + "😀".repeat(129) + "\"}",
                "{\"jsonrpc\":\"2.0\",\"method\":1}", "{\"jsonrpc\":\"2.0\",\"method\":\"a\",\"extra\":null}",
                "{\"jsonrpc\":\"2.0\",\"method\":\"a\",\"params\":null}", "{\"jsonrpc\":\"2.0\",\"method\":\"a\",\"params\":1}",
                "{\"jsonrpc\":\"2.0\",\"method\":\"a\",\"params\":\"x\"}", "{\"jsonrpc\":\"2.0\",\"method\":\"a\",\"id\":true}",
                "{\"jsonrpc\":\"2.0\",\"method\":\"a\",\"id\":[]}", "{\"jsonrpc\":\"2.0\",\"method\":\"a\",\"id\":{}}",
                "{\"jsonrpc\":\"2.0\",\"method\":\"a\",\"id\":1e400}", "{\"jsonrpc\":\"2.0\",\"result\":null}",
                "{\"jsonrpc\":\"2.0\",\"id\":null}", "{\"jsonrpc\":\"2.0\",\"id\":null,\"result\":1,\"error\":{}}",
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"a\",\"result\":1}",
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":1,\"params\":[]}",
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":null}", "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":[]}",
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":1.5,\"message\":\"a\"}}",
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":\"1\",\"message\":\"a\"}}",
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":1,\"message\":null}}",
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":1}}",
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":1,\"message\":\"a\",\"extra\":0}}",
                "{jsonrpc:'2.0',method:'a'}", "{\"jsonrpc\":\"2.0\",\"method\":\"a\",}",
                "{\"jsonrpc\":\"2.0\",\"method\":\"a\"} {}", "/*comment*/{\"jsonrpc\":\"2.0\",\"method\":\"a\"}")) {
            assertThrows(IllegalArgumentException.class, () -> JsonRpc.parse(invalid), "strict RPC rejection: " + invalid);
        }
        JsonObject original = JsonParser.parseString("{\"jsonrpc\":\"2.0\",\"method\":\"a\",\"params\":{\"x\":null}}").getAsJsonObject();
        JsonObject validated = JsonRpc.validate(original);
        original.getAsJsonObject("params").addProperty("x", "mutated");
        assertEquals(JsonNull.INSTANCE, validated.getAsJsonObject("params").get("x"), "validated tree is an owned copy");
    }

    @Test
    void bindings() {
        WorldBinding world = new WorldBinding("world", "player", "session");
        RunBinding run = new RunBinding("world", "player", "session", "run");
        assertEquals(world, run.worldBinding(), "run world seam");
        assertEquals(world, WorldBinding.fromJson(world.toJson()), "world exact wire roundtrip");
        assertEquals(run, RunBinding.fromJson(run.toJson()), "run exact wire roundtrip");
        assertEquals(JsonParser.parseString("{\"worldId\":\"world\",\"playerId\":\"player\",\"worldSessionId\":\"session\",\"runId\":\"run\"}"), run.toJson(), "flat run wire shape");
        assertFalse(run.equals(new RunBinding("world", "player", "session", "other")), "run equality exact");
        assertFalse(world.equals(new WorldBinding("world", "player", "other")), "session equality exact");
        assertEquals("😀".repeat(128), new WorldBinding("😀".repeat(128), "p", "s").worldId(), "identifier code points not UTF16 units");
        for (String value : Arrays.asList(null, "", "x".repeat(129), "😀".repeat(129))) {
            assertThrows(IllegalArgumentException.class, () -> new WorldBinding(value, "p", "s"), "invalid world identifier");
            assertThrows(IllegalArgumentException.class, () -> new RunBinding("w", "p", "s", value), "invalid run identifier");
        }
        for (String invalid : List.of("null", "[]", "{}", "{\"worldId\":1,\"playerId\":\"p\",\"worldSessionId\":\"s\"}",
                "{\"worldId\":\"w\",\"playerId\":null,\"worldSessionId\":\"s\"}",
                "{\"worldId\":\"w\",\"playerId\":\"p\",\"worldSessionId\":\"s\",\"unknown\":true}")) {
            assertThrows(IllegalArgumentException.class, () -> WorldBinding.fromJson(JsonParser.parseString(invalid)), "strict binding shape");
        }
        assertThrows(IllegalArgumentException.class, () -> WorldBinding.fromJson(run.toJson()), "world does not accept run extra key");
        assertThrows(IllegalArgumentException.class, () -> RunBinding.fromJson(world.toJson()), "run requires run ID");
    }

}

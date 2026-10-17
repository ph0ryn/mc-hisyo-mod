package io.github.ph0ryn.mchisyo.transport;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.Strictness;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;

/** UTF-8/LF framing only; independent of sockets, JSON-RPC dispatch and Pi stdio budgets. */
public final class JsonLineCodec {
    public static final int DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
    private static final Gson JSON = new GsonBuilder().serializeNulls().disableHtmlEscaping()
            .setStrictness(Strictness.STRICT).create();

    private JsonLineCodec() {}

    public static byte[] encode(JsonElement value) {
        return encode(value, DEFAULT_MAX_FRAME_BYTES);
    }

    public static byte[] encode(JsonElement value, int maxFrameBytes) {
        limit(maxFrameBytes);
        byte[] frame = (escapeLoneSurrogates(JSON.toJson(value)) + "\n").getBytes(StandardCharsets.UTF_8);
        if (frame.length - 1 > maxFrameBytes) throw new IllegalArgumentException("JSONL frame exceeds byte limit");
        return frame;
    }

    // Gson may emit lone UTF-16 surrogates literally; UTF-8 getBytes would silently replace them.
    // Preserve them as JSON escapes instead. Ordinary pairs and Gson's existing escapes stay intact.
    private static String escapeLoneSurrogates(String json) {
        StringBuilder result = new StringBuilder(json.length());
        for (int i = 0; i < json.length(); i++) {
            char current = json.charAt(i);
            if (Character.isHighSurrogate(current) && i + 1 < json.length()
                    && Character.isLowSurrogate(json.charAt(i + 1))) {
                result.append(current).append(json.charAt(++i));
            } else if (Character.isSurrogate(current)) {
                result.append(String.format("\\u%04x", (int) current));
            } else {
                result.append(current);
            }
        }
        return result.toString();
    }

    private static void limit(int bytes) {
        if (bytes < 1) throw new IllegalArgumentException("Invalid frame byte limit");
    }

    /** Single-reader decoder. After an exception, its owner must discard it and fail the transport. */
    public static final class Decoder {
        private final int maxFrameBytes;
        private final ByteArrayOutputStream pending = new ByteArrayOutputStream();

        public Decoder() {
            this(DEFAULT_MAX_FRAME_BYTES);
        }

        public Decoder(int maxFrameBytes) {
            limit(maxFrameBytes);
            this.maxFrameBytes = maxFrameBytes;
        }

        public void push(byte[] chunk, Consumer<String> onLine) {
            int start = 0;
            for (int end = 0; end < chunk.length; end++) {
                if (chunk[end] == 10) {
                    append(chunk, start, end - start);
                    onLine.accept(decode(pending.toByteArray()));
                    pending.reset();
                    start = end + 1;
                }
            }
            append(chunk, start, chunk.length - start);
        }

        public void finish() {
            if (pending.size() != 0) throw new IllegalArgumentException("Incomplete JSONL frame at EOF");
        }

        private void append(byte[] bytes, int offset, int length) {
            if (length > maxFrameBytes - pending.size()) throw new IllegalArgumentException("JSONL frame exceeds byte limit");
            pending.write(bytes, offset, length);
        }

        private static String decode(byte[] bytes) {
            try {
                String line = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                        .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
                // Node TextDecoder removes one leading UTF-8 BOM on each completed frame.
                return line.startsWith("\ufeff") ? line.substring(1) : line;
            } catch (CharacterCodingException invalid) {
                throw new IllegalArgumentException("Invalid UTF-8 JSONL frame", invalid);
            }
        }
    }
}

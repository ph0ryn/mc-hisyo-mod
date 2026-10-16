package io.github.ph0ryn.mchisyo.session;

import com.google.gson.*;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import java.io.IOException;
import java.io.StringReader;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.*;
import java.util.*;

/** Small literal codecs plus the bootstrap worker's file adapter. Never log input or causes. */
public final class DirectorFiles {
    private static final int LIMIT = 4096;
    private DirectorFiles() {}
    public record Connection(int port, String token) {
        @Override public String toString() { return "Director connection (redacted)"; }
    }
    public record Bootstrap(Connection connection, String worldId) {}

    private static JsonObject flat(String text) {
        try (JsonReader reader = new JsonReader(new StringReader(text))) {
            reader.setStrictness(Strictness.STRICT);
            JsonObject result = new JsonObject(); reader.beginObject();
            while (reader.hasNext()) {
                String key = reader.nextName();
                if (result.has(key)) throw invalid();
                JsonToken type = reader.peek();
                if (type == JsonToken.STRING) result.addProperty(key, reader.nextString());
                else if (type == JsonToken.NUMBER) result.add(key, JsonParser.parseString(reader.nextString()));
                else throw invalid();
            }
            reader.endObject(); if (reader.peek() != JsonToken.END_DOCUMENT) throw invalid();
            return result;
        } catch (IOException | RuntimeException error) { throw invalid(); }
    }
    private static IllegalArgumentException invalid() { return new IllegalArgumentException("Invalid Director file"); }
    private static String string(JsonObject object, String key) {
        JsonElement value = object.get(key);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) throw invalid();
        return value.getAsString();
    }
    private static long integer(JsonObject object, String key, long min, long max) {
        JsonElement value = object.get(key);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) throw invalid();
        try { long number = value.getAsBigDecimal().longValueExact(); if (number < min || number > max) throw invalid(); return number; }
        catch (ArithmeticException error) { throw invalid(); }
    }
    public static Connection parseConnection(String text) {
        JsonObject object = flat(text);
        if (!object.keySet().equals(Set.of("protocolVersion", "host", "port", "token", "pid"))) throw invalid();
        integer(object, "protocolVersion", 1, 1);
        if (!string(object, "host").equals("127.0.0.1")) throw invalid();
        String token = string(object, "token"); if (!token.matches("[A-Za-z0-9_-]{43}")) throw invalid();
        integer(object, "pid", 1, 9007199254740991L);
        return new Connection((int) integer(object, "port", 1, 65535), token);
    }
    public static Path parseSettings(String text) {
        JsonObject object = flat(text);
        if (!object.keySet().equals(Set.of("dataDirectory"))) throw invalid();
        try { Path path = Path.of(string(object, "dataDirectory")); if (!path.isAbsolute()) throw invalid(); return path; }
        catch (InvalidPathException error) { throw invalid(); }
    }
    public static String parseWorldId(String text) {
        if (!text.endsWith("\n")) throw invalid();
        String id = text.substring(0, text.length() - 1);
        try { if (!UUID.fromString(id).toString().equals(id)) throw invalid(); }
        catch (IllegalArgumentException error) { throw invalid(); }
        return id;
    }
    public static Bootstrap load(Path configDir, Path worldRoot) throws IOException {
        try {
            Path directory;
            try { directory = parseSettings(read(configDir.resolve("mc-hisyo.json"))); }
            catch (NoSuchFileException absent) { directory = Path.of(System.getProperty("user.home"), ".mc-hisyo"); }
            UserPrincipal user = directory.getFileSystem().getUserPrincipalLookupService()
                    .lookupPrincipalByName(System.getProperty("user.name"));
            privatePath(directory, user, true);
            Path file = directory.resolve("connection.json"); privatePath(file, user, false);
            Connection connection = parseConnection(read(file));
            Path sidecar = worldRoot.resolve("mc-hisyo-world-id");
            String worldId;
            try { worldId = parseWorldId(read(sidecar)); }
            catch (NoSuchFileException absent) {
                String created = UUID.randomUUID().toString();
                try { Files.writeString(sidecar, created + "\n", StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE); worldId = created; }
                catch (FileAlreadyExistsException race) { worldId = parseWorldId(read(sidecar)); }
            }
            return new Bootstrap(connection, worldId);
        } catch (IOException | RuntimeException error) { throw new IOException("Unable to read Director connection or world identity"); }
    }
    private static void privatePath(Path path, UserPrincipal user, boolean directory) throws IOException {
        PosixFileAttributes attrs = Files.readAttributes(path, PosixFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        Set<PosixFilePermission> permissions = PosixFilePermissions.fromString(directory ? "rwx------" : "rw-------");
        if (attrs.isSymbolicLink() || (directory ? !attrs.isDirectory() : !attrs.isRegularFile())
                || !attrs.owner().equals(user) || !attrs.permissions().equals(permissions)) throw new IOException("Unsafe Director discovery permissions");
    }
    private static String read(Path path) throws IOException {
        try (var channel = Files.newByteChannel(path, Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS))) {
            ByteBuffer bytes = ByteBuffer.allocate(LIMIT + 1);
            while (bytes.hasRemaining() && channel.read(bytes) != -1) {}
            if (bytes.position() > LIMIT) throw new IOException("Director file is too large");
            bytes.flip();
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(bytes).toString();
        }
    }
}

package io.github.ph0ryn.mchisyo.reference;

import com.google.gson.*;
import io.github.ph0ryn.mchisyo.session.GameSession;
import io.github.ph0ryn.mchisyo.transport.JsonLineCodec;
import io.github.ph0ryn.mchisyo.transport.RpcError;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.*;
import java.util.function.Function;

/** Read-only capabilities over a fixed loader-selected snapshot; does not own or close filesystems. */
public final class PackagedReferences {
    public record Root(String id, Path path, String reason) {}
    public record Page(List<String> names, String nextCursor) {}
    private final SortedMap<String, Root> roots;
    public PackagedReferences(List<Root> selected) {
        if (selected.size() > 4096) throw failure("Reference root limit exceeded");
        TreeMap<String, Root> copy = new TreeMap<>();
        for (Root root : selected) {
            rootId(root.id());
            String reason = root.path() == null ? "root_unavailable" : !archive(root.path()) ? "nonarchive_root" : null;
            if (copy.put(root.id(), new Root(root.id(), reason == null ? root.path() : null, reason)) != null) throw failure("Duplicate reference root");
        }
        roots = Collections.unmodifiableSortedMap(copy);
    }
    public static boolean archive(Path path) { return path.getFileSystem().provider().getScheme().equals("jar"); }
    private static RpcError invalid() { return new RpcError(-32602, "Invalid reference parameters"); }
    private static RpcError failure(String message) { return new RpcError(-32004, message); }
    private static String string(JsonObject query, String key) {
        JsonElement value = query.get(key);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) throw invalid();
        return value.getAsString();
    }
    private static void rootId(String id) { if (id.length() > 128 || !id.matches("[a-z0-9_.-]+:[0-9]+")) throw invalid(); }
    public static String logicalPath(String path, boolean empty) {
        if (path.length() > 1024 || (!empty && path.isEmpty()) || path.indexOf('\\') >= 0 || path.indexOf(':') >= 0
                || path.codePoints().anyMatch(c -> Character.isISOControl(c) || c >= 0xd800 && c <= 0xdfff)) throw invalid();
        if (!path.isEmpty()) for (String part : path.split("/", -1)) if (part.isEmpty() || part.equals(".") || part.equals("..")) throw invalid();
        return path;
    }
    private static String filename(String name) { logicalPath(name, false); if (name.contains("/")) throw invalid(); return name; }
    public static void validate(String method, JsonObject query) {
        Set<String> allowed;
        switch (method) {
            case "game.files.list" -> {
                allowed = Set.of("root", "path", "after", "limit");
                if (query.has("root") != query.has("path")) throw invalid();
                if (query.has("limit")) { long limit = GameSession.safeCounter(query.get("limit"), false); if (limit < 1 || limit > 128) throw invalid(); }
            }
            case "game.files.read" -> { allowed = Set.of("root", "path"); if (!query.has("root") || !query.has("path")) throw invalid(); }
            case "game.files.search" -> {
                allowed = Set.of("root", "path", "text", "after");
                if (!query.has("root") || !query.has("path")) throw invalid();
                String text = string(query, "text"); if (text.isEmpty() || text.length() > 256 || text.codePoints().anyMatch(c -> c >= 0xd800 && c <= 0xdfff)) throw invalid();
            }
            default -> throw invalid();
        }
        if (!allowed.containsAll(query.keySet())) throw invalid();
        if (query.has("root")) { rootId(string(query, "root")); logicalPath(string(query, "path"), !method.equals("game.files.read")); }
        if (query.has("after")) { if (query.has("root")) filename(string(query, "after")); else rootId(string(query, "after")); }
    }
    public static boolean textFile(String name) {
        int dot = name.lastIndexOf('.');
        return dot >= 0 && Set.of("json", "mcmeta", "txt", "md", "lang", "properties", "csv", "xml", "yml", "yaml", "toml", "fsh", "vsh", "glsl").contains(name.substring(dot + 1));
    }
    public static String decode(byte[] bytes) {
        if (bytes.length > 65536) throw failure("Reference file exceeds 64KiB");
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            if (text.codePoints().anyMatch(c -> Character.isISOControl(c) && c != '\t' && c != '\r' && c != '\n')) throw failure("Reference file is binary");
            return text;
        } catch (CharacterCodingException error) { throw failure("Reference file is not UTF-8"); }
    }
    public static Page page(List<String> input, String after, int limit) {
        // ponytail: directory4096/list128/search32, text64KiB/path1024/result512KiB; add indexed paging or raise verified budgets if needed.
        if (input.size() > 4096) throw failure("Reference directory exceeds 4096 entries");
        if (limit < 1 || limit > 128) throw invalid();
        List<String> names = input.stream().sorted().filter(name -> after == null || name.compareTo(after) > 0).toList();
        int end = Math.min(limit, names.size());
        return new Page(List.copyOf(names.subList(0, end)), end < names.size() ? names.get(end - 1) : null);
    }
    public static void budget(JsonElement result) {
        try { JsonLineCodec.encode(result, 512 * 1024 - 4096); }
        catch (IllegalArgumentException error) { throw failure("Reference result exceeds byte limit"); }
    }
    private BasicFileAttributes inspect(Path path, Runnable guard) throws IOException {
        guard.run(); BasicFileAttributes attributes = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (attributes.isSymbolicLink()) throw failure("Reference links are unavailable");
        return attributes;
    }
    private Path resolve(String id, String logical, Runnable guard) throws IOException {
        Root selected = roots.get(id);
        if (selected == null) throw failure("Unknown reference root");
        Path root = selected.path();
        if (root == null) throw failure("Reference root unavailable");
        guard.run();
        if (!root.getFileSystem().isOpen() || !archive(root)) throw failure("Reference root unavailable");
        Path resolved = root;
        inspect(root, guard);
        if (!logical.isEmpty()) for (String part : logical.split("/")) {
            resolved = resolved.resolve(part);
            if (resolved.getFileSystem() != root.getFileSystem() || !resolved.normalize().startsWith(root.normalize()) || !archive(resolved)) throw failure("Reference path unavailable");
            inspect(resolved, guard);
        }
        return resolved;
    }
    private SortedMap<String, String> children(String id, String logical, Runnable guard) throws IOException {
        Path directory = resolve(id, logical, guard);
        if (!inspect(directory, guard).isDirectory()) throw failure("Reference is not a directory");
        TreeMap<String, String> entries = new TreeMap<>(); guard.run();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(directory)) {
            guard.run(); var iterator = stream.iterator();
            while (true) {
                guard.run(); if (!iterator.hasNext()) break;
                guard.run(); Path child = iterator.next();
                String name = filename(child.getFileName().toString());
                logicalPath(logical.isEmpty() ? name : logical + "/" + name, false);
                if (!child.getParent().equals(directory) || child.getFileSystem() != directory.getFileSystem() || !archive(child)) throw failure("Reference path unavailable");
                BasicFileAttributes attributes = inspect(child, guard);
                entries.put(name, attributes.isDirectory() ? "directory" : attributes.isRegularFile() ? "file" : "unsupported");
                if (entries.size() > 4096) throw failure("Reference directory exceeds 4096 entries");
            }
        }
        return entries;
    }
    private String read(String id, String logical, Runnable guard) throws IOException {
        if (!textFile(logical)) throw failure("Unsupported reference text extension");
        Path file = resolve(id, logical, guard); BasicFileAttributes attributes = inspect(file, guard);
        if (!attributes.isRegularFile()) throw failure("Reference is not a regular file");
        if (attributes.size() > 65536) throw failure("Reference file exceeds 64KiB");
        guard.run();
        try (var input = Files.newInputStream(file)) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[8192];
            while (bytes.size() <= 65536) {
                guard.run(); int count = input.read(buffer, 0, Math.min(buffer.length, 65537 - bytes.size()));
                if (count < 0) break;
                bytes.write(buffer, 0, count);
            }
            guard.run(); return decode(bytes.toByteArray());
        }
    }
    public static JsonObject search(List<String> candidates, String after, String text, Function<String, String> reader, Runnable guard) {
        Page page = page(candidates, after, 32); JsonArray matches = new JsonArray();
        for (String name : page.names()) {
            guard.run(); String content = reader.apply(name); int offset = content.indexOf(text);
            if (offset >= 0) { JsonObject match = new JsonObject(); match.addProperty("name", name); match.addProperty("offset", offset); matches.add(match); }
        }
        JsonObject result = new JsonObject(); result.addProperty("text", text); result.add("matches", matches);
        result.addProperty("scanned", page.names().size()); result.addProperty("firstMatchPerFile", true); cursor(result, page.nextCursor());
        return result;
    }
    private static void cursor(JsonObject result, String value) { result.add("nextCursor", value == null ? JsonNull.INSTANCE : new JsonPrimitive(value)); }
    public JsonObject query(String method, JsonObject query, Runnable guard) {
        validate(method, query); guard.run();
        try {
            JsonObject result = new JsonObject();
            String after = query.has("after") ? string(query, "after") : null;
            int limit = query.has("limit") ? query.get("limit").getAsInt() : 128;
            if (!query.has("root")) {
                result.addProperty("kind", "roots"); JsonArray listed = new JsonArray();
                Page page = page(new ArrayList<>(roots.keySet()), after, limit);
                for (String id : page.names()) {
                    guard.run(); Root root = roots.get(id); JsonObject entry = new JsonObject(); entry.addProperty("id", id);
                    boolean available = root.path() != null && root.path().getFileSystem().isOpen();
                    entry.addProperty("available", available);
                    entry.add("reason", root.reason() == null ? available ? JsonNull.INSTANCE : new JsonPrimitive("root_unavailable") : new JsonPrimitive(root.reason())); listed.add(entry);
                }
                result.add("roots", listed); cursor(result, page.nextCursor());
            } else {
                String id = string(query, "root"), logical = string(query, "path"); result.addProperty("root", id); result.addProperty("path", logical);
                if (method.equals("game.files.read")) {
                    String content = read(id, logical, guard); result.addProperty("content", content); result.addProperty("bytes", content.getBytes(StandardCharsets.UTF_8).length);
                } else {
                    SortedMap<String, String> entries = children(id, logical, guard);
                    if (method.equals("game.files.list")) {
                        result.addProperty("kind", "directory"); JsonArray listed = new JsonArray(); Page page = page(new ArrayList<>(entries.keySet()), after, limit);
                        for (String name : page.names()) { JsonObject entry = new JsonObject(); entry.addProperty("name", name); entry.addProperty("kind", entries.get(name)); listed.add(entry); }
                        result.add("entries", listed); cursor(result, page.nextCursor());
                    } else {
                        String text = string(query, "text");
                        JsonObject search = search(entries.entrySet().stream().filter(entry -> entry.getValue().equals("file") && textFile(entry.getKey())).map(Map.Entry::getKey).toList(), after, text, name -> {
                            try { return read(id, logical.isEmpty() ? name : logical + "/" + name, guard); }
                            catch (IOException error) { throw failure("Reference I/O unavailable"); }
                        }, guard);
                        for (var entry : search.entrySet()) result.add(entry.getKey(), entry.getValue());
                    }
                }
            }
            guard.run(); budget(result); guard.run(); return result;
        } catch (IOException | SecurityException | ClosedFileSystemException | DirectoryIteratorException error) { throw failure("Reference I/O unavailable"); }
    }
}

package io.github.ph0ryn.mchisyo.reference;

import com.google.gson.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Literal values only: never instantiates the Files/archive/loader adapter. */
public final class ReferenceChecks {
    private static int checks;
    private static void check(boolean value) { checks++; if (!value) throw new AssertionError("check " + checks); }
    private static void rejects(Runnable work) { try { work.run(); throw new AssertionError("accepted"); } catch (RuntimeException expected) { check(!expected.toString().contains("SECRET")); } }
    public static void main(String[] args) {
        for (String path : List.of("/secret", "../x", "x/..", "x/./y", "x//y", "x/", "C:/x", "x\\y", "x\0y", "x\ny", "x\u0085y", "x".repeat(1025))) rejects(() -> PackagedReferences.logicalPath(path, true));
        check(PackagedReferences.logicalPath("", true).equals(""));
        check(PackagedReferences.logicalPath("data/日本語.json", false).equals("data/日本語.json"));
        rejects(() -> PackagedReferences.logicalPath("", false));
        rejects(() -> PackagedReferences.logicalPath("\ud800", true));
        check(PackagedReferences.decode("日".repeat(21845).getBytes(StandardCharsets.UTF_8)).length() == 21845);
        check(PackagedReferences.decode(new byte[0]).isEmpty());
        rejects(() -> PackagedReferences.decode(new byte[]{(byte) 0xc3, 0x28}));
        rejects(() -> PackagedReferences.decode(new byte[]{0}));
        rejects(() -> PackagedReferences.decode(new byte[65537]));
        check(PackagedReferences.decode("x".repeat(65536).getBytes(StandardCharsets.UTF_8)).length() == 65536);
        var page = PackagedReferences.page(List.of("z.json", "a.json", "b.json"), "a.json", 1);
        check(page.names().equals(List.of("b.json"))); check(page.nextCursor().equals("b.json"));
        check(PackagedReferences.page(List.of("a.json", "b.json"), "b.json", 128).nextCursor() == null);
        rejects(() -> PackagedReferences.page(Collections.nCopies(4097, "x"), null, 128));
        rejects(() -> PackagedReferences.page(List.of("x"), null, 129));
        JsonObject small = new JsonObject(); small.addProperty("value", "x".repeat(90000)); PackagedReferences.budget(small); check(true);
        JsonObject escaped = new JsonObject(); escaped.addProperty("value", "\0".repeat(90000)); rejects(() -> PackagedReferences.budget(escaped));
        JsonObject query = JsonParser.parseString("{\"root\":\"minecraft:0\",\"path\":\"data\",\"text\":\"absent\"}").getAsJsonObject();
        PackagedReferences.validate("game.files.search", query); check(true);
        query.addProperty("regex", true); rejects(() -> PackagedReferences.validate("game.files.search", query));
        JsonObject emptySearch = JsonParser.parseString("{\"root\":\"minecraft:0\",\"path\":\"\",\"text\":\"\"}").getAsJsonObject();
        rejects(() -> PackagedReferences.validate("game.files.search", emptySearch));
        check(PackagedReferences.textFile("x.json")); check(!PackagedReferences.textFile("x.class"));
        List<String> candidates = java.util.stream.IntStream.range(0, 33).mapToObj(i -> String.format("%02d.json", i)).toList();
        int[] reads = {0};
        JsonObject noMatches = PackagedReferences.search(candidates, null, "needle", name -> { reads[0]++; return "absent"; }, () -> {});
        check(noMatches.getAsJsonArray("matches").isEmpty()); check(noMatches.get("scanned").getAsInt() == 32);
        check(noMatches.get("nextCursor").getAsString().equals("31.json")); check(reads[0] == 32);
        JsonObject last = PackagedReferences.search(candidates, "31.json", "needle", name -> "xneedle needle", () -> {});
        check(last.get("scanned").getAsInt() == 1); check(last.get("nextCursor").isJsonNull());
        check(last.getAsJsonArray("matches").size() == 1); check(last.getAsJsonArray("matches").get(0).getAsJsonObject().get("offset").getAsInt() == 1);
        check(PackagedReferences.search(List.of("x.json"), null, "NEEDLE", name -> "needle", () -> {}).getAsJsonArray("matches").isEmpty());
        rejects(() -> PackagedReferences.search(List.of("x.json"), null, "needle", name -> { throw new IllegalStateException("redacted"); }, () -> {}));
        int[] guards = {0}; int before = reads[0];
        rejects(() -> PackagedReferences.search(candidates, null, "needle", name -> { reads[0]++; return "needle"; }, () -> { if (++guards[0] == 2) throw new IllegalStateException("stale"); }));
        check(reads[0] == before + 1);
        System.out.println("ReferenceChecks: " + checks + " assertions (pure values/manual text ports only)");
    }
}

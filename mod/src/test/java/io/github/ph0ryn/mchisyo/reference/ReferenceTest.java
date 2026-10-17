package io.github.ph0ryn.mchisyo.reference;

import static org.junit.jupiter.api.Assertions.*;

import com.google.gson.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.junit.jupiter.api.Test;

/** Literal values only: never instantiates the Files/archive/loader adapter. */
public final class ReferenceTest {
    private static void rejects(Runnable work) {
        RuntimeException error = assertThrows(RuntimeException.class, work::run);
        assertFalse(error.toString().contains("SECRET"));
    }
    @Test
    void logicalPathsRejectTraversalAndInvalidText() {
        for (String path : List.of("/secret", "../x", "x/..", "x/./y", "x//y", "x/", "C:/x", "x\\y", "x\0y", "x\ny", "x\u0085y", "x".repeat(1025))) rejects(() -> PackagedReferences.logicalPath(path, true));
        assertTrue(PackagedReferences.logicalPath("", true).equals(""));
        assertTrue(PackagedReferences.logicalPath("data/日本語.json", false).equals("data/日本語.json"));
        rejects(() -> PackagedReferences.logicalPath("", false));
        rejects(() -> PackagedReferences.logicalPath("\ud800", true));
    }

    @Test
    void textDecodingEnforcesUtf8AndByteBudget() {
        assertTrue(PackagedReferences.decode("日".repeat(21845).getBytes(StandardCharsets.UTF_8)).length() == 21845);
        assertTrue(PackagedReferences.decode(new byte[0]).isEmpty());
        rejects(() -> PackagedReferences.decode(new byte[]{(byte) 0xc3, 0x28}));
        rejects(() -> PackagedReferences.decode(new byte[]{0}));
        rejects(() -> PackagedReferences.decode(new byte[65537]));
        assertTrue(PackagedReferences.decode("x".repeat(65536).getBytes(StandardCharsets.UTF_8)).length() == 65536);
    }

    @Test
    void paginationIsSortedAndBounded() {
        var page = PackagedReferences.page(List.of("z.json", "a.json", "b.json"), "a.json", 1);
        assertTrue(page.names().equals(List.of("b.json"))); assertTrue(page.nextCursor().equals("b.json"));
        assertTrue(PackagedReferences.page(List.of("a.json", "b.json"), "b.json", 128).nextCursor() == null);
        rejects(() -> PackagedReferences.page(Collections.nCopies(4097, "x"), null, 128));
        rejects(() -> PackagedReferences.page(List.of("x"), null, 129));
    }

    @Test
    void serializedBudgetIncludesEscaping() {
        JsonObject small = new JsonObject(); small.addProperty("value", "x".repeat(90000)); assertDoesNotThrow(() -> PackagedReferences.budget(small));
        JsonObject escaped = new JsonObject(); escaped.addProperty("value", "\0".repeat(90000)); rejects(() -> PackagedReferences.budget(escaped));
    }

    @Test
    void queriesRejectUnsupportedFieldsAndEmptySearch() {
        JsonObject query = JsonParser.parseString("{\"root\":\"minecraft:0\",\"path\":\"data\",\"text\":\"absent\"}").getAsJsonObject();
        assertDoesNotThrow(() -> PackagedReferences.validate("game.files.search", query));
        query.addProperty("regex", true); rejects(() -> PackagedReferences.validate("game.files.search", query));
        JsonObject emptySearch = JsonParser.parseString("{\"root\":\"minecraft:0\",\"path\":\"\",\"text\":\"\"}").getAsJsonObject();
        rejects(() -> PackagedReferences.validate("game.files.search", emptySearch));
        assertTrue(PackagedReferences.textFile("x.json")); assertTrue(!PackagedReferences.textFile("x.class"));
    }

    @Test
    void searchIsBoundedAndHonorsCaptureGuards() {
        List<String> candidates = java.util.stream.IntStream.range(0, 33).mapToObj(i -> String.format("%02d.json", i)).toList();
        int[] reads = {0};
        JsonObject noMatches = PackagedReferences.search(candidates, null, "needle", name -> { reads[0]++; return "absent"; }, () -> {});
        assertTrue(noMatches.getAsJsonArray("matches").isEmpty()); assertTrue(noMatches.get("scanned").getAsInt() == 32);
        assertTrue(noMatches.get("nextCursor").getAsString().equals("31.json")); assertTrue(reads[0] == 32);
        JsonObject last = PackagedReferences.search(candidates, "31.json", "needle", name -> "xneedle needle", () -> {});
        assertTrue(last.get("scanned").getAsInt() == 1); assertTrue(last.get("nextCursor").isJsonNull());
        assertTrue(last.getAsJsonArray("matches").size() == 1); assertTrue(last.getAsJsonArray("matches").get(0).getAsJsonObject().get("offset").getAsInt() == 1);
        assertTrue(PackagedReferences.search(List.of("x.json"), null, "NEEDLE", name -> "needle", () -> {}).getAsJsonArray("matches").isEmpty());
        rejects(() -> PackagedReferences.search(List.of("x.json"), null, "needle", name -> { throw new IllegalStateException("redacted"); }, () -> {}));
        int[] guards = {0}; int before = reads[0];
        rejects(() -> PackagedReferences.search(candidates, null, "needle", name -> { reads[0]++; return "needle"; }, () -> { if (++guards[0] == 2) throw new IllegalStateException("stale"); }));
        assertTrue(reads[0] == before + 1);
    }
}

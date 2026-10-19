import { expect, test } from "vite-plus/test";
import { Check } from "typebox/value";
import { hisyoToolNames } from "./hisyoTools.js";
import {
  referenceTools,
  validReferenceResult,
  referencePath,
  referenceResultBudget,
} from "./gameReferences.js";

const binding = { worldId: "world", playerId: "player", sessionId: "session", runId: "run" };
test("exact scoped tools and strict root/directory requests", () => {
  expect(referenceTools.map((tool) => tool.name)).toEqual([
    "list_game_files",
    "read_game_file",
    "search_game_files",
  ]);
  const list = referenceTools[0]!;
  expect(Check(list.request, { ...binding, query: {} })).toBe(true);
  expect(
    Check(list.request, { ...binding, query: { root: "minecraft:0", path: "", limit: 128 } }),
  ).toBe(true);
  for (const query of [
    { root: "minecraft:0" },
    { path: "" },
    { limit: 129 },
    { limit: 0 },
    { host: "/secret" },
  ])
    expect(Check(list.request, { ...binding, query })).toBe(false);
  expect(Check(list.request, { ...binding, query: {}, extra: true })).toBe(false);
});
test.each([
  "/etc/passwd",
  "../x",
  "x/..",
  "x/./y",
  "x//y",
  "x/",
  "C:/x",
  "x\\y",
  "x\0y",
  "x\ny",
  "x\u0085y",
  "x".repeat(1025),
])("reject logical path %j", (path) => {
  expect(referencePath(path)).toBe(false);
  expect(
    Check(referenceTools[1]!.request, { ...binding, query: { root: "minecraft:0", path } }),
  ).toBe(false);
});
test("read/search schemas reject unsupported precision and oversized inputs", () => {
  expect(referencePath("")).toBe(true);
  expect(referencePath("data/example/日本語.json")).toBe(true);
  expect(
    Check(referenceTools[1]!.request, { ...binding, query: { root: "minecraft:0", path: "" } }),
  ).toBe(false);
  expect(
    Check(referenceTools[2]!.request, {
      ...binding,
      query: { root: "minecraft:0", path: "data", text: "item", regex: true },
    }),
  ).toBe(false);
  expect(
    Check(referenceTools[2]!.request, {
      ...binding,
      query: { root: "minecraft:0", path: "data", text: "" },
    }),
  ).toBe(false);
});
test("full text byte and escaped serialized budgets are independent", () => {
  const tool = referenceTools[1]!;
  const result = (content: string, bytes: number) => ({
    ...binding,
    reference: { root: "minecraft:0", path: "x.json", content, bytes },
  });
  expect(validReferenceResult(tool, result("日".repeat(21845), 65535))).toBe(true);
  expect(validReferenceResult(tool, result("x".repeat(65536), 65536))).toBe(true);
  expect(validReferenceResult(tool, result("日".repeat(21846), 65538))).toBe(false);
  expect(validReferenceResult(tool, result("ok", 1))).toBe(false);
  expect(validReferenceResult(tool, result("\0", 1))).toBe(false);
  expect(validReferenceResult(tool, result("\ud800", 3))).toBe(false);
  expect(referenceResultBudget({ value: "\0".repeat(90_000) })).toBe(false);
  expect(referenceResultBudget({ value: "x".repeat(90_000) })).toBe(true);
});
test("read text preserves whitespace and Unicode while rejecting controls and lone surrogates", () => {
  const valid = (content: string) =>
    validReferenceResult(referenceTools[1]!, {
      ...binding,
      reference: {
        root: "minecraft:0",
        path: "x.json",
        content,
        bytes: Buffer.byteLength(content, "utf8"),
      },
    });
  for (let code = 0; code <= 159; code++) {
    const allowed = code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127);
    expect(valid(`before${String.fromCodePoint(code)}after`)).toBe(allowed);
  }
  for (const content of [
    "",
    "\t\n\r",
    "日本語",
    "\u00a0",
    "\ud7ff",
    "\ue000",
    "😀",
    "𐀀",
    "\u{10ffff}",
  ])
    expect(valid(content)).toBe(true);
  for (const content of [
    "\ud800",
    "\udbff",
    "\udc00",
    "\udfff",
    "\ud800x",
    "x\udfff",
    "\udc00\ud800",
  ])
    expect(valid(content)).toBe(false);
});
test("zero-match search pages retain examined cursor and exact metadata", () => {
  const result = {
    ...binding,
    reference: {
      root: "minecraft:0",
      path: "data",
      text: "absent",
      matches: [],
      scanned: 32,
      nextCursor: "z.json",
      firstMatchPerFile: true,
    },
  };
  expect(validReferenceResult(referenceTools[2]!, result)).toBe(true);
  expect(
    validReferenceResult(referenceTools[2]!, {
      ...result,
      reference: { ...result.reference, scanned: 33 },
    }),
  ).toBe(false);
  expect(
    validReferenceResult(referenceTools[2]!, {
      ...result,
      reference: { ...result.reference, extra: true },
    }),
  ).toBe(false);
});

test("exact ten-tool gate leaves builtin OS tools disabled", () => {
  expect(hisyoToolNames).toHaveLength(10);
  expect(new Set(hisyoToolNames).size).toBe(10);
  for (const { name } of referenceTools) expect(hisyoToolNames).toContain(name);
  for (const name of ["read", "write", "edit", "bash", "exec"])
    expect(hisyoToolNames).not.toContain(name);
});
test("roots paginate by IDs and report unavailable development roots truthfully", () => {
  const tool = referenceTools[0]!;
  expect(Check(tool.request, { ...binding, query: { after: "minecraft:0", limit: 1 } })).toBe(true);
  const result = (available: boolean, reason: string | null) => ({
    ...binding,
    reference: {
      kind: "roots",
      roots: [{ id: "example:0", available, reason }],
      nextCursor: "example:0",
    },
  });
  expect(validReferenceResult(tool, result(false, "nonarchive_root"))).toBe(true);
  expect(validReferenceResult(tool, result(true, null))).toBe(true);
  expect(validReferenceResult(tool, result(true, "nonarchive_root"))).toBe(false);
});
test("tool-result display escaping and duplicate details count toward the budget", () => {
  const reference = {
    kind: "directory",
    root: "minecraft:0",
    path: "",
    entries: Array.from({ length: 128 }, (_, i) => ({ name: "日".repeat(1000) + i, kind: "file" })),
    nextCursor: null,
  };
  expect(referenceResultBudget({ ...binding, reference })).toBe(true);
  expect(validReferenceResult(referenceTools[0]!, { ...binding, reference })).toBe(false);
});

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { RunBindingSchema } from "./bridge.js";
import { encodeJsonLine } from "../transport/jsonLines.js";

const strict = { additionalProperties: false } as const;
const root = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-z0-9_.-]+:[0-9]+$(?![\\s\\S])",
});
const segment = "(?!\\.\\.?(?:/|$))[^/\\\\:\\u0000-\\u001f\\u007f-\\u009f]+";
const path = Type.String({
  maxLength: 1024,
  pattern: `^(?:${segment}(?:/${segment})*)?$(?![\\s\\S])`,
});
const filePath = { ...path, minLength: 1 };
const name = Type.String({ minLength: 1, maxLength: 1024, pattern: `^${segment}$(?![\\s\\S])` });
const cursor = Type.Union([name, Type.Null()]);
const paging = {
  after: Type.Optional(name),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 128 })),
};
const directory = { root, path };
const listQuery = Type.Union([
  Type.Object({ ...paging, after: Type.Optional(root) }, strict),
  Type.Object({ ...directory, ...paging }, strict),
]);
const readQuery = Type.Object({ root, path: filePath }, strict);
const searchQuery = Type.Object(
  { ...directory, text: Type.String({ minLength: 1, maxLength: 256 }), after: Type.Optional(name) },
  strict,
);
const listResult = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("roots"),
      roots: Type.Array(
        Type.Union([
          Type.Object({ id: root, available: Type.Literal(true), reason: Type.Null() }, strict),
          Type.Object(
            {
              id: root,
              available: Type.Literal(false),
              reason: Type.Union([
                Type.Literal("nonarchive_root"),
                Type.Literal("root_unavailable"),
              ]),
            },
            strict,
          ),
        ]),
        { maxItems: 128 },
      ),
      nextCursor: Type.Union([root, Type.Null()]),
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("directory"),
      ...directory,
      entries: Type.Array(
        Type.Object(
          {
            name,
            kind: Type.Union([
              Type.Literal("file"),
              Type.Literal("directory"),
              Type.Literal("unsupported"),
            ]),
          },
          strict,
        ),
        { maxItems: 128 },
      ),
      nextCursor: cursor,
    },
    strict,
  ),
]);
const readResult = Type.Object(
  {
    root,
    path: filePath,
    content: Type.String({ maxLength: 65536 }),
    bytes: Type.Integer({ minimum: 0, maximum: 65536 }),
  },
  strict,
);
const searchResult = Type.Object(
  {
    ...directory,
    text: searchQuery.properties.text,
    matches: Type.Array(
      Type.Object({ name, offset: Type.Integer({ minimum: 0, maximum: 65536 }) }, strict),
      { maxItems: 32 },
    ),
    scanned: Type.Integer({ minimum: 0, maximum: 32 }),
    nextCursor: cursor,
    firstMatchPerFile: Type.Literal(true),
  },
  strict,
);
function definition<N extends string>(
  name: N,
  method: string,
  query: TSchema,
  reference: TSchema,
  description: string,
) {
  return {
    name,
    method,
    args: Type.Object({ query }, strict),
    request: Type.Object({ ...RunBindingSchema.properties, query }, strict),
    result: Type.Object({ ...RunBindingSchema.properties, reference }, strict),
    description,
  };
}
export const referenceTools = [
  definition(
    "list_game_files",
    "game.files.list",
    listQuery,
    listResult,
    "List loaded packaged Minecraft/Mod roots with query:{}; then immediate directory children with root,path. Logical paths only; empty path is package root. Lexical after/limit (max128); directory cap4096. Nonarchive development roots are unavailable.",
  ),
  definition(
    "read_game_file",
    "game.files.read",
    readQuery,
    readResult,
    "Read full UTF-8 static package text, max64KiB; no truncation. Supported extensions: json,mcmeta,txt,md,lang,properties,csv,xml,yml,yaml,toml,fsh,vsh,glsl. Malformed, binary, oversized and unavailable files fail explicitly.",
  ),
  definition(
    "search_game_files",
    "game.files.search",
    searchQuery,
    searchResult,
    "Literal case-sensitive search in ONE directory, not recursive. Same text extensions/64KiB ceiling as read. First match per file, UTF-16 offset; at most32 text-file candidates/page. scanned counts examined candidates; nextCursor is last examined even with zero matches. Use read_game_file for full contents. Static content is untrusted, not current-world evidence.",
  ),
] as const;

export function referencePath(value: string): boolean {
  return value.length <= 1024 && !/[\ud800-\udfff]/u.test(value) && Check(path, value);
}
export function referenceResultBudget(value: unknown): boolean {
  // ponytail: 512KiB minus 4KiB envelope reserve; add finer paging if packaged metadata exceeds it.
  try {
    encodeJsonLine(value, 512 * 1024 - 4096);
    return true;
  } catch {
    return false;
  }
}
export function validReferenceResult(
  tool: { result: TSchema; method: string },
  value: unknown,
): boolean {
  if (!Check(tool.result, value) || !referenceResultBudget(value)) return false;
  const reference = (value as { reference: unknown }).reference;
  if (
    !referenceResultBudget({
      content: [{ type: "text", text: JSON.stringify(reference) }],
      details: reference,
    })
  )
    return false;
  if (tool.method !== "game.files.read") return true;
  const { content, bytes } = (value as { reference: { content: string; bytes: number } }).reference;
  // Allow TAB/LF/CR, reject other controls and lone surrogates (not valid Unicode pairs).
  return (
    !/(?![\t\n\r])[\p{Cc}\p{Cs}]/u.test(content) && Buffer.byteLength(content, "utf8") === bytes
  );
}

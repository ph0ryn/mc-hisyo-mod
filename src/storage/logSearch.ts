import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import { maxPiFrameBytes } from "../pi/piFraming.js";
import { defaultMaxFrameBytes } from "../transport/jsonLines.js";
import { validateScope, type WorldScope } from "../protocol/gameEvent.js";
import type { EventCatalog, EventFilter } from "../events/eventCatalog.js";

// Page JSON has no raw controls: Pi's escaped content costs <=2x, plus details <=1x.
// ponytail: wrappers/call metadata get 4096 bytes; measure envelopes if they grow.
export const eventPageBytes = Math.min(
  defaultMaxFrameBytes - 4096,
  Math.floor((maxPiFrameBytes - 4096) / 3),
);

export interface EventSearch {
  event?: string;
  filter?: EventFilter;
  since?: number;
  after?: number | undefined;
  through?: number;
  limit?: number;
}

export interface LogPage<Entry> {
  events: Entry[];
  through: number;
  /** Scope-wide gaps up to through, independent of filters, time, and page size. */
  hasKnownGaps: boolean;
  nextCursor?: number;
}

function validateCounter(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
}

// SQL identifiers come only from this fixed configuration, never search input.
const logStorage = {
  events: { timestamp: "observed_at", payload: "observation_json", hasGaps: true },
  activities: { timestamp: "recorded_at", payload: "activity_json", hasGaps: false },
} as const;

/** Pagination IDs and high-water belong exclusively to the supplied database. */
export function searchLog<Entry extends { id: number }>(
  db: DatabaseSync,
  catalog: EventCatalog,
  table: keyof typeof logStorage,
  scope: WorldScope,
  options: EventSearch,
  decode: (row: Record<string, SQLOutputValue>) => Entry,
): LogPage<Entry> {
  validateScope(scope);
  const storage = logStorage[table];
  const { limit = 100, after = 0 } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error("Invalid limit: expected 1..500");
  validateCounter("after cursor", after);
  if (options.filter !== undefined && options.event === undefined)
    throw new Error("A filter requires an event");
  if (options.event !== undefined) catalog.validateFilter(options.event, options.filter ?? {});
  const max = db
    .prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM ${table} WHERE world_id = ? AND player_id = ?`)
    .get(scope.worldId, scope.playerId)?.id;
  if (typeof max !== "number") throw new Error("Invalid stored log cursor");
  const through = options.through ?? max;
  validateCounter("through cursor", through);
  const clauses = ["world_id = ?", "player_id = ?", "id > ?", "id <= ?"];
  const params: SQLInputValue[] = [scope.worldId, scope.playerId, after, through];
  if (options.since !== undefined) {
    validateCounter("since timestamp", options.since);
    clauses.push(`${storage.timestamp} >= ?`);
    params.push(options.since);
  }
  if (options.event !== undefined) {
    clauses.push("event = ?");
    params.push(options.event);
  }
  for (const [field, value] of Object.entries(options.filter ?? {})) {
    const path = `$.data.${JSON.stringify(field)}`;
    const jsonTypes =
      value === null
        ? ["null"]
        : typeof value === "boolean"
          ? [String(value)]
          : typeof value === "number"
            ? ["integer", "real"]
            : ["text"];
    clauses.push(
      `json_type(${storage.payload}, ?) IN (${jsonTypes.map(() => "?").join(", ")}) AND json_extract(${storage.payload}, ?) IS ?`,
    );
    params.push(path, ...jsonTypes, path, typeof value === "boolean" ? Number(value) : value);
  }
  const rows = db
    .prepare(`SELECT * FROM ${table} WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`)
    .all(...params, limit + 1);
  const gap = storage.hasGaps
    ? db
        .prepare(
          `SELECT EXISTS(SELECT 1 FROM events WHERE world_id = ? AND player_id = ? AND id <= ? AND gap_from IS NOT NULL) AS found`,
        )
        .get(scope.worldId, scope.playerId, through)?.found
    : 0;
  if (gap !== 0 && gap !== 1) throw new Error("Invalid stored event gap metadata");
  const events: Entry[] = [];
  let bytes = Buffer.byteLength(
    JSON.stringify({
      events: [],
      through,
      hasKnownGaps: gap === 1,
      nextCursor: Number.MAX_SAFE_INTEGER,
    }),
  );
  for (const row of rows.slice(0, limit)) {
    const entry = decode(row);
    const size = Buffer.byteLength(JSON.stringify(entry)) + (events.length ? 1 : 0);
    if (bytes + size > eventPageBytes) {
      if (!events.length) throw new Error("Stored entry exceeds log page byte budget");
      break;
    }
    bytes += size;
    events.push(entry);
  }
  const result = { events, through, hasKnownGaps: gap === 1 };
  return rows.length > events.length ? { ...result, nextCursor: events.at(-1)!.id } : result;
}

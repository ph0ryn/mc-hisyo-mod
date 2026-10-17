import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import { maxPiFrameBytes } from "../pi/piFraming.js";
import { defaultMaxFrameBytes } from "../transport/jsonLines.js";
import { validateScope, type GameEvent, type WorldScope } from "../protocol/gameEvent.js";
import { EventCatalog, type EventFilter } from "./eventCatalog.js";
import {
  directorActivityCatalog,
  isDirectorActivity,
  validateDirectorActivity,
  type DirectorActivity,
} from "./directorActivity.js";

// Page JSON has no raw controls: Pi's escaped content costs <=2x, plus details <=1x.
// ponytail: wrappers/call metadata get 4096 bytes; measure envelopes if they grow.
export const eventPageBytes = Math.min(
  defaultMaxFrameBytes - 4096,
  Math.floor((maxPiFrameBytes - 4096) / 3),
);
export type StoredHistory = StoredEvent | { id: number; observation: DirectorActivity };

export interface StoredEvent {
  id: number;
  observation: GameEvent;
  missingSequencesBefore?: { from: number; to: number };
}

export interface EventSearch {
  event?: string;
  filter?: EventFilter;
  since?: number;
  after?: number | undefined;
  through?: number;
  limit?: number;
}

function decodeRow(row: Record<string, SQLOutputValue>, catalog: EventCatalog): StoredHistory {
  if (
    typeof row.id !== "number" ||
    !Number.isSafeInteger(row.id) ||
    row.id < 1 ||
    typeof row.observation_json !== "string"
  )
    throw new Error("Invalid stored event");
  const observation: unknown = JSON.parse(row.observation_json);
  if (row.seq === null) validateDirectorActivity(observation);
  else catalog.validateObservation(observation);
  const value = observation as GameEvent | DirectorActivity;
  if (
    row.world_id !== value.worldId ||
    row.player_id !== value.playerId ||
    row.session_id !== value.worldSessionId ||
    row.event !== value.event ||
    row.observed_at !== value.observedAt ||
    ("seq" in value && row.seq !== value.seq)
  )
    throw new Error("Invalid stored event metadata");
  if (row.gap_from === null && row.gap_to === null)
    return { id: row.id, observation: value } as StoredHistory;
  if (
    !("seq" in value) ||
    typeof row.gap_from !== "number" ||
    typeof row.gap_to !== "number" ||
    !Number.isSafeInteger(row.gap_from) ||
    !Number.isSafeInteger(row.gap_to) ||
    row.gap_from < 1 ||
    row.gap_to < row.gap_from ||
    row.gap_to !== value.seq - 1
  )
    throw new Error("Invalid stored event gap metadata");
  return {
    id: row.id,
    observation: value,
    missingSequencesBefore: { from: row.gap_from, to: row.gap_to },
  };
}

function validateCounter(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
}

export class EventLog {
  constructor(
    readonly db: DatabaseSync,
    readonly catalog: EventCatalog,
  ) {}

  /** The hook store and this log share this SQLite transaction; no unrecorded mutation ACK. */
  atomic<T>(mutate: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = mutate();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "History transaction and rollback failed");
      }
      throw error;
    }
  }

  appendActivity(observation: DirectorActivity): { id: number; observation: DirectorActivity } {
    validateDirectorActivity(observation);
    if (
      Buffer.byteLength(
        JSON.stringify({
          events: [{ id: Number.MAX_SAFE_INTEGER, observation }],
          through: Number.MAX_SAFE_INTEGER,
          hasKnownGaps: false,
          nextCursor: Number.MAX_SAFE_INTEGER,
        }),
      ) > eventPageBytes
    )
      throw new Error("Director activity exceeds history page byte budget");
    const id = this.#insert(observation, null);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid stored event cursor");
    return { id, observation: structuredClone(observation) };
  }

  appendActivities(observations: readonly DirectorActivity[]): void {
    if (!observations.length) return;
    this.atomic(() => {
      for (const observation of observations) this.appendActivity(observation);
    });
  }

  /** Persist first. A returned gap is evidence of missing observations, never inferred events. */
  append(observation: GameEvent): StoredEvent {
    this.catalog.validateObservation(observation);
    const { worldId, playerId, worldSessionId, seq } = observation;
    const last = this.db
      .prepare(`
      SELECT COALESCE(MAX(seq), 0) AS seq FROM events
      WHERE world_id = ? AND player_id = ? AND session_id = ?
    `)
      .get(worldId, playerId, worldSessionId)?.seq;
    if (typeof last !== "number") throw new Error("Invalid stored event sequence");
    if (seq <= last) throw new Error(`Invalid event sequence: received ${seq}, last ${last}`);
    const gapFrom = seq > last + 1 ? last + 1 : null;
    const gapTo = gapFrom === null ? null : seq - 1;
    const entry: StoredEvent = {
      id: this.#insert(observation, seq, gapFrom, gapTo),
      observation: structuredClone(observation),
    };
    if (gapFrom !== null && gapTo !== null)
      entry.missingSequencesBefore = { from: gapFrom, to: gapTo };
    return entry;
  }

  #insert(
    observation: GameEvent | DirectorActivity,
    seq: number | null,
    gapFrom: number | null = null,
    gapTo: number | null = null,
  ): number {
    const result = this.db
      .prepare(`
      INSERT INTO events(world_id, player_id, session_id, seq, event, observed_at, observation_json, gap_from, gap_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        observation.worldId,
        observation.playerId,
        observation.worldSessionId,
        seq,
        observation.event,
        observation.observedAt,
        JSON.stringify(observation),
        gapFrom,
        gapTo,
      );
    return Number(result.lastInsertRowid);
  }

  search(
    scope: WorldScope,
    options: EventSearch = {},
  ): {
    events: StoredHistory[];
    through: number;
    /** Scope-wide gaps up to through, independent of filters, time, and page size. */
    hasKnownGaps: boolean;
    nextCursor?: number;
  } {
    validateScope(scope);
    const { limit = 100, after = 0 } = options;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error("Invalid limit: expected 1..500");
    validateCounter("after cursor", after);
    if (options.filter !== undefined && options.event === undefined)
      throw new Error("A filter requires an event");
    if (options.event !== undefined)
      (isDirectorActivity(options.event) ? directorActivityCatalog : this.catalog).validateFilter(
        options.event,
        options.filter ?? {},
      );
    const max = this.db
      .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE world_id = ? AND player_id = ?")
      .get(scope.worldId, scope.playerId)?.id;
    if (typeof max !== "number") throw new Error("Invalid stored event cursor");
    const through = options.through ?? max;
    validateCounter("through cursor", through);
    const clauses = ["world_id = ?", "player_id = ?", "id > ?", "id <= ?"];
    const params: SQLInputValue[] = [scope.worldId, scope.playerId, after, through];
    if (options.since !== undefined) {
      validateCounter("since timestamp", options.since);
      clauses.push("observed_at >= ?");
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
        `json_type(observation_json, ?) IN (${jsonTypes.map(() => "?").join(", ")}) AND json_extract(observation_json, ?) IS ?`,
      );
      params.push(path, ...jsonTypes, path, typeof value === "boolean" ? Number(value) : value);
    }
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`)
      .all(...params, limit + 1);
    const gap = this.db
      .prepare(`
      SELECT EXISTS(SELECT 1 FROM events WHERE world_id = ? AND player_id = ? AND id <= ? AND gap_from IS NOT NULL) AS found
    `)
      .get(scope.worldId, scope.playerId, through)?.found;
    if (gap !== 0 && gap !== 1) throw new Error("Invalid stored event gap metadata");
    const events: StoredHistory[] = [];
    let bytes = Buffer.byteLength(
      JSON.stringify({
        events: [],
        through,
        hasKnownGaps: gap === 1,
        nextCursor: Number.MAX_SAFE_INTEGER,
      }),
    );
    for (const row of rows.slice(0, limit)) {
      const entry = decodeRow(row, this.catalog);
      const size = Buffer.byteLength(JSON.stringify(entry)) + (events.length ? 1 : 0);
      if (bytes + size > eventPageBytes) {
        if (!events.length) throw new Error("Stored event exceeds history page byte budget");
        break;
      }
      bytes += size;
      events.push(entry);
    }
    const result = { events, through, hasKnownGaps: gap === 1 };
    return rows.length > events.length ? { ...result, nextCursor: events.at(-1)!.id } : result;
  }
}

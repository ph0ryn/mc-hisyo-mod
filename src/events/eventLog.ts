import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import { validateScope, type GameEvent, type WorldScope } from "../protocol/gameEvent.js";
import { EventCatalog, type EventFilter } from "./eventCatalog.js";

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

function decodeRow(row: Record<string, SQLOutputValue>): StoredEvent {
  if (typeof row.id !== "number" || typeof row.observation_json !== "string") {
    throw new Error("Invalid stored event");
  }
  const entry: StoredEvent = {
    id: row.id,
    observation: JSON.parse(row.observation_json) as GameEvent,
  };
  if (typeof row.gap_from === "number" && typeof row.gap_to === "number") {
    entry.missingSequencesBefore = { from: row.gap_from, to: row.gap_to };
  }
  return entry;
}

function validateCounter(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
}

export class EventLog {
  constructor(
    readonly db: DatabaseSync,
    readonly catalog: EventCatalog,
  ) {}

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
    const result = this.db
      .prepare(`
      INSERT INTO events(world_id, player_id, session_id, seq, event, observed_at, observation_json, gap_from, gap_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        worldId,
        playerId,
        worldSessionId,
        seq,
        observation.event,
        observation.observedAt,
        JSON.stringify(observation),
        gapFrom,
        gapTo,
      );
    const entry: StoredEvent = {
      id: Number(result.lastInsertRowid),
      observation: structuredClone(observation),
    };
    if (gapFrom !== null && gapTo !== null)
      entry.missingSequencesBefore = { from: gapFrom, to: gapTo };
    return entry;
  }

  search(
    scope: WorldScope,
    options: EventSearch = {},
  ): {
    events: StoredEvent[];
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
      this.catalog.validateFilter(options.event, options.filter ?? {});
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
    const events = rows.slice(0, limit).map(decodeRow);
    const nextCursor = rows.length > limit ? events.at(-1)?.id : undefined;
    const gap = this.db
      .prepare(`
      SELECT EXISTS(SELECT 1 FROM events WHERE world_id = ? AND player_id = ? AND id <= ? AND gap_from IS NOT NULL) AS found
    `)
      .get(scope.worldId, scope.playerId, through)?.found;
    if (typeof gap !== "number") throw new Error("Invalid stored event gap metadata");
    const result = { events, through, hasKnownGaps: gap === 1 };
    return nextCursor === undefined ? result : { ...result, nextCursor };
  }
}

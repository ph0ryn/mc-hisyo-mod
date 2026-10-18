import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { GameEvent, WorldScope } from "../protocol/gameEvent.js";
import type { EventCatalog } from "./eventCatalog.js";
import { searchHistory, type EventSearch, type HistoryPage } from "./historySearch.js";

export { eventPageBytes, type EventSearch } from "./historySearch.js";

export interface StoredEvent {
  id: number;
  observation: GameEvent;
  missingSequencesBefore?: { from: number; to: number };
}

function decodeRow(row: Record<string, SQLOutputValue>, catalog: EventCatalog): StoredEvent {
  if (
    typeof row.id !== "number" ||
    !Number.isSafeInteger(row.id) ||
    row.id < 1 ||
    typeof row.observation_json !== "string"
  )
    throw new Error("Invalid stored event");
  const observation: unknown = JSON.parse(row.observation_json);
  catalog.validateObservation(observation);
  if (
    row.world_id !== observation.worldId ||
    row.player_id !== observation.playerId ||
    row.session_id !== observation.worldSessionId ||
    row.event !== observation.event ||
    row.observed_at !== observation.observedAt ||
    row.seq !== observation.seq
  )
    throw new Error("Invalid stored event metadata");
  if (observation.event === "nearby_sampled" && observation.data.visibility !== "unobstructed") {
    // Legacy samples included buried blocks and wall-hidden entities. Keep the stored row intact.
    observation.data = {
      ...observation.data,
      blocks: [],
      blocksComplete: false,
      entities: [],
      entitiesTruncated: true,
    };
  }
  if (row.gap_from === null && row.gap_to === null) return { id: row.id, observation };
  if (
    typeof row.gap_from !== "number" ||
    typeof row.gap_to !== "number" ||
    !Number.isSafeInteger(row.gap_from) ||
    !Number.isSafeInteger(row.gap_to) ||
    row.gap_from < 1 ||
    row.gap_to < row.gap_from ||
    row.gap_to !== observation.seq - 1
  )
    throw new Error("Invalid stored event gap metadata");
  return {
    id: row.id,
    observation,
    missingSequencesBefore: { from: row.gap_from, to: row.gap_to },
  };
}

/** Only validated Mod observations enter raw history and its sequence namespace. */
export class EventLog {
  constructor(
    readonly db: DatabaseSync,
    readonly catalog: EventCatalog,
  ) {}

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

  /** Persist first. A returned gap is evidence of missing observations, never inferred events. */
  append(observation: GameEvent): StoredEvent {
    this.catalog.validateObservation(observation);
    if (observation.event === "nearby_sampled" && observation.data.visibility !== "unobstructed")
      throw new Error("nearby_sampled requires unobstructed visibility; update the Mod");
    const { worldId, playerId, worldSessionId, seq } = observation;
    const last = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE world_id = ? AND player_id = ? AND session_id = ?`,
      )
      .get(worldId, playerId, worldSessionId)?.seq;
    if (typeof last !== "number") throw new Error("Invalid stored event sequence");
    if (seq <= last) throw new Error(`Invalid event sequence: received ${seq}, last ${last}`);
    const gapFrom = seq > last + 1 ? last + 1 : null;
    const gapTo = gapFrom === null ? null : seq - 1;
    const result = this.db
      .prepare(
        `INSERT INTO events(world_id, player_id, session_id, seq, event, observed_at, observation_json, gap_from, gap_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
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
    const id = Number(result.lastInsertRowid);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid stored event cursor");
    const entry: StoredEvent = { id, observation: structuredClone(observation) };
    if (gapFrom !== null && gapTo !== null)
      entry.missingSequencesBefore = { from: gapFrom, to: gapTo };
    return entry;
  }

  search(scope: WorldScope, options: EventSearch = {}): HistoryPage<StoredEvent> {
    return searchHistory(this.db, this.catalog, scope, options, (row) =>
      decodeRow(row, this.catalog),
    );
  }
}

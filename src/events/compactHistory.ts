import type { StoredEvent } from "./eventLog.js";
import { summaryInputBytes } from "../protocol/history.js";

export interface HistorySource {
  after: number;
  through: number;
  sourceSessionId: string;
  sourceCount: number;
  firstObservedAt: number;
  lastObservedAt: number;
  input: string;
}

const omittedFields = new Set([
  "sampleIntervalTicks",
  "minimumDistance",
  "elapsedTicks",
  "entityId",
  "victimId",
  "causingEntityId",
  "directEntityId",
  "containerId",
  "containerSlot",
  "menuId",
]);

function bounded(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let result = "";
  for (const char of text) {
    if (Buffer.byteLength(result + char) > bytes - 20) break;
    result += char;
  }
  return `${result}…[abbreviated]`;
}

/** Scalar text only, with explicit abbreviation; never dumps observation JSON. */
function valueText(value: unknown): string {
  if (typeof value === "string") {
    // eslint-disable-next-line no-control-regex -- Untrusted values must remain single-line text.
    return bounded(value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " "), 200);
  }
  if (value === null) return "unknown";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, 6).map(valueText);
    return `${items.join(",")}${value.length > 6 ? `,…[${value.length - 6} omitted]` : ""}`;
  }
  if (typeof value === "object" && value) {
    return Object.entries(value)
      .filter(([key]) => !omittedFields.has(key))
      .map(([key, entry]) => `${key}=${valueText(entry)}`)
      .join(" ");
  }
  throw new Error("Unsupported history value");
}

interface Projection {
  entry: StoredEvent;
  location: string;
  text: string;
  key: string;
  sampleKey?: string;
  seen: string[];
}

function typeCounts(items: readonly Record<string, unknown>[], field: string): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const id = valueText(item[field]);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return valueText(
    [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([id, count]) => `${id}×${count}`),
  );
}

function prepare(entry: StoredEvent): Projection {
  const observation = entry.observation;
  if ("origin" in observation || !Number.isSafeInteger(observation.seq) || observation.seq <= 0)
    throw new Error("History sources must contain only Mod observations");
  const { event, data, dimension } = observation;
  const location = ` @${dimension}:${valueText(observation.position)}`;
  let text: string;
  let seen: string[] = [];
  let sampleKey: string | undefined;
  if (event === "nearby_sampled") {
    const blocks = data.blocks as Record<string, unknown>[];
    const entities = data.entities as Record<string, unknown>[];
    text = `last ray-sampled blocks=${typeCounts(blocks, "blockId")} entities=${typeCounts(entities, "entityType")}${location}; not FOV/lighting/full sight, empty != absence`;
    seen = [
      ...new Set([
        ...blocks.map((block) => `block:${valueText(block.blockId)}`),
        ...entities.map((entity) => `entity:${valueText(entity.entityType)}`),
      ]),
    ];
    sampleKey = `${event}:${dimension}`;
  } else if (event === "player_location_changed") {
    text = `last sampled move=${valueText(data.beforePosition)} -> ${valueText(data.afterPosition)}${location}`;
    seen = [valueText(data.beforeBiomeId), valueText(data.afterBiomeId)];
    sampleKey = `${event}:${dimension}`;
  } else if (event === "structures_sampled") {
    text = "structure metadata sampled (not discovery; IDs/locations omitted)";
    sampleKey = `${event}:${dimension}`;
  } else if (event === "status_effects_sampled") {
    text = `last ${valueText(data)}${location}`;
    sampleKey = `${event}:${dimension}`;
  } else text = `${event} ${valueText(data)}${location}`;
  return {
    entry,
    location,
    text: bounded(text, 2_000),
    key: sampleKey ?? `${event}:${dimension}:${JSON.stringify(data)}:${location}`,
    ...(sampleKey ? { sampleKey } : {}),
    seen,
  };
}

/** Timeline uses arrival order, not timestamp order. Samples are explicitly separate aggregates. */
function project(entries: readonly Projection[]): string {
  const timeline: { projection: Projection; lastId: number; count: number }[] = [];
  const samples = new Map<
    string,
    { first: Projection; last: Projection; count: number; seen: Set<string> }
  >();
  const gaps: string[] = [];
  for (const projection of entries) {
    const entry = projection.entry;
    if ("missingSequencesBefore" in entry && entry.missingSequencesBefore)
      gaps.push(
        `e${entry.id}: missing seq ${entry.missingSequencesBefore.from}..${entry.missingSequencesBefore.to}`,
      );
    if (projection.sampleKey) {
      const prior = samples.get(projection.sampleKey);
      if (prior) {
        prior.last = projection;
        prior.count++;
        for (const id of projection.seen) prior.seen.add(id);
      } else
        samples.set(projection.sampleKey, {
          first: projection,
          last: projection,
          count: 1,
          seen: new Set(projection.seen),
        });
    } else {
      const prior = timeline.at(-1);
      if (prior?.projection.key === projection.key) {
        prior.count++;
        prior.lastId = entry.id;
      } else timeline.push({ projection, lastId: entry.id, count: 1 });
    }
  }
  return [
    ...gaps,
    ...timeline.map(
      ({ projection, lastId, count }) =>
        `e${projection.entry.id}${count > 1 ? `..e${lastId} [${count} identical observations]` : ""} ${projection.text}`,
    ),
    ...[...samples].map(([kind, { first, last, count, seen }]) => {
      const start =
        first.entry.observation.event === "player_location_changed"
          ? `first sampled position=${valueText(first.entry.observation.data.beforePosition)}; biomes=`
          : "seen types=";
      return `${kind} [${count} samples, e${first.entry.id}..e${last.entry.id}, not full chronology/path] ${seen.size ? `${start}${valueText([...seen])}; ` : ""}${last.text}`;
    }),
  ].join("\n");
}

/** A whole-row prefix of one source session. A high-water fence is NOT the consumed cursor. */
export function compactHistory(
  after: number,
  entries: readonly StoredEvent[],
): HistorySource | undefined {
  if (!entries.length) return;
  const first = entries[0]!;
  const included: Projection[] = [];
  let input = "";
  let previous = after;
  let minTime = Infinity;
  let maxTime = 0;
  for (const entry of entries) {
    if (entry.id <= previous) throw new Error("History sources are not in cursor order");
    if (entry.observation.worldSessionId !== first.observation.worldSessionId) break;
    const projection = prepare(entry);
    const candidate = [...included, projection];
    const from = Math.min(minTime, entry.observation.observedAt);
    const to = Math.max(maxTime, entry.observation.observedAt);
    const header = `Observed history; arrival order, grouped/abbreviated.\nSource session: ${valueText(first.observation.worldSessionId)}\nObserved ms range: ${from}..${to}\n`;
    const text = header + project(candidate);
    if (Buffer.byteLength(text) > summaryInputBytes) {
      if (!included.length) throw new Error("History source exceeds summary input budget");
      break;
    }
    included.push(projection);
    input = text;
    previous = entry.id;
    minTime = from;
    maxTime = to;
  }
  return {
    after,
    through: included.at(-1)!.entry.id,
    sourceSessionId: first.observation.worldSessionId,
    sourceCount: included.length,
    firstObservedAt: minTime,
    lastObservedAt: maxTime,
    input,
  };
}

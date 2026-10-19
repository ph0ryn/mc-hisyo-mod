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
  "entityPosition",
  "victimId",
  "causingEntityId",
  "directEntityId",
  "containerId",
  "containerSlot",
  "menuId",
  "hand",
  "remainingCount",
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
function valueText(value: unknown, field = ""): string {
  if (typeof value === "string") {
    // eslint-disable-next-line no-control-regex -- Untrusted values must remain single-line text.
    const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
    return bounded(text.replace(/^minecraft:(?=[a-z0-9/._-]+$)/u, ""), 200);
  }
  if (value === null) return "unknown";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (field === "position" || field.endsWith("Position"))
      return (value as number[])
        .map((coordinate) => String(Math.round(coordinate * 10) / 10))
        .join(",");
    const items = value.slice(0, 6).map((item) => valueText(item));
    return `${items.join(",")}${value.length > 6 ? `,…[${value.length - 6} omitted]` : ""}`;
  }
  if (typeof value === "object" && value) {
    const fields = value as Record<string, unknown>;
    return Object.entries(fields)
      .filter(([key]) => !omittedFields.has(key))
      .flatMap(([key, entry]) => {
        const after = key.replace(/^before(?=[A-Z])/u, "after");
        if (after !== key && Object.hasOwn(fields, after)) {
          const name = key[6]!.toLowerCase() + key.slice(7);
          const beforeText = valueText(entry, key);
          return [
            `${name}=${beforeText}${entry === fields[after] ? "" : `->${valueText(fields[after], after)}`}`,
          ];
        }
        const before = key.replace(/^after(?=[A-Z])/u, "before");
        return before !== key && Object.hasOwn(fields, before)
          ? []
          : [`${key}=${valueText(entry, key)}`];
      })
      .join(" ");
  }
  throw new Error("Unsupported history value");
}

interface Projection {
  entry: StoredEvent;
  localId: number;
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

function prepare(entry: StoredEvent, localId: number): Projection {
  const observation = entry.observation;
  if ("origin" in observation || !Number.isSafeInteger(observation.seq) || observation.seq <= 0)
    throw new Error("History sources must contain only Mod observations");
  const { event, data, dimension } = observation;
  const location = ` @${valueText(dimension)}:${valueText(observation.position, "position")}`;
  let text: string;
  let seen: string[] = [];
  let sampleKey: string | undefined;
  if (event === "nearby_sampled") {
    const blocks = data.blocks as Record<string, unknown>[];
    const entities = data.entities as Record<string, unknown>[];
    text = `last ray-sampled blocks=${typeCounts(blocks, "blockId")} entities=${typeCounts(entities, "entityType")}${location}`;
    seen = [
      ...new Set([
        ...blocks.map((block) => `block:${valueText(block.blockId)}`),
        ...entities.map((entity) => `entity:${valueText(entity.entityType)}`),
      ]),
    ];
    sampleKey = `${event}:${dimension}`;
  } else if (event === "player_location_changed") {
    text = `last sampled move=${valueText(data.beforePosition, "beforePosition")} -> ${valueText(data.afterPosition, "afterPosition")}${location}`;
    seen = [valueText(data.beforeBiomeId), valueText(data.afterBiomeId)];
    sampleKey = `${event}:${dimension}`;
  } else if (event === "status_effects_sampled") {
    text = `last ${valueText(data)}${location}`;
    sampleKey = `${event}:${dimension}`;
  } else if (event === "container_opened") {
    text = `${event} menuType=${valueText(data.menuType)}${location}`;
  } else {
    const fields = { ...data };
    if (event === "item_picked_up" && fields.infiniteMaterials === false)
      delete fields.infiniteMaterials;
    text = `${event} ${valueText(fields)}${location}`;
  }
  return {
    entry,
    localId,
    location,
    text: bounded(text, 2_000),
    // Display rounding/omission must never broaden observation identity.
    key:
      sampleKey ??
      `${event}:${dimension}:${JSON.stringify(data)}:${JSON.stringify(observation.position)}`,
    ...(sampleKey ? { sampleKey } : {}),
    seen,
  };
}

// Minecraft 1.21.11 Inventory.EQUIPMENT_SLOT_MAPPING; main hand is a selected hotbar slot.
const equipmentSlots = new Map<string, number>([
  ["feet", 36],
  ["legs", 37],
  ["chest", 38],
  ["head", 39],
  ["offHand", 40],
  ["body", 41],
  ["saddle", 42],
]);

function sameStackChange(a: Projection, b: Projection): boolean {
  return ["beforeItemId", "beforeCount", "afterItemId", "afterCount"].every(
    (field) => a.entry.observation.data[field] === b.entry.observation.data[field],
  );
}

/** Coalesce views of a physical stack change, not repeated actions or selected-slot changes. */
function stackMirrors(entries: readonly Projection[]) {
  const omitted = new Set<Projection>();
  const equipped = new Map<Projection, string>();
  const containers = new Map<number, Projection>();
  const snapshots = new Map<string, Projection>();
  let previousScope: string | undefined;
  for (const projection of entries) {
    const { entry } = projection;
    const { event, data, worldId, playerId, worldSessionId, dimension, tick, observedAt } =
      entry.observation;
    const scope = JSON.stringify([worldId, playerId, worldSessionId, dimension, tick]);
    if (
      scope !== previousScope ||
      entry.missingSequencesBefore ||
      event === "container_opened" ||
      event === "container_closed"
    ) {
      containers.clear();
      snapshots.clear();
    }
    previousScope = scope;
    if (event === "container_slot_changed" && data.playerInventory === true) {
      // Independent broadcast baseline: only the nearest preceding transition is eligible.
      containers.set(data.containerSlot as number, projection);
    } else if (event === "inventory_slot_changed") {
      const slot = data.slot as number;
      const prior = containers.get(slot);
      containers.delete(slot);
      if (prior && sameStackChange(prior, projection)) omitted.add(prior);
      snapshots.set(`${observedAt}:${slot}`, projection);
    } else if (event === "equipment_slot_changed" || event === "held_item_changed") {
      let slot: number | undefined;
      let equipment: string;
      if (event === "equipment_slot_changed") {
        equipment = data.slot as string;
        slot = equipmentSlots.get(equipment);
      } else if (data.hand === "off_hand") {
        equipment = "offHand";
        slot = 40;
      } else {
        if (typeof data.beforeSlot !== "number" || data.beforeSlot !== data.afterSlot) continue;
        equipment = "mainHand";
        slot = data.beforeSlot;
      }
      if (slot === undefined) continue;
      const key = `${observedAt}:${slot}`;
      const prior = snapshots.get(key);
      if (prior && prior.entry.observation.event !== event && sameStackChange(prior, projection)) {
        omitted.add(projection);
        if (prior.entry.observation.event === "inventory_slot_changed")
          equipped.set(prior, equipment);
      } else if (event === "equipment_slot_changed") snapshots.set(key, projection);
    }
  }
  return { omitted, equipped };
}

function timelineText(projection: Projection, lastId: number, count: number): string {
  const range = `e${projection.localId}${count > 1 ? `..e${lastId}` : ""}`;
  const { event, data } = projection.entry.observation;
  if (count > 1 && (event === "grid_result_taken" || event === "furnace_result_taken")) {
    const { count: quantity, ...context } = data;
    const total = BigInt(quantity as number) * BigInt(count);
    return `${range} ${event} ${valueText(context)} totalTaken=${total} creditedTakeEvents=${count}${projection.location}`;
  }
  return `${range}${count > 1 ? ` [${count} identical observations]` : ""} ${projection.text}`;
}

function omitObservation({ event, data }: StoredEvent["observation"]): boolean {
  return (
    event === "structures_sampled" ||
    (event === "status_effects_sampled" &&
      (data.effects as unknown[]).length === 0 &&
      data.effectsTruncated === false) ||
    ((event === "advancement_criterion_granted" || event === "advancement_completed") &&
      (data.advancementId as string).startsWith("minecraft:recipes/")) ||
    (event === "advancement_criterion_granted" && data.afterDone === true)
  );
}

/** Timeline uses arrival order, not timestamp order. Samples are explicitly separate aggregates. */
function project(entries: readonly Projection[]): string {
  const timeline: { projection: Projection; lastId: number; count: number }[] = [];
  const samples = new Map<
    string,
    { first: Projection; last: Projection; count: number; seen: Set<string> }
  >();
  const gaps: string[] = [];
  const { omitted, equipped } = stackMirrors(entries);
  let separate = false;
  for (const original of entries) {
    const entry = original.entry;
    if (entry.missingSequencesBefore) {
      gaps.push(
        `e${original.localId}: missing seq ${entry.missingSequencesBefore.from}..${entry.missingSequencesBefore.to}`,
      );
      separate = true;
    }
    if (omitted.has(original) || omitObservation(entry.observation)) continue;
    const equipment = equipped.get(original);
    const projection =
      equipment && equipment !== "mainHand" && equipment !== "offHand"
        ? {
            ...original,
            text: `${original.text} equipped=${equipment}`,
            key: `${original.key}:equipped=${equipment}`,
          }
        : original;
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
      const prior = separate ? undefined : timeline.at(-1);
      if (prior?.projection.key === projection.key) {
        prior.count++;
        prior.lastId = projection.localId;
      } else timeline.push({ projection, lastId: projection.localId, count: 1 });
      separate = false;
    }
  }
  return [
    ...gaps,
    ...timeline.map(({ projection, lastId, count }) => timelineText(projection, lastId, count)),
    ...[...samples.values()].map(({ first, last, count, seen }) => {
      const { event, dimension } = last.entry.observation;
      const start =
        first.entry.observation.event === "player_location_changed"
          ? `first sampled position=${valueText(first.entry.observation.data.beforePosition, "beforePosition")}; biomes=`
          : "seen types=";
      return `${event}:${valueText(dimension)} [${count} samples, e${first.localId}..e${last.localId}, not full chronology/path] ${seen.size ? `${start}${valueText([...seen])}; ` : ""}${last.text}`;
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
    // Input-local source-row labels; real IDs remain in cursor metadata.
    const projection = prepare(entry, included.length + 1);
    const candidate = [...included, projection];
    const from = Math.min(minTime, entry.observation.observedAt);
    const to = Math.max(maxTime, entry.observation.observedAt);
    const header =
      "Observed history; arrival order, grouped/abbreviated.\nDefault ID namespace: minecraft.\n";
    const text = header + (project(candidate) || "No retained observations.");
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

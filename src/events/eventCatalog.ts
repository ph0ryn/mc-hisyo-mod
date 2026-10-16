import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { GameEventSchema, type EventDefinition, type GameEvent } from "../protocol/gameEvent.js";

export const EventFilterSchema = Type.Record(
  Type.String(),
  Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
);
export type EventFilter = Readonly<Static<typeof EventFilterSchema>>;

function isScalarSchema(schema: TSchema): boolean {
  if (
    "type" in schema &&
    ["string", "number", "integer", "boolean", "null"].includes(String(schema.type))
  )
    return true;
  return "anyOf" in schema && Array.isArray(schema.anyOf) && schema.anyOf.every(isScalarSchema);
}

export class EventCatalog {
  readonly #definitions = new Map<string, EventDefinition>();

  constructor(definitions: readonly EventDefinition[]) {
    for (const definition of definitions) {
      if (!Check(GameEventSchema.properties.event, definition.name))
        throw new Error("Invalid event name");
      if (this.#definitions.has(definition.name))
        throw new Error(`Duplicate event: ${definition.name}`);
      for (const field of definition.filterFields) {
        const schema = definition.dataSchema.properties[field];
        if (
          !Object.hasOwn(definition.dataSchema.properties, field) ||
          !schema ||
          !isScalarSchema(schema)
        ) {
          throw new Error(`Invalid scalar filter field ${field} in event ${definition.name}`);
        }
      }
      this.#definitions.set(definition.name, definition);
    }
  }

  list(): readonly EventDefinition[] {
    return [...this.#definitions.values()];
  }

  get(name: string): EventDefinition {
    const definition = this.#definitions.get(name);
    if (!definition) throw new Error(`Unsupported event: ${name}`);
    return definition;
  }

  validateObservation(value: unknown): asserts value is GameEvent {
    if (!Check(GameEventSchema, value)) throw new Error("Invalid event observation");
    if (!Check(this.get(value.event).dataSchema, value.data)) {
      throw new Error(`Invalid data for event: ${value.event}`);
    }
  }

  validateFilter(event: string, filter: EventFilter): void {
    const definition = this.get(event);
    if (!Check(EventFilterSchema, filter)) throw new Error("Invalid event filter");
    for (const [field, value] of Object.entries(filter)) {
      const schema = definition.dataSchema.properties[field];
      if (!definition.filterFields.includes(field) || !schema || !Check(schema, value)) {
        throw new Error(`Invalid filter field or value: ${field} for ${event}`);
      }
    }
  }
}

export function matchesFilter(
  data: Readonly<Record<string, unknown>>,
  filter: EventFilter,
): boolean {
  return Object.entries(filter).every(
    ([field, value]) => Object.hasOwn(data, field) && data[field] === value,
  );
}

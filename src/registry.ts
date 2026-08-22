import Realm from "realm";
import type { Schema } from "./Schema";
import type { ModelClass } from "./Model";

export interface RegistryEntry {
  schema: Schema<any>;
  realmObjectSchema: Realm.ObjectSchema;
  modelClass?: ModelClass<any>;
}

const registry = new Map<string, RegistryEntry>();

// Embedded (nested) sub-document schemas, keyed by their generated name
// (e.g. "User_address"). Not top-level models — no CRUD, no CRUD registry
// entry, but Realm.open() still needs them in its schema array.
const embeddedRegistry = new Map<string, Realm.ObjectSchema>();

export function registerSchema(name: string, schema: Schema<any>, realmObjectSchema: Realm.ObjectSchema): void {
  const existing = registry.get(name);
  registry.set(name, { schema, realmObjectSchema, modelClass: existing?.modelClass });
}

export function registerModelClass(name: string, modelClass: ModelClass<any>): void {
  const existing = registry.get(name);
  if (existing) {
    existing.modelClass = modelClass;
  } else {
    registry.set(name, { schema: undefined as any, realmObjectSchema: undefined as any, modelClass });
  }
}

export function registerEmbeddedSchemas(schemas: Realm.ObjectSchema[]): void {
  for (const schema of schemas) {
    embeddedRegistry.set(schema.name, schema);
  }
}

export function getRegisteredSchema(name: string): RegistryEntry | undefined {
  return registry.get(name);
}

/** Every schema Realm.open() needs: top-level models + their nested embedded schemas. */
export function getAllRealmObjectSchemas(): Realm.ObjectSchema[] {
  return [...Array.from(registry.values()).map((e) => e.realmObjectSchema), ...Array.from(embeddedRegistry.values())];
}

export function getAllEmbeddedSchemas(): Map<string, Realm.ObjectSchema> {
  return embeddedRegistry;
}

export function getAllEntries(): Map<string, RegistryEntry> {
  return registry;
}

export function clearRegistry(): void {
  registry.clear();
  embeddedRegistry.clear();
}

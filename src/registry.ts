import Realm from "realm";
import type { Schema } from "./Schema";
import type { ModelClass } from "./Model";

export interface RegistryEntry {
  schema: Schema<any>;
  realmObjectSchema: Realm.ObjectSchema;
  modelClass?: ModelClass<any>;
}

const registry = new Map<string, RegistryEntry>();

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

export function getRegisteredSchema(name: string): RegistryEntry | undefined {
  return registry.get(name);
}

export function getAllRealmObjectSchemas(): Realm.ObjectSchema[] {
  return Array.from(registry.values()).map((e) => e.realmObjectSchema);
}

export function getAllEntries(): Map<string, RegistryEntry> {
  return registry;
}

export function clearRegistry(): void {
  registry.clear();
}

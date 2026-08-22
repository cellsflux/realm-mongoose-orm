import Realm from "realm";

export type MigrationFn = (oldRealm: Realm, newRealm: Realm) => void;

/**
 * "Safe" migration helpers: each method guards against the most common
 * failure modes (missing property, out-of-bounds index) instead of letting
 * the Realm migration crash outright.
 */
export class MigrationBuilder {
  constructor(private oldRealm: Realm, private newRealm: Realm) {}

  /** Renames a field by copying its value over, never throws if the field is missing */
  renameField(schemaName: string, from: string, to: string): void {
    const oldObjects = this.oldRealm.objects(schemaName);
    const newObjects = this.newRealm.objects(schemaName);
    const count = Math.min(oldObjects.length, newObjects.length);
    for (let i = 0; i < count; i++) {
      const oldObj = oldObjects[i] as unknown as Record<string, unknown>;
      const newObj = newObjects[i] as unknown as Record<string, unknown>;
      if (from in oldObj) {
        newObj[to] = oldObj[from];
      }
    }
  }

  /** Fills a default value for every object that doesn't already have this field set */
  fillDefault(schemaName: string, field: string, value: unknown): void {
    const newObjects = this.newRealm.objects(schemaName);
    for (const obj of newObjects) {
      const record = obj as unknown as Record<string, unknown>;
      if (record[field] === undefined || record[field] === null) {
        record[field] = typeof value === "function" ? (value as () => unknown)() : value;
      }
    }
  }

  /** Transforms each existing object with a custom function, safely (try/catch per row) */
  transform(schemaName: string, fn: (oldObj: any, newObj: any) => void): void {
    const oldObjects = this.oldRealm.objects(schemaName);
    const newObjects = this.newRealm.objects(schemaName);
    const count = Math.min(oldObjects.length, newObjects.length);
    for (let i = 0; i < count; i++) {
      try {
        fn(oldObjects[i], newObjects[i]);
      } catch (err) {
        console.warn(`[migration] failed on ${schemaName}[${i}]:`, err);
      }
    }
  }
}

/** Helper for writing a readable migration: defineMigration((m) => { m.renameField(...) }) */
export function defineMigration(build: (m: MigrationBuilder, oldVersion: number) => void): MigrationFn {
  return (oldRealm, newRealm) => {
    const builder = new MigrationBuilder(oldRealm, newRealm);
    build(builder, oldRealm.schemaVersion);
  };
}

import fs from "fs";
import { Schema } from "./Schema";
import { MigrationBuilder, MigrationFn } from "./MigrationBuilder";
import { getAllEntries, getAllEmbeddedSchemas } from "./registry";

interface StoredFieldMeta {
  type: string;
  hasDefault: boolean;
}

interface SchemaMetaFile {
  version: number;
  models: Record<string, Record<string, StoredFieldMeta>>;
}

export interface MigrationPlan {
  version: number;
  migration?: MigrationFn;
  /**
   * Only writes the .meta.json file to disk when called.
   * Must only be called AFTER Realm.open() has actually succeeded —
   * otherwise the meta file drifts out of sync with the real .realm file,
   * and no migration ever gets proposed again on the next startup
   * (a permanent "Migration is required" error loop).
   */
  commit: () => void;
}

/**
 * Stable, deep comparison (unlike `JSON.stringify(obj, arrayReplacer)`,
 * which recursively filters keys and silently hides real changes).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${parts.join(",")}}`;
}

/**
 * Automatically computes schemaVersion and the migration function — no
 * matter how complex the change, with zero intervention from the developer:
 *  1. Compares the current schema (ormSchema) against the one from the last
 *     SUCCESSFUL connection (`<db>.meta.json` file), via a reliable deep comparison.
 *  2. Field added -> the schema's default value is applied to existing
 *     documents (or the type's neutral value if no default is declared). No data loss.
 *  3. Field removed -> Realm drops it, and its data, silently.
 *  4. Fields removed + fields added of the same type, in the same model, during
 *     the same connection -> automatically paired as RENAMES (handles
 *     several simultaneous renames): the value is copied to the new name,
 *     no data loss, without writing a single line of migration code.
 *  5. The .meta.json file is only updated after a successful Realm.open()
 *     (never out of sync between the real database and what's "known").
 */
export class SchemaVersionManager {
  private metaPath: string;

  constructor(dbPath: string) {
    this.metaPath = dbPath === ":memory:" ? "" : `${dbPath}.meta.json`;
  }

  private buildCurrentMeta(): SchemaMetaFile["models"] {
    const models: SchemaMetaFile["models"] = {};
    for (const [name, entry] of getAllEntries()) {
      if (!entry.realmObjectSchema) continue;
      const fields: Record<string, StoredFieldMeta> = {};
      for (const [propName, propType] of Object.entries(entry.realmObjectSchema.properties)) {
        const typeStr = typeof propType === "string" ? propType : (propType as { type: string }).type;
        const fieldDef = (entry.schema as Schema<any>).fields[propName];
        const hasDefault =
          typeof fieldDef === "object" && fieldDef !== null && "default" in fieldDef && fieldDef.default !== undefined;
        fields[propName] = { type: typeStr, hasDefault: !!hasDefault };
      }
      models[name] = fields;
    }

    // Nested embedded sub-document schemas (e.g. "User_address") are tracked too,
    // so a change inside a nested object still bumps the version and never
    // triggers Realm's fatal "Migration is required" error. Renames/defaults
    // aren't auto-applied *inside* embedded objects (see plan() below) — only
    // the version bump is automatic there; use expert mode for anything fancier.
    for (const [name, embeddedSchema] of getAllEmbeddedSchemas()) {
      const fields: Record<string, StoredFieldMeta> = {};
      for (const [propName, propType] of Object.entries(embeddedSchema.properties)) {
        const typeStr = typeof propType === "string" ? propType : (propType as { type: string }).type;
        fields[propName] = { type: typeStr, hasDefault: false };
      }
      models[name] = fields;
    }

    return models;
  }

  private readPreviousMeta(): SchemaMetaFile | null {
    if (!this.metaPath || !fs.existsSync(this.metaPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.metaPath, "utf-8")) as SchemaMetaFile;
    } catch {
      return null;
    }
  }

  private writeMeta(meta: SchemaMetaFile): void {
    if (!this.metaPath) return;
    const tmpPath = `${this.metaPath}.tmp`;
    // Atomic write (temp file + rename) so we never leave a half-written
    // .meta.json behind if the process gets interrupted mid-write.
    fs.writeFileSync(tmpPath, JSON.stringify(meta, null, 2), "utf-8");
    fs.renameSync(tmpPath, this.metaPath);
  }

  private hasChanges(previous: SchemaMetaFile["models"], current: SchemaMetaFile["models"]): boolean {
    return stableStringify(previous) !== stableStringify(current);
  }

  /**
   * Prepares the version + migration to use, WITHOUT writing anything to disk.
   * Call `.commit()` on the result only after a successful Realm.open().
   */
  plan(explicitVersion?: number, explicitMigration?: MigrationFn): MigrationPlan {
    const current = this.buildCurrentMeta();

    if (explicitVersion !== undefined) {
      return {
        version: explicitVersion,
        migration: explicitMigration,
        commit: () => this.writeMeta({ version: explicitVersion, models: current }),
      };
    }

    const previous = this.readPreviousMeta();

    if (!previous) {
      // First connection ever: version 0, nothing to migrate.
      return {
        version: 0,
        migration: explicitMigration,
        commit: () => this.writeMeta({ version: 0, models: current }),
      };
    }

    const changed = this.hasChanges(previous.models, current);
    const newVersion = changed ? previous.version + 1 : previous.version;

    if (!changed) {
      return { version: newVersion, migration: explicitMigration, commit: () => {} };
    }

    const autoMigration: MigrationFn = (oldRealm, newRealm) => {
      const builder = new MigrationBuilder(oldRealm, newRealm);

      for (const [modelName, fields] of Object.entries(current)) {
        // Embedded (nested) sub-document schemas can't be queried directly
        // with realm.objects(...) — Realm only allows that on top-level
        // models. Their version bump alone (already computed above) is
        // enough to stop the fatal "Migration is required" crash; Realm
        // applies the new nested structure on its own. Skip rename/default
        // auto-fill for those — use expert mode (onMigration) if you need it.
        if (!getAllEntries().has(modelName)) continue;

        const previousFields = previous.models[modelName] ?? {};

        const addedFieldNames = Object.keys(fields).filter((f) => !(f in previousFields));
        const removedFieldNames = Object.keys(previousFields).filter((f) => !(f in fields));

        // Rename pairing: each removed field is matched with the first
        // still-available added field of the SAME TYPE. Handles multiple
        // simultaneous renames within the same model, not just one at a time.
        const stillAdded = new Set(addedFieldNames);
        const renamedPairs: Array<[string, string]> = [];

        for (const removedName of removedFieldNames) {
          const removedType = previousFields[removedName]?.type;
          const match = Array.from(stillAdded).find((addedName) => fields[addedName]?.type === removedType);
          if (match) {
            renamedPairs.push([removedName, match]);
            stillAdded.delete(match);
          }
        }

        for (const [from, to] of renamedPairs) {
          builder.renameField(modelName, from, to);
        }

        // Added fields that weren't matched to a rename are genuinely new
        // fields -> apply the schema's default value (or let Realm apply
        // the type's neutral value if no default was declared).
        for (const fieldName of stillAdded) {
          const entry = getAllEntries().get(modelName);
          const fieldDef = entry ? (entry.schema as Schema<any>).fields[fieldName] : undefined;
          const defaultValue =
            typeof fieldDef === "object" && fieldDef !== null && "default" in fieldDef ? fieldDef.default : undefined;

          if (defaultValue !== undefined) {
            builder.fillDefault(modelName, fieldName, defaultValue);
          }
        }

        // Unmatched removed fields are genuine deletions: Realm drops the
        // property (and its data) on its own, nothing to do here.
      }

      // Leave room for custom developer logic too, if one was provided.
      explicitMigration?.(oldRealm, newRealm);
    };

    return {
      version: newVersion,
      migration: autoMigration,
      commit: () => this.writeMeta({ version: newVersion, models: current }),
    };
  }
}

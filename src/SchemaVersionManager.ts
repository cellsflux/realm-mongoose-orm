import fs from "fs";
import { Schema } from "./Schema";
import { MigrationBuilder, MigrationFn } from "./MigrationBuilder";
import { getAllEntries } from "./registry";

interface StoredFieldMeta {
  type: string;
  hasDefault: boolean;
}

interface SchemaMetaFile {
  version: number;
  models: Record<string, Record<string, StoredFieldMeta>>;
}

/**
 * Calcule automatiquement schemaVersion et le migration function à la place du développeur.
 * Fonctionnement (comme un "auto-migrate" façon Prisma) :
 *  1. À chaque connexion, on compare les schémas actuellement déclarés (ormSchema)
 *     avec ceux enregistrés lors de la connexion précédente (fichier <db>.meta.json).
 *  2. S'il y a une différence (champ ajouté/retiré/type changé), la version est
 *     incrémentée automatiquement et une migration "safe" est générée :
 *     - nouveaux champs -> valeur par défaut du schéma (ou valeur neutre du type)
 *     - champs supprimés -> ignorés (Realm les élimine tout seul)
 *  3. Le développeur n'écrit RIEN, sauf s'il veut un comportement custom
 *     (auquel cas il peut toujours passer onMigration lui-même à connectDB()).
 */
export class SchemaVersionManager {
  private metaPath: string;

  constructor(dbPath: string) {
    this.metaPath = dbPath === ":memory:" ? "" : `${dbPath}.meta.json`;
  }

  private buildCurrentMeta(): SchemaMetaFile["models"] {
    const models: SchemaMetaFile["models"] = {};
    for (const [name, entry] of getAllEntries()) {
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
    fs.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2), "utf-8");
  }

  private hasChanges(previous: SchemaMetaFile["models"], current: SchemaMetaFile["models"]): boolean {
    const prevJson = JSON.stringify(previous, Object.keys(previous).sort());
    const currJson = JSON.stringify(current, Object.keys(current).sort());
    return prevJson !== currJson;
  }

  /**
   * Renvoie la version à utiliser + une fonction de migration auto-générée.
   * Si `explicitVersion`/`explicitMigration` sont fournis par le développeur,
   * ils sont utilisés tels quels (mode "expert", non obligatoire).
   */
  resolve(explicitVersion?: number, explicitMigration?: MigrationFn): { version: number; migration?: MigrationFn } {
    const current = this.buildCurrentMeta();

    if (explicitVersion !== undefined) {
      this.writeMeta({ version: explicitVersion, models: current });
      return { version: explicitVersion, migration: explicitMigration };
    }

    const previous = this.readPreviousMeta();

    if (!previous) {
      // Première connexion : version 0, rien à migrer.
      this.writeMeta({ version: 0, models: current });
      return { version: 0, migration: explicitMigration };
    }

    const changed = this.hasChanges(previous.models, current);
    const newVersion = changed ? previous.version + 1 : previous.version;

    if (!changed) {
      return { version: newVersion, migration: explicitMigration };
    }

    const autoMigration: MigrationFn = (oldRealm, newRealm) => {
      const builder = new MigrationBuilder(oldRealm, newRealm);
      for (const [modelName, fields] of Object.entries(current)) {
        const previousFields = previous.models[modelName] ?? {};
        for (const [fieldName, meta] of Object.entries(fields)) {
          const isNewField = !(fieldName in previousFields);
          if (!isNewField) continue;

          const entry = getAllEntries().get(modelName);
          const fieldDef = entry ? (entry.schema as Schema<any>).fields[fieldName] : undefined;
          const defaultValue =
            typeof fieldDef === "object" && fieldDef !== null && "default" in fieldDef ? fieldDef.default : undefined;

          if (defaultValue !== undefined) {
            builder.fillDefault(modelName, fieldName, defaultValue);
          }
          // Sinon Realm applique automatiquement la valeur neutre du type (0, "", false, null).
        }
      }
      // Laisse aussi la place à une logique custom du développeur si fournie.
      explicitMigration?.(oldRealm, newRealm);
    };

    this.writeMeta({ version: newVersion, models: current });
    return { version: newVersion, migration: autoMigration };
  }
}

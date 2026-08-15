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

export interface MigrationPlan {
  version: number;
  migration?: MigrationFn;
  /**
   * N'écrit le fichier .meta.json sur disque QUE si appelé.
   * Ne doit être appelé qu'APRÈS que Realm.open() a réellement réussi,
   * sinon le méta-fichier se désynchronise du fichier .realm réel et
   * plus aucune migration n'est proposée au prochain démarrage
   * (boucle d'erreur "Migration is required" permanente).
   */
  commit: () => void;
}

/**
 * Calcule automatiquement schemaVersion et la fonction de migration.
 *  1. Compare le schéma actuel (ormSchema) à celui de la dernière connexion
 *     RÉUSSIE (fichier <db>.meta.json).
 *  2. Champ ajouté -> valeur par défaut du schéma appliquée aux documents existants.
 *  3. Champ supprimé seul -> ignoré, Realm l'élimine tout seul.
 *  4. Un champ supprimé + un champ ajouté du même type dans le même modèle,
 *     lors de la même connexion -> traité comme un RENOMMAGE : la valeur est
 *     copiée automatiquement vers le nouveau nom (aucune perte de données),
 *     exactement comme si vous aviez écrit `m.renameField(model, from, to)`.
 *  5. Le fichier .meta.json n'est mis à jour qu'après un Realm.open() réussi.
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
    // Écriture atomique (fichier temporaire + rename) pour ne jamais laisser
    // un .meta.json à moitié écrit si le process est interrompu.
    fs.writeFileSync(tmpPath, JSON.stringify(meta, null, 2), "utf-8");
    fs.renameSync(tmpPath, this.metaPath);
  }

  private hasChanges(previous: SchemaMetaFile["models"], current: SchemaMetaFile["models"]): boolean {
    const prevJson = JSON.stringify(previous, Object.keys(previous).sort());
    const currJson = JSON.stringify(current, Object.keys(current).sort());
    return prevJson !== currJson;
  }

  /**
   * Prépare la version + migration à utiliser, SANS rien écrire sur disque.
   * Appelez `.commit()` sur le résultat uniquement après un Realm.open() réussi.
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
      // Première connexion : version 0, rien à migrer.
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
        const previousFields = previous.models[modelName] ?? {};

        const addedFieldNames = Object.keys(fields).filter((f) => !(f in previousFields));
        const removedFieldNames = Object.keys(previousFields).filter((f) => !(f in fields));

        // Détection de renommage : exactement 1 champ retiré + 1 champ ajouté
        // de même type -> on considère que c'est un renommage et on préserve la donnée.
        let renamedFrom: string | null = null;
        let renamedTo: string | null = null;
        if (removedFieldNames.length === 1 && addedFieldNames.length === 1) {
          const from = removedFieldNames[0];
          const to = addedFieldNames[0];
          if (previousFields[from].type === fields[to].type) {
            renamedFrom = from;
            renamedTo = to;
          }
        }

        if (renamedFrom && renamedTo) {
          builder.renameField(modelName, renamedFrom, renamedTo);
          continue;
        }

        // Sinon : traitement standard, champ par champ ajouté.
        for (const fieldName of addedFieldNames) {
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

    return {
      version: newVersion,
      migration: autoMigration,
      commit: () => this.writeMeta({ version: newVersion, models: current }),
    };
  }
}

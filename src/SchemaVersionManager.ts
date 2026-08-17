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

/** Comparaison stable et profonde (contrairement à JSON.stringify(obj, arrayReplacer)
 *  qui filtre récursivement les clés et masque silencieusement les vrais changements). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${parts.join(",")}}`;
}

/**
 * Calcule automatiquement schemaVersion et la fonction de migration —
 * quelle que soit la complexité du changement, sans intervention du développeur :
 *  1. Compare le schéma actuel (ormSchema) à celui de la dernière connexion
 *     RÉUSSIE (fichier <db>.meta.json), via une comparaison profonde fiable.
 *  2. Champ ajouté -> valeur par défaut du schéma appliquée aux documents existants
 *     (ou valeur neutre du type si aucun default n'est déclaré). Aucune perte de données.
 *  3. Champ supprimé -> Realm l'élimine, avec ses données, silencieusement.
 *  4. Champs supprimés + champs ajoutés du même type, dans le même modèle, lors de
 *     la même connexion -> appariés automatiquement comme des RENOMMAGES (gère
 *     plusieurs renommages simultanés) : la valeur est copiée vers le nouveau nom,
 *     aucune perte de données, sans écrire la moindre ligne de migration.
 *  5. Le fichier .meta.json n'est mis à jour qu'après un Realm.open() réussi
 *     (jamais de désynchronisation entre la base réelle et ce qui est "connu").
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
    return stableStringify(previous) !== stableStringify(current);
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

        // Appariement des renommages : chaque champ supprimé est associé au
        // premier champ ajouté de MÊME TYPE encore disponible. Gère plusieurs
        // renommages simultanés dans le même modèle, pas seulement un seul.
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

        // Les champs ajoutés qui n'ont pas été appariés à un renommage sont
        // de VRAIS nouveaux champs -> valeur par défaut du schéma (ou valeur
        // neutre du type, gérée nativement par Realm si aucun default n'existe).
        for (const fieldName of stillAdded) {
          const entry = getAllEntries().get(modelName);
          const fieldDef = entry ? (entry.schema as Schema<any>).fields[fieldName] : undefined;
          const defaultValue =
            typeof fieldDef === "object" && fieldDef !== null && "default" in fieldDef ? fieldDef.default : undefined;

          if (defaultValue !== undefined) {
            builder.fillDefault(modelName, fieldName, defaultValue);
          }
        }

        // Les champs supprimés non appariés sont de VRAIES suppressions :
        // Realm élimine la propriété (et sa donnée) tout seul, rien à faire ici.
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

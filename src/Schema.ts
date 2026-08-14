import Realm from "realm";
import {
  FieldDefinition,
  FieldOptions,
  FieldType,
  RelationDefinition,
  SchemaDefinitionMap,
  SchemaOptions,
} from "./types";
import { createModel, ModelClass } from "./Model";
import { registerSchema, registerModelClass } from "./registry";

export class ValidationError extends Error {
  constructor(field: string, message: string) {
    super(`Validation échouée sur "${field}": ${message}`);
    this.name = "ValidationError";
  }
}

const TYPE_MAP: Record<FieldType, string> = {
  string: "string",
  number: "double",
  int: "int",
  boolean: "bool",
  date: "date",
  objectId: "objectId",
  uuid: "uuid",
  mixed: "mixed",
  buffer: "data",
};

export function isRelation(def: FieldDefinition): def is RelationDefinition {
  return typeof def === "object" && def !== null && "ref" in def;
}

function normalize(def: FieldDefinition): FieldOptions | RelationDefinition {
  if (typeof def === "string") {
    return { type: def };
  }
  return def;
}

export class Schema<T extends Record<string, unknown> = Record<string, unknown>> {
  public readonly fields: SchemaDefinitionMap;
  public readonly options: Required<Pick<SchemaOptions, "timestamps" | "primaryKey" | "version">>;

  constructor(fields: SchemaDefinitionMap, options: SchemaOptions = {}) {
    this.fields = fields;
    this.options = {
      timestamps: options.timestamps ?? false,
      primaryKey: options.primaryKey ?? "_id",
      version: options.version ?? 0,
    };
  }

  /** Construit dynamiquement le nom de classe Realm (ObjectSchema) pour ce modèle */
  toRealmObjectSchema(name: string): Realm.ObjectSchema {
    const properties: Realm.PropertiesTypes = {
      [this.options.primaryKey]: this.options.primaryKey === "_id" ? "uuid" : "string",
    };

    for (const [field, rawDef] of Object.entries(this.fields)) {
      const def = normalize(rawDef);

      if (isRelation(def)) {
        // Stocké comme référence par _id (uuid), façon Mongoose (`ref`) — pas comme lien Realm natif.
        // populate() résout ensuite ces ids en documents réels, à la demande.
        properties[field] = def.many ? "uuid[]" : "uuid?";
        continue;
      }

      const opts = def as FieldOptions;
      const base = TYPE_MAP[opts.type];
      const suffix = opts.array ? "[]" : opts.required ? "" : "?";
      properties[field] = `${base}${suffix}`;
    }

    if (this.options.timestamps) {
      properties.createdAt = "date";
      properties.updatedAt = "date";
    }

    return {
      name,
      primaryKey: this.options.primaryKey,
      properties,
    };
  }

  /** Applique les valeurs par défaut (comme Mongoose) avant insertion */
  applyDefaults(doc: Partial<T>): Partial<T> {
    const result: Record<string, unknown> = { ...doc };

    for (const [field, rawDef] of Object.entries(this.fields)) {
      const def = normalize(rawDef);
      if (isRelation(def)) continue;
      const opts = def as FieldOptions;

      if (result[field] === undefined && opts.default !== undefined) {
        result[field] = typeof opts.default === "function" ? (opts.default as () => unknown)() : opts.default;
      }
    }

    if (this.options.timestamps) {
      const now = new Date();
      if (!result.createdAt) result.createdAt = now;
      result.updatedAt = now;
    }

    return result as Partial<T>;
  }

  /** Valide un document selon les règles required / enum / min / max / validate, comme Mongoose */
  validate(doc: Partial<T>, { partial = false }: { partial?: boolean } = {}): void {
    for (const [field, rawDef] of Object.entries(this.fields)) {
      const def = normalize(rawDef);
      if (isRelation(def)) continue;
      const opts = def as FieldOptions;
      const value = (doc as Record<string, unknown>)[field];

      const isMissing = value === undefined || value === null;

      if (!partial && opts.required && isMissing) {
        throw new ValidationError(field, "ce champ est requis");
      }
      if (isMissing) continue;

      if (opts.enum && !opts.enum.includes(value as never)) {
        throw new ValidationError(field, `valeur "${value}" hors de l'enum [${opts.enum.join(", ")}]`);
      }
      if (typeof value === "number") {
        if (opts.min !== undefined && value < opts.min) {
          throw new ValidationError(field, `doit être >= ${opts.min}`);
        }
        if (opts.max !== undefined && value > opts.max) {
          throw new ValidationError(field, `doit être <= ${opts.max}`);
        }
      }
      if (typeof value === "string") {
        if (opts.minLength !== undefined && value.length < opts.minLength) {
          throw new ValidationError(field, `doit contenir au moins ${opts.minLength} caractères`);
        }
        if (opts.maxLength !== undefined && value.length > opts.maxLength) {
          throw new ValidationError(field, `doit contenir au plus ${opts.maxLength} caractères`);
        }
      }
      if (opts.validate) {
        const res = opts.validate(value);
        if (res === false) throw new ValidationError(field, "validation personnalisée échouée");
        if (typeof res === "string") throw new ValidationError(field, res);
      }
    }
  }

  /**
   * Équivalent de `mongoose.model("User", userSchema)`.
   * Enregistre le schéma dans le registre global (utilisé par RealmClient.connect)
   * et renvoie une classe Model prête à l'emploi (create, find, findOne, save, ...).
   */
  model(name: string): ModelClass<T> {
    const realmObjectSchema = this.toRealmObjectSchema(name);
    registerSchema(name, this, realmObjectSchema);
    const ModelClassRef = createModel<T>(name, this);
    registerModelClass(name, ModelClassRef);
    return ModelClassRef;
  }
}

/** Alias principal demandé : ormSchema({...}, { timestamps: true }) */
export function ormSchema<T extends Record<string, unknown> = Record<string, unknown>>(
  fields: SchemaDefinitionMap,
  options?: SchemaOptions
): Schema<T> {
  return new Schema<T>(fields, options);
}

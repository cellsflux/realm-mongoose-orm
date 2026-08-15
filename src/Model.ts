import Realm from "realm";
import { isRelation, Schema } from "./Schema";
import { QueryTranslator } from "./QueryTranslator";
import { RealmClient } from "./RealmClient";
import { Aggregate, AggregationStage } from "./Aggregate";
import { Query } from "./Query";
import { getRegisteredSchema } from "./registry";
import type { FindOptions, MongoLikeFilter, RelationDefinition } from "./types";

/** Convertit un id passé en string (ex: depuis une URL) vers le type uuid attendu par Realm */
function toUuid(id: string | Realm.BSON.UUID): Realm.BSON.UUID {
  return id instanceof Realm.BSON.UUID ? id : new Realm.BSON.UUID(id);
}

/** Extrait un id (string ou UUID) à partir d'une valeur brute, d'un id déjà prêt, ou d'un objet peuplé { _id } */
function extractId(value: unknown): Realm.BSON.UUID | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Realm.BSON.UUID) return value;
  if (typeof value === "string") return toUuid(value);
  if (typeof value === "object" && "_id" in (value as Record<string, unknown>)) {
    return extractId((value as Record<string, unknown>)._id);
  }
  return undefined;
}

function toPlainObject<T>(realmObject: Realm.Object & Record<string, unknown>): T {
  const plain: Record<string, unknown> = {};
  for (const key of Object.keys(realmObject)) {
    const value = (realmObject as Record<string, unknown>)[key];
    // Les listes Realm (relations "many", champs array) sont itérables mais pas
    // de vrais tableaux JS : on les convertit pour un usage normal (map, JSON, ...).
    plain[key] =
      value && typeof value === "object" && typeof (value as any)[Symbol.iterator] === "function" && !(value instanceof Date)
        ? Array.from(value as Iterable<unknown>)
        : value;
  }
  return plain as T;
}

/**
 * Convertit récursivement tout `Realm.BSON.UUID` (ids, ids de relation) en string,
 * exactement comme Mongoose sérialise un `ObjectId` en string dans `toJSON()`.
 * Sans ça, `_id` apparaîtrait comme un buffer brut illisible côté client (IPC, JSON.stringify...).
 */
function serializeValue(value: unknown): unknown {
  if (value instanceof Realm.BSON.UUID) return value.toString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value instanceof Date) return value;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Convertit les champs de relation (`{ ref: "User" }`) d'un payload en id(s) uuid,
 * pour que le développeur puisse indifféremment passer un id string ("64f...")
 * ou un document déjà peuplé ({ _id: "64f...", name: "Alice" }).
 */
function normalizeRelations<T extends object>(
  schema: Schema<T>,
  payload: Record<string, unknown>
): void {
  for (const [field, rawDef] of Object.entries(schema.fields)) {
    if (!isRelation(rawDef)) continue;
    const def = rawDef as RelationDefinition;
    const value = payload[field];
    if (value === undefined) continue;

    if (def.many) {
      const arr = Array.isArray(value) ? value : [];
      payload[field] = arr.map((v) => extractId(v)).filter((v): v is Realm.BSON.UUID => !!v);
    } else {
      const id = extractId(value);
      payload[field] = id ?? null;
    }
  }
}

/**
 * Classe de base renvoyée par schema.model("Nom").
 * Chaque instance représente un document, comme un document Mongoose.
 */
export class BaseModel<T extends object> {
  private _isNew: boolean;
  [key: string]: unknown;

  constructor(data: Partial<T>, isNew = true) {
    Object.assign(this, data);
    this._isNew = isNew;
  }

  /** Équivalent de doc.save() en Mongoose : insère si nouveau, met à jour sinon */
  async save(): Promise<this> {
    const Model = this.constructor as unknown as ModelClass<T>;
    const data = this.toObject();

    if (this._isNew) {
      const created = await Model.create(data);
      Object.assign(this, created.toObject());
      this._isNew = false;
      return this;
    }

    await Model.updateOne({ _id: (this as Record<string, unknown>)._id } as MongoLikeFilter<T>, data);
    return this;
  }

  /** Équivalent de doc.deleteOne() en Mongoose */
  async remove(): Promise<void> {
    const Model = this.constructor as unknown as ModelClass<T>;
    await Model.deleteOne({ _id: (this as Record<string, unknown>)._id } as MongoLikeFilter<T>);
  }

  /** Résout un ou plusieurs champs de relation sur CE document, comme doc.populate("owner") */
  async populate(fields: string | string[]): Promise<this> {
    const Model = this.constructor as unknown as ModelClass<T>;
    await Model.populate(this, Array.isArray(fields) ? fields : [fields]);
    return this;
  }

  toObject(): T {
    const { _isNew, ...rest } = this as unknown as Record<string, unknown>;
    return serializeValue(rest) as T;
  }

  toJSON(): T {
    return this.toObject();
  }
}

export interface ModelClass<T extends object> {
  new (data: Partial<T>, isNew?: boolean): BaseModel<T>;
  modelName: string;

  create(data: Partial<T>): Promise<BaseModel<T>>;
  insertMany(data: Partial<T>[]): Promise<BaseModel<T>[]>;
  find(filter?: MongoLikeFilter<T>, options?: FindOptions): Query<BaseModel<T>[]>;
  findOne(filter?: MongoLikeFilter<T>, options?: FindOptions): Query<BaseModel<T> | null>;
  findById(id: string, options?: FindOptions): Query<BaseModel<T> | null>;
  updateOne(filter: MongoLikeFilter<T>, update: Partial<T>): Promise<number>;
  updateMany(filter: MongoLikeFilter<T>, update: Partial<T>): Promise<number>;
  deleteOne(filter: MongoLikeFilter<T>): Promise<number>;
  deleteMany(filter: MongoLikeFilter<T>): Promise<number>;
  count(filter?: MongoLikeFilter<T>): Promise<number>;
  countDocuments(filter?: MongoLikeFilter<T>): Promise<number>;

  findByIdAndUpdate(id: string, update: Partial<T>, options?: { new?: boolean }): Promise<BaseModel<T> | null>;
  findByIdAndDelete(id: string): Promise<BaseModel<T> | null>;
  findOneAndUpdate(
    filter: MongoLikeFilter<T>,
    update: Partial<T>,
    options?: { new?: boolean }
  ): Promise<BaseModel<T> | null>;
  findOneAndDelete(filter: MongoLikeFilter<T>): Promise<BaseModel<T> | null>;

  exists(filter: MongoLikeFilter<T>): Promise<boolean>;
  distinct<K extends keyof T>(field: K, filter?: MongoLikeFilter<T>): Promise<T[K][]>;
  aggregate<R = any>(pipeline: AggregationStage[]): Promise<R[]>;

  /** Résout les champs de relation (ref) d'un ou plusieurs documents, façon Mongoose populate() */
  populate(doc: BaseModel<T>, fields: string[]): Promise<BaseModel<T>>;
  populate(docs: BaseModel<T>[], fields: string[]): Promise<BaseModel<T>[]>;
}

export function createModel<T extends object>(name: string, schema: Schema<T>): ModelClass<T> {
  class Model extends BaseModel<T> {
    static modelName = name;

    static async create(data: Partial<T>): Promise<BaseModel<T>> {
      const withDefaults = schema.applyDefaults(data);
      schema.validate(withDefaults);

      const realm = await RealmClient.ready();
      const payload: Record<string, unknown> = { ...withDefaults };
      normalizeRelations(schema, payload);
      if (!payload._id) {
        payload._id = new Realm.BSON.UUID();
      }

      let created!: Realm.Object;
      realm.write(() => {
        created = realm.create(name, payload);
      });

      return new Model(toPlainObject<T>(created as any), false);
    }

    static async insertMany(dataList: Partial<T>[]): Promise<BaseModel<T>[]> {
      const realm = await RealmClient.ready();
      const results: BaseModel<T>[] = [];

      realm.write(() => {
        for (const data of dataList) {
          const withDefaults = schema.applyDefaults(data);
          schema.validate(withDefaults);
          const payload: Record<string, unknown> = { ...withDefaults };
          normalizeRelations(schema, payload);
          if (!payload._id) payload._id = new Realm.BSON.UUID();
          const created = realm.create(name, payload);
          results.push(new Model(toPlainObject<T>(created as any), false));
        }
      });

      return results;
    }

    static _findExec(filter: MongoLikeFilter<T>, options: FindOptions): Promise<any> {
      return (async () => {
        const realm = await RealmClient.ready();
        const { query, args } = QueryTranslator.translate(filter);
        let results = realm.objects(name).filtered(query, ...args);

        if (options.sort) {
          const sortSpec = QueryTranslator.translateSort(options.sort)!;
          for (const [field, reverse] of sortSpec) {
            results = results.sorted(field, reverse);
          }
        }

        let array = Array.from(results);
        if (options.skip) array = array.slice(options.skip);
        if (options.limit) array = array.slice(0, options.limit);

        const docs = array.map((obj) => new Model(toPlainObject<T>(obj as any), false));

        if (options.populate?.length) {
          await Model.populate(docs, options.populate);
        }

        return options.lean ? docs.map((d) => d.toObject()) : docs;
      })();
    }

    /**
     * Renvoie une requête chaînable, façon Mongoose :
     *   await userModel.find({ role: "admin" }).populate("team").sort({ name: 1 }).limit(10);
     * Fonctionne aussi directement avec await (sans rien chaîner), comme avant.
     */
    static find(filter: MongoLikeFilter<T> = {}, options: FindOptions = {}): Query<BaseModel<T>[]> {
      return new Query<BaseModel<T>[]>((opts) => Model._findExec(filter, opts), options);
    }

    static findOne(filter: MongoLikeFilter<T> = {}, options: FindOptions = {}): Query<BaseModel<T> | null> {
      return new Query<BaseModel<T> | null>(async (opts) => {
        const results = (await Model._findExec(filter, { ...opts, limit: 1 })) as BaseModel<T>[];
        return results[0] ?? null;
      }, options);
    }

    static findById(id: string, options: FindOptions = {}): Query<BaseModel<T> | null> {
      return Model.findOne({ _id: toUuid(id) } as unknown as MongoLikeFilter<T>, options);
    }

    static async updateOne(filter: MongoLikeFilter<T>, update: Partial<T>): Promise<number> {
      return Model.updateMany(filter, update, true);
    }

    static async updateMany(filter: MongoLikeFilter<T>, update: Partial<T>, onlyFirst = false): Promise<number> {
      const realm = await RealmClient.ready();
      const { query, args } = QueryTranslator.translate(filter);
      const results = realm.objects(name).filtered(query, ...args);

      const updatePayload: Record<string, unknown> = { ...update };
      normalizeRelations(schema, updatePayload);

      let count = 0;
      realm.write(() => {
        for (const obj of results) {
          const record = obj as unknown as Record<string, unknown>;
          for (const [k, v] of Object.entries(updatePayload)) {
            record[k] = v;
          }
          if (schema.options.timestamps) {
            record.updatedAt = new Date();
          }
          count++;
          if (onlyFirst) break;
        }
      });

      return count;
    }

    static async deleteOne(filter: MongoLikeFilter<T>): Promise<number> {
      return Model.deleteMany(filter, true);
    }

    static async deleteMany(filter: MongoLikeFilter<T>, onlyFirst = false): Promise<number> {
      const realm = await RealmClient.ready();
      const { query, args } = QueryTranslator.translate(filter);
      const results = realm.objects(name).filtered(query, ...args);

      let count = 0;
      realm.write(() => {
        const toDelete = onlyFirst ? Array.from(results).slice(0, 1) : Array.from(results);
        for (const obj of toDelete) {
          realm.delete(obj);
          count++;
        }
      });

      return count;
    }

    static async count(filter: MongoLikeFilter<T> = {}): Promise<number> {
      const realm = await RealmClient.ready();
      const { query, args } = QueryTranslator.translate(filter);
      return realm.objects(name).filtered(query, ...args).length;
    }

    static async countDocuments(filter: MongoLikeFilter<T> = {}): Promise<number> {
      return Model.count(filter);
    }

    // ---- Raccourcis "findXAndY", exactement comme Mongoose ----

    static async findByIdAndUpdate(
      id: string,
      update: Partial<T>,
      options: { new?: boolean } = { new: true }
    ): Promise<BaseModel<T> | null> {
      return Model.findOneAndUpdate({ _id: toUuid(id) } as unknown as MongoLikeFilter<T>, update, options);
    }

    static async findByIdAndDelete(id: string): Promise<BaseModel<T> | null> {
      return Model.findOneAndDelete({ _id: toUuid(id) } as unknown as MongoLikeFilter<T>);
    }

    static async findOneAndUpdate(
      filter: MongoLikeFilter<T>,
      update: Partial<T>,
      options: { new?: boolean } = { new: true }
    ): Promise<BaseModel<T> | null> {
      const before = await Model.findOne(filter);
      if (!before) return null;

      await Model.updateOne(filter, update);
      if (options.new === false) return before;
      return Model.findOne(filter);
    }

    static async findOneAndDelete(filter: MongoLikeFilter<T>): Promise<BaseModel<T> | null> {
      const doc = await Model.findOne(filter);
      if (!doc) return null;
      await Model.deleteOne(filter);
      return doc;
    }

    static async exists(filter: MongoLikeFilter<T>): Promise<boolean> {
      const count = await Model.count(filter);
      return count > 0;
    }

    static async distinct<K extends keyof T>(field: K, filter: MongoLikeFilter<T> = {}): Promise<T[K][]> {
      const docs = await Model.find(filter);
      const values = docs.map((d) => d.toObject()[field]);
      return Array.from(new Set(values));
    }

    /** Pipeline d'agrégation façon MongoDB: $match, $group, $sort, $project, $limit, $skip, $unwind */
    static async aggregate<R = any>(pipeline: AggregationStage[]): Promise<R[]> {
      const all = await Model.find({});
      const plainDocs = all.map((d) => d.toObject());
      return Aggregate.run(plainDocs, pipeline) as R[];
    }

    /**
     * Résout un ou plusieurs champs `ref` en documents réels, façon Mongoose `.populate()`.
     * Fonctionne pour un document unique ou un tableau, et regroupe les requêtes
     * par lot (une seule requête $in par champ, quel que soit le nombre de documents).
     *
     *   const post = await postModel.findById(id, { populate: ["author"] });
     *   // ou manuellement :
     *   const post = await postModel.findById(id);
     *   await postModel.populate(post, ["author"]);
     */
    static async populate(docOrDocs: BaseModel<T> | BaseModel<T>[], fields: string[]): Promise<any> {
      const isArray = Array.isArray(docOrDocs);
      const list = (isArray ? docOrDocs : [docOrDocs]) as BaseModel<T>[];
      if (list.length === 0) return docOrDocs;

      for (const fieldName of fields) {
        const rawDef = schema.fields[fieldName];
        if (!rawDef || !isRelation(rawDef)) {
          throw new Error(`populate("${fieldName}") : ce champ n'est pas une relation dans le schéma "${name}".`);
        }
        const relation = rawDef as RelationDefinition;
        const entry = getRegisteredSchema(relation.ref);
        const RefModel = entry?.modelClass;
        if (!RefModel) {
          throw new Error(
            `populate("${fieldName}") : le modèle référencé "${relation.ref}" n'est pas enregistré. ` +
              `Importez son fichier avant de vous connecter.`
          );
        }

        // 1. Récupère tous les ids nécessaires, sur tous les documents, en une fois.
        const idSet = new Set<string>();
        for (const doc of list) {
          const value = (doc as unknown as Record<string, unknown>)[fieldName];
          if (relation.many && Array.isArray(value)) {
            for (const v of value) idSet.add(String(v));
          } else if (value) {
            idSet.add(String(value));
          }
        }
        if (idSet.size === 0) continue;

        // 2. Une seule requête $in pour charger tous les documents référencés.
        const refDocs = await RefModel.find({ _id: { $in: Array.from(idSet).map(toUuid) } } as any);
        const byId = new Map(refDocs.map((d: any) => [String(d.toObject()._id), d.toObject()]));

        // 3. Remplace les ids par les documents peuplés sur chaque document d'origine.
        for (const doc of list) {
          const record = doc as unknown as Record<string, unknown>;
          const value = record[fieldName];
          if (relation.many) {
            const arr = Array.isArray(value) ? value : [];
            record[fieldName] = arr.map((v) => byId.get(String(v))).filter(Boolean);
          } else if (value) {
            record[fieldName] = byId.get(String(value)) ?? null;
          }
        }
      }

      return isArray ? list : list[0];
    }
  }

  return Model as unknown as ModelClass<T>;
}

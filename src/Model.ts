import Realm from "realm";
import { isRelation, Schema } from "./Schema";
import { QueryTranslator } from "./QueryTranslator";
import { RealmClient } from "./RealmClient";
import { Aggregate, AggregationStage } from "./Aggregate";
import { Query } from "./Query";
import { normalizePopulateArgs } from "./populateUtils";
import { getRegisteredSchema } from "./registry";
import { ObjectId, requireObjectId, normalizeIdFields } from "./ObjectId";
import type { FindOptions, MongoLikeFilter, PopulateInput, PopulateSpec, RelationDefinition } from "./types";

/**
 * Every id-taking field (`_id` and every relation `ref` field) is normalized
 * through `ObjectId(...)` (see ObjectId.ts) — the single source of truth for
 * cleaning up and converting id-shaped values the whole library uses. This
 * means callers can pass a raw string, a quoted/JSON-escaped string, an
 * already-populated document, or a real BSON id interchangeably, everywhere:
 * create/insertMany payloads, find/update/delete filters, findById, and
 * populate() — no manual normalizeId()/toRealmId() boilerplate needed in
 * application code anymore.
 */

/**
 * Recursively flattens a Realm value into a plain JS value: embedded
 * `Realm.Object` sub-documents become plain objects, Realm lists (relation
 * arrays, "many" fields, embedded-object arrays) become real JS arrays —
 * all the way down, however deeply nested.
 */
function realmValueToPlain(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date || value instanceof Realm.BSON.UUID) return value;
  if (value instanceof Realm.Object) {
    const plain: Record<string, unknown> = {};
    for (const key of Object.keys(value as object)) {
      plain[key] = realmValueToPlain((value as unknown as Record<string, unknown>)[key]);
    }
    return plain;
  }
  if (typeof value === "object" && typeof (value as any)[Symbol.iterator] === "function") {
    return Array.from(value as Iterable<unknown>).map(realmValueToPlain);
  }
  return value;
}

function toPlainObject<T>(realmObject: Realm.Object & Record<string, unknown>): T {
  const plain: Record<string, unknown> = {};
  for (const key of Object.keys(realmObject)) {
    plain[key] = realmValueToPlain((realmObject as Record<string, unknown>)[key]);
  }
  return plain as T;
}

/**
 * Recursively converts every `Realm.BSON.UUID` (ids, relation ids) into a
 * string, exactly like Mongoose serializes an `ObjectId` into a string in
 * `toJSON()`. Without this, `_id` would show up as an unreadable raw buffer
 * on the client side (IPC, JSON.stringify, ...).
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

/** Keeps only the requested fields (+ _id), for populate({ select: "..." }) */
function applySelect<T extends Record<string, unknown>>(doc: T, select?: string[]): T {
  if (!select || select.length === 0) return doc;
  const out: Record<string, unknown> = { _id: doc._id };
  for (const key of select) {
    if (key in doc) out[key] = doc[key];
  }
  return out as T;
}

/**
 * Converts relation fields (`{ ref: "User" }`) in a payload into uuid id(s),
 * so the developer can pass either a plain id string ("64f...") or an
 * already-populated document ({ _id: "64f...", name: "Alice" }) interchangeably.
 */
function normalizeRelations<T extends object>(schema: Schema<T>, payload: Record<string, unknown>): void {
  for (const [field, rawDef] of Object.entries(schema.fields)) {
    if (!isRelation(rawDef)) continue;
    const def = rawDef as RelationDefinition;
    const value = payload[field];
    if (value === undefined) continue;

    if (def.many) {
      const arr = Array.isArray(value) ? value : [];
      payload[field] = arr.map((v) => ObjectId(v)).filter((v): v is Exclude<ReturnType<typeof ObjectId>, null> => !!v);
    } else {
      payload[field] = ObjectId(value);
    }
  }
}

/**
 * Base class returned by schema.model("Name").
 * An instance is only ever created when you explicitly use `new Model(...)`
 * or `{ lean: false }` — by default, every model method returns a plain JS
 * object (see the "Automatic _id" section of the README).
 */
export class BaseModel<T extends object> {
  private _isNew: boolean;
  [key: string]: unknown;

  constructor(data: Partial<T>, isNew = true) {
    Object.assign(this, data);
    this._isNew = isNew;
  }

  /** Equivalent of doc.save() in Mongoose: inserts if new, updates otherwise */
  async save(): Promise<this> {
    const Model = this.constructor as unknown as ModelClass<T>;
    const data = this.toObject();

    if (this._isNew) {
      const created = await Model.create(data);
      Object.assign(this, created);
      this._isNew = false;
      return this;
    }

    await Model.updateOne({ _id: (this as Record<string, unknown>)._id } as MongoLikeFilter<T>, data);
    return this;
  }

  /** Equivalent of doc.deleteOne() in Mongoose */
  async remove(): Promise<void> {
    const Model = this.constructor as unknown as ModelClass<T>;
    await Model.deleteOne({ _id: (this as Record<string, unknown>)._id } as MongoLikeFilter<T>);
  }

  /**
   * Resolves one or more relation fields on THIS document, Mongoose-style:
   *   await doc.populate("author");
   *   await doc.populate("author", "name email");
   *   await doc.populate([{ path: "author", select: "name" }]);
   */
  async populate(...args: (PopulateInput | PopulateInput[])[]): Promise<this> {
    const Model = this.constructor as unknown as ModelClass<T>;
    await Model.populate(this, normalizePopulateArgs(args));
    return this;
  }

  toObject(opts?: { virtuals?: boolean }): T {
    const { _isNew, ...rest } = this as unknown as Record<string, unknown>;
    return serializeValue(rest) as T;
  }

  toJSON(opts?: { virtuals?: boolean }): T {
    return this.toObject(opts);
  }
}

export interface ModelClass<T extends object> {
  new (data: Partial<T>, isNew?: boolean): BaseModel<T>;
  modelName: string;

  /** Returns a plain JS object (ids already stringified), ready for IPC/JSON/res.json() */
  create(data: Partial<T>): Promise<T>;
  insertMany(data: Partial<T>[]): Promise<T[]>;
  /** Chainable query: plain JS objects by default, `.lean(false)` for real instances */
  find(filter?: MongoLikeFilter<T>, options?: FindOptions): Query<T[]>;
  findOne(filter?: MongoLikeFilter<T>, options?: FindOptions): Query<T | null>;
  findById(id: string, options?: FindOptions): Query<T | null>;
  updateOne(filter: MongoLikeFilter<T>, update: Partial<T>): Promise<number>;
  updateMany(filter: MongoLikeFilter<T>, update: Partial<T>): Promise<number>;
  deleteOne(filter: MongoLikeFilter<T>): Promise<number>;
  deleteMany(filter: MongoLikeFilter<T>): Promise<number>;
  count(filter?: MongoLikeFilter<T>): Promise<number>;
  countDocuments(filter?: MongoLikeFilter<T>): Promise<number>;

  findByIdAndUpdate(id: string, update: Partial<T>, options?: { new?: boolean }): Promise<T | null>;
  findByIdAndDelete(id: string): Promise<T | null>;
  findOneAndUpdate(filter: MongoLikeFilter<T>, update: Partial<T>, options?: { new?: boolean }): Promise<T | null>;
  findOneAndDelete(filter: MongoLikeFilter<T>): Promise<T | null>;

  exists(filter: MongoLikeFilter<T>): Promise<boolean>;
  distinct<K extends keyof T>(field: K, filter?: MongoLikeFilter<T>): Promise<T[K][]>;
  aggregate<R = any>(pipeline: AggregationStage[]): Promise<R[]>;

  /** Resolves the relation (ref) fields of one or more documents, Mongoose populate()-style */
  populate(doc: T | BaseModel<T>, fields: PopulateInput | PopulateInput[] | PopulateSpec[]): Promise<T>;
  populate(docs: (T | BaseModel<T>)[], fields: PopulateInput | PopulateInput[] | PopulateSpec[]): Promise<T[]>;
}

export function createModel<T extends object>(name: string, schema: Schema<T>): ModelClass<T> {
  // Every field that holds an id: "_id" itself, plus every relation (`ref`)
  // field. Filters and updates touching any of these are normalized
  // automatically (see ObjectId.ts) — callers never need to convert by hand.
  const idFieldNames = new Set<string>(["_id"]);
  for (const [field, def] of Object.entries(schema.fields)) {
    if (isRelation(def)) idFieldNames.add(field);
  }

  class Model extends BaseModel<T> {
    static modelName = name;

    static async create(data: Partial<T>): Promise<T> {
      const withDefaults = schema.applyDefaults(data);
      schema.validate(withDefaults);

      const payload: Record<string, unknown> = { ...withDefaults };
      normalizeRelations(schema, payload);
      if (!payload._id) {
        payload._id = new Realm.BSON.UUID();
      }

      // pre("save") hooks run BEFORE the write, with the plain payload —
      // mutate it directly (e.g. hash a password) before it's persisted.
      for (const fn of schema.preHooks.save) {
        await fn.call(payload, payload);
      }

      const realm = await RealmClient.ready();
      let created!: Realm.Object;
      realm.write(() => {
        created = realm.create(name, payload);
      });

      const result = new Model(toPlainObject<T>(created as any), false).toObject();

      // post("save") hooks run AFTER the write succeeds, with the final plain result.
      for (const fn of schema.postHooks.save) {
        await fn.call(result, result);
      }

      return result;
    }

    static async insertMany(dataList: Partial<T>[]): Promise<T[]> {
      const realm = await RealmClient.ready();
      const results: T[] = [];

      realm.write(() => {
        for (const data of dataList) {
          const withDefaults = schema.applyDefaults(data);
          schema.validate(withDefaults);
          const payload: Record<string, unknown> = { ...withDefaults };
          normalizeRelations(schema, payload);
          if (!payload._id) payload._id = new Realm.BSON.UUID();
          const created = realm.create(name, payload);
          results.push(new Model(toPlainObject<T>(created as any), false).toObject());
        }
      });

      return results;
    }

    /** The actual find() execution — always instances internally (needed for populate), converted to plain at the end */
    static _findExec(filter: MongoLikeFilter<T>, options: FindOptions): Promise<any> {
      return (async () => {
        const realm = await RealmClient.ready();
        const normalizedFilter = normalizeIdFields(idFieldNames, filter as Record<string, unknown>);
        const { query, args } = QueryTranslator.translate(normalizedFilter);
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

        // Plain JS objects by default (lean !== false), instances only if lean === false explicitly.
        return options.lean === false ? docs : docs.map((d) => d.toObject());
      })();
    }

    /**
     * Chainable query, Mongoose-style:
     *   await userModel.find({ role: "admin" }).populate("team").sort({ name: 1 }).limit(10);
     * Returns plain JS objects by default (see `FindOptions.lean`).
     */
    static find(filter: MongoLikeFilter<T> = {}, options: FindOptions = {}): Query<T[]> {
      return new Query<T[]>((opts) => Model._findExec(filter, opts), options);
    }

    static findOne(filter: MongoLikeFilter<T> = {}, options: FindOptions = {}): Query<T | null> {
      return new Query<T | null>(async (opts) => {
        const results = (await Model._findExec(filter, { ...opts, limit: 1 })) as T[];
        return results[0] ?? null;
      }, options);
    }

    static findById(id: string, options: FindOptions = {}): Query<T | null> {
      return Model.findOne({ _id: requireObjectId(id, `${name}._id`) } as unknown as MongoLikeFilter<T>, options);
    }

    static async updateOne(filter: MongoLikeFilter<T>, update: Partial<T>): Promise<number> {
      return Model.updateMany(filter, update, true);
    }

    static async updateMany(filter: MongoLikeFilter<T>, update: Partial<T>, onlyFirst = false): Promise<number> {
      const realm = await RealmClient.ready();
      const normalizedFilter = normalizeIdFields(idFieldNames, filter as Record<string, unknown>);
      const { query, args } = QueryTranslator.translate(normalizedFilter);
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
      const normalizedFilter = normalizeIdFields(idFieldNames, filter as Record<string, unknown>);
      const { query, args } = QueryTranslator.translate(normalizedFilter);
      const results = realm.objects(name).filtered(query, ...args);

      const toDelete = onlyFirst ? Array.from(results).slice(0, 1) : Array.from(results);

      // Capture the plain data BEFORE deleting — a Realm.Object becomes
      // unreadable the instant it's removed, and post("remove") needs it.
      const plainDocs = toDelete.map((obj) => new Model(toPlainObject<T>(obj as any), false).toObject());

      for (const plain of plainDocs) {
        for (const fn of schema.preHooks.remove) await fn.call(plain, plain);
      }

      let count = 0;
      realm.write(() => {
        for (const obj of toDelete) {
          realm.delete(obj);
          count++;
        }
      });

      for (const plain of plainDocs) {
        for (const fn of schema.postHooks.remove) await fn.call(plain, plain);
      }

      return count;
    }

    static async count(filter: MongoLikeFilter<T> = {}): Promise<number> {
      const realm = await RealmClient.ready();
      const normalizedFilter = normalizeIdFields(idFieldNames, filter as Record<string, unknown>);
      const { query, args } = QueryTranslator.translate(normalizedFilter);
      return realm.objects(name).filtered(query, ...args).length;
    }

    static async countDocuments(filter: MongoLikeFilter<T> = {}): Promise<number> {
      return Model.count(filter);
    }

    // ---- "findXAndY" shortcuts, exactly like Mongoose ----

    static async findByIdAndUpdate(
      id: string,
      update: Partial<T>,
      options: { new?: boolean } = { new: true }
    ): Promise<T | null> {
      return Model.findOneAndUpdate({ _id: requireObjectId(id, `${name}._id`) } as unknown as MongoLikeFilter<T>, update, options);
    }

    static async findByIdAndDelete(id: string): Promise<T | null> {
      return Model.findOneAndDelete({ _id: requireObjectId(id, `${name}._id`) } as unknown as MongoLikeFilter<T>);
    }

    static async findOneAndUpdate(
      filter: MongoLikeFilter<T>,
      update: Partial<T>,
      options: { new?: boolean } = { new: true }
    ): Promise<T | null> {
      const before = await Model.findOne(filter);
      if (!before) return null;

      await Model.updateOne(filter, update);
      if (options.new === false) return before;
      return Model.findOne(filter);
    }

    static async findOneAndDelete(filter: MongoLikeFilter<T>): Promise<T | null> {
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
      const docs = await Model.find(filter, { lean: true });
      const values = docs.map((d) => (d as Record<string, unknown>)[field as string] as T[K]);
      return Array.from(new Set(values));
    }

    /** MongoDB-style aggregation pipeline: $match, $group, $sort, $project, $limit, $skip, $unwind */
    static async aggregate<R = any>(pipeline: AggregationStage[]): Promise<R[]> {
      const plainDocs = await Model.find({}, { lean: true });
      return Aggregate.run(plainDocs as unknown as Record<string, unknown>[], pipeline) as R[];
    }

    /**
     * Resolves one or more `ref` fields into real documents, Mongoose `.populate()`-style.
     * Works on a single document or an array, on instances or plain JS
     * objects, and batches the requests (a single $in query per field, no
     * matter how many documents — no N+1). Supports projection:
     * populate("author", "name email").
     *
     *   const post = await postModel.findById(id, { populate: [{ path: "author" }] });
     *   // or manually:
     *   await postModel.populate(post, "author");
     *   await postModel.populate(post, ["author", "tags"]);
     */
    static async populate(
      docOrDocs: unknown,
      fieldsInput: PopulateInput | PopulateInput[] | PopulateSpec[]
    ): Promise<any> {
      const isArray = Array.isArray(docOrDocs);
      const list = (isArray ? docOrDocs : [docOrDocs]) as Array<Record<string, unknown>>;
      if (list.length === 0) return docOrDocs;

      const alreadyNormalized =
        Array.isArray(fieldsInput) && (fieldsInput as any[]).every((f) => typeof f === "object" && f !== null && "path" in f);
      const specs: PopulateSpec[] = alreadyNormalized
        ? (fieldsInput as PopulateSpec[])
        : normalizePopulateArgs(Array.isArray(fieldsInput) ? [fieldsInput as PopulateInput[]] : [fieldsInput as PopulateInput]);

      for (const spec of specs) {
        const fieldName = spec.path;
        const rawDef = schema.fields[fieldName];
        if (!rawDef || !isRelation(rawDef)) {
          throw new Error(`populate("${fieldName}"): this field is not a relation in the "${name}" schema.`);
        }
        const relation = rawDef as RelationDefinition;
        const entry = getRegisteredSchema(relation.ref);
        const RefModel = entry?.modelClass;
        if (!RefModel) {
          throw new Error(
            `populate("${fieldName}"): referenced model "${relation.ref}" is not registered. ` +
              `Import its file before connecting.`
          );
        }

        // 1. Gather every id we'll need, across all documents, in one pass.
        const idSet = new Set<string>();
        for (const doc of list) {
          const value = doc[fieldName];
          if (relation.many && Array.isArray(value)) {
            for (const v of value) idSet.add(String(v));
          } else if (value) {
            idSet.add(String(value));
          }
        }
        if (idSet.size === 0) continue;

        // 2. A single $in query to load every referenced document (plain JS objects).
        const refDocs = (await RefModel.find({ _id: { $in: Array.from(idSet).map((v) => ObjectId(v)).filter(Boolean) } } as any, {
          lean: true,
        })) as Record<string, unknown>[];
        const byId = new Map(refDocs.map((d) => [String(d._id), applySelect(d, spec.select)]));

        // 3. Replace the ids with the populated documents (with optional projection) on each document.
        for (const doc of list) {
          const value = doc[fieldName];
          if (relation.many) {
            const arr = Array.isArray(value) ? value : [];
            doc[fieldName] = arr.map((v) => byId.get(String(v))).filter(Boolean);
          } else if (value) {
            doc[fieldName] = byId.get(String(value)) ?? null;
          }
        }
      }

      return isArray ? list : list[0];
    }
  }

  // ---- Wire up schema.methods / schema.statics / schema.virtual(...), Mongoose-style ----

  for (const [methodName, fn] of Object.entries(schema.methods)) {
    (Model.prototype as Record<string, unknown>)[methodName] = fn;
  }
  for (const [staticName, fn] of Object.entries(schema.statics)) {
    (Model as unknown as Record<string, unknown>)[staticName] = fn;
  }
  for (const [virtualName, v] of Object.entries(schema.virtuals)) {
    Object.defineProperty(Model.prototype, virtualName, {
      configurable: true,
      enumerable: false,
      get: v.getter ? function (this: unknown) { return v.getter!.call(this); } : undefined,
      set: v.setter ? function (this: unknown, value: unknown) { v.setter!.call(this, value); } : undefined,
    });
  }

  // toObject()/toJSON() overridden here (rather than on the shared BaseModel
  // class) so they can apply THIS schema's virtuals/transform options.
  (Model.prototype as unknown as { toObject: (opts?: { virtuals?: boolean }) => T }).toObject = function (
    this: Record<string, unknown>,
    opts?: { virtuals?: boolean }
  ): T {
    const { _isNew, ...rest } = this;
    let plain = serializeValue(rest) as Record<string, unknown>;

    const includeVirtuals = opts?.virtuals ?? schema.toObjectOptions.virtuals ?? false;
    if (includeVirtuals) {
      for (const [virtualName, v] of Object.entries(schema.virtuals)) {
        if (v.getter) plain[virtualName] = v.getter.call(this);
      }
    }

    if (schema.toObjectOptions.transform) {
      plain = schema.toObjectOptions.transform(this, plain) ?? plain;
    }

    return plain as T;
  };

  (Model.prototype as unknown as { toJSON: (opts?: { virtuals?: boolean }) => T }).toJSON = function (
    this: Record<string, unknown> & { toObject: (opts?: { virtuals?: boolean }) => T },
    opts?: { virtuals?: boolean }
  ): T {
    let plain = this.toObject({ virtuals: opts?.virtuals ?? schema.toJSONOptions.virtuals }) as Record<string, unknown>;
    if (schema.toJSONOptions.transform) {
      plain = schema.toJSONOptions.transform(this, plain) ?? plain;
    }
    return plain as T;
  };

  return Model as unknown as ModelClass<T>;
}

import Realm from "realm";
import {
  EmbeddedSchemaDefinition,
  FieldDefinition,
  FieldOptions,
  FieldType,
  FieldTypeCtor,
  FieldTypeInput,
  RelationDefinition,
  SchemaDefinitionMap,
  SchemaOptions,
  ToObjectOptions,
} from "./types";
import { createModel, ModelClass } from "./Model";
import { registerSchema, registerModelClass, registerEmbeddedSchemas } from "./registry";
import type { InferSchemaType } from "./infer";

export class ValidationError extends Error {
  constructor(field: string, message: string) {
    super(`Validation failed for "${field}": ${message}`);
    this.name = "ValidationError";
  }
}

/**
 * Returned by `schema.virtual(name)`, exactly like Mongoose's `VirtualType`.
 * Chain `.get(fn)` / `.set(fn)` to define a computed property that isn't
 * stored in Realm at all — it only exists on real model instances
 * (`new Model(...)` or `{ lean: false }`), and is included in
 * `toObject()`/`toJSON()` output only when asked for (`{ virtuals: true }`
 * on the call, or `virtuals: true` in the schema's `toObject`/`toJSON` option).
 */
export class VirtualType {
  getter?: (this: any) => unknown;
  setter?: (this: any, value: unknown) => void;

  get(fn: (this: any) => unknown): this {
    this.getter = fn;
    return this;
  }

  set(fn: (this: any, value: unknown) => void): this {
    this.setter = fn;
    return this;
  }
}

type HookFn = (this: any, doc: any) => void | Promise<void>;
type HookEvent = "save" | "remove";

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
  return typeof def === "object" && def !== null && !Array.isArray(def) && "ref" in def;
}

function isTypeCtor(value: unknown): value is FieldTypeCtor {
  return (
    value === String ||
    value === Number ||
    value === Boolean ||
    value === Date ||
    value === Array ||
    (typeof Buffer !== "undefined" && value === Buffer)
  );
}

/**
 * Turns a native constructor (String, Number, Boolean, Date, Buffer) into
 * its canonical string form. Lets developers write `type: String` exactly
 * like Mongoose, in addition to the plain `type: "string"` form — both work
 * everywhere. `Array` is handled separately by the caller (it doesn't map
 * to a single FieldType — see `buildFieldType`).
 */
function normalizeFieldType(type: FieldTypeInput): FieldType {
  if (type === String) return "string";
  if (type === Number) return "number";
  if (type === Boolean) return "boolean";
  if (type === Date) return "date";
  if (typeof Buffer !== "undefined" && type === Buffer) return "buffer";
  return type as FieldType;
}

/** A bare nested object with neither `type` nor `ref` at its own top level: a Mongoose-style embedded sub-document. */
export function isEmbeddedObject(def: FieldDefinition): def is EmbeddedSchemaDefinition {
  return (
    typeof def === "object" &&
    def !== null &&
    !Array.isArray(def) &&
    !(def instanceof Date) &&
    !isTypeCtor(def) &&
    !("ref" in def) &&
    !("type" in def)
  );
}

/** `field: [{ ...nested... }]` — an array of embedded sub-documents. */
export function isEmbeddedArrayDef(def: FieldDefinition): def is readonly [EmbeddedSchemaDefinition] {
  return Array.isArray(def) && def.length >= 1 && isEmbeddedObject(def[0] as FieldDefinition);
}

/** `field: [String]` — shorthand array of a primitive type. */
export function isPrimitiveArrayDef(def: FieldDefinition): def is readonly [FieldTypeInput] {
  if (!Array.isArray(def) || def.length === 0) return false;
  const el = def[0];
  return typeof el === "string" || isTypeCtor(el);
}

/** Normalizes the "simple field" shorthands (string / ctor / FieldOptions) into a canonical FieldOptions. Not for relations, embedded objects, or array shorthands — check those first. */
function normalizeSimple(def: FieldDefinition): FieldOptions {
  if (typeof def === "string") {
    return { type: def };
  }
  if (isTypeCtor(def)) {
    return { type: def === Array ? "mixed" : normalizeFieldType(def), array: def === Array ? true : undefined };
  }
  const opts = def as FieldOptions;
  if (opts.type === Array) {
    return { ...opts, type: "mixed", array: true };
  }
  return { ...opts, type: normalizeFieldType(opts.type) };
}

interface BuildContext {
  embeddedSchemas: Realm.ObjectSchema[];
  seen: Set<string>;
}

function buildEmbedded(schemaName: string, fields: EmbeddedSchemaDefinition, ctx: BuildContext): void {
  if (ctx.seen.has(schemaName)) return;
  ctx.seen.add(schemaName);
  const properties = buildProperties(schemaName, fields, ctx);
  ctx.embeddedSchemas.push({ name: schemaName, embedded: true, properties });
}

function buildProperties(schemaName: string, fields: SchemaDefinitionMap, ctx: BuildContext): Realm.PropertiesTypes {
  const properties: Realm.PropertiesTypes = {};
  for (const [field, rawDef] of Object.entries(fields)) {
    properties[field] = buildFieldType(schemaName, field, rawDef, ctx);
  }
  return properties;
}

function buildFieldType(parentSchemaName: string, field: string, rawDef: FieldDefinition, ctx: BuildContext): string {
  if (isRelation(rawDef)) {
    // Stored as an _id reference (uuid), Mongoose `ref`-style — not a native Realm link.
    // populate() resolves these ids into real documents on demand.
    return rawDef.many ? "uuid[]" : "uuid?";
  }

  if (isEmbeddedArrayDef(rawDef)) {
    const embeddedName = `${parentSchemaName}_${field}`;
    buildEmbedded(embeddedName, rawDef[0] as EmbeddedSchemaDefinition, ctx);
    return `${embeddedName}[]`;
  }

  if (isPrimitiveArrayDef(rawDef)) {
    const base = TYPE_MAP[normalizeFieldType(rawDef[0] as FieldTypeInput)];
    return `${base}[]`;
  }

  if (isEmbeddedObject(rawDef)) {
    const embeddedName = `${parentSchemaName}_${field}`;
    buildEmbedded(embeddedName, rawDef, ctx);
    return `${embeddedName}?`;
  }

  const opts = normalizeSimple(rawDef);
  const base = TYPE_MAP[opts.type as FieldType];
  const suffix = opts.array ? "[]" : opts.required ? "" : "?";
  return `${base}${suffix}`;
}

export class Schema<T extends object = Record<string, unknown>> {
  public readonly fields: SchemaDefinitionMap;
  public readonly options: Required<Pick<SchemaOptions, "timestamps" | "primaryKey" | "version">>;

  /** Instance methods, Mongoose-style: `schema.methods.getFullName = function () { return this.name; }` */
  public readonly methods: Record<string, (this: any, ...args: any[]) => any> = {};
  /** Static (model-level) methods: `schema.statics.findActive = function () { return this.find({ active: true }); }` */
  public readonly statics: Record<string, (this: any, ...args: any[]) => any> = {};
  /** Computed properties, defined via `schema.virtual(name)` */
  public readonly virtuals: Record<string, VirtualType> = {};
  public readonly preHooks: Record<HookEvent, HookFn[]> = { save: [], remove: [] };
  public readonly postHooks: Record<HookEvent, HookFn[]> = { save: [], remove: [] };
  public readonly toJSONOptions: ToObjectOptions;
  public readonly toObjectOptions: ToObjectOptions;

  constructor(fields: SchemaDefinitionMap, options: SchemaOptions = {}) {
    this.fields = fields;
    this.options = {
      timestamps: options.timestamps ?? false,
      primaryKey: options.primaryKey ?? "_id",
      version: options.version ?? 0,
    };
    this.toJSONOptions = options.toJSON ?? {};
    this.toObjectOptions = options.toObject ?? {};
  }

  /**
   * Builds the Realm ObjectSchema (property map) for this model, dynamically —
   * including any nested embedded sub-document schemas it needs along the way.
   */
  toRealmObjectSchema(name: string): { main: Realm.ObjectSchema; embedded: Realm.ObjectSchema[] } {
    const ctx: BuildContext = { embeddedSchemas: [], seen: new Set() };
    const properties: Realm.PropertiesTypes = {
      [this.options.primaryKey]: this.options.primaryKey === "_id" ? "uuid" : "string",
      ...buildProperties(name, this.fields, ctx),
    };

    if (this.options.timestamps) {
      properties.createdAt = "date";
      properties.updatedAt = "date";
    }

    return {
      main: { name, primaryKey: this.options.primaryKey, properties },
      embedded: ctx.embeddedSchemas,
    };
  }

  /** Applies default values (Mongoose-style) before insertion. Skips relations, embedded objects, and array shorthands. */
  applyDefaults(doc: Partial<T>): Partial<T> {
    const result: Record<string, unknown> = { ...doc };

    for (const [field, rawDef] of Object.entries(this.fields)) {
      if (isRelation(rawDef) || isEmbeddedObject(rawDef) || isEmbeddedArrayDef(rawDef) || isPrimitiveArrayDef(rawDef)) {
        continue;
      }
      const opts = normalizeSimple(rawDef);

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

  /** Validates a document against required / enum / min / max / validate rules, Mongoose-style. Skips relations, embedded objects, and array shorthands. */
  validate(doc: Partial<T>, { partial = false }: { partial?: boolean } = {}): void {
    for (const [field, rawDef] of Object.entries(this.fields)) {
      if (isRelation(rawDef) || isEmbeddedObject(rawDef) || isEmbeddedArrayDef(rawDef) || isPrimitiveArrayDef(rawDef)) {
        continue;
      }
      const opts = normalizeSimple(rawDef);
      const value = (doc as Record<string, unknown>)[field];

      const isMissing = value === undefined || value === null;

      if (!partial && opts.required && isMissing) {
        throw new ValidationError(field, "this field is required");
      }
      if (isMissing) continue;

      if (opts.enum && !opts.enum.includes(value as never)) {
        throw new ValidationError(field, `value "${value}" is not in the allowed enum [${opts.enum.join(", ")}]`);
      }
      if (typeof value === "number") {
        if (opts.min !== undefined && value < opts.min) {
          throw new ValidationError(field, `must be >= ${opts.min}`);
        }
        if (opts.max !== undefined && value > opts.max) {
          throw new ValidationError(field, `must be <= ${opts.max}`);
        }
      }
      if (typeof value === "string") {
        if (opts.minLength !== undefined && value.length < opts.minLength) {
          throw new ValidationError(field, `must be at least ${opts.minLength} characters long`);
        }
        if (opts.maxLength !== undefined && value.length > opts.maxLength) {
          throw new ValidationError(field, `must be at most ${opts.maxLength} characters long`);
        }
      }
      if (opts.validate) {
        const res = opts.validate(value);
        if (res === false) throw new ValidationError(field, "custom validation failed");
        if (typeof res === "string") throw new ValidationError(field, res);
      }
    }
  }

  /**
   * Defines a computed property, Mongoose-style:
   *   userSchema.virtual("fullName").get(function () { return `${this.firstName} ${this.lastName}`; });
   * Only available on real instances (`new Model(...)` or `{ lean: false }`) —
   * never stored in Realm. Add a setter with `.set(fn)` too if you want it writable.
   */
  virtual(name: string): VirtualType {
    const v = new VirtualType();
    this.virtuals[name] = v;
    return v;
  }

  /**
   * Registers a hook that runs BEFORE the operation, Mongoose `pre()`-style.
   * `"save"` covers both `Model.create(...)` and `new Model(...).save()`;
   * `this`/the argument is the plain payload about to be written — mutate it
   * directly (e.g. hash a password) before it's persisted.
   * `"remove"` covers `deleteOne`/`deleteMany`/`doc.remove()`.
   *
   * Note: unlike Mongoose, hooks here are promise-based only (no `next()`
   * callback) — return a Promise (or use `async`) if you need to await something.
   */
  pre(event: HookEvent, fn: HookFn): this {
    this.preHooks[event].push(fn);
    return this;
  }

  /** Registers a hook that runs AFTER the operation succeeds, with the final plain result. */
  post(event: HookEvent, fn: HookFn): this {
    this.postHooks[event].push(fn);
    return this;
  }

  /**
   * Applies a reusable plugin to this schema, Mongoose-style:
   *   schema.plugin(softDeletePlugin, { deletedAtField: "deletedAt" });
   * A plugin is just a function that receives the schema (and your options)
   * and can add methods/statics/virtuals/hooks to it — nothing magic, just
   * a convention for packaging reusable schema behavior.
   */
  plugin<Options = unknown>(fn: (schema: this, options?: Options) => void, options?: Options): this {
    fn(this, options);
    return this;
  }

  /**
   * Equivalent of `mongoose.model("User", userSchema)`.
   * Registers the schema (and any nested embedded schemas it needs) in the
   * global registry (used by `RealmClient.connect`) and returns a
   * ready-to-use Model class (create, find, findOne, save, ...).
   */
  model(name: string): ModelClass<T> {
    const { main, embedded } = this.toRealmObjectSchema(name);
    registerSchema(name, this, main);
    registerEmbeddedSchemas(embedded);
    const ModelClassRef = createModel<T>(name, this);
    registerModelClass(name, ModelClassRef);
    return ModelClassRef;
  }
}

/**
 * Equivalent of `mongoose.Schema(...)`. The document's TypeScript type is
 * inferred automatically from the fields you declare (like Mongoose's
 * `InferSchemaType`) — `.create({ ... })`, `.find({ ... })`, etc. get full
 * autocomplete without writing an interface by hand. You can still force an
 * explicit type with `ormSchema<MyType>(...)` if you prefer.
 *
 * Field types can be written either as a string (`"string"`) or as the
 * native constructor (`String`), exactly like Mongoose. Nested objects and
 * arrays work too:
 *
 *   const userSchema = ormSchema({
 *     name: String,                                    // shorthand, native constructor
 *     age: { type: Number, default: 18 },                // detailed, native constructor
 *     bio: { type: "string", required: false },           // detailed, string literal
 *     tags: [String],                                       // array of strings
 *     address: { street: String, city: String },              // nested embedded sub-document
 *     contacts: [{ phone: String, label: String }],             // array of embedded sub-documents
 *     misc: { type: Array },                                      // generic array of anything (mixed[])
 *   });
 */
export function ormSchema<Fields extends SchemaDefinitionMap, T extends object = InferSchemaType<Fields>>(
  fields: Fields,
  options?: SchemaOptions
): Schema<T> {
  return new Schema<T>(fields, options);
}

/** Extracts a model's document type: `type User = InferModel<typeof userModel>` */
export type InferModel<M> = M extends ModelClass<infer T> ? T : never;

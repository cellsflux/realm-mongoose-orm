/**
 * Field types, mirroring Mongoose's vocabulary but mapped internally to
 * Realm's own property types.
 */
export type FieldType =
  | "string"
  | "number"
  | "int"
  | "boolean"
  | "date"
  | "objectId"
  | "uuid"
  | "mixed"
  | "buffer";

/**
 * Native JS constructors accepted anywhere a `FieldType` is expected, exactly
 * like Mongoose lets you write `type: String` instead of `type: "string"`.
 * Both styles work everywhere — pick whichever reads better to you.
 * `Array` on its own means "an array of anything" (mixed), just like plain
 * `type: Array` in Mongoose — for a typed array, use the `[String]` / `{ type: String, array: true }` forms instead.
 */
export type FieldTypeCtor =
  | StringConstructor
  | NumberConstructor
  | BooleanConstructor
  | DateConstructor
  | BufferConstructor
  | ArrayConstructor;

/** Anything that can appear as a field's `type` (or as the whole shorthand field definition). */
export type FieldTypeInput = FieldType | FieldTypeCtor;

export interface RelationDefinition {
  /** Name of the referenced model, e.g. "User" */
  ref: string;
  /** true = one-to-many relationship (array), false/omitted = one-to-one */
  many?: boolean;
}

export interface FieldOptions<T = unknown> {
  type: FieldTypeInput;
  required?: boolean;
  default?: T | (() => T);
  unique?: boolean;
  index?: boolean;
  enum?: readonly T[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  /** true if this field is an array of the declared type */
  array?: boolean;
  /** Custom validator — return `false`/a string error message to reject a value */
  validate?: (value: T) => boolean | string;
}

/**
 * A nested/embedded sub-document, Mongoose-style: a plain object of fields
 * with no `type` or `ref` key at its own top level, e.g.:
 *   address: { street: String, city: String }
 * Stored as a Realm embedded object — no separate collection, no own _id,
 * deleted automatically along with its parent.
 */
export type EmbeddedSchemaDefinition = SchemaDefinitionMap;

/**
 * A field can be declared several equivalent ways:
 *   name: "string"                                  // shorthand, string literal
 *   name: String                                     // shorthand, native constructor (Mongoose-style)
 *   name: { type: "string", required: true }          // detailed, either type style
 *   name: { type: Array }                               // generic array of anything (mixed[])
 *   name: [String]                                       // shorthand array of a primitive type
 *   name: { street: String, city: String }                // nested embedded sub-document
 *   name: [{ street: String, city: String }]                // array of embedded sub-documents
 */
export type FieldDefinition =
  | FieldTypeInput
  | FieldOptions
  | RelationDefinition
  | EmbeddedSchemaDefinition
  | readonly [FieldTypeInput]
  | readonly [EmbeddedSchemaDefinition];

export interface SchemaDefinitionMap {
  [field: string]: FieldDefinition;
}

export interface SchemaOptions {
  /** Automatically adds createdAt / updatedAt, just like Mongoose */
  timestamps?: boolean;
  /** Field name used as the primary key, defaults to "_id" */
  primaryKey?: string;
  /** Schema version for Realm migrations, defaults to 0 (managed automatically — see SchemaVersionManager) */
  version?: number;
}

/** MongoDB-style query filter: { age: { $gt: 18 } } */
export type MongoLikeFilter<T = Record<string, unknown>> = {
  [K in keyof T]?: T[K] | MongoOperator<T[K]>;
} & { _id?: string | MongoOperator<string> };

export interface MongoOperator<T> {
  $eq?: T;
  $ne?: T;
  $gt?: T;
  $gte?: T;
  $lt?: T;
  $lte?: T;
  $in?: T[];
  $nin?: T[];
  $exists?: boolean;
  $contains?: string;
}

/** Normalized population spec, used internally once all populate() call styles have been parsed */
export interface PopulateSpec {
  path: string;
  select?: string[];
}

/** Anything you can pass to .populate(...), Mongoose-style */
export type PopulateInput = string | { path: string; select?: string | string[] };

export interface FindOptions {
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
  /** Relation fields to resolve automatically, Mongoose populate()-style */
  populate?: PopulateSpec[];
  /**
   * Return plain JS objects (default: true) instead of model instances.
   * Set `lean: false` to get real instances back, with `.save()` /
   * `.populate()` / `.remove()` available on them. By default everything is
   * already a plain object — safe to send as-is over Electron IPC,
   * JSON.stringify, res.json(), etc. (ids are already strings).
   */
  lean?: boolean;
}

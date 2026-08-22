import type {
  FieldDefinition,
  FieldOptions,
  FieldTypeCtor,
  FieldTypeInput,
  RelationDefinition,
  SchemaDefinitionMap,
} from "./types";

/** Maps a field's `type` (string literal OR native constructor) to its TypeScript value type. */
type InferPrimitive<Type extends FieldTypeInput> = Type extends "string"
  ? string
  : Type extends "number" | "int"
  ? number
  : Type extends "boolean"
  ? boolean
  : Type extends "date"
  ? Date
  : Type extends "uuid" | "objectId"
  ? string
  : Type extends "buffer"
  ? Uint8Array
  : Type extends StringConstructor
  ? string
  : Type extends NumberConstructor
  ? number
  : Type extends BooleanConstructor
  ? boolean
  : Type extends DateConstructor
  ? Date
  : Type extends BufferConstructor
  ? Uint8Array
  : Type extends ArrayConstructor
  ? unknown[]
  : unknown;

type FieldValueType<F extends FieldDefinition> = F extends RelationDefinition
  ? F["many"] extends true
    ? (string | Record<string, unknown>)[]
    : string | Record<string, unknown>
  : // Array shorthand: [String] (primitive) or [{ nested: fields }] (embedded sub-document array)
  F extends readonly (infer Elem)[]
  ? Elem extends SchemaDefinitionMap
    ? InferSchemaType<Elem>[]
    : Elem extends FieldTypeInput
    ? InferPrimitive<Elem>[]
    : unknown[]
  : F extends FieldOptions
  ? F["type"] extends ArrayConstructor
    ? unknown[]
    : F["enum"] extends readonly (infer Enum)[]
    ? F["array"] extends true
      ? Enum[]
      : Enum
    : F["array"] extends true
    ? InferPrimitive<F["type"]>[]
    : InferPrimitive<F["type"]>
  : F extends FieldTypeCtor | string
  ? F extends FieldTypeInput
    ? InferPrimitive<F>
    : unknown
  : // Bare nested object, no "type"/"ref" key: a Mongoose-style embedded sub-document
  F extends SchemaDefinitionMap
  ? InferSchemaType<F>
  : unknown;

type IsRequiredField<F extends FieldDefinition> = F extends FieldOptions ? (F["required"] extends true ? true : false) : false;

type RequiredKeys<Fields extends SchemaDefinitionMap> = {
  [K in keyof Fields]: IsRequiredField<Fields[K]> extends true ? K : never;
}[keyof Fields];

type OptionalKeys<Fields extends SchemaDefinitionMap> = {
  [K in keyof Fields]: IsRequiredField<Fields[K]> extends true ? never : K;
}[keyof Fields];

/**
 * Automatically infers a document's TypeScript type from the definition
 * passed to `ormSchema(...)`, exactly like Mongoose's `InferSchemaType`.
 * This is what powers autocomplete on `.create({ ... })`, `.find({ ... })`,
 * etc. without ever writing an interface by hand. Works whether fields are
 * declared with string literals ("string"), native constructors (String),
 * array shorthands ([String], [{ ... }]), or nested embedded sub-documents
 * ({ street: String, city: String }) — recursively, at any depth.
 */
export type InferSchemaType<Fields extends SchemaDefinitionMap> = {
  [K in RequiredKeys<Fields>]: FieldValueType<Fields[K]>;
} & {
  [K in OptionalKeys<Fields>]?: FieldValueType<Fields[K]>;
} & {
  _id?: string;
  createdAt?: Date;
  updatedAt?: Date;
};

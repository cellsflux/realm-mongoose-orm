import type { FieldDefinition, FieldOptions, FieldType, RelationDefinition, SchemaDefinitionMap } from "./types";

type InferPrimitive<Type extends FieldType> = Type extends "string"
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
  : unknown;

type FieldValueType<F extends FieldDefinition> = F extends RelationDefinition
  ? F["many"] extends true
    ? (string | Record<string, unknown>)[]
    : string | Record<string, unknown>
  : F extends FieldOptions
  ? F["enum"] extends readonly (infer Enum)[]
    ? F["array"] extends true
      ? Enum[]
      : Enum
    : F["array"] extends true
    ? InferPrimitive<F["type"]>[]
    : InferPrimitive<F["type"]>
  : F extends FieldType
  ? InferPrimitive<F>
  : unknown;

type IsRequiredField<F extends FieldDefinition> = F extends FieldOptions ? (F["required"] extends true ? true : false) : false;

type RequiredKeys<Fields extends SchemaDefinitionMap> = {
  [K in keyof Fields]: IsRequiredField<Fields[K]> extends true ? K : never;
}[keyof Fields];

type OptionalKeys<Fields extends SchemaDefinitionMap> = {
  [K in keyof Fields]: IsRequiredField<Fields[K]> extends true ? never : K;
}[keyof Fields];

/**
 * Déduit automatiquement le type TypeScript d'un document à partir de la
 * définition passée à `ormSchema(...)`, exactement comme `InferSchemaType`
 * le fait pour Mongoose. Ça donne l'autocomplétion sur `.create({ ... })`,
 * `.find({ ... })`, etc. sans avoir à écrire une interface à la main.
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

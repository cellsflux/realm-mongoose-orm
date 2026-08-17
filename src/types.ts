/**
 * Types de champs supportés, calqués sur le vocabulaire Mongoose
 * mais traduits en interne vers les types Realm.
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

export interface RelationDefinition {
  /** Nom du modèle référencé, ex: "User" */
  ref: string;
  /** true = relation 1-N (liste), false/absent = relation 1-1 */
  many?: boolean;
}

export interface FieldOptions<T = unknown> {
  type: FieldType;
  required?: boolean;
  default?: T | (() => T);
  unique?: boolean;
  index?: boolean;
  enum?: readonly T[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  /** true si le champ est un tableau du type déclaré */
  array?: boolean;
  /** fonction de validation custom, doit renvoyer true/false ou lever une erreur */
  validate?: (value: T) => boolean | string;
}

/** Un champ peut être défini en version courte ("string") ou détaillée ({ type: "string", required: true }) */
export type FieldDefinition = FieldType | FieldOptions | RelationDefinition;

export interface SchemaDefinitionMap {
  [field: string]: FieldDefinition;
}

export interface SchemaOptions {
  /** Ajoute automatiquement createdAt / updatedAt, comme Mongoose */
  timestamps?: boolean;
  /** Nom du champ utilisé comme clé primaire, défaut "_id" */
  primaryKey?: string;
  /** Version du schéma pour les migrations Realm, défaut 0 */
  version?: number;
}

/** Filtre de recherche façon MongoDB: { age: { $gt: 18 } } */
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

/** Spécification normalisée de population (interne) */
export interface PopulateSpec {
  path: string;
  select?: string[];
}

/** Ce que le développeur peut passer à .populate(...), façon Mongoose */
export type PopulateInput = string | { path: string; select?: string | string[] };

export interface FindOptions {
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
  /** Champs de relation à résoudre automatiquement, façon Mongoose populate() */
  populate?: PopulateSpec[];
  /**
   * Renvoie des objets JS bruts (par défaut : true) au lieu d'instances de
   * modèle. Mettez `lean: false` pour récupérer de vraies instances avec
   * `.save()` / `.populate()` / `.remove()`. Par défaut, tout est déjà un
   * objet JS simple — sûr à envoyer tel quel via IPC Electron, JSON.stringify,
   * res.json(), etc. (les ids sont déjà des strings).
   */
  lean?: boolean;
}

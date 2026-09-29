import Realm from "realm";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/** The BSON value types Realm accepts for an id field. */
export type RealmId = Realm.BSON.UUID | Realm.BSON.ObjectId;

/**
 * Cleans up a value that's supposed to be an id: strips surrounding quotes
 * (very common when an id has round-tripped through JSON.stringify, a form
 * field, localStorage, a URL param, ...), trims whitespace, unwraps a
 * populated document (`{ _id: "...", name: "..." }` -> `"..."`), and
 * unwraps an already-built `Realm.BSON.UUID` / `Realm.BSON.ObjectId`
 * instance back to its string form. Returns `null` for anything
 * empty/nullish. Never throws.
 */
export function normalizeId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;

  if (value instanceof Realm.BSON.UUID || value instanceof Realm.BSON.ObjectId) {
    return value.toString();
  }

  if (typeof value === "object" && "_id" in (value as Record<string, unknown>)) {
    return normalizeId((value as Record<string, unknown>)._id);
  }

  let s = String(value).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      s = JSON.parse(s);
    } catch {
      s = s.slice(1, -1);
    }
  }
  s = String(s).trim();
  return s.length > 0 ? s : null;
}

/**
 * Builds the exact BSON value Realm expects for an id field, from *anything*
 * id-shaped: a plain string, a quoted/JSON-escaped string, a populated
 * document (`{ _id, ... }`), or an already-built BSON instance. Detects
 * UUID vs. classic 24-hex-char ObjectId format automatically.
 *
 * This is the single source of truth the whole library uses internally for
 * every `_id` / relation (`ref`) lookup — exported so application code
 * never has to reimplement this conversion (this replaces the
 * `normalizeId` + `toRealmId` pair you'd otherwise write by hand):
 *
 *   import { ObjectId } from "realm-mongoose-orm";
 *   await ClasseModel.find({ sections: ObjectId(rawSectionId) });
 *
 * Returns `null` if the value isn't a recognizable id shape (rather than
 * silently forwarding a raw string that would just never match anything).
 */
export function ObjectId(value: unknown): Realm.BSON.UUID | Realm.BSON.ObjectId | null {
  const id = normalizeId(value);
  if (!id) return null;

  if (UUID_RE.test(id)) {
    try {
      return new Realm.BSON.UUID(id);
    } catch {
      /* fall through to ObjectId / null */
    }
  }
  if (OBJECT_ID_RE.test(id)) {
    try {
      return new Realm.BSON.ObjectId(id);
    } catch {
      /* fall through to null */
    }
  }
  return null;
}

/** Strict variant of `ObjectId()`: throws instead of returning null, for call sites where a valid id is mandatory. */
export function requireObjectId(value: unknown, context = "id"): Realm.BSON.UUID | Realm.BSON.ObjectId {
  const id = ObjectId(value);
  if (!id) {
    throw new Error(`Invalid ${context}: ${JSON.stringify(value)}`);
  }
  return id;
}

/** True if the value looks like *some* kind of id (UUID or ObjectId format), without building the BSON instance. */
export function isObjectIdLike(value: unknown): boolean {
  const id = normalizeId(value);
  if (!id) return false;
  return UUID_RE.test(id) || OBJECT_ID_RE.test(id);
}

/**
 * Recursively normalizes every id-shaped value found under the given field
 * names within a MongoDB-style filter or update payload — including inside
 * operators (`$in`, `$eq`, `$ne`, ...) and arrays. Any other field is left
 * untouched. Used internally so `find`/`updateOne`/`deleteMany`/etc. accept
 * raw strings, quoted strings, or populated documents for `_id` and any
 * `ref` field, without the caller ever having to convert them.
 */
export function normalizeIdFields(idFieldNames: Iterable<string>, input: Record<string, unknown>): Record<string, unknown> {
  const idFields = new Set(idFieldNames);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = idFields.has(key) ? normalizeIdValue(value) : value;
  }
  return out;
}

function normalizeIdValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(normalizeIdValue);

  if (
    typeof value === "object" &&
    !(value instanceof Realm.BSON.UUID) &&
    !(value instanceof Realm.BSON.ObjectId) &&
    !(value instanceof Date)
  ) {
    const keys = Object.keys(value as Record<string, unknown>);
    const isOperatorObject = keys.length > 0 && keys.every((k) => k.startsWith("$"));
    if (isOperatorObject) {
      const out: Record<string, unknown> = {};
      for (const [op, v] of Object.entries(value as Record<string, unknown>)) out[op] = normalizeIdValue(v);
      return out;
    }
    // Not an operator object: likely a populated document ({ _id, ... }) passed directly as a filter value.
    return ObjectId(value) ?? value;
  }

  return ObjectId(value) ?? value;
}

# realm-mongoose-orm

> A TypeScript ORM that gives **Realm** the API and comfort of **Mongoose**:
> `ormSchema()`, `.model()`, auto-generated `_id`, 100% automatic migrations,
> full CRUD, `findXAndY`, aggregations (`$match`, `$group`, `$sort`, ...).

---

## Table of Contents

1. [Why this library](#1-why-this-library)
2. [Installation](#2-installation)
3. [Quick Start](#3-quick-start)
4. [Define a Schema](#4-define-a-schema)
5. [Connect to the Database](#5-connect-to-the-database)
6. [Automatic `_id`](#6-automatic-_id)
7. [Migrations (100% automatic)](#7-migrations-100-automatic)
8. [Full CRUD](#8-full-crud)
9. [MongoDB-style Filters](#9-mongodb-style-filters)
10. [Aggregations](#10-aggregations)
11. [Relations between Models](#11-relations-between-models)
12. [Connection Events](#12-connection-events)
13. [Complete API Reference](#13-complete-api-reference)
14. [Best Practices & Limitations](#14-best-practices--limitations)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. Why this library

Realm is a very high-performance embedded database, but its raw API forces you to:

- write schemas in Realm's own format (`"string?"`, `"double[]"`, ...) instead of a readable Mongoose-like object;
- manually manage a `schemaVersion` and a migration function on every structural change;
- use a textual query language (RQL) instead of object-based filters;
- generate unique identifiers yourself.

**`realm-mongoose-orm` removes all of that.** You write your models as you would with Mongoose, you call `connectDB()`, and the library handles the rest: identifiers, migrations, query translation.

This library is specifically designed for Electron + Vite projects.

---

## 2. Installation

```bash
npm install
npm run build
```

> ⚠️ **Network required during installation.** The `realm` package downloads a precompiled native binary from `static.realm.io` during `npm install`. Once installed, the application works entirely offline (embedded local database, no server to start).

## 3. Quick Start

```ts
import { ormSchema, connectDB } from "realm-mongoose-orm";

// 1. Define a schema, like with Mongoose
const userSchema = ormSchema(
  {
    name: { type: "string", required: true },
    email: { type: "string", required: true, unique: true },
    age: { type: "number", default: 18 },
  },
  { timestamps: true },
);

// 2. Create the model
export const userModel = userSchema.model("User");

// 3. Connect (once, at application startup)
await connectDB({ path: "app.realm" });

// 4. Use the model
const user = await userModel.create({ name: "Alice", email: "alice@test.com" });
console.log(user.toObject());
```

That's it. No `schemaVersion`, no manual migration, no manual `_id` generation.

---

## 4. Define a Schema

```ts
const productSchema = ormSchema(
  {
    title: { type: "string", required: true, minLength: 3, maxLength: 120 },
    price: { type: "number", required: true, min: 0 },
    category: { type: "string", enum: ["food", "tech", "clothing"] as const },
    inStock: { type: "boolean", default: true },
    tags: { type: "string", array: true }, // array of strings
    publishedAt: { type: "date", default: () => new Date() }, // dynamic default
    owner: { ref: "User" }, // 1-1 relation
    reviews: { ref: "Review", many: true }, // 1-N relation
  },
  {
    timestamps: true, // adds createdAt / updatedAt automatically
    primaryKey: "_id", // by default, no need to specify it
  },
);

export const productModel = productSchema.model("Product");
```

### Available Field Types

| Mongoose-like Type | Underlying Realm Type |
| ------------------ | --------------------- |
| `"string"`         | `string`              |
| `"number"`         | `double`              |
| `"int"`            | `int`                 |
| `"boolean"`        | `bool`                |
| `"date"`           | `date`                |
| `"objectId"`       | `objectId`            |
| `"uuid"`           | `uuid`                |
| `"mixed"`          | `mixed`               |
| `"buffer"`         | `data`                |

### Field Validation Options

| Option                    | Effect                                                             |
| ------------------------- | ------------------------------------------------------------------ |
| `required`                | Field is required at creation                                      |
| `default`                 | Value (or function) applied if the field is absent                 |
| `unique`                  | Marks the field as unique (to be validated in your business logic) |
| `enum`                    | List of allowed values                                             |
| `min` / `max`             | Numeric bounds                                                     |
| `minLength` / `maxLength` | String length bounds                                               |
| `array`                   | The field is an array of the declared type                         |
| `validate`                | Custom function `(value) => boolean \| string`                     |

---

## 5. Connect to the Database

```ts
import { connectDB, disconnectDB, RealmClient } from "realm-mongoose-orm";

await connectDB({
  path: "app.realm", // local file, ":memory:" for testing
  silent: false, // false = log connection to console
});

// ... your application ...

disconnectDB();
```

- **Singleton**: `connectDB()` reuses the existing connection if called multiple times (like `mongoose.connect`).
- **Automatic model loading**: if your schemas are in a separate folder, load them before connecting:

  ```ts
  RealmClient.loadModels("./src/models"); // require() all .ts/.js in the folder
  await connectDB({ path: "app.realm" });
  ```

---

## 6. Automatic `_id`

You **never** need to provide or generate an `_id`:

```ts
const user = await userModel.create({ name: "Alice", email: "a@test.com" });
console.log(user.toObject()._id); // Automatically generated UUID
```

Internally, every `create()` / `insertMany()` generates a `Realm.BSON.UUID()` if `_id` is not provided — exactly like Mongoose generates an `ObjectId`. To find a document by id (e.g., from an HTTP route where the id arrives as a `string`), simply use the string:

```ts
await userModel.findById(id);
await userModel.findByIdAndUpdate(id, { age: 26 });
await userModel.findByIdAndDelete(id);
```

The `string -> UUID` conversion is handled automatically by the library.

---

## 7. Migrations (100% automatic)

**This is the most important feature: you never write migrations by hand.**

Realm normally requires a manually incremented `schemaVersion` and an `onMigration` function on every structural change. This library fully automates this mechanism:

1. On every `connectDB()`, it compares the current schema (your `ormSchema`) with the one from the last connection (saved in `<file>.meta.json` next to your database).
2. If nothing changed → nothing happens, the version stays the same.
3. If a field was **added** → the version is automatically incremented and its `default` value (if defined in the schema) is applied to all existing documents.
4. If a field was **removed** → Realm removes it on its own, no action needed.

**Concrete example:**

```ts
// Version 1 of the schema
const userSchema = ormSchema({
  name: { type: "string", required: true },
});

// ... later, you add a field ...

// Version 2 (just modified in code, nothing else to do)
const userSchema = ormSchema({
  name: { type: "string", required: true },
  role: { type: "string", default: "user" }, // <- new field
});
```

On the next application startup, `connectDB()` detects the new `role` field, automatically increments the version, and fills `"user"` for all existing users. **No migration code to write.**

### Expert Mode (optional)

For a complex case (field renaming, data transformation), you can still provide your own logic, executed **in addition to** the auto-migration:

```ts
import { connectDB, defineMigration } from "realm-mongoose-orm";

await connectDB({
  path: "app.realm",
  onMigration: defineMigration((m, oldVersion) => {
    if (oldVersion < 3) {
      m.renameField("User", "fullName", "name");
      m.transform("User", (old, updated) => {
        updated.email = String(old.email).toLowerCase();
      });
    }
  }),
});
```

| `MigrationBuilder` Method          | Usage                                                      |
| ---------------------------------- | ---------------------------------------------------------- |
| `renameField(model, from, to)`     | Copies the old value to the new field name                 |
| `fillDefault(model, field, value)` | Fills a default value if absent                            |
| `transform(model, fn)`             | Custom transformation, protected by try/catch per document |

---

## 8. Full CRUD

```ts
// Create
const user = await userModel.create({ name: "Alice", email: "a@test.com" });
const users = await userModel.insertMany([
  { name: "Bob", email: "b@test.com" },
]);

// new + save() (Mongoose document style)
const doc = new userModel({ name: "Carla", email: "c@test.com" });
await doc.save();

// Read
await userModel.find(
  { age: { $gte: 18 } },
  { sort: { name: 1 }, limit: 10, skip: 0 },
);
await userModel.findOne({ email: "a@test.com" });
await userModel.findById(id);
await userModel.count();
await userModel.countDocuments({ role: "admin" });
await userModel.exists({ email: "a@test.com" });
await userModel.distinct("role");

// Update
await userModel.updateOne({ email: "a@test.com" }, { age: 26 });
await userModel.updateMany({ role: "user" }, { isActive: true });
await userModel.findByIdAndUpdate(id, { age: 27 }); // returns updated doc
await userModel.findOneAndUpdate(
  { email: "a@test.com" },
  { age: 28 },
  { new: false },
); // returns old doc

// Delete
await userModel.deleteOne({ email: "a@test.com" });
await userModel.deleteMany({ isActive: false });
await userModel.findByIdAndDelete(id);
await userModel.findOneAndDelete({ email: "a@test.com" });

// Instance
await doc.save();
await doc.remove();
doc.toObject(); // raw JS object
doc.toJSON(); // alias, handy for res.json(doc)
```

---

## 9. MongoDB-style Filters

```ts
await userModel.find({
  age: { $gte: 18, $lte: 65 },
  role: { $in: ["admin", "user"] },
  email: { $exists: true },
  name: { $contains: "ali" }, // case-insensitive search
});
```

Supported operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$contains`.

---

## 10. Aggregations

In-memory pipeline like Mongoose's `Model.aggregate([...])`:

```ts
const stats = await userModel.aggregate([
  { $match: { isActive: true } },
  {
    $group: {
      _id: "$role",
      total: { $count: "$_id" },
      avgAge: { $avg: "$age" },
      maxAge: { $max: "$age" },
    },
  },
  { $sort: { total: -1 } },
  { $limit: 5 },
]);
// [{ _id: "user", total: 12, avgAge: 27.4, maxAge: 41 }, ...]
```

Supported stages: `$match`, `$group` (`$sum`, `$avg`, `$min`, `$max`, `$count`, `$push`, `$addToSet`, `$first`, `$last`), `$sort`, `$skip`, `$limit`, `$project`, `$unwind`.

---

## 11. Relations between Models

```ts
const reviewSchema = ormSchema({
  text: { type: "string", required: true },
  author: { ref: "User" }, // simple relation
});

const productSchema = ormSchema({
  title: { type: "string", required: true },
  reviews: { ref: "Review", many: true }, // list of relations
});
```

> Referenced models must be registered (via `.model(...)`) **before** `connectDB()`, regardless of import order, as long as the file is loaded.

Internally, a `{ ref: "..." }` field is stored as a simple **id** (uuid), exactly like an `ObjectId` with `ref` in Mongoose — not as a native Realm link. You can create a document by passing either the id or the full document; the relation is automatically normalized:

```ts
const post = await postModel.create({
  title: "My article",
  content: "...",
  author: alice, // or directly: author: alice.toObject()._id
});
```

### `populate()`, exactly like Mongoose

**Option 1 — directly in the query**, like `Model.findById(id).populate("author")`:

```ts
const post = await postModel.findById(id, { populate: ["author"] });
console.log(post?.toObject().author); // { _id, name, email, ... } instead of a plain id

const posts = await postModel.find({}, { populate: ["author"] });
```

**Option 2 — manually, on an already loaded document**, like `doc.populate("field")`:

```ts
const post = await postModel.findOne({ title: "My article" });
await post?.populate("author"); // single field
await post?.populate(["author", "tags"]); // multiple fields
```

**Option 3 — on a batch of documents at once** (a single `$in` query per field, regardless of document count — no N+1):

```ts
const posts = await postModel.find({});
await postModel.populate(posts, ["author"]);
```

For a `many: true` relation, `populate()` replaces the array of ids with the array of resolved documents.

---

## 12. Connection Events

`RealmClient` is an `EventEmitter`:

```ts
import { RealmClient } from "realm-mongoose-orm";

RealmClient.on("connecting", () => console.log("Connecting..."));
RealmClient.on("connected", () => console.log("Connected!"));
RealmClient.on("disconnected", () => console.log("Disconnected."));
RealmClient.on("error", (err) => console.error("Realm error:", err));

RealmClient.getState(); // "disconnected" | "connecting" | "connected" | "error"
RealmClient.isConnected(); // boolean
```

---

## 13. Complete API Reference

### `ormSchema(fields, options?) => Schema`

Creates a schema definition. `options.timestamps` adds `createdAt`/`updatedAt`.

### `schema.model(name) => ModelClass`

Registers the schema and returns the model class usable for CRUD.

### `connectDB(options?) => Promise<Realm>`

Simplified connection. `options.path`, `options.silent`, expert mode: `options.schemaVersion`, `options.onMigration`.

### `disconnectDB() => void`

Closes the connection.

### `RealmClient`

Singleton exposing `.connect()`, `.close()`, `.getRealm()`, `.isConnected()`, `.getState()`, `.loadModels(dir)`, and the `connecting` / `connected` / `disconnected` / `error` events.

### Static Model Methods

`create`, `insertMany`, `find`, `findOne`, `findById`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `count`, `countDocuments`, `exists`, `distinct`, `findByIdAndUpdate`, `findByIdAndDelete`, `findOneAndUpdate`, `findOneAndDelete`, `aggregate`, `populate(docOrDocs, fields)`.

### Instance Methods

`save()`, `remove()`, `populate(fields)`, `toObject()`, `toJSON()`.

---

## 14. Best Practices & Limitations

- **Always import your model files before `connectDB()`** — it's the import that registers the schema in the global registry.
- **The `<db>.meta.json` file** created next to your `.realm` is used to detect schema changes: do not delete it manually in production (otherwise the next migration won't know what changed).
- **`unique`** is a documented intention but is not (yet) natively enforced by Realm at the engine level; add an application-level check if it's critical (e.g., `exists({ email })` before `create`).
- **`aggregate()`** works in-memory (loads documents then applies the pipeline) — perfect for collections of reasonable size, not designed for massive data-warehouse-style aggregations.

---

## 15. Troubleshooting

**`Realm is not connected`**
→ Call `connectDB()` before any model call.

**`No schema registered`**
→ Your model files were not imported before `connectDB()`. Import them explicitly or use `RealmClient.loadModels("./models")`.

**Network error during `npm install`**
→ The `realm` package downloads a native binary from `static.realm.io`. Check your internet connection / corporate proxy.

---

## Vite-specific Configuration for Electron Projects

In your `vite.config.js` file:

```ts
electron({
  main: {
    entry: "[your entry]/main.ts",

    vite: {
      build: {
        outDir: "[your output]/main",
        emptyOutDir: true,

        rolldownOptions: {
          external: ["realm"],
        },
      },

      optimizeDeps: {
        exclude: ["realm"],
      },

      // ... rest of your config
    },
  },
  // ... rest of your electron config
});
```

---

## Project Structure

```
src/
  types.ts               // Field types, Mongo-style filters
  Schema.ts              // ormSchema(), validation, conversion to Realm
  QueryTranslator.ts     // { age: { $gt: 18 } } -> Realm query (RQL)
  Aggregate.ts           // MongoDB-style aggregation pipeline
  Model.ts               // Full CRUD + findXAndY
  MigrationBuilder.ts    // "Safe" migration helpers
  SchemaVersionManager.ts // Schema detection + automatic migration
  RealmClient.ts         // connectDB(), events, singleton
  registry.ts            // Global registry of declared schemas
  example/               // Complete usage example
```

```

```

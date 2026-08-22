# realm-mongoose-orm

> A TypeScript ORM that gives **Realm** the API and comfort of **Mongoose**:
> `ormSchema()`, `.model()`, auto-generated `_id`, fully automatic migrations
> (however complex the change), full CRUD returning plain JS objects,
> `findXAndY` shortcuts, `populate()` with field projection, and MongoDB-style
> aggregation (`$match`, `$group`, `$sort`, ...).

Realm is a fast, embedded database — but its raw API is a world away from
the ergonomics most Node/TypeScript developers are used to from Mongoose.
This library closes that gap: you write schemas and queries the way you
already know, and it handles the Realm-specific plumbing (property types,
schema versioning, query syntax, id generation) behind the scenes.

---

## Table of contents

1. [Why this library](#1-why-this-library)
2. [Installation](#2-installation)
3. [Quick start](#3-quick-start)
4. [Defining a schema](#4-defining-a-schema)
5. [Connecting to the database](#5-connecting-to-the-database)
6. [Automatic `_id` + plain JS objects](#6-automatic-_id--plain-js-objects)
7. [Migrations — fully automatic, however complex](#7-migrations--fully-automatic-however-complex)
8. [Full CRUD](#8-full-crud)
9. [Chainable queries (`Query`)](#9-chainable-queries-query)
10. [MongoDB-style filters, with autocomplete](#10-mongodb-style-filters-with-autocomplete)
11. [Aggregation](#11-aggregation)
12. [Relations & `populate()`](#12-relations--populate)
13. [Connection events](#13-connection-events)
14. [Full API reference](#14-full-api-reference)
15. [Best practices & limitations](#15-best-practices--limitations)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. Why this library

Realm is a fantastic embedded database, but working with it directly means:

- writing schemas in Realm's own format (`"string?"`, `"double[]"`, ...)
  instead of a readable, Mongoose-shaped object;
- manually bumping a `schemaVersion` and writing a migration function
  every single time your data model changes — get this wrong and Realm
  refuses to open the database at all;
- using a text-based query language (RQL) instead of familiar filter objects;
- generating your own unique ids;
- getting back raw class instances or native `Realm.BSON.UUID` buffers that
  don't survive `JSON.stringify`, an IPC channel, or `res.json()` cleanly.

**`realm-mongoose-orm` removes all of that friction.** Define your models the
way you would with Mongoose, call `connectDB()`, and let the library take
care of ids, schema migrations, query translation, and serialization.

---

## 2. Installation

```bash
npm install realm-mongoose-orm realm
npm run build
```

> ⚠️ **Network access required at install time.** The `realm` package
> downloads a precompiled native binary during `npm install`. Once
> installed, your app runs fully offline (it's a local, embedded database —
> no server to run).
>
> **Using Electron?** The native binary needs to match Electron's Node ABI,
> not plain Node's. Install `@electron/rebuild` and run
> `npx electron-rebuild -f -w realm` after every install. If you bundle with
> Vite, webpack, or esbuild, make sure `realm` is marked **external** —
> never bundled — since it ships a native `.node` file that bundlers can't
> process. See [Troubleshooting](#16-troubleshooting) for the full picture.

---

## 3. Quick start

```ts
import { ormSchema, connectDB } from "realm-mongoose-orm";

// 1. Define a schema, Mongoose-style
const userSchema = ormSchema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    age: { type: Number, default: 18 },
  },
  { timestamps: true },
);

// 2. Create the model
export const userModel = userSchema.model("User");

// 3. Connect once, at app startup
await connectDB({ path: "app.realm" });

// 4. Use the model — you get a plain JS object back, ready to use
const user = await userModel.create({ name: "Alice", email: "alice@test.com" });
console.log(user); // { _id: "a2658a17-...", name: "Alice", email: "...", age: 18, ... }
```

That's it. No `schemaVersion` to manage, no migration to write by hand, no
id generation, no `.toObject()` conversion step.

---

## 4. Defining a schema

```ts
const productSchema = ormSchema(
  {
    title: { type: String, required: true, minLength: 3, maxLength: 120 },
    price: { type: Number, required: true, min: 0 },
    category: { type: String, enum: ["food", "tech", "clothing"] as const },
    inStock: { type: Boolean, default: true },
    tags: { type: String, array: true }, // array of strings
    publishedAt: { type: Date, default: () => new Date() }, // dynamic default
    owner: { ref: "User" }, // one-to-one relation
    reviews: { ref: "Review", many: true }, // one-to-many relation
  },
  {
    timestamps: true, // adds createdAt / updatedAt automatically
    primaryKey: "_id", // this is already the default, no need to set it explicitly
  },
);

export const productModel = productSchema.model("Product");
```

### Two equally valid ways to write a field's type

Exactly like Mongoose, you can use either a native JS constructor or a
string literal — pick whichever reads better to you, both are fully
supported everywhere:

```ts
name: { type: String, required: true }     // native constructor (Mongoose-style)
name: { type: "string", required: true }    // string literal
name: String                                 // bare shorthand, no options
name: "string"                                // bare shorthand, string literal
```

| Native constructor | String literal | Realm property type |
| ------------------ | -------------- | ------------------- |
| `String`           | `"string"`     | `string`            |
| `Number`           | `"number"`     | `double`            |
| —                  | `"int"`        | `int`               |
| `Boolean`          | `"boolean"`    | `bool`              |
| `Date`             | `"date"`       | `date`              |
| —                  | `"objectId"`   | `objectId`          |
| —                  | `"uuid"`       | `uuid`              |
| —                  | `"mixed"`      | `mixed`             |
| `Buffer`           | `"buffer"`     | `data`              |

### Validation options, per field

| Option                    | Effect                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `required`                | Field must be provided when creating a document                                     |
| `default`                 | Value (or function) applied when the field is missing                               |
| `unique`                  | Documents this field as unique (see [limitations](#15-best-practices--limitations)) |
| `enum`                    | List of allowed values                                                              |
| `min` / `max`             | Numeric bounds                                                                      |
| `minLength` / `maxLength` | String length bounds                                                                |
| `array`                   | Marks the field as an array of the declared type                                    |
| `validate`                | Custom validator: `(value) => boolean \| string`                                    |

### Nested objects, embedded arrays, and `Array`

Just like Mongoose, you can nest a plain object of fields directly — no
need to declare a separate schema for it. It becomes a Realm **embedded
object**: no separate collection, no own `_id`, and it's deleted
automatically along with its parent.

```ts
const userSchema = ormSchema({
  name: { type: String, required: true },

  // Nested sub-document (embedded object) — just write the fields directly:
  address: { street: String, city: String, zip: String },

  // Array of embedded sub-documents:
  contacts: [{ phone: String, label: String }],

  // Shorthand array of a primitive type:
  tags: [String],

  // Generic array of anything (mixed), exactly like Mongoose's plain `type: Array`:
  metadata: { type: Array },
});

const user = await userModel.create({
  name: "Alice",
  address: { street: "1 Main St", city: "Springfield", zip: "00000" },
  contacts: [
    { phone: "+1...", label: "mobile" },
    { phone: "+2...", label: "work" },
  ],
  tags: ["vip", "beta"],
  metadata: [1, "anything", true],
});

console.log(user.address.city); // "Springfield" — already a plain object, no populate() needed
console.log(user.contacts[0].phone); // "+1..." — already a plain array of plain objects
```

Nesting works at any depth (an embedded object can itself contain another
embedded object or embedded array), and autocomplete follows along
recursively — `create({ address: { ... } })` suggests `street`, `city`,
`zip` exactly like the top-level fields do.

> Nested objects are **not** the same thing as [relations](#12-relations--populate)
> (`{ ref: "User" }`): a relation points at a document in another
> collection and needs `populate()` to resolve; a nested object is embedded
> directly inside its parent document and is always already there — no
> extra query needed.
>
> One small caveat, exactly like Mongoose itself: a nested field object
> can't have its own top-level `type` or `ref` key (that's how the library
> tells a nested schema apart from a field descriptor). If you genuinely
> need a nested field literally named `type`, wrap it as `{ type: { type: String } }`
> — the same workaround Mongoose documents for this exact case.

---

## 5. Connecting to the database

```ts
import { connectDB, disconnectDB, RealmClient } from "realm-mongoose-orm";

await connectDB({
  path: "app.realm", // local file, or ":memory:" for tests
  silent: false, // false = log the connection to the console
});

// ... your app runs ...

disconnectDB();
```

- **Singleton behavior**: calling `connectDB()` more than once reuses the
  existing connection (just like `mongoose.connect`).
- **Loading models from a separate folder**: if your schemas live in their
  own directory, load them before connecting:

  ```ts
  RealmClient.loadModels("./src/models"); // require()s every .ts/.js file in the folder
  await connectDB({ path: "app.realm" });
  ```

---

## 6. Automatic `_id` + plain JS objects

You never need to provide or generate an `_id`:

```ts
const user = await userModel.create({ name: "Alice", email: "a@test.com" });
console.log(user._id); // "a2658a17-3c6a-44d1-8891-fe9d8c828..." — a string, not a buffer
console.log(user.name); // "Alice" — a plain JS object, ready to use directly
```

Every `create()` / `insertMany()` generates a `Realm.BSON.UUID()` under the
hood when `_id` isn't provided — exactly like Mongoose generates an
`ObjectId`.

**Every method returns a plain JS object by default** — `create`, `find`,
`findOne`, `findById`, `findByIdAndUpdate`, `insertMany`, and so on. No
conversion step, no class to learn. This matters a lot with **Electron** in
particular: `ipcMain.handle` serializes its response using the _structured
clone_ algorithm, which **ignores** custom `toJSON()` methods on classes.
Returning a raw model instance over IPC used to leak internal fields and
buffer-encoded ids — that's no longer possible, since you're already
holding an ordinary JS object:

```ts
ipcMain.handle("user:getProfile", async () => {
  return userModel.findOne({ _id: currentUserId }); // already a clean object, id already a string
});
```

All ids — including those inside documents resolved by `populate()` — are
recursively serialized to strings. You will never get a raw buffer like
`{ sub_type: 4, buffer: {...} }` in your output.

To look a document up by id (say, from an HTTP route or an IPC channel
where the id arrives as a `string`), just pass the string directly:

```ts
await userModel.findById(id);
await userModel.findByIdAndUpdate(id, { age: 26 });
await userModel.findByIdAndDelete(id);
```

The `string -> UUID` conversion happens automatically.

> Need a real instance instead (to chain `.save()` / `.populate()` on it
> later)? Pass `{ lean: false }` — see [§9](#9-chainable-queries-query).

---

## 7. Migrations — fully automatic, however complex

**This is the core promise of the library: you never write a migration by hand.**

Realm normally requires a manually incremented `schemaVersion` and an
`onMigration` function every time your data model changes. This library
automates that mechanism entirely:

1. On every `connectDB()`, it compares your current schema (your
   `ormSchema` declarations) against the one from the last **successful**
   connection (saved in a `<file>.meta.json` next to your database — only
   written after a `Realm.open()` that actually succeeded, so it never
   drifts out of sync with the real database).
2. Nothing changed → nothing happens, the version stays the same.
3. **A field was added** → the version is bumped automatically, and its
   `default` value (if declared) is applied to every existing document.
4. **A field was removed** → Realm drops it — and its data — on its own,
   nothing to do.
5. **A field was removed AND another was added, of the same type, in the
   same model, at the same time** (e.g. you renamed `by` to `By`, or
   `fullName` to `name`) → this is automatically detected as a **rename**:
   the value is copied over to the new name, no data lost. **Multiple
   simultaneous renames in the same model are handled correctly too** —
   each removed field is paired with the first still-available added field
   of the same type.

### A concrete example (adding a field)

```ts
// Version 1 of the schema
const userSchema = ormSchema({
  name: { type: String, required: true },
});

// ... later, you add a field ...

// Version 2 (just edit the code, nothing else to do)
const userSchema = ormSchema({
  name: { type: String, required: true },
  role: { type: String, default: "user" }, // <- new field
});
```

The next time your app starts, `connectDB()` detects the new `role` field,
bumps the version automatically, and backfills `"user"` for every existing
user. **No migration code to write.**

### A concrete example (rename detected automatically)

```ts
// Before
const productSchema = ormSchema({ by: { type: Number } });

// After: just rename the field in your code
const productSchema = ormSchema({ By: { type: Number } });
```

On restart, the library notices that `by` disappeared and `By` (same type)
appeared → it automatically copies the value from `by` to `By` for every
existing document, with nothing extra required from you.

> ⚠️ Edge case: if you add a field AND rename another field of the exact
> same type at the same time, in the same model, the automatic pairing
> could occasionally guess the wrong match. In that rare case, spell out the
> exact intent with `m.renameField(...)` in expert mode below — the
> automatic behavior is correct for the overwhelming majority of changes.

### Expert mode (optional)

For a genuinely complex case (a subtler data transformation), you can
always supply your own logic, run **in addition to** the automatic migration:

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

| `MigrationBuilder` method          | What it does                                                 |
| ---------------------------------- | ------------------------------------------------------------ |
| `renameField(model, from, to)`     | Copies the old field's value to the new field name           |
| `fillDefault(model, field, value)` | Backfills a default value where the field is missing         |
| `transform(model, fn)`             | Custom transformation, protected by a per-document try/catch |

---

## 8. Full CRUD

```ts
// Create
const user = await userModel.create({ name: "Alice", email: "a@test.com" });
const users = await userModel.insertMany([
  { name: "Bob", email: "b@test.com" },
]);

// new + save() (Mongoose document-style)
const doc = new userModel({ name: "Carla", email: "c@test.com" });
await doc.save();

// Read — find/findOne/findById return a CHAINABLE Query (see §9)
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
await userModel.findByIdAndUpdate(id, { age: 27 }); // returns the updated document
await userModel.findOneAndUpdate(
  { email: "a@test.com" },
  { age: 28 },
  { new: false },
); // returns the old document

// Delete
await userModel.deleteOne({ email: "a@test.com" });
await userModel.deleteMany({ isActive: false });
await userModel.findByIdAndDelete(id);
await userModel.findOneAndDelete({ email: "a@test.com" });

// Instance
await doc.save();
await doc.remove();
await doc.populate("author"); // resolves a relation field on this document
doc.toObject(); // plain JS object, ids already stringified
doc.toJSON(); // alias, handy for res.json(doc) or an IPC response
```

---

## 9. Chainable queries (`Query`)

`find()`, `findOne()`, and `findById()` don't return a Promise directly —
they return a **chainable, "thenable" `Query`** object. You can `await` it
directly, or chain methods on it before `await`ing — either way, the query
only actually runs once it's awaited. **The result is a plain JS object by
default**, ready to return as-is (IPC, `res.json()`, ...):

```ts
// Exactly the Mongoose syntax you're used to:
const posts = await postModel
  .find({ title: "First post" })
  .populate("author") // resolves the relation
  .sort({ createdAt: -1 })
  .skip(0)
  .limit(20);

console.log(posts[0].author.name); // already populated, already a plain object

// populate() with projection (select), exactly like Mongoose:
await postModel.find({}).populate("author", "name email"); // path + select (space-separated string)
await postModel.find({}).populate("author", ["name", "email"]); // path + select (array)
await postModel.find({}).populate({ path: "author", select: "name email" });
await postModel
  .find({})
  .populate([{ path: "author", select: "name" }, { path: "tags" }]);

// Multiple paths at once, no select (Mongoose "path1 path2" style):
await postModel.find({}).populate("author tags");

// No chaining at all still works exactly as before:
const all = await userModel.find({ isActive: true });

// Need a real model instance (to chain .save()/.populate() on it later)
// instead of a plain object:
const doc = await userModel.findOne({ email: "a@test.com" }).lean(false);
await doc?.save();
```

| `Query` method                                                               | Mongoose equivalent |
| ---------------------------------------------------------------------------- | ------------------- |
| `.populate(path)` / `.populate(path, select)` / `.populate([{path,select}])` | `.populate(...)`    |
| `.sort(spec)`                                                                | `.sort(spec)`       |
| `.limit(n)`                                                                  | `.limit(n)`         |
| `.skip(n)`                                                                   | `.skip(n)`          |
| `.lean()` / `.lean(false)`                                                   | `.lean()`           |

---

## 10. MongoDB-style filters, with autocomplete

Thanks to the type automatically inferred from your `ormSchema` (§4), the
filter object gets autocomplete on your model's real field names — your
editor will suggest `name`, `email`, `age`, `role`, and so on:

```ts
await userModel.find({
  age: { $gte: 18, $lte: 65 },
  role: { $in: ["admin", "user"] },
  email: { $exists: true },
  name: { $contains: "ali" }, // case-insensitive search
});
```

Supported operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`,
`$nin`, `$exists`, `$contains`.

---

## 11. Aggregation

An in-memory pipeline, Mongoose/MongoDB `Model.aggregate([...])`-style:

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

Supported stages: `$match`, `$group` (`$sum`, `$avg`, `$min`, `$max`,
`$count`, `$push`, `$addToSet`, `$first`, `$last`), `$sort`, `$skip`,
`$limit`, `$project`, `$unwind`.

---

## 12. Relations & `populate()`

```ts
const reviewSchema = ormSchema({
  text: { type: String, required: true },
  author: { ref: "User" }, // simple relation
});

const productSchema = ormSchema({
  title: { type: String, required: true },
  reviews: { ref: "Review", many: true }, // list of relations
});
```

> Referenced models must be registered (via `.model(...)`) **before**
> `connectDB()` — the order of file imports doesn't matter, as long as the
> file gets loaded.

Under the hood, a `{ ref: "..." }` field is stored as a plain **id** (uuid)
— exactly like an `ObjectId` with `ref` in Mongoose — not as a native Realm
link. You can create a document by passing either the id or the full
document; the relation is normalized automatically either way:

```ts
const post = await postModel.create({
  title: "My post",
  content: "...",
  author: alice, // or directly: author: alice._id
});
```

### `populate()`, exactly like Mongoose (with `select` projection)

**Option 1 — directly in the query**, like `Model.findById(id).populate("author")`:

```ts
const post = await postModel.findById(id, { populate: [{ path: "author" }] });
console.log(post?.author); // { _id, name, email, ... } instead of a plain id — already a plain object

// With projection: only fetch specific fields from the populated document
const lightPost = await postModel.findById(id, {
  populate: [{ path: "author", select: ["name", "email"] }],
});
console.log(lightPost?.author); // { _id, name, email } — password, etc. excluded

const posts = await postModel.find({}, { populate: [{ path: "author" }] });
```

**Option 2 — manually, on an already-fetched document** (works on either a
plain object or an instance):

```ts
const post = await postModel.findOne({ title: "My post" }, { lean: false }); // instance -> .populate() available
await post?.populate("author"); // a single field
await post?.populate("author", "name email"); // with projection
await post?.populate([{ path: "author", select: "name" }]);

// Or directly on a plain object, via the static method:
const plainPost = await postModel.findOne({ title: "My post" });
const [populated] = await postModel.populate([plainPost], "author");
```

**Option 3 — on a batch of documents at once** (a single `$in` query per
field, no matter how many documents — no N+1):

```ts
const posts = await postModel.find({});
const populated = await postModel.populate(posts, "author");
```

For a `many: true` relation, `populate()` replaces the array of ids with
the array of resolved documents (with the same `select` projection applied
to each item).

---

## 13. Connection events

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

## 14. Full API reference

### `ormSchema(fields, options?) => Schema`

Creates a schema definition. `options.timestamps` adds `createdAt`/`updatedAt`.
The document's TypeScript type is **inferred automatically** from the
declared fields (autocomplete on `create()`, `find()`, etc. without writing
an interface by hand — see `InferSchemaType` / `InferModel` below). Field
types accept both native constructors (`String`) and string literals (`"string"`).

### `schema.model(name) => ModelClass`

Registers the schema and returns the model class you use for CRUD.

### `InferModel<typeof myModel>` / `InferSchemaType<Fields>`

Extracts a document's TypeScript type from a model or a schema:

```ts
export type IUser = InferModel<typeof userModel>;
```

### `connectDB(options?) => Promise<Realm>`

Simplified connection. `options.path`, `options.silent`. Expert mode:
`options.schemaVersion`, `options.onMigration`.

### `disconnectDB() => void`

Closes the connection.

### `RealmClient`

Singleton exposing `.connect()`, `.close()`, `.getRealm()` (fails
immediately if not connected), `.ready()` (waits for an **in-progress**
connection instead of failing — used internally throughout the library),
`.isConnected()`, `.getState()`, `.loadModels(dir)`, and the
`connecting` / `connected` / `disconnected` / `error` events.

### `Query` (returned by `find` / `findOne` / `findById`)

Chainable, "thenable" object: `.populate(path, select?)`, `.sort(spec)`,
`.limit(n)`, `.skip(n)`, `.lean(true|false)`. `await`s directly like a
Promise. **Returns plain JS objects by default** (`lean !== false`).

### Static model methods

`create`, `insertMany`, `find`, `findOne`, `findById`, `updateOne`,
`updateMany`, `deleteOne`, `deleteMany`, `count`, `countDocuments`, `exists`,
`distinct`, `findByIdAndUpdate`, `findByIdAndDelete`, `findOneAndUpdate`,
`findOneAndDelete`, `aggregate`, `populate(docOrDocs, fields)`.
**All of them return plain JS objects**, ids already stringified.

### Instance methods (only via `new Model(...)` or `{ lean: false }`)

`save()`, `remove()`, `populate(path, select?)`, `toObject()`, `toJSON()`.

---

## 15. Best practices & limitations

- **Always import your model files before `connectDB()`** — it's the
  import that registers the schema in the global registry.
- **The `<db>.meta.json` file** created next to your `.realm` is what
  drives schema-change detection: don't delete it manually in production
  (the next migration would lose track of what actually changed). It's
  fine to delete it in development if you ever need to force a clean slate.
- **`unique`** documents intent but isn't (yet) enforced natively by Realm
  at the engine level — add an application-level check if this is
  critical for you (e.g. `exists({ email })` before `create`).
- **`aggregate()`** runs in memory (loads the documents, then applies the
  pipeline) — great for reasonably sized collections, not built for
  data-warehouse-scale aggregation.
- **Migrations inside nested/embedded objects**: a change to a nested
  object's structure (§4) still bumps the schema version automatically —
  it will never trigger a "Migration is required" crash. But the automatic
  default-filling and rename-pairing described in §7 only run on top-level
  model fields, not inside embedded objects (Realm doesn't allow querying
  embedded objects directly, which is what those helpers rely on). For a
  new field inside a nested object, Realm applies its own neutral default
  (0, "", false, null); for a rename inside a nested object, use expert
  mode's `m.transform(...)` to walk the parent documents and fix it up yourself.

---

## 16. Troubleshooting

**`Realm is not connected`**
→ Call `connectDB()` before using any model.

**`No schema registered`**
→ Your model files weren't imported before `connectDB()`. Import them
explicitly, or use `RealmClient.loadModels("./models")`.

**Network error during `npm install`**
→ The `realm` package downloads a native binary from `static.realm.io`.
Check your internet connection / corporate proxy.

**`Cannot find module '.../realm/prebuilds/node/realm.node'`**
→ The most common causes, in order:

1. **Two versions of `realm` installed** (common with pnpm, when a
   transitive dependency pulls in a different version). Run `pnpm why realm`
   to see every resolution path, and pin a single version via
   `pnpm.overrides` in `package.json`.
2. **Electron**: the binary must be compiled for Electron's ABI, not
   Node's. Install `@electron/rebuild` and run
   `npx electron-rebuild -f -w realm` after every install.
3. **Bundler (Vite/webpack/esbuild/Rolldown)**: `realm` must never be
   bundled, only externalized (`external: ["realm"]` +
   `optimizeDeps.exclude: ["realm"]`), or the bundler breaks its internal
   `#realm.node` import.

**`Migration is required due to the following errors: Property 'X.field' has been removed...`**
→ Shouldn't happen for a simple field rename (auto-detected, see §7). If it
still does, more than one field was likely renamed at the same time in the
same model with ambiguous type matches — fall back to expert mode
(`m.renameField(...)` in `onMigration`) for that specific case.

---

## Project structure

```
src/
  types.ts               // field types, Mongo-style filters
  Schema.ts                // ormSchema(), validation, Realm schema conversion
  QueryTranslator.ts       // { age: { $gt: 18 } } -> Realm query (RQL)
  Aggregate.ts              // MongoDB-style aggregation pipeline
  Query.ts                   // chainable, thenable query object
  populateUtils.ts             // parses every populate() call form
  Model.ts                      // full CRUD + findXAndY + populate
  MigrationBuilder.ts             // "safe" migration helpers
  SchemaVersionManager.ts          // automatic schema-change detection + migration
  RealmClient.ts                     // connectDB(), events, singleton
  registry.ts                          // global registry of declared schemas
  infer.ts                              // TypeScript type inference from ormSchema
  example/                               // full usage example
```

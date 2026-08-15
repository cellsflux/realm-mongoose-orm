# realm-mongoose-orm

> Un ORM TypeScript qui donne à **Realm** l'API et le confort de **Mongoose** :
> `ormSchema()`, `.model()`, `_id` auto-généré, migrations 100% automatiques,
> CRUD complet, `findXAndY`, agrégations (`$match`, `$group`, `$sort`, ...).

---

## Table des matières

1. [Pourquoi cette librairie](#1-pourquoi-cette-librairie)
2. [Installation](#2-installation)
3. [Démarrage rapide](#3-démarrage-rapide)
4. [Définir un schéma](#4-définir-un-schéma)
5. [Se connecter à la base](#5-se-connecter-à-la-base)
6. [Le `_id` automatique](#6-le-_id-automatique)
7. [Les migrations (100% automatiques)](#7-les-migrations-100-automatiques)
8. [CRUD complet](#8-crud-complet)
9. [Filtres façon MongoDB](#9-filtres-façon-mongodb)
10. [Agrégations](#10-agrégations)
11. [Relations entre modèles](#11-relations-entre-modèles)
12. [Événements de connexion](#12-événements-de-connexion)
13. [Référence API complète](#13-référence-api-complète)
14. [Bonnes pratiques & limites](#14-bonnes-pratiques--limites)
15. [Dépannage](#15-dépannage)

---

## 1. Pourquoi cette librairie

Realm est une base de données embarquée très performante, mais son API brute
oblige à :
- écrire des schémas au format Realm (`"string?"`, `"double[]"`, ...) au lieu
  d'un objet lisible façon Mongoose ;
- gérer manuellement un `schemaVersion` et une fonction de migration à
  chaque changement de structure ;
- utiliser un langage de requête textuel (RQL) au lieu de filtres objets ;
- générer soi-même les identifiants uniques.

**`realm-mongoose-orm` élimine tout ça.** Vous écrivez vos modèles comme avec
Mongoose, vous appelez `connectDB()`, et la librairie s'occupe du reste :
identifiants, migrations, traduction des requêtes.

---

## 2. Installation

```bash
npm install
npm run build
```

> ⚠️ **Réseau requis à l'installation.** Le paquet `realm` télécharge un
> binaire natif précompilé depuis `static.realm.io` lors du `npm install`.
> Une fois installé, l'application fonctionne entièrement hors-ligne (base
> de données locale embarquée, pas de serveur à démarrer).

---

## 3. Démarrage rapide

```ts
import { ormSchema, connectDB } from "realm-mongoose-orm";

// 1. Définir un schéma, comme avec Mongoose
const userSchema = ormSchema({
  name:  { type: "string", required: true },
  email: { type: "string", required: true, unique: true },
  age:   { type: "number", default: 18 },
}, { timestamps: true });

// 2. Créer le modèle
export const userModel = userSchema.model("User");

// 3. Se connecter (une seule fois, au démarrage de l'app)
await connectDB({ path: "app.realm" });

// 4. Utiliser le modèle
const user = await userModel.create({ name: "Alice", email: "alice@test.com" });
console.log(user.toObject());
```

C'est tout. Pas de `schemaVersion`, pas de migration écrite à la main, pas de
génération d'`_id` manuelle.

---

## 4. Définir un schéma

```ts
const productSchema = ormSchema({
  title:       { type: "string", required: true, minLength: 3, maxLength: 120 },
  price:       { type: "number", required: true, min: 0 },
  category:    { type: "string", enum: ["food", "tech", "clothing"] as const },
  inStock:     { type: "boolean", default: true },
  tags:        { type: "string", array: true },              // tableau de strings
  publishedAt: { type: "date", default: () => new Date() },  // default dynamique
  owner:       { ref: "User" },                                // relation 1-1
  reviews:     { ref: "Review", many: true },                   // relation 1-N
}, {
  timestamps: true,   // ajoute createdAt / updatedAt automatiquement
  primaryKey: "_id",  // par défaut, inutile de le préciser
});

export const productModel = productSchema.model("Product");
```

### Types de champs disponibles

| Type Mongoose-like | Type Realm sous-jacent |
|---------------------|--------------------------|
| `"string"`          | `string`                 |
| `"number"`           | `double`                 |
| `"int"`              | `int`                    |
| `"boolean"`          | `bool`                   |
| `"date"`             | `date`                   |
| `"objectId"`         | `objectId`               |
| `"uuid"`             | `uuid`                   |
| `"mixed"`            | `mixed`                  |
| `"buffer"`           | `data`                   |

### Options de validation par champ

| Option        | Effet                                                         |
|---------------|-----------------------------------------------------------------|
| `required`    | Champ obligatoire à la création                                 |
| `default`     | Valeur (ou fonction) appliquée si le champ est absent            |
| `unique`      | Marque le champ comme unique (à valider dans votre logique métier)|
| `enum`        | Liste de valeurs autorisées                                      |
| `min` / `max` | Bornes numériques                                                |
| `minLength` / `maxLength` | Bornes de longueur de chaîne                          |
| `array`       | Le champ est un tableau du type déclaré                          |
| `validate`    | Fonction custom `(value) => boolean \| string`                   |

---

## 5. Se connecter à la base

```ts
import { connectDB, disconnectDB, RealmClient } from "realm-mongoose-orm";

await connectDB({
  path: "app.realm",   // fichier local, ":memory:" pour les tests
  silent: false,        // false = log de connexion dans la console
});

// ... votre application ...

disconnectDB();
```

- **Singleton** : `connectDB()` réutilise la connexion existante si vous
  l'appelez plusieurs fois (comme `mongoose.connect`).
- **Chargement automatique des modèles** : si vos schémas sont dans un
  dossier séparé, chargez-les avant de vous connecter :

  ```ts
  RealmClient.loadModels("./src/models"); // require() tous les .ts/.js du dossier
  await connectDB({ path: "app.realm" });
  ```

---

## 6. Le `_id` automatique

Vous n'avez **jamais** besoin de fournir ou de générer un `_id` :

```ts
const user = await userModel.create({ name: "Alice", email: "a@test.com" });
console.log(user.toObject()._id); // "a2658a17-3c6a-44d1-8891-fe9d8c828..." (string, pas un buffer)
```

En interne, chaque `create()` / `insertMany()` génère un `Realm.BSON.UUID()`
si `_id` n'est pas fourni — exactement comme Mongoose génère un `ObjectId`.

**`toObject()` / `toJSON()` sérialisent automatiquement tous les ids en
string** (récursivement, y compris dans les documents peuplés par
`populate()`). Vous n'obtiendrez donc jamais un buffer brut `{ sub_type: 4,
buffer: {...} }` en sortie — que ce soit en JSON, dans une réponse IPC
Electron, ou dans un `console.log`. C'est le même comportement que
`JSON.stringify(mongooseDoc)`, qui convertit un `ObjectId` en string.

Pour retrouver un document par id (par ex. depuis une route HTTP ou un canal
IPC où l'id arrive en `string`), utilisez simplement la string :

```ts
await userModel.findById(id);
await userModel.findByIdAndUpdate(id, { age: 26 });
await userModel.findByIdAndDelete(id);
```

La conversion `string -> UUID` est faite automatiquement par la librairie.

---

## 7. Les migrations (100% automatiques)

**C'est le point le plus important : vous n'écrivez jamais de migration à la main.**

Realm exige normalement un `schemaVersion` incrémenté manuellement et une
fonction `onMigration` à chaque changement de structure. Cette librairie
automatise entièrement ce mécanisme :

1. À chaque `connectDB()`, elle compare le schéma actuel (vos `ormSchema`)
   avec celui de la dernière connexion **réussie** (sauvegardé dans
   `<fichier>.meta.json` à côté de votre base — écrit seulement après un
   `Realm.open()` qui a fonctionné, jamais en cas d'échec, pour ne jamais se
   désynchroniser de la vraie base).
2. Si rien n'a changé → rien ne se passe, la version reste la même.
3. Si un champ a été **ajouté seul** → la version est incrémentée
   automatiquement et sa valeur `default` (si définie dans le schéma) est
   appliquée à tous les documents existants.
4. Si un champ a été **supprimé seul** → Realm l'élimine tout seul, aucune
   action nécessaire.
5. Si un champ a été **retiré et qu'un autre a été ajouté au même moment,
   avec le même type** (ex: vous renommez `by` en `By`, ou `fullName` en
   `name`) → c'est automatiquement traité comme un **renommage** : la
   valeur est copiée vers le nouveau nom, aucune donnée perdue. C'est ce cas
   précis qui provoquait auparavant l'erreur `Migration is required due to
   the following errors: Property 'X.by' has been removed...` — il est
   maintenant géré tout seul.

**Exemple concret (ajout de champ) :**

```ts
// Version 1 du schéma
const userSchema = ormSchema({
  name: { type: "string", required: true },
});

// ... plus tard, vous ajoutez un champ ...

// Version 2 (juste modifiée dans le code, rien d'autre à faire)
const userSchema = ormSchema({
  name: { type: "string", required: true },
  role: { type: "string", default: "user" }, // <- nouveau champ
});
```

Au prochain démarrage de l'application, `connectDB()` détecte le nouveau
champ `role`, incrémente automatiquement la version, et remplit `"user"`
pour tous les utilisateurs déjà existants. **Aucune ligne de migration à
écrire.**

**Exemple concret (renommage détecté automatiquement) :**

```ts
// Avant
const productSchema = ormSchema({ by: { type: "number" } });

// Après : juste renommer le champ dans le code suffit
const productSchema = ormSchema({ By: { type: "number" } });
```

Au redémarrage, la librairie voit que `by` a disparu et que `By` (même
type) est apparu → elle copie automatiquement la valeur de `by` vers `By`
pour tous les documents existants, sans que vous ayez à écrire quoi que ce
soit.

> ⚠️ La détection de renommage ne fonctionne que pour **un seul** champ
> retiré + **un seul** champ ajouté par modèle et par connexion, de même
> type. Pour un cas plus complexe (plusieurs renommages en même temps, ou
> changement de type), utilisez le mode expert ci-dessous avec
> `m.renameField(...)`.

### Mode expert (optionnel)

Pour un cas complexe (renommage de champ, transformation de données), vous
pouvez toujours fournir votre propre logique, exécutée **en plus** de
l'auto-migration :

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

| Méthode `MigrationBuilder` | Usage |
|------------------------------|--------|
| `renameField(model, from, to)` | Copie l'ancienne valeur vers le nouveau nom de champ |
| `fillDefault(model, field, value)` | Remplit une valeur par défaut si absente |
| `transform(model, fn)` | Transformation custom, protégée par try/catch par document |

---

## 8. CRUD complet

```ts
// Create
const user = await userModel.create({ name: "Alice", email: "a@test.com" });
const users = await userModel.insertMany([{ name: "Bob", email: "b@test.com" }]);

// new + save() (façon document Mongoose)
const doc = new userModel({ name: "Carla", email: "c@test.com" });
await doc.save();

// Read — find/findOne/findById renvoient une Query CHAÎNABLE (voir §8bis)
await userModel.find({ age: { $gte: 18 } }, { sort: { name: 1 }, limit: 10, skip: 0 });
await userModel.findOne({ email: "a@test.com" });
await userModel.findById(id);
await userModel.count();
await userModel.countDocuments({ role: "admin" });
await userModel.exists({ email: "a@test.com" });
await userModel.distinct("role");

// Update
await userModel.updateOne({ email: "a@test.com" }, { age: 26 });
await userModel.updateMany({ role: "user" }, { isActive: true });
await userModel.findByIdAndUpdate(id, { age: 27 });          // renvoie le doc mis à jour
await userModel.findOneAndUpdate({ email: "a@test.com" }, { age: 28 }, { new: false }); // renvoie l'ancien doc

// Delete
await userModel.deleteOne({ email: "a@test.com" });
await userModel.deleteMany({ isActive: false });
await userModel.findByIdAndDelete(id);
await userModel.findOneAndDelete({ email: "a@test.com" });

// Instance
await doc.save();
await doc.remove();
await doc.populate("author");     // résout un champ de relation sur ce document
doc.toObject(); // objet JS brut, ids déjà en string
doc.toJSON();   // alias, pratique pour res.json(doc) ou une réponse IPC Electron
```

---

## 8bis. Requêtes chaînables (`Query`), exactement comme Mongoose

`find()`, `findOne()` et `findById()` ne renvoient pas directement une
Promise : ils renvoient un objet `Query` **chaînable et "thenable"**. Vous
pouvez soit l'`await` directement, soit enchaîner des méthodes avant de
l'`await` — dans les deux cas, la requête ne part réellement que lorsqu'elle
est `await`ée :

```ts
// Exactement la syntaxe Mongoose que vous cherchiez :
const posts = await postModel
  .find({ title: "Premier article" })
  .populate("author")          // résout la relation
  .sort({ createdAt: -1 })
  .skip(0)
  .limit(20);

// populate() accepte aussi plusieurs champs, séparés ou en tableau :
await postModel.find({}).populate("author", "tags");
await postModel.find({}).populate(["author", "tags"]);

// .lean() renvoie des objets JS bruts (pas d'instances de modèle), pour aller plus vite
const rawPosts = await postModel.find({}).lean();

// Sans rien chaîner, ça continue de marcher comme avant :
const all = await userModel.find({ isActive: true });
```

| Méthode `Query` | Équivalent Mongoose |
|-------------------|------------------------|
| `.populate(...fields)` | `.populate(field)` |
| `.sort(spec)`            | `.sort(spec)` |
| `.limit(n)`               | `.limit(n)` |
| `.skip(n)`                 | `.skip(n)` |
| `.lean()`                   | `.lean()` |

---

## 9. Filtres façon MongoDB

```ts
await userModel.find({
  age: { $gte: 18, $lte: 65 },
  role: { $in: ["admin", "user"] },
  email: { $exists: true },
  name: { $contains: "ali" }, // recherche insensible à la casse
});
```

Opérateurs supportés : `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`,
`$nin`, `$exists`, `$contains`.

---

## 10. Agrégations

Pipeline en mémoire façon `Model.aggregate([...])` de Mongoose :

```ts
const stats = await userModel.aggregate([
  { $match: { isActive: true } },
  { $group: {
      _id: "$role",
      total: { $count: "$_id" },
      avgAge: { $avg: "$age" },
      maxAge: { $max: "$age" },
    }
  },
  { $sort: { total: -1 } },
  { $limit: 5 },
]);
// [{ _id: "user", total: 12, avgAge: 27.4, maxAge: 41 }, ...]
```

Stages supportés : `$match`, `$group` (`$sum`, `$avg`, `$min`, `$max`,
`$count`, `$push`, `$addToSet`, `$first`, `$last`), `$sort`, `$skip`,
`$limit`, `$project`, `$unwind`.

---

## 11. Relations entre modèles

```ts
const reviewSchema = ormSchema({
  text: { type: "string", required: true },
  author: { ref: "User" },              // relation simple
});

const productSchema = ormSchema({
  title: { type: "string", required: true },
  reviews: { ref: "Review", many: true }, // liste de relations
});
```

> Les modèles référencés doivent être enregistrés (via `.model(...)`) **avant**
> `connectDB()`, peu importe l'ordre des imports, tant que le fichier est chargé.

En interne, un champ `{ ref: "..." }` est stocké comme un simple **id** (uuid),
exactement comme un `ObjectId` avec `ref` dans Mongoose — pas comme un lien
Realm natif. Vous pouvez créer un document en passant soit l'id, soit le
document complet, la relation est normalisée automatiquement :

```ts
const post = await postModel.create({
  title: "Mon article",
  content: "...",
  author: alice,       // ou directement : author: alice.toObject()._id
});
```

### `populate()`, exactement comme Mongoose

**Option 1 — directement dans la requête**, comme `Model.findById(id).populate("author")` :

```ts
const post = await postModel.findById(id, { populate: ["author"] });
console.log(post?.toObject().author); // { _id, name, email, ... } au lieu d'un simple id

const posts = await postModel.find({}, { populate: ["author"] });
```

**Option 2 — manuellement, sur un document déjà chargé**, comme `doc.populate("field")` :

```ts
const post = await postModel.findOne({ title: "Mon article" });
await post?.populate("author");           // un seul champ
await post?.populate(["author", "tags"]); // plusieurs champs
```

**Option 3 — sur un lot de documents en une seule fois** (une seule requête
`$in` par champ, quel que soit le nombre de documents — pas de N+1) :

```ts
const posts = await postModel.find({});
await postModel.populate(posts, ["author"]);
```

Pour une relation `many: true`, `populate()` remplace le tableau d'ids par
le tableau des documents résolus.

---

## 12. Événements de connexion

`RealmClient` est un `EventEmitter` :

```ts
import { RealmClient } from "realm-mongoose-orm";

RealmClient.on("connecting", () => console.log("Connexion en cours..."));
RealmClient.on("connected", () => console.log("Connecté !"));
RealmClient.on("disconnected", () => console.log("Déconnecté."));
RealmClient.on("error", (err) => console.error("Erreur Realm:", err));

RealmClient.getState(); // "disconnected" | "connecting" | "connected" | "error"
RealmClient.isConnected(); // boolean
```

---

## 13. Référence API complète

### `ormSchema(fields, options?) => Schema`
Crée une définition de schéma. `options.timestamps` ajoute `createdAt`/`updatedAt`.
Le type TypeScript du document est **déduit automatiquement** des champs
déclarés (autocomplétion sur `create()`, `find()`, etc. sans écrire
d'interface à la main — voir `InferSchemaType` / `InferModel` ci-dessous).

### `schema.model(name) => ModelClass`
Enregistre le schéma et renvoie la classe modèle utilisable pour le CRUD.

### `InferModel<typeof monModel>` / `InferSchemaType<Fields>`
Extrait le type TypeScript d'un document à partir du modèle ou du schéma :
```ts
export type IUser = InferModel<typeof userModel>;
```

### `connectDB(options?) => Promise<Realm>`
Connexion simplifiée. `options.path`, `options.silent`, mode expert :
`options.schemaVersion`, `options.onMigration`.

### `disconnectDB() => void`
Ferme la connexion.

### `RealmClient`
Singleton exposant `.connect()`, `.close()`, `.getRealm()` (échoue
immédiatement si non connecté), `.ready()` (attend une connexion **en
cours** au lieu d'échouer — recommandé dans le code interne de la
librairie), `.isConnected()`, `.getState()`, `.loadModels(dir)`, et les
événements `connecting` / `connected` / `disconnected` / `error`.

### `Query` (renvoyé par `find` / `findOne` / `findById`)
Objet chaînable et "thenable" : `.populate(...fields)`, `.sort(spec)`,
`.limit(n)`, `.skip(n)`, `.lean()`. S'`await`e directement comme une Promise.

### Méthodes statiques d'un modèle
`create`, `insertMany`, `find`, `findOne`, `findById`, `updateOne`,
`updateMany`, `deleteOne`, `deleteMany`, `count`, `countDocuments`, `exists`,
`distinct`, `findByIdAndUpdate`, `findByIdAndDelete`, `findOneAndUpdate`,
`findOneAndDelete`, `aggregate`, `populate(docOrDocs, fields)`.

### Méthodes d'instance
`save()`, `remove()`, `populate(fields)`, `toObject()` (ids déjà en string),
`toJSON()`.

---

## 14. Bonnes pratiques & limites

- **Toujours importer vos fichiers de modèles avant `connectDB()`** — c'est
  l'import qui enregistre le schéma dans le registre global.
- **Le fichier `<db>.meta.json`** créé à côté de votre `.realm` sert à
  détecter les changements de schéma : ne le supprimez pas manuellement en
  production (sinon la prochaine migration ne saura plus ce qui a changé).
- **`unique`** est une intention documentée mais n'est pas (encore) imposée
  nativement par Realm au niveau moteur ; ajoutez une vérification
  applicative si c'est critique (ex: `exists({ email })` avant `create`).
- **`aggregate()`** fonctionne en mémoire (charge les documents puis applique
  le pipeline) — parfait pour des collections de taille raisonnable, pas
  conçu pour des agrégations massives façon data warehouse.

---

## 15. Dépannage

**`Realm n'est pas connecté`**
→ Appelez `connectDB()` avant tout appel à un modèle.

**`Aucun schéma enregistré`**
→ Vos fichiers de modèles n'ont pas été importés avant `connectDB()`. Importez-les explicitement ou utilisez `RealmClient.loadModels("./models")`.

**Erreur réseau pendant `npm install`**
→ Le paquet `realm` télécharge un binaire natif depuis `static.realm.io`.
Vérifiez votre connexion internet / proxy d'entreprise.

**`Cannot find module '.../realm/prebuilds/node/realm.node'`**
→ Causes les plus fréquentes, dans l'ordre à vérifier :
1. **Deux versions de `realm` installées** (fréquent avec pnpm si une
   dépendance transitive impose une autre version). Lancez `pnpm why realm`
   pour voir tous les chemins de résolution, et figez-en une seule via
   `pnpm.overrides` dans `package.json`.
2. **Electron** : le binaire doit être compilé pour l'ABI d'Electron, pas
   celle de Node.js. Installez `@electron/rebuild` et lancez
   `npx electron-rebuild -f -w realm` après chaque `install`.
3. **Bundler (Vite/webpack/esbuild/Rolldown)** : `realm` ne doit jamais être
   bundlé, seulement externalisé (`external: ["realm"]` +
   `optimizeDeps.exclude: ["realm"]`), sinon le bundler casse la résolution
   de son import interne `#realm.node`.

**`Migration is required due to the following errors: Property 'X.champ' has been removed...`**
→ Ne devrait plus arriver pour un simple renommage de champ (détecté
automatiquement, voir §7). Si ça persiste, c'est que plus d'un champ a été
renommé en même temps dans le même modèle — passez par le mode expert
(`m.renameField(...)` dans `onMigration`) pour ce cas précis.

---

## Structure du projet

```
src/
  types.ts               // types des champs, filtres façon Mongo
  Schema.ts                // ormSchema(), validation, conversion vers Realm
  QueryTranslator.ts       // { age: { $gt: 18 } } -> requête Realm (RQL)
  Aggregate.ts              // pipeline d'agrégation façon MongoDB
  Model.ts                  // CRUD complet + findXAndY
  MigrationBuilder.ts        // helpers de migration "sans risque"
  SchemaVersionManager.ts    // détection + migration automatique du schéma
  RealmClient.ts              // connectDB(), événements, singleton
  registry.ts                  // registre global des schémas déclarés
  example/                     // exemple d'utilisation complet
```

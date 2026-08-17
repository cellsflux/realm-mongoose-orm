import { connectDB, disconnectDB } from "../RealmClient";
import { userModel } from "./user.model";
import { postModel } from "./post.model";

async function main() {
  // Connexion simplifiée : pas de schemaVersion, pas de migration à écrire.
  await connectDB({ path: "demo.realm" });

  // create() renvoie directement un objet JS simple (plus besoin de .toObject())
  // -- sûr à envoyer tel quel via IPC Electron, res.json(), JSON.stringify(), etc.
  const alice = await userModel.create({
    name: "Alice",
    email: "alice@example.com",
    age: 24,
  });
  console.log("Créé:", alice); // { _id: "a2658a17-...", name: "Alice", ... } -- _id déjà en string

  // new Model() + save() reste utile pour un flux orienté "document"
  const bob = new userModel({ name: "Bob", email: "bob@example.com" });
  await bob.save();

  const carla = await userModel.create({
    name: "Carla",
    email: "carla@example.com",
    age: 31,
    role: "admin",
  });

  // find() avec filtre façon Mongo -- l'autocomplétion propose "name", "email", "age", "role", "isActive"
  const adults = await userModel.find(
    { age: { $gte: 18 } },
    { sort: { name: 1 } },
  );
  console.log("Utilisateurs majeurs:", adults); // déjà des objets JS, pas besoin de .map(u => u.toObject())

  // findById / findByIdAndUpdate / findByIdAndDelete, comme Mongoose
  const id = alice._id as string;
  const updated = await userModel.findByIdAndUpdate(id, { age: 25 });
  console.log("Après findByIdAndUpdate:", updated);

  // findOneAndUpdate / findOneAndDelete
  await userModel.findOneAndUpdate({ email: "bob@example.com" }, { age: 30 });

  // exists / distinct
  console.log("Un admin existe ?", await userModel.exists({ role: "admin" }));
  console.log("Rôles distincts:", await userModel.distinct("role"));

  // aggregate() façon MongoDB
  const byRole = await userModel.aggregate([
    {
      $group: {
        _id: "$role",
        total: { $count: "$_id" },
        avgAge: { $avg: "$age" },
      },
    },
    { $sort: { total: -1 } },
  ]);
  console.log("Agrégation par rôle:", byRole);

  console.log("Nombre total d'utilisateurs:", await userModel.countDocuments());

  // ---- Relations + populate(), façon Mongoose ----

  const post = await postModel.create({
    title: "Premier article",
    content: "Contenu de test",
    author: alice, // ou directement : author: alice._id -- normalisé automatiquement
  });
  console.log("Post créé (author = id, pas encore peuplé):", post);

  // populate() directement dans find/findOne/findById, avec projection (select) façon Mongoose :
  const populatedPost = await postModel.findById(post._id as string, {
    populate: [{ path: "author", select: ["name", "email"] }],
  });
  console.log("Post peuplé (author limité à name/email):", populatedPost);

  // ---- Requête CHAÎNÉE, exactement comme Mongoose ----
  // populate("author", "name email") : chemin + projection en une chaîne façon Mongoose
  const chained = await postModel
    .find({ title: "Premier article" })
    .populate("author", "name email")
    .sort({ title: 1 })
    .limit(5);
  console.log("Requête chaînée avec populate + select:", chained);

  // populate() manuel, sur un document déjà récupéré (objet JS simple, pas une instance)
  const anotherPost = await postModel.findOne(
    { title: "Premier article" },
    { lean: true },
  );
  if (anotherPost) {
    const [populatedManually] = await postModel.populate(
      [anotherPost],
      "author",
    );
    console.log("Peuplé manuellement:", populatedManually);
  }

  await userModel.findByIdAndDelete(id);
  disconnectDB();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

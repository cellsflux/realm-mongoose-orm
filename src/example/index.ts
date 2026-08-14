import { connectDB, disconnectDB } from "../RealmClient";
import { userModel } from "./user.model";
import { postModel } from "./post.model";

async function main() {
  // Connexion simplifiée : pas de schemaVersion, pas de migration à écrire.
  // La librairie détecte toute seule si le schéma a changé depuis la dernière fois.
  await connectDB({ path: "demo.realm" });

  // create() -- _id généré automatiquement (uuid), comme un ObjectId Mongoose
  const alice = await userModel.create({ name: "Alice", email: "alice@example.com", age: 24 });
  console.log("Créé:", alice.toObject());

  // new Model() + save()
  const bob = new userModel({ name: "Bob", email: "bob@example.com" });
  await bob.save();

  const carla = await userModel.create({ name: "Carla", email: "carla@example.com", age: 31, role: "admin" });

  // find() avec filtre façon Mongo
  const adults = await userModel.find({ age: { $gte: 18 } }, { sort: { name: 1 } });
  console.log("Utilisateurs majeurs:", adults.map((u) => u.toObject()));

  // findById / findByIdAndUpdate / findByIdAndDelete, comme Mongoose
  const id = (alice.toObject()._id as any).toString();
  const updated = await userModel.findByIdAndUpdate(id, { age: 25 });
  console.log("Après findByIdAndUpdate:", updated?.toObject());

  // findOneAndUpdate / findOneAndDelete
  await userModel.findOneAndUpdate({ email: "bob@example.com" }, { age: 30 });

  // exists / distinct
  console.log("Un admin existe ?", await userModel.exists({ role: "admin" }));
  console.log("Rôles distincts:", await userModel.distinct("role"));

  // aggregate() façon MongoDB
  const byRole = await userModel.aggregate([
    { $group: { _id: "$role", total: { $count: "$_id" }, avgAge: { $avg: "$age" } } },
    { $sort: { total: -1 } },
  ]);
  console.log("Agrégation par rôle:", byRole);

  console.log("Nombre total d'utilisateurs:", await userModel.countDocuments());

  // ---- Relations + populate(), façon Mongoose ----

  // On peut passer directement le document (author: alice), l'id (author: id),
  // ou une string : la relation est normalisée automatiquement.
  const post = await postModel.create({
    title: "Premier article",
    content: "Contenu de test",
    author: alice, // équivalent de `author: alice._id`
  });
  console.log("Post créé (author = id, pas encore peuplé):", post.toObject());

  // populate() directement dans find/findOne/findById :
  const populatedPost = await postModel.findById((post.toObject()._id as any).toString(), {
    populate: ["author"],
  });
  console.log("Post peuplé:", populatedPost?.toObject());

  // ou manuellement, après coup, sur un document déjà chargé :
  const anotherPost = await postModel.findOne({ title: "Premier article" });
  await anotherPost?.populate("author");
  console.log("Peuplé manuellement:", anotherPost?.toObject());

  await userModel.findByIdAndDelete(id);
  disconnectDB();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

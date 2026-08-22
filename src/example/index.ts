import { connectDB, disconnectDB } from "../RealmClient";
import { userModel } from "./user.model";
import { postModel } from "./post.model";

async function main() {
  // Simplified connection: no schemaVersion, no migration to write.
  await connectDB({ path: "demo.realm" });

  // create() returns a plain JS object directly (no more .toObject() needed)
  // -- safe to send as-is over Electron IPC, res.json(), JSON.stringify(), etc.
  const alice = await userModel.create({ name: "Alice", email: "alice@example.com", age: 24 });
  console.log("Created:", alice); // { _id: "a2658a17-...", name: "Alice", ... } -- _id already a string

  // new Model() + save() is still handy for a "document"-oriented flow
  const bob = new userModel({ name: "Bob", email: "bob@example.com" });
  await bob.save();

  const carla = await userModel.create({ name: "Carla", email: "carla@example.com", age: 31, role: "admin" });

  // find() with a MongoDB-style filter -- autocomplete suggests "name", "email", "age", "role", "isActive"
  const adults = await userModel.find({ age: { $gte: 18 } }, { sort: { name: 1 } });
  console.log("Adult users:", adults); // already plain objects, no .map(u => u.toObject()) needed

  // findById / findByIdAndUpdate / findByIdAndDelete, just like Mongoose
  const id = alice._id as string;
  const updated = await userModel.findByIdAndUpdate(id, { age: 25 });
  console.log("After findByIdAndUpdate:", updated);

  // findOneAndUpdate / findOneAndDelete
  await userModel.findOneAndUpdate({ email: "bob@example.com" }, { age: 30 });

  // exists / distinct
  console.log("Does an admin exist?", await userModel.exists({ role: "admin" }));
  console.log("Distinct roles:", await userModel.distinct("role"));

  // aggregate(), MongoDB-style
  const byRole = await userModel.aggregate([
    { $group: { _id: "$role", total: { $count: "$_id" }, avgAge: { $avg: "$age" } } },
    { $sort: { total: -1 } },
  ]);
  console.log("Aggregation by role:", byRole);

  console.log("Total user count:", await userModel.countDocuments());

  // ---- Relations + populate(), Mongoose-style ----

  const post = await postModel.create({
    title: "First post",
    content: "Test content",
    author: alice, // or directly: author: alice._id -- normalized automatically
  });
  console.log("Post created (author = id, not populated yet):", post);

  // populate() directly inside find/findOne/findById, with projection (select), Mongoose-style:
  const populatedPost = await postModel.findById(post._id as string, {
    populate: [{ path: "author", select: ["name", "email"] }],
  });
  console.log("Populated post (author limited to name/email):", populatedPost);

  // ---- CHAINED query, exactly like Mongoose ----
  // populate("author", "name email"): path + projection in one call, Mongoose-style
  const chained = await postModel
    .find({ title: "First post" })
    .populate("author", "name email")
    .sort({ title: 1 })
    .limit(5);
  console.log("Chained query with populate + select:", chained);

  // Manual populate(), on an already-fetched document (plain JS object, not an instance)
  const anotherPost = await postModel.findOne({ title: "First post" }, { lean: true });
  if (anotherPost) {
    const [populatedManually] = await postModel.populate([anotherPost], "author");
    console.log("Manually populated:", populatedManually);
  }

  await userModel.findByIdAndDelete(id);
  disconnectDB();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

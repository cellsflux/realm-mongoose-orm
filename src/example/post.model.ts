import { ormSchema, InferModel } from "../Schema";

// Relation simple : un post appartient à un auteur (User).
// "author" est déduit automatiquement comme un id (string), et devient un
// objet User complet une fois populate("author") appelé.
const postSchema = ormSchema(
  {
    title: { type: "string", required: true },
    content: { type: "string", required: true },
    author: { ref: "User" }, // équivalent de `author: { type: Schema.Types.ObjectId, ref: "User" }`
  },
  { timestamps: true }
);

export const postModel = postSchema.model("Post");
export { postSchema };
export type IPost = InferModel<typeof postModel>;

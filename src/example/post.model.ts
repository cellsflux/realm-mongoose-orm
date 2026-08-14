import { ormSchema } from "../Schema";

export interface IPost {
  [key: string]: unknown;
  _id?: string;
  title: string;
  content: string;
  author?: unknown; // id (string) avant populate, objet User complet après populate
  createdAt?: Date;
  updatedAt?: Date;
}

// Relation simple : un post appartient à un auteur (User)
const postSchema = ormSchema<IPost>(
  {
    title: { type: "string", required: true },
    content: { type: "string", required: true },
    author: { ref: "User" }, // équivalent de `author: { type: Schema.Types.ObjectId, ref: "User" }`
  },
  { timestamps: true }
);

export const postModel = postSchema.model("Post");
export { postSchema };

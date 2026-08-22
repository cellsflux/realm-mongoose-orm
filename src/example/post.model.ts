import { ormSchema, InferModel } from "../Schema";

// Simple relation: a post belongs to an author (User).
// "author" is inferred automatically as an id (string), and becomes a full
// User object once populate("author") is called.
const postSchema = ormSchema(
  {
    title: { type: String, required: true },
    content: { type: String, required: true },
    author: { ref: "User" }, // equivalent of `author: { type: Schema.Types.ObjectId, ref: "User" }`
  },
  { timestamps: true }
);

export const postModel = postSchema.model("Post");
export { postSchema };
export type IPost = InferModel<typeof postModel>;

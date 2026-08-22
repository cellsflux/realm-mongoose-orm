import { ormSchema, InferModel } from "../Schema";

// ----------------------------------------------------------------
// EXACTLY the shape you're used to from Mongoose:
// const userSchema = ormSchema({ name: {...}, ... }, { timestamps: true })
// export const userModel = userSchema.model("User")
//
// Field types can be written as native constructors (String, Number,
// Boolean, Date) -- just like Mongoose -- or as string literals ("string").
// Both are supported everywhere, pick whichever you prefer.
//
// The document's type is inferred automatically from the fields you
// declare (like Mongoose's InferSchemaType): userModel.create({ ... }) and
// userModel.find({ ... }) get full autocomplete on "name", "email", "age",
// "role", "isActive" -- no interface to write by hand.
// ----------------------------------------------------------------
const userSchema = ormSchema(
  {
    name: { type: String, required: true, minLength: 2 },
    email: { type: String, required: true, unique: true },
    age: { type: Number, default: 18, min: 0, max: 120 },
    role: { type: String, enum: ["admin", "user"] as const, default: "user" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true } // automatically adds createdAt / updatedAt
);

export const userModel = userSchema.model("User");
export { userSchema };

/** The document type, inferred automatically: { name: string; email: string; age?: number; ... } */
export type IUser = InferModel<typeof userModel>;

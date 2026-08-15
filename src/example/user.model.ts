import { ormSchema, InferModel } from "../Schema";

// ----------------------------------------------------------------
// EXACTEMENT comme demandé :
// const userSchema = ormSchema({ name: {...}, ... }, { timestamps: true })
// export const userModel = userSchema.model("User")
//
// Le type du document est déduit automatiquement des champs déclarés
// (comme InferSchemaType chez Mongoose) : userModel.create({ ... }) et
// userModel.find({ ... }) bénéficient de l'autocomplétion sur "name",
// "email", "age", "role", "isActive", sans écrire d'interface à la main.
// ----------------------------------------------------------------
const userSchema = ormSchema(
  {
    name: { type: "string", required: true, minLength: 2 },
    email: { type: "string", required: true, unique: true },
    age: { type: "number", default: 18, min: 0, max: 120 },
    role: { type: "string", enum: ["admin", "user"] as const, default: "user" },
    isActive: { type: "boolean", default: true },
  },
  { timestamps: true } // ajoute automatiquement createdAt / updatedAt
);

export const userModel = userSchema.model("User");
export { userSchema };

/** Type du document, déduit automatiquement : { name: string; email: string; age?: number; ... } */
export type IUser = InferModel<typeof userModel>;

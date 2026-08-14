import { ormSchema } from "../Schema";

export interface IUser {
  [key: string]: unknown;
  _id?: string;
  name: string;
  email: string;
  age?: number;
  role?: "admin" | "user";
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

// ----------------------------------------------------------------
// EXACTEMENT comme demandé :
// const userSchema = ormSchema({ name: {...}, ... }, { timestamps: true })
// export const userModel = userSchema.model("User")
// ----------------------------------------------------------------
const userSchema = ormSchema<IUser>(
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

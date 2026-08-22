import type { MongoLikeFilter, MongoOperator } from "./types";

/**
 * Realm uses a text-based query language (RQL), close to SQL, while
 * Mongoose uses filter objects. This class translates
 * { age: { $gt: 18 }, name: "Ali" } into "age > $0 AND name == $1" + [18, "Ali"]
 */
export class QueryTranslator {
  static translate<T>(filter: MongoLikeFilter<T> = {}): { query: string; args: unknown[] } {
    const clauses: string[] = [];
    const args: unknown[] = [];

    for (const [field, rawCondition] of Object.entries(filter)) {
      if (rawCondition === undefined) continue;

      const key = field === "_id" ? "_id" : field;

      if (this.isOperatorObject(rawCondition)) {
        const condition = rawCondition as MongoOperator<unknown>;
        for (const [op, value] of Object.entries(condition)) {
          clauses.push(this.buildClause(key, op, value, args));
        }
      } else {
        args.push(rawCondition);
        clauses.push(`${key} == $${args.length - 1}`);
      }
    }

    return {
      query: clauses.length ? clauses.join(" AND ") : "TRUEPREDICATE",
      args,
    };
  }

  private static isOperatorObject(value: unknown): boolean {
    return (
      typeof value === "object" &&
      value !== null &&
      !(value instanceof Date) &&
      Object.keys(value).some((k) => k.startsWith("$"))
    );
  }

  private static buildClause(
    field: string,
    op: string,
    value: unknown,
    args: unknown[]
  ): string {
    switch (op) {
      case "$eq":
        args.push(value);
        return `${field} == $${args.length - 1}`;
      case "$ne":
        args.push(value);
        return `${field} != $${args.length - 1}`;
      case "$gt":
        args.push(value);
        return `${field} > $${args.length - 1}`;
      case "$gte":
        args.push(value);
        return `${field} >= $${args.length - 1}`;
      case "$lt":
        args.push(value);
        return `${field} < $${args.length - 1}`;
      case "$lte":
        args.push(value);
        return `${field} <= $${args.length - 1}`;
      case "$in": {
        const values = value as unknown[];
        const placeholders = values.map((v) => {
          args.push(v);
          return `$${args.length - 1}`;
        });
        return `${field} IN {${placeholders.join(", ")}}`;
      }
      case "$nin": {
        const values = value as unknown[];
        const placeholders = values.map((v) => {
          args.push(v);
          return `$${args.length - 1}`;
        });
        return `NOT (${field} IN {${placeholders.join(", ")}})`;
      }
      case "$exists":
        return value ? `${field} != null` : `${field} == null`;
      case "$contains":
        args.push(value);
        return `${field} CONTAINS[c] $${args.length - 1}`;
      default:
        throw new Error(`Unsupported operator: ${op}`);
    }
  }

  static translateSort(sort?: Record<string, 1 | -1>): [string, boolean][] | undefined {
    if (!sort) return undefined;
    return Object.entries(sort).map(([field, dir]) => [field, dir === -1] as [string, boolean]);
  }
}

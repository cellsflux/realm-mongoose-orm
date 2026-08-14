export type AggregationStage =
  | { $match: Record<string, any> }
  | { $group: { _id: any; [field: string]: any } }
  | { $sort: Record<string, 1 | -1> }
  | { $limit: number }
  | { $skip: number }
  | { $project: Record<string, 0 | 1 | ((doc: any) => any)> }
  | { $unwind: string };

function getPath(doc: any, path: string): any {
  if (!path.startsWith("$")) return path;
  const cleanPath = path.slice(1);
  return cleanPath.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), doc);
}

function matches(doc: any, filter: Record<string, any>): boolean {
  for (const [field, condition] of Object.entries(filter)) {
    const value = doc[field];
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      for (const [op, opValue] of Object.entries(condition)) {
        switch (op) {
          case "$eq":
            if (value !== opValue) return false;
            break;
          case "$ne":
            if (value === opValue) return false;
            break;
          case "$gt":
            if (!(value > (opValue as any))) return false;
            break;
          case "$gte":
            if (!(value >= (opValue as any))) return false;
            break;
          case "$lt":
            if (!(value < (opValue as any))) return false;
            break;
          case "$lte":
            if (!(value <= (opValue as any))) return false;
            break;
          case "$in":
            if (!(opValue as any[]).includes(value)) return false;
            break;
          case "$nin":
            if ((opValue as any[]).includes(value)) return false;
            break;
          case "$exists":
            if (opValue ? value === undefined : value !== undefined) return false;
            break;
          default:
            break;
        }
      }
    } else if (value !== condition) {
      return false;
    }
  }
  return true;
}

function applyAccumulator(acc: string, values: any[]): any {
  switch (acc) {
    case "$sum":
      return values.reduce((s, v) => s + (typeof v === "number" ? v : 0), 0);
    case "$avg":
      return values.length ? values.reduce((s, v) => s + (typeof v === "number" ? v : 0), 0) / values.length : 0;
    case "$min":
      return values.length ? Math.min(...values.filter((v) => typeof v === "number")) : null;
    case "$max":
      return values.length ? Math.max(...values.filter((v) => typeof v === "number")) : null;
    case "$count":
      return values.length;
    case "$push":
      return values;
    case "$addToSet":
      return Array.from(new Set(values));
    case "$first":
      return values[0];
    case "$last":
      return values[values.length - 1];
    default:
      return values;
  }
}

/**
 * Pipeline d'agrégation en mémoire, façon `Model.aggregate([...])` de Mongoose.
 * Fonctionne sur un tableau de documents déjà chargés depuis Realm.
 */
export class Aggregate {
  static run(docs: any[], pipeline: AggregationStage[]): any[] {
    let data = docs.map((d) => ({ ...d }));

    for (const stage of pipeline) {
      if ("$match" in stage) {
        data = data.filter((doc) => matches(doc, stage.$match));
      } else if ("$sort" in stage) {
        const entries = Object.entries(stage.$sort);
        data = [...data].sort((a, b) => {
          for (const [field, dir] of entries) {
            if (a[field] < b[field]) return dir === 1 ? -1 : 1;
            if (a[field] > b[field]) return dir === 1 ? 1 : -1;
          }
          return 0;
        });
      } else if ("$skip" in stage) {
        data = data.slice(stage.$skip);
      } else if ("$limit" in stage) {
        data = data.slice(0, stage.$limit);
      } else if ("$unwind" in stage) {
        const field = stage.$unwind.replace(/^\$/, "");
        const out: any[] = [];
        for (const doc of data) {
          const arr = doc[field];
          if (Array.isArray(arr)) {
            for (const item of arr) out.push({ ...doc, [field]: item });
          } else {
            out.push(doc);
          }
        }
        data = out;
      } else if ("$project" in stage) {
        const spec = stage.$project;
        data = data.map((doc) => {
          const out: Record<string, any> = {};
          for (const [field, rule] of Object.entries(spec)) {
            if (typeof rule === "function") {
              out[field] = rule(doc);
            } else if (rule === 1) {
              out[field] = doc[field];
            }
            // rule === 0 => champ exclu, on ne le copie pas
          }
          return out;
        });
      } else if ("$group" in stage) {
        const { _id: idExpr, ...accumulators } = stage.$group;
        const groups = new Map<string, any[]>();

        for (const doc of data) {
          const key = typeof idExpr === "string" ? String(getPath(doc, idExpr)) : JSON.stringify(idExpr);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(doc);
        }

        const result: any[] = [];
        for (const [key, groupDocs] of groups) {
          const groupResult: Record<string, any> = {
            _id: typeof idExpr === "string" ? getPath(groupDocs[0], idExpr) : idExpr,
          };
          for (const [field, accExpr] of Object.entries(accumulators)) {
            const [accOp, accPath] = Object.entries(accExpr as Record<string, string>)[0];
            const values =
              accOp === "$count"
                ? groupDocs
                : groupDocs.map((d) => (typeof accPath === "string" ? getPath(d, accPath) : accPath));
            groupResult[field] = applyAccumulator(accOp, values);
          }
          result.push(groupResult);
        }
        data = result;
      }
    }

    return data;
  }
}

import type { PopulateInput, PopulateSpec } from "./types";

function normalizeSelect(select?: string | string[]): string[] | undefined {
  if (!select) return undefined;
  if (Array.isArray(select)) return select.filter(Boolean);
  return select.trim().split(/\s+/).filter(Boolean);
}

function toSpecs(item: PopulateInput): PopulateSpec[] {
  if (typeof item === "string") {
    const trimmed = item.trim();
    // "author tags" (space-separated) -> multiple paths, Mongoose-style
    if (/\s/.test(trimmed)) {
      return trimmed.split(/\s+/).map((path) => ({ path }));
    }
    return [{ path: trimmed }];
  }
  if (item && typeof item === "object" && "path" in item) {
    return [{ path: item.path, select: normalizeSelect(item.select) }];
  }
  return [];
}

/**
 * Understands every Mongoose-style populate() call form:
 *   populate("author")
 *   populate("author tags")                       // multiple paths
 *   populate("author", "name email")               // path + select (space-separated string)
 *   populate("author", ["name", "email"])           // path + select (array)
 *   populate({ path: "author", select: "name" })
 *   populate([{ path: "author", select: "name" }, { path: "tags" }])
 *   populate("author", "name").populate("tags")     // chained multiple times
 */
export function normalizePopulateArgs(args: unknown[]): PopulateSpec[] {
  if (args.length === 0) return [];

  // populate([...]) : array of strings / { path, select }
  if (args.length === 1 && Array.isArray(args[0])) {
    return (args[0] as PopulateInput[]).flatMap(toSpecs);
  }

  // populate("path", "select"...) or populate("path", ["select", ...])
  if (args.length >= 2 && typeof args[0] === "string") {
    const select = normalizeSelect(args[1] as string | string[] | undefined);
    return [{ path: args[0] as string, select }];
  }

  // populate("path") or populate("a b c") or populate({ path, select })
  if (args.length === 1) {
    return toSpecs(args[0] as PopulateInput);
  }

  // populate({...}, {...}, "path", ...) : multiple mixed arguments
  return (args as PopulateInput[]).flatMap(toSpecs);
}

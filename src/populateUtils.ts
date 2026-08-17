import type { PopulateInput, PopulateSpec } from "./types";

function normalizeSelect(select?: string | string[]): string[] | undefined {
  if (!select) return undefined;
  if (Array.isArray(select)) return select.filter(Boolean);
  return select.trim().split(/\s+/).filter(Boolean);
}

function toSpecs(item: PopulateInput): PopulateSpec[] {
  if (typeof item === "string") {
    const trimmed = item.trim();
    // "author tags" (espaces) -> plusieurs chemins, comme Mongoose
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
 * Comprend toutes les syntaxes populate() façon Mongoose :
 *   populate("author")
 *   populate("author tags")                       // plusieurs chemins
 *   populate("author", "name email")               // chemin + select (espaces)
 *   populate("author", ["name", "email"])           // chemin + select (tableau)
 *   populate({ path: "author", select: "name" })
 *   populate([{ path: "author", select: "name" }, { path: "tags" }])
 *   populate("author", "name").populate("tags")     // chaîné plusieurs fois
 */
export function normalizePopulateArgs(args: unknown[]): PopulateSpec[] {
  if (args.length === 0) return [];

  // populate([...]) : tableau de strings / { path, select }
  if (args.length === 1 && Array.isArray(args[0])) {
    return (args[0] as PopulateInput[]).flatMap(toSpecs);
  }

  // populate("path", "select"...) ou populate("path", ["select", ...])
  if (args.length >= 2 && typeof args[0] === "string") {
    const select = normalizeSelect(args[1] as string | string[] | undefined);
    return [{ path: args[0] as string, select }];
  }

  // populate("path") ou populate("a b c") ou populate({ path, select })
  if (args.length === 1) {
    return toSpecs(args[0] as PopulateInput);
  }

  // populate({...}, {...}, "path", ...) : plusieurs arguments mixtes
  return (args as PopulateInput[]).flatMap(toSpecs);
}

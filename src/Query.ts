import type { FindOptions, MongoLikeFilter } from "./types";

export type QueryExecutor<R> = (options: FindOptions) => Promise<R>;

/**
 * Objet "thenable" façon Mongoose Query : `Model.find(filter)` ne lance PAS
 * la requête immédiatement, il renvoie cet objet chaînable. La requête ne
 * part réellement que lorsqu'on l'`await`, exactement comme :
 *
 *   await userModel.find({ role: "admin" }).populate("team").sort({ name: 1 }).limit(10);
 *
 * `Query` implémente `PromiseLike`, donc `await` et `.then()` fonctionnent
 * normalement, et un simple `const list = await Model.find(filter)` (sans
 * rien chaîner) continue de marcher exactement comme avant.
 */
export class Query<R> implements PromiseLike<R> {
  private options: FindOptions;
  private executed: Promise<R> | null = null;

  constructor(private execute: QueryExecutor<R>, initialOptions: FindOptions = {}) {
    this.options = { ...initialOptions };
  }

  /** Résout un ou plusieurs champs de relation, comme .populate("author") ou .populate(["a", "b"]) */
  populate(...fields: (string | string[])[]): this {
    const flat = fields.flatMap((f) => (Array.isArray(f) ? f : [f]));
    this.options.populate = [...(this.options.populate ?? []), ...flat];
    return this;
  }

  sort(spec: Record<string, 1 | -1>): this {
    this.options.sort = spec;
    return this;
  }

  limit(n: number): this {
    this.options.limit = n;
    return this;
  }

  skip(n: number): this {
    this.options.skip = n;
    return this;
  }

  /** Renvoie des objets JS bruts (pas d'instances de modèle), comme .lean() en Mongoose */
  lean(): this {
    this.options.lean = true;
    return this;
  }

  private run(): Promise<R> {
    if (!this.executed) {
      this.executed = this.execute(this.options);
    }
    return this.executed;
  }

  then<TResult1 = R, TResult2 = never>(
    onfulfilled?: ((value: R) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<R | TResult> {
    return this.run().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<R> {
    return this.run().finally(onfinally);
  }
}

export type { MongoLikeFilter };

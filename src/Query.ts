import type { FindOptions, MongoLikeFilter, PopulateInput } from "./types";
import { normalizePopulateArgs } from "./populateUtils";

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

  /**
   * Résout un ou plusieurs champs de relation, exactement comme Mongoose :
   *   .populate("author")
   *   .populate("author tags")                     // plusieurs chemins
   *   .populate("author", "name email")             // avec projection (select)
   *   .populate([{ path: "author", select: "name" }])
   */
  populate(...args: (PopulateInput | PopulateInput[])[]): this {
    const specs = normalizePopulateArgs(args);
    this.options.populate = [...(this.options.populate ?? []), ...specs];
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

  /**
   * Bascule explicitement entre objets JS bruts (par défaut) et vraies
   * instances de modèle. `lean()` ou `lean(true)` = objets bruts (déjà le
   * comportement par défaut). `lean(false)` = instances avec .save()/.populate().
   */
  lean(value = true): this {
    this.options.lean = value;
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

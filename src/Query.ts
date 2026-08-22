import type { FindOptions, MongoLikeFilter, PopulateInput } from "./types";
import { normalizePopulateArgs } from "./populateUtils";

export type QueryExecutor<R> = (options: FindOptions) => Promise<R>;

/**
 * "Thenable" object, Mongoose Query-style: `Model.find(filter)` does NOT run
 * the query immediately — it returns this chainable object instead. The
 * query only actually runs once you `await` it, exactly like:
 *
 *   await userModel.find({ role: "admin" }).populate("team").sort({ name: 1 }).limit(10);
 *
 * `Query` implements `PromiseLike`, so `await` and `.then()` work normally,
 * and a plain `const list = await Model.find(filter)` (no chaining at all)
 * keeps working exactly as before.
 */
export class Query<R> implements PromiseLike<R> {
  private options: FindOptions;
  private executed: Promise<R> | null = null;

  constructor(private execute: QueryExecutor<R>, initialOptions: FindOptions = {}) {
    this.options = { ...initialOptions };
  }

  /**
   * Resolves one or more relation fields, exactly like Mongoose:
   *   .populate("author")
   *   .populate("author tags")                     // multiple paths
   *   .populate("author", "name email")             // with projection (select)
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
   * Explicitly toggles between plain JS objects (the default) and real
   * model instances. `lean()` or `lean(true)` = plain objects (already the
   * default). `lean(false)` = instances with .save()/.populate() available.
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

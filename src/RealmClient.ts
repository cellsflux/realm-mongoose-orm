import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import Realm from "realm";
import { getAllRealmObjectSchemas } from "./registry";
import { SchemaVersionManager } from "./SchemaVersionManager";
import { MigrationBuilder, MigrationFn, defineMigration } from "./MigrationBuilder";

export { MigrationBuilder, defineMigration };
export type { MigrationFn };

export interface ConnectOptions {
  /** Path to the .realm file on disk, or ":memory:" for tests. Defaults to "app.realm" */
  path?: string;
  /**
   * EXPERT mode only: if you'd rather manage the version yourself.
   * By default, leave this unset: the library detects schema changes and
   * handles versioning + migration entirely on its own (like Mongoose,
   * which never asks you to version a schema).
   */
  schemaVersion?: number;
  /**
   * EXPERT mode only: additional migration logic, called AFTER the
   * automatic migration (which already fills in new fields). Useful for a
   * field rename or a more complex data transformation.
   */
  onMigration?: MigrationFn;
  /** Optional encryption key (64-byte Uint8Array) */
  encryptionKey?: Uint8Array;
  /** Silences connection logs in the console */
  silent?: boolean;
}

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

class RealmClientImpl extends EventEmitter {
  private realm: Realm | null = null;
  private state: ConnectionState = "disconnected";
  private connectingPromise: Promise<Realm> | null = null;

  /**
   * Connects to the Realm database. Simplified equivalent of `mongoose.connect(uri)`.
   * - No `_id` to manage: auto-generated (uuid) on every `create()`.
   * - No `schemaVersion` to manage: detected and bumped automatically
   *   whenever you change an `ormSchema(...)`.
   * - Reuses the existing connection if already connected (singleton-style).
   */
  async connect(options: ConnectOptions = {}): Promise<Realm> {
    if (this.realm && !this.realm.isClosed) {
      return this.realm;
    }
    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    this.connectingPromise = this.doConnect(options);
    try {
      const realm = await this.connectingPromise;
      return realm;
    } finally {
      this.connectingPromise = null;
    }
  }

  private async doConnect(options: ConnectOptions): Promise<Realm> {
    this.state = "connecting";
    this.emit("connecting");

    const schema = getAllRealmObjectSchemas();
    if (schema.length === 0) {
      const err = new Error(
        "No schema registered. Import your model files (ormSchema(...).model(...)) before connecting, " +
          'or use RealmClient.loadModels("./models") to load them automatically.'
      );
      this.state = "error";
      this.emit("error", err);
      throw err;
    }

    const dbPath = options.path ?? "app.realm";

    // --- Fully automatic version + migration handling ---
    const versionManager = new SchemaVersionManager(dbPath);
    const plan = versionManager.plan(options.schemaVersion, options.onMigration);

    const config: Realm.Configuration = {
      path: dbPath,
      schema,
      schemaVersion: plan.version,
      encryptionKey: options.encryptionKey,
      onMigration: plan.migration,
    };

    try {
      this.realm = await Realm.open(config);
      // The meta file is only written HERE, once the migration has actually
      // succeeded. If Realm.open() had failed, nothing is written: the next
      // attempt recomputes the exact same migration plan instead of getting
      // stuck in a desynchronized state.
      plan.commit();
      this.state = "connected";
      if (!options.silent) {
        console.log(`✅ [realm-mongoose-orm] connected to "${dbPath}" (schemaVersion=${plan.version})`);
      }
      this.emit("connected", this.realm);
      return this.realm;
    } catch (err) {
      this.state = "error";
      this.emit("error", err);
      throw err;
    }
  }

  /** Automatically loads every model file in a directory (like `require("./models")`) */
  loadModels(directory: string): void {
    const abs = path.resolve(directory);
    if (!fs.existsSync(abs)) {
      throw new Error(`Models directory not found: ${abs}`);
    }
    for (const file of fs.readdirSync(abs)) {
      if (/\.(js|ts)$/.test(file) && !file.endsWith(".d.ts")) {
        require(path.join(abs, file));
      }
    }
  }

  getRealm(): Realm {
    if (!this.realm || this.realm.isClosed) {
      throw new Error("Realm is not connected. Call RealmClient.connect(...) (or connectDB(...)) before using a model.");
    }
    return this.realm;
  }

  /**
   * Like `getRealm()`, but waits for an ALREADY IN-PROGRESS connection
   * instead of failing immediately (Mongoose-style command "buffering").
   * Useful when an IPC request arrives right after app startup, while
   * `connectDB()` is still running: instead of crashing, the operation
   * waits and then runs normally as soon as possible. If the connection
   * itself fails (e.g. a migration error), that error surfaces here.
   */
  async ready(): Promise<Realm> {
    if (this.realm && !this.realm.isClosed) return this.realm;
    if (this.connectingPromise) return this.connectingPromise;
    return this.getRealm(); // never connected and nothing in progress -> clear error
  }

  close(): void {
    if (this.realm && !this.realm.isClosed) {
      this.realm.close();
      this.emit("disconnected");
    }
    this.realm = null;
    this.state = "disconnected";
  }

  isConnected(): boolean {
    return !!this.realm && !this.realm.isClosed;
  }

  getState(): ConnectionState {
    return this.state;
  }
}

/** Singleton, like `mongoose.connection` */
export const RealmClient = new RealmClientImpl();

/** Ergonomic alias, like `mongoose.connect(uri)` */
export async function connectDB(options: ConnectOptions = {}): Promise<Realm> {
  return RealmClient.connect(options);
}

/** Ergonomic alias, like `mongoose.disconnect()` */
export function disconnectDB(): void {
  RealmClient.close();
}

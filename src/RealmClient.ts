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
  /** Chemin du fichier .realm sur disque, ou ":memory:" pour les tests. Défaut: "app.realm" */
  path?: string;
  /**
   * Mode EXPERT uniquement : si vous préférez gérer la version vous-même.
   * Par défaut, laissez-le vide : la librairie détecte les changements de schéma
   * et gère la version + la migration toute seule (comme Mongoose qui ne demande
   * jamais de versionner un schéma).
   */
  schemaVersion?: number;
  /**
   * Mode EXPERT uniquement : logique de migration additionnelle, appelée
   * APRÈS la migration automatique (remplissage des nouveaux champs).
   * Utile pour un renommage de champ ou une transformation complexe.
   */
  onMigration?: MigrationFn;
  /** Clé de chiffrement optionnelle (Uint8Array de 64 octets) */
  encryptionKey?: Uint8Array;
  /** Coupe les logs de connexion dans la console */
  silent?: boolean;
}

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

class RealmClientImpl extends EventEmitter {
  private realm: Realm | null = null;
  private state: ConnectionState = "disconnected";
  private connectingPromise: Promise<Realm> | null = null;

  /**
   * Se connecte à la base Realm. Équivalent simplifié de `mongoose.connect(uri)`.
   * - Aucun `_id` à gérer : généré automatiquement (uuid) à chaque `create()`.
   * - Aucune `schemaVersion` à gérer : détectée et incrémentée automatiquement
   *   dès que vous changez un `ormSchema(...)`.
   * - Réutilise la connexion existante si déjà connecté (comme un singleton).
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
        "Aucun schéma enregistré. Importez vos fichiers de modèles (ormSchema(...).model(...)) avant de vous connecter, " +
          'ou utilisez RealmClient.loadModels("./models") pour les charger automatiquement.'
      );
      this.state = "error";
      this.emit("error", err);
      throw err;
    }

    const dbPath = options.path ?? "app.realm";

    // --- Gestion 100% automatique de la version + migration ---
    const versionManager = new SchemaVersionManager(dbPath);
    const { version, migration } = versionManager.resolve(options.schemaVersion, options.onMigration);

    const config: Realm.Configuration = {
      path: dbPath,
      schema,
      schemaVersion: version,
      encryptionKey: options.encryptionKey,
      onMigration: migration,
    };

    try {
      this.realm = await Realm.open(config);
      this.state = "connected";
      if (!options.silent) {
        console.log(`✅ [realm-mongoose-orm] connecté à "${dbPath}" (schemaVersion=${version})`);
      }
      this.emit("connected", this.realm);
      return this.realm;
    } catch (err) {
      this.state = "error";
      this.emit("error", err);
      throw err;
    }
  }

  /** Charge automatiquement tous les fichiers de modèles d'un dossier (comme `require("./models")`) */
  loadModels(directory: string): void {
    const abs = path.resolve(directory);
    if (!fs.existsSync(abs)) {
      throw new Error(`Dossier de modèles introuvable: ${abs}`);
    }
    for (const file of fs.readdirSync(abs)) {
      if (/\.(js|ts)$/.test(file) && !file.endsWith(".d.ts")) {
        require(path.join(abs, file));
      }
    }
  }

  getRealm(): Realm {
    if (!this.realm || this.realm.isClosed) {
      throw new Error(
        "Realm n'est pas connecté. Appelez RealmClient.connect(...) (ou connectDB(...)) avant d'utiliser un modèle."
      );
    }
    return this.realm;
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

/** Singleton, comme `mongoose.connection` */
export const RealmClient = new RealmClientImpl();

/** Alias ergonomique, comme `mongoose.connect(uri)` */
export async function connectDB(options: ConnectOptions = {}): Promise<Realm> {
  return RealmClient.connect(options);
}

/** Alias ergonomique, comme `mongoose.disconnect()` */
export function disconnectDB(): void {
  RealmClient.close();
}

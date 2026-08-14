import Realm from "realm";

export type MigrationFn = (oldRealm: Realm, newRealm: Realm) => void;

/**
 * Helpers de migration "sans risque" : chaque méthode protège contre les
 * erreurs les plus courantes (propriété absente, index hors limites) au lieu
 * de laisser planter la migration Realm.
 */
export class MigrationBuilder {
  constructor(private oldRealm: Realm, private newRealm: Realm) {}

  /** Renomme un champ en copiant sa valeur, sans jamais planter si absent */
  renameField(schemaName: string, from: string, to: string): void {
    const oldObjects = this.oldRealm.objects(schemaName);
    const newObjects = this.newRealm.objects(schemaName);
    const count = Math.min(oldObjects.length, newObjects.length);
    for (let i = 0; i < count; i++) {
      const oldObj = oldObjects[i] as unknown as Record<string, unknown>;
      const newObj = newObjects[i] as unknown as Record<string, unknown>;
      if (from in oldObj) {
        newObj[to] = oldObj[from];
      }
    }
  }

  /** Remplit une valeur par défaut pour tous les objets qui n'ont pas encore ce champ */
  fillDefault(schemaName: string, field: string, value: unknown): void {
    const newObjects = this.newRealm.objects(schemaName);
    for (const obj of newObjects) {
      const record = obj as unknown as Record<string, unknown>;
      if (record[field] === undefined || record[field] === null) {
        record[field] = typeof value === "function" ? (value as () => unknown)() : value;
      }
    }
  }

  /** Transforme chaque objet existant avec une fonction custom, en toute sécurité (try/catch par ligne) */
  transform(schemaName: string, fn: (oldObj: any, newObj: any) => void): void {
    const oldObjects = this.oldRealm.objects(schemaName);
    const newObjects = this.newRealm.objects(schemaName);
    const count = Math.min(oldObjects.length, newObjects.length);
    for (let i = 0; i < count; i++) {
      try {
        fn(oldObjects[i], newObjects[i]);
      } catch (err) {
        console.warn(`[migration] échec sur ${schemaName}[${i}]:`, err);
      }
    }
  }
}

/** Aide à écrire une migration lisible: defineMigration((m) => { m.renameField(...) }) */
export function defineMigration(build: (m: MigrationBuilder, oldVersion: number) => void): MigrationFn {
  return (oldRealm, newRealm) => {
    const builder = new MigrationBuilder(oldRealm, newRealm);
    build(builder, oldRealm.schemaVersion);
  };
}

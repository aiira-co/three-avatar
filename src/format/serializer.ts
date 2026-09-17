import { AVATAR_SCHEMA, AVATAR_SCHEMA_VERSION } from './constants.js';
import type { AvatarStateV1, VersionedId } from './types.js';
import { parseAvatarState } from './validation.js';

export type AvatarMigration = (input: Record<string, unknown>) => Record<string, unknown>;

export class AvatarMigrationRegistry {
  private readonly migrations = new Map<number, AvatarMigration>();

  register(fromVersion: number, migration: AvatarMigration): this {
    if (!Number.isInteger(fromVersion) || fromVersion < 0) {
      throw new Error('Migration source version must be a non-negative integer');
    }
    if (this.migrations.has(fromVersion)) {
      throw new Error(`A migration from avatar schema v${fromVersion} is already registered`);
    }
    this.migrations.set(fromVersion, migration);
    return this;
  }

  migrate(value: unknown): AvatarStateV1 {
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value) as unknown;
      } catch (error) {
        throw new Error(`Avatar JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return parseAvatarState(value);
    }

    let current = structuredClone(value) as Record<string, unknown>;
    let version = typeof current['schemaVersion'] === 'number' ? current['schemaVersion'] : 0;

    while (version < AVATAR_SCHEMA_VERSION) {
      const migration = this.migrations.get(version);
      if (!migration) throw new Error(`No avatar migration registered from schema v${version}`);
      current = migration(current);
      const nextVersion = current['schemaVersion'];
      if (typeof nextVersion !== 'number' || nextVersion <= version) {
        throw new Error(`Avatar migration from v${version} did not advance schemaVersion`);
      }
      version = nextVersion;
    }

    return parseAvatarState(current);
  }
}

export class AvatarSerializer {
  constructor(readonly migrations = new AvatarMigrationRegistry()) {}

  parse(value: unknown): AvatarStateV1 {
    return this.migrations.migrate(value);
  }

  stringify(value: AvatarStateV1, space?: number): string {
    return JSON.stringify(parseAvatarState(value), null, space);
  }

  clone(value: AvatarStateV1): AvatarStateV1 {
    return parseAvatarState(structuredClone(value));
  }

  createEmpty(family: VersionedId): AvatarStateV1 {
    return {
      schema: AVATAR_SCHEMA,
      schemaVersion: AVATAR_SCHEMA_VERSION,
      family: { ...family },
      body: { morphs: {} },
      appearance: {},
      equipment: [],
    };
  }
}

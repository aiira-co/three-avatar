import type {
  AvatarAssetDefinition,
  AvatarAssetPackDefinition,
  AvatarFamilyDefinition,
  AvatarItemDefinition,
  AvatarRigDefinition,
  VersionedId,
} from '../format/types.js';
import {
  validateFamilyDefinition,
  validateItemDefinition,
  validateRigDefinition,
  versionedKey,
} from '../format/validation.js';

export class AvatarRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AvatarRegistryError';
  }
}

/**
 * Installed definitions are immutable: they are cloned once on install and
 * deep-frozen, so hot-path getters can hand out the stored object without a
 * per-call clone and without a caller being able to corrupt the registry.
 */
function freezeDefinition<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) freezeDefinition(entry);
  return value;
}

function install<T extends VersionedId>(collection: Map<string, T>, definition: T): void {
  collection.set(versionedKey(definition), freezeDefinition(structuredClone(definition)));
}

export class AvatarAssetRegistry {
  private readonly packs = new Map<string, AvatarAssetPackDefinition>();
  private readonly assets = new Map<string, AvatarAssetDefinition>();
  private readonly rigs = new Map<string, AvatarRigDefinition>();
  private readonly families = new Map<string, AvatarFamilyDefinition>();
  private readonly items = new Map<string, AvatarItemDefinition>();

  install(pack: AvatarAssetPackDefinition): this {
    const packKey = versionedKey(pack);
    if (this.packs.has(packKey)) throw new AvatarRegistryError(`Avatar pack ${packKey} is already installed`);

    for (const dependency of pack.dependencies ?? []) {
      if (!this.packs.has(versionedKey(dependency))) {
        throw new AvatarRegistryError(`Avatar pack ${packKey} requires missing pack ${versionedKey(dependency)}`);
      }
    }

    const collections: Array<[string, readonly VersionedId[], Map<string, unknown>]> = [
      ['asset', pack.assets ?? [], this.assets],
      ['rig', pack.rigs ?? [], this.rigs],
      ['family', pack.families ?? [], this.families],
      ['item', pack.items ?? [], this.items],
    ];
    const stagedKeys = new Set<string>();

    for (const [kind, definitions, collection] of collections) {
      for (const definition of definitions) {
        const key = versionedKey(definition);
        const scopedKey = `${kind}:${key}`;
        if (collection.has(key) || stagedKeys.has(scopedKey)) {
          throw new AvatarRegistryError(`Duplicate avatar ${kind} ${key}`);
        }
        stagedKeys.add(scopedKey);
      }
    }

    for (const rig of pack.rigs ?? []) validateRigDefinition(rig);
    for (const family of pack.families ?? []) validateFamilyDefinition(family);
    for (const item of pack.items ?? []) validateItemDefinition(item);

    const hasAsset = (ref: VersionedId) => this.assets.has(versionedKey(ref))
      || (pack.assets ?? []).some((entry) => versionedKey(entry) === versionedKey(ref));
    const hasRig = (ref: VersionedId) => this.rigs.has(versionedKey(ref))
      || (pack.rigs ?? []).some((entry) => versionedKey(entry) === versionedKey(ref));
    const hasFamily = (ref: VersionedId) => this.families.has(versionedKey(ref))
      || (pack.families ?? []).some((entry) => versionedKey(entry) === versionedKey(ref));

    for (const family of pack.families ?? []) {
      if (!hasRig(family.rig)) {
        throw new AvatarRegistryError(`Avatar family ${versionedKey(family)} references missing rig ${versionedKey(family.rig)}`);
      }
      if (!hasAsset(family.body.asset)) {
        throw new AvatarRegistryError(`Avatar family ${versionedKey(family)} references missing body asset ${versionedKey(family.body.asset)}`);
      }
    }
    for (const item of pack.items ?? []) {
      if (!hasAsset(item.render.asset)) {
        throw new AvatarRegistryError(`Avatar item ${versionedKey(item)} references missing asset ${versionedKey(item.render.asset)}`);
      }
      for (const family of item.compatibility.families) {
        if (!hasFamily(family)) {
          throw new AvatarRegistryError(`Avatar item ${versionedKey(item)} references missing family ${versionedKey(family)}`);
        }
      }
      if (item.compatibility.rig && !hasRig(item.compatibility.rig)) {
        throw new AvatarRegistryError(`Avatar item ${versionedKey(item)} references missing rig ${versionedKey(item.compatibility.rig)}`);
      }
    }

    for (const asset of pack.assets ?? []) install(this.assets, asset);
    for (const rig of pack.rigs ?? []) install(this.rigs, rig);
    for (const family of pack.families ?? []) install(this.families, family);
    for (const item of pack.items ?? []) install(this.items, item);
    this.packs.set(packKey, freezeDefinition(structuredClone(pack)));

    return this;
  }

  hasPack(ref: VersionedId): boolean {
    return this.packs.has(versionedKey(ref));
  }

  getAsset(ref: VersionedId): AvatarAssetDefinition | undefined {
    return this.assets.get(versionedKey(ref));
  }

  requireAsset(ref: VersionedId): AvatarAssetDefinition {
    return this.require(this.assets, ref, 'asset');
  }

  getRig(ref: VersionedId): AvatarRigDefinition | undefined {
    return this.rigs.get(versionedKey(ref));
  }

  requireRig(ref: VersionedId): AvatarRigDefinition {
    return this.require(this.rigs, ref, 'rig');
  }

  getFamily(ref: VersionedId): AvatarFamilyDefinition | undefined {
    return this.families.get(versionedKey(ref));
  }

  requireFamily(ref: VersionedId): AvatarFamilyDefinition {
    return this.require(this.families, ref, 'family');
  }

  /**
   * Resolves a saved avatar's family reference to a family that can render it:
   * the exact version when installed, otherwise an installed family that
   * declares `supersedes` for it. Returns `undefined` when neither exists.
   */
  resolveFamily(ref: VersionedId): AvatarFamilyDefinition | undefined {
    const exact = this.getFamily(ref);
    if (exact) return exact;
    const key = versionedKey(ref);
    return [...this.families.values()].find(
      (family) => family.supersedes?.some((superseded) => versionedKey(superseded) === key) ?? false,
    );
  }

  getItem(ref: VersionedId): AvatarItemDefinition | undefined {
    return this.items.get(versionedKey(ref));
  }

  requireItem(ref: VersionedId): AvatarItemDefinition {
    return this.require(this.items, ref, 'item');
  }

  listFamilies(): AvatarFamilyDefinition[] {
    return [...this.families.values()];
  }

  listItems(): AvatarItemDefinition[] {
    return [...this.items.values()];
  }

  private require<T extends VersionedId>(collection: Map<string, T>, ref: VersionedId, kind: string): T {
    const key = versionedKey(ref);
    const value = collection.get(key);
    if (!value) throw new AvatarRegistryError(`Unknown avatar ${kind} ${key}`);
    return value;
  }
}

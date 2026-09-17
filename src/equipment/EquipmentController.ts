import { Group, Object3D, SkinnedMesh } from 'three';
import type { AppearanceController } from '../appearance/AppearanceController.js';
import type { OcclusionSurfaceController } from '../appearance/OcclusionSurfaceController.js';
import type { AvatarAssetLoader, LoadedAvatarAsset } from '../assets/AvatarAssetLoader.js';
import type { AvatarMorphController } from '../body/AvatarMorphController.js';
import type { BodyVisibilityController } from '../body/BodyVisibilityController.js';
import type {
  AvatarAppearanceValue,
  AvatarFamilyDefinition,
  AvatarItemDefinition,
  EquippedAvatarItemState,
  VersionedId,
} from '../format/types.js';
import { versionedKey } from '../format/validation.js';
import type { AvatarAssetRegistry } from '../registry/AvatarAssetRegistry.js';
import type { AvatarRig } from '../rig/AvatarRig.js';
import type { AvatarSocketController } from '../rig/AvatarSocketController.js';
import { rebindSkinnedMesh } from './rebindSkinnedMesh.js';

export interface EquippedAvatarItem {
  readonly instanceId: string;
  readonly definition: AvatarItemDefinition;
  readonly root: Object3D;
  readonly appearance: Record<string, AvatarAppearanceValue>;
}

interface InternalEquippedAvatarItem extends EquippedAvatarItem {
  loaded: LoadedAvatarAsset;
  scope: string;
}

export interface EquipOptions {
  instanceId?: string;
  appearance?: Record<string, AvatarAppearanceValue>;
  signal?: AbortSignal;
}

/**
 * Removes and releases skinned meshes an item's `meshNodes` did not select.
 * Geometry and materials still referenced by a selected mesh are left alone,
 * because a custom loader may share them across meshes.
 */
function discardUnselectedMeshes(all: readonly SkinnedMesh[], selected: readonly SkinnedMesh[]): void {
  const keep = new Set<SkinnedMesh>(selected);
  const retainedGeometries = new Set(selected.map((mesh) => mesh.geometry));
  const retainedMaterials = new Set(selected.flatMap((mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material])));

  for (const mesh of all) {
    if (keep.has(mesh)) continue;
    mesh.removeFromParent();
    if (!retainedGeometries.has(mesh.geometry)) mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!retainedMaterials.has(material)) material.dispose();
    }
  }
}

export class EquipmentController {
  private readonly equipped = new Map<string, InternalEquippedAvatarItem>();
  private operationQueue: Promise<unknown> = Promise.resolve();
  private instanceCounter = 1;
  private disposed = false;

  constructor(
    private readonly registry: AvatarAssetRegistry,
    private readonly loader: AvatarAssetLoader,
    private readonly family: AvatarFamilyDefinition,
    private readonly equipmentRoot: Group,
    private readonly rig: AvatarRig,
    private readonly bodyMesh: SkinnedMesh,
    private readonly bodyVisibility: BodyVisibilityController,
    private readonly sockets: AvatarSocketController,
    private readonly surfaces: OcclusionSurfaceController,
    private readonly appearanceController: AppearanceController,
    private readonly morphController: AvatarMorphController,
  ) {}

  equip(ref: VersionedId, options: EquipOptions = {}): Promise<EquippedAvatarItem> {
    return this.enqueue(() => this.performEquip(ref, options));
  }

  unequip(instanceId: string): Promise<boolean> {
    return this.enqueue(async () => this.remove(instanceId));
  }

  unequipChannel(channel: string): Promise<number> {
    return this.enqueue(async () => {
      const targets = [...this.equipped.values()]
        .filter((entry) => entry.definition.occupies.includes(channel))
        .map((entry) => entry.instanceId);
      for (const instanceId of targets) this.remove(instanceId);
      return targets.length;
    });
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      for (const instanceId of [...this.equipped.keys()]) this.remove(instanceId);
    });
  }

  list(): EquippedAvatarItem[] {
    return [...this.equipped.values()];
  }

  serialize(): EquippedAvatarItemState[] {
    return [...this.equipped.values()].map((entry) => ({
      instanceId: entry.instanceId,
      item: { id: entry.definition.id, version: entry.definition.version },
      ...(Object.keys(entry.appearance).length === 0
        ? {}
        : { appearance: structuredClone(entry.appearance) }),
    }));
  }

  dispose(): void {
    this.disposed = true;
    for (const instanceId of [...this.equipped.keys()]) this.remove(instanceId);
  }

  private async performEquip(ref: VersionedId, options: EquipOptions): Promise<EquippedAvatarItem> {
    this.assertActive();
    const definition = this.registry.requireItem(ref);
    this.assertCompatible(definition);
    this.assertVisibilityTargets(definition);
    const instanceId = options.instanceId ?? this.generateInstanceId();
    if (this.equipped.has(instanceId)) throw new Error(`Equipment instance "${instanceId}" already exists`);

    const loaded = await this.loader.load(definition.render.asset, options.signal);
    if (this.disposed) {
      loaded.dispose?.();
      throw new Error('Avatar equipment controller was disposed while loading an item');
    }

    const scope = `equipment.${instanceId}`;
    try {
      if (definition.render.type === 'skinned') {
        this.prepareSkinnedItem(loaded.root, definition);
      } else {
        this.sockets.require(definition.render.socket);
      }

      if (definition.materialChannels?.length) {
        this.appearanceController.bind(loaded.root, definition.materialChannels, scope);
        this.appearanceController.applyMany(scope, options.appearance ?? {});
      } else if (options.appearance && Object.keys(options.appearance).length > 0) {
        throw new Error(`Item ${versionedKey(definition)} does not define material channels`);
      }
      if (definition.morphBindings?.length) {
        this.morphController.bind(loaded.root, definition.morphBindings, scope);
      }

      // Commit only after loading, rig validation, and all bindings succeed.
      const conflicts = this.findConflicts(definition);
      for (const conflict of conflicts) this.remove(conflict.instanceId);

      if (definition.render.type === 'skinned') {
        this.equipmentRoot.add(loaded.root);
      } else {
        this.sockets.attach(definition.render.socket, loaded.root, definition.render.transform);
      }

      const entry: InternalEquippedAvatarItem = {
        instanceId,
        definition,
        root: loaded.root,
        appearance: structuredClone(options.appearance ?? {}),
        loaded,
        scope,
      };
      this.equipped.set(instanceId, entry);
      this.recomputeVisibility();
      return entry;
    } catch (error) {
      loaded.root.removeFromParent();
      this.appearanceController.unbindScope(scope);
      this.morphController.unbindScope(scope);
      loaded.dispose?.();
      throw error;
    }
  }

  private prepareSkinnedItem(root: Object3D, definition: AvatarItemDefinition): void {
    const requestedNames = definition.render.type === 'skinned' ? definition.render.meshNodes : undefined;
    const allMeshes: SkinnedMesh[] = [];
    root.traverse((object) => {
      const mesh = object as SkinnedMesh;
      if (mesh.isSkinnedMesh) allMeshes.push(mesh);
    });

    const selected = requestedNames
      ? allMeshes.filter((mesh) => requestedNames.includes(mesh.name))
      : allMeshes;
    if (selected.length === 0) throw new Error(`Skinned item ${versionedKey(definition)} contains no matching SkinnedMesh`);
    if (requestedNames) {
      for (const name of requestedNames) {
        if (!selected.some((mesh) => mesh.name === name)) {
          throw new Error(`Skinned item ${versionedKey(definition)} is missing mesh node "${name}"`);
        }
      }
    }

    // Unselected skinned meshes would keep rendering against a bone hierarchy
    // that is about to be removed, so they are discarded with the asset clone.
    discardUnselectedMeshes(allMeshes, selected);

    for (const mesh of selected) rebindSkinnedMesh(mesh, this.rig, this.bodyMesh.bindMatrix);

    const duplicateBoneRoots: Object3D[] = [];
    root.traverse((object) => {
      if ((object as { isBone?: boolean }).isBone && !(object.parent as { isBone?: boolean } | null)?.isBone) {
        duplicateBoneRoots.push(object);
      }
    });
    for (const boneRoot of duplicateBoneRoots) boneRoot.removeFromParent();
  }

  private generateInstanceId(): string {
    let candidate = `item-${this.instanceCounter}`;
    while (this.equipped.has(candidate)) {
      this.instanceCounter += 1;
      candidate = `item-${this.instanceCounter}`;
    }
    this.instanceCounter += 1;
    return candidate;
  }

  private findConflicts(definition: AvatarItemDefinition): InternalEquippedAvatarItem[] {
    const occupied = new Set(definition.occupies);
    const explicitConflicts = new Set(definition.conflicts ?? []);
    return [...this.equipped.values()].filter((entry) => {
      const otherChannels = new Set(entry.definition.occupies);
      const otherConflicts = new Set(entry.definition.conflicts ?? []);
      return [...otherChannels].some((channel) => occupied.has(channel) || explicitConflicts.has(channel))
        || [...occupied].some((channel) => otherConflicts.has(channel));
    });
  }

  private assertCompatible(definition: AvatarItemDefinition): void {
    const familyKey = versionedKey(this.family);
    const compatible = definition.compatibility.families.some((family) => versionedKey(family) === familyKey);
    if (!compatible) throw new Error(`Item ${versionedKey(definition)} is not compatible with family ${familyKey}`);
    if (definition.compatibility.rig && versionedKey(definition.compatibility.rig) !== versionedKey(this.family.rig)) {
      throw new Error(`Item ${versionedKey(definition)} requires an incompatible rig`);
    }
  }

  private assertVisibilityTargets(definition: AvatarItemDefinition): void {
    const bodyRegions = new Set(this.family.body.regions.map((region) => region.id));
    for (const region of definition.coversBody ?? []) {
      if (!bodyRegions.has(region)) {
        throw new Error(`Item ${versionedKey(definition)} references unknown body region "${region}"`);
      }
    }
    const surfaces = new Set(Object.keys(this.family.occlusionSurfaces ?? {}));
    for (const surface of definition.occludes ?? []) {
      if (!surfaces.has(surface)) {
        throw new Error(`Item ${versionedKey(definition)} references unknown occlusion surface "${surface}"`);
      }
    }
  }

  private remove(instanceId: string): boolean {
    const entry = this.equipped.get(instanceId);
    if (!entry) return false;
    entry.root.removeFromParent();
    this.appearanceController.unbindScope(entry.scope);
    this.morphController.unbindScope(entry.scope);
    entry.loaded.dispose?.();
    this.equipped.delete(instanceId);
    this.recomputeVisibility();
    return true;
  }

  private recomputeVisibility(): void {
    const bodyRegions = new Set<string>();
    const surfaces = new Set<string>();
    for (const entry of this.equipped.values()) {
      for (const region of entry.definition.coversBody ?? []) bodyRegions.add(region);
      for (const surface of entry.definition.occludes ?? []) surfaces.add(surface);
    }
    this.bodyVisibility.setHiddenRegions(bodyRegions);
    this.surfaces.setHiddenSurfaces(surfaces);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operationQueue.then(operation, operation);
    this.operationQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Avatar equipment controller has been disposed');
  }
}

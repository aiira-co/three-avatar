import { Box3, Group, SkinnedMesh, Vector3 } from 'three';
import type { AppearanceController } from '../appearance/AppearanceController.js';
import type { OcclusionSurfaceController } from '../appearance/OcclusionSurfaceController.js';
import type { LoadedAvatarAsset } from '../assets/AvatarAssetLoader.js';
import type { AvatarMorphController } from '../body/AvatarMorphController.js';
import type { BodyVisibilityController } from '../body/BodyVisibilityController.js';
import { AVATAR_SCHEMA, AVATAR_SCHEMA_VERSION } from '../format/constants.js';
import type {
  AvatarAppearanceValue,
  AvatarFamilyDefinition,
  AvatarResidualState,
  AvatarStateV1,
  EquippedAvatarItemState,
  VersionedId,
} from '../format/types.js';
import type { AvatarFaceController } from '../face/AvatarFaceController.js';
import type { EquipmentController } from '../equipment/EquipmentController.js';
import type { AvatarRig } from '../rig/AvatarRig.js';
import type { AvatarSocketController } from '../rig/AvatarSocketController.js';

export interface AvatarBounds {
  size: Vector3;
  center: Vector3;
}

export interface AvatarBoundsOptions {
  /**
   * Include hats, packs, weapons, and other equipment. Off by default: a
   * physics capsule must follow the body, not whatever the avatar is wearing.
   */
  includeEquipment?: boolean;
}

export class AvatarInstance {
  private scale = 1;
  private metadata: Record<string, unknown> | undefined;
  private residual: AvatarResidualState | undefined;
  private disposed = false;

  constructor(
    readonly family: AvatarFamilyDefinition,
    readonly root: Group,
    readonly bodyMesh: SkinnedMesh,
    readonly headMesh: SkinnedMesh | undefined,
    readonly rig: AvatarRig,
    readonly bodyVisibility: BodyVisibilityController,
    readonly equipment: EquipmentController,
    readonly appearance: AppearanceController,
    readonly morphs: AvatarMorphController,
    readonly sockets: AvatarSocketController,
    readonly surfaces: OcclusionSurfaceController,
    readonly face: AvatarFaceController | undefined,
    private readonly loadedBody: LoadedAvatarAsset,
  ) {}

  setScale(scale: number): void {
    this.assertActive();
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('Avatar scale must be a finite number greater than zero');
    this.scale = scale;
    this.root.scale.setScalar(scale);
  }

  setAppearance(channel: string, value: AvatarAppearanceValue): void {
    this.assertActive();
    this.appearance.apply('base', channel, value);
  }

  setMetadata(metadata: Record<string, unknown> | undefined): void {
    this.metadata = metadata ? structuredClone(metadata) : undefined;
  }

  /**
   * State the current family could not apply when this avatar was restored.
   * Preserved verbatim through `serialize()`.
   */
  getResidualState(): AvatarResidualState | undefined {
    return this.residual ? structuredClone(this.residual) : undefined;
  }

  setResidualState(residual: AvatarResidualState | undefined): void {
    // `equipmentOrder` alone is not residue: a clean restore already replays
    // equipment in its saved order.
    const isEmpty = !residual
      || (Object.keys(residual.morphs).length === 0
        && Object.keys(residual.appearance).length === 0
        && residual.equipment.length === 0);
    this.residual = isEmpty ? undefined : structuredClone(residual);
  }

  getBounds(options: AvatarBoundsOptions = {}): AvatarBounds {
    this.root.updateMatrixWorld(true);
    const bounds = new Box3();
    if (options.includeEquipment) {
      bounds.setFromObject(this.root);
    } else {
      bounds.expandByObject(this.bodyMesh);
      if (this.headMesh) bounds.expandByObject(this.headMesh);
    }
    if (bounds.isEmpty()) return { size: new Vector3(), center: new Vector3() };
    return {
      size: bounds.getSize(new Vector3()),
      center: bounds.getCenter(new Vector3()),
    };
  }

  serialize(): AvatarStateV1 {
    this.assertActive();
    const family: VersionedId = { id: this.family.id, version: this.family.version };
    return {
      schema: AVATAR_SCHEMA,
      schemaVersion: AVATAR_SCHEMA_VERSION,
      family,
      body: {
        ...(this.scale === 1 ? {} : { scale: this.scale }),
        morphs: { ...this.residual?.morphs, ...this.morphs.getValues() },
      },
      appearance: { ...this.residual?.appearance, ...this.appearance.getValues('base') },
      equipment: this.serializeEquipment(),
      ...(this.metadata ? { metadata: structuredClone(this.metadata) } : {}),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.equipment.dispose();
    this.sockets.dispose();
    this.surfaces.dispose();
    this.bodyVisibility.dispose();
    this.appearance.dispose();
    this.root.removeFromParent();
    this.loadedBody.dispose?.();
  }

  /** Keeps the saved ordering, and re-emits equipment that failed to resolve. */
  private serializeEquipment(): EquippedAvatarItemState[] {
    const live = this.equipment.serialize();
    if (!this.residual) return live;

    const liveById = new Map(live.map((entry) => [entry.instanceId, entry]));
    const unresolvedById = new Map(this.residual.equipment.map((entry) => [entry.instanceId, entry]));
    const ordered: EquippedAvatarItemState[] = [];
    const emitted = new Set<string>();

    for (const instanceId of this.residual.equipmentOrder) {
      const entry = liveById.get(instanceId) ?? unresolvedById.get(instanceId);
      if (!entry || emitted.has(instanceId)) continue;
      ordered.push(entry);
      emitted.add(instanceId);
    }
    for (const entry of live) {
      if (!emitted.has(entry.instanceId)) ordered.push(entry);
    }
    return ordered;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Avatar instance has been disposed');
  }
}

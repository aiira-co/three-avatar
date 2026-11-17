import { Group, SkinnedMesh } from 'three';
import { AppearanceController } from '../appearance/AppearanceController.js';
import { OcclusionSurfaceController } from '../appearance/OcclusionSurfaceController.js';
import type { AvatarAssetLoader } from '../assets/AvatarAssetLoader.js';
import { AvatarMorphController } from '../body/AvatarMorphController.js';
import { BodyVisibilityController } from '../body/BodyVisibilityController.js';
import { EquipmentController } from '../equipment/EquipmentController.js';
import { rebindSkinnedMesh } from '../equipment/rebindSkinnedMesh.js';
import { AvatarFaceController } from '../face/AvatarFaceController.js';
import { AvatarSerializer } from '../format/serializer.js';
import type {
  AvatarFamilyDefinition,
  AvatarResidualState,
  AvatarStateV1,
  VersionedId,
} from '../format/types.js';
import { versionedKey } from '../format/validation.js';
import type { AvatarAssetRegistry } from '../registry/AvatarAssetRegistry.js';
import { AvatarRig } from '../rig/AvatarRig.js';
import { AvatarSocketController } from '../rig/AvatarSocketController.js';
import { AvatarInstance } from './AvatarInstance.js';

export interface AvatarStateIssue {
  kind: 'morph' | 'appearance' | 'equipment';
  /** Morph or material channel the current family does not define. */
  channel?: string;
  item?: VersionedId;
  instanceId?: string;
  error?: unknown;
}

export interface CreateAvatarOptions {
  family: VersionedId;
  state?: AvatarStateV1;
  signal?: AbortSignal;
  /**
   * Fail instead of tolerating any part of a saved avatar the current family
   * cannot apply. Off by default: stored avatars are user data and outlive the
   * family versions that produced them.
   */
  strict?: boolean;
  strictEquipment?: boolean;
  onEquipmentError?: (item: VersionedId, error: unknown) => void;
  onStateIssue?: (issue: AvatarStateIssue) => void;
}

function findBodyMesh(root: Group, family: AvatarFamilyDefinition): SkinnedMesh {
  const object = root.getObjectByName(family.body.meshNode);
  const mesh = object as SkinnedMesh | undefined;
  if (!mesh?.isSkinnedMesh) {
    throw new Error(`Avatar body node "${family.body.meshNode}" is missing or is not a SkinnedMesh`);
  }
  return mesh;
}

function familyAccepts(family: AvatarFamilyDefinition, savedFamily: VersionedId): boolean {
  const key = versionedKey(savedFamily);
  if (versionedKey(family) === key) return true;
  return family.supersedes?.some((superseded) => versionedKey(superseded) === key) ?? false;
}

function findHeadMesh(root: Group, family: AvatarFamilyDefinition): SkinnedMesh | undefined {
  if (!family.head) return undefined;
  const object = root.getObjectByName(family.head.meshNode);
  const mesh = object as SkinnedMesh | undefined;
  if (!mesh?.isSkinnedMesh) {
    throw new Error(`Avatar head node "${family.head.meshNode}" is missing or is not a SkinnedMesh`);
  }
  return mesh;
}

export class AvatarRuntime {
  readonly serializer: AvatarSerializer;

  constructor(
    readonly registry: AvatarAssetRegistry,
    readonly loader: AvatarAssetLoader,
    serializer = new AvatarSerializer(),
  ) {
    this.serializer = serializer;
  }

  async create(options: CreateAvatarOptions): Promise<AvatarInstance> {
    const state = options.state ? this.serializer.clone(options.state) : undefined;
    const family = this.registry.requireFamily(options.family);
    if (state && !familyAccepts(family, state.family)) {
      throw new Error(`Avatar state family ${versionedKey(state.family)} is not accepted by family ${versionedKey(family)}; declare it in "supersedes" to migrate saved avatars`);
    }

    const rigDefinition = this.registry.requireRig(family.rig);
    const loadedBody = await this.loader.load(family.body.asset, options.signal);
    let avatar: AvatarInstance | undefined;

    try {
      const root = new Group();
      root.name = `Avatar:${family.id}`;
      root.add(loadedBody.root);
      const bodyMesh = findBodyMesh(root, family);
      const rig = new AvatarRig(root, bodyMesh.skeleton, rigDefinition);
      const headMesh = findHeadMesh(root, family);
      if (headMesh && headMesh.skeleton !== rig.skeleton) {
        rebindSkinnedMesh(headMesh, rig, bodyMesh.bindMatrix);
      }
      const sockets = new AvatarSocketController(rig, family.sockets ?? []);
      const surfaces = new OcclusionSurfaceController(root, family.occlusionSurfaces ?? {});
      const bodyVisibility = new BodyVisibilityController(
        bodyMesh,
        family.body.regions,
        `${versionedKey(family)}:${versionedKey(family.body.asset)}`,
      );
      const appearance = new AppearanceController();
      const morphs = new AvatarMorphController();

      if (family.materialChannels?.length) appearance.bind(root, family.materialChannels, 'base');
      if (family.morphBindings?.length) morphs.bind(root, family.morphBindings, 'body');
      if (family.face?.morphBindings.length) morphs.bind(root, family.face.morphBindings, 'face');

      const equipmentRoot = new Group();
      equipmentRoot.name = 'AvatarEquipment';
      root.add(equipmentRoot);
      const equipment = new EquipmentController(
        this.registry,
        this.loader,
        family,
        equipmentRoot,
        rig,
        bodyMesh,
        bodyVisibility,
        sockets,
        surfaces,
        appearance,
        morphs,
      );
      const face = family.face ? new AvatarFaceController(morphs, family.face) : undefined;
      avatar = new AvatarInstance(
        family,
        root,
        bodyMesh,
        headMesh,
        rig,
        bodyVisibility,
        equipment,
        appearance,
        morphs,
        sockets,
        surfaces,
        face,
        loadedBody,
      );

      appearance.applyMany('base', family.defaultAppearance ?? {});
      morphs.setMany(family.defaultMorphs ?? {});

      if (state) {
        const strict = options.strict ?? false;
        const residual: AvatarResidualState = {
          morphs: {},
          appearance: {},
          equipment: [],
          equipmentOrder: state.equipment.map((item) => item.instanceId),
        };
        const report = (issue: AvatarStateIssue) => {
          options.onStateIssue?.(issue);
        };

        if (state.body.scale !== undefined) avatar.setScale(state.body.scale);

        for (const [channel, value] of Object.entries(state.body.morphs)) {
          if (morphs.has(channel)) {
            morphs.set(channel, value);
            continue;
          }
          if (strict) throw new Error(`Saved morph channel "${channel}" is not defined by family ${versionedKey(family)}`);
          residual.morphs[channel] = value;
          report({ kind: 'morph', channel });
        }

        for (const [channel, value] of Object.entries(state.appearance)) {
          if (appearance.hasChannel('base', channel)) {
            appearance.apply('base', channel, value);
            continue;
          }
          if (strict) throw new Error(`Saved appearance channel "${channel}" is not defined by family ${versionedKey(family)}`);
          residual.appearance[channel] = value;
          report({ kind: 'appearance', channel });
        }

        avatar.setMetadata(state.metadata);

        for (const item of state.equipment) {
          try {
            await equipment.equip(item.item, {
              instanceId: item.instanceId,
              appearance: item.appearance,
              transform: item.transform,
              signal: options.signal,
            });
          } catch (error) {
            options.onEquipmentError?.(item.item, error);
            report({ kind: 'equipment', item: item.item, instanceId: item.instanceId, error });
            if (strict || (options.strictEquipment ?? false)) throw error;
            residual.equipment.push(item);
          }
        }

        avatar.setResidualState(residual);
      }

      return avatar;
    } catch (error) {
      if (avatar) avatar.dispose();
      else loadedBody.dispose?.();
      throw error;
    }
  }

  /**
   * Restores a saved avatar, resolving its family reference to the installed
   * family that declares `supersedes` for it when the exact version is gone.
   */
  async fromJSON(value: unknown, options: Omit<CreateAvatarOptions, 'family' | 'state'> = {}): Promise<AvatarInstance> {
    const state = this.serializer.parse(value);
    const family = this.registry.resolveFamily(state.family);
    if (!family) {
      throw new Error(`No installed avatar family can load saved family ${versionedKey(state.family)}`);
    }
    return this.create({ ...options, family: { id: family.id, version: family.version }, state });
  }
}

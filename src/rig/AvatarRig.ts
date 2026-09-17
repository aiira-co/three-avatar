import { Bone, Object3D, Skeleton } from 'three';
import type { AvatarRigDefinition } from '../format/types.js';

export function normalizeBoneName(name: string): string {
  return name
    .replace(/^mixamorig[_:]?/i, '')
    .replace(/^bip0?1[_\s-]?/i, '')
    .replace(/^armature[|:_\s-]?/i, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

export class AvatarRigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AvatarRigError';
  }
}

export class AvatarRig {
  private readonly boneBySemanticId = new Map<string, Bone>();
  private readonly semanticIdByAlias = new Map<string, string>();
  private readonly boneByNormalizedName = new Map<string, Bone>();

  constructor(
    readonly root: Object3D,
    readonly skeleton: Skeleton,
    readonly definition: AvatarRigDefinition,
  ) {
    for (const definitionBone of definition.bones) {
      this.semanticIdByAlias.set(normalizeBoneName(definitionBone.id), definitionBone.id);
      for (const alias of definitionBone.aliases) {
        this.semanticIdByAlias.set(normalizeBoneName(alias), definitionBone.id);
      }
    }

    for (const bone of skeleton.bones) {
      this.boneByNormalizedName.set(normalizeBoneName(bone.name), bone);
    }

    for (const definitionBone of definition.bones) {
      const aliases = [definitionBone.id, ...definitionBone.aliases];
      const bone = aliases
        .map((alias) => this.boneByNormalizedName.get(normalizeBoneName(alias)))
        .find((entry): entry is Bone => entry !== undefined);
      if (bone) this.boneBySemanticId.set(definitionBone.id, bone);
      else if (definitionBone.required) {
        throw new AvatarRigError(`Required bone "${definitionBone.id}" was not found in the avatar skeleton`);
      }
    }
  }

  getBone(semanticId: string): Bone | undefined {
    return this.boneBySemanticId.get(semanticId);
  }

  requireBone(semanticId: string): Bone {
    const bone = this.getBone(semanticId);
    if (!bone) throw new AvatarRigError(`Bone "${semanticId}" is not available on this avatar`);
    return bone;
  }

  resolveBone(sourceName: string): Bone | undefined {
    const normalized = normalizeBoneName(sourceName);
    const direct = this.boneByNormalizedName.get(normalized);
    if (direct) return direct;
    const semanticId = this.semanticIdByAlias.get(normalized);
    return semanticId ? this.boneBySemanticId.get(semanticId) : undefined;
  }
}

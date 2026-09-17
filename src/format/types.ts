export interface VersionedId {
  id: string;
  version: string;
}

export type BodyRegionId = string;
export type EquipmentChannelId = string;
export type OcclusionSurfaceId = string;
export type MorphChannelId = string;
export type MaterialChannelId = string;

export type AvatarAssetKind = 'body' | 'wearable' | 'accessory' | 'hair' | 'prop' | 'animation' | 'other';

export interface AvatarAssetDefinition extends VersionedId {
  uri: string;
  kind?: AvatarAssetKind;
  integrity?: string;
  metadata?: Record<string, unknown>;
}

export interface HumanoidBoneDefinition {
  id: string;
  aliases: string[];
  required?: boolean;
}

export interface AvatarRigDefinition extends VersionedId {
  upAxis: '+Y';
  forwardAxis: '+Z' | '-Z';
  handedness: 'right';
  unitsPerMeter: number;
  referencePose: 'T' | 'A';
  rootMotionBone: string;
  bones: HumanoidBoneDefinition[];
}

export interface SerializableTransform {
  position?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}

export interface AvatarSocketDefinition extends SerializableTransform {
  id: string;
  bone: string;
}

export interface BodyRegionDefinition {
  id: BodyRegionId;
  indexOffset: number;
  indexCount: number;
}

/**
 * Optional morph-rich head mesh contained in the family's body GLB.
 *
 * `neckSeamVertexGroup` is authoring metadata. The runtime does not consume
 * Blender vertex groups, but keeping the canonical name in the manifest lets
 * exporters and validators enforce a seam that remains fixed by identity
 * morphs.
 */
export interface AvatarHeadDefinition {
  meshNode: string;
  neckSeamVertexGroup?: string;
}

export interface MorphBindingDefinition {
  channel: MorphChannelId;
  target: string;
  meshNode?: string;
  min?: number;
  max?: number;
}

export type AvatarMaterialProperty =
  | 'color'
  | 'emissive'
  | 'emissiveIntensity'
  | 'roughness'
  | 'metalness'
  | 'opacity';

export interface MaterialTargetDefinition {
  meshNode?: string;
  materialName?: string;
  materialIndex?: number;
}

export interface MaterialChannelDefinition {
  id: MaterialChannelId;
  targets: MaterialTargetDefinition[];
  properties: AvatarMaterialProperty[];
}

export interface AvatarAppearanceValue {
  color?: string;
  emissive?: string;
  emissiveIntensity?: number;
  roughness?: number;
  metalness?: number;
  opacity?: number;
}

export interface FacialExpressionDefinition {
  id: string;
  channels: Record<MorphChannelId, number>;
}

export interface VisemeDefinition {
  id: string;
  channels: Record<MorphChannelId, number>;
}

export interface FaceProfileDefinition {
  morphBindings: MorphBindingDefinition[];
  expressions?: FacialExpressionDefinition[];
  visemes?: VisemeDefinition[];
  bones?: {
    leftEye?: string;
    rightEye?: string;
    jaw?: string;
  };
}

export interface AvatarFamilyDefinition extends VersionedId {
  rig: VersionedId;
  /**
   * Earlier family versions whose saved avatars this family can load.
   * Without it, publishing a new family version orphans every stored
   * `AvatarStateV1` that names the old one.
   */
  supersedes?: VersionedId[];
  body: {
    asset: VersionedId;
    meshNode: string;
    regions: BodyRegionDefinition[];
  };
  head?: AvatarHeadDefinition;
  sockets?: AvatarSocketDefinition[];
  occlusionSurfaces?: Record<OcclusionSurfaceId, string[]>;
  morphBindings?: MorphBindingDefinition[];
  materialChannels?: MaterialChannelDefinition[];
  face?: FaceProfileDefinition;
  defaultAppearance?: Record<MaterialChannelId, AvatarAppearanceValue>;
  defaultMorphs?: Record<MorphChannelId, number>;
  metadata?: Record<string, unknown>;
}

export type AvatarItemKind = 'wearable' | 'hair' | 'accessory' | 'prop';

export type AvatarItemRenderDefinition =
  | {
      type: 'skinned';
      asset: VersionedId;
      meshNodes?: string[];
    }
  | {
      type: 'socket';
      asset: VersionedId;
      socket: string;
      transform?: SerializableTransform;
    };

export interface AvatarItemDefinition extends VersionedId {
  name?: string;
  kind: AvatarItemKind;
  compatibility: {
    families: VersionedId[];
    rig?: VersionedId;
  };
  render: AvatarItemRenderDefinition;
  occupies: EquipmentChannelId[];
  conflicts?: EquipmentChannelId[];
  coversBody?: BodyRegionId[];
  occludes?: OcclusionSurfaceId[];
  materialChannels?: MaterialChannelDefinition[];
  morphBindings?: MorphBindingDefinition[];
  metadata?: Record<string, unknown>;
}

export interface AvatarAssetPackDefinition extends VersionedId {
  dependencies?: VersionedId[];
  assets?: AvatarAssetDefinition[];
  rigs?: AvatarRigDefinition[];
  families?: AvatarFamilyDefinition[];
  items?: AvatarItemDefinition[];
  metadata?: Record<string, unknown>;
}

export interface EquippedAvatarItemState {
  instanceId: string;
  item: VersionedId;
  appearance?: Record<MaterialChannelId, AvatarAppearanceValue>;
}

export interface AvatarStateV1 {
  schema: 'interverse-avatar';
  schemaVersion: 1;
  family: VersionedId;
  body: {
    scale?: number;
    morphs: Record<MorphChannelId, number>;
  };
  appearance: Record<MaterialChannelId, AvatarAppearanceValue>;
  equipment: EquippedAvatarItemState[];
  metadata?: Record<string, unknown>;
}

export interface VisemeCue {
  startTime: number;
  duration: number;
  viseme: string;
  weight?: number;
}

/**
 * Parts of a saved avatar the current family could not apply: channels that
 * were retired, or equipment that failed to resolve. They are reported to the
 * host and preserved verbatim so re-saving never destroys user data.
 */
export interface AvatarResidualState {
  morphs: Record<MorphChannelId, number>;
  appearance: Record<MaterialChannelId, AvatarAppearanceValue>;
  equipment: EquippedAvatarItemState[];
  equipmentOrder: string[];
}

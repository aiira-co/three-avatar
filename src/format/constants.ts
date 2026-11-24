import type {
  AvatarAssetPackDefinition,
  AvatarRigDefinition,
  BodyRegionId,
  EquipmentChannelId,
  MorphChannelId,
} from './types.js';

export const AVATAR_SCHEMA = 'interverse-avatar' as const;
export const AVATAR_SCHEMA_VERSION = 1 as const;

export const HUMANOID_BODY_REGIONS = {
  Head: 'head',
  Neck: 'neck',
  UpperTorso: 'torso.upper',
  LowerTorso: 'torso.lower',
  Pelvis: 'pelvis',
  LeftUpperArm: 'arm.upper.left',
  RightUpperArm: 'arm.upper.right',
  LeftLowerArm: 'arm.lower.left',
  RightLowerArm: 'arm.lower.right',
  LeftHand: 'hand.left',
  RightHand: 'hand.right',
  LeftUpperLeg: 'leg.upper.left',
  RightUpperLeg: 'leg.upper.right',
  LeftLowerLeg: 'leg.lower.left',
  RightLowerLeg: 'leg.lower.right',
  LeftFoot: 'foot.left',
  RightFoot: 'foot.right',
} as const satisfies Record<string, BodyRegionId>;

/** Canonical Blender face/vertex-group names used by the body-region compiler. */
export const HUMANOID_BODY_VERTEX_GROUPS = {
  Head: 'region.head',
  Neck: 'region.neck',
  UpperTorso: 'region.torso.upper',
  LowerTorso: 'region.torso.lower',
  Pelvis: 'region.pelvis',
  LeftUpperArm: 'region.arm.upper.left',
  RightUpperArm: 'region.arm.upper.right',
  LeftLowerArm: 'region.arm.lower.left',
  RightLowerArm: 'region.arm.lower.right',
  LeftHand: 'region.hand.left',
  RightHand: 'region.hand.right',
  LeftUpperLeg: 'region.leg.upper.left',
  RightUpperLeg: 'region.leg.upper.right',
  LeftLowerLeg: 'region.leg.lower.left',
  RightLowerLeg: 'region.leg.lower.right',
  LeftFoot: 'region.foot.left',
  RightFoot: 'region.foot.right',
  NeckSeam: 'seam.neck',
} as const;

/** Optional Blender selection groups for repeatable facial sculpting and QA. */
export const HUMANOID_HEAD_VERTEX_GROUPS = {
  Forehead: 'feature.forehead',
  LeftBrow: 'feature.brow.left',
  RightBrow: 'feature.brow.right',
  LeftEye: 'feature.eye.left',
  RightEye: 'feature.eye.right',
  Nose: 'feature.nose',
  LeftCheek: 'feature.cheek.left',
  RightCheek: 'feature.cheek.right',
  Mouth: 'feature.mouth',
  Jaw: 'feature.jaw',
  LeftEar: 'feature.ear.left',
  RightEar: 'feature.ear.right',
  NeckSeam: 'seam.neck',
} as const;

/**
 * Stable identity channels for the first Interverse humanoid family.
 * Presets such as masculine, feminine, and neutral are recipes over these
 * values; they are not separate rigs or compatibility families.
 */
export const HUMANOID_IDENTITY_MORPH_CHANNELS = {
  BodyMasculine: 'body.archetype.masculine',
  BodyFeminine: 'body.archetype.feminine',
  ShoulderWidth: 'body.shoulderWidth',
  ChestVolume: 'body.chestVolume',
  WaistWidth: 'body.waistWidth',
  HipWidth: 'body.hipWidth',
  GluteVolume: 'body.gluteVolume',
  Muscularity: 'body.muscularity',
  BodyFat: 'body.bodyFat',
  ArmThickness: 'body.armThickness',
  LegThickness: 'body.legThickness',
  HeadWidth: 'head.width',
  HeadHeight: 'head.height',
  HeadDepth: 'head.depth',
  FaceWidth: 'face.width',
  FaceLength: 'face.length',
  JawWidth: 'jaw.width',
  JawProjection: 'jaw.projection',
  ChinWidth: 'chin.width',
  ChinProjection: 'chin.projection',
  CheekWidth: 'cheek.width',
  CheekFullness: 'cheek.fullness',
  NoseWidth: 'nose.width',
  NoseLength: 'nose.length',
  NoseProjection: 'nose.projection',
  EyeSpacing: 'eye.spacing',
  EyeSize: 'eye.size',
  MouthWidth: 'mouth.width',
  MouthFullness: 'mouth.fullness',
} as const satisfies Record<string, MorphChannelId>;

export const STANDARD_EQUIPMENT_CHANNELS = {
  Hair: 'hair',
  HeadBase: 'head.base',
  HeadOuter: 'head.outer',
  FaceEyes: 'face.eyes',
  FaceMask: 'face.mask',
  FaceLeft: 'face.left',
  FaceRight: 'face.right',
  EarLeft: 'ear.left',
  EarRight: 'ear.right',
  Neck: 'neck',
  UpperUnder: 'upper.under',
  UpperBase: 'upper.base',
  UpperOuter: 'upper.outer',
  UpperArmor: 'upper.armor',
  LowerUnder: 'lower.under',
  LowerBase: 'lower.base',
  LowerOuter: 'lower.outer',
  Outfit: 'outfit',
  Hands: 'hands',
  LeftHand: 'hands.left',
  RightHand: 'hands.right',
  Feet: 'feet',
  FeetSocks: 'feet.socks',
  LeftFoot: 'feet.left',
  RightFoot: 'feet.right',
  Back: 'back',
  Waist: 'waist',
} as const satisfies Record<string, EquipmentChannelId>;

export const LAYERING_METADATA_KEY = 'layering' as const;
export const POSE_OFFSETS_METADATA_KEY = 'poseOffsets' as const;
export const HEAD_ARCHETYPES_METADATA_KEY = 'headArchetypes' as const;
export const EXPRESSION_MOOD_METADATA_KEY = 'mood' as const;
export const MOOD_BUBBLE_METADATA_KEY = 'moodBubble' as const;

export const MOOD_BUBBLE_STYLES = ['anime', 'bubble', 'card', 'icon'] as const;
export const MOOD_BUBBLE_MODES = ['always', 'reactions'] as const;
export const MOOD_BUBBLE_PLACEMENTS = ['center', 'temple'] as const;

export const HEAD_ARCHETYPE_REGIONS = [
  'cranium',
  'brows_eyes',
  'nose',
  'cheeks',
  'mouth',
  'jaw_chin',
  'ears',
] as const;

export const ARKIT_CORE_EXPRESSION_CHANNELS = [
  'browInnerUp',
  'browDownLeft',
  'browDownRight',
  'browOuterUpLeft',
  'browOuterUpRight',
  'eyeWideLeft',
  'eyeWideRight',
  'eyeSquintLeft',
  'eyeSquintRight',
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'cheekSquintLeft',
  'cheekSquintRight',
  'cheekPuff',
  'noseSneerLeft',
  'noseSneerRight',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthPucker',
  'mouthFunnel',
  'mouthDimpleLeft',
  'mouthDimpleRight',
  'mouthShrugLower',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  'jawOpen',
] as const;

export const EXPRESSION_MOOD_IDS = [
  'neutral',
  'smile',
  'happy',
  'laugh',
  'angry',
  'frustrated',
  'surprised',
  'sad',
  'cry',
  'bold',
  'skeptical',
  'shy',
  'focused',
  'love',
] as const;

export const MIXAMO_HUMANOID_RIG_V1: AvatarRigDefinition = {
  id: 'interverse:rig/humanoid-mixamo',
  version: '1.0.0',
  upAxis: '+Y',
  forwardAxis: '-Z',
  handedness: 'right',
  unitsPerMeter: 1,
  referencePose: 'T',
  rootMotionBone: 'hips',
  bones: [
    { id: 'hips', aliases: ['Hips', 'mixamorig:Hips', 'mixamorigHips'], required: true },
    { id: 'spine', aliases: ['Spine', 'mixamorig:Spine', 'mixamorigSpine'], required: true },
    { id: 'spine1', aliases: ['Spine1', 'mixamorig:Spine1', 'mixamorigSpine1'], required: true },
    { id: 'spine2', aliases: ['Spine2', 'mixamorig:Spine2', 'mixamorigSpine2'], required: true },
    { id: 'neck', aliases: ['Neck', 'mixamorig:Neck', 'mixamorigNeck'], required: true },
    { id: 'head', aliases: ['Head', 'mixamorig:Head', 'mixamorigHead'], required: true },
    { id: 'shoulder.left', aliases: ['LeftShoulder', 'mixamorig:LeftShoulder', 'mixamorigLeftShoulder'], required: true },
    { id: 'arm.upper.left', aliases: ['LeftUpperArm', 'mixamorig:LeftArm', 'mixamorigLeftArm'], required: true },
    { id: 'arm.lower.left', aliases: ['LeftLowerArm', 'mixamorig:LeftForeArm', 'mixamorigLeftForeArm'], required: true },
    { id: 'hand.left', aliases: ['LeftHand', 'mixamorig:LeftHand', 'mixamorigLeftHand'], required: true },
    { id: 'shoulder.right', aliases: ['RightShoulder', 'mixamorig:RightShoulder', 'mixamorigRightShoulder'], required: true },
    { id: 'arm.upper.right', aliases: ['RightUpperArm', 'mixamorig:RightArm', 'mixamorigRightArm'], required: true },
    { id: 'arm.lower.right', aliases: ['RightLowerArm', 'mixamorig:RightForeArm', 'mixamorigRightForeArm'], required: true },
    { id: 'hand.right', aliases: ['RightHand', 'mixamorig:RightHand', 'mixamorigRightHand'], required: true },
    { id: 'leg.upper.left', aliases: ['LeftUpperLeg', 'mixamorig:LeftUpLeg', 'mixamorigLeftUpLeg'], required: true },
    { id: 'leg.lower.left', aliases: ['LeftLowerLeg', 'mixamorig:LeftLeg', 'mixamorigLeftLeg'], required: true },
    { id: 'foot.left', aliases: ['LeftFoot', 'mixamorig:LeftFoot', 'mixamorigLeftFoot'], required: true },
    { id: 'toes.left', aliases: ['LeftToes', 'mixamorig:LeftToeBase', 'mixamorigLeftToeBase'] },
    { id: 'leg.upper.right', aliases: ['RightUpperLeg', 'mixamorig:RightUpLeg', 'mixamorigRightUpLeg'], required: true },
    { id: 'leg.lower.right', aliases: ['RightLowerLeg', 'mixamorig:RightLeg', 'mixamorigRightLeg'], required: true },
    { id: 'foot.right', aliases: ['RightFoot', 'mixamorig:RightFoot', 'mixamorigRightFoot'], required: true },
    { id: 'toes.right', aliases: ['RightToes', 'mixamorig:RightToeBase', 'mixamorigRightToeBase'] },
    { id: 'eye.left', aliases: ['eye.L', 'EyeLeft', 'LeftEye'] },
    { id: 'eye.right', aliases: ['eye.R', 'EyeRight', 'RightEye'] },
    { id: 'jaw', aliases: ['jaw', 'Jaw'] },
    { id: 'tongue', aliases: ['tongue', 'Tongue'] },
  ],
};

export const INTERVERSE_RIG_PACK_V1: AvatarAssetPackDefinition = {
  id: 'interverse:pack/rigs',
  version: '1.0.0',
  rigs: [MIXAMO_HUMANOID_RIG_V1],
};

import { Bone, Euler, MathUtils, Quaternion } from 'three';
import { POSE_OFFSETS_METADATA_KEY } from '../format/constants.js';
import type { AvatarPoseOffsetState, BonePoseOffset } from '../format/types.js';
import type { AvatarInstance } from '../runtime/AvatarInstance.js';

export interface RigBoneLookup {
  getBone(semanticId: string): Bone | undefined;
  resolveBone(sourceName: string): Bone | undefined;
}

export interface AutoPoseClearanceInputs {
  /** Normalized 0..1 (or 0..100 slider values, automatically scaled). */
  bust?: number;
  chestVolume?: number;
  waist?: number;
  hips?: number;
  upperArms?: number;
  thighs?: number;
  outerBulk?: number;
}

/** Max per-axis Euler rotation offset (degrees) allowed per anatomical bone group. */
export const POSE_OFFSET_LIMITS: Readonly<Record<string, number>> = {
  'arm.upper.left': 25,
  'arm.upper.right': 25,
  'arm.lower.left': 25,
  'arm.lower.right': 25,
  'leg.upper.left': 25,
  'leg.upper.right': 25,
  'leg.lower.left': 25,
  'leg.lower.right': 25,
  'shoulder.left': 15,
  'shoulder.right': 15,
  spine: 10,
  spine1: 10,
  spine2: 10,
  neck: 10,
  head: 10,
  hips: 0,
  root: 0,
};

const DEFAULT_BONE_LIMIT = 15;

const CANONICAL_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  'arm.upper.left': ['arm.upper.left', 'leftarm', 'leftupperarm', 'mixamorigLeftArm'],
  'arm.upper.right': ['arm.upper.right', 'rightarm', 'rightupperarm', 'mixamorigRightArm'],
  'arm.lower.left': ['arm.lower.left', 'leftforearm', 'leftlowerarm', 'mixamorigLeftForeArm'],
  'arm.lower.right': ['arm.lower.right', 'rightforearm', 'rightlowerarm', 'mixamorigRightForeArm'],
  'leg.upper.left': ['leg.upper.left', 'leftupleg', 'leftupperleg', 'mixamorigLeftUpLeg'],
  'leg.upper.right': ['leg.upper.right', 'rightupleg', 'rightupperleg', 'mixamorigRightUpLeg'],
  'leg.lower.left': ['leg.lower.left', 'leftleg', 'leftlowerleg', 'mixamorigLeftLeg'],
  'leg.lower.right': ['leg.lower.right', 'rightleg', 'rightlowerleg', 'mixamorigRightLeg'],
  'shoulder.left': ['shoulder.left', 'leftshoulder', 'mixamorigLeftShoulder'],
  'shoulder.right': ['shoulder.right', 'rightshoulder', 'mixamorigRightShoulder'],
  hips: ['hips', 'root', 'Hips', 'mixamorigHips'],
  root: ['root', 'hips', 'Hips', 'mixamorigHips'],
  spine: ['spine', 'Spine', 'mixamorigSpine'],
  spine1: ['spine1', 'Spine1', 'mixamorigSpine1'],
  spine2: ['spine2', 'Spine2', 'mixamorigSpine2'],
  neck: ['neck', 'Neck', 'mixamorigNeck'],
  head: ['head', 'Head', 'mixamorigHead'],
};

const ALIAS_TO_CANONICAL = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(CANONICAL_SYNONYMS)) {
  for (const alias of aliases) {
    ALIAS_TO_CANONICAL.set(alias.replace(/[^a-z0-9]/gi, '').toLowerCase(), canonical);
  }
}

function canonicalBoneKey(boneId: string): string {
  const stripped = boneId
    .replace(/^mixamorig\d*[_:]?/i, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
  return ALIAS_TO_CANONICAL.get(stripped) ?? boneId;
}

export function poseLimitForBone(boneId: string): number {
  const canonical = canonicalBoneKey(boneId);
  return POSE_OFFSET_LIMITS[canonical] ?? POSE_OFFSET_LIMITS[boneId] ?? DEFAULT_BONE_LIMIT;
}

function clampOffsetToBoneLimit(boneId: string, offset: BonePoseOffset): [number, number, number] {
  const limit = poseLimitForBone(boneId);
  if (limit <= 0) return [0, 0, 0];
  const clamp = (v: number) => (Number.isFinite(v) ? Math.max(-limit, Math.min(limit, v)) : 0);
  return [clamp(offset[0]), clamp(offset[1]), clamp(offset[2])];
}

function isZeroOffset(offset: readonly [number, number, number]): boolean {
  return Math.abs(offset[0]) < 1e-4 && Math.abs(offset[1]) < 1e-4 && Math.abs(offset[2]) < 1e-4;
}

function parseTuple(raw: unknown): BonePoseOffset | undefined {
  if (!Array.isArray(raw) || raw.length !== 3) return undefined;
  const [x, y, z] = raw;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return undefined;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined;
  return [x, y, z];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeOffsetMap(raw: unknown): Record<string, BonePoseOffset> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, BonePoseOffset> = {};
  for (const [boneId, entry] of Object.entries(raw)) {
    const parsed = parseTuple(entry);
    if (!parsed) continue;
    const clamped = clampOffsetToBoneLimit(boneId, parsed);
    if (!isZeroOffset(clamped)) out[boneId] = clamped;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizePoseOffsetState(raw: unknown): AvatarPoseOffsetState {
  if (!isRecord(raw)) return {};
  const result: AvatarPoseOffsetState = {};
  if (typeof raw['auto'] === 'boolean') result.auto = raw['auto'];
  if (typeof raw['symmetric'] === 'boolean') result.symmetric = raw['symmetric'];

  const global = sanitizeOffsetMap(raw['global']);
  if (global) result.global = global;

  if (isRecord(raw['perClip'])) {
    const perClip: Record<string, Record<string, BonePoseOffset>> = {};
    for (const [clipName, map] of Object.entries(raw['perClip'])) {
      if (!clipName) continue;
      const sanitized = sanitizeOffsetMap(map);
      if (sanitized) perClip[clipName] = sanitized;
    }
    if (Object.keys(perClip).length > 0) result.perClip = perClip;
  }
  return result;
}

export function readPoseOffsetState(avatar: AvatarInstance): AvatarPoseOffsetState {
  return normalizePoseOffsetState(avatar.serialize().metadata?.[POSE_OFFSETS_METADATA_KEY]);
}

export function writePoseOffsetState(avatar: AvatarInstance, state: AvatarPoseOffsetState): AvatarPoseOffsetState {
  const normalized = normalizePoseOffsetState(state);
  const current = avatar.serialize().metadata ?? {};
  const next: Record<string, unknown> = { ...current };
  if (Object.keys(normalized).length === 0) {
    delete next[POSE_OFFSETS_METADATA_KEY];
  } else {
    next[POSE_OFFSETS_METADATA_KEY] = normalized;
  }
  avatar.setMetadata(Object.keys(next).length > 0 ? next : undefined);
  return normalized;
}

/** Returns the contralateral bone ID for a left/right bone, or `undefined` for midline bones. */
export function mirrorBoneId(boneId: string): string | undefined {
  if (boneId.includes('.left')) return boneId.replace('.left', '.right');
  if (boneId.includes('.right')) return boneId.replace('.right', '.left');
  if (boneId.includes('Left')) return boneId.replace('Left', 'Right');
  if (boneId.includes('Right')) return boneId.replace('Right', 'Left');
  if (boneId.startsWith('left')) return `right${boneId.slice(4)}`;
  if (boneId.startsWith('right')) return `left${boneId.slice(5)}`;
  return undefined;
}

/** Mirrors a bone Euler offset `[rx, ry, rz]` across the sagittal (YZ) plane. */
export function mirrorBoneOffset(deg: BonePoseOffset): [number, number, number] {
  return [deg[0], -deg[1], -deg[2]];
}

function normalizeUnit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? Math.min(1, value / 100) : Math.min(1, value);
}

/**
 * Tier-1 Automatic Posture Clearance: computes subtle abduction/spread bone offsets from body
 * proportions and outer garment bulk so arms and thighs clear torso/coat volume during locomotion.
 */
export function computeAutoPoseOffsets(inputs: AutoPoseClearanceInputs): Record<string, BonePoseOffset> {
  const chest = Math.max(normalizeUnit(inputs.bust), normalizeUnit(inputs.chestVolume));
  const waist = normalizeUnit(inputs.waist);
  const hips = normalizeUnit(inputs.hips);
  const upperArms = normalizeUnit(inputs.upperArms);
  const thighs = normalizeUnit(inputs.thighs);
  const outerBulk = normalizeUnit(inputs.outerBulk);

  const armSignal = Math.min(1, chest * 0.45 + waist * 0.2 + upperArms * 0.35 + outerBulk * 0.65);
  const legSignal = Math.min(1, hips * 0.55 + thighs * 0.45 + outerBulk * 0.25);

  const out: Record<string, BonePoseOffset> = {};
  if (armSignal > 0.01) {
    const upperArmSpread = Math.round((2 + armSignal * 10) * 100) / 100;
    const forearmFlare = Math.round((armSignal * 4) * 100) / 100;
    const shoulderSpread = Math.round((armSignal * 3) * 100) / 100;
    out['arm.upper.left'] = [0, 0, upperArmSpread];
    out['arm.upper.right'] = [0, 0, -upperArmSpread];
    out['arm.lower.left'] = [0, 0, forearmFlare];
    out['arm.lower.right'] = [0, 0, -forearmFlare];
    out['shoulder.left'] = [0, 0, shoulderSpread];
    out['shoulder.right'] = [0, 0, -shoulderSpread];
  }
  if (legSignal > 0.01) {
    const thighSpread = Math.round((1 + legSignal * 4) * 100) / 100;
    out['leg.upper.left'] = [0, 0, thighSpread];
    out['leg.upper.right'] = [0, 0, -thighSpread];
  }
  return out;
}

function resolveRigBone(rig: RigBoneLookup, boneId: string): Bone | undefined {
  const direct = rig.getBone(boneId) ?? rig.resolveBone(boneId);
  if (direct) return direct;
  const canonical = canonicalBoneKey(boneId);
  const synonyms = CANONICAL_SYNONYMS[canonical];
  if (!synonyms) return undefined;
  for (const alias of synonyms) {
    const found = rig.getBone(alias) ?? rig.resolveBone(alias);
    if (found) return found;
  }
  return undefined;
}

/**
 * Post-mixer, pre-IK bone pose offset controller.
 *
 * Saves original bone quaternions on `apply()` and restores them on `restore()` before the next
 * `AnimationMixer.update()`, preventing drift on unkeyed bones. Offsets are pre-multiplied in
 * parent space so limb abduction stays consistently outward throughout swing cycles.
 */
export class PoseOffsetController {
  private state: AvatarPoseOffsetState = { auto: true, symmetric: true };
  private autoOffsets: Record<string, BonePoseOffset> = {};
  private readonly savedBones: { bone: Bone; quaternion: Quaternion }[] = [];
  private readonly euler = new Euler(0, 0, 0, 'XYZ');
  private readonly offsetQuat = new Quaternion();

  constructor(private readonly rig: RigBoneLookup, initialState?: AvatarPoseOffsetState) {
    if (initialState) this.setState(initialState);
  }

  setState(state: AvatarPoseOffsetState): void {
    this.restore();
    const normalized = normalizePoseOffsetState(state);
    this.state = {
      auto: normalized.auto ?? true,
      symmetric: normalized.symmetric ?? true,
      ...(normalized.global ? { global: normalized.global } : {}),
      ...(normalized.perClip ? { perClip: normalized.perClip } : {}),
    };
  }

  getState(): AvatarPoseOffsetState {
    return normalizePoseOffsetState(this.state);
  }

  setAutoInputs(inputs: AutoPoseClearanceInputs): void {
    this.autoOffsets = computeAutoPoseOffsets(inputs);
  }

  setGlobalOffset(boneId: string, deg: BonePoseOffset, symmetric = this.state.symmetric ?? true): void {
    const nextGlobal = { ...(this.state.global ?? {}) };
    const clamped = clampOffsetToBoneLimit(boneId, deg);
    if (isZeroOffset(clamped)) delete nextGlobal[boneId];
    else nextGlobal[boneId] = clamped;

    if (symmetric) {
      const mirrorId = mirrorBoneId(boneId);
      if (mirrorId) {
        const mirrored = clampOffsetToBoneLimit(mirrorId, mirrorBoneOffset(clamped));
        if (isZeroOffset(mirrored)) delete nextGlobal[mirrorId];
        else nextGlobal[mirrorId] = mirrored;
      }
    }
    this.state = {
      ...this.state,
      ...(Object.keys(nextGlobal).length > 0 ? { global: nextGlobal } : { global: undefined }),
    };
  }

  setClipOffset(
    clipName: string,
    boneId: string,
    deg: BonePoseOffset,
    symmetric = this.state.symmetric ?? true,
  ): void {
    const nextPerClip = { ...(this.state.perClip ?? {}) };
    const clipMap = { ...(nextPerClip[clipName] ?? {}) };
    const clamped = clampOffsetToBoneLimit(boneId, deg);
    if (isZeroOffset(clamped)) delete clipMap[boneId];
    else clipMap[boneId] = clamped;

    if (symmetric) {
      const mirrorId = mirrorBoneId(boneId);
      if (mirrorId) {
        const mirrored = clampOffsetToBoneLimit(mirrorId, mirrorBoneOffset(clamped));
        if (isZeroOffset(mirrored)) delete clipMap[mirrorId];
        else clipMap[mirrorId] = mirrored;
      }
    }
    if (Object.keys(clipMap).length > 0) nextPerClip[clipName] = clipMap;
    else delete nextPerClip[clipName];

    this.state = {
      ...this.state,
      ...(Object.keys(nextPerClip).length > 0 ? { perClip: nextPerClip } : { perClip: undefined }),
    };
  }

  clearClip(clipName: string): void {
    if (!this.state.perClip?.[clipName]) return;
    const nextPerClip = { ...this.state.perClip };
    delete nextPerClip[clipName];
    this.state = {
      ...this.state,
      ...(Object.keys(nextPerClip).length > 0 ? { perClip: nextPerClip } : { perClip: undefined }),
    };
  }

  reset(): void {
    this.restore();
    this.state = { auto: true, symmetric: true };
  }

  /**
   * Computes effective clamped offsets for `activeClipName`.
   * Per-clip manual offsets override global manual offsets per bone, added on top of Tier-1 auto
   * clearance when enabled.
   */
  getEffectiveOffsets(activeClipName?: string): Record<string, [number, number, number]> {
    const combined = new Map<string, { boneId: string; deg: [number, number, number] }>();

    if (this.state.auto !== false) {
      for (const [boneId, deg] of Object.entries(this.autoOffsets)) {
        const key = canonicalBoneKey(boneId);
        combined.set(key, { boneId, deg: [deg[0], deg[1], deg[2]] });
      }
    }

    const manual = new Map<string, { boneId: string; deg: BonePoseOffset }>();
    for (const [boneId, deg] of Object.entries(this.state.global ?? {})) {
      manual.set(canonicalBoneKey(boneId), { boneId, deg });
    }
    if (activeClipName && this.state.perClip?.[activeClipName]) {
      for (const [boneId, deg] of Object.entries(this.state.perClip[activeClipName])) {
        manual.set(canonicalBoneKey(boneId), { boneId, deg });
      }
    }

    for (const [key, entry] of manual) {
      const base = combined.get(key)?.deg ?? [0, 0, 0];
      combined.set(key, {
        boneId: entry.boneId,
        deg: [base[0] + entry.deg[0], base[1] + entry.deg[1], base[2] + entry.deg[2]],
      });
    }

    const out: Record<string, [number, number, number]> = {};
    for (const entry of combined.values()) {
      const clamped = clampOffsetToBoneLimit(entry.boneId, entry.deg);
      if (!isZeroOffset(clamped)) out[entry.boneId] = clamped;
    }
    return out;
  }

  /** Restores bone quaternions saved during the previous `apply()` call. */
  restore(): void {
    for (let i = this.savedBones.length - 1; i >= 0; i--) {
      const saved = this.savedBones[i]!;
      saved.bone.quaternion.copy(saved.quaternion);
    }
    this.savedBones.length = 0;
  }

  /**
   * Applies effective bone offsets in parent frame (`bone.quaternion.premultiply(offsetQuat)`).
   * Always restores any previously saved state first so repeated calls stay drift-free.
   */
  apply(activeClipName?: string): void {
    this.restore();
    const offsets = this.getEffectiveOffsets(activeClipName);
    const seenBones = new Set<Bone>();

    for (const [boneId, deg] of Object.entries(offsets)) {
      const bone = resolveRigBone(this.rig, boneId);
      if (!bone || seenBones.has(bone)) continue;
      seenBones.add(bone);

      this.savedBones.push({ bone, quaternion: bone.quaternion.clone() });
      this.euler.set(
        MathUtils.degToRad(deg[0]),
        MathUtils.degToRad(deg[1]),
        MathUtils.degToRad(deg[2]),
        'XYZ',
      );
      this.offsetQuat.setFromEuler(this.euler);
      bone.quaternion.premultiply(this.offsetQuat);
    }
  }
}

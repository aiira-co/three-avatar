import { type Bone, Euler, Quaternion, Vector3 } from 'three';
import type { NormalizedLandmark } from './PoseLandmarkSolver.js';

export type HandSide = 'left' | 'right';
export type FingerDigit = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';
export type FingerJointIndex = 1 | 2 | 3;
export type HandFingerBoneId = `hand.${HandSide}.${FingerDigit}.${FingerJointIndex}`;

export interface MediaPipeHandDetection {
  landmarks: readonly NormalizedLandmark[];
  worldLandmarks?: readonly NormalizedLandmark[];
  handedness: 'Left' | 'Right' | string;
  score?: number;
}

export interface HandSolveOptions {
  /** Flip horizontal X / swap left & right hands (selfie webcam preview). Default `true`. */
  mirrored?: boolean;
  /** Minimum handedness detection confidence required to drive finger bones. Default `0.3`. */
  minConfidence?: number;
  /** Multiplier applied to finger curl angles (`0.25..1.5`). Default `1`. */
  curlScale?: number;
  /** Multiplier applied to MCP spread angles (`0..1.5`). Default `1`. */
  spreadScale?: number;
}

export interface SingleHandSolvedPose {
  side: HandSide;
  boneRotations: Record<string, [number, number, number, number]>;
  confidence: number;
}

export interface MocapSolvedHands {
  /** Delta local rotations `[x, y, z, w]` keyed by `hand.<side>.<digit>.<1|2|3>` semantic IDs. */
  boneRotations: Record<string, [number, number, number, number]>;
  /** Avatar hand sides solved in this frame. */
  trackedHands: HandSide[];
  /** Average confidence across tracked hands (`0..1`). */
  confidence: number;
}

export interface HandRigLike {
  getBone(semanticId: string): Bone | undefined;
  resolveBone?(sourceName: string): Bone | undefined;
}

const HAND_SIDES: readonly HandSide[] = ['left', 'right'];
const FINGER_DIGITS: readonly FingerDigit[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const FINGER_JOINTS: readonly FingerJointIndex[] = [1, 2, 3];

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Canonical semantic bone IDs for all 30 humanoid finger joints (`hand.<side>.<digit>.<1..3>`). */
export const HAND_FINGER_BONE_IDS: readonly HandFingerBoneId[] = HAND_SIDES.flatMap((side) =>
  FINGER_DIGITS.flatMap((digit) =>
    FINGER_JOINTS.map((joint) => `hand.${side}.${digit}.${joint}` as HandFingerBoneId),
  ),
);

function buildFingerBoneAliases(): Readonly<Record<HandFingerBoneId, readonly string[]>> {
  const aliases: Partial<Record<HandFingerBoneId, readonly string[]>> = {};
  for (const side of HAND_SIDES) {
    const capSide = capitalize(side);
    for (const digit of FINGER_DIGITS) {
      const capDigit = capitalize(digit);
      for (const joint of FINGER_JOINTS) {
        const id = `hand.${side}.${digit}.${joint}` as HandFingerBoneId;
        const base = `${capSide}Hand${capDigit}${joint}`;
        aliases[id] = [`mixamorig${base}`, `mixamorig:${base}`, base];
      }
    }
  }
  return aliases as Record<HandFingerBoneId, readonly string[]>;
}

/** Mixamo and generic bone name aliases for every canonical finger bone ID. */
export const HAND_FINGER_BONE_ALIASES: Readonly<Record<HandFingerBoneId, readonly string[]>> =
  buildFingerBoneAliases();

/**
 * Resolves a canonical finger bone ID (`hand.left.index.1`, etc.) on an `AvatarRig`,
 * checking direct semantic registration first and falling back to `AvatarRig.resolveBone`
 * with Mixamo aliases.
 */
export function resolveHandFingerBone(rig: HandRigLike | undefined, boneId: string): Bone | undefined {
  if (!rig) return undefined;
  const direct = rig.getBone(boneId);
  if (direct) return direct;
  if (typeof rig.resolveBone !== 'function') return undefined;
  const byId = rig.resolveBone(boneId);
  if (byId) return byId;
  const aliases = HAND_FINGER_BONE_ALIASES[boneId as HandFingerBoneId];
  if (!aliases) return undefined;
  for (const alias of aliases) {
    const resolved = rig.resolveBone(alias);
    if (resolved) return resolved;
  }
  return undefined;
}

// MediaPipe Hand 21-point landmark indices
const LM_WRIST = 0;
const LM_THUMB_CMC = 1;
const LM_THUMB_MCP = 2;
const LM_THUMB_IP = 3;
const LM_THUMB_TIP = 4;
const LM_INDEX_MCP = 5;
const LM_MIDDLE_MCP = 9;
const LM_RING_MCP = 13;
const LM_PINKY_MCP = 17;

const FINGER_CHAINS: readonly { digit: Exclude<FingerDigit, 'thumb'>; indices: readonly [number, number, number, number] }[] = [
  { digit: 'index', indices: [LM_INDEX_MCP, 6, 7, 8] },
  { digit: 'middle', indices: [LM_MIDDLE_MCP, 10, 11, 12] },
  { digit: 'ring', indices: [LM_RING_MCP, 14, 15, 16] },
  { digit: 'pinky', indices: [LM_PINKY_MCP, 18, 19, 20] },
];

// Anatomical limits (radians) matched to Mixamo local finger axes (+X curl/flexion, Z spread/splay)
const FINGER_LIMITS = {
  mcpCurlMin: -0.25,
  mcpCurlMax: 1.48,
  mcpSpreadMax: 0.38,
  pipCurlMin: 0,
  pipCurlMax: 1.85,
  dipCurlMin: 0,
  dipCurlMax: 1.35,
  thumbCmcCurlMin: -0.35,
  thumbCmcCurlMax: 0.95,
  thumbCmcSpreadMin: -0.55,
  thumbCmcSpreadMax: 0.65,
  thumbMcpCurlMin: -0.15,
  thumbMcpCurlMax: 1.15,
  thumbIpCurlMin: -0.2,
  thumbIpCurlMax: 1.35,
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function landmarkToHandVec(lm: NormalizedLandmark, mirrored: boolean): Vector3 {
  const x = mirrored ? -(lm.x - 0.5) : lm.x - 0.5;
  const y = -(lm.y - 0.5);
  const z = -lm.z;
  return new Vector3(x, y, z);
}

function resolveAvatarSide(handedness: string, mirrored: boolean): HandSide {
  const normalized = handedness.trim().toLowerCase();
  const isLeft = normalized.startsWith('l');
  if (mirrored) {
    return isLeft ? 'right' : 'left';
  }
  return isLeft ? 'left' : 'right';
}

function signedAngleAroundAxis(a: Vector3, b: Vector3, axis: Vector3): number {
  const cross = new Vector3().crossVectors(a, b);
  const sinVal = cross.dot(axis);
  const cosVal = clamp(a.dot(b), -1, 1);
  return Math.atan2(sinVal, cosVal);
}

function quatTupleFromEuler(rx: number, ry: number, rz: number): [number, number, number, number] {
  const q = new Quaternion().setFromEuler(new Euler(rx, ry, rz, 'XYZ')).normalize();
  return [q.x, q.y, q.z, q.w];
}

/**
 * Solves a single 21-point MediaPipe `HandLandmarker` hand into anatomically clamped
 * Mixamo local delta quaternions (`hand.<side>.<digit>.<1..3>`).
 */
export function solveSingleHandLandmarksToRig(
  landmarks: readonly NormalizedLandmark[],
  handedness: string,
  options: HandSolveOptions = {},
): SingleHandSolvedPose {
  const mirrored = options.mirrored ?? true;
  const curlScale = Number.isFinite(options.curlScale) ? clamp(options.curlScale ?? 1, 0.25, 1.5) : 1;
  const spreadScale = Number.isFinite(options.spreadScale) ? clamp(options.spreadScale ?? 1, 0, 1.5) : 1;
  const side = resolveAvatarSide(handedness, mirrored);
  const boneRotations: Record<string, [number, number, number, number]> = {};

  if (landmarks.length < 21) {
    return { side, boneRotations, confidence: 0 };
  }

  const pts = landmarks.slice(0, 21).map((lm) => landmarkToHandVec(lm, mirrored));
  const wrist = pts[LM_WRIST]!;
  const indexMcp = pts[LM_INDEX_MCP]!;
  const middleMcp = pts[LM_MIDDLE_MCP]!;
  const pinkyMcp = pts[LM_PINKY_MCP]!;

  const palmForward = middleMcp.clone().sub(wrist);
  if (palmForward.lengthSq() < 1e-8) {
    return { side, boneRotations, confidence: 0 };
  }
  palmForward.normalize();

  const rawAcross = indexMcp.clone().sub(pinkyMcp);
  if (rawAcross.lengthSq() < 1e-8) {
    return { side, boneRotations, confidence: 0 };
  }
  rawAcross.normalize();

  // Palm normal always points out of the palmar surface (flexion direction),
  // invariant under 3D hand rotation and consistent across mirrored/unmirrored modes.
  const palmNormal = side === 'left'
    ? new Vector3().crossVectors(rawAcross, palmForward)
    : new Vector3().crossVectors(palmForward, rawAcross);
  if (palmNormal.lengthSq() < 1e-8) {
    return { side, boneRotations, confidence: 0 };
  }
  palmNormal.normalize();

  // Orthonormal flexion axis: positive rotation around flexAxis swings palmForward -> palmNormal.
  const flexAxis = new Vector3().crossVectors(palmForward, palmNormal).normalize();
  // Direction across the knuckles pointing from pinky toward thumb.
  const palmThumbDir = side === 'left' ? flexAxis.clone() : flexAxis.clone().negate();
  const spreadSign = side === 'left' ? -1 : 1;

  // Solve index, middle, ring, pinky
  for (const { digit, indices } of FINGER_CHAINS) {
    const mcp = pts[indices[0]]!;
    const pip = pts[indices[1]]!;
    const dip = pts[indices[2]]!;
    const tip = pts[indices[3]]!;

    const v1 = pip.clone().sub(mcp);
    const v2 = dip.clone().sub(pip);
    const v3 = tip.clone().sub(dip);
    if (v1.lengthSq() < 1e-8 || v2.lengthSq() < 1e-8 || v3.lengthSq() < 1e-8) continue;
    v1.normalize();
    v2.normalize();
    v3.normalize();

    // Neutral metacarpal direction projected onto the palm plane so relaxed hands stay near 0 spread.
    const metacarpal = mcp.clone().sub(wrist);
    metacarpal.addScaledVector(palmNormal, -metacarpal.dot(palmNormal));
    if (metacarpal.lengthSq() < 1e-8) {
      metacarpal.copy(palmForward);
    } else {
      metacarpal.normalize();
    }

    const f1Fwd = v1.dot(palmForward);
    const f1Norm = v1.dot(palmNormal);
    const rawCurl1 = Math.atan2(f1Norm, f1Fwd) * curlScale;
    const curl1 = clamp(rawCurl1, FINGER_LIMITS.mcpCurlMin, FINGER_LIMITS.mcpCurlMax);

    // Taper abduction/spread as the finger curls deeply into the palm.
    const spreadWeight = Math.max(0, 1 - Math.max(0, curl1) / 1.35);
    const v1Lateral = Math.atan2(v1.dot(palmThumbDir), Math.max(0.25, f1Fwd));
    const neutralLateral = Math.atan2(metacarpal.dot(palmThumbDir), Math.max(0.25, metacarpal.dot(palmForward)));
    const rawSpread = (v1Lateral - neutralLateral) * spreadScale * spreadWeight;
    const spread1 = clamp(rawSpread, -FINGER_LIMITS.mcpSpreadMax, FINGER_LIMITS.mcpSpreadMax) * spreadSign;

    const curl2 = clamp(
      signedAngleAroundAxis(v1, v2, flexAxis) * curlScale,
      FINGER_LIMITS.pipCurlMin,
      FINGER_LIMITS.pipCurlMax,
    );
    const curl3 = clamp(
      signedAngleAroundAxis(v2, v3, flexAxis) * curlScale,
      FINGER_LIMITS.dipCurlMin,
      FINGER_LIMITS.dipCurlMax,
    );

    boneRotations[`hand.${side}.${digit}.1`] = quatTupleFromEuler(curl1, 0, spread1);
    boneRotations[`hand.${side}.${digit}.2`] = quatTupleFromEuler(curl2, 0, 0);
    boneRotations[`hand.${side}.${digit}.3`] = quatTupleFromEuler(curl3, 0, 0);
  }

  // Solve thumb (CMC, MCP, IP)
  const cmc = pts[LM_THUMB_CMC]!;
  const thumbMcp = pts[LM_THUMB_MCP]!;
  const thumbIp = pts[LM_THUMB_IP]!;
  const thumbTip = pts[LM_THUMB_TIP]!;
  const t1 = thumbMcp.clone().sub(cmc);
  const t2 = thumbIp.clone().sub(thumbMcp);
  const t3 = thumbTip.clone().sub(thumbIp);

  if (t1.lengthSq() >= 1e-8 && t2.lengthSq() >= 1e-8 && t3.lengthSq() >= 1e-8) {
    t1.normalize();
    t2.normalize();
    t3.normalize();

    const restThumbDir = palmForward.clone().multiplyScalar(0.72).addScaledVector(palmThumbDir, 0.69).normalize();
    const thumbCurl1 = clamp(
      Math.atan2(t1.dot(palmNormal), Math.max(0.2, t1.dot(restThumbDir))) * curlScale,
      FINGER_LIMITS.thumbCmcCurlMin,
      FINGER_LIMITS.thumbCmcCurlMax,
    );
    const rawThumbSpread = (Math.atan2(t1.dot(palmThumbDir), Math.max(0.2, t1.dot(palmForward))) - 0.76) * spreadScale;
    const thumbSpread1 = clamp(
      rawThumbSpread,
      FINGER_LIMITS.thumbCmcSpreadMin,
      FINGER_LIMITS.thumbCmcSpreadMax,
    ) * spreadSign;

    const inward = palmNormal.clone().multiplyScalar(0.7).addScaledVector(palmThumbDir, -0.7).normalize();
    const t2Perp = t2.clone().addScaledVector(t1, -t2.dot(t1));
    const sign2 = t2Perp.dot(inward) >= 0 ? 1 : -1;
    const thumbCurl2 = clamp(
      sign2 * t1.angleTo(t2) * curlScale,
      FINGER_LIMITS.thumbMcpCurlMin,
      FINGER_LIMITS.thumbMcpCurlMax,
    );

    const t3Perp = t3.clone().addScaledVector(t2, -t3.dot(t2));
    const sign3 = t3Perp.dot(inward) >= 0 ? 1 : -1;
    const thumbCurl3 = clamp(
      sign3 * t2.angleTo(t3) * curlScale,
      FINGER_LIMITS.thumbIpCurlMin,
      FINGER_LIMITS.thumbIpCurlMax,
    );

    boneRotations[`hand.${side}.thumb.1`] = quatTupleFromEuler(thumbCurl1, 0, thumbSpread1);
    boneRotations[`hand.${side}.thumb.2`] = quatTupleFromEuler(thumbCurl2, 0, 0);
    boneRotations[`hand.${side}.thumb.3`] = quatTupleFromEuler(thumbCurl3, 0, 0);
  }

  return {
    side,
    boneRotations,
    confidence: 1,
  };
}

/**
 * Solves 0..2 MediaPipe `HandLandmarker` detections into Mixamo finger-bone local
 * delta quaternions (`hand.<left|right>.<thumb|index|middle|ring|pinky>.<1|2|3>`).
 */
export function solveHandLandmarksToRig(
  hands: readonly MediaPipeHandDetection[],
  options: HandSolveOptions = {},
): MocapSolvedHands {
  const minConfidence = options.minConfidence ?? 0.3;
  const boneRotations: Record<string, [number, number, number, number]> = {};
  const trackedHands: HandSide[] = [];
  const scores: number[] = [];

  for (const hand of hands) {
    const score = hand.score ?? 1;
    if (score < minConfidence) continue;
    const sourceLandmarks = hand.worldLandmarks && hand.worldLandmarks.length >= 21
      ? hand.worldLandmarks
      : hand.landmarks;
    if (!sourceLandmarks || sourceLandmarks.length < 21) continue;

    const solved = solveSingleHandLandmarksToRig(sourceLandmarks, hand.handedness, options);
    if (Object.keys(solved.boneRotations).length === 0) continue;

    Object.assign(boneRotations, solved.boneRotations);
    if (!trackedHands.includes(solved.side)) {
      trackedHands.push(solved.side);
    }
    scores.push(score);
  }

  const confidence = scores.length > 0
    ? scores.reduce((sum, value) => sum + value, 0) / scores.length
    : 0;

  return { boneRotations, trackedHands, confidence };
}

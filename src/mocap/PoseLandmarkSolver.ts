import { Euler, Quaternion, Vector3 } from 'three';
import { ARKIT_CORE_EXPRESSION_CHANNELS } from '../format/constants.js';

export interface NormalizedLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export interface MediaPipeBlendshapeCategory {
  categoryName: string;
  score: number;
}

export interface MocapCalibrationBaseline {
  shoulderSpan: number;
  hipCenter: [number, number, number];
  headPitchBiasRad: number;
}

export interface PoseSolveOptions {
  /** Flip horizontal X / swap left & right landmarks (selfie webcam preview). Default `true`. */
  mirrored?: boolean;
  /** Minimum landmark visibility score required to drive a bone. Default `0.35`. */
  minVisibility?: number;
  /** Include upper-body spine/head/arm solving. Default `true`. */
  applyBody?: boolean;
  /** Include leg/knee solving when hips/ankles are visible. Default `true`. */
  applyLegs?: boolean;
  /**
   * Optional metric 3D MediaPipe Pose `worldLandmarks` (hip-centered in meters,
   * `+X` right in camera space, `+Y` down, `+Z` away from camera).
   * When provided with length `>= 29`, 3D bone direction vectors are computed from
   * `worldLandmarks` while reading landmark visibility from `poseLandmarks`
   * (falling back to `worldLandmarks[i].visibility ?? 1`).
   */
  worldLandmarks?: readonly NormalizedLandmark[];
}

export interface HeadCropOptions {
  /** Minimum landmark visibility score required for head/shoulder anchors. Default `0.35`. */
  minVisibility?: number;
  /** Fractional margin added around the estimated head size (`side = baseSize * (1 + padding)`). Default `0.5`. */
  padding?: number;
  /**
   * Skip cropping (`undefined` returned) when `sh / frameHeight >= maxHeightRatio`,
   * so close-up shots do not unnecessarily crop. Default `0.42`.
   */
  maxHeightRatio?: number;
}

export interface HeadCropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface MocapSolvedPose {
  /** Delta local rotations `[x, y, z, w]` keyed by `MIXAMO_HUMANOID_RIG_V1` semantic bone IDs. */
  boneRotations: Record<string, [number, number, number, number]>;
  /** Average visibility confidence across tracked core landmarks (`0..1`). */
  confidence: number;
}

// MediaPipe Pose 33-point landmark indices
const LM_NOSE = 0;
const LM_LEFT_EAR = 7;
const LM_RIGHT_EAR = 8;
const LM_LEFT_SHOULDER = 11;
const LM_RIGHT_SHOULDER = 12;
const LM_LEFT_ELBOW = 13;
const LM_RIGHT_ELBOW = 14;
const LM_LEFT_WRIST = 15;
const LM_RIGHT_WRIST = 16;
const LM_LEFT_HIP = 23;
const LM_RIGHT_HIP = 24;
const LM_LEFT_KNEE = 25;
const LM_RIGHT_KNEE = 26;
const LM_LEFT_ANKLE = 27;
const LM_RIGHT_ANKLE = 28;

// Neutral avatar rest vectors in +Y up, -Z forward, +X stage-left (character's right is -X)
const REST_DIR: Readonly<Record<string, Vector3>> = {
  'arm.upper.left': new Vector3(1, 0, 0),
  'arm.lower.left': new Vector3(1, 0, 0),
  'arm.upper.right': new Vector3(-1, 0, 0),
  'arm.lower.right': new Vector3(-1, 0, 0),
  'leg.upper.left': new Vector3(0, -1, 0),
  'leg.lower.left': new Vector3(0, -1, 0),
  'leg.upper.right': new Vector3(0, -1, 0),
  'leg.lower.right': new Vector3(0, -1, 0),
};

const VALID_ARKIT_CHANNEL_SET = new Set<string>(ARKIT_CORE_EXPRESSION_CHANNELS);

function normalizeChannelAlias(rawName: string): string | undefined {
  if (VALID_ARKIT_CHANNEL_SET.has(rawName)) return rawName;
  // Convert MediaPipe suffix variants like `eyeBlink_L` -> `eyeBlinkLeft`
  if (rawName.endsWith('_L')) {
    const candidate = `${rawName.slice(0, -2)}Left`;
    if (VALID_ARKIT_CHANNEL_SET.has(candidate)) return candidate;
  }
  if (rawName.endsWith('_R')) {
    const candidate = `${rawName.slice(0, -2)}Right`;
    if (VALID_ARKIT_CHANNEL_SET.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Maps MediaPipe FaceLandmarker `faceBlendshapes` categories into
 * `ARKIT_CORE_EXPRESSION_CHANNELS` weights (`0..1`), applying optional horizontal
 * left/right mirroring for selfie camera input.
 */
export function normalizeMediaPipeFaceBlendshapes(
  categories: readonly MediaPipeBlendshapeCategory[],
  options: { mirrored?: boolean; scale?: number } = {},
): Record<string, number> {
  const mirrored = options.mirrored ?? true;
  const scale = Number.isFinite(options.scale) ? Math.max(0.1, Math.min(2, options.scale ?? 1)) : 1;
  const out: Record<string, number> = {};

  for (const cat of categories) {
    let canonical = normalizeChannelAlias(cat.categoryName);
    if (!canonical) continue;
    if (mirrored) {
      if (canonical.endsWith('Left')) canonical = `${canonical.slice(0, -4)}Right`;
      else if (canonical.endsWith('Right')) canonical = `${canonical.slice(0, -5)}Left`;
    }
    const clamped = Math.max(0, Math.min(1, cat.score * scale));
    if (clamped > 0.005) {
      out[canonical] = clamped;
    }
  }
  return out;
}

function landmarkToWorldVec(lm: NormalizedLandmark, mirrored: boolean): Vector3 {
  // MediaPipe image space: x right [0..1], y down [0..1], z toward camera (negative).
  // Mirroring flips screen x so user's left hand moves avatar's left hand in selfie mode.
  const x = mirrored ? -(lm.x - 0.5) : lm.x - 0.5;
  const y = -(lm.y - 0.5);
  const z = -lm.z;
  return new Vector3(x, y, z);
}

function worldLandmarkToSolverVec(lm: NormalizedLandmark, mirrored: boolean): Vector3 {
  // MediaPipe Pose worldLandmarks are hip-centered metric 3D coordinates in meters:
  // +x right (camera space), +y down, +z away from camera (negative toward camera).
  // Convert to solver space (+X character/stage-left, +Y up, +Z toward camera) matching landmarkToWorldVec.
  const x = mirrored ? -lm.x : lm.x;
  const y = -lm.y;
  const z = -lm.z;
  return new Vector3(x, y, z);
}

function isFiniteLandmark(lm: NormalizedLandmark | undefined): lm is NormalizedLandmark {
  return (
    lm !== undefined &&
    Number.isFinite(lm.x) &&
    Number.isFinite(lm.y) &&
    Number.isFinite(lm.z)
  );
}

/**
 * Estimates a square pixel-space head crop box from MediaPipe Pose landmarks
 * (nose, ears, shoulders) clamped to `[0, frameWidth] x [0, frameHeight]`.
 *
 * Returns `undefined` when required landmarks are missing/low-visibility or when the
 * estimated head crop already occupies at least `maxHeightRatio` of `frameHeight`.
 */
export function computeHeadCropRect(
  poseLandmarks: readonly NormalizedLandmark[],
  frameWidth: number,
  frameHeight: number,
  options: HeadCropOptions = {},
): HeadCropRect | undefined {
  if (
    !Array.isArray(poseLandmarks) ||
    poseLandmarks.length === 0 ||
    !Number.isFinite(frameWidth) ||
    !Number.isFinite(frameHeight) ||
    frameWidth < 1 ||
    frameHeight < 1
  ) {
    return undefined;
  }

  const minVisibility = options.minVisibility ?? 0.35;
  const padding = Number.isFinite(options.padding) ? Math.max(0, Math.min(3, options.padding!)) : 0.5;
  const maxHeightRatio = Number.isFinite(options.maxHeightRatio)
    ? Math.max(0.05, Math.min(1, options.maxHeightRatio!))
    : 0.42;

  const nose = poseLandmarks[LM_NOSE];
  if (
    !nose ||
    !Number.isFinite(nose.x) ||
    !Number.isFinite(nose.y) ||
    (nose.visibility ?? 1) < minVisibility ||
    nose.x < -0.1 ||
    nose.x > 1.1 ||
    nose.y < -0.1 ||
    nose.y > 1.1
  ) {
    return undefined;
  }

  const ok2d = (lm: NormalizedLandmark | undefined): lm is NormalizedLandmark =>
    lm !== undefined &&
    Number.isFinite(lm.x) &&
    Number.isFinite(lm.y) &&
    (lm.visibility ?? 1) >= minVisibility;

  const lEar = poseLandmarks[LM_LEFT_EAR];
  const rEar = poseLandmarks[LM_RIGHT_EAR];
  const lShoulder = poseLandmarks[LM_LEFT_SHOULDER];
  const rShoulder = poseLandmarks[LM_RIGHT_SHOULDER];

  const hasLEar = ok2d(lEar);
  const hasREar = ok2d(rEar);
  const hasLShoulder = ok2d(lShoulder);
  const hasRShoulder = ok2d(rShoulder);

  const noseX = nose.x * frameWidth;
  const noseY = nose.y * frameHeight;

  const sizeEstimates: number[] = [];
  if (hasLEar && hasREar) {
    const earSpanPx = Math.hypot((lEar.x - rEar.x) * frameWidth, (lEar.y - rEar.y) * frameHeight);
    if (earSpanPx > 1) {
      sizeEstimates.push(earSpanPx * 1.55);
    }
  }
  if (hasLShoulder && hasRShoulder) {
    const shoulderSpanPx = Math.hypot(
      (lShoulder.x - rShoulder.x) * frameWidth,
      (lShoulder.y - rShoulder.y) * frameHeight,
    );
    if (shoulderSpanPx > 1) {
      sizeEstimates.push(shoulderSpanPx * 0.65);
    }
    const shMidX = ((lShoulder.x + rShoulder.x) * 0.5) * frameWidth;
    const shMidY = ((lShoulder.y + rShoulder.y) * 0.5) * frameHeight;
    const noseToShoulderPx = Math.hypot(noseX - shMidX, noseY - shMidY);
    if (noseToShoulderPx > 1) {
      sizeEstimates.push(noseToShoulderPx * 1.25);
    }
  }
  if (sizeEstimates.length === 0 && (hasLEar || hasREar)) {
    const ear = (hasLEar ? lEar : rEar)!;
    const noseToEarPx = Math.hypot(noseX - ear.x * frameWidth, noseY - ear.y * frameHeight);
    if (noseToEarPx > 1) {
      sizeEstimates.push(noseToEarPx * 2.4);
    }
  }

  if (sizeEstimates.length === 0) {
    return undefined;
  }

  const baseHeadSize = Math.max(...sizeEstimates);
  if (!Number.isFinite(baseHeadSize) || baseHeadSize <= 1) {
    return undefined;
  }

  const maxDim = Math.floor(Math.min(frameWidth, frameHeight));
  const rawSide = baseHeadSize * (1 + padding);
  const side = Math.min(maxDim, Math.round(rawSide));
  if (side < 1 || side / frameHeight >= maxHeightRatio) {
    return undefined;
  }

  let cx = noseX;
  let cy = noseY;
  if (hasLEar && hasREar) {
    const earMidX = ((lEar.x + rEar.x) * 0.5) * frameWidth;
    const earMidY = ((lEar.y + rEar.y) * 0.5) * frameHeight;
    cx = (noseX + earMidX) * 0.5;
    cy = (noseY + earMidY) * 0.5;
  } else if (hasLEar || hasREar) {
    const ear = (hasLEar ? lEar : rEar)!;
    cx = (noseX + ear.x * frameWidth) * 0.5;
    cy = (noseY + ear.y * frameHeight) * 0.5;
  }

  const maxSx = Math.max(0, Math.floor(frameWidth) - side);
  const maxSy = Math.max(0, Math.floor(frameHeight) - side);
  const sx = Math.max(0, Math.min(maxSx, Math.round(cx - side * 0.5)));
  const sy = Math.max(0, Math.min(maxSy, Math.round(cy - side * 0.5)));

  return { sx, sy, sw: side, sh: side };
}

function clampedDeltaFromDirs(
  restDir: Vector3,
  targetDir: Vector3,
  maxAngleRad = Math.PI * 0.72,
): Quaternion {
  const targetNorm = targetDir.clone().normalize();
  if (targetNorm.lengthSq() < 1e-6) return new Quaternion();
  const q = new Quaternion().setFromUnitVectors(restDir, targetNorm);
  const halfAngle = Math.acos(Math.max(-1, Math.min(1, q.w)));
  const angle = halfAngle * 2;
  if (angle > maxAngleRad && angle > 1e-4) {
    const ratio = maxAngleRad / angle;
    q.slerpQuaternions(new Quaternion(), q, ratio);
  }
  return q;
}

/**
 * Captures a neutral calibration baseline from the user's rest pose landmarks.
 */
export function calibratePoseBaseline(
  poseLandmarks: readonly NormalizedLandmark[],
  mirrored = true,
  worldLandmarks?: readonly NormalizedLandmark[],
): MocapCalibrationBaseline | undefined {
  const useWorld = Array.isArray(worldLandmarks) && worldLandmarks.length >= 29;
  const src = useWorld ? worldLandmarks : poseLandmarks;
  const toVec = useWorld ? worldLandmarkToSolverVec : landmarkToWorldVec;

  const lSh = src[LM_LEFT_SHOULDER];
  const rSh = src[LM_RIGHT_SHOULDER];
  const lHip = src[LM_LEFT_HIP];
  const rHip = src[LM_RIGHT_HIP];
  if (!lSh || !rSh || !lHip || !rHip) return undefined;

  const pLSh = toVec(lSh, mirrored);
  const pRSh = toVec(rSh, mirrored);
  const pHip = toVec(lHip, mirrored)
    .add(toVec(rHip, mirrored))
    .multiplyScalar(0.5);

  const lEar = src[LM_LEFT_EAR];
  const rEar = src[LM_RIGHT_EAR];
  const nose = src[LM_NOSE];
  let headPitchBiasRad = 0;
  if (lEar && rEar && nose) {
    const earMid = toVec(lEar, mirrored)
      .add(toVec(rEar, mirrored))
      .multiplyScalar(0.5);
    const nosePos = toVec(nose, mirrored);
    headPitchBiasRad = Math.atan2(nosePos.y - earMid.y, Math.max(0.04, Math.hypot(nosePos.z - earMid.z, 0.04)));
  }

  return {
    shoulderSpan: Math.max(0.05, pLSh.distanceTo(pRSh)),
    hipCenter: [pHip.x, pHip.y, pHip.z],
    headPitchBiasRad,
  };
}

/**
 * Solves 33 MediaPipe BlazePose landmarks into delta bone quaternions keyed by
 * `MIXAMO_HUMANOID_RIG_V1` semantic bone IDs.
 *
 * When `options.worldLandmarks` is provided (`length >= 29`), 3D bone vectors are computed
 * from metric hip-centered `worldLandmarks` while visibility gating reads `poseLandmarks`
 * first and falls back to `worldLandmarks[i].visibility ?? 1`.
 */
export function solvePoseLandmarksToRig(
  poseLandmarks: readonly NormalizedLandmark[],
  options: PoseSolveOptions = {},
  calibration?: MocapCalibrationBaseline,
): MocapSolvedPose {
  const mirrored = options.mirrored ?? true;
  const minVisibility = options.minVisibility ?? 0.35;
  const applyBody = options.applyBody ?? true;
  const applyLegs = options.applyLegs ?? true;
  const worldLandmarks = options.worldLandmarks;
  const useWorld = Array.isArray(worldLandmarks) && worldLandmarks.length >= 29;

  const boneRotations: Record<string, [number, number, number, number]> = {};
  if (!applyBody && !applyLegs) {
    return { boneRotations, confidence: 0 };
  }

  const hasLandmark = (idx: number): boolean => {
    const geomLm = useWorld ? worldLandmarks[idx] : poseLandmarks[idx];
    if (!isFiniteLandmark(geomLm)) return false;
    const vis = poseLandmarks[idx]?.visibility ?? geomLm.visibility ?? 1;
    return vis >= minVisibility;
  };

  const posAt = (idx: number): Vector3 => {
    if (useWorld) {
      return worldLandmarkToSolverVec(worldLandmarks[idx]!, mirrored);
    }
    return landmarkToWorldVec(poseLandmarks[idx]!, mirrored);
  };

  const trackedScores: number[] = [];
  for (const idx of [LM_NOSE, LM_LEFT_SHOULDER, LM_RIGHT_SHOULDER, LM_LEFT_ELBOW, LM_RIGHT_ELBOW]) {
    const poseLm = poseLandmarks[idx];
    const worldLm = useWorld ? worldLandmarks[idx] : undefined;
    if (poseLm || worldLm) {
      trackedScores.push(poseLm?.visibility ?? worldLm?.visibility ?? 1);
    }
  }
  const confidence =
    trackedScores.length > 0
      ? trackedScores.reduce((sum, v) => sum + v, 0) / trackedScores.length
      : 0;

  if (!hasLandmark(LM_LEFT_SHOULDER) || !hasLandmark(LM_RIGHT_SHOULDER)) {
    return { boneRotations, confidence };
  }

  // Note: When selfie-mirrored, anatomical viewer-left in screen space corresponds to the swapped side.
  const leftShoulderPos = posAt(mirrored ? LM_RIGHT_SHOULDER : LM_LEFT_SHOULDER);
  const rightShoulderPos = posAt(mirrored ? LM_LEFT_SHOULDER : LM_RIGHT_SHOULDER);
  const shoulderMid = leftShoulderPos.clone().add(rightShoulderPos).multiplyScalar(0.5);

  const shoulderVec = leftShoulderPos.clone().sub(rightShoulderPos);
  const spineRoll = Math.max(-0.55, Math.min(0.55, Math.atan2(shoulderVec.y, Math.max(0.05, Math.hypot(shoulderVec.x, shoulderVec.z)))));

  let spinePitch = 0;
  let spineYaw = 0;
  const hasHips = hasLandmark(LM_LEFT_HIP) && hasLandmark(LM_RIGHT_HIP);
  if (hasHips) {
    const hipMid = posAt(LM_LEFT_HIP)
      .add(posAt(LM_RIGHT_HIP))
      .multiplyScalar(0.5);
    const torsoDir = shoulderMid.clone().sub(hipMid).normalize();
    spinePitch = Math.max(-0.5, Math.min(0.5, Math.atan2(torsoDir.z, Math.max(0.1, torsoDir.y))));
    spineYaw = Math.max(-0.65, Math.min(0.65, Math.atan2(-shoulderVec.z, Math.max(0.05, shoulderVec.x))));
  }

  if (applyBody) {
    const qSpine = new Quaternion().setFromEuler(new Euler(spinePitch * 0.45, spineYaw * 0.45, spineRoll * 0.4, 'YXZ'));
    const qChest = new Quaternion().setFromEuler(new Euler(spinePitch * 0.55, spineYaw * 0.55, spineRoll * 0.6, 'YXZ'));
    boneRotations['spine'] = [qSpine.x, qSpine.y, qSpine.z, qSpine.w];
    boneRotations['spine2'] = [qChest.x, qChest.y, qChest.z, qChest.w];

    if (hasLandmark(LM_NOSE) && hasLandmark(LM_LEFT_EAR) && hasLandmark(LM_RIGHT_EAR)) {
      const leftEar = posAt(mirrored ? LM_RIGHT_EAR : LM_LEFT_EAR);
      const rightEar = posAt(mirrored ? LM_LEFT_EAR : LM_RIGHT_EAR);
      const earMid = leftEar.clone().add(rightEar).multiplyScalar(0.5);
      const nosePos = posAt(LM_NOSE);
      const earVec = leftEar.clone().sub(rightEar);

      const headRoll = Math.max(-0.55, Math.min(0.55, Math.atan2(earVec.y, Math.max(0.04, earVec.x))));
      const rawPitch = Math.atan2(nosePos.y - earMid.y, Math.max(0.04, Math.hypot(nosePos.z - earMid.z, 0.04)));
      const headPitch = Math.max(-0.55, Math.min(0.55, (rawPitch - (calibration?.headPitchBiasRad ?? 0)) * 0.9));
      const headYaw = Math.max(-0.7, Math.min(0.7, Math.atan2(nosePos.x - earMid.x, Math.max(0.05, leftEar.distanceTo(rightEar) * 0.5)) - spineYaw * 0.6));

      const qHead = new Quaternion().setFromEuler(new Euler(-headPitch, headYaw, headRoll, 'YXZ'));
      const qNeck = new Quaternion().setFromEuler(new Euler(-headPitch * 0.35, headYaw * 0.35, headRoll * 0.35, 'YXZ'));
      boneRotations['neck'] = [qNeck.x, qNeck.y, qNeck.z, qNeck.w];
      boneRotations['head'] = [qHead.x, qHead.y, qHead.z, qHead.w];
    }

    // Left arm
    const lElbowIdx = mirrored ? LM_RIGHT_ELBOW : LM_LEFT_ELBOW;
    const lWristIdx = mirrored ? LM_RIGHT_WRIST : LM_LEFT_WRIST;
    if (hasLandmark(lElbowIdx)) {
      const lElbow = posAt(lElbowIdx);
      const upperVec = lElbow.clone().sub(leftShoulderPos);
      const qUpper = clampedDeltaFromDirs(REST_DIR['arm.upper.left']!, upperVec, Math.PI * 0.78);
      boneRotations['arm.upper.left'] = [qUpper.x, qUpper.y, qUpper.z, qUpper.w];

      if (hasLandmark(lWristIdx)) {
        const lWrist = posAt(lWristIdx);
        const worldLowerDir = lWrist.clone().sub(lElbow).normalize();
        const invUpper = qUpper.clone().invert();
        const parentSpaceLowerDir = worldLowerDir.applyQuaternion(invUpper);
        const qLower = clampedDeltaFromDirs(REST_DIR['arm.lower.left']!, parentSpaceLowerDir, Math.PI * 0.75);
        boneRotations['arm.lower.left'] = [qLower.x, qLower.y, qLower.z, qLower.w];
      }
    }

    // Right arm
    const rElbowIdx = mirrored ? LM_LEFT_ELBOW : LM_RIGHT_ELBOW;
    const rWristIdx = mirrored ? LM_LEFT_WRIST : LM_RIGHT_WRIST;
    if (hasLandmark(rElbowIdx)) {
      const rElbow = posAt(rElbowIdx);
      const upperVec = rElbow.clone().sub(rightShoulderPos);
      const qUpper = clampedDeltaFromDirs(REST_DIR['arm.upper.right']!, upperVec, Math.PI * 0.78);
      boneRotations['arm.upper.right'] = [qUpper.x, qUpper.y, qUpper.z, qUpper.w];

      if (hasLandmark(rWristIdx)) {
        const rWrist = posAt(rWristIdx);
        const worldLowerDir = rWrist.clone().sub(rElbow).normalize();
        const invUpper = qUpper.clone().invert();
        const parentSpaceLowerDir = worldLowerDir.applyQuaternion(invUpper);
        const qLower = clampedDeltaFromDirs(REST_DIR['arm.lower.right']!, parentSpaceLowerDir, Math.PI * 0.75);
        boneRotations['arm.lower.right'] = [qLower.x, qLower.y, qLower.z, qLower.w];
      }
    }
  }

  if (applyLegs && hasHips) {
    const leftHipPos = posAt(mirrored ? LM_RIGHT_HIP : LM_LEFT_HIP);
    const rightHipPos = posAt(mirrored ? LM_LEFT_HIP : LM_RIGHT_HIP);

    const lKneeIdx = mirrored ? LM_RIGHT_KNEE : LM_LEFT_KNEE;
    const lAnkleIdx = mirrored ? LM_RIGHT_ANKLE : LM_LEFT_ANKLE;
    if (hasLandmark(lKneeIdx)) {
      const lKnee = posAt(lKneeIdx);
      const qUpperLeg = clampedDeltaFromDirs(REST_DIR['leg.upper.left']!, lKnee.clone().sub(leftHipPos), Math.PI * 0.65);
      boneRotations['leg.upper.left'] = [qUpperLeg.x, qUpperLeg.y, qUpperLeg.z, qUpperLeg.w];
      if (hasLandmark(lAnkleIdx)) {
        const lAnkle = posAt(lAnkleIdx);
        const worldShin = lAnkle.clone().sub(lKnee).normalize().applyQuaternion(qUpperLeg.clone().invert());
        const qLowerLeg = clampedDeltaFromDirs(REST_DIR['leg.lower.left']!, worldShin, Math.PI * 0.65);
        boneRotations['leg.lower.left'] = [qLowerLeg.x, qLowerLeg.y, qLowerLeg.z, qLowerLeg.w];
      }
    }

    const rKneeIdx = mirrored ? LM_LEFT_KNEE : LM_RIGHT_KNEE;
    const rAnkleIdx = mirrored ? LM_LEFT_ANKLE : LM_RIGHT_ANKLE;
    if (hasLandmark(rKneeIdx)) {
      const rKnee = posAt(rKneeIdx);
      const qUpperLeg = clampedDeltaFromDirs(REST_DIR['leg.upper.right']!, rKnee.clone().sub(rightHipPos), Math.PI * 0.65);
      boneRotations['leg.upper.right'] = [qUpperLeg.x, qUpperLeg.y, qUpperLeg.z, qUpperLeg.w];
      if (hasLandmark(rAnkleIdx)) {
        const rAnkle = posAt(rAnkleIdx);
        const worldShin = rAnkle.clone().sub(rKnee).normalize().applyQuaternion(qUpperLeg.clone().invert());
        const qLowerLeg = clampedDeltaFromDirs(REST_DIR['leg.lower.right']!, worldShin, Math.PI * 0.65);
        boneRotations['leg.lower.right'] = [qLowerLeg.x, qLowerLeg.y, qLowerLeg.z, qLowerLeg.w];
      }
    }
  }

  return { boneRotations, confidence };
}

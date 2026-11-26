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

function visOk(lm: NormalizedLandmark | undefined, minVisibility: number): lm is NormalizedLandmark {
  if (!lm) return false;
  return (lm.visibility ?? 1) >= minVisibility;
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
): MocapCalibrationBaseline | undefined {
  const lSh = poseLandmarks[LM_LEFT_SHOULDER];
  const rSh = poseLandmarks[LM_RIGHT_SHOULDER];
  const lHip = poseLandmarks[LM_LEFT_HIP];
  const rHip = poseLandmarks[LM_RIGHT_HIP];
  if (!lSh || !rSh || !lHip || !rHip) return undefined;

  const pLSh = landmarkToWorldVec(lSh, mirrored);
  const pRSh = landmarkToWorldVec(rSh, mirrored);
  const pHip = landmarkToWorldVec(lHip, mirrored)
    .add(landmarkToWorldVec(rHip, mirrored))
    .multiplyScalar(0.5);

  const lEar = poseLandmarks[LM_LEFT_EAR];
  const rEar = poseLandmarks[LM_RIGHT_EAR];
  const nose = poseLandmarks[LM_NOSE];
  let headPitchBiasRad = 0;
  if (lEar && rEar && nose) {
    const earMid = landmarkToWorldVec(lEar, mirrored)
      .add(landmarkToWorldVec(rEar, mirrored))
      .multiplyScalar(0.5);
    const nosePos = landmarkToWorldVec(nose, mirrored);
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

  const boneRotations: Record<string, [number, number, number, number]> = {};
  if (!applyBody && !applyLegs) {
    return { boneRotations, confidence: 0 };
  }

  const lShoulderLm = poseLandmarks[LM_LEFT_SHOULDER];
  const rShoulderLm = poseLandmarks[LM_RIGHT_SHOULDER];
  const lHipLm = poseLandmarks[LM_LEFT_HIP];
  const rHipLm = poseLandmarks[LM_RIGHT_HIP];

  const trackedScores: number[] = [];
  for (const idx of [LM_NOSE, LM_LEFT_SHOULDER, LM_RIGHT_SHOULDER, LM_LEFT_ELBOW, LM_RIGHT_ELBOW]) {
    const lm = poseLandmarks[idx];
    if (lm) trackedScores.push(lm.visibility ?? 1);
  }
  const confidence =
    trackedScores.length > 0
      ? trackedScores.reduce((sum, v) => sum + v, 0) / trackedScores.length
      : 0;

  if (!visOk(lShoulderLm, minVisibility) || !visOk(rShoulderLm, minVisibility)) {
    return { boneRotations, confidence };
  }

  // Note: When selfie-mirrored, anatomical viewer-left in screen space corresponds to the swapped side.
  const leftShoulderPos = landmarkToWorldVec(mirrored ? rShoulderLm : lShoulderLm, mirrored);
  const rightShoulderPos = landmarkToWorldVec(mirrored ? lShoulderLm : rShoulderLm, mirrored);
  const shoulderMid = leftShoulderPos.clone().add(rightShoulderPos).multiplyScalar(0.5);

  const shoulderVec = leftShoulderPos.clone().sub(rightShoulderPos);
  const spineRoll = Math.max(-0.55, Math.min(0.55, Math.atan2(shoulderVec.y, Math.max(0.05, Math.hypot(shoulderVec.x, shoulderVec.z)))));

  let spinePitch = 0;
  let spineYaw = 0;
  if (visOk(lHipLm, minVisibility) && visOk(rHipLm, minVisibility)) {
    const hipMid = landmarkToWorldVec(lHipLm, mirrored)
      .add(landmarkToWorldVec(rHipLm, mirrored))
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

    const noseLm = poseLandmarks[LM_NOSE];
    const lEarLm = poseLandmarks[LM_LEFT_EAR];
    const rEarLm = poseLandmarks[LM_RIGHT_EAR];
    if (visOk(noseLm, minVisibility) && visOk(lEarLm, minVisibility) && visOk(rEarLm, minVisibility)) {
      const leftEar = landmarkToWorldVec(mirrored ? rEarLm : lEarLm, mirrored);
      const rightEar = landmarkToWorldVec(mirrored ? lEarLm : rEarLm, mirrored);
      const earMid = leftEar.clone().add(rightEar).multiplyScalar(0.5);
      const nosePos = landmarkToWorldVec(noseLm, mirrored);
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
    const lElbowLm = poseLandmarks[mirrored ? LM_RIGHT_ELBOW : LM_LEFT_ELBOW];
    const lWristLm = poseLandmarks[mirrored ? LM_RIGHT_WRIST : LM_LEFT_WRIST];
    if (visOk(lElbowLm, minVisibility)) {
      const lElbow = landmarkToWorldVec(lElbowLm, mirrored);
      const upperVec = lElbow.clone().sub(leftShoulderPos);
      const qUpper = clampedDeltaFromDirs(REST_DIR['arm.upper.left']!, upperVec, Math.PI * 0.78);
      boneRotations['arm.upper.left'] = [qUpper.x, qUpper.y, qUpper.z, qUpper.w];

      if (visOk(lWristLm, minVisibility)) {
        const lWrist = landmarkToWorldVec(lWristLm, mirrored);
        const worldLowerDir = lWrist.clone().sub(lElbow).normalize();
        const invUpper = qUpper.clone().invert();
        const parentSpaceLowerDir = worldLowerDir.applyQuaternion(invUpper);
        const qLower = clampedDeltaFromDirs(REST_DIR['arm.lower.left']!, parentSpaceLowerDir, Math.PI * 0.75);
        boneRotations['arm.lower.left'] = [qLower.x, qLower.y, qLower.z, qLower.w];
      }
    }

    // Right arm
    const rElbowLm = poseLandmarks[mirrored ? LM_LEFT_ELBOW : LM_RIGHT_ELBOW];
    const rWristLm = poseLandmarks[mirrored ? LM_LEFT_WRIST : LM_RIGHT_WRIST];
    if (visOk(rElbowLm, minVisibility)) {
      const rElbow = landmarkToWorldVec(rElbowLm, mirrored);
      const upperVec = rElbow.clone().sub(rightShoulderPos);
      const qUpper = clampedDeltaFromDirs(REST_DIR['arm.upper.right']!, upperVec, Math.PI * 0.78);
      boneRotations['arm.upper.right'] = [qUpper.x, qUpper.y, qUpper.z, qUpper.w];

      if (visOk(rWristLm, minVisibility)) {
        const rWrist = landmarkToWorldVec(rWristLm, mirrored);
        const worldLowerDir = rWrist.clone().sub(rElbow).normalize();
        const invUpper = qUpper.clone().invert();
        const parentSpaceLowerDir = worldLowerDir.applyQuaternion(invUpper);
        const qLower = clampedDeltaFromDirs(REST_DIR['arm.lower.right']!, parentSpaceLowerDir, Math.PI * 0.75);
        boneRotations['arm.lower.right'] = [qLower.x, qLower.y, qLower.z, qLower.w];
      }
    }
  }

  if (applyLegs && visOk(lHipLm, minVisibility) && visOk(rHipLm, minVisibility)) {
    const leftHipPos = landmarkToWorldVec(mirrored ? rHipLm : lHipLm, mirrored);
    const rightHipPos = landmarkToWorldVec(mirrored ? lHipLm : rHipLm, mirrored);

    const lKneeLm = poseLandmarks[mirrored ? LM_RIGHT_KNEE : LM_LEFT_KNEE];
    const lAnkleLm = poseLandmarks[mirrored ? LM_RIGHT_ANKLE : LM_LEFT_ANKLE];
    if (visOk(lKneeLm, minVisibility)) {
      const lKnee = landmarkToWorldVec(lKneeLm, mirrored);
      const qUpperLeg = clampedDeltaFromDirs(REST_DIR['leg.upper.left']!, lKnee.clone().sub(leftHipPos), Math.PI * 0.65);
      boneRotations['leg.upper.left'] = [qUpperLeg.x, qUpperLeg.y, qUpperLeg.z, qUpperLeg.w];
      if (visOk(lAnkleLm, minVisibility)) {
        const lAnkle = landmarkToWorldVec(lAnkleLm, mirrored);
        const worldShin = lAnkle.clone().sub(lKnee).normalize().applyQuaternion(qUpperLeg.clone().invert());
        const qLowerLeg = clampedDeltaFromDirs(REST_DIR['leg.lower.left']!, worldShin, Math.PI * 0.65);
        boneRotations['leg.lower.left'] = [qLowerLeg.x, qLowerLeg.y, qLowerLeg.z, qLowerLeg.w];
      }
    }

    const rKneeLm = poseLandmarks[mirrored ? LM_LEFT_KNEE : LM_RIGHT_KNEE];
    const rAnkleLm = poseLandmarks[mirrored ? LM_LEFT_ANKLE : LM_RIGHT_ANKLE];
    if (visOk(rKneeLm, minVisibility)) {
      const rKnee = landmarkToWorldVec(rKneeLm, mirrored);
      const qUpperLeg = clampedDeltaFromDirs(REST_DIR['leg.upper.right']!, rKnee.clone().sub(rightHipPos), Math.PI * 0.65);
      boneRotations['leg.upper.right'] = [qUpperLeg.x, qUpperLeg.y, qUpperLeg.z, qUpperLeg.w];
      if (visOk(rAnkleLm, minVisibility)) {
        const rAnkle = landmarkToWorldVec(rAnkleLm, mirrored);
        const worldShin = rAnkle.clone().sub(rKnee).normalize().applyQuaternion(qUpperLeg.clone().invert());
        const qLowerLeg = clampedDeltaFromDirs(REST_DIR['leg.lower.right']!, worldShin, Math.PI * 0.65);
        boneRotations['leg.lower.right'] = [qLowerLeg.x, qLowerLeg.y, qLowerLeg.z, qLowerLeg.w];
      }
    }
  }

  return { boneRotations, confidence };
}

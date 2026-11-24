import { Mesh, Vector3 } from 'three';
import { ARKIT_CORE_EXPRESSION_CHANNELS } from '../format/constants.js';
import { computeNeckLockMask } from '../head-archetypes/HeadArchetypeController.js';
import { upsertRelativeMorphTarget } from '../layering/SpatialMeshIndex.js';

export interface ProceduralExpressionLandmarks {
  eyeLeft: readonly [number, number, number];
  eyeRight?: readonly [number, number, number];
  eyeRadius: number;
  eyeRadii?: readonly [number, number, number];
  eyeShearZ?: number;
  eyeShearY?: number;
  eyeBackDepthScale?: number;
  browInner: readonly [number, number, number];
  browOuter: readonly [number, number, number];
  noseWing: readonly [number, number, number];
  cheek: readonly [number, number, number];
  mouthCenter: readonly [number, number, number];
  mouthCorner: readonly [number, number, number];
  chin: readonly [number, number, number];
  neckSeamY?: number;
  blendHeight?: number;
}

export interface InstallProceduralExpressionTargetsOptions {
  overwrite?: boolean;
  channels?: readonly string[];
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge0 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function gauss3(
  px: number,
  py: number,
  pz: number,
  cx: number,
  cy: number,
  cz: number,
  sigma: number,
): number {
  const dx = px - cx;
  const dy = py - cy;
  const dz = pz - cz;
  return Math.exp(-(dx * dx + dy * dy + dz * dz) / Math.max(sigma * sigma, 1e-8));
}

function mirrorX(pt: readonly [number, number, number]): readonly [number, number, number] {
  return [-pt[0], pt[1], pt[2]];
}

function evaluateExpressionChannel(
  channel: string,
  x: number,
  y: number,
  z: number,
  lm: Required<Pick<ProceduralExpressionLandmarks, 'eyeLeft' | 'eyeRight' | 'eyeRadius' | 'browInner' | 'browOuter' | 'noseWing' | 'cheek' | 'mouthCenter' | 'mouthCorner' | 'chin'>> & Pick<ProceduralExpressionLandmarks, 'eyeRadii' | 'eyeShearZ' | 'eyeShearY' | 'eyeBackDepthScale'>,
  out: Vector3,
): void {
  out.set(0, 0, 0);
  const r0 = Math.max(0.01, lm.eyeRadius);
  const browInnerR = mirrorX(lm.browInner);
  const browOuterR = mirrorX(lm.browOuter);
  const noseWingR = mirrorX(lm.noseWing);
  const cheekR = mirrorX(lm.cheek);
  const mouthCornerR = mirrorX(lm.mouthCorner);

  const mouthHalfW = Math.max(0.012, Math.abs(lm.mouthCorner[0] - lm.mouthCenter[0]));
  const dyLip = y - lm.mouthCenter[1];

  switch (channel) {
    case 'browInnerUp': {
      const gL = gauss3(x, y, z, ...lm.browInner, 0.019);
      const gR = gauss3(x, y, z, ...browInnerR, 0.019);
      const g = Math.min(1, gL + gR);
      out.x = -0.0018 * (gL - gR);
      out.y = 0.0080 * g;
      out.z = 0.0012 * g;
      return;
    }
    case 'browDownLeft':
    case 'browDownRight': {
      const side = channel.endsWith('Left') ? 1 : -1;
      const inner = side > 0 ? lm.browInner : browInnerR;
      const outer = side > 0 ? lm.browOuter : browOuterR;
      const gInner = gauss3(x, y, z, ...inner, 0.020);
      const gOuter = gauss3(x, y, z, ...outer, 0.021);
      out.x = -side * 0.0038 * gInner;
      out.y = -0.0095 * gInner - 0.0024 * gOuter * (1 - 0.6 * gInner);
      out.z = 0.0020 * Math.max(gInner, gOuter);
      return;
    }
    case 'browOuterUpLeft':
    case 'browOuterUpRight': {
      const outer = channel.endsWith('Left') ? lm.browOuter : browOuterR;
      const g = gauss3(x, y, z, ...outer, 0.022);
      out.y = 0.0085 * g;
      out.z = 0.0010 * g;
      return;
    }
    case 'eyeWideLeft':
    case 'eyeWideRight':
    case 'eyeSquintLeft':
    case 'eyeSquintRight':
    case 'eyeBlinkLeft':
    case 'eyeBlinkRight': {
      const side = channel.endsWith('Left') ? 1 : -1;
      const eyePt = side > 0 ? lm.eyeLeft : lm.eyeRight;
      const rx = Math.max(0.008, lm.eyeRadii?.[0] ?? r0);
      const ry = Math.max(0.008, lm.eyeRadii?.[1] ?? r0);
      const rz = Math.max(0.008, lm.eyeRadii?.[2] ?? r0);
      const shearZ = lm.eyeShearZ ?? 0;
      const shearY = lm.eyeShearY ?? 0;
      const backScale = Math.max(1, lm.eyeBackDepthScale ?? 1);
      const nx = (side * (x - eyePt[0])) / rx;
      const ny = (y - eyePt[1]) / ry;
      const qzEff = (z - eyePt[2]) - nx * shearZ - ny * shearY;
      const rzEff = qzEff >= 0 ? rz : rz * backScale;
      const nz = qzEff / rzEff;
      const r = Math.hypot(nx, ny, nz);
      const front = smoothstep(-0.35, 0.15, nz);
      const midlineGuard = smoothstep(0.004, 0.012, Math.abs(x)) * smoothstep(-0.002, 0.008, side * x);
      const ring = smoothstep(0.75, 0.95, r) * (1 - smoothstep(1.45, 2.00, r)) * front * midlineGuard;
      if (ring <= 1e-4) return;
      const upper = smoothstep(-0.08, 0.28, ny) * (1 - smoothstep(1.05, 1.45, ny));
      const lower = (1 - smoothstep(-0.28, 0.08, ny)) * smoothstep(-1.45, -1.05, ny);
      let angle = 0;
      if (channel.startsWith('eyeWide')) {
        angle = ring * (0.30 * upper - 0.12 * lower);
      } else if (channel.startsWith('eyeSquint')) {
        angle = ring * (0.42 * lower - 0.24 * upper);
      } else {
        const upperBlink = smoothstep(-0.15, 0.25, ny) * (1 - smoothstep(1.10, 1.50, ny));
        angle = ring * (-0.68 * upperBlink + 0.14 * lower);
      }
      const dny = nz * angle;
      const dnz = -ny * angle;
      out.y = dny * ry;
      out.z = dny * shearY + dnz * rz;
      return;
    }
    case 'cheekSquintLeft':
    case 'cheekSquintRight': {
      const c = channel.endsWith('Left') ? lm.cheek : cheekR;
      const g = gauss3(x, y, z, ...c, 0.026);
      out.y = 0.0055 * g;
      out.z = 0.004 * g;
      return;
    }
    case 'cheekPuff': {
      const gL = gauss3(x, y, z, lm.cheek[0], lm.cheek[1] - 0.008, lm.cheek[2], 0.026);
      const gR = gauss3(x, y, z, cheekR[0], cheekR[1] - 0.008, cheekR[2], 0.026);
      out.x = 0.0075 * (gL - gR);
      out.z = 0.0055 * Math.max(gL, gR);
      return;
    }
    case 'noseSneerLeft':
    case 'noseSneerRight': {
      const wing = channel.endsWith('Left') ? lm.noseWing : noseWingR;
      const g = gauss3(x, y, z, ...wing, 0.015);
      out.y = 0.0042 * g;
      out.z = 0.0018 * g;
      return;
    }
    case 'mouthSmileLeft':
    case 'mouthSmileRight': {
      const side = channel.endsWith('Left') ? 1 : -1;
      const corner = side > 0 ? lm.mouthCorner : mouthCornerR;
      const g = gauss3(x, y, z, ...corner, 0.021);
      out.x = side * 0.0052 * g;
      out.y = 0.0072 * g;
      out.z = -0.0032 * g;
      return;
    }
    case 'mouthFrownLeft':
    case 'mouthFrownRight': {
      const side = channel.endsWith('Left') ? 1 : -1;
      const corner = side > 0 ? lm.mouthCorner : mouthCornerR;
      const g = gauss3(x, y, z, ...corner, 0.021);
      out.x = -side * 0.0018 * g;
      out.y = -0.0068 * g;
      out.z = -0.0014 * g;
      return;
    }
    case 'mouthPressLeft':
    case 'mouthPressRight': {
      const side = channel.endsWith('Left') ? 1 : -1;
      const corner = side > 0 ? lm.mouthCorner : mouthCornerR;
      const g = Math.max(
        gauss3(x, y, z, ...corner, 0.018),
        gauss3(x, y, z, ...lm.mouthCenter, 0.017) * (x * side >= 0 ? 1 : 0.35),
      );
      const band = Math.exp(-(dyLip * dyLip) / (0.009 * 0.009));
      out.x = side * 0.0010 * g;
      out.y = -dyLip * 0.42 * band * g;
      out.z = -0.0024 * g;
      return;
    }
    case 'mouthDimpleLeft':
    case 'mouthDimpleRight': {
      const side = channel.endsWith('Left') ? 1 : -1;
      const corner = side > 0 ? lm.mouthCorner : mouthCornerR;
      const g = gauss3(x, y, z, corner[0] + side * 0.008, corner[1], corner[2] - 0.004, 0.016);
      out.x = side * 0.0025 * g;
      out.z = -0.0038 * g;
      return;
    }
    case 'mouthPucker': {
      const g = gauss3(x, y, z, ...lm.mouthCenter, 0.022);
      out.x = -(x - lm.mouthCenter[0]) * 0.36 * g;
      out.z = 0.0065 * g;
      return;
    }
    case 'mouthFunnel': {
      const g = gauss3(x, y, z, ...lm.mouthCenter, 0.024);
      const rim = smoothstep(0.0015, 0.0075, Math.abs(dyLip));
      out.x = -(x - lm.mouthCenter[0]) * 0.30 * g;
      out.y = Math.tanh(dyLip / 0.0045) * 0.0034 * g;
      out.z = (0.0018 + 0.0042 * rim) * g;
      return;
    }
    case 'mouthShrugLower': {
      const g = gauss3(x, y, z, lm.mouthCenter[0], lm.mouthCenter[1] - 0.009, lm.mouthCenter[2], 0.020);
      out.y = 0.0048 * g;
      out.z = 0.0026 * g;
      return;
    }
    case 'mouthUpperUpLeft':
    case 'mouthUpperUpRight': {
      const side = channel.endsWith('Left') ? 1 : -1;
      const g = gauss3(x, y, z, lm.mouthCenter[0] + side * 0.008, lm.mouthCenter[1] + 0.0055, lm.mouthCenter[2], 0.015);
      out.y = 0.0048 * g;
      out.z = 0.0014 * g;
      return;
    }
    case 'jawOpen': {
      // Hinge rotation around TMJ pivot behind chin/ears, plus slight upper-lip lift and concave
      // inner-mouth recess so sealed lips curve inward instead of protruding forward.
      const pivotY = lm.eyeLeft[1] - 0.02;
      const pivotZ = lm.eyeLeft[2] - 0.055;
      const jawWeight =
        (1 - smoothstep(lm.mouthCenter[1] - 0.002, lm.mouthCenter[1] + 0.008, y))
        * smoothstep(lm.chin[1] - 0.045, lm.chin[1] - 0.006, y);
      if (jawWeight > 1e-4) {
        const dy = y - pivotY;
        const dz = z - pivotZ;
        const angle = 0.21 * jawWeight;
        out.y += -dz * angle;
        out.z += dy * angle;
      }
      const upperLift =
        smoothstep(lm.mouthCenter[1] + 0.001, lm.mouthCenter[1] + 0.006, y)
        * (1 - smoothstep(lm.mouthCenter[1] + 0.008, lm.mouthCenter[1] + 0.016, y))
        * Math.exp(-((x - lm.mouthCenter[0]) ** 2) / ((mouthHalfW * 0.9) ** 2));
      out.y += 0.0018 * upperLift;

      const nx = (x - lm.mouthCenter[0]) / (mouthHalfW * 0.86);
      const ny = (y - (lm.mouthCenter[1] - 0.0015)) / 0.0055;
      const cavity = Math.max(0, 1 - (nx * nx + ny * ny));
      const frontMouth = smoothstep(lm.mouthCenter[2] - 0.018, lm.mouthCenter[2] - 0.004, z);
      out.z -= 0.0052 * cavity * cavity * frontMouth;
      return;
    }
  }
}

/**
 * Generates landmark-driven ARKit-compatible facial expression morph targets on `mesh` while
 * preserving any existing Blender-authored targets and locking vertices below `neckSeamY` to 0.
 */
export function installProceduralExpressionTargets(
  mesh: Mesh,
  landmarks: ProceduralExpressionLandmarks,
  options: InstallProceduralExpressionTargetsOptions = {},
): string[] {
  const position = mesh.geometry.getAttribute('position');
  if (!position || position.count === 0) return [];

  const lm = {
    eyeLeft: landmarks.eyeLeft,
    eyeRight: landmarks.eyeRight ?? mirrorX(landmarks.eyeLeft),
    eyeRadius: landmarks.eyeRadius,
    eyeRadii: landmarks.eyeRadii,
    eyeShearZ: landmarks.eyeShearZ,
    eyeShearY: landmarks.eyeShearY,
    eyeBackDepthScale: landmarks.eyeBackDepthScale,
    browInner: landmarks.browInner,
    browOuter: landmarks.browOuter,
    noseWing: landmarks.noseWing,
    cheek: landmarks.cheek,
    mouthCenter: landmarks.mouthCenter,
    mouthCorner: landmarks.mouthCorner,
    chin: landmarks.chin,
  };

  const neckSeamY = landmarks.neckSeamY ?? 0.785;
  const blendHeight = landmarks.blendHeight ?? 0.025;
  const neckMask = computeNeckLockMask(mesh.geometry, neckSeamY, blendHeight);
  const channels = options.channels ?? ARKIT_CORE_EXPRESSION_CHANNELS;
  const overwrite = options.overwrite ?? false;

  const installed: string[] = [];
  const tmp = new Vector3();

  for (const channel of channels) {
    if (!overwrite && mesh.morphTargetDictionary?.[channel] !== undefined) continue;

    const delta = new Float32Array(position.count * 3);
    let moved = false;
    for (let i = 0; i < position.count; i++) {
      const lock = neckMask[i] ?? 1;
      if (lock === 0) continue;
      evaluateExpressionChannel(
        channel,
        position.getX(i),
        position.getY(i),
        position.getZ(i),
        lm,
        tmp,
      );
      if (tmp.lengthSq() < 1e-14) continue;
      delta[i * 3] = tmp.x * lock;
      delta[i * 3 + 1] = tmp.y * lock;
      delta[i * 3 + 2] = tmp.z * lock;
      moved = true;
    }

    if (!moved) continue;
    upsertRelativeMorphTarget(mesh, channel, delta, 0);
    installed.push(channel);
  }

  return installed;
}

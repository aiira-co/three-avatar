import { BufferGeometry, SkinnedMesh } from 'three';
import {
  HEAD_ARCHETYPES_METADATA_KEY,
  HEAD_ARCHETYPE_REGIONS,
} from '../format/constants.js';
import type {
  AvatarHeadArchetypeState,
  HeadArchetypeDefinition,
  HeadArchetypePack,
  HeadArchetypeRegionId,
  HeadLandmarkSet,
  SparseMorphTargetDefinition,
} from '../format/types.js';
import { setMorphTargetInfluence, upsertRelativeMorphTarget } from '../layering/SpatialMeshIndex.js';
import type { AvatarInstance } from '../runtime/AvatarInstance.js';

export const HEAD_ARCHETYPE_TARGET_PREFIX = 'HeadArchetype_';
export const HEAD_ARCHETYPE_BLENDED_TARGET = 'HeadArchetype_Blended';
export const DEFAULT_SKIN_DETAIL_STRENGTH = 0.55;

export const BUILTIN_HEAD_ARCHETYPE_CATALOG = [
  { id: 'black', label: 'Black / African' },
  { id: 'east_asian', label: 'East Asian' },
  { id: 'chinese', label: 'Chinese' },
  { id: 'manga', label: 'Manga / Anime 3D' },
  { id: 'south_asian', label: 'South Asian' },
  { id: 'angular', label: 'Angular / Sculpted' },
] as const;

const VALID_REGION_SET = new Set<string>(HEAD_ARCHETYPE_REGIONS);

const LANDMARK_REGION_MAP: Readonly<Record<string, HeadArchetypeRegionId>> = {
  crown: 'cranium',
  forehead: 'cranium',
  browInner: 'brows_eyes',
  browOuter: 'brows_eyes',
  browRidge: 'brows_eyes',
  eyeLeft: 'brows_eyes',
  eyeRight: 'brows_eyes',
  upperLid: 'brows_eyes',
  lowerLid: 'brows_eyes',
  noseBridge: 'nose',
  noseTip: 'nose',
  noseWing: 'nose',
  cheekbone: 'cheeks',
  cheek: 'cheeks',
  mouthCenter: 'mouth',
  mouthCorner: 'mouth',
  chin: 'jaw_chin',
  jawAngle: 'jaw_chin',
  earLeft: 'ears',
  earRight: 'ears',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeWeightMap(raw: unknown): Record<string, number> {
  if (!isRecord(raw)) return {};
  const out: Record<string, number> = {};
  for (const [id, val] of Object.entries(raw)) {
    if (!id || typeof val !== 'number' || !Number.isFinite(val)) continue;
    const clamped = Math.max(0, Math.min(1, val));
    if (clamped > 1e-4) out[id] = clamped;
  }
  return out;
}

export function normalizeHeadArchetypeState(raw: unknown): AvatarHeadArchetypeState {
  if (!isRecord(raw)) return { weights: {} };
  const weights = sanitizeWeightMap(raw['weights']);
  const result: AvatarHeadArchetypeState = { weights };

  if (isRecord(raw['regions'])) {
    const regions: Partial<Record<HeadArchetypeRegionId, Record<string, number>>> = {};
    for (const [regionKey, value] of Object.entries(raw['regions'])) {
      if (!VALID_REGION_SET.has(regionKey)) continue;
      const cleaned = sanitizeWeightMap(value);
      if (Object.keys(cleaned).length > 0) {
        regions[regionKey as HeadArchetypeRegionId] = cleaned;
      }
    }
    if (Object.keys(regions).length > 0) result.regions = regions;
  }

  const rawDetail = raw['detailStrength'];
  if (typeof rawDetail === 'number' && Number.isFinite(rawDetail)) {
    const clampedDetail = Math.round(Math.max(0, Math.min(1, rawDetail)) * 100) / 100;
    if (Math.abs(clampedDetail - DEFAULT_SKIN_DETAIL_STRENGTH) > 1e-4) {
      result.detailStrength = clampedDetail;
    }
  }
  return result;
}

export function readHeadArchetypeState(avatar: AvatarInstance): AvatarHeadArchetypeState {
  return normalizeHeadArchetypeState(avatar.serialize().metadata?.[HEAD_ARCHETYPES_METADATA_KEY]);
}

export function writeHeadArchetypeState(
  avatar: AvatarInstance,
  state: AvatarHeadArchetypeState,
): AvatarHeadArchetypeState {
  const normalized = normalizeHeadArchetypeState(state);
  const current = avatar.serialize().metadata ?? {};
  const next: Record<string, unknown> = { ...current };
  const isEmpty =
    Object.keys(normalized.weights).length === 0
    && (!normalized.regions || Object.keys(normalized.regions).length === 0)
    && normalized.detailStrength === undefined;

  if (isEmpty) {
    delete next[HEAD_ARCHETYPES_METADATA_KEY];
  } else {
    next[HEAD_ARCHETYPES_METADATA_KEY] = normalized;
  }
  avatar.setMetadata(Object.keys(next).length > 0 ? next : undefined);
  return normalized;
}

/**
 * Computes a per-vertex mask that is strictly `0` at or below `neckSeamY` and smoothly transitions
 * to `1` over `blendHeight`, preventing any neck-seam detachment when blending head shapes.
 */
export function computeNeckLockMask(
  geometry: BufferGeometry,
  neckSeamY = 0.785,
  blendHeight = 0.025,
): Float32Array {
  const position = geometry.getAttribute('position');
  if (!position) return new Float32Array(0);
  const mask = new Float32Array(position.count);
  const invSpan = blendHeight > 1e-6 ? 1 / blendHeight : 0;

  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    if (y <= neckSeamY + 1e-5) {
      mask[i] = 0;
    } else if (invSpan === 0 || y >= neckSeamY + blendHeight) {
      mask[i] = 1;
    } else {
      const t = (y - neckSeamY) * invSpan;
      mask[i] = t * t * (3 - 2 * t);
    }
  }
  return mask;
}

export interface ApplyHeadArchetypesOptions {
  neckSeamY?: number;
  blendHeight?: number;
  neckMask?: Float32Array;
  blendedTargetName?: string;
}

export type HeadArchetypeApplyMode = 'gpu' | 'composited' | 'cleared';

function extractArchetypeDelta(
  mesh: SkinnedMesh,
  archetype: HeadArchetypeDefinition,
  vertexCount: number,
): Float32Array | undefined {
  if (archetype.vertexIndices && archetype.deltas) {
    const out = new Float32Array(vertexCount * 3);
    const len = Math.min(archetype.vertexIndices.length, Math.floor(archetype.deltas.length / 3));
    for (let k = 0; k < len; k++) {
      const idx = archetype.vertexIndices[k]!;
      if (idx < 0 || idx >= vertexCount) continue;
      out[idx * 3] = archetype.deltas[k * 3] ?? 0;
      out[idx * 3 + 1] = archetype.deltas[k * 3 + 1] ?? 0;
      out[idx * 3 + 2] = archetype.deltas[k * 3 + 2] ?? 0;
    }
    return out;
  }

  const targetName = archetype.targetName ?? `${HEAD_ARCHETYPE_TARGET_PREFIX}${archetype.id}`;
  const targetIdx = mesh.morphTargetDictionary?.[targetName];
  if (targetIdx === undefined) return undefined;
  const attr = mesh.geometry.morphAttributes['position']?.[targetIdx];
  const base = mesh.geometry.getAttribute('position');
  if (!attr || !base) return undefined;

  const out = new Float32Array(vertexCount * 3);
  const relative = mesh.geometry.morphTargetsRelative;
  for (let i = 0; i < vertexCount; i++) {
    out[i * 3] = attr.getX(i) - (relative ? 0 : base.getX(i));
    out[i * 3 + 1] = attr.getY(i) - (relative ? 0 : base.getY(i));
    out[i * 3 + 2] = attr.getZ(i) - (relative ? 0 : base.getZ(i));
  }
  return out;
}

/**
 * Applies head archetype weights (and optional per-region overrides) onto `mesh`.
 * Uses direct GPU morph influences when all active archetypes are pre-baked on `mesh` without
 * regional overrides or neck-seam overrides; otherwise composites a neck-locked blended target.
 */
export function applyHeadArchetypes(
  mesh: SkinnedMesh,
  archetypes: readonly HeadArchetypeDefinition[],
  rawState: AvatarHeadArchetypeState,
  options: ApplyHeadArchetypesOptions = {},
): HeadArchetypeApplyMode {
  const position = mesh.geometry.getAttribute('position');
  if (!position) return 'cleared';
  const vertexCount = position.count;
  const state = normalizeHeadArchetypeState(rawState);
  const blendedTarget = options.blendedTargetName ?? HEAD_ARCHETYPE_BLENDED_TARGET;

  const activeRegions = state.regions
    ? (Object.entries(state.regions).filter(([, map]) => Object.keys(map).length > 0) as [
        HeadArchetypeRegionId,
        Record<string, number>,
      ][])
    : [];

  const hasGlobal = Object.keys(state.weights).length > 0;
  if (!hasGlobal && activeRegions.length === 0) {
    for (const archetype of archetypes) {
      setMorphTargetInfluence(mesh, archetype.targetName ?? `${HEAD_ARCHETYPE_TARGET_PREFIX}${archetype.id}`, 0);
    }
    setMorphTargetInfluence(mesh, blendedTarget, 0);
    return 'cleared';
  }

  const requiresMask = options.neckMask !== undefined || options.neckSeamY !== undefined || options.blendHeight !== undefined;
  const canUseDirectGpu =
    activeRegions.length === 0
    && !requiresMask
    && archetypes.every((entry) => {
      const w = state.weights[entry.id] ?? 0;
      if (w === 0) return true;
      const targetName = entry.targetName ?? `${HEAD_ARCHETYPE_TARGET_PREFIX}${entry.id}`;
      return mesh.morphTargetDictionary?.[targetName] !== undefined;
    });

  if (canUseDirectGpu) {
    setMorphTargetInfluence(mesh, blendedTarget, 0);
    for (const archetype of archetypes) {
      const targetName = archetype.targetName ?? `${HEAD_ARCHETYPE_TARGET_PREFIX}${archetype.id}`;
      setMorphTargetInfluence(mesh, targetName, state.weights[archetype.id] ?? 0);
    }
    return 'gpu';
  }

  for (const archetype of archetypes) {
    setMorphTargetInfluence(mesh, archetype.targetName ?? `${HEAD_ARCHETYPE_TARGET_PREFIX}${archetype.id}`, 0);
  }

  const neckMask =
    options.neckMask
    ?? computeNeckLockMask(mesh.geometry, options.neckSeamY ?? 0.785, options.blendHeight ?? 0.025);

  const composited = new Float32Array(vertexCount * 3);

  if (activeRegions.length === 0) {
    for (const archetype of archetypes) {
      const w = state.weights[archetype.id] ?? 0;
      if (w <= 0) continue;
      const delta = extractArchetypeDelta(mesh, archetype, vertexCount);
      if (!delta) continue;
      for (let v = 0; v < vertexCount; v++) {
        const m = w * (neckMask[v] ?? 1);
        if (m === 0) continue;
        composited[v * 3] = (composited[v * 3] ?? 0) + (delta[v * 3] ?? 0) * m;
        composited[v * 3 + 1] = (composited[v * 3 + 1] ?? 0) + (delta[v * 3 + 1] ?? 0) * m;
        composited[v * 3 + 2] = (composited[v * 3 + 2] ?? 0) + (delta[v * 3 + 2] ?? 0) * m;
      }
    }
  } else {
    const regionSum = new Float32Array(vertexCount);
    const vertexRegionMask = new Map<HeadArchetypeRegionId, Float32Array>();
    for (const [regionId] of activeRegions) {
      const combinedMask = new Float32Array(vertexCount);
      for (const archetype of archetypes) {
        const maskArr = archetype.regionWeights?.[regionId];
        if (!maskArr) continue;
        for (let v = 0; v < vertexCount; v++) {
          const val = Math.max(0, Math.min(1, maskArr[v] ?? 0));
          if (val > (combinedMask[v] ?? 0)) combinedMask[v] = val;
        }
      }
      vertexRegionMask.set(regionId, combinedMask);
      for (let v = 0; v < vertexCount; v++) {
        regionSum[v] = (regionSum[v] ?? 0) + (combinedMask[v] ?? 0);
      }
    }

    for (const archetype of archetypes) {
      const delta = extractArchetypeDelta(mesh, archetype, vertexCount);
      if (!delta) continue;
      const globalW = state.weights[archetype.id] ?? 0;

      for (let v = 0; v < vertexCount; v++) {
        const lock = neckMask[v] ?? 1;
        if (lock === 0) continue;

        const sum = regionSum[v] ?? 0;
        const norm = sum > 1 ? 1 / sum : 1;
        const globalShare = Math.max(0, 1 - sum);
        let weight = globalW * globalShare;

        for (const [regionId, regionWeights] of activeRegions) {
          const mask = (vertexRegionMask.get(regionId)?.[v] ?? 0) * norm;
          if (mask === 0) continue;
          weight += mask * (regionWeights[archetype.id] ?? 0);
        }

        const m = weight * lock;
        if (m === 0) continue;
        composited[v * 3] = (composited[v * 3] ?? 0) + (delta[v * 3] ?? 0) * m;
        composited[v * 3 + 1] = (composited[v * 3 + 1] ?? 0) + (delta[v * 3 + 1] ?? 0) * m;
        composited[v * 3 + 2] = (composited[v * 3 + 2] ?? 0) + (delta[v * 3 + 2] ?? 0) * m;
      }
    }
  }

  upsertRelativeMorphTarget(mesh, blendedTarget, composited, 1);
  return 'composited';
}

/**
 * Interpolates base head landmarks using global and regional archetype weights so procedural
 * eyeballs, lids, brows, lashes, hair caps, and facial accessories follow the sculpted skull.
 */
export function interpolateHeadLandmarks(
  baseLandmarks: HeadLandmarkSet,
  archetypes: readonly HeadArchetypeDefinition[],
  rawState: AvatarHeadArchetypeState,
  landmarkRegionMap: Readonly<Record<string, HeadArchetypeRegionId>> = LANDMARK_REGION_MAP,
): Record<string, [number, number, number]> {
  const state = normalizeHeadArchetypeState(rawState);
  const out: Record<string, [number, number, number]> = {};

  for (const [landmark, base] of Object.entries(baseLandmarks)) {
    let x = base[0];
    let y = base[1];
    let z = base[2];

    const region = landmarkRegionMap[landmark];
    const regionWeights = region ? state.regions?.[region] : undefined;
    const activeWeights =
      regionWeights && Object.keys(regionWeights).length > 0 ? regionWeights : state.weights;

    for (const archetype of archetypes) {
      const w = activeWeights[archetype.id] ?? 0;
      if (w === 0) continue;
      const delta = archetype.landmarkDeltas?.[landmark];
      if (!delta) continue;
      x += delta[0] * w;
      y += delta[1] * w;
      z += delta[2] * w;
    }

    out[landmark] = [x, y, z];
  }

  return out;
}

function parseRegionWeights(
  raw: unknown,
  expectedLength: number,
  path: string,
): Partial<Record<HeadArchetypeRegionId, number[]>> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error(`${path}: expected an object`);
  const result: Partial<Record<HeadArchetypeRegionId, number[]>> = {};
  for (const [key, arr] of Object.entries(raw)) {
    if (!VALID_REGION_SET.has(key)) continue;
    if (!Array.isArray(arr) || arr.length !== expectedLength) {
      throw new Error(`${path}.${key}: expected ${expectedLength} weights`);
    }
    result[key as HeadArchetypeRegionId] = arr.map((v, idx) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`${path}.${key}[${idx}]: expected a finite number`);
      }
      return v;
    });
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseSparseMorphEntry(
  rawIndices: unknown,
  rawDeltas: unknown,
  vertexCount: number,
  path: string,
): SparseMorphTargetDefinition {
  if (!Array.isArray(rawIndices) || !Array.isArray(rawDeltas)) {
    throw new Error(`${path}: vertexIndices and deltas must both be arrays`);
  }
  if (rawDeltas.length !== rawIndices.length * 3) {
    throw new Error(`${path}: deltas length must equal vertexIndices.length * 3`);
  }
  const vertexIndices = rawIndices.map((v, i) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= vertexCount) {
      throw new Error(`${path}.vertexIndices[${i}]: index out of range`);
    }
    return v;
  });
  const deltas = rawDeltas.map((v, i) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`${path}.deltas[${i}]: expected finite number`);
    }
    return v;
  });
  return { vertexIndices, deltas };
}

/**
 * Validates and hydrates a Blender-exported `HeadArchetypePack` JSON object, expanding shared
 * top-level `regionWeights` onto each `HeadArchetypeDefinition` when omitted per item.
 */
export function parseHeadArchetypePack(raw: unknown): HeadArchetypePack {
  if (!isRecord(raw)) throw new Error('HeadArchetypePack: expected an object');
  if (raw['version'] !== 1) throw new Error(`HeadArchetypePack: unsupported version ${String(raw['version'])}`);

  const slug = raw['slug'];
  if (typeof slug !== 'string' || slug.trim() === '') {
    throw new Error('HeadArchetypePack.slug: expected a non-empty string');
  }
  const vertexCount = raw['vertexCount'];
  if (typeof vertexCount !== 'number' || !Number.isInteger(vertexCount) || vertexCount <= 0) {
    throw new Error('HeadArchetypePack.vertexCount: expected a positive integer');
  }
  const neckSeamY = raw['neckSeamY'];
  if (typeof neckSeamY !== 'number' || !Number.isFinite(neckSeamY)) {
    throw new Error('HeadArchetypePack.neckSeamY: expected a finite number');
  }
  const blendHeight = raw['blendHeight'];
  if (blendHeight !== undefined && (typeof blendHeight !== 'number' || !Number.isFinite(blendHeight) || blendHeight < 0)) {
    throw new Error('HeadArchetypePack.blendHeight: expected a non-negative finite number');
  }

  const sharedRegions = parseRegionWeights(raw['regionWeights'], vertexCount, 'HeadArchetypePack.regionWeights');
  const rawArchetypes = raw['archetypes'];
  if (!Array.isArray(rawArchetypes)) {
    throw new Error('HeadArchetypePack.archetypes: expected an array');
  }

  const archetypes: HeadArchetypeDefinition[] = rawArchetypes.map((entry, idx) => {
    const path = `HeadArchetypePack.archetypes[${idx}]`;
    if (!isRecord(entry)) throw new Error(`${path}: expected an object`);
    const id = entry['id'];
    const label = entry['label'];
    if (typeof id !== 'string' || id.trim() === '') throw new Error(`${path}.id: expected a non-empty string`);
    if (typeof label !== 'string' || label.trim() === '') throw new Error(`${path}.label: expected a non-empty string`);

    const targetName = typeof entry['targetName'] === 'string' && entry['targetName'] ? entry['targetName'] : undefined;
    let sparse: SparseMorphTargetDefinition | undefined;
    if (entry['vertexIndices'] !== undefined || entry['deltas'] !== undefined) {
      sparse = parseSparseMorphEntry(entry['vertexIndices'], entry['deltas'], vertexCount, path);
    }

    let landmarkDeltas: HeadLandmarkSet | undefined;
    if (entry['landmarkDeltas'] !== undefined) {
      if (!isRecord(entry['landmarkDeltas'])) throw new Error(`${path}.landmarkDeltas: expected an object`);
      landmarkDeltas = {};
      for (const [lmName, vec] of Object.entries(entry['landmarkDeltas'])) {
        if (!Array.isArray(vec) || vec.length !== 3 || !vec.every((n) => typeof n === 'number' && Number.isFinite(n))) {
          throw new Error(`${path}.landmarkDeltas.${lmName}: expected [dx, dy, dz] finite numbers`);
        }
        landmarkDeltas[lmName] = [vec[0] as number, vec[1] as number, vec[2] as number];
      }
    }

    const ownRegions = parseRegionWeights(entry['regionWeights'], vertexCount, `${path}.regionWeights`);
    const resolvedRegions = ownRegions ?? sharedRegions;

    return {
      id,
      label,
      ...(targetName ? { targetName } : {}),
      ...(sparse ? { vertexIndices: sparse.vertexIndices, deltas: sparse.deltas } : {}),
      ...(landmarkDeltas ? { landmarkDeltas } : {}),
      ...(resolvedRegions ? { regionWeights: resolvedRegions } : {}),
    };
  });

  let expressionTargets: Record<string, SparseMorphTargetDefinition> | undefined;
  if (raw['expressionTargets'] !== undefined) {
    if (!isRecord(raw['expressionTargets'])) {
      throw new Error('HeadArchetypePack.expressionTargets: expected an object');
    }
    expressionTargets = {};
    for (const [channel, entry] of Object.entries(raw['expressionTargets'])) {
      if (!channel || channel.trim() === '') {
        throw new Error('HeadArchetypePack.expressionTargets: expected non-empty channel name');
      }
      const path = `HeadArchetypePack.expressionTargets.${channel}`;
      if (!isRecord(entry)) throw new Error(`${path}: expected an object`);
      expressionTargets[channel] = parseSparseMorphEntry(
        entry['vertexIndices'],
        entry['deltas'],
        vertexCount,
        path,
      );
    }
  }

  return {
    version: 1,
    slug,
    vertexCount,
    neckSeamY,
    ...(blendHeight !== undefined ? { blendHeight } : {}),
    ...(sharedRegions ? { regionWeights: sharedRegions } : {}),
    archetypes,
    ...(expressionTargets && Object.keys(expressionTargets).length > 0 ? { expressionTargets } : {}),
  };
}

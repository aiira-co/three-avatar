import {
  BufferAttribute,
  Matrix3,
  Matrix4,
  SkinnedMesh,
  Vector3,
  type Material,
} from 'three';
import { LAYERING_METADATA_KEY } from '../format/constants.js';
import type {
  AvatarItemDefinition,
  AvatarLayeringState,
  TuckCuffsMode,
  TuckTopMode,
} from '../format/types.js';
import type { EquippedAvatarItem } from '../equipment/EquipmentController.js';
import type { AvatarInstance } from '../runtime/AvatarInstance.js';
import {
  SpatialMeshIndex,
  evaluateMeshBindNormals,
  evaluateMeshBindPositions,
  laplacianSmooth,
  setMorphTargetInfluence,
  upsertRelativeMorphTarget,
  weldedAdjacency,
} from './SpatialMeshIndex.js';

export const LAYER_COVERAGE_ATTRIBUTE = 'avatarCovered';

const MIN_SKIN_CLEARANCE = 0.0025;
const MIN_LAYER_CLEARANCE = 0.005;
const MAX_OUTER_INFLATE = 0.018;
const LAYER_SEARCH_RADIUS = 0.03;
const COVERAGE_INSIDE = 0.02;
const COVERAGE_REACH = 0.025;
const INNER_COVERAGE_INSIDE = 0.006;
const INNER_COVERAGE_REACH = 0.022;
const COVERAGE_SAME_FACING = 0.25;

const LAYER_COMPRESS_TARGET = 'layer.compress';
const LAYER_CLEAR_TARGET = 'layer.clear';
const LAYER_TUCK_TOP_TARGET = 'layer.tuckTop';
const LAYER_TUCK_CUFFS_TARGET = 'layer.tuckCuffs';
const LAYER_TARGET_PREFIX = 'layer.';

export const DEFAULT_LAYER_RANKS: Readonly<Record<string, number>> = {
  body: 0,
  'upper.under': 1,
  'lower.under': 1,
  'feet.socks': 1,
  'lower.base': 2,
  outfit: 2,
  hands: 2,
  'hands.left': 2,
  'hands.right': 2,
  'upper.base': 3,
  'upper.outer': 4,
  'lower.outer': 4,
  feet: 4,
  'feet.left': 4,
  'feet.right': 4,
  'upper.armor': 5,
  waist: 5,
  neck: 5,
  back: 5,
};

export interface LayerCoverageReport {
  bodyCoveredVertices: number;
  garmentCoveredVertices: Record<string, number>;
}

export interface SolveGarmentLayersResult {
  covered: LayerCoverageReport;
  adjustedInstances: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTuckTopMode(value: unknown): value is TuckTopMode {
  return value === 'auto' || value === 'tucked' || value === 'untucked';
}

function isTuckCuffsMode(value: unknown): value is TuckCuffsMode {
  return value === 'auto' || value === 'tucked' || value === 'over';
}

export function normalizeLayeringState(raw: unknown): AvatarLayeringState {
  if (!isRecord(raw)) return {};
  const result: AvatarLayeringState = {};
  if (isTuckTopMode(raw['tuckTop']) && raw['tuckTop'] !== 'auto') {
    result.tuckTop = raw['tuckTop'];
  }
  if (isTuckCuffsMode(raw['tuckCuffs']) && raw['tuckCuffs'] !== 'auto') {
    result.tuckCuffs = raw['tuckCuffs'];
  }
  if (isRecord(raw['layerOverrides'])) {
    const overrides: Record<string, number> = {};
    for (const [channel, rank] of Object.entries(raw['layerOverrides'])) {
      if (typeof rank === 'number' && Number.isFinite(rank)) {
        overrides[channel] = rank;
      }
    }
    if (Object.keys(overrides).length > 0) result.layerOverrides = overrides;
  }
  return result;
}

export function readLayeringState(avatar: AvatarInstance): AvatarLayeringState {
  const metadata = avatar.serialize().metadata;
  return normalizeLayeringState(metadata?.[LAYERING_METADATA_KEY]);
}

export function writeLayeringState(avatar: AvatarInstance, state: AvatarLayeringState): AvatarLayeringState {
  const normalized = normalizeLayeringState(state);
  const current = avatar.serialize().metadata ?? {};
  const next: Record<string, unknown> = { ...current };
  if (Object.keys(normalized).length === 0) {
    delete next[LAYERING_METADATA_KEY];
  } else {
    next[LAYERING_METADATA_KEY] = normalized;
  }
  avatar.setMetadata(Object.keys(next).length > 0 ? next : undefined);
  return normalized;
}

/** Resolves inside-out layer rank for an item given optional user tuck/override state. */
export function resolveGarmentLayerRank(
  item: AvatarItemDefinition,
  state?: AvatarLayeringState,
): number {
  const occupies = item.occupies;
  if (state?.layerOverrides) {
    for (const channel of occupies) {
      const override = state.layerOverrides[channel];
      if (override !== undefined) return override;
    }
  }

  let baseRank: number;
  if (item.layer?.rank !== undefined) {
    baseRank = item.layer.rank;
  } else {
    const primary = occupies[0] ?? '';
    baseRank = DEFAULT_LAYER_RANKS[primary] ?? 3;
  }

  // Tucking a top into trousers places `upper.base` inside `lower.base` (1.5 < 2)
  // while keeping it outside `upper.under` (1).
  if (
    state?.tuckTop === 'tucked'
    && occupies.includes('upper.base')
    && !occupies.includes('outfit')
    && !occupies.includes('upper.outer')
  ) {
    return Math.min(baseRank, 1.5);
  }

  // Wearing cuffs over boots places `feet` below `lower.base` (1.5 < 2) while
  // keeping socks (`1`) inside footwear (`1.5`).
  if (state?.tuckCuffs === 'over' && occupies.some((c) => c === 'feet' || c === 'feet.left' || c === 'feet.right')) {
    return Math.min(baseRank, 1.5);
  }

  return baseRank;
}

function hidesInnerSurfaces(occupies: readonly string[]): boolean {
  return !occupies.some(
    (channel) =>
      channel === 'hair'
      || channel === 'back'
      || channel.startsWith('face.')
      || channel.startsWith('head.')
      || channel.startsWith('ear.'),
  );
}

function isOpaqueMaterial(material: Material | Material[]): boolean {
  const list = Array.isArray(material) ? material : [material];
  return list.every((entry) => {
    const m = entry as Material & { alphaMap?: unknown };
    return !m.transparent && !(m.alphaTest > 0) && !m.alphaMap && m.opacity >= 1;
  });
}

function collectGarmentSkinnedMeshes(
  item: EquippedAvatarItem,
  bodyRootBone: unknown,
  requireOpaque = true,
): SkinnedMesh[] {
  const meshes: SkinnedMesh[] = [];
  item.root.traverse((object) => {
    const mesh = object as SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.visible) return;
    if (requireOpaque && !isOpaqueMaterial(mesh.material)) return;
    if (bodyRootBone && mesh.skeleton.bones[0] !== bodyRootBone) return;
    meshes.push(mesh);
  });
  return meshes;
}

function ensureCoverageAttribute(mesh: SkinnedMesh): BufferAttribute {
  const existing = mesh.geometry.getAttribute(LAYER_COVERAGE_ATTRIBUTE);
  const count = mesh.geometry.getAttribute('position')?.count ?? 0;
  if (existing instanceof BufferAttribute && existing.count === count) {
    return existing;
  }
  const attr = new BufferAttribute(new Float32Array(count), 1);
  mesh.geometry.setAttribute(LAYER_COVERAGE_ATTRIBUTE, attr);
  return attr;
}

function exposedBodyVertices(body: SkinnedMesh): Uint8Array {
  const skinIndex = body.geometry.getAttribute('skinIndex');
  const skinWeight = body.geometry.getAttribute('skinWeight');
  const count = body.geometry.getAttribute('position')?.count ?? 0;
  const out = new Uint8Array(count);
  if (!skinIndex || !skinWeight) return out;
  const exposedBone = body.skeleton.bones.map((bone) =>
    /hand|head|eye|jaw|tongue/i.test(bone.name.replace(/^mixamorig\d*:?/i, '')),
  );
  for (let i = 0; i < count; i++) {
    let weight = 0;
    for (let k = 0; k < 4; k++) {
      const boneIdx = skinIndex.getComponent(i, k);
      if (exposedBone[boneIdx]) weight += skinWeight.getComponent(i, k);
    }
    if (weight >= 0.5) out[i] = 1;
  }
  return out;
}

function cleanCoverageHoles(
  mesh: SkinnedMesh,
  covered: Float32Array,
  protectedMask?: Uint8Array,
): void {
  const position = mesh.geometry.getAttribute('position');
  const index = mesh.geometry.index;
  if (!position || !index) return;
  const adjacency = weldedAdjacency(mesh);
  const { weld, offsets, neighbours } = adjacency;
  let state = new Float32Array(position.count);
  state.fill(1);
  for (let i = 0; i < position.count; i++) {
    if ((covered[i] ?? 0) <= 0.5) state[weld[i] ?? i] = 0;
  }
  for (let pass = 0; pass < 2; pass++) {
    const next = state.slice();
    for (let v = 0; v < position.count; v++) {
      if (weld[v] !== v) continue;
      if (protectedMask?.[v]) continue;
      const start = offsets[v] ?? 0;
      const end = offsets[v + 1] ?? 0;
      const degree = end - start;
      if (degree === 0) continue;
      let on = 0;
      for (let k = start; k < end; k++) {
        on += state[neighbours[k] ?? 0] ?? 0;
      }
      const share = on / degree;
      if ((state[v] ?? 0) === 0 && share >= 0.7) next[v] = 1;
      else if ((state[v] ?? 0) > 0 && share <= 0.2) next[v] = 0;
    }
    state = next;
  }
  for (let i = 0; i < position.count; i++) {
    const w = weld[i] ?? i;
    covered[i] = (state[w] ?? 0) > 0 && !protectedMask?.[i] ? 1 : 0;
  }
}

/**
 * Erodes covered vertices by 1 ring along the uncovered boundary so inner garments
 * (e.g. socks inside shoe collars) always keep a continuous rim tucked behind outer cloth.
 */
function erodeCoverageBoundary(
  mesh: SkinnedMesh,
  covered: Float32Array,
  protectedMask?: Uint8Array,
): void {
  const position = mesh.geometry.getAttribute('position');
  const index = mesh.geometry.index;
  if (!position || !index) return;
  const { weld, offsets, neighbours } = weldedAdjacency(mesh);
  const state = new Float32Array(position.count);
  state.fill(1);
  for (let i = 0; i < position.count; i++) {
    if ((covered[i] ?? 0) <= 0.5) state[weld[i] ?? i] = 0;
  }
  const next = state.slice();
  for (let v = 0; v < position.count; v++) {
    if (weld[v] !== v || (state[v] ?? 0) === 0) continue;
    const start = offsets[v] ?? 0;
    const end = offsets[v + 1] ?? 0;
    for (let k = start; k < end; k++) {
      if ((state[neighbours[k] ?? 0] ?? 0) === 0) {
        next[v] = 0;
        break;
      }
    }
  }
  for (let i = 0; i < position.count; i++) {
    const w = weld[i] ?? i;
    covered[i] = (next[w] ?? 0) > 0 && !protectedMask?.[i] ? 1 : 0;
  }
}

function markCoveredVertices(
  target: SkinnedMesh,
  outerIndex: SpatialMeshIndex | undefined,
  protectedMask?: Uint8Array,
  erodeBoundary = false,
): number {
  const attr = ensureCoverageAttribute(target);
  const covered = attr.array as Float32Array;
  covered.fill(0);
  if (!outerIndex) {
    attr.needsUpdate = true;
    return 0;
  }

  const positions = evaluateMeshBindPositions(target, () => true);
  const normals = evaluateMeshBindNormals(target);
  const count = Math.floor(positions.length / 3);
  const p = new Vector3();
  const n = new Vector3();
  const origin = new Vector3();
  const inside = erodeBoundary ? INNER_COVERAGE_INSIDE : COVERAGE_INSIDE;
  const reach = erodeBoundary ? INNER_COVERAGE_REACH : COVERAGE_REACH;
  const probeLength = inside + reach;

  for (let i = 0; i < count; i++) {
    if (protectedMask?.[i]) continue;
    p.set(positions[i * 3] ?? 0, positions[i * 3 + 1] ?? 0, positions[i * 3 + 2] ?? 0);
    n.set(normals[i * 3] ?? 0, normals[i * 3 + 1] ?? 1, normals[i * 3 + 2] ?? 0);
    if (n.lengthSq() < 1e-12) continue;
    n.normalize();
    origin.copy(p).addScaledVector(n, -inside);
    if (outerIndex.rayHitsFrontFacing(origin, n, probeLength, COVERAGE_SAME_FACING)) {
      covered[i] = 1;
    }
  }

  if (erodeBoundary) {
    erodeCoverageBoundary(target, covered, protectedMask);
  } else {
    cleanCoverageHoles(target, covered, protectedMask);
  }
  attr.needsUpdate = true;

  let coveredCount = 0;
  for (let i = 0; i < count; i++) {
    if ((covered[i] ?? 0) > 0.5) coveredCount++;
  }
  return coveredCount;
}

/**
 * Computes per-vertex `avatarCovered` attributes on `avatar.bodyMesh` and all inner opaque skinned
 * garments against higher-rank opaque garments. Open fronts/collars stay uncovered where outer
 * rays miss.
 */
export function computeLayerCoverage(
  avatar: AvatarInstance,
  state?: AvatarLayeringState,
): LayerCoverageReport {
  const effectiveState = state ?? readLayeringState(avatar);
  const bodyRootBone = avatar.bodyMesh.skeleton.bones[0];
  const entries = avatar.equipment
    .list()
    .filter((entry) => entry.definition.render.type === 'skinned' && hidesInnerSurfaces(entry.definition.occupies))
    .map((entry) => ({
      item: entry,
      rank: resolveGarmentLayerRank(entry.definition, effectiveState),
      meshes: collectGarmentSkinnedMeshes(entry, bodyRootBone, true),
    }))
    .filter((entry) => entry.meshes.length > 0);

  const allOuterMeshes = entries.flatMap((entry) => entry.meshes);
  const bodyOuterIndex = allOuterMeshes.length
    ? SpatialMeshIndex.fromSkinnedMeshes(allOuterMeshes, { includeMorph: () => true })
    : undefined;
  const bodyCoveredVertices = markCoveredVertices(
    avatar.bodyMesh,
    bodyOuterIndex,
    exposedBodyVertices(avatar.bodyMesh),
  );

  const garmentCoveredVertices: Record<string, number> = {};
  for (const entry of entries) {
    const higherMeshes = entries
      .filter((other) => other.rank > entry.rank)
      .flatMap((other) => other.meshes);
    const higherIndex = higherMeshes.length
      ? SpatialMeshIndex.fromSkinnedMeshes(higherMeshes, { includeMorph: () => true })
      : undefined;
    let totalCovered = 0;
    for (const mesh of entry.meshes) {
      totalCovered += markCoveredVertices(mesh, higherIndex, undefined, true);
    }
    garmentCoveredVertices[entry.item.instanceId] = totalCovered;
  }

  return { bodyCoveredVertices, garmentCoveredVertices };
}

function resetLayerTargets(mesh: SkinnedMesh): void {
  setMorphTargetInfluence(mesh, LAYER_COMPRESS_TARGET, 0);
  setMorphTargetInfluence(mesh, LAYER_CLEAR_TARGET, 0);
  setMorphTargetInfluence(mesh, LAYER_TUCK_TOP_TARGET, 0);
  setMorphTargetInfluence(mesh, LAYER_TUCK_CUFFS_TARGET, 0);
}

const nonLayerMorph = (name: string): boolean => !name.startsWith(LAYER_TARGET_PREFIX);
const preSeparationMorph = (name: string): boolean =>
  name === LAYER_TUCK_TOP_TARGET || name === LAYER_TUCK_CUFFS_TARGET || !name.startsWith(LAYER_TARGET_PREFIX);

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / Math.max(edge1 - edge0, 1e-9)));
  return t * t * (3 - 2 * t);
}

function meshBoundsY(meshes: readonly SkinnedMesh[]): { minY: number; maxY: number; centerX: number; centerZ: number } {
  let minY = Infinity;
  let maxY = -Infinity;
  let sumX = 0;
  let sumZ = 0;
  let count = 0;
  for (const mesh of meshes) {
    const pos = evaluateMeshBindPositions(mesh, nonLayerMorph);
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i] ?? 0;
      const y = pos[i + 1] ?? 0;
      const z = pos[i + 2] ?? 0;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sumX += x;
      sumZ += z;
      count++;
    }
  }
  return {
    minY,
    maxY,
    centerX: count > 0 ? sumX / count : 0,
    centerZ: count > 0 ? sumZ / count : 0,
  };
}

function armWeightMask(mesh: SkinnedMesh): Float32Array {
  const count = mesh.geometry.getAttribute('position')?.count ?? 0;
  const out = new Float32Array(count);
  const skinIndex = mesh.geometry.getAttribute('skinIndex');
  const skinWeight = mesh.geometry.getAttribute('skinWeight');
  if (!skinIndex || !skinWeight) return out;
  const isArm = mesh.skeleton.bones.map((bone) =>
    /arm|hand/i.test(bone.name.replace(/^mixamorig\d*:?/i, '')),
  );
  for (let i = 0; i < count; i++) {
    let w = 0;
    for (let k = 0; k < 4; k++) {
      if (isArm[skinIndex.getComponent(i, k)]) w += skinWeight.getComponent(i, k);
    }
    out[i] = w;
  }
  return out;
}

function commitSmoothedBindDelta(
  mesh: SkinnedMesh,
  targetName: string,
  bindDelta: Float32Array,
  iterations: number,
  amount: number,
): void {
  const count = Math.floor(bindDelta.length / 3);
  const adjacency = weldedAdjacency(mesh);
  const smoothed = laplacianSmooth(bindDelta, adjacency, iterations, amount);
  const toMesh = new Matrix3().setFromMatrix4(new Matrix4().copy(mesh.bindMatrix).invert());
  const meshDelta = new Float32Array(count * 3);
  const v = new Vector3();
  for (let i = 0; i < count; i++) {
    v.set(smoothed[i * 3] ?? 0, smoothed[i * 3 + 1] ?? 0, smoothed[i * 3 + 2] ?? 0).applyMatrix3(toMesh);
    meshDelta[i * 3] = v.x;
    meshDelta[i * 3 + 1] = v.y;
    meshDelta[i * 3 + 2] = v.z;
  }
  upsertRelativeMorphTarget(mesh, targetName, meshDelta, 1);
}

function applyTuckTop(
  upperMeshes: readonly SkinnedMesh[],
  lowerMeshes: readonly SkinnedMesh[],
  bodyIndex: SpatialMeshIndex | undefined,
): boolean {
  const { maxY: waistTopY, centerX, centerZ } = meshBoundsY(lowerMeshes);
  if (!Number.isFinite(waistTopY)) return false;

  let changed = false;
  const p = new Vector3();
  const radial = new Vector3();
  const bary: [number, number, number] = [0, 0, 0];

  for (const mesh of upperMeshes) {
    const pos = evaluateMeshBindPositions(mesh, nonLayerMorph);
    const count = Math.floor(pos.length / 3);
    const arms = armWeightMask(mesh);
    const bindDelta = new Float32Array(count * 3);
    let moved = false;

    for (let i = 0; i < count; i++) {
      const arm = arms[i] ?? 0;
      if (arm >= 0.5) continue;
      const x = pos[i * 3] ?? 0;
      const y = pos[i * 3 + 1] ?? 0;
      const z = pos[i * 3 + 2] ?? 0;
      if (y > waistTopY + 0.015) continue;

      const t = 1 - smoothstep(waistTopY - 0.045, waistTopY + 0.015, y);
      radial.set(x - centerX, 0, z - centerZ);
      const len = radial.length();
      if (len < 1e-5) continue;
      radial.divideScalar(len);

      let push = 0.014 * t * (1 - arm * 2);
      if (bodyIndex) {
        p.set(x, y, z);
        const hit = bodyIndex.closest(p, bary, 0.05);
        if (hit.triangle >= 0) {
          const room = Math.max(0, hit.distance - MIN_SKIN_CLEARANCE);
          push = Math.min(push, room);
        }
      }
      if (push <= 1e-5) continue;
      bindDelta[i * 3] = -radial.x * push;
      bindDelta[i * 3 + 2] = -radial.z * push;
      moved = true;
    }

    if (!moved) continue;
    commitSmoothedBindDelta(mesh, LAYER_TUCK_TOP_TARGET, bindDelta, 2, 0.4);
    changed = true;
  }
  return changed;
}

function applyTuckCuffs(
  lowerMeshes: readonly SkinnedMesh[],
  feetMeshes: readonly SkinnedMesh[],
  bodyIndex: SpatialMeshIndex | undefined,
  shouldTuck: boolean,
): boolean {
  let changed = false;
  let usedAuthored = false;
  for (const mesh of lowerMeshes) {
    if (setMorphTargetInfluence(mesh, 'TuckIntoBoots', shouldTuck ? 1 : 0)) {
      usedAuthored = true;
      changed = true;
    }
  }
  if (!shouldTuck || usedAuthored) return changed;

  const { maxY: bootTopY } = meshBoundsY(feetMeshes);
  if (!Number.isFinite(bootTopY)) return false;

  const p = new Vector3();
  const radial = new Vector3();
  const bary: [number, number, number] = [0, 0, 0];

  for (const mesh of lowerMeshes) {
    const pos = evaluateMeshBindPositions(mesh, nonLayerMorph);
    const norm = evaluateMeshBindNormals(mesh);
    const count = Math.floor(pos.length / 3);
    const bindDelta = new Float32Array(count * 3);
    let moved = false;

    for (let i = 0; i < count; i++) {
      const y = pos[i * 3 + 1] ?? 0;
      if (y > bootTopY + 0.02) continue;
      const t = 1 - smoothstep(bootTopY - 0.05, bootTopY + 0.02, y);
      radial.set(norm[i * 3] ?? 0, 0, norm[i * 3 + 2] ?? 0);
      if (radial.lengthSq() < 1e-6) continue;
      radial.normalize();

      let push = 0.012 * t;
      if (bodyIndex) {
        p.set(pos[i * 3] ?? 0, y, pos[i * 3 + 2] ?? 0);
        const hit = bodyIndex.closest(p, bary, 0.05);
        if (hit.triangle >= 0) {
          push = Math.min(push, Math.max(0, hit.distance - MIN_SKIN_CLEARANCE));
        }
      }
      if (push <= 1e-5) continue;
      bindDelta[i * 3] = -radial.x * push;
      bindDelta[i * 3 + 2] = -radial.z * push;
      moved = true;
    }

    if (!moved) continue;
    commitSmoothedBindDelta(mesh, LAYER_TUCK_CUFFS_TARGET, bindDelta, 2, 0.4);
    changed = true;
  }
  return changed;
}

/**
 * Resolves layered garment stacking automatically:
 * 1. Handles top-into-waistband and cuff-into-boot tucks.
 * 2. Compresses inner garments (`layer.compress`, clamped above skin clearance) where outer layers press in.
 * 3. Expands outer garments (`layer.clear`, smoothed) to guarantee `5mm` separation over inner layers.
 * 4. Updates per-vertex `avatarCovered` on the body and inner garments.
 */
export function solveGarmentLayers(
  avatar: AvatarInstance,
  state?: AvatarLayeringState,
): SolveGarmentLayersResult {
  const effectiveState = state ?? readLayeringState(avatar);
  const bodyRootBone = avatar.bodyMesh.skeleton.bones[0];

  const entries = avatar.equipment
    .list()
    .filter((entry) => entry.definition.render.type === 'skinned' && hidesInnerSurfaces(entry.definition.occupies))
    .map((entry) => ({
      item: entry,
      rank: resolveGarmentLayerRank(entry.definition, effectiveState),
      meshes: collectGarmentSkinnedMeshes(entry, bodyRootBone, false),
    }))
    .filter((entry) => entry.meshes.length > 0)
    .sort((a, b) => a.rank - b.rank);

  for (const entry of entries) {
    for (const mesh of entry.meshes) resetLayerTargets(mesh);
  }

  const adjusted = new Set<string>();
  const bodyIndex = SpatialMeshIndex.fromAvatarBody(avatar, { includeMorph: nonLayerMorph });

  // 1. Pair interactions: tuckTop and tuckCuffs.
  const upperBase = entries.find(
    (entry) => entry.item.definition.occupies.includes('upper.base') && !entry.item.definition.occupies.includes('outfit'),
  );
  const lowerBase = entries.find(
    (entry) => entry.item.definition.occupies.includes('lower.base') || entry.item.definition.occupies.includes('outfit'),
  );
  if (upperBase && lowerBase) {
    const mode = effectiveState.tuckTop ?? 'auto';
    const shouldTuckTop = mode === 'tucked' || (mode === 'auto' && upperBase.item.definition.layer?.tuckable === true);
    if (shouldTuckTop && applyTuckTop(upperBase.meshes, lowerBase.meshes, bodyIndex)) {
      adjusted.add(upperBase.item.instanceId);
    }
  }

  const feet = entries.find((entry) =>
    entry.item.definition.occupies.some((c) => c === 'feet' || c === 'feet.left' || c === 'feet.right'),
  );
  if (lowerBase && feet) {
    const cuffMode = effectiveState.tuckCuffs ?? 'auto';
    const bootsWantTuck =
      feet.item.definition.metadata?.['tucksLegwear'] === true || feet.item.definition.layer?.highShaft === true;
    const shouldTuckCuffs = cuffMode === 'tucked' || (cuffMode === 'auto' && bootsWantTuck);
    if (applyTuckCuffs(lowerBase.meshes, feet.meshes, bodyIndex, shouldTuckCuffs)) {
      adjusted.add(lowerBase.item.instanceId);
    }
  }

  // Re-sort after rank considerations (effectiveState already captures tuck modes).
  const p = new Vector3();
  const innerN = new Vector3();
  const outerN = new Vector3();
  const deltaVec = new Vector3();
  const bary: [number, number, number] = [0, 0, 0];

  // 2. Pass 1: Compress inner layers under strictly higher-rank outer layers (clamped above skin).
  for (let i = 0; i < entries.length - 1; i++) {
    const innerEntry = entries[i]!;
    const outerMeshes = entries
      .filter((candidate) => candidate.rank > innerEntry.rank)
      .flatMap((candidate) => candidate.meshes);
    if (outerMeshes.length === 0) continue;

    const outerIndex = SpatialMeshIndex.fromSkinnedMeshes(outerMeshes, { includeMorph: preSeparationMorph });
    if (!outerIndex) continue;

    for (const mesh of innerEntry.meshes) {
      const pos = evaluateMeshBindPositions(mesh, preSeparationMorph);
      const norm = evaluateMeshBindNormals(mesh);
      const count = Math.floor(pos.length / 3);
      const bindDelta = new Float32Array(count * 3);
      let moved = false;

      for (let v = 0; v < count; v++) {
        p.set(pos[v * 3] ?? 0, pos[v * 3 + 1] ?? 0, pos[v * 3 + 2] ?? 0);
        innerN.set(norm[v * 3] ?? 0, norm[v * 3 + 1] ?? 1, norm[v * 3 + 2] ?? 0);
        if (innerN.lengthSq() < 1e-12) continue;
        innerN.normalize();

        const outerHit = outerIndex.closest(p, bary, LAYER_SEARCH_RADIUS);
        if (outerHit.triangle < 0) continue;

        outerIndex.triangleNormal(outerHit.triangle, bary, outerN);
        if (outerN.dot(innerN) <= 0.1) continue;

        // Positive signedClearance means `p` sits inside `outer` along `-outerN`.
        const signedClearance = deltaVec.subVectors(outerHit.closestPoint, p).dot(outerN);
        if (signedClearance >= MIN_LAYER_CLEARANCE) continue;

        let push = MIN_LAYER_CLEARANCE - signedClearance;
        if (bodyIndex) {
          const skinHit = bodyIndex.closest(p, bary, 0.08);
          if (skinHit.triangle >= 0) {
            const room = Math.max(0, skinHit.distance - MIN_SKIN_CLEARANCE);
            push = Math.min(push, room);
          }
        }
        if (push <= 1e-5) continue;

        bindDelta[v * 3] = -innerN.x * push;
        bindDelta[v * 3 + 1] = -innerN.y * push;
        bindDelta[v * 3 + 2] = -innerN.z * push;
        moved = true;
      }

      if (!moved) continue;
      commitSmoothedBindDelta(mesh, LAYER_COMPRESS_TARGET, bindDelta, 3, 0.45);
      adjusted.add(innerEntry.item.instanceId);
    }
  }

  // 3. Pass 2: Expand outer layers for any remaining deficit against compressed inner layers.
  const includeCompressed = (name: string): boolean =>
    name === LAYER_COMPRESS_TARGET || preSeparationMorph(name);

  for (let j = 1; j < entries.length; j++) {
    const outerEntry = entries[j]!;
    const innerMeshes = entries
      .filter((candidate) => candidate.rank < outerEntry.rank)
      .flatMap((candidate) => candidate.meshes);
    if (innerMeshes.length === 0) continue;

    const innerIndex = SpatialMeshIndex.fromSkinnedMeshes(innerMeshes, { includeMorph: includeCompressed });
    if (!innerIndex) continue;

    for (const mesh of outerEntry.meshes) {
      const pos = evaluateMeshBindPositions(mesh, preSeparationMorph);
      const norm = evaluateMeshBindNormals(mesh);
      const count = Math.floor(pos.length / 3);
      const bindDelta = new Float32Array(count * 3);
      let moved = false;

      for (let v = 0; v < count; v++) {
        p.set(pos[v * 3] ?? 0, pos[v * 3 + 1] ?? 0, pos[v * 3 + 2] ?? 0);
        outerN.set(norm[v * 3] ?? 0, norm[v * 3 + 1] ?? 1, norm[v * 3 + 2] ?? 0);
        if (outerN.lengthSq() < 1e-12) continue;
        outerN.normalize();

        const innerHit = innerIndex.closest(p, bary, LAYER_SEARCH_RADIUS);
        if (innerHit.triangle < 0) continue;

        innerIndex.triangleNormal(innerHit.triangle, bary, innerN);
        if (innerN.dot(outerN) <= 0.1) continue;

        // Positive clearance means `p` sits outside `inner` along `+innerN`.
        const clearance = deltaVec.subVectors(p, innerHit.closestPoint).dot(innerN);
        if (clearance >= MIN_LAYER_CLEARANCE) continue;

        const push = Math.min(MAX_OUTER_INFLATE, MIN_LAYER_CLEARANCE - clearance);
        if (push <= 1e-5) continue;

        bindDelta[v * 3] = innerN.x * push;
        bindDelta[v * 3 + 1] = innerN.y * push;
        bindDelta[v * 3 + 2] = innerN.z * push;
        moved = true;
      }

      if (!moved) continue;
      commitSmoothedBindDelta(mesh, LAYER_CLEAR_TARGET, bindDelta, 4, 0.5);
      adjusted.add(outerEntry.item.instanceId);
    }
  }

  const covered = computeLayerCoverage(avatar, effectiveState);
  return {
    covered,
    adjustedInstances: [...adjusted],
  };
}

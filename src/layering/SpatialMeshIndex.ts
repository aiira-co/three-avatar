import {
  BufferAttribute,
  Float32BufferAttribute,
  Matrix3,
  Matrix4,
  Mesh,
  SkinnedMesh,
  Vector3,
} from 'three';
import type { AvatarInstance } from '../runtime/AvatarInstance.js';

const CELL = 0.012;
const OFFSET = 1024;
const cellKey = (ix: number, iy: number, iz: number): number =>
  ((ix + OFFSET) * 2048 + (iy + OFFSET)) * 2048 + (iz + OFFSET);

export interface WeldedAdjacency {
  readonly weld: Int32Array;
  readonly offsets: Int32Array;
  readonly neighbours: Int32Array;
}

export interface SpatialMeshIndexOptions {
  /** Optional filter for which active morph targets are baked into the bind-space snapshot. */
  includeMorph?: (name: string) => boolean;
}

const _ab = new Vector3();
const _ac = new Vector3();
const _ap = new Vector3();
const _bp = new Vector3();
const _cp = new Vector3();
const _v = new Vector3();
const _m = new Vector3();

/**
 * Closest point on triangle `(ia, ib, ic)` in flat `positions` array to `point`.
 * Returns squared distance and writes closest point to `out` and barycentric weights to `bary`.
 */
export function closestPointOnTriangle(
  positions: Float32Array,
  ia: number,
  ib: number,
  ic: number,
  point: Vector3,
  out: Vector3,
  bary: [number, number, number],
): number {
  const ax = positions[ia] ?? 0;
  const ay = positions[ia + 1] ?? 0;
  const az = positions[ia + 2] ?? 0;
  const bx = positions[ib] ?? 0;
  const by = positions[ib + 1] ?? 0;
  const bz = positions[ib + 2] ?? 0;
  const cx = positions[ic] ?? 0;
  const cy = positions[ic + 1] ?? 0;
  const cz = positions[ic + 2] ?? 0;

  _ab.set(bx - ax, by - ay, bz - az);
  _ac.set(cx - ax, cy - ay, cz - az);
  _ap.set(point.x - ax, point.y - ay, point.z - az);

  const d1 = _ab.dot(_ap);
  const d2 = _ac.dot(_ap);
  if (d1 <= 0 && d2 <= 0) {
    out.set(ax, ay, az);
    bary[0] = 1; bary[1] = 0; bary[2] = 0;
    return out.distanceToSquared(point);
  }

  _bp.set(point.x - bx, point.y - by, point.z - bz);
  const d3 = _ab.dot(_bp);
  const d4 = _ac.dot(_bp);
  if (d3 >= 0 && d4 <= d3) {
    out.set(bx, by, bz);
    bary[0] = 0; bary[1] = 1; bary[2] = 0;
    return out.distanceToSquared(point);
  }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out.set(ax + v * _ab.x, ay + v * _ab.y, az + v * _ab.z);
    bary[0] = 1 - v; bary[1] = v; bary[2] = 0;
    return out.distanceToSquared(point);
  }

  _cp.set(point.x - cx, point.y - cy, point.z - cz);
  const d5 = _ab.dot(_cp);
  const d6 = _ac.dot(_cp);
  if (d6 >= 0 && d5 <= d6) {
    out.set(cx, cy, cz);
    bary[0] = 0; bary[1] = 0; bary[2] = 1;
    return out.distanceToSquared(point);
  }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out.set(ax + w * _ac.x, ay + w * _ac.y, az + w * _ac.z);
    bary[0] = 1 - w; bary[1] = 0; bary[2] = w;
    return out.distanceToSquared(point);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    out.set(bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz));
    bary[0] = 0; bary[1] = 1 - w; bary[2] = w;
    return out.distanceToSquared(point);
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  out.set(
    ax + _ab.x * v + _ac.x * w,
    ay + _ab.y * v + _ac.y * w,
    az + _ab.z * v + _ac.z * w,
  );
  bary[0] = 1 - v - w;
  bary[1] = v;
  bary[2] = w;
  return out.distanceToSquared(point);
}

/**
 * Evaluates vertex positions of `mesh` in bind space, optionally applying active morph targets
 * matching `includeMorph`.
 */
export function evaluateMeshBindPositions(
  mesh: SkinnedMesh,
  includeMorph?: (name: string) => boolean,
): Float32Array {
  const position = mesh.geometry.getAttribute('position');
  if (!position) return new Float32Array(0);
  const out = new Float32Array(position.count * 3);
  const targets = mesh.geometry.morphAttributes['position'] ?? [];
  const influences = mesh.morphTargetInfluences ?? [];
  const relative = mesh.geometry.morphTargetsRelative;

  const activeTargets = includeMorph
    ? targets
        .map((attr, idx) => ({ attr, influence: influences[idx] ?? 0 }))
        .filter((entry) => entry.influence !== 0 && includeMorph(entry.attr.name))
    : [];

  for (let i = 0; i < position.count; i++) {
    _v.fromBufferAttribute(position, i);
    if (activeTargets.length > 0) {
      const baseX = _v.x;
      const baseY = _v.y;
      const baseZ = _v.z;
      for (const { attr, influence } of activeTargets) {
        _m.fromBufferAttribute(attr, i);
        if (!relative) {
          _m.x -= baseX;
          _m.y -= baseY;
          _m.z -= baseZ;
        }
        _v.addScaledVector(_m, influence);
      }
    }
    _v.applyMatrix4(mesh.bindMatrix);
    out[i * 3] = _v.x;
    out[i * 3 + 1] = _v.y;
    out[i * 3 + 2] = _v.z;
  }
  return out;
}

/** Evaluates vertex normals of `mesh` in bind space. */
export function evaluateMeshBindNormals(mesh: SkinnedMesh): Float32Array {
  if (!mesh.geometry.getAttribute('normal')) {
    mesh.geometry.computeVertexNormals();
  }
  const normal = mesh.geometry.getAttribute('normal');
  if (!normal) return new Float32Array(0);
  const out = new Float32Array(normal.count * 3);
  const normalMatrix = new Matrix3().getNormalMatrix(mesh.bindMatrix);
  for (let i = 0; i < normal.count; i++) {
    _v.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
    out[i * 3] = _v.x;
    out[i * 3 + 1] = _v.y;
    out[i * 3 + 2] = _v.z;
  }
  return out;
}

/**
 * Spatial hash grid over bind-space triangles for closest-point queries between body and garment
 * layers without modifying mesh topology.
 */
export class SpatialMeshIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly stamps: Uint32Array;
  private query = 0;
  private readonly scratch = new Vector3();
  private readonly scratchBary: [number, number, number] = [0, 0, 0];

  readonly triangleCount: number;

  constructor(
    readonly positions: Float32Array,
    readonly triangles: Uint32Array,
    readonly normals?: Float32Array,
  ) {
    this.triangleCount = Math.floor(triangles.length / 3);
    this.stamps = new Uint32Array(this.triangleCount);

    for (let t = 0; t < this.triangleCount; t++) {
      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;

      for (let k = 0; k < 3; k++) {
        const v = (triangles[t * 3 + k] ?? 0) * 3;
        const x = positions[v] ?? 0;
        const y = positions[v + 1] ?? 0;
        const z = positions[v + 2] ?? 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }

      const x0 = Math.floor(minX / CELL);
      const x1 = Math.floor(maxX / CELL);
      const y0 = Math.floor(minY / CELL);
      const y1 = Math.floor(maxY / CELL);
      const z0 = Math.floor(minZ / CELL);
      const z1 = Math.floor(maxZ / CELL);

      for (let ix = x0; ix <= x1; ix++) {
        for (let iy = y0; iy <= y1; iy++) {
          for (let iz = z0; iz <= z1; iz++) {
            const key = cellKey(ix, iy, iz);
            let bucket = this.cells.get(key);
            if (!bucket) {
              bucket = [];
              this.cells.set(key, bucket);
            }
            bucket.push(t);
          }
        }
      }
    }
  }

  static fromSkinnedMesh(mesh: SkinnedMesh, options: SpatialMeshIndexOptions = {}): SpatialMeshIndex | undefined {
    return SpatialMeshIndex.fromSkinnedMeshes([mesh], options);
  }

  static fromSkinnedMeshes(meshes: readonly SkinnedMesh[], options: SpatialMeshIndexOptions = {}): SpatialMeshIndex | undefined {
    const positionsList: number[] = [];
    const normalsList: number[] = [];
    const trianglesList: number[] = [];

    for (const mesh of meshes) {
      const posAttr = mesh.geometry.getAttribute('position');
      if (!posAttr || posAttr.count === 0) continue;
      const offset = positionsList.length / 3;
      const pos = evaluateMeshBindPositions(mesh, options.includeMorph);
      const norm = evaluateMeshBindNormals(mesh);
      for (let i = 0; i < pos.length; i++) positionsList.push(pos[i] ?? 0);
      for (let i = 0; i < norm.length; i++) normalsList.push(norm[i] ?? 0);

      const index = mesh.geometry.index;
      const corners = index ? index.count : posAttr.count;
      for (let i = 0; i + 2 < corners; i += 3) {
        trianglesList.push(
          offset + (index ? index.getX(i) : i),
          offset + (index ? index.getX(i + 1) : i + 1),
          offset + (index ? index.getX(i + 2) : i + 2),
        );
      }
    }

    if (trianglesList.length === 0) return undefined;
    return new SpatialMeshIndex(
      Float32Array.from(positionsList),
      Uint32Array.from(trianglesList),
      Float32Array.from(normalsList),
    );
  }

  /** Builds a complete bind-space body index even while equipment hides body regions. */
  static fromAvatarBody(avatar: AvatarInstance, options: SpatialMeshIndexOptions = {}): SpatialMeshIndex | undefined {
    const hidden = [...avatar.bodyVisibility.hiddenRegions];
    if (hidden.length > 0) avatar.bodyVisibility.showAll();
    try {
      return SpatialMeshIndex.fromSkinnedMesh(avatar.bodyMesh, options);
    } finally {
      if (hidden.length > 0) avatar.bodyVisibility.setHiddenRegions(hidden);
    }
  }

  closest(
    point: Vector3,
    bary: [number, number, number],
    maxRadius: number,
  ): { triangle: number; distance: number; closestPoint: Vector3 } {
    const stamp = ++this.query;
    const cx = Math.floor(point.x / CELL);
    const cy = Math.floor(point.y / CELL);
    const cz = Math.floor(point.z / CELL);
    const maxRing = Math.ceil(maxRadius / CELL);
    let best = maxRadius * maxRadius;
    let triangle = -1;
    const bestPoint = new Vector3();

    for (let ring = 0; ring <= maxRing; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          for (let dz = -ring; dz <= ring; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue;
            const bucket = this.cells.get(cellKey(cx + dx, cy + dy, cz + dz));
            if (!bucket) continue;
            for (const t of bucket) {
              if (this.stamps[t] === stamp) continue;
              this.stamps[t] = stamp;
              const ia = (this.triangles[t * 3] ?? 0) * 3;
              const ib = (this.triangles[t * 3 + 1] ?? 0) * 3;
              const ic = (this.triangles[t * 3 + 2] ?? 0) * 3;
              const distSq = closestPointOnTriangle(
                this.positions,
                ia,
                ib,
                ic,
                point,
                this.scratch,
                this.scratchBary,
              );
              if (distSq < best) {
                best = distSq;
                triangle = t;
                bary[0] = this.scratchBary[0];
                bary[1] = this.scratchBary[1];
                bary[2] = this.scratchBary[2];
                bestPoint.copy(this.scratch);
              }
            }
          }
        }
      }
      if (triangle >= 0 && best <= (ring * CELL) ** 2) break;
    }

    return { triangle, distance: Math.sqrt(best), closestPoint: bestPoint };
  }

  /** Interpolated outward normal of triangle `t` using barycentric weights `bary`. */
  triangleNormal(t: number, bary: readonly [number, number, number], out = new Vector3()): Vector3 {
    const ia = (this.triangles[t * 3] ?? 0) * 3;
    const ib = (this.triangles[t * 3 + 1] ?? 0) * 3;
    const ic = (this.triangles[t * 3 + 2] ?? 0) * 3;
    if (this.normals && this.normals.length >= Math.max(ia, ib, ic) + 3) {
      out.set(
        (this.normals[ia] ?? 0) * bary[0] + (this.normals[ib] ?? 0) * bary[1] + (this.normals[ic] ?? 0) * bary[2],
        (this.normals[ia + 1] ?? 0) * bary[0] + (this.normals[ib + 1] ?? 0) * bary[1] + (this.normals[ic + 1] ?? 0) * bary[2],
        (this.normals[ia + 2] ?? 0) * bary[0] + (this.normals[ib + 2] ?? 0) * bary[1] + (this.normals[ic + 2] ?? 0) * bary[2],
      );
      if (out.lengthSq() > 1e-12) return out.normalize();
    }
    const ax = this.positions[ia] ?? 0;
    const ay = this.positions[ia + 1] ?? 0;
    const az = this.positions[ia + 2] ?? 0;
    _ab.set((this.positions[ib] ?? 0) - ax, (this.positions[ib + 1] ?? 0) - ay, (this.positions[ib + 2] ?? 0) - az);
    _ac.set((this.positions[ic] ?? 0) - ax, (this.positions[ic + 1] ?? 0) - ay, (this.positions[ic + 2] ?? 0) - az);
    out.crossVectors(_ab, _ac);
    return out.lengthSq() > 1e-12 ? out.normalize() : out.set(0, 1, 0);
  }

  /**
   * Returns true if a ray starting at `origin` along unit `direction` hits any triangle within
   * `maxDistance` whose outward normal agrees with `direction` (`dot >= minFacing`).
   */
  rayHitsFrontFacing(
    origin: Vector3,
    direction: Vector3,
    maxDistance: number,
    minFacing = 0.25,
  ): boolean {
    if (this.triangleCount === 0 || maxDistance <= 0) return false;
    const stamp = ++this.query;
    const steps = Math.max(1, Math.ceil(maxDistance / (CELL * 0.5)));
    const sample = new Vector3();
    const triNormal = new Vector3();
    const centerBary: [number, number, number] = [1 / 3, 1 / 3, 1 / 3];

    for (let s = 0; s <= steps; s++) {
      sample.copy(origin).addScaledVector(direction, (s / steps) * maxDistance);
      const bucket = this.cells.get(
        cellKey(Math.floor(sample.x / CELL), Math.floor(sample.y / CELL), Math.floor(sample.z / CELL)),
      );
      if (!bucket) continue;
      for (const t of bucket) {
        if (this.stamps[t] === stamp) continue;
        this.stamps[t] = stamp;
        this.triangleNormal(t, centerBary, triNormal);
        if (triNormal.dot(direction) < minFacing) continue;
        const dist = rayTriangle(this.positions, t, origin, direction, this.triangles);
        if (dist >= 0 && dist <= maxDistance) return true;
      }
    }
    return false;
  }
}

/** Builds welded neighbour lists (CSR) so smoothing never splits UV seams. */
export function weldedAdjacency(mesh: SkinnedMesh): WeldedAdjacency {
  const position = mesh.geometry.getAttribute('position');
  if (!position) {
    return { weld: new Int32Array(0), offsets: new Int32Array(1), neighbours: new Int32Array(0) };
  }
  const count = position.count;
  const weld = new Int32Array(count);
  const seen = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(position.getX(i) * 1e5)},${Math.round(position.getY(i) * 1e5)},${Math.round(position.getZ(i) * 1e5)}`;
    const existing = seen.get(key);
    if (existing === undefined) {
      weld[i] = i;
      seen.set(key, i);
    } else {
      weld[i] = existing;
    }
  }

  const sets = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (a === b) return;
    let set = sets.get(a);
    if (!set) {
      set = new Set();
      sets.set(a, set);
    }
    set.add(b);
  };

  const index = mesh.geometry.index;
  const corners = index ? index.count : count;
  for (let i = 0; i + 2 < corners; i += 3) {
    const a = weld[index ? index.getX(i) : i] ?? 0;
    const b = weld[index ? index.getX(i + 1) : i + 1] ?? 0;
    const c = weld[index ? index.getX(i + 2) : i + 2] ?? 0;
    link(a, b); link(b, a);
    link(b, c); link(c, b);
    link(a, c); link(c, a);
  }

  const offsets = new Int32Array(count + 1);
  const list: number[] = [];
  for (let i = 0; i < count; i++) {
    offsets[i] = list.length;
    if (weld[i] === i) {
      for (const n of sets.get(i) ?? []) list.push(n);
    }
  }
  offsets[count] = list.length;
  return { weld, offsets, neighbours: Int32Array.from(list) };
}

/** Uniform Laplacian smoothing of a per-vertex vec3 field over welded vertices. */
export function laplacianSmooth(
  field: Float32Array,
  adjacency: WeldedAdjacency,
  iterations: number,
  amount: number,
): Float32Array {
  let current = new Float32Array(field);
  const { weld, offsets, neighbours } = adjacency;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const next = new Float32Array(current.length);
    for (let i = 0; i < weld.length; i++) {
      if (weld[i] !== i) continue;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      const start = offsets[i] ?? 0;
      const end = offsets[i + 1] ?? 0;
      for (let k = start; k < end; k++) {
        const n = neighbours[k] ?? 0;
        sx += current[n * 3] ?? 0;
        sy += current[n * 3 + 1] ?? 0;
        sz += current[n * 3 + 2] ?? 0;
      }
      const count = end - start;
      const cx = current[i * 3] ?? 0;
      const cy = current[i * 3 + 1] ?? 0;
      const cz = current[i * 3 + 2] ?? 0;
      if (count === 0) {
        next[i * 3] = cx;
        next[i * 3 + 1] = cy;
        next[i * 3 + 2] = cz;
        continue;
      }
      next[i * 3] = cx + (sx / count - cx) * amount;
      next[i * 3 + 1] = cy + (sy / count - cy) * amount;
      next[i * 3 + 2] = cz + (sz / count - cz) * amount;
    }
    for (let i = 0; i < weld.length; i++) {
      const w = weld[i] ?? i;
      if (w === i) continue;
      next[i * 3] = next[w * 3] ?? 0;
      next[i * 3 + 1] = next[w * 3 + 1] ?? 0;
      next[i * 3 + 2] = next[w * 3 + 2] ?? 0;
    }
    current = next;
  }
  return current;
}

/** Möller–Trumbore ray-triangle intersection: distance along `direction` to triangle `t`, or `-1`. */
export function rayTriangle(
  positions: Float32Array,
  triIndex: number,
  origin: Vector3,
  direction: Vector3,
  triangles?: Uint32Array,
): number {
  let ia: number;
  let ib: number;
  let ic: number;
  if (triangles) {
    ia = (triangles[triIndex * 3] ?? 0) * 3;
    ib = (triangles[triIndex * 3 + 1] ?? 0) * 3;
    ic = (triangles[triIndex * 3 + 2] ?? 0) * 3;
  } else {
    ia = triIndex * 9;
    ib = ia + 3;
    ic = ia + 6;
  }

  const ax = positions[ia] ?? 0;
  const ay = positions[ia + 1] ?? 0;
  const az = positions[ia + 2] ?? 0;
  const e1x = (positions[ib] ?? 0) - ax;
  const e1y = (positions[ib + 1] ?? 0) - ay;
  const e1z = (positions[ib + 2] ?? 0) - az;
  const e2x = (positions[ic] ?? 0) - ax;
  const e2y = (positions[ic + 1] ?? 0) - ay;
  const e2z = (positions[ic + 2] ?? 0) - az;

  const px = direction.y * e2z - direction.z * e2y;
  const py = direction.z * e2x - direction.x * e2z;
  const pz = direction.x * e2y - direction.y * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return -1;

  const inv = 1 / det;
  const tx = origin.x - ax;
  const ty = origin.y - ay;
  const tz = origin.z - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const w = (direction.x * qx + direction.y * qy + direction.z * qz) * inv;
  if (w < 0 || u + w > 1) return -1;

  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

/**
 * Appends or replaces a named relative position morph target on `mesh`, preserving all existing
 * morph target influences across `updateMorphTargets()`.
 */
export function upsertRelativeMorphTarget(
  mesh: Mesh,
  name: string,
  delta: Float32Array,
  influence: number,
): void {
  const position = mesh.geometry.getAttribute('position');
  if (!position) return;
  if (delta.length !== position.count * 3) {
    throw new Error(`Morph target "${name}" delta length (${delta.length}) does not match vertex count (${position.count * 3})`);
  }

  const existingTargets = mesh.geometry.morphAttributes['position'] ?? [];
  if (existingTargets.length === 0) {
    mesh.geometry.morphTargetsRelative = true;
  }

  // Convert delta to absolute coordinates only if the mesh already carries non-relative targets.
  let stored = delta;
  if (!mesh.geometry.morphTargetsRelative) {
    stored = new Float32Array(delta.length);
    for (let i = 0; i < position.count; i++) {
      stored[i * 3] = position.getX(i) + (delta[i * 3] ?? 0);
      stored[i * 3 + 1] = position.getY(i) + (delta[i * 3 + 1] ?? 0);
      stored[i * 3 + 2] = position.getZ(i) + (delta[i * 3 + 2] ?? 0);
    }
  }

  // Snapshot existing influences before updateMorphTargets() resets the array.
  const preserved = new Map<string, number>();
  const oldDict = mesh.morphTargetDictionary ?? {};
  const oldInfluences = mesh.morphTargetInfluences ?? [];
  for (const [targetName, idx] of Object.entries(oldDict)) {
    const val = oldInfluences[idx];
    if (val !== undefined) preserved.set(targetName, val);
  }

  const targets = [...existingTargets];
  const existingIdx = targets.findIndex((entry) => entry.name === name);
  const attribute = new Float32BufferAttribute(stored, 3);
  attribute.name = name;

  if (existingIdx >= 0) {
    targets[existingIdx] = attribute;
  } else {
    targets.push(attribute);
  }
  mesh.geometry.morphAttributes['position'] = targets;

  // Keep GLTF targetNames extras in sync if present so updateMorphTargets maps names cleanly.
  const userData = mesh.geometry.userData as { targetNames?: string[] };
  if (Array.isArray(userData.targetNames)) {
    const nextNames = [...userData.targetNames];
    if (existingIdx >= 0) nextNames[existingIdx] = name;
    else nextNames.push(name);
    userData.targetNames = nextNames;
  }

  mesh.updateMorphTargets();
  if (mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
    for (const [targetName, idx] of Object.entries(mesh.morphTargetDictionary)) {
      if (targetName === name) continue;
      const prev = preserved.get(targetName);
      if (prev !== undefined) mesh.morphTargetInfluences[idx] = prev;
    }
    const targetIdx = mesh.morphTargetDictionary[name];
    if (targetIdx !== undefined) {
      mesh.morphTargetInfluences[targetIdx] = influence;
    }
  }
}

export function setMorphTargetInfluence(mesh: Mesh, name: string, influence: number): boolean {
  const index = mesh.morphTargetDictionary?.[name];
  if (index === undefined || !mesh.morphTargetInfluences) return false;
  mesh.morphTargetInfluences[index] = influence;
  return true;
}

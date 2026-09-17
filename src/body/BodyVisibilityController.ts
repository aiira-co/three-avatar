import { BufferAttribute, SkinnedMesh } from 'three';
import type { BodyRegionDefinition, BodyRegionId } from '../format/types.js';
import { validateBodyRegions } from '../format/validation.js';

type IndexArray = Uint8Array | Uint16Array | Uint32Array;

function createIndexArray(source: IndexArray, length: number): IndexArray {
  if (source instanceof Uint32Array) return new Uint32Array(length);
  if (source instanceof Uint16Array) return new Uint16Array(length);
  return new Uint8Array(length);
}

export interface BodyVisibilitySnapshot {
  hiddenRegions: string[];
  visibleIndexCount: number;
  totalIndexCount: number;
}

/**
 * Removes covered body triangles from the rendered index buffer.
 *
 * The built index *arrays* are shared process-wide per (family, body asset,
 * coverage mask) because rebuilding them is the expensive part. The
 * `BufferAttribute` wrapping an array is always per-avatar: three keys GPU
 * buffers by attribute instance, so sharing one attribute across avatars would
 * let disposing one avatar drop a buffer another is still rendering with.
 */
export class BodyVisibilityController {
  private static readonly arrayCache = new Map<string, Map<string, IndexArray>>();

  private readonly originalIndex: BufferAttribute;
  private readonly regionById = new Map<BodyRegionId, BodyRegionDefinition>();
  private readonly hidden = new Set<BodyRegionId>();
  private readonly attributes = new Map<string, BufferAttribute>();

  constructor(
    readonly mesh: SkinnedMesh,
    regions: readonly BodyRegionDefinition[],
    private readonly cacheNamespace: string,
  ) {
    if (Array.isArray(mesh.material) && mesh.material.length > 1) {
      throw new Error('Avatar base bodies must use one material for region masking in runtime v1');
    }
    if (!mesh.geometry.index) throw new Error('Avatar base body geometry must be indexed');
    this.originalIndex = mesh.geometry.index.clone();
    validateBodyRegions([...regions], this.originalIndex.count);
    for (const region of regions) this.regionById.set(region.id, { ...region });
  }

  get hiddenRegions(): ReadonlySet<BodyRegionId> {
    return this.hidden;
  }

  listRegions(): BodyRegionId[] {
    return [...this.regionById.keys()];
  }

  setHiddenRegions(regions: Iterable<BodyRegionId>): BodyVisibilitySnapshot {
    const next = new Set(regions);
    for (const region of next) {
      if (!this.regionById.has(region)) throw new Error(`Unknown body region "${region}"`);
    }

    this.hidden.clear();
    for (const region of next) this.hidden.add(region);

    const key = [...this.hidden].sort().join('|');
    let attribute = this.attributes.get(key);
    if (!attribute) {
      attribute = new BufferAttribute(this.resolveArray(key), 1);
      this.attributes.set(key, attribute);
    }
    this.mesh.geometry.setIndex(attribute);

    return this.snapshot();
  }

  showAll(): BodyVisibilitySnapshot {
    return this.setHiddenRegions([]);
  }

  snapshot(): BodyVisibilitySnapshot {
    return {
      hiddenRegions: [...this.hidden].sort(),
      visibleIndexCount: this.mesh.geometry.index?.count ?? 0,
      totalIndexCount: this.originalIndex.count,
    };
  }

  /** Releases this avatar's index attributes. Shared arrays stay cached. */
  dispose(): void {
    this.attributes.clear();
  }

  /**
   * Drops cached index arrays. Call with a namespace when an asset version is
   * replaced, or with no argument to release everything (long-running
   * customizer sessions that page through many families).
   */
  static clearCache(namespace?: string): void {
    if (namespace === undefined) BodyVisibilityController.arrayCache.clear();
    else BodyVisibilityController.arrayCache.delete(namespace);
  }

  static cacheSize(): number {
    let total = 0;
    for (const entries of BodyVisibilityController.arrayCache.values()) total += entries.size;
    return total;
  }

  private resolveArray(key: string): IndexArray {
    let namespaceCache = BodyVisibilityController.arrayCache.get(this.cacheNamespace);
    if (!namespaceCache) {
      namespaceCache = new Map<string, IndexArray>();
      BodyVisibilityController.arrayCache.set(this.cacheNamespace, namespaceCache);
    }
    let array = namespaceCache.get(key);
    if (!array) {
      array = this.buildIndexArray();
      namespaceCache.set(key, array);
    }
    return array;
  }

  private buildIndexArray(): IndexArray {
    const source = this.originalIndex.array as IndexArray;
    const visibleRegions = [...this.regionById.values()].filter((region) => !this.hidden.has(region.id));
    const count = visibleRegions.reduce((sum, region) => sum + region.indexCount, 0);
    const result = createIndexArray(source, count);
    let cursor = 0;
    for (const region of visibleRegions) {
      result.set(source.subarray(region.indexOffset, region.indexOffset + region.indexCount), cursor);
      cursor += region.indexCount;
    }
    return result;
  }
}

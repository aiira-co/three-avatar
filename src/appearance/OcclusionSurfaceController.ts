import type { Object3D } from 'three';
import type { OcclusionSurfaceId } from '../format/types.js';

/**
 * Hides render surfaces covered by equipment.
 *
 * Visibility is aggregated per object: an object is hidden when *any* surface
 * that owns it is hidden. The controller only ever restores visibility it took
 * away itself, so host-owned visibility (first-person culling, editor isolation)
 * survives equipment changes.
 */
export class OcclusionSurfaceController {
  private readonly objectsBySurface = new Map<OcclusionSurfaceId, Object3D[]>();
  private readonly surfacesByObject = new Map<Object3D, Set<OcclusionSurfaceId>>();
  private readonly hidden = new Set<OcclusionSurfaceId>();
  private readonly restoreVisibility = new Map<Object3D, boolean>();

  constructor(root: Object3D, definitions: Record<OcclusionSurfaceId, string[]>) {
    const objectsByName = new Map<string, Object3D[]>();
    root.traverse((object) => {
      if (!object.name) return;
      const entries = objectsByName.get(object.name) ?? [];
      entries.push(object);
      objectsByName.set(object.name, entries);
    });

    for (const [surface, names] of Object.entries(definitions)) {
      const objects = [...new Set(names.flatMap((name) => objectsByName.get(name) ?? []))];
      if (objects.length === 0) throw new Error(`Occlusion surface "${surface}" did not match any avatar nodes`);
      this.objectsBySurface.set(surface, objects);
      for (const object of objects) {
        const owners = this.surfacesByObject.get(object) ?? new Set<OcclusionSurfaceId>();
        owners.add(surface);
        this.surfacesByObject.set(object, owners);
      }
    }
  }

  setHiddenSurfaces(surfaces: Iterable<OcclusionSurfaceId>): void {
    const next = new Set(surfaces);
    for (const surface of next) {
      if (!this.objectsBySurface.has(surface)) throw new Error(`Unknown occlusion surface "${surface}"`);
    }

    this.hidden.clear();
    for (const surface of next) this.hidden.add(surface);

    for (const [object, owners] of this.surfacesByObject) {
      const shouldHide = [...owners].some((surface) => this.hidden.has(surface));
      if (shouldHide) {
        if (!this.restoreVisibility.has(object)) {
          this.restoreVisibility.set(object, object.visible);
          object.visible = false;
        }
      } else if (this.restoreVisibility.has(object)) {
        object.visible = this.restoreVisibility.get(object)!;
        this.restoreVisibility.delete(object);
      }
    }
  }

  get hiddenSurfaces(): ReadonlySet<OcclusionSurfaceId> {
    return this.hidden;
  }

  isHidden(surface: OcclusionSurfaceId): boolean {
    return this.hidden.has(surface);
  }

  /** Restores every object this controller hid and forgets all surfaces. */
  dispose(): void {
    for (const [object, visible] of this.restoreVisibility) object.visible = visible;
    this.restoreVisibility.clear();
    this.hidden.clear();
  }
}

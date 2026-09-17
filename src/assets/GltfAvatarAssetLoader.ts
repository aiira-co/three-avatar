import { LoadingManager, Material, Mesh, Object3D } from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import type { VersionedId } from '../format/types.js';
import { versionedKey } from '../format/validation.js';
import type { AvatarAssetRegistry } from '../registry/AvatarAssetRegistry.js';
import type { AvatarAssetLoader, LoadedAvatarAsset } from './AvatarAssetLoader.js';

function cloneMaterial(material: Material | Material[]): Material | Material[] {
  return Array.isArray(material) ? material.map((entry) => entry.clone()) : material.clone();
}

function disposeOwned(root: Object3D): void {
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) material.dispose();
  });
}

export class GltfAvatarAssetLoader implements AvatarAssetLoader {
  private readonly loader: GLTFLoader;
  private readonly cache = new Map<string, Promise<GLTF>>();

  constructor(
    private readonly registry: AvatarAssetRegistry,
    manager?: LoadingManager,
  ) {
    this.loader = new GLTFLoader(manager);
  }

  async load(ref: VersionedId, signal?: AbortSignal): Promise<LoadedAvatarAsset> {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const definition = this.registry.requireAsset(ref);
    const key = versionedKey(ref);
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.loader.loadAsync(definition.uri);
      this.cache.set(key, pending);
      pending.catch(() => this.cache.delete(key));
    }

    const gltf = await pending;
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');

    const root = cloneSkeleton(gltf.scene);
    root.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry = mesh.geometry.clone();
      mesh.material = cloneMaterial(mesh.material);
    });

    return { root, dispose: () => disposeOwned(root) };
  }

  clearCache(): void {
    this.cache.clear();
  }
}

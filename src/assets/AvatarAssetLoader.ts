import type { Object3D } from 'three';
import type { VersionedId } from '../format/types.js';

export interface LoadedAvatarAsset {
  root: Object3D;
  dispose?: () => void;
}

export interface AvatarAssetLoader {
  load(ref: VersionedId, signal?: AbortSignal): Promise<LoadedAvatarAsset>;
}

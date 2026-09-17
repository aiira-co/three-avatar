import { Matrix4, SkinnedMesh } from 'three';
import type { AvatarRig } from '../rig/AvatarRig.js';

const MATRIX_EPSILON = 1e-4;

function matricesEqual(left: Matrix4, right: Matrix4): boolean {
  return left.elements.every((value, index) => Math.abs(value - right.elements[index]!) <= MATRIX_EPSILON);
}

export function rebindSkinnedMesh(
  mesh: SkinnedMesh,
  rig: AvatarRig,
  targetBindMatrix: Matrix4,
): void {
  const sourceSkeleton = mesh.skeleton;
  if (!sourceSkeleton) throw new Error(`Skinned mesh "${mesh.name}" has no skeleton`);
  if (!mesh.geometry.getAttribute('skinIndex') || !mesh.geometry.getAttribute('skinWeight')) {
    throw new Error(`Skinned mesh "${mesh.name}" is missing skinIndex or skinWeight attributes`);
  }
  if (!matricesEqual(mesh.bindMatrix, targetBindMatrix)) {
    throw new Error(`Skinned mesh "${mesh.name}" uses a bind matrix incompatible with the avatar body`);
  }

  const targetIndexByBone = new Map(rig.skeleton.bones.map((bone, index) => [bone, index]));
  const sourceToTarget: number[] = [];

  sourceSkeleton.bones.forEach((sourceBone, sourceIndex) => {
    const targetBone = rig.resolveBone(sourceBone.name);
    if (!targetBone) throw new Error(`Wearable bone "${sourceBone.name}" is not present in the avatar rig`);
    const targetIndex = targetIndexByBone.get(targetBone);
    if (targetIndex === undefined) throw new Error(`Wearable bone "${sourceBone.name}" is not part of the body skeleton`);
    const sourceInverse = sourceSkeleton.boneInverses[sourceIndex];
    const targetInverse = rig.skeleton.boneInverses[targetIndex];
    if (!sourceInverse || !targetInverse || !matricesEqual(sourceInverse, targetInverse)) {
      throw new Error(`Wearable bone "${sourceBone.name}" has an incompatible inverse bind matrix`);
    }
    sourceToTarget[sourceIndex] = targetIndex;
  });

  const skinIndex = mesh.geometry.getAttribute('skinIndex');
  for (let vertex = 0; vertex < skinIndex.count; vertex++) {
    for (let component = 0; component < skinIndex.itemSize; component++) {
      const sourceIndex = skinIndex.getComponent(vertex, component);
      const targetIndex = sourceToTarget[sourceIndex];
      if (targetIndex === undefined) {
        throw new Error(`Skinned mesh "${mesh.name}" references unmapped bone index ${sourceIndex}`);
      }
      skinIndex.setComponent(vertex, component, targetIndex);
    }
  }
  skinIndex.needsUpdate = true;

  mesh.bind(rig.skeleton, targetBindMatrix);
}

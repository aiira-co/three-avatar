import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Bone,
  Euler,
  Group,
  MathUtils,
  Quaternion,
  Skeleton,
  Vector3,
} from 'three';
import {
  AvatarRig,
  MIXAMO_HUMANOID_RIG_V1,
  PoseOffsetController,
  computeAutoPoseOffsets,
  mirrorBoneId,
  mirrorBoneOffset,
  normalizePoseOffsetState,
} from '../dist/index.js';

function createTestRig() {
  const root = new Group();
  const bones = {};
  const addBone = (name, parent, pos = [0, 0, 0]) => {
    const bone = new Bone();
    bone.name = name;
    bone.position.set(pos[0], pos[1], pos[2]);
    parent.add(bone);
    bones[name] = bone;
    return bone;
  };

  const hips = addBone('mixamorig:Hips', root, [0, 0.9, 0]);
  const spine = addBone('mixamorig:Spine', hips, [0, 0.1, 0]);
  const spine1 = addBone('mixamorig:Spine1', spine, [0, 0.12, 0]);
  const spine2 = addBone('mixamorig:Spine2', spine1, [0, 0.12, 0]);
  const neck = addBone('mixamorig:Neck', spine2, [0, 0.14, 0]);
  addBone('mixamorig:Head', neck, [0, 0.1, 0]);

  const lSh = addBone('mixamorig:LeftShoulder', spine2, [0.06, 0.1, 0]);
  const lArm = addBone('mixamorig:LeftArm', lSh, [0.1, 0, 0]);
  const lFore = addBone('mixamorig:LeftForeArm', lArm, [0, -0.25, 0]);
  addBone('mixamorig:LeftHand', lFore, [0, -0.22, 0]);

  const rSh = addBone('mixamorig:RightShoulder', spine2, [-0.06, 0.1, 0]);
  const rArm = addBone('mixamorig:RightArm', rSh, [-0.1, 0, 0]);
  const rFore = addBone('mixamorig:RightForeArm', rArm, [0, -0.25, 0]);
  addBone('mixamorig:RightHand', rFore, [0, -0.22, 0]);

  const lUp = addBone('mixamorig:LeftUpLeg', hips, [0.09, -0.05, 0]);
  const lLeg = addBone('mixamorig:LeftLeg', lUp, [0, -0.4, 0]);
  addBone('mixamorig:LeftFoot', lLeg, [0, -0.4, 0]);

  const rUp = addBone('mixamorig:RightUpLeg', hips, [-0.09, -0.05, 0]);
  const rLeg = addBone('mixamorig:RightLeg', rUp, [0, -0.4, 0]);
  addBone('mixamorig:RightFoot', rLeg, [0, -0.4, 0]);

  root.updateMatrixWorld(true);
  const skeleton = new Skeleton(Object.values(bones));
  const rig = new AvatarRig(root, skeleton, MIXAMO_HUMANOID_RIG_V1);
  return { root, rig, bones };
}

test('PoseOffsetController save/restore prevents drift on unkeyed bones', () => {
  const { rig, bones } = createTestRig();
  const controller = new PoseOffsetController(rig, { auto: false });
  controller.setGlobalOffset('arm.upper.left', [5, 0, 12], true);

  const initialLeft = bones['mixamorig:LeftArm'].quaternion.clone();
  const initialRight = bones['mixamorig:RightArm'].quaternion.clone();

  for (let i = 0; i < 50; i++) {
    controller.restore();
    controller.apply('idle');
  }
  controller.restore();

  assert.ok(bones['mixamorig:LeftArm'].quaternion.angleTo(initialLeft) < 1e-6);
  assert.ok(bones['mixamorig:RightArm'].quaternion.angleTo(initialRight) < 1e-6);
});

test('PoseOffsetController pre-multiplies in parent space so abduction stays outward across 90° arm pitch', () => {
  const { root, rig, bones } = createTestRig();
  const controller = new PoseOffsetController(rig, { auto: false, symmetric: false });
  // Positive Z rotation around parent (+Z) swings a downward -Y arm outward toward +X.
  controller.setGlobalOffset('arm.upper.left', [0, 0, 15], false);

  const lArm = bones['mixamorig:LeftArm'];
  const lFore = bones['mixamorig:LeftForeArm'];

  // Simulate an animation keyframe pitching the arm forward by -90° around X (arm points +Z).
  const swing = new Quaternion().setFromEuler(new Euler(MathUtils.degToRad(-90), 0, 0, 'XYZ'));
  lArm.quaternion.copy(swing);
  controller.apply('walk');
  root.updateMatrixWorld(true);

  const shoulderPos = lArm.getWorldPosition(new Vector3());
  const elbowPos = lFore.getWorldPosition(new Vector3());
  const armDir = elbowPos.sub(shoulderPos).normalize();

  // With parent-frame pre-multiply, Rz(+15°) rotates +Z vector to stay along Z/Y? Wait:
  // Arm points (0, -1, 0) rotated Rx(-90°) -> (0, 0, +1).
  // Wait: Rz(+15°) rotates (1,0,0)->(cos,sin,0), (0,1,0)->(-sin,cos,0), (0,0,1)->(0,0,1)!
  // Let's test Y-yaw abduction (turning arm outward around parent +Y when arm points +Z) OR check exact parent-space quaternion identity:
  // Specifically: after apply(), lArm.quaternion MUST equal offsetQuat * swing (NOT swing * offsetQuat).
  const expectedOffset = new Quaternion().setFromEuler(new Euler(0, 0, MathUtils.degToRad(15), 'XYZ'));
  const expectedParentPre = expectedOffset.clone().multiply(swing);
  assert.ok(lArm.quaternion.angleTo(expectedParentPre) < 1e-5);

  controller.restore();
  assert.ok(lArm.quaternion.angleTo(swing) < 1e-6);

  // Verify outward spread on a pitched arm using Y-yaw offset in parent space:
  controller.setGlobalOffset('arm.upper.left', [0, 15, 0], false);
  lArm.quaternion.copy(swing);
  controller.apply('walk');
  root.updateMatrixWorld(true);
  const elbowAfterYaw = lFore.getWorldPosition(new Vector3());
  const dirAfterYaw = elbowAfterYaw.sub(lArm.getWorldPosition(new Vector3())).normalize();
  // Around +Y, rotating (0, 0, 1) by +15° moves it cleanly outward toward +X without rolling X/Z!
  assert.ok(dirAfterYaw.x > 0.2, `expected outward +X spread across 90° swing, got ${dirAfterYaw.x}`);
});

test('PoseOffsetController enforces strict anatomical clamps and never moves hips/root', () => {
  const { rig } = createTestRig();
  const controller = new PoseOffsetController(rig, { auto: false, symmetric: false });
  controller.setGlobalOffset('arm.upper.left', [90, -90, 45], false);
  controller.setGlobalOffset('shoulder.left', [45, 0, 0], false);
  controller.setGlobalOffset('spine2', [30, 0, 0], false);
  controller.setGlobalOffset('hips', [20, 20, 20], false);
  controller.setGlobalOffset('root', [20, 20, 20], false);

  const effective = controller.getEffectiveOffsets();
  assert.deepEqual(effective['arm.upper.left'], [25, -25, 25]);
  assert.deepEqual(effective['shoulder.left'], [15, 0, 0]);
  assert.deepEqual(effective['spine2'], [10, 0, 0]);
  assert.equal(effective['hips'], undefined);
  assert.equal(effective['root'], undefined);

  const normalized = normalizePoseOffsetState({
    global: { hips: [10, 10, 10], 'arm.upper.left': [80, 0, 0] },
  });
  assert.deepEqual(normalized.global, { 'arm.upper.left': [25, 0, 0] });
});

test('PoseOffsetController supports L/R mirroring, per-clip precedence, and Tier-1 auto clearance', () => {
  assert.equal(mirrorBoneId('arm.upper.left'), 'arm.upper.right');
  assert.equal(mirrorBoneId('mixamorig:RightForeArm'), 'mixamorig:LeftForeArm');
  assert.equal(mirrorBoneId('spine2'), undefined);
  assert.deepEqual(mirrorBoneOffset([4, 6, -10]), [4, -6, 10]);

  const slimAuto = computeAutoPoseOffsets({ chestVolume: 0, hips: 0, outerBulk: 0 });
  assert.deepEqual(slimAuto, {});

  const bulkyAuto = computeAutoPoseOffsets({ chestVolume: 0.8, hips: 0.7, outerBulk: 0.9 });
  assert.ok(bulkyAuto['arm.upper.left'][2] > 5);
  assert.equal(bulkyAuto['arm.upper.right'][2], -bulkyAuto['arm.upper.left'][2]);
  assert.ok(bulkyAuto['leg.upper.left'][2] > 1);

  const { rig } = createTestRig();
  const controller = new PoseOffsetController(rig, { auto: false });
  controller.setGlobalOffset('arm.upper.left', [2, 0, 8], true);
  controller.setClipOffset('fold_arms', 'arm.upper.left', [0, 0, 18], true);

  const walk = controller.getEffectiveOffsets('walk');
  assert.deepEqual(walk['arm.upper.left'], [2, 0, 8]);
  assert.deepEqual(walk['arm.upper.right'], [2, 0, -8]);

  const fold = controller.getEffectiveOffsets('fold_arms');
  assert.deepEqual(fold['arm.upper.left'], [0, 0, 18]);
  assert.deepEqual(fold['arm.upper.right'], [0, 0, -18]);
});

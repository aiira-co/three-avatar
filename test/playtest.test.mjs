import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnimationClip,
  AnimationMixer,
  Bone,
  Group,
  QuaternionKeyframeTrack,
  Skeleton,
} from 'three';
import * as rootPackage from '../dist/index.js';
import { AvatarRig, MIXAMO_HUMANOID_RIG_V1, PoseOffsetController } from '../dist/index.js';
import { AvatarPlaytestController, ThirdPersonFollowCamera } from '../dist/playtest/index.js';
import { PerspectiveCamera, Vector3 } from 'three';

function createPlaytestFixture() {
  const root = new Group();
  const bones = [];
  const names = [
    'mixamorigHips', 'mixamorigSpine', 'mixamorigSpine1', 'mixamorigSpine2', 'mixamorigNeck', 'mixamorigHead',
    'mixamorigLeftShoulder', 'mixamorigLeftArm', 'mixamorigLeftForeArm', 'mixamorigLeftHand',
    'mixamorigRightShoulder', 'mixamorigRightArm', 'mixamorigRightForeArm', 'mixamorigRightHand',
    'mixamorigLeftUpLeg', 'mixamorigLeftLeg', 'mixamorigLeftFoot',
    'mixamorigRightUpLeg', 'mixamorigRightLeg', 'mixamorigRightFoot',
  ];
  for (const name of names) {
    const bone = new Bone();
    bone.name = name;
    bones.push(bone);
  }
  bones[0].add(bones[1]);
  bones[1].add(bones[2]);
  bones[2].add(bones[3]);
  bones[3].add(bones[4]);
  bones[4].add(bones[5]);
  bones[3].add(bones[6], bones[10]);
  bones[6].add(bones[7]); bones[7].add(bones[8]); bones[8].add(bones[9]);
  bones[10].add(bones[11]); bones[11].add(bones[12]); bones[12].add(bones[13]);
  bones[0].add(bones[14], bones[17]);
  bones[14].add(bones[15]); bones[15].add(bones[16]);
  bones[17].add(bones[18]); bones[18].add(bones[19]);
  root.add(bones[0]);
  root.updateMatrixWorld(true);

  const skeleton = new Skeleton(bones);
  const rig = new AvatarRig(root, skeleton, MIXAMO_HUMANOID_RIG_V1);

  const makeClip = (name, duration = 1) =>
    new AnimationClip(name, duration, [
      new QuaternionKeyframeTrack('mixamorigLeftArm.quaternion', [0, duration], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);

  const clips = ['idle', 'walk', 'run', 'sprint', 'crouch_idle', 'crouch_walk', 'jump', 'fall', 'land', 'wave']
    .map((name) => makeClip(name, name === 'wave' ? 0.4 : 1));
  const mixer = new AnimationMixer(root);
  const poseOffsets = new PoseOffsetController(rig, { auto: false });
  poseOffsets.setGlobalOffset('arm.upper.left', [0, 0, 10], false);

  return { root, mixer, clips, rig, poseOffsets, leftArm: bones[7] };
}

test('AvatarPlaytestController steps idle -> walk -> run -> sprint and crouch speeds', () => {
  const { root, mixer, clips, poseOffsets } = createPlaytestFixture();
  const playtest = new AvatarPlaytestController({ root, mixer, clips, poseOffsets });

  assert.equal(playtest.update(0.016), 'idle');

  playtest.setInput({ forward: 0.4, right: 0 });
  for (let i = 0; i < 30; i++) playtest.update(0.03);
  assert.equal(playtest.currentState, 'walk');
  assert.ok(playtest.velocity.z > 0.5 && playtest.velocity.z <= playtest.config.walkSpeed + 0.05);

  playtest.setInput({ forward: 1, right: 0, sprint: false });
  for (let i = 0; i < 30; i++) playtest.update(0.03);
  assert.equal(playtest.currentState, 'run');
  assert.ok(playtest.velocity.z > playtest.config.walkSpeed + 0.5);

  playtest.setInput({ forward: 1, right: 0, sprint: true });
  for (let i = 0; i < 30; i++) playtest.update(0.03);
  assert.equal(playtest.currentState, 'sprint');
  assert.ok(playtest.velocity.z > playtest.config.runSpeed + 0.5);

  playtest.setInput({ forward: 1, right: 0, sprint: false, crouch: true });
  for (let i = 0; i < 40; i++) playtest.update(0.03);
  assert.equal(playtest.currentState, 'crouch_walk');
  assert.ok(Math.hypot(playtest.velocity.x, playtest.velocity.z) <= playtest.config.crouchSpeed + 0.05);
});

test('AvatarPlaytestController runs jump -> fall -> land -> idle kinematic arc and yaw convergence', () => {
  const { root, mixer, clips, poseOffsets } = createPlaytestFixture();
  const playtest = new AvatarPlaytestController({ root, mixer, clips, poseOffsets });

  // Move right (-X when cameraYaw=0) and verify yaw turns toward -PI/2.
  playtest.setInput({ forward: 0, right: 1, cameraYaw: 0 });
  for (let i = 0; i < 30; i++) playtest.update(0.03);
  assert.ok(Math.abs(playtest.facingYaw - -Math.PI / 2) < 0.1);

  // Stop and trigger jump.
  playtest.setInput({ forward: 0, right: 0, jump: true });
  assert.equal(playtest.update(0.02), 'jump');
  assert.equal(playtest.isGrounded, false);
  playtest.setInput({ jump: false });

  let sawFall = false;
  let sawLand = false;
  for (let i = 0; i < 60; i++) {
    const state = playtest.update(0.025);
    if (state === 'fall') sawFall = true;
    if (state === 'land') sawLand = true;
  }
  assert.equal(sawFall, true);
  assert.equal(sawLand, true);
  assert.equal(playtest.isGrounded, true);
  assert.equal(playtest.currentState, 'idle');
});

test('AvatarPlaytestController handles emote interruption and PoseOffsetController restore/apply hooks', () => {
  const { root, mixer, clips, poseOffsets, leftArm } = createPlaytestFixture();
  const playtest = new AvatarPlaytestController({ root, mixer, clips, poseOffsets });

  assert.equal(playtest.triggerEmote('wave'), true);
  assert.equal(playtest.currentState, 'emote');
  assert.equal(playtest.currentClipName, 'wave');

  // Verify pose offset is applied after update without drifting across ticks.
  playtest.update(0.02);
  const firstQuat = leftArm.quaternion.clone();
  playtest.update(0.02);
  assert.ok(leftArm.quaternion.angleTo(firstQuat) < 1e-5);
  assert.ok(firstQuat.z > 0.05, 'PoseOffsetController applied +10deg Z offset');

  // Movement input interrupts active emote immediately.
  playtest.setInput({ forward: 1, right: 0 });
  const nextState = playtest.update(0.02);
  assert.notEqual(nextState, 'emote');

  // ThirdPersonFollowCamera tracks target smoothly.
  const cam = new PerspectiveCamera(45, 1, 0.1, 50);
  const follow = new ThirdPersonFollowCamera();
  follow.orbit(0.4, 0.1);
  follow.zoom(-0.5);
  follow.update(new Vector3(2, 0, 3), 0.05, cam);
  assert.ok(cam.position.distanceTo(new Vector3(2, 1.25, 3)) > 1.5);
  assert.equal('AvatarPlaytestController' in rootPackage, false);
});

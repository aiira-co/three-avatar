import assert from 'node:assert/strict';
import test from 'node:test';
import { Bone, Euler, Group, Quaternion, Skeleton, Vector3 } from 'three';
import { AvatarRig } from '../dist/rig/AvatarRig.js';
import { MIXAMO_HUMANOID_RIG_V1 } from '../dist/format/constants.js';
import {
  ChannelMapOneEuroFilter,
  HAND_FINGER_BONE_ALIASES,
  HAND_FINGER_BONE_IDS,
  MocapClipRecorder,
  OneEuroFilter,
  QuaternionOneEuroFilter,
  buildAnimationClipFromFrames,
  calibratePoseBaseline,
  computeHeadCropRect,
  normalizeMediaPipeFaceBlendshapes,
  parseSavedMocapClip,
  quantizeMocapFrames,
  resolveHandFingerBone,
  sampleMocapFaceChannelsAt,
  solveHandLandmarksToRig,
  solvePoseLandmarksToRig,
  solveSingleHandLandmarksToRig,
} from '../dist/mocap/index.js';

function createPose33Landmarks(raisedLeftArm = false) {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.95 }));
  landmarks[0] = { x: 0.5, y: 0.2, z: -0.08, visibility: 0.98 }; // nose
  landmarks[7] = { x: 0.45, y: 0.19, z: 0, visibility: 0.95 }; // left ear
  landmarks[8] = { x: 0.55, y: 0.19, z: 0, visibility: 0.95 }; // right ear
  landmarks[11] = { x: 0.42, y: 0.32, z: 0, visibility: 0.98 }; // left shoulder
  landmarks[12] = { x: 0.58, y: 0.32, z: 0, visibility: 0.98 }; // right shoulder
  landmarks[13] = { x: 0.34, y: raisedLeftArm ? 0.18 : 0.44, z: 0, visibility: 0.95 };
  landmarks[14] = { x: 0.66, y: 0.44, z: 0, visibility: 0.95 };
  landmarks[15] = { x: 0.28, y: raisedLeftArm ? 0.08 : 0.55, z: -0.04, visibility: 0.95 };
  landmarks[16] = { x: 0.72, y: 0.55, z: -0.04, visibility: 0.95 };
  landmarks[23] = { x: 0.44, y: 0.58, z: 0, visibility: 0.95 }; // left hip
  landmarks[24] = { x: 0.56, y: 0.58, z: 0, visibility: 0.95 }; // right hip
  landmarks[25] = { x: 0.44, y: 0.76, z: 0, visibility: 0.95 }; // left knee
  landmarks[26] = { x: 0.56, y: 0.76, z: 0, visibility: 0.95 }; // right knee
  landmarks[27] = { x: 0.44, y: 0.93, z: 0, visibility: 0.95 }; // left ankle
  landmarks[28] = { x: 0.56, y: 0.93, z: 0, visibility: 0.95 }; // right ankle
  return landmarks;
}

test('OneEuroFilter reduces high-frequency jitter while remaining finite and responsive', () => {
  const filter = new OneEuroFilter({ minCutoff: 1.2, beta: 0.02 });
  const noisy = [];
  const filtered = [];
  for (let i = 0; i < 40; i++) {
    const val = (i % 2 === 0 ? 0.08 : -0.08);
    noisy.push(val);
    filtered.push(filter.filter(val, i * (1 / 30)));
  }
  const lateFiltered = filtered.slice(10);
  const maxAbs = Math.max(...lateFiltered.map((v) => Math.abs(v)));
  assert.ok(maxAbs < 0.06, `Expected smoothed amplitude < 0.06, got ${maxAbs}`);
});

test('QuaternionOneEuroFilter handles double-cover antipodal sign flips smoothly', () => {
  const qFilter = new QuaternionOneEuroFilter({ minCutoff: 1.5, beta: 0.03 });
  const q1 = new Quaternion().setFromEuler(new Euler(0.2, 0.4, 0));
  const q2 = new Quaternion(-q1.x, -q1.y, -q1.z, -q1.w); // exact same orientation, opposite sign
  const out1 = qFilter.filter(q1, 0);
  const out2 = qFilter.filter(q2, 1 / 30);
  assert.ok(out1.angleTo(out2) < 1e-3);
});

test('ChannelMapOneEuroFilter smooths scalar morph maps independently', () => {
  const bank = new ChannelMapOneEuroFilter({ minCutoff: 1.5, beta: 0.02 });
  const first = bank.filterMap({ jawOpen: 0.8 }, 0);
  const second = bank.filterMap({ jawOpen: 0.2 }, 0.033);
  assert.equal(first.jawOpen, 0.8);
  assert.ok(second.jawOpen < 0.8 && second.jawOpen > 0.2);
});

test('solvePoseLandmarksToRig solves upper-body and limb quaternions cleanly', () => {
  const restPose = createPose33Landmarks(false);
  const baseline = calibratePoseBaseline(restPose, true);
  assert.ok(baseline && baseline.shoulderSpan > 0.05);

  const raisedPose = createPose33Landmarks(true);
  const solved = solvePoseLandmarksToRig(raisedPose, { mirrored: true }, baseline);
  assert.ok(solved.confidence > 0.8);
  assert.ok(solved.boneRotations['spine']);
  assert.ok(solved.boneRotations['arm.upper.left']);
  assert.ok(solved.boneRotations['arm.lower.left']);
  assert.ok(solved.boneRotations['head']);

  for (const tuple of Object.values(solved.boneRotations)) {
    const len = Math.hypot(tuple[0], tuple[1], tuple[2], tuple[3]);
    assert.ok(Math.abs(len - 1) < 1e-3, `Quaternion not unit length: ${len}`);
  }
});

test('normalizeMediaPipeFaceBlendshapes mirrors Left/Right and clamps values', () => {
  const out = normalizeMediaPipeFaceBlendshapes(
    [
      { categoryName: 'eyeBlink_L', score: 0.9 },
      { categoryName: 'jawOpen', score: 0.6 },
      { categoryName: 'unknownChannel', score: 1.0 },
    ],
    { mirrored: true },
  );
  assert.equal(out.eyeBlinkRight, 0.9);
  assert.equal(out.eyeBlinkLeft, undefined);
  assert.equal(out.jawOpen, 0.6);
  assert.equal(out.unknownChannel, undefined);
});

test('MocapClipRecorder records at fixed interval and builds an AnimationClip with bone name mapping', () => {
  const recorder = new MocapClipRecorder({ fps: 30 });
  recorder.start();
  assert.equal(recorder.pushFrame(10.0, { 'arm.upper.left': [0, 0, 0, 1] }), true);
  assert.equal(recorder.pushFrame(10.005, { 'arm.upper.left': [0, 0, 0, 1] }), false); // throttled under 30fps
  const rot = new Quaternion().setFromEuler(new Euler(0, 0, 0.5));
  assert.equal(recorder.pushFrame(10.04, { 'arm.upper.left': [rot.x, rot.y, rot.z, rot.w] }), true);

  const frames = recorder.stop();
  assert.equal(frames.length, 2);

  const clip = recorder.toAnimationClip({
    name: 'WaveTest',
    boneNameMap: { 'arm.upper.left': 'mixamorigLeftArm' },
  });
  assert.equal(clip.name, 'WaveTest');
  assert.equal(clip.tracks.length, 1);
  assert.equal(clip.tracks[0].name, 'mixamorigLeftArm.quaternion');
  assert.equal(clip.tracks[0].times.length, 2);
});

test('quantizeMocapFrames, parseSavedMocapClip, buildAnimationClipFromFrames, and sampleMocapFaceChannelsAt round-trip cleanly', () => {
  const frames = quantizeMocapFrames([
    { time: 0.0, boneRotations: { spine: [0.00012, 0, 0, 1] }, faceChannels: { jawOpen: 0.1, tiny: 0.002 } },
    { time: 0.5, boneRotations: { spine: [0, 0.25, 0, 0.96824] }, faceChannels: { jawOpen: 0.7 } },
  ]);
  assert.equal(frames[0].faceChannels.tiny, undefined);

  const parsed = parseSavedMocapClip({
    version: 1,
    id: 'take-1',
    name: 'Wave Take',
    createdAt: 1000,
    updatedAt: 2000,
    duration: 0.5,
    fps: 30,
    frames,
  });
  assert.ok(parsed);
  assert.equal(parsed.name, 'Wave Take');
  assert.equal(parseSavedMocapClip({ version: 2 }), undefined);

  const built = buildAnimationClipFromFrames(parsed.frames, {
    name: 'mocap:take-1',
    boneNameMap: { spine: 'mixamorigSpine' },
  });
  assert.equal(built.name, 'mocap:take-1');
  assert.equal(built.tracks[0].name, 'mixamorigSpine.quaternion');

  const midFace = sampleMocapFaceChannelsAt(parsed.frames, 0.25, false);
  assert.ok(Math.abs(midFace.jawOpen - 0.4) < 0.01);
});

function createSyntheticHandLandmarks({
  handedness = 'Right',
  curl = 0,
  spread = 0,
  thumbCurl = 0,
} = {}) {
  // Hand held upright, palm facing camera (-z in MediaPipe image space => +z in solver space).
  // For MediaPipe 'Right' (mirrored -> avatar 'left'), thumb sits on smaller image x so mirrored x is +X.
  const thumbDirX = handedness === 'Right' ? -1 : 1;
  const lms = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const wrist = { x: 0.5, y: 0.8, z: 0 };
  lms[0] = wrist;

  const fingerSpecs = [
    { base: 5, offsetX: thumbDirX * 0.06, fanX: thumbDirX * 0.08 }, // index
    { base: 9, offsetX: thumbDirX * 0.02, fanX: 0 }, // middle
    { base: 13, offsetX: -thumbDirX * 0.02, fanX: -thumbDirX * 0.06 }, // ring
    { base: 17, offsetX: -thumbDirX * 0.06, fanX: -thumbDirX * 0.14 }, // pinky
  ];

  const len = 0.06;
  for (const spec of fingerSpecs) {
    const mcp = { x: wrist.x + spec.offsetX, y: wrist.y - 0.14, z: 0 };
    lms[spec.base] = mcp;
    const lateral = spec.fanX + (spec.base === 5 ? thumbDirX * spread : 0);
    const a1 = curl * 0.9;
    const a2 = a1 + curl * 1.0;
    const a3 = a2 + curl * 0.7;
    const step = (prev, angle, lat) => ({
      x: prev.x + lat * len * Math.cos(angle),
      y: prev.y - len * Math.cos(angle),
      z: prev.z - len * Math.sin(angle),
    });
    const pip = step(mcp, a1, lateral);
    const dip = step(pip, a2, lateral * 0.4);
    const tip = step(dip, a3, 0);
    lms[spec.base + 1] = pip;
    lms[spec.base + 2] = dip;
    lms[spec.base + 3] = tip;
  }

  // Thumb chain (1..4)
  const cmc = { x: wrist.x + thumbDirX * 0.05, y: wrist.y - 0.05, z: 0 };
  const t1Angle = thumbCurl * 0.7;
  const t2Angle = t1Angle + thumbCurl * 0.8;
  const t3Angle = t2Angle + thumbCurl * 0.8;
  const thumbMcp = {
    x: cmc.x + thumbDirX * 0.05 * Math.cos(t1Angle),
    y: cmc.y - 0.05 * Math.cos(t1Angle),
    z: cmc.z - 0.05 * Math.sin(t1Angle),
  };
  const thumbIp = {
    x: thumbMcp.x + thumbDirX * 0.045 * Math.cos(t2Angle),
    y: thumbMcp.y - 0.045 * Math.cos(t2Angle),
    z: thumbMcp.z - 0.045 * Math.sin(t2Angle),
  };
  const thumbTip = {
    x: thumbIp.x + thumbDirX * 0.04 * Math.cos(t3Angle),
    y: thumbIp.y - 0.04 * Math.cos(t3Angle),
    z: thumbIp.z - 0.04 * Math.sin(t3Angle),
  };
  lms[1] = cmc;
  lms[2] = thumbMcp;
  lms[3] = thumbIp;
  lms[4] = thumbTip;

  return lms;
}

test('solveHandLandmarksToRig solves open vs curled fingers with anatomical clamps and mirror support', () => {
  assert.equal(HAND_FINGER_BONE_IDS.length, 30);
  assert.ok(HAND_FINGER_BONE_ALIASES['hand.left.index.1'].includes('mixamorigLeftHandIndex1'));

  const openLms = createSyntheticHandLandmarks({ handedness: 'Right', curl: 0, thumbCurl: 0 });
  const openSolved = solveHandLandmarksToRig(
    [{ landmarks: openLms, handedness: 'Right', score: 0.95 }],
    { mirrored: true },
  );
  assert.deepEqual(openSolved.trackedHands, ['left']);
  assert.ok(openSolved.confidence > 0.9);
  const openIndex1 = openSolved.boneRotations['hand.left.index.1'];
  assert.ok(openIndex1);
  const openEuler = new Euler().setFromQuaternion(new Quaternion(...openIndex1), 'XYZ');
  assert.ok(Math.abs(openEuler.x) < 0.2, `Expected open index curl near 0, got ${openEuler.x}`);

  const fistLms = createSyntheticHandLandmarks({ handedness: 'Right', curl: 1.0, thumbCurl: 0.9 });
  const fistSolved = solveHandLandmarksToRig(
    [{ landmarks: fistLms, handedness: 'Right', score: 0.92 }],
    { mirrored: true },
  );
  const fistIndex1 = new Euler().setFromQuaternion(new Quaternion(...fistSolved.boneRotations['hand.left.index.1']), 'XYZ');
  const fistIndex2 = new Euler().setFromQuaternion(new Quaternion(...fistSolved.boneRotations['hand.left.index.2']), 'XYZ');
  const fistIndex3 = new Euler().setFromQuaternion(new Quaternion(...fistSolved.boneRotations['hand.left.index.3']), 'XYZ');
  const fistThumb2 = new Euler().setFromQuaternion(new Quaternion(...fistSolved.boneRotations['hand.left.thumb.2']), 'XYZ');
  assert.ok(fistIndex1.x > 0.5 && fistIndex1.x <= 1.48, `Expected positive clamped MCP curl, got ${fistIndex1.x}`);
  assert.ok(fistIndex2.x > 0.6 && fistIndex2.x <= 1.85, `Expected positive clamped PIP curl, got ${fistIndex2.x}`);
  assert.ok(fistIndex3.x > 0.3 && fistIndex3.x <= 1.35, `Expected positive clamped DIP curl, got ${fistIndex3.x}`);
  assert.ok(fistThumb2.x > 0.2 && fistThumb2.x <= 1.15, `Expected positive thumb MCP curl, got ${fistThumb2.x}`);

  // Unmirrored keeps MediaPipe 'Right' on avatar 'right'
  const unmirrored = solveSingleHandLandmarksToRig(fistLms, 'Right', { mirrored: false });
  assert.equal(unmirrored.side, 'right');
  assert.ok(unmirrored.boneRotations['hand.right.index.1']);
  assert.equal(unmirrored.boneRotations['hand.left.index.1'], undefined);

  // Extreme curl values remain unit quaternions within anatomical clamps
  const extremeLms = createSyntheticHandLandmarks({ handedness: 'Left', curl: 2.2, spread: 1.5, thumbCurl: 2.0 });
  const extremeSolved = solveHandLandmarksToRig(
    [{ landmarks: extremeLms, handedness: 'Left', score: 0.9 }],
    { mirrored: true },
  );
  assert.deepEqual(extremeSolved.trackedHands, ['right']);
  for (const tuple of Object.values(extremeSolved.boneRotations)) {
    const len = Math.hypot(tuple[0], tuple[1], tuple[2], tuple[3]);
    assert.ok(Math.abs(len - 1) < 1e-3, `Finger quaternion not unit length: ${len}`);
  }
});

test('resolveHandFingerBone resolves Mixamo finger aliases via AvatarRig.resolveBone', () => {
  const bones = [];
  for (const def of MIXAMO_HUMANOID_RIG_V1.bones) {
    if (!def.required) continue;
    const bone = new Bone();
    bone.name = def.aliases[0];
    bones.push(bone);
  }
  const indexBone = new Bone();
  indexBone.name = 'mixamorigLeftHandIndex1';
  const thumbBone = new Bone();
  thumbBone.name = 'mixamorig:RightHandThumb2';
  bones.push(indexBone, thumbBone);

  const root = new Group();
  const rig = new AvatarRig(root, new Skeleton(bones), MIXAMO_HUMANOID_RIG_V1);

  assert.equal(rig.getBone('hand.left.index.1'), undefined);
  assert.equal(resolveHandFingerBone(rig, 'hand.left.index.1'), indexBone);
  assert.equal(resolveHandFingerBone(rig, 'hand.right.thumb.2'), thumbBone);
  assert.equal(resolveHandFingerBone(rig, 'hand.left.pinky.3'), undefined);
});

/**
 * Helper building hip-centered metric 3D MediaPipe Pose `worldLandmarks` in meters:
 * +X right (viewer's right = subject's anatomical left when facing camera), +Y down, +Z away from camera.
 */
function createWorld33Landmarks({
  raiseLeftArm = false,
  bendLeftKnee = false,
  torsoLeanForward = false,
  headTurnLeft = false,
} = {}) {
  const w = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.95 }));
  const torsoZ = torsoLeanForward ? -0.18 : 0;
  // Head
  w[0] = { x: headTurnLeft ? 0.055 : 0, y: -0.66, z: torsoZ - 0.1, visibility: 0.98 }; // nose
  w[7] = { x: 0.08, y: -0.68, z: torsoZ, visibility: 0.95 }; // left ear (anatomical left)
  w[8] = { x: -0.08, y: -0.68, z: torsoZ, visibility: 0.95 }; // right ear (anatomical right)
  // Shoulders
  w[11] = { x: 0.18, y: -0.5, z: torsoZ, visibility: 0.98 }; // left shoulder
  w[12] = { x: -0.18, y: -0.5, z: torsoZ, visibility: 0.98 }; // right shoulder
  // Arms (T-pose rest by default; optionally raise anatomical left arm upward)
  w[13] = raiseLeftArm
    ? { x: 0.34, y: -0.72, z: torsoZ, visibility: 0.95 }
    : { x: 0.45, y: -0.5, z: torsoZ, visibility: 0.95 };
  w[15] = raiseLeftArm
    ? { x: 0.48, y: -0.92, z: torsoZ - 0.04, visibility: 0.95 }
    : { x: 0.7, y: -0.5, z: torsoZ, visibility: 0.95 };
  w[14] = { x: -0.45, y: -0.5, z: torsoZ, visibility: 0.95 };
  w[16] = { x: -0.7, y: -0.5, z: torsoZ, visibility: 0.95 };
  // Hips (centered at origin)
  w[23] = { x: 0.1, y: 0, z: 0, visibility: 0.95 }; // left hip
  w[24] = { x: -0.1, y: 0, z: 0, visibility: 0.95 }; // right hip
  // Legs (straight down by default; optionally lift left knee forward & bend shin back)
  w[25] = bendLeftKnee
    ? { x: 0.1, y: 0.32, z: -0.26, visibility: 0.95 }
    : { x: 0.1, y: 0.42, z: 0, visibility: 0.95 };
  w[27] = bendLeftKnee
    ? { x: 0.1, y: 0.68, z: 0.08, visibility: 0.95 }
    : { x: 0.1, y: 0.84, z: 0, visibility: 0.95 };
  w[26] = { x: -0.1, y: 0.42, z: 0, visibility: 0.95 };
  w[28] = { x: -0.1, y: 0.84, z: 0, visibility: 0.95 };
  return w;
}

/**
 * Matching normalized 2D+Z poseLandmarks (facing camera: anatomical left has x > 0.5, right has x < 0.5).
 */
function createCameraSpacePose33({
  raiseLeftArm = false,
  bendLeftKnee = false,
  torsoLeanForward = false,
  headTurnLeft = false,
} = {}) {
  const world = createWorld33Landmarks({ raiseLeftArm, bendLeftKnee, torsoLeanForward, headTurnLeft });
  // Map meters into centered [0..1] square space (1m -> 0.45 normalized units)
  const scale = 0.45;
  return world.map((lm) => ({
    x: 0.5 + lm.x * scale,
    y: 0.55 + lm.y * scale,
    z: lm.z * scale,
    visibility: lm.visibility,
  }));
}

test('solvePoseLandmarksToRig solves metric worldLandmarks with mirrored false/true consistency', () => {
  // Neutral T-pose in worldLandmarks -> near-identity arm/leg/spine rotations
  const tPoseNorm = createCameraSpacePose33();
  const tPoseWorld = createWorld33Landmarks();
  for (const mirrored of [false, true]) {
    const solvedRest = solvePoseLandmarksToRig(tPoseNorm, { mirrored, worldLandmarks: tPoseWorld });
    for (const boneId of ['spine', 'spine2', 'arm.upper.left', 'arm.upper.right', 'leg.upper.left', 'leg.upper.right']) {
      const q = new Quaternion(...solvedRest.boneRotations[boneId]);
      assert.ok(q.angleTo(new Quaternion()) < 0.05, `Expected near-identity ${boneId} (mirrored=${mirrored}), angle=${q.angleTo(new Quaternion())}`);
    }
  }

  // Raised anatomical left arm + bent left knee + torso forward lean + head turn left
  const actionOpts = {
    raiseLeftArm: true,
    bendLeftKnee: true,
    torsoLeanForward: true,
    headTurnLeft: true,
  };
  const actionNorm = createCameraSpacePose33(actionOpts);
  const actionWorld = createWorld33Landmarks(actionOpts);

  // Unmirrored (video mode): anatomical left arm -> avatar left arm (+X rotated upward to +Y)
  const solvedUnmirroredWorld = solvePoseLandmarksToRig(actionNorm, { mirrored: false, worldLandmarks: actionWorld });
  const solvedUnmirroredNorm = solvePoseLandmarksToRig(actionNorm, { mirrored: false });

  const leftArmDirWorld = new Vector3(1, 0, 0).applyQuaternion(new Quaternion(...solvedUnmirroredWorld.boneRotations['arm.upper.left']));
  const leftArmDirNorm = new Vector3(1, 0, 0).applyQuaternion(new Quaternion(...solvedUnmirroredNorm.boneRotations['arm.upper.left']));
  assert.ok(leftArmDirWorld.y > 0.5, `Expected raised left arm +Y (world), got ${leftArmDirWorld.y}`);
  assert.ok(leftArmDirNorm.y > 0.5, `Expected raised left arm +Y (norm), got ${leftArmDirNorm.y}`);
  assert.ok(leftArmDirWorld.distanceTo(leftArmDirNorm) < 0.05, 'World and normalized arm directions should align');

  const rightArmDirWorld = new Vector3(-1, 0, 0).applyQuaternion(new Quaternion(...solvedUnmirroredWorld.boneRotations['arm.upper.right']));
  assert.ok(Math.abs(rightArmDirWorld.y) < 0.05, 'Unraised right arm should remain horizontal');

  // Knee lift forward (+Z) and shin bend backward (-Z)
  const thighDirWorld = new Vector3(0, -1, 0).applyQuaternion(new Quaternion(...solvedUnmirroredWorld.boneRotations['leg.upper.left']));
  const thighDirNorm = new Vector3(0, -1, 0).applyQuaternion(new Quaternion(...solvedUnmirroredNorm.boneRotations['leg.upper.left']));
  assert.ok(thighDirWorld.z > 0.4, `Expected lifted left thigh +Z, got ${thighDirWorld.z}`);
  assert.ok(thighDirWorld.distanceTo(thighDirNorm) < 0.05, 'World and normalized thigh directions should align');

  const shinLocalWorld = new Vector3(0, -1, 0).applyQuaternion(new Quaternion(...solvedUnmirroredWorld.boneRotations['leg.lower.left']));
  assert.ok(shinLocalWorld.z < -0.4, `Expected bent knee shin -Z in parent space, got ${shinLocalWorld.z}`);

  // Torso forward lean -> positive X pitch on spine, matching normalized sign
  const spineWorldEuler = new Euler().setFromQuaternion(new Quaternion(...solvedUnmirroredWorld.boneRotations['spine']), 'YXZ');
  const spineNormEuler = new Euler().setFromQuaternion(new Quaternion(...solvedUnmirroredNorm.boneRotations['spine']), 'YXZ');
  assert.ok(spineWorldEuler.x > 0.08 && spineNormEuler.x > 0.08, `Expected positive forward spine pitch, got world=${spineWorldEuler.x}, norm=${spineNormEuler.x}`);

  // Head turn left -> positive Y yaw when unmirrored, negative Y yaw when mirrored
  const headUnmirrored = new Euler().setFromQuaternion(new Quaternion(...solvedUnmirroredWorld.boneRotations['head']), 'YXZ');
  const solvedMirroredWorld = solvePoseLandmarksToRig(actionNorm, { mirrored: true, worldLandmarks: actionWorld });
  const headMirrored = new Euler().setFromQuaternion(new Quaternion(...solvedMirroredWorld.boneRotations['head']), 'YXZ');
  assert.ok(headUnmirrored.y > 0.2, `Expected positive head yaw when unmirrored, got ${headUnmirrored.y}`);
  assert.ok(headMirrored.y < -0.2, `Expected negative head yaw when mirrored, got ${headMirrored.y}`);

  // Mirrored swaps anatomical left raised arm onto avatar right arm
  const mirroredRightArm = new Vector3(-1, 0, 0).applyQuaternion(new Quaternion(...solvedMirroredWorld.boneRotations['arm.upper.right']));
  const mirroredLeftArm = new Vector3(1, 0, 0).applyQuaternion(new Quaternion(...solvedMirroredWorld.boneRotations['arm.upper.left']));
  assert.ok(mirroredRightArm.y > 0.5, `Expected mirrored raised arm on avatar right, got ${mirroredRightArm.y}`);
  assert.ok(Math.abs(mirroredLeftArm.y) < 0.05, `Expected avatar left arm to stay horizontal when mirrored, got ${mirroredLeftArm.y}`);
});

test('solvePoseLandmarksToRig worldLandmarks visibility gating and short-array fallback', () => {
  const norm = createCameraSpacePose33({ raiseLeftArm: true });
  const world = createWorld33Landmarks({ raiseLeftArm: true });

  // Visibility from poseLandmarks gates worldLandmarks bones
  const occludedNorm = norm.map((lm, i) => (i === 13 || i === 15 ? { ...lm, visibility: 0.1 } : lm));
  const occludedSolved = solvePoseLandmarksToRig(occludedNorm, { mirrored: false, worldLandmarks: world });
  assert.equal(occludedSolved.boneRotations['arm.upper.left'], undefined);
  assert.equal(occludedSolved.boneRotations['arm.lower.left'], undefined);
  assert.ok(occludedSolved.boneRotations['arm.upper.right']);

  // Falls back to worldLandmarks[i].visibility ?? 1 when poseLandmarks omits visibility
  const noVisNorm = norm.map(({ x, y, z }) => ({ x, y, z }));
  const worldWithLowRightArm = world.map((lm, i) => (i === 14 ? { ...lm, visibility: 0.1 } : { x: lm.x, y: lm.y, z: lm.z }));
  const fallbackVisSolved = solvePoseLandmarksToRig(noVisNorm, { mirrored: false, worldLandmarks: worldWithLowRightArm });
  assert.ok(fallbackVisSolved.boneRotations['arm.upper.left']);
  assert.equal(fallbackVisSolved.boneRotations['arm.upper.right'], undefined);

  // Short/missing worldLandmarks falls back identically to normalized poseLandmarks
  const baselineNorm = solvePoseLandmarksToRig(norm, { mirrored: false });
  const shortWorld = solvePoseLandmarksToRig(norm, { mirrored: false, worldLandmarks: world.slice(0, 10) });
  assert.deepEqual(shortWorld, baselineNorm);
});

test('computeHeadCropRect handles wide shots, edge clamping, close-ups, and missing landmarks', () => {
  // Wide full-body 1280x720 shot: person occupies ~75% height, head ~11% height
  const wideLms = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.95 }));
  wideLms[0] = { x: 0.5, y: 0.18, z: -0.05, visibility: 0.98 }; // nose
  wideLms[7] = { x: 0.52, y: 0.175, z: 0, visibility: 0.95 }; // left ear
  wideLms[8] = { x: 0.48, y: 0.175, z: 0, visibility: 0.95 }; // right ear
  wideLms[11] = { x: 0.55, y: 0.27, z: 0, visibility: 0.98 }; // left shoulder
  wideLms[12] = { x: 0.45, y: 0.27, z: 0, visibility: 0.98 }; // right shoulder

  const rect = computeHeadCropRect(wideLms, 1280, 720);
  assert.ok(rect, 'Expected valid head crop rect for wide full-body shot');
  assert.equal(rect.sw, rect.sh, 'Crop rect must be square');
  assert.ok(rect.sx >= 0 && rect.sy >= 0, 'Origin must be >= 0');
  assert.ok(rect.sx + rect.sw <= 1280 && rect.sy + rect.sh <= 720, 'Rect must be clamped within frame');
  assert.ok(rect.sh / 720 < 0.42, `Expected sh/frameHeight < 0.42, got ${rect.sh / 720}`);
  // Nose pixel (640, 129.6) should lie inside the returned crop box
  assert.ok(rect.sx <= 640 && 640 <= rect.sx + rect.sw);
  assert.ok(rect.sy <= 130 && 130 <= rect.sy + rect.sh);

  // Corner clamping: head near top-left edge stays square and strictly inside bounds
  const cornerLms = wideLms.map((lm) => ({ ...lm, x: lm.x - 0.48, y: lm.y - 0.16 }));
  const cornerRect = computeHeadCropRect(cornerLms, 1280, 720);
  assert.ok(cornerRect);
  assert.equal(cornerRect.sw, cornerRect.sh);
  assert.equal(cornerRect.sx, 0);
  assert.equal(cornerRect.sy, 0);
  assert.ok(cornerRect.sx + cornerRect.sw <= 1280 && cornerRect.sy + cornerRect.sh <= 720);

  // Bottom-right corner clamping
  const brLms = wideLms.map((lm) => ({ ...lm, x: lm.x + 0.48, y: lm.y + 0.78 }));
  const brRect = computeHeadCropRect(brLms, 1280, 720);
  assert.ok(brRect);
  assert.equal(brRect.sw, brRect.sh);
  assert.ok(brRect.sx >= 0 && brRect.sy >= 0);
  assert.equal(brRect.sx + brRect.sw, 1280);
  assert.equal(brRect.sy + brRect.sh, 720);

  // Partial anchors (ears hidden, nose + shoulders visible) still produces a valid square crop
  const shouldersOnlyLms = wideLms.map((lm, i) => (i === 7 || i === 8 ? { ...lm, visibility: 0.05 } : lm));
  const shouldersOnlyRect = computeHeadCropRect(shouldersOnlyLms, 1280, 720);
  assert.ok(shouldersOnlyRect);
  assert.equal(shouldersOnlyRect.sw, shouldersOnlyRect.sh);

  // Close-up shot: face already large relative to frame height -> returns undefined
  const closeupLms = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.95 }));
  closeupLms[0] = { x: 0.5, y: 0.42, z: -0.1, visibility: 0.98 };
  closeupLms[7] = { x: 0.6, y: 0.41, z: 0, visibility: 0.95 };
  closeupLms[8] = { x: 0.4, y: 0.41, z: 0, visibility: 0.95 };
  closeupLms[11] = { x: 0.72, y: 0.78, z: 0, visibility: 0.98 };
  closeupLms[12] = { x: 0.28, y: 0.78, z: 0, visibility: 0.98 };
  assert.equal(computeHeadCropRect(closeupLms, 1280, 720), undefined);

  // Missing landmarks, low visibility, and invalid frame dimensions -> undefined
  assert.equal(computeHeadCropRect([], 1280, 720), undefined);
  const lowVisNose = wideLms.map((lm, i) => (i === 0 ? { ...lm, visibility: 0.1 } : lm));
  assert.equal(computeHeadCropRect(lowVisNose, 1280, 720), undefined);
  const noseOnly = wideLms.map((lm, i) => (i === 0 ? lm : { ...lm, visibility: 0.05 }));
  assert.equal(computeHeadCropRect(noseOnly, 1280, 720), undefined);
  assert.equal(computeHeadCropRect(wideLms, 0, 720), undefined);
  assert.equal(computeHeadCropRect(wideLms, 1280, -10), undefined);
});

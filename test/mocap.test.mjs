import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, Quaternion } from 'three';
import {
  ChannelMapOneEuroFilter,
  MocapClipRecorder,
  OneEuroFilter,
  QuaternionOneEuroFilter,
  buildAnimationClipFromFrames,
  calibratePoseBaseline,
  normalizeMediaPipeFaceBlendshapes,
  parseSavedMocapClip,
  quantizeMocapFrames,
  sampleMocapFaceChannelsAt,
  solvePoseLandmarksToRig,
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

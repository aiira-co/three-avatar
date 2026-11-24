import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
} from 'three';
import {
  ARKIT_CORE_EXPRESSION_CHANNELS,
  AvatarAssetRegistry,
  AvatarRuntime,
  AvatarSerializer,
  BUILTIN_EXPRESSION_PRESETS,
  BUILTIN_EXPRESSION_PRESET_MAP,
  EXPRESSION_MOOD_IDS,
  EXPRESSION_MOOD_METADATA_KEY,
  ExpressionController,
  MIXAMO_HUMANOID_RIG_V1,
  installProceduralExpressionTargets,
  normalizeMoodState,
  readMoodState,
  writeMoodState,
} from '../dist/index.js';
import { ExpressionController as SubpathExpressionController } from '../dist/expressions/index.js';

function createExpressionHeadMesh() {
  const landmarks = {
    eyeLeft: [0.03, 0.90, 0.06],
    eyeRight: [-0.03, 0.90, 0.06],
    eyeRadius: 0.014,
    browInner: [0.016, 0.925, 0.068],
    browOuter: [0.044, 0.925, 0.056],
    noseWing: [0.012, 0.87, 0.072],
    cheek: [0.035, 0.865, 0.062],
    mouthCenter: [0, 0.85, 0.068],
    mouthCorner: [0.017, 0.85, 0.062],
    chin: [0, 0.825, 0.06],
    neckSeamY: 0.785,
    blendHeight: 0.025,
  };

  const r = landmarks.eyeRadius;
  const verts = [
    // Neck seam & below-seam vertices (indices 0 and 1 MUST stay locked at 0 delta)
    0, 0.785, 0.04,
    0, 0.77, 0.04,
    // Eye L/R upper & lower lid rings (front qz = 0.3*r, r_dist ≈ 1.04*r)
    landmarks.eyeLeft[0], landmarks.eyeLeft[1] + r, landmarks.eyeLeft[2] + 0.3 * r,
    landmarks.eyeLeft[0], landmarks.eyeLeft[1] - r, landmarks.eyeLeft[2] + 0.3 * r,
    landmarks.eyeRight[0], landmarks.eyeRight[1] + r, landmarks.eyeRight[2] + 0.3 * r,
    landmarks.eyeRight[0], landmarks.eyeRight[1] - r, landmarks.eyeRight[2] + 0.3 * r,
    // Brows L/R
    landmarks.browInner[0], landmarks.browInner[1], landmarks.browInner[2],
    -landmarks.browInner[0], landmarks.browInner[1], landmarks.browInner[2],
    landmarks.browOuter[0], landmarks.browOuter[1], landmarks.browOuter[2],
    -landmarks.browOuter[0], landmarks.browOuter[1], landmarks.browOuter[2],
    // Nose wings L/R
    landmarks.noseWing[0], landmarks.noseWing[1], landmarks.noseWing[2],
    -landmarks.noseWing[0], landmarks.noseWing[1], landmarks.noseWing[2],
    // Cheeks L/R
    landmarks.cheek[0], landmarks.cheek[1], landmarks.cheek[2],
    -landmarks.cheek[0], landmarks.cheek[1], landmarks.cheek[2],
    // Mouth center & corners
    landmarks.mouthCenter[0], landmarks.mouthCenter[1], landmarks.mouthCenter[2],
    landmarks.mouthCorner[0], landmarks.mouthCorner[1], landmarks.mouthCorner[2],
    -landmarks.mouthCorner[0], landmarks.mouthCorner[1], landmarks.mouthCorner[2],
    // Chin
    landmarks.chin[0], landmarks.chin[1], landmarks.chin[2],
  ];

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(verts, 3));
  const mesh = new Mesh(geometry, new MeshBasicMaterial());
  return { mesh, landmarks };
}

test('expression presets cover all 14 mood ids with valid ARKit core channels', () => {
  assert.equal(EXPRESSION_MOOD_IDS.length, 14);
  assert.equal(BUILTIN_EXPRESSION_PRESETS.length, EXPRESSION_MOOD_IDS.length);
  assert.equal(ExpressionController, SubpathExpressionController);

  const allowedChannels = new Set(ARKIT_CORE_EXPRESSION_CHANNELS);
  for (const id of EXPRESSION_MOOD_IDS) {
    const preset = BUILTIN_EXPRESSION_PRESET_MAP.get(id);
    assert.ok(preset, `Missing builtin expression preset for "${id}"`);
    for (const [channel, weight] of Object.entries(preset.channels)) {
      assert.ok(allowedChannels.has(channel), `Unknown channel "${channel}" in preset "${id}"`);
      assert.ok(weight >= 0 && weight <= 1, `Weight out of [0,1] for ${id}.${channel}: ${weight}`);
    }
  }
});

test('ExpressionController blends moods, drives target meshes, handles reactions and signature cues', () => {
  const { mesh, landmarks } = createExpressionHeadMesh();
  const installed = installProceduralExpressionTargets(mesh, landmarks);
  assert.equal(installed.length, ARKIT_CORE_EXPRESSION_CHANNELS.length);

  const controller = new ExpressionController({ targets: [mesh] });

  // 1. Smooth mood transition to smile over 0.25s
  controller.setMood('smile', 1, 0.25);
  const early = controller.update(0.05);
  assert.ok(early.channels['mouthSmileLeft'] > 0 && early.channels['mouthSmileLeft'] < 0.68);

  let steady = early;
  for (let i = 0; i < 12; i++) steady = controller.update(0.05);
  assert.ok(Math.abs(steady.channels['mouthSmileLeft'] - 0.68) < 0.01);
  const smileIdx = mesh.morphTargetDictionary['mouthSmileLeft'];
  assert.ok(smileIdx !== undefined);
  assert.ok(Math.abs(mesh.morphTargetInfluences[smileIdx] - 0.68) < 0.01);

  // 2. One-shot reaction ('surprised') over active base mood ('smile')
  controller.triggerReaction('surprised', { intensity: 1, attack: 0.1, hold: 0.2, release: 0.2 });
  const peak = controller.update(0.15); // midway into hold (reactionWeight = 1)
  assert.equal(peak.activeReaction, 'surprised');
  assert.ok(peak.pupilScale < 1, `Expected constricted pupil on surprised, got ${peak.pupilScale}`);
  assert.ok(Math.abs(peak.pupilScale - 0.78) < 1e-4);
  assert.ok(Math.abs(peak.channels['jawOpen'] - 0.62) < 1e-4);

  // After total reaction duration (0.1 + 0.2 + 0.2 = 0.5s), returns to base 'smile'
  const recovered = controller.update(0.45); // elapsed = 0.60 >= 0.50
  assert.equal(recovered.activeReaction, undefined);
  assert.ok(Math.abs(recovered.channels['mouthSmileLeft'] - 0.68) < 0.01);
  assert.equal(recovered.channels['jawOpen'], undefined);

  // 3. Mood mix & clearMood
  controller.setMoodMix({ angry: 0.5, frustrated: 0.5 }, 0);
  const mixed = controller.update(0);
  assert.ok(mixed.channels['browDownLeft'] > 0);
  assert.ok(mixed.channels['noseSneerLeft'] > 0);

  controller.clearMood(0);
  const cleared = controller.update(0);
  assert.deepEqual(cleared.channels, {});
  assert.ok(Math.abs(mesh.morphTargetInfluences[smileIdx]) < 1e-6);

  // 4. Signature outputs: 'cry' tears overlay & 'bold' asymmetric smirk + head tilt
  controller.setMood('cry', 1, 0);
  const cryFrame = controller.update(0);
  const tears = cryFrame.overlays.find((o) => o.id === 'tears');
  assert.ok(tears && tears.weight > 0.9);

  controller.setMood('bold', 1, 0);
  const boldFrame = controller.update(0);
  assert.notEqual(boldFrame.channels['mouthSmileLeft'], boldFrame.channels['mouthSmileRight']);
  assert.ok(boldFrame.channels['mouthSmileRight'] > boldFrame.channels['mouthSmileLeft']);
  assert.ok(Math.hypot(...boldFrame.headTiltDeg) > 0);
});

test('mood state persists in AvatarStateV1.metadata without mutating body.morphs', async () => {
  const { mesh } = createExpressionHeadMesh();
  const root = new Group();
  const fullBones = MIXAMO_HUMANOID_RIG_V1.bones.filter((b) => b.required).map((b) => {
    const bone = new Bone();
    bone.name = b.aliases[0];
    return bone;
  });
  for (let i = 1; i < fullBones.length; i++) fullBones[0].add(fullBones[i]);
  root.add(fullBones[0]);

  const skinned = new SkinnedMesh(mesh.geometry.clone(), new MeshBasicMaterial());
  skinned.name = 'AvatarBody';
  const count = skinned.geometry.getAttribute('position').count;
  const skinIdx = new Uint16Array(count * 4);
  const skinWgt = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) skinWgt[i * 4] = 1;
  skinned.geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIdx, 4));
  skinned.geometry.setAttribute('skinWeight', new Uint16BufferAttribute([0], 1)); // overwritten below
  skinned.geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWgt, 4));
  skinned.geometry.setIndex(new Uint16BufferAttribute([0, 1, 2], 1));
  root.add(skinned);
  root.updateMatrixWorld(true);
  const skel = new Skeleton(fullBones);
  skel.calculateInverses();
  skinned.bind(skel, new Matrix4());

  const registry = new AvatarAssetRegistry();
  registry.install({
    id: 'test:pack/mood',
    version: '1.0.0',
    rigs: [MIXAMO_HUMANOID_RIG_V1],
    assets: [{ id: 'test:asset/body', version: '1.0.0', uri: 'mem://body', kind: 'body' }],
    families: [{
      id: 'test:family/mood',
      version: '1.0.0',
      rig: { id: MIXAMO_HUMANOID_RIG_V1.id, version: MIXAMO_HUMANOID_RIG_V1.version },
      body: {
        asset: { id: 'test:asset/body', version: '1.0.0' },
        meshNode: 'AvatarBody',
        regions: [{ id: 'head', indexOffset: 0, indexCount: 3 }],
      },
    }],
  });

  const runtime = new AvatarRuntime(registry, { async load() { return { root }; } });
  const avatar = await runtime.create({ family: { id: 'test:family/mood', version: '1.0.0' } });
  const initialMorphs = { ...avatar.serialize().body.morphs };

  writeMoodState(avatar, { mood: 'happy', intensity: 0.85 });
  const serializer = new AvatarSerializer();
  const saved = serializer.parse(serializer.stringify(avatar.serialize()));
  assert.deepEqual(saved.body.morphs, initialMorphs);
  assert.deepEqual(saved.metadata?.[EXPRESSION_MOOD_METADATA_KEY], { mood: 'happy', intensity: 0.85 });

  const restored = await runtime.fromJSON(saved);
  assert.deepEqual(readMoodState(restored), { mood: 'happy', intensity: 0.85 });

  assert.equal(normalizeMoodState({ mood: 'neutral', intensity: 0.5 }), undefined);
  writeMoodState(restored, { mood: 'neutral' });
  assert.equal(restored.serialize().metadata?.[EXPRESSION_MOOD_METADATA_KEY], undefined);
  assert.deepEqual(readMoodState(restored), { mood: 'neutral', intensity: 1 });
});

test('installProceduralExpressionTargets locks neck seam and skips existing Blender targets unless overwrite=true', () => {
  const { mesh, landmarks } = createExpressionHeadMesh();

  // Pre-seed a custom Blender-authored smile target on vertex 14 (mouthCenter)
  const vCount = mesh.geometry.getAttribute('position').count;
  const authoredDelta = new Float32Array(vCount * 3);
  authoredDelta[14 * 3 + 1] = 0.042;
  const authoredAttr = new Float32BufferAttribute(authoredDelta, 3);
  authoredAttr.name = 'mouthSmileLeft';
  mesh.geometry.morphTargetsRelative = true;
  mesh.geometry.morphAttributes.position = [authoredAttr];
  mesh.updateMorphTargets();

  const installed = installProceduralExpressionTargets(mesh, landmarks);
  assert.equal(installed.length, ARKIT_CORE_EXPRESSION_CHANNELS.length - 1);
  assert.ok(!installed.includes('mouthSmileLeft'));

  // Authored target stays intact
  const smileTarget = mesh.geometry.morphAttributes.position[mesh.morphTargetDictionary['mouthSmileLeft']];
  assert.ok(Math.abs(smileTarget.getY(14) - 0.042) < 1e-6);

  // Every generated expression morph target has exact 0 delta at neck vertices 0 (y=0.785) and 1 (y=0.770)
  for (const attr of mesh.geometry.morphAttributes.position) {
    for (const neckIdx of [0, 1]) {
      assert.equal(attr.getX(neckIdx), 0, `${attr.name} moved neck vertex ${neckIdx} X`);
      assert.equal(attr.getY(neckIdx), 0, `${attr.name} moved neck vertex ${neckIdx} Y`);
      assert.equal(attr.getZ(neckIdx), 0, `${attr.name} moved neck vertex ${neckIdx} Z`);
    }
  }

  // overwrite: true regenerates even pre-existing targets
  const overwritten = installProceduralExpressionTargets(mesh, landmarks, {
    overwrite: true,
    channels: ['mouthSmileLeft'],
  });
  assert.deepEqual(overwritten, ['mouthSmileLeft']);
});

test('procedural eyelid, brow, and mouth press morphs displace in anatomically correct directions', () => {
  const { mesh, landmarks } = createExpressionHeadMesh();
  installProceduralExpressionTargets(mesh, landmarks);

  const deltaY = (channel, vertexIndex) => {
    const idx = mesh.morphTargetDictionary[channel];
    assert.ok(idx !== undefined, `Missing channel ${channel}`);
    return mesh.geometry.morphAttributes.position[idx].getY(vertexIndex);
  };
  const deltaX = (channel, vertexIndex) => {
    const idx = mesh.morphTargetDictionary[channel];
    assert.ok(idx !== undefined, `Missing channel ${channel}`);
    return mesh.geometry.morphAttributes.position[idx].getX(vertexIndex);
  };

  // Vertex 2 = upper left lid (+r), Vertex 3 = lower left lid (-r)
  assert.ok(deltaY('eyeWideLeft', 2) > 0, 'eyeWideLeft should raise upper left lid');
  assert.ok(deltaY('eyeBlinkLeft', 2) < 0, 'eyeBlinkLeft should lower upper left lid');
  assert.ok(deltaY('eyeSquintLeft', 3) > 0, 'eyeSquintLeft should raise lower left lid');
  assert.ok(deltaY('eyeSquintLeft', 2) < 0, 'eyeSquintLeft should narrow upper left lid downward');

  // Vertex 6 = inner left brow, Vertex 8 = outer left brow
  const innerBrowDownY = deltaY('browDownLeft', 6);
  const outerBrowDownY = deltaY('browDownLeft', 8);
  assert.ok(innerBrowDownY < outerBrowDownY && outerBrowDownY < 0, 'browDownLeft should angle inner brow deeper than outer');
  assert.ok(deltaX('browDownLeft', 6) < 0, 'browDownLeft should pull left inner brow inward');

  // Vertex 14 = mouthCenter must stay continuous at dy = 0 under mouthPressLeft (within float32 precision)
  assert.ok(Math.abs(deltaY('mouthPressLeft', 14)) < 1e-6);
});

test('ExpressionController snaps clearing and settling transitions without residual channel drift', () => {
  const { mesh, landmarks } = createExpressionHeadMesh();
  installProceduralExpressionTargets(mesh, landmarks);
  const controller = new ExpressionController({ targets: [mesh] });

  controller.setMood('happy', 1, 0.25);
  controller.snapTransitions();
  const snappedHappy = controller.update(0);
  assert.ok(Math.abs(snappedHappy.channels['mouthSmileLeft'] - 0.9) < 1e-6);

  controller.clearMood(0.25);
  for (let i = 0; i < 9; i++) controller.update(0.05); // 0.45s
  const cleared = controller.update(0);
  assert.deepEqual(cleared.channels, {});
});

test('sheared-ellipsoid eyeBlinkLeft lowers outer upper lid cleanly even when raw qz < 0', () => {
  const { landmarks } = createExpressionHeadMesh();
  const eyeLeft = [0.0332, 0.8925, 0.0445];
  const radii = [0.0178, 0.0182, 0.0128];
  const shearZ = -0.01;
  // Outer upper-lid point with negative raw qz (0.041 - 0.0445 = -0.0035 < 0)
  const vx = 0.049;
  const vy = 0.903;
  const vz = 0.041;
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute([vx, vy, vz], 3));
  const mesh = new Mesh(geo, new MeshBasicMaterial());

  installProceduralExpressionTargets(
    mesh,
    {
      ...landmarks,
      eyeLeft,
      eyeRight: [-eyeLeft[0], eyeLeft[1], eyeLeft[2]],
      eyeRadius: radii[1],
      eyeRadii: radii,
      eyeShearZ: shearZ,
      eyeShearY: 0,
      eyeBackDepthScale: 1.3,
    },
    { channels: ['eyeBlinkLeft'] },
  );

  const idx = mesh.morphTargetDictionary.eyeBlinkLeft;
  assert.ok(idx !== undefined);
  const attr = mesh.geometry.morphAttributes.position[idx];
  const dx = attr.getX(0);
  const dy = attr.getY(0);
  const dz = attr.getZ(0);
  assert.ok(dy < -0.001, `expected outer upper lid to lower under eyeBlinkLeft, got dy=${dy}`);

  const shearedR = (x, y, z) => {
    const nx = (x - eyeLeft[0]) / radii[0];
    const ny = (y - eyeLeft[1]) / radii[1];
    const qz = (z - eyeLeft[2]) - nx * shearZ;
    const nz = qz / (qz >= 0 ? radii[2] : radii[2] * 1.3);
    return Math.hypot(nx, ny, nz);
  };
  assert.ok(shearedR(vx + dx, vy + dy, vz + dz) >= shearedR(vx, vy, vz) - 1e-4);
});

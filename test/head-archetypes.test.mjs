import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Matrix4,
  MeshBasicMaterial,
  Skeleton,
  SkinnedMesh,
} from 'three';
import {
  AvatarAssetRegistry,
  AvatarRuntime,
  AvatarSerializer,
  MIXAMO_HUMANOID_RIG_V1,
  applyHeadArchetypes,
  computeNeckLockMask,
  interpolateHeadLandmarks,
  normalizeHeadArchetypeState,
  parseHeadArchetypePack,
  readHeadArchetypeState,
  writeHeadArchetypeState,
} from '../dist/index.js';
import { BUILTIN_HEAD_ARCHETYPE_CATALOG } from '../dist/head-archetypes/index.js';

function createHeadMesh({ prebaked = false } = {}) {
  const neckBone = new Bone();
  neckBone.name = 'mixamorig:Hips';
  const skeleton = new Skeleton([neckBone]);

  // 4 vertices:
  // v0: at neck seam (y=0.785) -> MUST remain at 0 delta
  // v1: below neck seam (y=0.770) -> MUST remain at 0 delta
  // v2: nose tip (y=0.870)
  // v3: jaw/chin (y=0.825)
  const positions = [
    0, 0.785, 0.04,
    0, 0.77, 0.04,
    0, 0.87, 0.07,
    0, 0.825, 0.06,
  ];
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));

  if (prebaked) {
    geometry.morphTargetsRelative = true;
    const blackAttr = new Float32BufferAttribute([
      0, 0, 0,
      0, 0, 0,
      0.004, 0, 0.002,
      0, -0.003, 0,
    ], 3);
    blackAttr.name = 'HeadArchetype_black';
    const mangaAttr = new Float32BufferAttribute([
      0, 0, 0,
      0, 0, 0,
      0, 0, -0.004,
      0, -0.006, 0.003,
    ], 3);
    mangaAttr.name = 'HeadArchetype_manga';
    geometry.morphAttributes.position = [blackAttr, mangaAttr];
    geometry.userData.targetNames = ['HeadArchetype_black', 'HeadArchetype_manga'];
  }

  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
  mesh.bind(skeleton, new Matrix4());
  return mesh;
}

test('computeNeckLockMask zeroes vertices at or below neckSeamY and ramps smoothly above', () => {
  const mesh = createHeadMesh();
  const mask = computeNeckLockMask(mesh.geometry, 0.785, 0.025);
  assert.equal(mask[0], 0);
  assert.equal(mask[1], 0);
  assert.equal(mask[2], 1);
  assert.equal(mask[3], 1);
});

test('applyHeadArchetypes supports GPU direct path, composited global blend, and regional masked mixing with neck lock', () => {
  assert.equal(BUILTIN_HEAD_ARCHETYPE_CATALOG.length, 6);

  // 1. Direct GPU path when pre-baked targets exist and no regions/neck override are active.
  const gpuMesh = createHeadMesh({ prebaked: true });
  const gpuMode = applyHeadArchetypes(
    gpuMesh,
    [
      { id: 'black', label: 'Black' },
      { id: 'manga', label: 'Manga' },
    ],
    { weights: { black: 0.6, manga: 0.4 } },
  );
  assert.equal(gpuMode, 'gpu');
  assert.ok(Math.abs(gpuMesh.morphTargetInfluences[gpuMesh.morphTargetDictionary['HeadArchetype_black']] - 0.6) < 1e-6);
  assert.ok(Math.abs(gpuMesh.morphTargetInfluences[gpuMesh.morphTargetDictionary['HeadArchetype_manga']] - 0.4) < 1e-6);

  // 2. Regional masked mixing + strict neck lock (even if an archetype tries to move v0/v1).
  const compMesh = createHeadMesh();
  const archetypes = [
    {
      id: 'black',
      label: 'Black',
      vertexIndices: [0, 1, 2, 3],
      deltas: [
        0.01, 0.01, 0.01, // v0 neck seam attempt -> locked to 0
        0.01, 0.01, 0.01, // v1 below seam attempt -> locked to 0
        0.006, 0, 0,      // v2 nose
        0, -0.002, 0,     // v3 jaw
      ],
      regionWeights: {
        nose: [0, 0, 1, 0],
        jaw_chin: [0, 0, 0, 1],
      },
    },
    {
      id: 'manga',
      label: 'Manga',
      vertexIndices: [2, 3],
      deltas: [
        0, 0, -0.005,     // v2 nose
        0, -0.01, 0.004,  // v3 jaw
      ],
      regionWeights: {
        nose: [0, 0, 1, 0],
        jaw_chin: [0, 0, 0, 1],
      },
    },
  ];

  const mode = applyHeadArchetypes(
    compMesh,
    archetypes,
    {
      weights: { manga: 1.0 },
      regions: { nose: { black: 1.0 } },
    },
    { neckSeamY: 0.785, blendHeight: 0.025 },
  );
  assert.equal(mode, 'composited');

  const blendedIdx = compMesh.morphTargetDictionary['HeadArchetype_Blended'];
  assert.ok(blendedIdx !== undefined);
  assert.equal(compMesh.morphTargetInfluences[blendedIdx], 1);

  const attr = compMesh.geometry.morphAttributes.position[blendedIdx];
  // Neck seam vertices v0, v1 strictly unchanged!
  assert.equal(attr.getX(0), 0);
  assert.equal(attr.getY(0), 0);
  assert.equal(attr.getZ(0), 0);
  assert.equal(attr.getX(1), 0);
  // v2 (nose) follows `black` regional override; v3 (jaw) follows global `manga`.
  assert.ok(Math.abs(attr.getX(2) - 0.006) < 1e-6);
  assert.ok(Math.abs(attr.getZ(2)) < 1e-6);
  assert.ok(Math.abs(attr.getY(3) - -0.01) < 1e-6);
  assert.ok(Math.abs(attr.getZ(3) - 0.004) < 1e-6);
});

test('interpolateHeadLandmarks tracks global and regional archetype mixes and persists in AvatarStateV1', async () => {
  const baseLandmarks = {
    eyeLeft: [0.03, 0.89, 0.04],
    noseTip: [0, 0.865, 0.07],
    chin: [0, 0.815, 0.055],
  };
  const archetypes = [
    {
      id: 'black',
      label: 'Black',
      landmarkDeltas: {
        eyeLeft: [0.001, 0, 0],
        noseTip: [0.002, -0.001, 0.002],
        chin: [0, -0.002, 0.001],
      },
    },
    {
      id: 'manga',
      label: 'Manga',
      landmarkDeltas: {
        eyeLeft: [0.004, 0.005, 0],
        noseTip: [0, 0.001, -0.004],
        chin: [0, -0.008, 0.003],
      },
    },
  ];

  const mixed = interpolateHeadLandmarks(baseLandmarks, archetypes, {
    weights: { manga: 1.0 },
    regions: { nose: { black: 0.5, manga: 0.5 } },
  });

  // eyeLeft -> global manga (1.0)
  assert.ok(Math.abs(mixed.eyeLeft[0] - 0.034) < 1e-6);
  assert.ok(Math.abs(mixed.eyeLeft[1] - 0.895) < 1e-6);
  // noseTip -> regional mix (0.5 black + 0.5 manga)
  assert.ok(Math.abs(mixed.noseTip[0] - 0.001) < 1e-6);
  assert.ok(Math.abs(mixed.noseTip[2] - 0.069) < 1e-6);
  // chin -> global manga (1.0)
  assert.ok(Math.abs(mixed.chin[1] - 0.807) < 1e-6);

  assert.deepEqual(normalizeHeadArchetypeState({
    weights: { black: 2, empty: 0 },
    regions: { invalid_zone: { black: 1 }, nose: { black: 0.4 } },
  }), {
    weights: { black: 1 },
    regions: { nose: { black: 0.4 } },
  });

  // Round-trip through AvatarRuntime + AvatarSerializer.
  const body = createHeadMesh();
  body.name = 'AvatarBody';
  // Build minimal valid indexed body with 1 triangle and required Mixamo bones.
  const root = body.skeleton.bones[0].parent ?? new (await import('three')).Group();
  root.add(body);
  const fullBones = MIXAMO_HUMANOID_RIG_V1.bones.filter((b) => b.required).map((b) => {
    const bone = new Bone();
    bone.name = b.aliases[0];
    return bone;
  });
  for (let i = 1; i < fullBones.length; i++) fullBones[0].add(fullBones[i]);
  root.add(fullBones[0]);
  root.updateMatrixWorld(true);
  const skel = new Skeleton(fullBones);
  skel.calculateInverses();
  body.geometry.setAttribute('skinIndex', new (await import('three')).Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
  body.geometry.setAttribute('skinWeight', new (await import('three')).Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  body.geometry.setIndex(new (await import('three')).Uint16BufferAttribute([0, 1, 2], 1));
  body.bind(skel, new Matrix4());

  const registry = new AvatarAssetRegistry();
  registry.install({
    id: 'test:pack/heads',
    version: '1.0.0',
    rigs: [MIXAMO_HUMANOID_RIG_V1],
    assets: [{ id: 'test:asset/body', version: '1.0.0', uri: 'mem://body', kind: 'body' }],
    families: [{
      id: 'test:family/heads',
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
  const avatar = await runtime.create({ family: { id: 'test:family/heads', version: '1.0.0' } });
  writeHeadArchetypeState(avatar, { weights: { chinese: 0.7 }, regions: { nose: { black: 0.3 } } });

  const serializer = new AvatarSerializer();
  const saved = serializer.parse(serializer.stringify(avatar.serialize()));
  const restored = await runtime.fromJSON(saved);
  assert.deepEqual(readHeadArchetypeState(restored), {
    weights: { chinese: 0.7 },
    regions: { nose: { black: 0.3 } },
  });
});

test('parseHeadArchetypePack validates real Blender female and male packs and applies safely with neck lock', () => {
  const expectedIds = ['black', 'east_asian', 'chinese', 'manga', 'south_asian', 'angular'];
  const specs = [
    { file: 'examples/head-archetypes/head-archetypes-female.json', slug: 'female', vertexCount: 10585 },
    { file: 'examples/head-archetypes/head-archetypes-male.json', slug: 'male', vertexCount: 10732 },
  ];

  for (const spec of specs) {
    const raw = JSON.parse(readFileSync(new URL(`../${spec.file}`, import.meta.url), 'utf8'));
    const pack = parseHeadArchetypePack(raw);
    assert.equal(pack.version, 1);
    assert.equal(pack.slug, spec.slug);
    assert.equal(pack.vertexCount, spec.vertexCount);
    assert.equal(pack.archetypes.length, expectedIds.length);

    const movedHeadVertices = new Set();
    for (const id of expectedIds) {
      const entry = pack.archetypes.find((a) => a.id === id);
      assert.ok(entry, `${spec.slug} missing archetype "${id}"`);
      assert.ok(entry.vertexIndices && entry.vertexIndices.length > 500);
      assert.ok(entry.deltas && entry.deltas.length === entry.vertexIndices.length * 3);
      for (const d of entry.deltas) assert.ok(Number.isFinite(d));
      assert.ok(entry.landmarkDeltas && entry.landmarkDeltas['noseTip']);
      for (const vec of Object.values(entry.landmarkDeltas)) {
        assert.equal(vec.length, 3);
        for (const n of vec) assert.ok(Number.isFinite(n));
      }
      for (const vi of entry.vertexIndices) movedHeadVertices.add(vi);
    }

    // Build synthetic SkinnedMesh matching pack.vertexCount where sparse moved indices lie
    // above neckSeamY and remaining vertices lie at or below neckSeamY.
    const positions = new Float32Array(pack.vertexCount * 3);
    const neckIndices = [];
    for (let i = 0; i < pack.vertexCount; i++) {
      positions[i * 3] = 0.02 * ((i % 5) - 2);
      if (movedHeadVertices.has(i)) {
        positions[i * 3 + 1] = pack.neckSeamY + 0.1;
      } else {
        positions[i * 3 + 1] = neckIndices.length === 0 ? pack.neckSeamY : pack.neckSeamY - 0.05;
        neckIndices.push(i);
      }
      positions[i * 3 + 2] = 0.05;
    }
    assert.ok(neckIndices.length > 0);

    const bone = new Bone();
    bone.name = 'mixamorig:Hips';
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
    mesh.bind(new Skeleton([bone]), new Matrix4());

    const mode = applyHeadArchetypes(
      mesh,
      pack.archetypes,
      {
        weights: { manga: 0.7, angular: 0.3 },
        regions: { nose: { black: 0.8 } },
      },
      { neckSeamY: pack.neckSeamY, blendHeight: pack.blendHeight },
    );
    assert.equal(mode, 'composited');

    const blendedIdx = mesh.morphTargetDictionary['HeadArchetype_Blended'];
    assert.ok(blendedIdx !== undefined);
    const attr = mesh.geometry.morphAttributes.position[blendedIdx];
    let nonZeroHead = 0;
    for (let i = 0; i < pack.vertexCount; i++) {
      const dx = attr.getX(i);
      const dy = attr.getY(i);
      const dz = attr.getZ(i);
      assert.ok(Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(dz));
      if (positions[i * 3 + 1] <= pack.neckSeamY) {
        assert.equal(dx, 0);
        assert.equal(dy, 0);
        assert.equal(dz, 0);
      } else if (dx !== 0 || dy !== 0 || dz !== 0) {
        nonZeroHead++;
      }
    }
    assert.ok(nonZeroHead > 500, `Expected displaced head vertices for ${spec.slug}, got ${nonZeroHead}`);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Matrix4,
  MeshBasicMaterial,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
} from 'three';
import {
  AvatarAssetRegistry,
  AvatarRuntime,
  AvatarSerializer,
  LAYER_COVERAGE_ATTRIBUTE,
  MIXAMO_HUMANOID_RIG_V1,
  STANDARD_EQUIPMENT_CHANNELS,
  computeLayerCoverage,
  normalizeLayeringState,
  readLayeringState,
  resolveGarmentLayerRank,
  solveGarmentLayers,
  writeLayeringState,
} from '../dist/index.js';
import {
  SpatialMeshIndex,
  evaluateMeshBindPositions,
} from '../dist/layering/index.js';

function createCylinderMesh({
  name = 'Mesh',
  radius = 0.1,
  yMin = 0.8,
  yMax = 1.4,
  radialSegments = 16,
  heightSegments = 4,
  openFront = false,
  morphTargetNames = [],
}) {
  const root = new Group();
  const hips = new Bone();
  hips.name = 'mixamorig:Hips';
  const spine = new Bone();
  spine.name = 'mixamorig:Spine';
  const spine1 = new Bone();
  spine1.name = 'mixamorig:Spine1';
  const spine2 = new Bone();
  spine2.name = 'mixamorig:Spine2';
  const neck = new Bone();
  neck.name = 'mixamorig:Neck';
  const head = new Bone();
  head.name = 'mixamorig:Head';
  const leftShoulder = new Bone(); leftShoulder.name = 'mixamorig:LeftShoulder';
  const leftArm = new Bone(); leftArm.name = 'mixamorig:LeftArm';
  const leftForeArm = new Bone(); leftForeArm.name = 'mixamorig:LeftForeArm';
  const leftHand = new Bone(); leftHand.name = 'mixamorig:LeftHand';
  const rightShoulder = new Bone(); rightShoulder.name = 'mixamorig:RightShoulder';
  const rightArm = new Bone(); rightArm.name = 'mixamorig:RightArm';
  const rightForeArm = new Bone(); rightForeArm.name = 'mixamorig:RightForeArm';
  const rightHand = new Bone(); rightHand.name = 'mixamorig:RightHand';
  const leftUpLeg = new Bone(); leftUpLeg.name = 'mixamorig:LeftUpLeg';
  const leftLeg = new Bone(); leftLeg.name = 'mixamorig:LeftLeg';
  const leftFoot = new Bone(); leftFoot.name = 'mixamorig:LeftFoot';
  const rightUpLeg = new Bone(); rightUpLeg.name = 'mixamorig:RightUpLeg';
  const rightLeg = new Bone(); rightLeg.name = 'mixamorig:RightLeg';
  const rightFoot = new Bone(); rightFoot.name = 'mixamorig:RightFoot';

  hips.position.y = 0.9;
  spine.position.y = 0.1;
  spine1.position.y = 0.15;
  spine2.position.y = 0.15;
  neck.position.y = 0.15;
  head.position.y = 0.1;
  hips.add(spine);
  spine.add(spine1);
  spine1.add(spine2);
  spine2.add(neck);
  neck.add(head);
  spine2.add(leftShoulder, rightShoulder);
  leftShoulder.add(leftArm); leftArm.add(leftForeArm); leftForeArm.add(leftHand);
  rightShoulder.add(rightArm); rightArm.add(rightForeArm); rightForeArm.add(rightHand);
  hips.add(leftUpLeg, rightUpLeg);
  leftUpLeg.add(leftLeg); leftLeg.add(leftFoot);
  rightUpLeg.add(rightLeg); rightLeg.add(rightFoot);
  root.add(hips);
  root.updateMatrixWorld(true);

  const bones = [
    hips, spine, spine1, spine2, neck, head,
    leftShoulder, leftArm, leftForeArm, leftHand,
    rightShoulder, rightArm, rightForeArm, rightHand,
    leftUpLeg, leftLeg, leftFoot,
    rightUpLeg, rightLeg, rightFoot,
  ];

  const positions = [];
  const normals = [];
  const skinIndices = [];
  const skinWeights = [];
  const indices = [];

  for (let iy = 0; iy <= heightSegments; iy++) {
    const y = yMin + (yMax - yMin) * (iy / heightSegments);
    for (let ix = 0; ix <= radialSegments; ix++) {
      const theta = (ix / radialSegments) * Math.PI * 2;
      const nx = Math.sin(theta);
      const nz = Math.cos(theta);
      positions.push(nx * radius, y, nz * radius);
      normals.push(nx, 0, nz);
      skinIndices.push(1, 0, 0, 0);
      skinWeights.push(1, 0, 0, 0);
    }
  }

  const stride = radialSegments + 1;
  for (let iy = 0; iy < heightSegments; iy++) {
    for (let ix = 0; ix < radialSegments; ix++) {
      const a = iy * stride + ix;
      const b = a + 1;
      const c = (iy + 1) * stride + ix;
      const d = c + 1;
      // If openFront is true, omit triangles facing +Z (around theta ~ 0 / 2*PI).
      if (openFront) {
        const thetaMid = ((ix + 0.5) / radialSegments) * Math.PI * 2;
        if (Math.cos(thetaMid) > 0.5) continue;
      }
      indices.push(a, b, d, a, d, c);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeights, 4));
  geometry.setIndex(new Uint16BufferAttribute(indices, 1));

  if (morphTargetNames.length > 0) {
    geometry.morphTargetsRelative = true;
    geometry.morphAttributes.position = morphTargetNames.map((targetName) => {
      const delta = new Float32Array(positions.length);
      for (let i = 0; i < positions.length; i += 3) {
        // TuckIntoBoots pulls vertices radially inward by 0.015m.
        const x = positions[i];
        const z = positions[i + 2];
        const len = Math.hypot(x, z) || 1;
        delta[i] = -(x / len) * 0.015;
        delta[i + 2] = -(z / len) * 0.015;
      }
      const attr = new Float32BufferAttribute(delta, 3);
      attr.name = targetName;
      return attr;
    });
    geometry.userData.targetNames = [...morphTargetNames];
  }

  const skeleton = new Skeleton(bones);
  skeleton.calculateInverses();
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial({ color: '#ffffff' }));
  mesh.name = name;
  mesh.bind(skeleton, new Matrix4());
  root.add(mesh);
  return { root, mesh, indexCount: indices.length };
}

function setupLayerTestRuntime(assetsById) {
  const registry = new AvatarAssetRegistry();
  registry.install({
    id: 'test:pack/layering',
    version: '1.0.0',
    rigs: [MIXAMO_HUMANOID_RIG_V1],
    assets: Object.keys(assetsById).map((id) => ({
      id,
      version: '1.0.0',
      uri: `mem://${id}`,
      kind: id.includes('body') ? 'body' : 'wearable',
    })),
    families: [
      {
        id: 'test:family/layered',
        version: '1.0.0',
        rig: { id: MIXAMO_HUMANOID_RIG_V1.id, version: MIXAMO_HUMANOID_RIG_V1.version },
        body: {
          asset: { id: 'test:asset/body', version: '1.0.0' },
          meshNode: 'AvatarBody',
          regions: [{ id: 'torso.upper', indexOffset: 0, indexCount: assetsById['test:asset/body'].indexCount }],
        },
      },
    ],
    items: [
      {
        id: 'test:item/shirt',
        version: '1.0.0',
        kind: 'wearable',
        compatibility: { families: [{ id: 'test:family/layered', version: '1.0.0' }] },
        render: { type: 'skinned', asset: { id: 'test:asset/shirt', version: '1.0.0' } },
        occupies: [STANDARD_EQUIPMENT_CHANNELS.UpperBase],
      },
      {
        id: 'test:item/jacket',
        version: '1.0.0',
        kind: 'wearable',
        compatibility: { families: [{ id: 'test:family/layered', version: '1.0.0' }] },
        render: { type: 'skinned', asset: { id: 'test:asset/jacket', version: '1.0.0' } },
        occupies: [STANDARD_EQUIPMENT_CHANNELS.UpperOuter],
        layer: { openFront: true, outerBulk: 0.6 },
      },
      {
        id: 'test:item/trousers',
        version: '1.0.0',
        kind: 'wearable',
        compatibility: { families: [{ id: 'test:family/layered', version: '1.0.0' }] },
        render: { type: 'skinned', asset: { id: 'test:asset/trousers', version: '1.0.0' } },
        occupies: [STANDARD_EQUIPMENT_CHANNELS.LowerBase],
      },
      {
        id: 'test:item/boots',
        version: '1.0.0',
        kind: 'wearable',
        compatibility: { families: [{ id: 'test:family/layered', version: '1.0.0' }] },
        render: { type: 'skinned', asset: { id: 'test:asset/boots', version: '1.0.0' } },
        occupies: [STANDARD_EQUIPMENT_CHANNELS.Feet],
        layer: { highShaft: true },
        metadata: { tucksLegwear: true },
      },
    ],
  });

  const loader = {
    async load(ref) {
      const source = assetsById[ref.id];
      return { root: source.root };
    },
  };
  return new AvatarRuntime(registry, loader);
}

test('resolveGarmentLayerRank handles standard layers and tuck overrides', () => {
  const shirt = {
    id: 'a', version: '1.0.0', kind: 'wearable',
    compatibility: { families: [] },
    render: { type: 'skinned', asset: { id: 'x', version: '1.0.0' } },
    occupies: ['upper.base'],
  };
  const jacket = { ...shirt, id: 'b', occupies: ['upper.outer'] };
  const pants = { ...shirt, id: 'c', occupies: ['lower.base'] };
  const boots = { ...shirt, id: 'd', occupies: ['feet'] };

  assert.ok(resolveGarmentLayerRank(shirt) > resolveGarmentLayerRank(pants));
  assert.ok(resolveGarmentLayerRank(jacket) > resolveGarmentLayerRank(shirt));
  assert.ok(resolveGarmentLayerRank(shirt, { tuckTop: 'tucked' }) < resolveGarmentLayerRank(pants, { tuckTop: 'tucked' }));
  assert.ok(resolveGarmentLayerRank(boots, { tuckCuffs: 'over' }) < resolveGarmentLayerRank(pants, { tuckCuffs: 'over' }));
  assert.equal(resolveGarmentLayerRank(shirt, { layerOverrides: { 'upper.base': 9 } }), 9);
});

test('computeLayerCoverage culls back under open-front outer jacket while keeping exposed front visible', async () => {
  const runtime = setupLayerTestRuntime({
    'test:asset/body': createCylinderMesh({ name: 'AvatarBody', radius: 0.1, yMin: 0.7, yMax: 1.4 }),
    'test:asset/shirt': createCylinderMesh({ name: 'Shirt', radius: 0.11, yMin: 0.9, yMax: 1.35 }),
    'test:asset/jacket': createCylinderMesh({ name: 'Jacket', radius: 0.12, yMin: 0.9, yMax: 1.35, openFront: true }),
    'test:asset/trousers': createCylinderMesh({ name: 'Trousers', radius: 0.108, yMin: 0.7, yMax: 1.0 }),
    'test:asset/boots': createCylinderMesh({ name: 'Boots', radius: 0.12, yMin: 0.7, yMax: 0.85 }),
  });

  const avatar = await runtime.create({ family: { id: 'test:family/layered', version: '1.0.0' } });
  const shirt = await avatar.equipment.equip({ id: 'test:item/shirt', version: '1.0.0' });
  await avatar.equipment.equip({ id: 'test:item/jacket', version: '1.0.0' });

  const report = computeLayerCoverage(avatar);
  assert.ok(report.bodyCoveredVertices > 0);
  assert.ok((report.garmentCoveredVertices[shirt.instanceId] ?? 0) > 0);

  const shirtMesh = shirt.root.getObjectByName('Shirt');
  const pos = shirtMesh.geometry.getAttribute('position');
  const cov = shirtMesh.geometry.getAttribute(LAYER_COVERAGE_ATTRIBUTE);
  let frontExposed = 0;
  let backCovered = 0;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const y = pos.getY(i);
    if (y > 0.98 && y < 1.28) {
      if (z > 0.095 && cov.getX(i) === 0) frontExposed++;
      if (z < -0.095 && cov.getX(i) === 1) backCovered++;
    }
  }
  assert.ok(frontExposed > 0, 'open front of outer jacket leaves inner shirt front uncovered');
  assert.ok(backCovered > 0, 'covered back of inner shirt is marked covered');
});

test('solveGarmentLayers compresses inner shirt without piercing skin and expands outer jacket to 5mm clearance', async () => {
  // Body at 0.100, shirt at 0.110 (10mm outside body), penetrating jacket at 0.106 (inside shirt!).
  const runtime = setupLayerTestRuntime({
    'test:asset/body': createCylinderMesh({ name: 'AvatarBody', radius: 0.1, yMin: 0.8, yMax: 1.4 }),
    'test:asset/shirt': createCylinderMesh({ name: 'Shirt', radius: 0.11, yMin: 0.9, yMax: 1.3 }),
    'test:asset/jacket': createCylinderMesh({ name: 'Jacket', radius: 0.106, yMin: 0.9, yMax: 1.3 }),
    'test:asset/trousers': createCylinderMesh({ name: 'Trousers', radius: 0.108, yMin: 0.8, yMax: 1.0 }),
    'test:asset/boots': createCylinderMesh({ name: 'Boots', radius: 0.12, yMin: 0.8, yMax: 0.9 }),
  });

  const avatar = await runtime.create({ family: { id: 'test:family/layered', version: '1.0.0' } });
  const shirt = await avatar.equipment.equip({ id: 'test:item/shirt', version: '1.0.0' });
  const jacket = await avatar.equipment.equip({ id: 'test:item/jacket', version: '1.0.0' });

  const result = solveGarmentLayers(avatar);
  assert.ok(result.adjustedInstances.includes(shirt.instanceId));
  assert.ok(result.adjustedInstances.includes(jacket.instanceId));

  const shirtMesh = shirt.root.getObjectByName('Shirt');
  const jacketMesh = jacket.root.getObjectByName('Jacket');
  const shirtPos = evaluateMeshBindPositions(shirtMesh, () => true);
  const jacketPos = evaluateMeshBindPositions(jacketMesh, () => true);

  const radial = (arr, i) => Math.hypot(arr[i * 3], arr[i * 3 + 2]);
  // Check middle ring vertices (far from top/bottom boundary smoothing).
  let minShirtR = Infinity;
  let minJacketR = Infinity;
  for (let i = 0; i < shirtPos.length / 3; i++) {
    const y = shirtPos[i * 3 + 1];
    if (y > 1.05 && y < 1.15) {
      minShirtR = Math.min(minShirtR, radial(shirtPos, i));
      minJacketR = Math.min(minJacketR, radial(jacketPos, i));
    }
  }

  assert.ok(minShirtR >= 0.102, `inner shirt stays outside body skin clearance (got ${minShirtR.toFixed(4)})`);
  assert.ok(minShirtR < 0.1095, `inner shirt compressed inward from 0.110 (got ${minShirtR.toFixed(4)})`);
  assert.ok(minJacketR >= minShirtR + 0.0045, `outer jacket maintains clearance over shirt (jacket ${minJacketR.toFixed(4)} vs shirt ${minShirtR.toFixed(4)})`);

  // Idempotency check: solving again yields stable radii.
  solveGarmentLayers(avatar);
  const jacketPosAfter = evaluateMeshBindPositions(jacketMesh, () => true);
  let minJacketAfter = Infinity;
  for (let i = 0; i < jacketPosAfter.length / 3; i++) {
    const y = jacketPosAfter[i * 3 + 1];
    if (y > 1.05 && y < 1.15) minJacketAfter = Math.min(minJacketAfter, radial(jacketPosAfter, i));
  }
  assert.ok(Math.abs(minJacketAfter - minJacketR) < 0.001);
});

test('solveGarmentLayers handles tuckTop and TuckIntoBoots / procedural cuff tucking', async () => {
  const runtime = setupLayerTestRuntime({
    'test:asset/body': createCylinderMesh({ name: 'AvatarBody', radius: 0.1, yMin: 0.2, yMax: 1.4 }),
    'test:asset/shirt': createCylinderMesh({ name: 'Shirt', radius: 0.115, yMin: 0.9, yMax: 1.3 }),
    'test:asset/jacket': createCylinderMesh({ name: 'Jacket', radius: 0.125, yMin: 0.9, yMax: 1.3 }),
    'test:asset/trousers': createCylinderMesh({
      name: 'Trousers',
      radius: 0.112,
      yMin: 0.2,
      yMax: 1.0,
      morphTargetNames: ['TuckIntoBoots'],
    }),
    'test:asset/boots': createCylinderMesh({ name: 'Boots', radius: 0.12, yMin: 0.2, yMax: 0.45 }),
  });

  const avatar = await runtime.create({ family: { id: 'test:family/layered', version: '1.0.0' } });
  const shirt = await avatar.equipment.equip({ id: 'test:item/shirt', version: '1.0.0' });
  const trousers = await avatar.equipment.equip({ id: 'test:item/trousers', version: '1.0.0' });
  await avatar.equipment.equip({ id: 'test:item/boots', version: '1.0.0' });

  solveGarmentLayers(avatar, { tuckTop: 'tucked', tuckCuffs: 'auto' });
  const shirtMesh = shirt.root.getObjectByName('Shirt');
  const trousersMesh = trousers.root.getObjectByName('Trousers');

  assert.equal(shirtMesh.morphTargetInfluences[shirtMesh.morphTargetDictionary['layer.tuckTop']], 1);
  assert.equal(trousersMesh.morphTargetInfluences[trousersMesh.morphTargetDictionary['TuckIntoBoots']], 1);

  solveGarmentLayers(avatar, { tuckTop: 'untucked', tuckCuffs: 'over' });
  assert.equal(shirtMesh.morphTargetInfluences[shirtMesh.morphTargetDictionary['layer.tuckTop']] ?? 0, 0);
  assert.equal(trousersMesh.morphTargetInfluences[trousersMesh.morphTargetDictionary['TuckIntoBoots']], 0);

  // Also verify procedural cuff taper fallback (`layer.tuckCuffs`) when `TuckIntoBoots` is absent.
  const fallbackRuntime = setupLayerTestRuntime({
    'test:asset/body': createCylinderMesh({ name: 'AvatarBody', radius: 0.08, yMin: 0.2, yMax: 1.4 }),
    'test:asset/shirt': createCylinderMesh({ name: 'Shirt', radius: 0.115, yMin: 0.9, yMax: 1.3 }),
    'test:asset/jacket': createCylinderMesh({ name: 'Jacket', radius: 0.125, yMin: 0.9, yMax: 1.3 }),
    'test:asset/trousers': createCylinderMesh({ name: 'Trousers', radius: 0.112, yMin: 0.2, yMax: 1.0 }),
    'test:asset/boots': createCylinderMesh({ name: 'Boots', radius: 0.12, yMin: 0.2, yMax: 0.45 }),
  });
  const fallbackAvatar = await fallbackRuntime.create({ family: { id: 'test:family/layered', version: '1.0.0' } });
  const fallbackTrousers = await fallbackAvatar.equipment.equip({ id: 'test:item/trousers', version: '1.0.0' });
  await fallbackAvatar.equipment.equip({ id: 'test:item/boots', version: '1.0.0' });

  solveGarmentLayers(fallbackAvatar, { tuckCuffs: 'tucked' });
  const fallbackMesh = fallbackTrousers.root.getObjectByName('Trousers');
  assert.equal(fallbackMesh.morphTargetInfluences[fallbackMesh.morphTargetDictionary['layer.tuckCuffs']], 1);
});

test('layering metadata round-trips cleanly through AvatarSerializer', async () => {
  const runtime = setupLayerTestRuntime({
    'test:asset/body': createCylinderMesh({ name: 'AvatarBody', radius: 0.1, yMin: 0.8, yMax: 1.4 }),
    'test:asset/shirt': createCylinderMesh({ name: 'Shirt', radius: 0.11, yMin: 0.9, yMax: 1.3 }),
    'test:asset/jacket': createCylinderMesh({ name: 'Jacket', radius: 0.12, yMin: 0.9, yMax: 1.3 }),
    'test:asset/trousers': createCylinderMesh({ name: 'Trousers', radius: 0.108, yMin: 0.8, yMax: 1.0 }),
    'test:asset/boots': createCylinderMesh({ name: 'Boots', radius: 0.12, yMin: 0.8, yMax: 0.9 }),
  });

  const avatar = await runtime.create({ family: { id: 'test:family/layered', version: '1.0.0' } });
  writeLayeringState(avatar, { tuckTop: 'tucked', tuckCuffs: 'over', layerOverrides: { waist: 7 } });

  const serializer = new AvatarSerializer();
  const parsed = serializer.parse(serializer.stringify(avatar.serialize()));
  const restored = await runtime.fromJSON(parsed);
  assert.deepEqual(readLayeringState(restored), {
    tuckTop: 'tucked',
    tuckCuffs: 'over',
    layerOverrides: { waist: 7 },
  });
  assert.deepEqual(normalizeLayeringState({ tuckTop: 'auto', tuckCuffs: 'bogus' }), {});
});

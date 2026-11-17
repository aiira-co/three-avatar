import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
} from 'three';
import {
  AvatarAssetRegistry,
  AvatarRuntime,
} from '../dist/index.js';

const refs = {
  rig: { id: 'test:rig/two-bone', version: '1.0.0' },
  family: { id: 'test:family/human', version: '1.0.0' },
  body: { id: 'test:asset/body', version: '1.0.0' },
  shirtAsset: { id: 'test:asset/shirt', version: '1.0.0' },
  armorAsset: { id: 'test:asset/armor', version: '1.0.0' },
  patchAsset: { id: 'test:asset/patch', version: '1.0.0' },
  shirt: { id: 'test:item/shirt', version: '1.0.0' },
  armor: { id: 'test:item/armor', version: '1.0.0' },
  patch: { id: 'test:item/patch', version: '1.0.0' },
};

function createSkinnedAsset(meshName, morphTargets = []) {
  const root = new Group();
  const hips = new Bone();
  hips.name = 'mixamorig:Hips';
  const head = new Bone();
  head.name = 'mixamorig:Head';
  head.position.y = 1;
  hips.add(head);
  root.add(hips);
  root.updateMatrixWorld(true);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    0, 1, 0,
    1, 1, 0,
    0, 2, 0,
  ], 3));
  geometry.setIndex(new Uint16BufferAttribute([0, 1, 2, 3, 4, 5], 1));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute([
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
  ], 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute([
    1, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
  ], 4));
  geometry.morphAttributes.position = morphTargets.map(() => new Float32BufferAttribute([
    0, 0, 0,
    0, 0, 0,
    0, 0, 0,
    0, 0, 0,
    0, 0, 0,
    0, 0, 0,
  ], 3));

  const skeleton = new Skeleton([hips, head]);
  skeleton.calculateInverses();
  const material = new MeshBasicMaterial({ color: '#ffffff' });
  material.name = 'Fabric';
  const mesh = new SkinnedMesh(geometry, material);
  mesh.name = meshName;
  mesh.updateMorphTargets();
  mesh.morphTargetDictionary = Object.fromEntries(morphTargets.map((name, index) => [name, index]));
  root.add(mesh);
  mesh.bind(skeleton, new Matrix4());
  return root;
}

function createBodyAsset() {
  const root = createSkinnedAsset('Body', ['body.archetype.feminine']);
  const body = root.getObjectByName('Body');
  const headGeometry = body.geometry.clone();
  headGeometry.morphAttributes.position = [new Float32BufferAttribute([
    0, 0, 0,
    0, 0, 0,
    0, 0, 0,
    0, 0, 0,
    0, 0, 0,
    0, 0, 0,
  ], 3)];
  const head = new SkinnedMesh(headGeometry, body.material.clone());
  head.name = 'Head';
  head.bind(body.skeleton, body.bindMatrix);
  head.updateMorphTargets();
  head.morphTargetDictionary = { 'head.width': 0 };
  root.add(head);
  const eye = new Object3D();
  eye.name = 'EyeLeft';
  root.add(eye);
  return root;
}

class TestLoader {
  constructor() {
    this.factories = new Map([
      ['test:asset/body@1.0.0', createBodyAsset],
      ['test:asset/shirt@1.0.0', () => createSkinnedAsset('Shirt', ['body.archetype.feminine'])],
      ['test:asset/armor@1.0.0', () => createSkinnedAsset('Armor')],
      ['test:asset/patch@1.0.0', () => {
        const root = new Group();
        root.name = 'Patch';
        return root;
      }],
    ]);
  }

  async load(ref) {
    const factory = this.factories.get(`${ref.id}@${ref.version}`);
    if (!factory) throw new Error(`Missing test asset ${ref.id}@${ref.version}`);
    const root = factory();
    return { root, dispose: () => { root.userData.disposed = true; } };
  }
}

function createRegistry() {
  const registry = new AvatarAssetRegistry();
  registry.install({
    id: 'test:pack/core',
    version: '1.0.0',
    rigs: [{
      ...refs.rig,
      upAxis: '+Y',
      forwardAxis: '-Z',
      handedness: 'right',
      unitsPerMeter: 1,
      referencePose: 'T',
      rootMotionBone: 'hips',
      bones: [
        { id: 'hips', aliases: ['mixamorig:Hips'], required: true },
        { id: 'head', aliases: ['mixamorig:Head'], required: true },
      ],
    }],
    assets: [
      { ...refs.body, uri: '/body.glb', kind: 'body' },
      { ...refs.shirtAsset, uri: '/shirt.glb', kind: 'wearable' },
      { ...refs.armorAsset, uri: '/armor.glb', kind: 'wearable' },
      { ...refs.patchAsset, uri: '/patch.glb', kind: 'accessory' },
    ],
    families: [{
      ...refs.family,
      rig: refs.rig,
      body: {
        asset: refs.body,
        meshNode: 'Body',
        regions: [
          { id: 'torso.upper', indexOffset: 0, indexCount: 3 },
          { id: 'head', indexOffset: 3, indexCount: 3 },
        ],
      },
      head: { meshNode: 'Head', neckSeamVertexGroup: 'seam.neck' },
      morphBindings: [
        { channel: 'body.archetype.feminine', target: 'body.archetype.feminine', meshNode: 'Body' },
        { channel: 'head.width', target: 'head.width', meshNode: 'Head' },
      ],
      sockets: [{ id: 'face.left', bone: 'head' }],
      occlusionSurfaces: { 'eye.left': ['EyeLeft'] },
    }],
    items: [
      {
        ...refs.shirt,
        kind: 'wearable',
        compatibility: { families: [refs.family], rig: refs.rig },
        render: { type: 'skinned', asset: refs.shirtAsset, meshNodes: ['Shirt'] },
        occupies: ['upper.base'],
        coversBody: ['torso.upper'],
        morphBindings: [
          { channel: 'body.archetype.feminine', target: 'body.archetype.feminine', meshNode: 'Shirt' },
        ],
      },
      {
        ...refs.armor,
        kind: 'wearable',
        compatibility: { families: [refs.family], rig: refs.rig },
        render: { type: 'skinned', asset: refs.armorAsset, meshNodes: ['Armor'] },
        occupies: ['upper.base'],
        coversBody: ['head'],
      },
      {
        ...refs.patch,
        kind: 'accessory',
        compatibility: { families: [refs.family] },
        render: { type: 'socket', asset: refs.patchAsset, socket: 'face.left' },
        occupies: ['face.left'],
        occludes: ['eye.left'],
      },
    ],
  });
  return registry;
}

test('runtime masks body regions and reuses the body Skeleton for wearables', async () => {
  const runtime = new AvatarRuntime(createRegistry(), new TestLoader());
  const avatar = await runtime.create({ family: refs.family });
  const shirt = await avatar.equipment.equip(refs.shirt, { instanceId: 'shirt' });
  const shirtMesh = shirt.root.getObjectByName('Shirt');

  assert.equal(shirtMesh.skeleton, avatar.bodyMesh.skeleton);
  assert.equal(avatar.bodyMesh.geometry.index.count, 3);
  assert.deepEqual([...avatar.bodyVisibility.hiddenRegions], ['torso.upper']);
  avatar.dispose();
});

test('runtime exposes a separate head and propagates identity morphs to fitted wearables', async () => {
  const runtime = new AvatarRuntime(createRegistry(), new TestLoader());
  const avatar = await runtime.create({ family: refs.family });

  assert.equal(avatar.headMesh?.name, 'Head');
  assert.equal(avatar.headMesh?.skeleton, avatar.bodyMesh.skeleton);

  avatar.morphs.set('head.width', 0.35);
  avatar.morphs.set('body.archetype.feminine', 0.7);
  const shirt = await avatar.equipment.equip(refs.shirt, { instanceId: 'fitted-shirt' });
  const shirtMesh = shirt.root.getObjectByName('Shirt');

  assert.equal(avatar.headMesh.morphTargetInfluences[0], 0.35);
  assert.equal(avatar.bodyMesh.morphTargetInfluences[0], 0.7);
  assert.equal(shirtMesh.morphTargetInfluences[0], 0.7);
  assert.throws(() => avatar.morphs.set('body.unknown', 0.5), /not defined/);
  avatar.dispose();
});

test('equipment occupancy replaces conflicts and recomputes body coverage', async () => {
  const runtime = new AvatarRuntime(createRegistry(), new TestLoader());
  const avatar = await runtime.create({ family: refs.family });
  const shirt = await avatar.equipment.equip(refs.shirt, { instanceId: 'shirt' });
  await avatar.equipment.equip(refs.armor, { instanceId: 'armor' });

  assert.deepEqual(avatar.equipment.list().map((entry) => entry.instanceId), ['armor']);
  assert.equal(shirt.root.parent, null);
  assert.deepEqual([...avatar.bodyVisibility.hiddenRegions], ['head']);
  avatar.dispose();
});

test('socket accessories attach to semantic bones and occlude named surfaces', async () => {
  const runtime = new AvatarRuntime(createRegistry(), new TestLoader());
  const avatar = await runtime.create({ family: refs.family });
  const patch = await avatar.equipment.equip(refs.patch, { instanceId: 'patch' });

  assert.equal(patch.root.parent, avatar.sockets.require('face.left'));
  assert.equal(avatar.root.getObjectByName('EyeLeft').visible, false);
  await avatar.equipment.unequip('patch');
  assert.equal(avatar.root.getObjectByName('EyeLeft').visible, true);
  avatar.dispose();
});

test('serialized avatars restore equipment and exact local asset references', async () => {
  const runtime = new AvatarRuntime(createRegistry(), new TestLoader());
  const avatar = await runtime.create({ family: refs.family });
  avatar.setScale(1.15);
  await avatar.equipment.equip(refs.shirt, { instanceId: 'shirt' });
  const state = avatar.serialize();
  const restored = await runtime.fromJSON(state, { strictEquipment: true });

  assert.deepEqual(restored.serialize(), state);
  assert.equal(restored.equipment.list()[0].root.getObjectByName('Shirt').skeleton, restored.bodyMesh.skeleton);
  avatar.dispose();
  restored.dispose();
});

test('socket fit adjustments restore over the authored fit and reset to it', async () => {
  const runtime = new AvatarRuntime(createRegistry(), new TestLoader());
  const avatar = await runtime.create({ family: refs.family });
  const item = await avatar.equipment.equip(refs.patch, { instanceId: 'patch' });
  const fitted = item.root.position.toArray();
  const rotation = [0, Math.sin(Math.PI / 12), 0, Math.cos(Math.PI / 12)];
  avatar.equipment.setSocketTransform('patch', { position: [0.03, 0, 0], rotation, scale: [1.2, 1.2, 1.2] });
  const state = avatar.serialize();
  const restored = await runtime.fromJSON(JSON.parse(JSON.stringify(state)), { strict: true });
  const patch = restored.equipment.list()[0];
  assert.deepEqual(restored.serialize(), state);
  assert.equal(patch.root.parent, restored.sockets.require('face.left'));
  assert.deepEqual(patch.root.position.toArray(), [fitted[0] + 0.03, fitted[1], fitted[2]]);
  assert.deepEqual(patch.root.scale.toArray(), [1.2, 1.2, 1.2]);
  assert.throws(() => restored.equipment.setSocketTransform('patch', { scale: [1, 0, 1] }), /greater than zero/);
  assert.throws(() => restored.equipment.setSocketTransform('patch', { rotation: [0, 0, 0, 0] }), /unit quaternion/);
  assert.deepEqual(restored.serialize(), state);
  const shirt = await restored.equipment.equip(refs.shirt);
  assert.throws(() => restored.equipment.setSocketTransform(shirt.instanceId, { position: [0.03, 0, 0] }), /not socket-mounted/);
  restored.equipment.setSocketTransform('patch');
  assert.deepEqual(patch.root.position.toArray(), fitted);
  assert.equal(restored.serialize().equipment[0].transform, undefined);
  avatar.dispose();
  restored.dispose();
});

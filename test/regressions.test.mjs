import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
} from 'three';
import { AvatarAssetRegistry, AvatarRuntime, BodyVisibilityController } from '../dist/index.js';

const refs = {
  rig: { id: 'test:rig/two-bone', version: '1.0.0' },
  family: { id: 'test:family/human', version: '1.0.0' },
  familyNext: { id: 'test:family/human', version: '2.0.0' },
  body: { id: 'test:asset/body', version: '1.0.0' },
  pairAsset: { id: 'test:asset/pair', version: '1.0.0' },
  hatAsset: { id: 'test:asset/hat', version: '1.0.0' },
  capAsset: { id: 'test:asset/cap', version: '1.0.0' },
  fittedAsset: { id: 'test:asset/fitted', version: '1.0.0' },
  hairAsset: { id: 'test:asset/hair', version: '1.0.0' },
  shirt: { id: 'test:item/shirt', version: '1.0.0' },
  hat: { id: 'test:item/hat', version: '1.0.0' },
  cap: { id: 'test:item/cap', version: '1.0.0' },
  fitted: { id: 'test:item/fitted', version: '1.0.0' },
  hair: { id: 'test:item/hair', version: '1.0.0' },
  missing: { id: 'test:item/missing', version: '1.0.0' },
};

const FACE_MORPHS = ['smile', 'jawOpen', 'mouthO'];

function createSkinnedAsset(meshNames, morphTargets = []) {
  const root = new Group();
  const hips = new Bone();
  hips.name = 'mixamorig:Hips';
  const head = new Bone();
  head.name = 'mixamorig:Head';
  head.position.y = 1;
  hips.add(head);
  root.add(hips);
  root.updateMatrixWorld(true);
  const skeleton = new Skeleton([hips, head]);
  skeleton.calculateInverses();

  for (const meshName of meshNames) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 0, 2, 0], 3));
    geometry.setIndex(new Uint16BufferAttribute([0, 1, 2, 3, 4, 5], 1));
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Array(24).fill(0), 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(
      [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
    geometry.morphAttributes.position = morphTargets.map(
      () => new Float32BufferAttribute(new Array(18).fill(0), 3));

    const material = new MeshStandardMaterial();
    material.name = 'Skin';
    const mesh = new SkinnedMesh(geometry, material);
    mesh.name = meshName;
    root.add(mesh);
    mesh.updateMorphTargets();
    mesh.morphTargetDictionary = Object.fromEntries(morphTargets.map((name, index) => [name, index]));
    mesh.bind(skeleton, new Matrix4());
  }
  return root;
}

function createBodyAsset() {
  const root = createSkinnedAsset(['Body'], FACE_MORPHS);
  const hair = new Object3D();
  hair.name = 'HairTop';
  root.add(hair);
  return root;
}

// Alpha-blended hair cards over an opaque cap, both tinted by one channel.
function createHairAsset() {
  const root = new Group();
  root.name = 'Hair';
  for (const [name, transparent] of [['HairCards', true], ['HairCap', false]]) {
    const geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    const mesh = new Mesh(geometry, new MeshStandardMaterial({ transparent }));
    mesh.name = name;
    root.add(mesh);
  }
  return root;
}

class TestLoader {
  constructor() {
    this.factories = new Map([
      ['test:asset/body@1.0.0', createBodyAsset],
      ['test:asset/pair@1.0.0', () => createSkinnedAsset(['Selected', 'Unselected'])],
      ['test:asset/hat@1.0.0', () => { const g = new Group(); g.name = 'Hat'; return g; }],
      ['test:asset/cap@1.0.0', () => { const g = new Group(); g.name = 'Cap'; return g; }],
      ['test:asset/fitted@1.0.0', () => createSkinnedAsset(['Fitted'], ['fit.loose'])],
      ['test:asset/hair@1.0.0', createHairAsset],
    ]);
  }

  async load(ref) {
    const factory = this.factories.get(`${ref.id}@${ref.version}`);
    if (!factory) throw new Error(`Missing test asset ${ref.id}@${ref.version}`);
    const root = factory();
    return { root, dispose: () => { root.userData.disposed = true; } };
  }
}

function createFamily(version, extra = {}) {
  return {
    id: refs.family.id,
    version,
    rig: refs.rig,
    body: {
      asset: refs.body,
      meshNode: 'Body',
      regions: [
        { id: 'torso.upper', indexOffset: 0, indexCount: 3 },
        { id: 'head', indexOffset: 3, indexCount: 3 },
      ],
    },
    sockets: [{ id: 'head.top', bone: 'head' }],
    // One node owned by two surfaces: aggregation must be per object.
    occlusionSurfaces: { 'hair.top': ['HairTop'], 'hair.all': ['HairTop'] },
    materialChannels: [
      { id: 'skin', targets: [{ meshNode: 'Body' }], properties: ['color', 'roughness'] },
    ],
    face: {
      morphBindings: FACE_MORPHS.map((target) => ({ channel: `face.${target}`, target, meshNode: 'Body' })),
      expressions: [
        { id: 'happy', channels: { 'face.smile': 1 } },
        { id: 'talking', channels: { 'face.jawOpen': 0.2 } },
      ],
      visemes: [
        { id: 'aa', channels: { 'face.jawOpen': 0.8 } },
        { id: 'oh', channels: { 'face.mouthO': 0.9 } },
      ],
    },
    ...extra,
  };
}

// `withSuccessor` models a published catalogue where the old family version has
// been retired and only its successor remains installed.
function createRegistry({ withSuccessor = false } = {}) {
  const compatibleFamilies = withSuccessor ? [refs.familyNext] : [refs.family];
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
      { ...refs.pairAsset, uri: '/pair.glb', kind: 'wearable' },
      { ...refs.hatAsset, uri: '/hat.glb', kind: 'accessory' },
      { ...refs.capAsset, uri: '/cap.glb', kind: 'accessory' },
      { ...refs.fittedAsset, uri: '/fitted.glb', kind: 'wearable' },
      { ...refs.hairAsset, uri: '/hair.glb', kind: 'hair' },
    ],
    families: withSuccessor
      ? [createFamily('2.0.0', { supersedes: [refs.family] })]
      : [createFamily('1.0.0')],
    items: [
      {
        ...refs.shirt,
        kind: 'wearable',
        compatibility: { families: compatibleFamilies },
        render: { type: 'skinned', asset: refs.pairAsset, meshNodes: ['Selected'] },
        occupies: ['upper.base'],
        coversBody: ['torso.upper'],
      },
      {
        ...refs.hat,
        kind: 'accessory',
        compatibility: { families: compatibleFamilies },
        render: { type: 'socket', asset: refs.hatAsset, socket: 'head.top' },
        occupies: ['head.outer'],
        occludes: ['hair.top'],
      },
      {
        ...refs.cap,
        kind: 'accessory',
        compatibility: { families: compatibleFamilies },
        render: { type: 'socket', asset: refs.capAsset, socket: 'head.top' },
        occupies: ['head.base'],
        occludes: ['hair.all'],
      },
      {
        ...refs.fitted,
        kind: 'wearable',
        compatibility: { families: compatibleFamilies },
        render: { type: 'skinned', asset: refs.fittedAsset, meshNodes: ['Fitted'] },
        occupies: ['lower.base'],
        // A channel only this garment defines; the family knows nothing of it.
        morphBindings: [{ channel: 'fit.loose', target: 'fit.loose', meshNode: 'Fitted' }],
      },
      {
        ...refs.hair,
        kind: 'hair',
        compatibility: { families: compatibleFamilies },
        render: { type: 'socket', asset: refs.hairAsset, socket: 'head.top' },
        occupies: ['hair'],
        materialChannels: [{
          id: 'tint',
          targets: [{ meshNode: 'HairCards' }, { meshNode: 'HairCap' }],
          properties: ['color', 'opacity'],
        }],
      },
    ],
  });
  return registry;
}

const createRuntime = (options) => new AvatarRuntime(createRegistry(options), new TestLoader());

test('occlusion aggregates per object and never forces host visibility back on', async () => {
  const avatar = await createRuntime().create({ family: refs.family });
  const hair = avatar.root.getObjectByName('HairTop');

  // The node belongs to hair.top and hair.all; hiding either must hide it.
  await avatar.equipment.equip(refs.hat, { instanceId: 'hat' });
  assert.equal(hair.visible, false);

  await avatar.equipment.equip(refs.cap, { instanceId: 'cap' });
  assert.equal(hair.visible, false);

  // Releasing one owner must not reveal a node the other still covers.
  await avatar.equipment.unequip('cap');
  assert.equal(hair.visible, false);

  await avatar.equipment.unequip('hat');
  assert.equal(hair.visible, true);
  avatar.dispose();
});

test('occlusion restores host-owned visibility instead of forcing visible', async () => {
  const avatar = await createRuntime().create({ family: refs.family });
  const hair = avatar.root.getObjectByName('HairTop');

  // A host hides the node for its own reasons (first-person camera, isolation).
  hair.visible = false;
  await avatar.equipment.equip(refs.hat, { instanceId: 'hat' });
  await avatar.equipment.unequip('hat');
  assert.equal(hair.visible, false);
  avatar.dispose();
});

test('expressions and visemes replace rather than accumulate', async () => {
  const avatar = await createRuntime().create({ family: refs.family });
  const influence = (target) => avatar.bodyMesh.morphTargetInfluences[FACE_MORPHS.indexOf(target)];

  avatar.face.setExpression('happy');
  assert.equal(influence('smile'), 1);
  avatar.face.setExpression('talking');
  assert.equal(influence('smile'), 0);
  assert.equal(influence('jawOpen'), 0.2);

  avatar.face.setViseme('aa');
  assert.equal(influence('jawOpen'), 1);
  avatar.face.setViseme('oh');
  assert.equal(influence('jawOpen'), 0.2);
  assert.equal(influence('mouthO'), 0.9);

  avatar.face.clearExpression();
  avatar.face.clearViseme();
  assert.equal(influence('jawOpen'), 0);
  assert.equal(influence('mouthO'), 0);
  avatar.dispose();
});

test('viseme cue playback releases the mouth after the last cue', async () => {
  const avatar = await createRuntime().create({ family: refs.family });
  const jawOpen = () => avatar.bodyMesh.morphTargetInfluences[FACE_MORPHS.indexOf('jawOpen')];
  const cues = [{ startTime: 0, duration: 0.2, viseme: 'aa' }];

  avatar.face.sampleVisemeCues(cues, 0.1);
  assert.equal(jawOpen(), 0.8);
  avatar.face.sampleVisemeCues(cues, 5);
  assert.equal(jawOpen(), 0);
  assert.equal(avatar.face.viseme, undefined);
  avatar.dispose();
});

test('transient face state is never serialized into identity morphs', async () => {
  const avatar = await createRuntime().create({ family: refs.family });
  avatar.morphs.set('face.smile', 0.25);
  avatar.face.setViseme('aa');
  avatar.face.setExpression('happy');

  assert.deepEqual(avatar.serialize().body.morphs, { 'face.smile': 0.25 });
  avatar.dispose();
});

test('unselected skinned meshes are discarded instead of left orphaned', async () => {
  const avatar = await createRuntime().create({ family: refs.family });
  const item = await avatar.equipment.equip(refs.shirt, { instanceId: 'shirt' });

  assert.equal(item.root.getObjectByName('Selected').skeleton, avatar.bodyMesh.skeleton);
  assert.equal(item.root.getObjectByName('Unselected'), undefined);
  avatar.dispose();
});

test('generated instance IDs never collide with restored ones', async () => {
  const runtime = createRuntime();
  const avatar = await runtime.create({ family: refs.family });
  await avatar.equipment.equip(refs.hat);
  const state = avatar.serialize();
  assert.deepEqual(state.equipment.map((entry) => entry.instanceId), ['item-1']);

  const restored = await runtime.fromJSON(state, { strict: true });
  const added = await restored.equipment.equip(refs.cap);
  assert.notEqual(added.instanceId, 'item-1');
  assert.equal(restored.equipment.list().length, 2);
  avatar.dispose();
  restored.dispose();
});

test('generated instance IDs never take the ID of an unresolved saved item', async () => {
  const runtime = createRuntime();
  const avatar = await runtime.create({ family: refs.family });
  await avatar.equipment.equip(refs.hat);
  const saved = avatar.serialize();
  avatar.dispose();
  // Saved by a client that has an item pack this one lacks.
  saved.equipment.push({ instanceId: 'item-2', item: refs.missing });

  const restored = await runtime.fromJSON(saved);
  const shirt = await restored.equipment.equip(refs.shirt);
  assert.notEqual(shirt.instanceId, 'item-2');

  // The unresolved item is still there after the next save.
  assert.deepEqual(
    restored.serialize().equipment.map((entry) => [entry.instanceId, entry.item.id]),
    [['item-1', refs.hat.id], ['item-2', refs.missing.id], [shirt.instanceId, refs.shirt.id]],
  );
  restored.dispose();
});

test('registry definitions are immutable once installed', () => {
  const registry = createRegistry();
  const family = registry.requireFamily(refs.family);
  assert.throws(() => { family.body.meshNode = 'Mutated'; }, TypeError);
  assert.throws(() => { registry.requireItem(refs.shirt).occupies.push('lower.base'); }, TypeError);
  assert.equal(registry.requireFamily(refs.family).body.meshNode, 'Body');
});

test('a rejected appearance channel is not retained in serialized state', async () => {
  const avatar = await createRuntime().create({ family: refs.family });
  assert.throws(() => avatar.setAppearance('does.not.exist', { color: '#ff0000' }));
  assert.deepEqual(avatar.serialize().appearance, {});

  avatar.setAppearance('skin', { color: '#b87356' });
  assert.deepEqual(avatar.serialize().appearance, { skin: { color: '#b87356' } });
  avatar.dispose();
});

test('opacity keeps authored alpha blending and only adds blending below 1', async () => {
  const avatar = await createRuntime().create({ family: refs.family });
  const opaque = await avatar.equipment.equip(refs.hair, { instanceId: 'hair', appearance: { tint: { opacity: 1 } } });
  assert.equal(opaque.root.getObjectByName('HairCards').material.transparent, true);
  assert.equal(opaque.root.getObjectByName('HairCap').material.transparent, false);

  await avatar.equipment.unequip('hair');
  const sheer = await avatar.equipment.equip(refs.hair, { instanceId: 'hair', appearance: { tint: { opacity: 0.5 } } });
  assert.equal(sheer.root.getObjectByName('HairCards').material.transparent, true);
  assert.equal(sheer.root.getObjectByName('HairCap').material.transparent, true);
  avatar.dispose();
});

test('avatars do not share one index BufferAttribute instance', async () => {
  const runtime = createRuntime();
  const first = await runtime.create({ family: refs.family });
  const second = await runtime.create({ family: refs.family });
  await first.equipment.equip(refs.shirt, { instanceId: 'shirt' });
  await second.equipment.equip(refs.shirt, { instanceId: 'shirt' });

  assert.notEqual(first.bodyMesh.geometry.index, second.bodyMesh.geometry.index);
  // The expensive part (the rebuilt array) is still shared.
  assert.equal(first.bodyMesh.geometry.index.array, second.bodyMesh.geometry.index.array);
  assert.equal(second.bodyMesh.geometry.index.count, 3);

  first.dispose();
  assert.equal(second.bodyMesh.geometry.index.count, 3);
  second.dispose();

  assert.ok(BodyVisibilityController.cacheSize() > 0);
  BodyVisibilityController.clearCache();
  assert.equal(BodyVisibilityController.cacheSize(), 0);
});

test('getBounds tracks the body by default and equipment only on request', async () => {
  const avatar = await createRuntime().create({ family: refs.family });
  const bodyOnly = avatar.getBounds().size.toArray();

  const plume = new Mesh(
    new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 9, 0, 4, 0, 0], 3)),
    new MeshStandardMaterial(),
  );
  avatar.sockets.attach('head.top', plume);

  assert.deepEqual(avatar.getBounds().size.toArray(), bodyOnly);
  assert.notDeepEqual(avatar.getBounds({ includeEquipment: true }).size.toArray(), bodyOnly);
  avatar.dispose();
});

test('getBounds follows morph influences and skips the recompute when none moved', async () => {
  const avatar = await createRuntime().create({ family: refs.family });
  const geometry = avatar.bodyMesh.geometry;
  // Give jawOpen a real shape: it lifts the top vertex by one unit.
  geometry.morphTargetsRelative = true;
  geometry.morphAttributes.position[FACE_MORPHS.indexOf('jawOpen')].setY(5, 1);
  const rest = avatar.getBounds().size.y;

  avatar.morphs.set('face.jawOpen', 1);
  assert.equal(avatar.getBounds().size.y, rest + 1);
  assert.equal(avatar.getBounds({ includeEquipment: true }).size.y, rest + 1);

  let recomputed = 0;
  const compute = avatar.bodyMesh.computeBoundingBox;
  avatar.bodyMesh.computeBoundingBox = function () {
    recomputed += 1;
    return compute.call(this);
  };
  avatar.getBounds();
  assert.equal(recomputed, 0);

  avatar.morphs.set('face.jawOpen', 0);
  assert.equal(avatar.getBounds().size.y, rest);
  assert.equal(recomputed, 1);
  avatar.dispose();
});

test('a newer family version loads avatars saved against the version it supersedes', async () => {
  const legacyRuntime = createRuntime();
  const avatar = await legacyRuntime.create({ family: refs.family });
  await avatar.equipment.equip(refs.shirt, { instanceId: 'shirt' });
  const saved = avatar.serialize();
  avatar.dispose();

  // The catalogue has moved on: only the successor family is installed now.
  const runtime = createRuntime({ withSuccessor: true });
  const restored = await runtime.fromJSON(saved, { strict: true });
  assert.deepEqual(restored.family.version, '2.0.0');
  assert.deepEqual(restored.serialize().family, refs.familyNext);
  assert.equal(restored.equipment.list().length, 1);
  restored.dispose();
});

test('retired channels and unresolvable items survive a load/save round trip', async () => {
  const runtime = createRuntime();
  const avatar = await runtime.create({ family: refs.family });
  await avatar.equipment.equip(refs.hat, { instanceId: 'hat' });
  const saved = avatar.serialize();
  avatar.dispose();

  saved.body.morphs['body.retiredChannel'] = 0.5;
  saved.appearance['retiredChannel'] = { color: '#123456' };
  saved.equipment.unshift({ instanceId: 'gone', item: refs.missing });

  const issues = [];
  const restored = await runtime.create({
    family: refs.family,
    state: saved,
    onStateIssue: (issue) => issues.push(issue),
  });

  assert.deepEqual(issues.map((issue) => issue.kind).sort(), ['appearance', 'equipment', 'morph']);
  assert.equal(restored.equipment.list().length, 1);

  // Nothing the current family could not apply is lost, and order is preserved.
  const reserialized = restored.serialize();
  assert.equal(reserialized.body.morphs['body.retiredChannel'], 0.5);
  assert.deepEqual(reserialized.appearance['retiredChannel'], { color: '#123456' });
  assert.deepEqual(reserialized.equipment.map((entry) => entry.instanceId), ['gone', 'hat']);
  restored.dispose();
});

test('strict restore refuses state the current family cannot fully apply', async () => {
  const runtime = createRuntime();
  const avatar = await runtime.create({ family: refs.family });
  const saved = avatar.serialize();
  avatar.dispose();
  saved.body.morphs['body.retiredChannel'] = 0.5;

  await assert.rejects(
    () => runtime.create({ family: refs.family, state: saved, strict: true }),
    /body\.retiredChannel/,
  );
});

test('morph channels only an equipped item defines restore with that item', async () => {
  const runtime = createRuntime();
  const avatar = await runtime.create({ family: refs.family });
  await avatar.equipment.equip(refs.fitted, { instanceId: 'fitted' });
  avatar.morphs.set('fit.loose', 0.6);
  const saved = avatar.serialize();
  avatar.dispose();

  // An avatar's own save must restore strictly.
  const restored = await runtime.fromJSON(saved, { strict: true });
  const fitted = restored.equipment.list()[0].root.getObjectByName('Fitted');
  assert.equal(fitted.morphTargetInfluences[0], 0.6);
  assert.deepEqual(restored.serialize(), saved);
  restored.dispose();

  const issues = [];
  const tolerant = await runtime.fromJSON(saved, { onStateIssue: (issue) => issues.push(issue) });
  assert.deepEqual(issues, []);
  assert.equal(tolerant.getResidualState(), undefined);
  tolerant.dispose();
});

test('family validation rejects self-supersession and duplicate sockets', () => {
  const registry = new AvatarAssetRegistry();
  const install = (family) => () => registry.install({
    id: `test:pack/${family.version}`,
    version: family.version,
    rigs: [{
      ...refs.rig,
      upAxis: '+Y',
      forwardAxis: '-Z',
      handedness: 'right',
      unitsPerMeter: 1,
      referencePose: 'T',
      rootMotionBone: 'hips',
      bones: [{ id: 'hips', aliases: ['mixamorig:Hips'], required: true }],
    }],
    assets: [{ ...refs.body, uri: '/body.glb' }],
    families: [family],
  });

  assert.throws(install(createFamily('9.0.0', {
    supersedes: [{ id: refs.family.id, version: '9.0.0' }],
  })), /supersede itself/);

  assert.throws(install(createFamily('9.1.0', {
    sockets: [{ id: 'head.top', bone: 'head' }, { id: 'head.top', bone: 'head' }],
  })), /duplicate socket/);
});

test('facial profiles cannot reference unbound morph channels', async () => {
  const registry = new AvatarAssetRegistry();
  registry.install({
    id: 'test:pack/broken-face',
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
    assets: [{ ...refs.body, uri: '/body.glb' }],
    families: [createFamily('1.0.0', {
      face: {
        morphBindings: [{ channel: 'face.smile', target: 'smile', meshNode: 'Body' }],
        expressions: [{ id: 'broken', channels: { 'face.notBound': 1 } }],
      },
    })],
  });

  const runtime = new AvatarRuntime(registry, new TestLoader());
  await assert.rejects(() => runtime.create({ family: refs.family }), /unbound morph channel/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AVATAR_SCHEMA,
  AVATAR_SCHEMA_VERSION,
  AvatarAssetRegistry,
  AvatarRegistryError,
  AvatarSerializer,
  AvatarValidationError,
} from '../dist/index.js';

const FAMILY = { id: 'test:family/human', version: '1.0.0' };

test('AvatarSerializer round-trips deterministic versioned state', () => {
  const serializer = new AvatarSerializer();
  const state = {
    schema: AVATAR_SCHEMA,
    schemaVersion: AVATAR_SCHEMA_VERSION,
    family: FAMILY,
    body: { scale: 1.1, morphs: { muscularity: 0.4 } },
    appearance: { skin: { color: '#884422', roughness: 0.7 } },
    equipment: [
      {
        instanceId: 'shirt',
        item: { id: 'test:item/shirt', version: '1.0.0' },
        appearance: { primary: { color: '#112233' } },
      },
    ],
  };

  const parsed = serializer.parse(serializer.stringify(state));
  assert.deepEqual(parsed, state);
});

test('AvatarSerializer rejects duplicate equipment instance IDs', () => {
  const serializer = new AvatarSerializer();
  const state = serializer.createEmpty(FAMILY);
  state.equipment = [
    { instanceId: 'same', item: { id: 'test:item/a', version: '1.0.0' } },
    { instanceId: 'same', item: { id: 'test:item/b', version: '1.0.0' } },
  ];
  assert.throws(() => serializer.parse(state), AvatarValidationError);
});

test('AvatarAssetRegistry installs packs atomically and requires exact versions', () => {
  const registry = new AvatarAssetRegistry();
  registry.install({
    id: 'test:pack/core',
    version: '1.0.0',
    assets: [{ id: 'test:asset/body', version: '1.0.0', uri: '/body.glb', kind: 'body' }],
  });

  assert.equal(registry.requireAsset({ id: 'test:asset/body', version: '1.0.0' }).uri, '/body.glb');
  assert.throws(
    () => registry.requireAsset({ id: 'test:asset/body', version: '2.0.0' }),
    AvatarRegistryError,
  );
  assert.throws(
    () => registry.install({
      id: 'test:pack/duplicate',
      version: '1.0.0',
      assets: [{ id: 'test:asset/body', version: '1.0.0', uri: '/different.glb' }],
    }),
    AvatarRegistryError,
  );
});

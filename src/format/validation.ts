import { AVATAR_SCHEMA, AVATAR_SCHEMA_VERSION } from './constants.js';
import type {
  AvatarAppearanceValue,
  AvatarFamilyDefinition,
  AvatarItemDefinition,
  AvatarRigDefinition,
  AvatarStateV1,
  BodyRegionDefinition,
  VersionedId,
} from './types.js';

export class AvatarValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'AvatarValidationError';
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new AvatarValidationError(path, 'expected an object');
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AvatarValidationError(path, 'expected a non-empty string');
  }
  return value;
}

function optionalFiniteNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AvatarValidationError(path, 'expected a finite number');
  }
  return value;
}

export function versionedKey(value: VersionedId): string {
  return `${value.id}@${value.version}`;
}

export function parseVersionedId(value: unknown, path = '$'): VersionedId {
  const object = requireRecord(value, path);
  return {
    id: requireString(object['id'], `${path}.id`),
    version: requireString(object['version'], `${path}.version`),
  };
}

function parseAppearanceValue(value: unknown, path: string): AvatarAppearanceValue {
  const object = requireRecord(value, path);
  const result: AvatarAppearanceValue = {};

  if (object['color'] !== undefined) result.color = requireString(object['color'], `${path}.color`);
  if (object['emissive'] !== undefined) result.emissive = requireString(object['emissive'], `${path}.emissive`);

  const emissiveIntensity = optionalFiniteNumber(object['emissiveIntensity'], `${path}.emissiveIntensity`);
  const roughness = optionalFiniteNumber(object['roughness'], `${path}.roughness`);
  const metalness = optionalFiniteNumber(object['metalness'], `${path}.metalness`);
  const opacity = optionalFiniteNumber(object['opacity'], `${path}.opacity`);

  if (emissiveIntensity !== undefined) result.emissiveIntensity = emissiveIntensity;
  if (roughness !== undefined) result.roughness = roughness;
  if (metalness !== undefined) result.metalness = metalness;
  if (opacity !== undefined) result.opacity = opacity;

  return result;
}

function parseAppearanceMap(value: unknown, path: string): Record<string, AvatarAppearanceValue> {
  const object = requireRecord(value, path);
  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [key, parseAppearanceValue(entry, `${path}.${key}`)]),
  );
}

function parseNumberMap(value: unknown, path: string): Record<string, number> {
  const object = requireRecord(value, path);
  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => {
      if (typeof entry !== 'number' || !Number.isFinite(entry)) {
        throw new AvatarValidationError(`${path}.${key}`, 'expected a finite number');
      }
      return [key, entry];
    }),
  );
}

export function parseAvatarState(value: unknown): AvatarStateV1 {
  const object = requireRecord(value, '$');
  if (object['schema'] !== AVATAR_SCHEMA) {
    throw new AvatarValidationError('$.schema', `expected "${AVATAR_SCHEMA}"`);
  }
  if (object['schemaVersion'] !== AVATAR_SCHEMA_VERSION) {
    throw new AvatarValidationError('$.schemaVersion', `unsupported schema version ${String(object['schemaVersion'])}`);
  }

  const body = requireRecord(object['body'], '$.body');
  const equipmentValue = object['equipment'];
  if (!Array.isArray(equipmentValue)) {
    throw new AvatarValidationError('$.equipment', 'expected an array');
  }

  const instanceIds = new Set<string>();
  const equipment = equipmentValue.map((entry, index) => {
    const path = `$.equipment[${index}]`;
    const item = requireRecord(entry, path);
    const instanceId = requireString(item['instanceId'], `${path}.instanceId`);
    if (instanceIds.has(instanceId)) {
      throw new AvatarValidationError(`${path}.instanceId`, `duplicate instance ID "${instanceId}"`);
    }
    instanceIds.add(instanceId);

    return {
      instanceId,
      item: parseVersionedId(item['item'], `${path}.item`),
      ...(item['appearance'] === undefined
        ? {}
        : { appearance: parseAppearanceMap(item['appearance'], `${path}.appearance`) }),
    };
  });

  const scale = optionalFiniteNumber(body['scale'], '$.body.scale');
  if (scale !== undefined && scale <= 0) {
    throw new AvatarValidationError('$.body.scale', 'must be greater than zero');
  }

  return {
    schema: AVATAR_SCHEMA,
    schemaVersion: AVATAR_SCHEMA_VERSION,
    family: parseVersionedId(object['family'], '$.family'),
    body: {
      ...(scale === undefined ? {} : { scale }),
      morphs: parseNumberMap(body['morphs'], '$.body.morphs'),
    },
    appearance: parseAppearanceMap(object['appearance'], '$.appearance'),
    equipment,
    ...(object['metadata'] === undefined
      ? {}
      : { metadata: { ...requireRecord(object['metadata'], '$.metadata') } }),
  };
}

export function validateBodyRegions(regions: BodyRegionDefinition[], indexCount: number): void {
  if (regions.length === 0) {
    throw new AvatarValidationError('family.body.regions', 'at least one region is required');
  }

  const ids = new Set<string>();
  const sorted = [...regions].sort((a, b) => a.indexOffset - b.indexOffset);
  let cursor = 0;

  for (const [index, region] of sorted.entries()) {
    if (!region.id) throw new AvatarValidationError(`family.body.regions[${index}].id`, 'must not be empty');
    if (ids.has(region.id)) {
      throw new AvatarValidationError(`family.body.regions[${index}].id`, `duplicate region "${region.id}"`);
    }
    ids.add(region.id);

    if (!Number.isInteger(region.indexOffset) || region.indexOffset < 0 || region.indexOffset % 3 !== 0) {
      throw new AvatarValidationError(`family.body.regions[${index}].indexOffset`, 'must be a non-negative triangle-aligned integer');
    }
    if (!Number.isInteger(region.indexCount) || region.indexCount <= 0 || region.indexCount % 3 !== 0) {
      throw new AvatarValidationError(`family.body.regions[${index}].indexCount`, 'must be a positive triangle-aligned integer');
    }
    if (region.indexOffset !== cursor) {
      throw new AvatarValidationError(`family.body.regions[${index}]`, `expected contiguous index offset ${cursor}`);
    }
    cursor += region.indexCount;
  }

  if (cursor !== indexCount) {
    throw new AvatarValidationError('family.body.regions', `regions cover ${cursor} indices but body has ${indexCount}`);
  }
}

export function validateRigDefinition(rig: AvatarRigDefinition): void {
  parseVersionedId(rig, 'rig');
  if (rig.unitsPerMeter <= 0 || !Number.isFinite(rig.unitsPerMeter)) {
    throw new AvatarValidationError('rig.unitsPerMeter', 'must be greater than zero');
  }
  const ids = new Set<string>();
  for (const bone of rig.bones) {
    if (!bone.id) throw new AvatarValidationError('rig.bones', 'bone IDs must not be empty');
    if (ids.has(bone.id)) throw new AvatarValidationError('rig.bones', `duplicate semantic bone "${bone.id}"`);
    ids.add(bone.id);
    if (bone.aliases.length === 0) {
      throw new AvatarValidationError(`rig.bones.${bone.id}`, 'at least one alias is required');
    }
  }
  if (!ids.has(rig.rootMotionBone)) {
    throw new AvatarValidationError('rig.rootMotionBone', 'must reference a semantic bone in this rig');
  }
}

export function validateFamilyDefinition(family: AvatarFamilyDefinition): void {
  parseVersionedId(family, 'family');
  parseVersionedId(family.rig, 'family.rig');
  parseVersionedId(family.body.asset, 'family.body.asset');
  if (!family.body.meshNode) throw new AvatarValidationError('family.body.meshNode', 'must not be empty');
  if (family.head) {
    if (!family.head.meshNode) throw new AvatarValidationError('family.head.meshNode', 'must not be empty');
    if (family.head.meshNode === family.body.meshNode) {
      throw new AvatarValidationError('family.head.meshNode', 'must be different from family.body.meshNode');
    }
    if (family.head.neckSeamVertexGroup !== undefined && !family.head.neckSeamVertexGroup) {
      throw new AvatarValidationError('family.head.neckSeamVertexGroup', 'must not be empty');
    }
  }
  for (const [index, superseded] of (family.supersedes ?? []).entries()) {
    parseVersionedId(superseded, `family.supersedes[${index}]`);
    if (versionedKey(superseded) === versionedKey(family)) {
      throw new AvatarValidationError(`family.supersedes[${index}]`, 'a family cannot supersede itself');
    }
  }

  const regionIds = new Set<string>();
  for (const region of family.body.regions) {
    if (!region.id || regionIds.has(region.id)) {
      throw new AvatarValidationError('family.body.regions', `invalid or duplicate region "${region.id}"`);
    }
    regionIds.add(region.id);
  }

  const socketIds = new Set<string>();
  for (const socket of family.sockets ?? []) {
    if (!socket.id || socketIds.has(socket.id)) {
      throw new AvatarValidationError('family.sockets', `invalid or duplicate socket "${socket.id}"`);
    }
    socketIds.add(socket.id);
  }

  const materialChannelIds = new Set<string>();
  for (const channel of family.materialChannels ?? []) {
    if (!channel.id || materialChannelIds.has(channel.id)) {
      throw new AvatarValidationError('family.materialChannels', `invalid or duplicate channel "${channel.id}"`);
    }
    materialChannelIds.add(channel.id);
  }


  const morphChannels = new Set<string>();
  for (const [path, bindings] of [
    ['family.morphBindings', family.morphBindings ?? []],
    ['family.face.morphBindings', family.face?.morphBindings ?? []],
  ] as const) {
    for (const binding of bindings) {
      if (!binding.channel) throw new AvatarValidationError(path, 'morph channel IDs must not be empty');
      if (!binding.target) throw new AvatarValidationError(path, `channel "${binding.channel}" must name a target`);
      const bindingKey = `${binding.meshNode ?? '*'}:${binding.channel}`;
      if (morphChannels.has(bindingKey)) {
        throw new AvatarValidationError(path, `duplicate binding for channel "${binding.channel}" on mesh "${binding.meshNode ?? '*'}"`);
      }
      morphChannels.add(bindingKey);
    }
  }

  for (const channel of Object.keys(family.defaultMorphs ?? {})) {
    const isBound = [...(family.morphBindings ?? []), ...(family.face?.morphBindings ?? [])]
      .some((binding) => binding.channel === channel);
    if (!isBound) {
      throw new AvatarValidationError('family.defaultMorphs', `channel "${channel}" has no morph binding`);
    }
  }
}

export function validateItemDefinition(item: AvatarItemDefinition): void {
  parseVersionedId(item, 'item');
  if (item.compatibility.families.length === 0) {
    throw new AvatarValidationError('item.compatibility.families', 'at least one compatible family is required');
  }
  if (item.occupies.length === 0) {
    throw new AvatarValidationError('item.occupies', 'at least one occupancy channel is required');
  }
  parseVersionedId(item.render.asset, 'item.render.asset');
  if (item.render.type === 'socket' && !item.render.socket) {
    throw new AvatarValidationError('item.render.socket', 'must not be empty');
  }
}

import { Group, Object3D, Quaternion, Vector3 } from 'three';
import type { AvatarSocketDefinition, SerializableTransform } from '../format/types.js';
import type { AvatarRig } from './AvatarRig.js';

function applyTransform(object: Object3D, transform?: SerializableTransform): void {
  const position = transform?.position;
  const rotation = transform?.rotation;
  const scale = transform?.scale;
  object.position.copy(position ? new Vector3(...position) : new Vector3());
  object.quaternion.copy(rotation ? new Quaternion(...rotation) : new Quaternion());
  object.scale.copy(scale ? new Vector3(...scale) : new Vector3(1, 1, 1));
}

export class AvatarSocketController {
  private readonly sockets = new Map<string, Group>();

  constructor(rig: AvatarRig, definitions: readonly AvatarSocketDefinition[]) {
    for (const definition of definitions) {
      if (this.sockets.has(definition.id)) throw new Error(`Duplicate avatar socket "${definition.id}"`);
      const socket = new Group();
      socket.name = `AvatarSocket:${definition.id}`;
      applyTransform(socket, definition);
      rig.requireBone(definition.bone).add(socket);
      this.sockets.set(definition.id, socket);
    }
  }

  get(id: string): Group | undefined {
    return this.sockets.get(id);
  }

  require(id: string): Group {
    const socket = this.get(id);
    if (!socket) throw new Error(`Avatar socket "${id}" is not defined`);
    return socket;
  }

  attach(id: string, object: Object3D, transform?: SerializableTransform): void {
    const socket = this.require(id);
    socket.add(object);
    applyTransform(object, transform);
  }

  detach(object: Object3D): void {
    object.removeFromParent();
  }

  dispose(): void {
    for (const socket of this.sockets.values()) socket.removeFromParent();
    this.sockets.clear();
  }
}

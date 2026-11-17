import { Color, Material, Mesh, Object3D } from 'three';
import type {
  AvatarAppearanceValue,
  AvatarMaterialProperty,
  MaterialChannelDefinition,
} from '../format/types.js';

interface MaterialBinding {
  material: Material & Record<string, unknown>;
  properties: Set<AvatarMaterialProperty>;
  /** Alpha blending the asset authored (hair cards, lashes); opacity never turns it off. */
  authoredTransparent: boolean;
}

function asColor(value: unknown): Color | undefined {
  return value instanceof Color ? value : undefined;
}

export class AppearanceController {
  private readonly bindings = new Map<string, MaterialBinding[]>();
  private readonly values = new Map<string, AvatarAppearanceValue>();
  private readonly materialsByScope = new Map<string, Set<Material>>();

  bind(root: Object3D, definitions: readonly MaterialChannelDefinition[], scope: string): void {
    const prepared = new Map<Mesh, Material[]>();
    const authoredTransparent = new Map<Material, boolean>();

    const prepareMesh = (mesh: Mesh): Material[] => {
      const existing = prepared.get(mesh);
      if (existing) return existing;
      const source = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const cloned = source.map((material) => material.clone());
      mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0]!;
      prepared.set(mesh, cloned);
      for (const material of cloned) authoredTransparent.set(material, material.transparent);
      const scopeMaterials = this.materialsByScope.get(scope) ?? new Set<Material>();
      for (const material of cloned) scopeMaterials.add(material);
      this.materialsByScope.set(scope, scopeMaterials);
      return cloned;
    };

    for (const definition of definitions) {
      const scopedChannel = this.scoped(scope, definition.id);
      const resolved: MaterialBinding[] = [];

      for (const target of definition.targets) {
        root.traverse((object) => {
          const mesh = object as Mesh;
          if (!mesh.isMesh || (target.meshNode && mesh.name !== target.meshNode)) return;
          const materials = prepareMesh(mesh);
          materials.forEach((material, index) => {
            if (target.materialIndex !== undefined && target.materialIndex !== index) return;
            if (target.materialName && material.name !== target.materialName) return;
            resolved.push({
              material: material as Material & Record<string, unknown>,
              properties: new Set(definition.properties),
              authoredTransparent: authoredTransparent.get(material) ?? false,
            });
          });
        });
      }

      if (resolved.length === 0) {
        throw new Error(`Material channel "${definition.id}" did not match any materials in scope "${scope}"`);
      }
      this.bindings.set(scopedChannel, resolved);
      const existingValue = this.values.get(scopedChannel);
      if (existingValue) this.applyResolved(scopedChannel, existingValue);
    }
  }

  apply(scope: string, channel: string, value: AvatarAppearanceValue): void {
    const scopedChannel = this.scoped(scope, channel);
    // Applied first: a rejected channel must not survive into serialized state.
    this.applyResolved(scopedChannel, value);
    this.values.set(scopedChannel, structuredClone(value));
  }

  applyMany(scope: string, values: Record<string, AvatarAppearanceValue>): void {
    for (const [channel, value] of Object.entries(values)) this.apply(scope, channel, value);
  }

  hasChannel(scope: string, channel: string): boolean {
    return this.bindings.has(this.scoped(scope, channel));
  }

  listChannels(scope: string): string[] {
    const prefix = `${scope}:`;
    return [...this.bindings.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }

  getValues(scope: string): Record<string, AvatarAppearanceValue> {
    const prefix = `${scope}:`;
    return Object.fromEntries(
      [...this.values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key.slice(prefix.length), structuredClone(value)]),
    );
  }

  unbindScope(scope: string): void {
    const prefix = `${scope}:`;
    for (const key of [...this.bindings.keys()]) {
      if (key.startsWith(prefix)) this.bindings.delete(key);
    }
    for (const key of [...this.values.keys()]) {
      if (key.startsWith(prefix)) this.values.delete(key);
    }
    for (const material of this.materialsByScope.get(scope) ?? []) material.dispose();
    this.materialsByScope.delete(scope);
  }

  dispose(): void {
    for (const scope of [...this.materialsByScope.keys()]) this.unbindScope(scope);
    this.bindings.clear();
    this.values.clear();
  }

  private applyResolved(scopedChannel: string, value: AvatarAppearanceValue): void {
    const bindings = this.bindings.get(scopedChannel);
    if (!bindings) throw new Error(`Unknown material channel "${scopedChannel}"`);

    for (const binding of bindings) {
      const material = binding.material;
      if (value.color !== undefined && binding.properties.has('color')) {
        asColor(material['color'])?.set(value.color);
      }
      if (value.emissive !== undefined && binding.properties.has('emissive')) {
        asColor(material['emissive'])?.set(value.emissive);
      }
      for (const property of ['emissiveIntensity', 'roughness', 'metalness', 'opacity'] as const) {
        const propertyValue = value[property];
        if (propertyValue !== undefined && binding.properties.has(property)) material[property] = propertyValue;
      }
      if (value.opacity !== undefined && binding.properties.has('opacity')) {
        material['transparent'] = binding.authoredTransparent || value.opacity < 1;
      }
      material.needsUpdate = true;
    }
  }

  private scoped(scope: string, channel: string): string {
    return `${scope}:${channel}`;
  }
}

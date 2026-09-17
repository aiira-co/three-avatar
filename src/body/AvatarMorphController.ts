import { Object3D, SkinnedMesh } from 'three';
import type { MorphBindingDefinition, MorphChannelId } from '../format/types.js';

interface ResolvedMorphBinding {
  scope: string;
  mesh: SkinnedMesh;
  index: number;
  min: number;
  max: number;
}

/**
 * Persistent identity layer. Only this layer is serialized; expression,
 * viseme, and tracking layers are transient runtime state.
 */
export const MORPH_BASE_LAYER = 'base';

/**
 * Additive morph mixer.
 *
 * Every channel's effective value is the sum of its per-layer contributions,
 * clamped to the binding's declared range. Replacing a layer clears the
 * channels that layer no longer drives, so switching expressions or visemes
 * cannot accumulate stale weights.
 */
export class AvatarMorphController {
  private readonly bindings = new Map<MorphChannelId, ResolvedMorphBinding[]>();
  private readonly layers = new Map<string, Map<MorphChannelId, number>>();

  bind(root: Object3D, definitions: readonly MorphBindingDefinition[], scope: string): void {
    for (const definition of definitions) {
      let found = false;
      root.traverse((object) => {
        const mesh = object as SkinnedMesh;
        if (!mesh.isSkinnedMesh || !mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return;
        if (definition.meshNode && mesh.name !== definition.meshNode) return;
        const index = mesh.morphTargetDictionary[definition.target];
        if (index === undefined) return;
        found = true;
        const entries = this.bindings.get(definition.channel) ?? [];
        entries.push({
          scope,
          mesh,
          index,
          min: definition.min ?? 0,
          max: definition.max ?? 1,
        });
        this.bindings.set(definition.channel, entries);
      });
      if (!found) {
        throw new Error(`Morph target "${definition.target}" for channel "${definition.channel}" was not found`);
      }
    }

    // Newly bound meshes must adopt the avatar's current values.
    for (const channel of this.bindings.keys()) this.apply(channel);
  }

  unbindScope(scope: string): void {
    for (const [channel, entries] of this.bindings) {
      const remaining = entries.filter((entry) => entry.scope !== scope);
      if (remaining.length > 0) this.bindings.set(channel, remaining);
      else this.bindings.delete(channel);
    }
  }

  set(channel: MorphChannelId, value: number): void {
    if (!Number.isFinite(value)) throw new Error(`Morph channel "${channel}" requires a finite number`);
    if (!this.bindings.has(channel)) {
      throw new Error(`Morph channel "${channel}" is not defined by the avatar family`);
    }
    this.layer(MORPH_BASE_LAYER).set(channel, value);
    this.apply(channel);
  }

  setMany(values: Record<MorphChannelId, number>): void {
    for (const [channel, value] of Object.entries(values)) this.set(channel, value);
  }

  has(channel: MorphChannelId): boolean {
    return this.bindings.has(channel);
  }

  listChannels(): MorphChannelId[] {
    return [...this.bindings.keys()];
  }

  /**
   * Replaces one transient layer wholesale. Channels the previous contents
   * drove but the new contents do not are released. Unknown channels are
   * ignored so a layer can be authored once and reused across families.
   */
  setLayer(layer: string, values: Record<MorphChannelId, number>): void {
    if (layer === MORPH_BASE_LAYER) throw new Error('The base morph layer is written through set()/setMany()');
    const previous = this.layers.get(layer);
    const next = new Map<MorphChannelId, number>();
    for (const [channel, value] of Object.entries(values)) {
      if (!this.bindings.has(channel) || !Number.isFinite(value)) continue;
      next.set(channel, value);
    }

    const touched = new Set<MorphChannelId>([...(previous?.keys() ?? []), ...next.keys()]);
    if (next.size > 0) this.layers.set(layer, next);
    else this.layers.delete(layer);
    for (const channel of touched) this.apply(channel);
  }

  clearLayer(layer: string): void {
    if (layer === MORPH_BASE_LAYER) throw new Error('The base morph layer cannot be cleared');
    const previous = this.layers.get(layer);
    if (!previous) return;
    this.layers.delete(layer);
    for (const channel of previous.keys()) this.apply(channel);
  }

  listLayers(): string[] {
    return [...this.layers.keys()].filter((layer) => layer !== MORPH_BASE_LAYER);
  }

  /** Persistent identity values only. Transient layers are never serialized. */
  getValues(): Record<MorphChannelId, number> {
    return Object.fromEntries(this.layers.get(MORPH_BASE_LAYER) ?? []);
  }

  /** Effective value currently driving the meshes, across every layer. */
  getEffectiveValue(channel: MorphChannelId): number {
    let total = 0;
    for (const values of this.layers.values()) total += values.get(channel) ?? 0;
    return total;
  }

  private layer(name: string): Map<MorphChannelId, number> {
    const existing = this.layers.get(name);
    if (existing) return existing;
    const created = new Map<MorphChannelId, number>();
    this.layers.set(name, created);
    return created;
  }

  private apply(channel: MorphChannelId): void {
    const value = this.getEffectiveValue(channel);
    for (const binding of this.bindings.get(channel) ?? []) {
      const clamped = Math.max(binding.min, Math.min(binding.max, value));
      binding.mesh.morphTargetInfluences![binding.index] = clamped;
    }
  }
}

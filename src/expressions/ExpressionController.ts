import { Mesh } from 'three';
import { FACE_EXPRESSION_LAYER } from '../face/AvatarFaceController.js';
import { EXPRESSION_MOOD_METADATA_KEY } from '../format/constants.js';
import type {
  AvatarMoodState,
  ExpressionOverlayCue,
  ExpressionPresetDefinition,
} from '../format/types.js';
import { setMorphTargetInfluence } from '../layering/SpatialMeshIndex.js';
import type { AvatarInstance } from '../runtime/AvatarInstance.js';
import { BUILTIN_EXPRESSION_PRESETS } from './ExpressionPresets.js';

export interface ExpressionFrameOutput {
  channels: Record<string, number>;
  headTiltDeg: [number, number, number];
  gaze: [number, number];
  pupilScale: number;
  blinkRateMultiplier: number;
  eyeSymbol: 'classic' | 'heart' | 'star';
  overlays: { id: ExpressionOverlayCue; weight: number }[];
  activeReaction?: string;
}

export interface TriggerReactionOptions {
  intensity?: number;
  attack?: number;
  hold?: number;
  release?: number;
}

export interface ExpressionControllerOptions {
  avatar?: AvatarInstance;
  targets?: Mesh[];
  presets?: readonly ExpressionPresetDefinition[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge0 ? 1 : 0;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function normalizeMoodState(raw: unknown): AvatarMoodState | undefined {
  if (!isRecord(raw)) return undefined;
  const mood = typeof raw['mood'] === 'string' ? raw['mood'].trim() : '';
  if (!mood || mood === 'neutral') return undefined;
  const rawIntensity = raw['intensity'];
  const intensity =
    typeof rawIntensity === 'number' && Number.isFinite(rawIntensity)
      ? Math.max(0.05, Math.min(1, Math.round(rawIntensity * 100) / 100))
      : 1;
  return intensity === 1 ? { mood } : { mood, intensity };
}

export function readMoodState(avatar: AvatarInstance): AvatarMoodState {
  const parsed = normalizeMoodState(avatar.serialize().metadata?.[EXPRESSION_MOOD_METADATA_KEY]);
  return parsed ?? { mood: 'neutral', intensity: 1 };
}

export function writeMoodState(
  avatar: AvatarInstance,
  state: AvatarMoodState | undefined,
): AvatarMoodState | undefined {
  const normalized = normalizeMoodState(state);
  const current = avatar.serialize().metadata ?? {};
  const next: Record<string, unknown> = { ...current };
  if (!normalized) {
    delete next[EXPRESSION_MOOD_METADATA_KEY];
  } else {
    next[EXPRESSION_MOOD_METADATA_KEY] = normalized;
  }
  avatar.setMetadata(Object.keys(next).length > 0 ? next : undefined);
  return normalized;
}

interface ActiveReactionState {
  id: string;
  intensity: number;
  elapsed: number;
  attack: number;
  hold: number;
  release: number;
}

/**
 * Runtime facial mood and chat/game reaction controller.
 *
 * Smoothly blends persistent social moods (`setMood` / `setMoodMix`) with one-shot reaction
 * envelopes (`triggerReaction`), drives `FACE_EXPRESSION_LAYER` + procedural expression morphs,
 * and outputs secondary gaze, pupil scale, blink multiplier, head tilt, and stylized cue overlays.
 */
export class ExpressionController {
  private readonly presets = new Map<string, ExpressionPresetDefinition>();
  private readonly avatar?: AvatarInstance;
  private readonly targets = new Set<Mesh>();
  private readonly currentMoodWeights = new Map<string, number>();
  private readonly targetMoodWeights = new Map<string, number>();
  private readonly appliedChannels = new Set<string>();
  private transitionSeconds = 0.25;
  private activeReaction: ActiveReactionState | undefined;

  constructor(options: ExpressionControllerOptions = {}) {
    this.avatar = options.avatar;
    for (const target of options.targets ?? []) this.targets.add(target);
    for (const preset of BUILTIN_EXPRESSION_PRESETS) this.presets.set(preset.id, preset);
    for (const preset of options.presets ?? []) this.presets.set(preset.id, preset);
  }

  addTargetMesh(mesh: Mesh): void {
    this.targets.add(mesh);
  }

  removeTargetMesh(mesh: Mesh): void {
    this.targets.delete(mesh);
  }

  registerPreset(preset: ExpressionPresetDefinition): void {
    this.presets.set(preset.id, preset);
  }

  getPreset(id: string): ExpressionPresetDefinition | undefined {
    return this.presets.get(id);
  }

  listPresets(): ExpressionPresetDefinition[] {
    return [...this.presets.values()];
  }

  setMood(moodId: string, intensity = 1, transitionSeconds = 0.25): void {
    if (!this.presets.has(moodId)) {
      throw new Error(`Unknown expression mood "${moodId}"`);
    }
    const clamped = clamp01(intensity);
    this.setMoodMix(clamped > 0 && moodId !== 'neutral' ? { [moodId]: clamped } : {}, transitionSeconds);
  }

  setMoodMix(weights: Record<string, number>, transitionSeconds = 0.25): void {
    for (const id of Object.keys(weights)) {
      if (!this.presets.has(id)) throw new Error(`Unknown expression mood "${id}"`);
    }
    this.targetMoodWeights.clear();
    for (const [id, weight] of Object.entries(weights)) {
      const clamped = clamp01(weight);
      if (clamped > 1e-4 && id !== 'neutral') {
        this.targetMoodWeights.set(id, clamped);
      }
    }
    this.transitionSeconds = Math.max(0, transitionSeconds);
    if (this.transitionSeconds === 0) {
      this.currentMoodWeights.clear();
      for (const [id, w] of this.targetMoodWeights) this.currentMoodWeights.set(id, w);
    }
  }

  clearMood(transitionSeconds = 0.2): void {
    this.setMoodMix({}, transitionSeconds);
  }

  /** Immediately settles active mood interpolation onto `targetMoodWeights`. */
  snapTransitions(): void {
    this.currentMoodWeights.clear();
    for (const [id, w] of this.targetMoodWeights) {
      this.currentMoodWeights.set(id, w);
    }
  }

  triggerReaction(moodId: string, options: TriggerReactionOptions = {}): void {
    const preset = this.presets.get(moodId);
    if (!preset) throw new Error(`Unknown expression mood "${moodId}"`);
    const fallback = preset.reactionEnvelope ?? { attack: 0.14, hold: 1.25, release: 0.4 };
    this.activeReaction = {
      id: moodId,
      intensity: clamp01(options.intensity ?? 1),
      elapsed: 0,
      attack: Math.max(0, options.attack ?? fallback.attack),
      hold: Math.max(0, options.hold ?? fallback.hold),
      release: Math.max(0, options.release ?? fallback.release),
    };
  }

  cancelReaction(): void {
    this.activeReaction = undefined;
  }

  /** Advances mood interpolation and active reaction envelopes by `dt` seconds. */
  update(dt: number): ExpressionFrameOutput {
    const step = Math.max(0, dt);

    if (this.transitionSeconds <= 1e-4) {
      this.currentMoodWeights.clear();
      for (const [id, w] of this.targetMoodWeights) this.currentMoodWeights.set(id, w);
    } else if (step > 0) {
      const rate = 4 / this.transitionSeconds;
      const alpha = 1 - Math.exp(-rate * step);
      const ids = new Set([...this.currentMoodWeights.keys(), ...this.targetMoodWeights.keys()]);
      for (const id of ids) {
        const cur = this.currentMoodWeights.get(id) ?? 0;
        const tgt = this.targetMoodWeights.get(id) ?? 0;
        let next = cur + (tgt - cur) * alpha;
        if (Math.abs(tgt - next) < 0.005) next = tgt;
        if (next < 1e-4 && tgt === 0) this.currentMoodWeights.delete(id);
        else this.currentMoodWeights.set(id, next);
      }
    }

    let reactionWeight = 0;
    let reactionPreset: ExpressionPresetDefinition | undefined;
    if (this.activeReaction) {
      this.activeReaction.elapsed += step;
      const { elapsed, attack, hold, release, intensity, id } = this.activeReaction;
      const total = attack + hold + release;
      if (elapsed >= total) {
        this.activeReaction = undefined;
      } else {
        reactionPreset = this.presets.get(id);
        if (elapsed < attack) {
          reactionWeight = attack > 0 ? smoothstep(0, attack, elapsed) * intensity : intensity;
        } else if (elapsed < attack + hold) {
          reactionWeight = intensity;
        } else {
          reactionWeight =
            release > 0 ? (1 - smoothstep(attack + hold, total, elapsed)) * intensity : 0;
        }
      }
    }

    const baseChannels: Record<string, number> = {};
    const baseTilt: [number, number, number] = [0, 0, 0];
    const baseGaze: [number, number] = [0, 0];
    let basePupil = 1;
    let baseBlinkMult = 1;
    let baseTotalWeight = 0;
    let baseSymbol: 'classic' | 'heart' | 'star' = 'classic';
    const overlayWeights = new Map<ExpressionOverlayCue, number>();

    for (const [id, weight] of this.currentMoodWeights) {
      const preset = this.presets.get(id);
      if (!preset || weight <= 0) continue;
      baseTotalWeight += weight;

      for (const [ch, val] of Object.entries(preset.channels)) {
        baseChannels[ch] = clamp01((baseChannels[ch] ?? 0) + val * weight);
      }
      if (preset.headTiltDeg) {
        baseTilt[0] += preset.headTiltDeg[0] * weight;
        baseTilt[1] += preset.headTiltDeg[1] * weight;
        baseTilt[2] += preset.headTiltDeg[2] * weight;
      }
      if (preset.eyeResponse?.gaze) {
        baseGaze[0] += preset.eyeResponse.gaze[0] * weight;
        baseGaze[1] += preset.eyeResponse.gaze[1] * weight;
      }
      if (preset.eyeResponse?.pupilScale !== undefined) {
        basePupil += (preset.eyeResponse.pupilScale - 1) * weight;
      }
      if (preset.eyeResponse?.blinkRateMultiplier !== undefined) {
        baseBlinkMult += (preset.eyeResponse.blinkRateMultiplier - 1) * weight;
      }
      if (preset.eyeResponse?.eyeSymbol && preset.eyeResponse.eyeSymbol !== 'classic' && weight >= 0.4) {
        baseSymbol = preset.eyeResponse.eyeSymbol;
      }
      for (const cue of preset.overlays ?? []) {
        overlayWeights.set(cue, Math.max(overlayWeights.get(cue) ?? 0, weight));
      }
    }
    if (baseTotalWeight > 1) {
      const inv = 1 / baseTotalWeight;
      baseTilt[0] *= inv; baseTilt[1] *= inv; baseTilt[2] *= inv;
      baseGaze[0] *= inv; baseGaze[1] *= inv;
      basePupil = 1 + (basePupil - 1) * inv;
      baseBlinkMult = 1 + (baseBlinkMult - 1) * inv;
    }

    const finalChannels: Record<string, number> = { ...baseChannels };
    const finalTilt: [number, number, number] = [...baseTilt];
    const finalGaze: [number, number] = [...baseGaze];
    let finalPupil = basePupil;
    let finalBlinkMult = baseBlinkMult;
    let finalSymbol = baseSymbol;

    if (reactionPreset && reactionWeight > 0) {
      const allChannelKeys = new Set([
        ...Object.keys(baseChannels),
        ...Object.keys(reactionPreset.channels),
      ]);
      for (const ch of allChannelKeys) {
        const b = baseChannels[ch] ?? 0;
        const r = reactionPreset.channels[ch] ?? 0;
        const blended = b + (r - b) * reactionWeight;
        if (blended > 1e-4) finalChannels[ch] = clamp01(blended);
        else delete finalChannels[ch];
      }

      const rt = reactionPreset.headTiltDeg ?? [0, 0, 0];
      finalTilt[0] += (rt[0] - finalTilt[0]) * reactionWeight;
      finalTilt[1] += (rt[1] - finalTilt[1]) * reactionWeight;
      finalTilt[2] += (rt[2] - finalTilt[2]) * reactionWeight;

      const rg = reactionPreset.eyeResponse?.gaze ?? [0, 0];
      finalGaze[0] += (rg[0] - finalGaze[0]) * reactionWeight;
      finalGaze[1] += (rg[1] - finalGaze[1]) * reactionWeight;

      const rp = reactionPreset.eyeResponse?.pupilScale ?? 1;
      finalPupil += (rp - finalPupil) * reactionWeight;

      const rb = reactionPreset.eyeResponse?.blinkRateMultiplier ?? 1;
      finalBlinkMult += (rb - finalBlinkMult) * reactionWeight;

      if (
        reactionPreset.eyeResponse?.eyeSymbol
        && reactionPreset.eyeResponse.eyeSymbol !== 'classic'
        && reactionWeight >= 0.4
      ) {
        finalSymbol = reactionPreset.eyeResponse.eyeSymbol;
      }

      for (const cue of reactionPreset.overlays ?? []) {
        overlayWeights.set(cue, Math.max(overlayWeights.get(cue) ?? 0, reactionWeight));
      }
    }

    this.applyToBindings(finalChannels);

    return {
      channels: finalChannels,
      headTiltDeg: finalTilt,
      gaze: finalGaze,
      pupilScale: finalPupil,
      blinkRateMultiplier: finalBlinkMult,
      eyeSymbol: finalSymbol,
      overlays: [...overlayWeights.entries()].map(([id, weight]) => ({ id, weight })),
      ...(reactionPreset && reactionWeight > 0 ? { activeReaction: reactionPreset.id } : {}),
    };
  }

  private applyToBindings(channels: Record<string, number>): void {
    if (this.avatar) {
      if (Object.keys(channels).length > 0) {
        this.avatar.morphs.setLayer(FACE_EXPRESSION_LAYER, channels);
      } else {
        this.avatar.morphs.clearLayer(FACE_EXPRESSION_LAYER);
      }
    }

    if (this.targets.size === 0) return;

    const touched = new Set<string>([...this.appliedChannels, ...Object.keys(channels)]);
    this.appliedChannels.clear();
    for (const ch of Object.keys(channels)) this.appliedChannels.add(ch);

    for (const ch of touched) {
      if (this.avatar?.morphs.has(ch)) continue;
      const val = channels[ch] ?? 0;
      for (const mesh of this.targets) {
        setMorphTargetInfluence(mesh, ch, val);
      }
    }
  }
}

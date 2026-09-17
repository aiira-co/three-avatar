import type { FaceProfileDefinition, VisemeCue } from '../format/types.js';
import type { AvatarMorphController } from '../body/AvatarMorphController.js';

export const FACE_EXPRESSION_LAYER = 'face.expression';
export const FACE_VISEME_LAYER = 'face.viseme';
export const FACE_TRACKING_LAYER = 'face.tracking';

function scale(channels: Record<string, number>, weight: number): Record<string, number> {
  return Object.fromEntries(Object.entries(channels).map(([channel, value]) => [channel, value * weight]));
}

/**
 * Layered face mixer over the shared morph controller.
 *
 * Identity lives in the base layer. Expressions, visemes, and external
 * tracking each own one transient layer, so setting a new expression or
 * viseme releases the previous one instead of accumulating weights.
 */
export class AvatarFaceController {
  private readonly expressions = new Map<string, Record<string, number>>();
  private readonly visemes = new Map<string, Record<string, number>>();
  private activeExpression: { id: string; weight: number } | undefined;
  private activeViseme: { id: string; weight: number } | undefined;

  constructor(
    private readonly morphs: AvatarMorphController,
    definition: FaceProfileDefinition,
  ) {
    for (const expression of definition.expressions ?? []) {
      if (this.expressions.has(expression.id)) throw new Error(`Duplicate facial expression "${expression.id}"`);
      this.assertChannelsBound(`expression "${expression.id}"`, expression.channels);
      this.expressions.set(expression.id, { ...expression.channels });
    }
    for (const viseme of definition.visemes ?? []) {
      if (this.visemes.has(viseme.id)) throw new Error(`Duplicate viseme "${viseme.id}"`);
      this.assertChannelsBound(`viseme "${viseme.id}"`, viseme.channels);
      this.visemes.set(viseme.id, { ...viseme.channels });
    }
  }

  /** Writes a persistent identity value. Use expressions/visemes for animation. */
  setMorph(channel: string, value: number): void {
    this.morphs.set(channel, value);
  }

  get expression(): string | undefined {
    return this.activeExpression?.id;
  }

  get viseme(): string | undefined {
    return this.activeViseme?.id;
  }

  listExpressions(): string[] {
    return [...this.expressions.keys()];
  }

  listVisemes(): string[] {
    return [...this.visemes.keys()];
  }

  setExpression(id: string, weight = 1): void {
    const expression = this.expressions.get(id);
    if (!expression) throw new Error(`Unknown facial expression "${id}"`);
    this.activeExpression = { id, weight };
    this.morphs.setLayer(FACE_EXPRESSION_LAYER, scale(expression, weight));
  }

  clearExpression(): void {
    this.activeExpression = undefined;
    this.morphs.clearLayer(FACE_EXPRESSION_LAYER);
  }

  setViseme(id: string, weight = 1): void {
    const viseme = this.visemes.get(id);
    if (!viseme) throw new Error(`Unknown viseme "${id}"`);
    this.activeViseme = { id, weight };
    this.morphs.setLayer(FACE_VISEME_LAYER, scale(viseme, weight));
  }

  clearViseme(): void {
    this.activeViseme = undefined;
    this.morphs.clearLayer(FACE_VISEME_LAYER);
  }

  /** Applies externally tracked channel weights, replacing the previous frame. */
  setTracking(channels: Record<string, number>): void {
    this.morphs.setLayer(FACE_TRACKING_LAYER, channels);
  }

  clearTracking(): void {
    this.morphs.clearLayer(FACE_TRACKING_LAYER);
  }

  /**
   * Drives the viseme layer from a timed cue list. The mouth is released once
   * no cue covers `time`, so playback ends in a closed rest pose.
   */
  sampleVisemeCues(cues: readonly VisemeCue[], time: number): void {
    const active = cues.find((cue) => time >= cue.startTime && time < cue.startTime + cue.duration);
    if (!active) {
      if (this.activeViseme) this.clearViseme();
      return;
    }
    this.setViseme(active.viseme, active.weight ?? 1);
  }

  /** Releases every transient face layer, leaving identity morphs intact. */
  reset(): void {
    this.clearExpression();
    this.clearViseme();
    this.clearTracking();
  }

  private assertChannelsBound(label: string, channels: Record<string, number>): void {
    for (const channel of Object.keys(channels)) {
      if (!this.morphs.has(channel)) {
        throw new Error(`Facial ${label} references unbound morph channel "${channel}"`);
      }
    }
  }
}

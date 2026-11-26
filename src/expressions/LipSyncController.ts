import { ARKIT_CORE_EXPRESSION_CHANNELS } from '../format/constants.js';
import type { VisemeCue } from '../format/types.js';

export const OCULUS_VISEME_IDS = [
  'sil',
  'PP',
  'FF',
  'TH',
  'DD',
  'kk',
  'CH',
  'SS',
  'nn',
  'RR',
  'aa',
  'E',
  'ih',
  'oh',
  'ou',
] as const;

export type OculusVisemeId = (typeof OCULUS_VISEME_IDS)[number];

/**
 * ARKit expression channel recipes for the 15 standard Oculus visemes.
 * Every key belongs to `ARKIT_CORE_EXPRESSION_CHANNELS` so both authored
 * facial rigs and procedural expression packs respond consistently.
 */
export const VISEME_ARKIT_MAP: Readonly<Record<OculusVisemeId, Readonly<Record<string, number>>>> = {
  sil: {},
  PP: {
    mouthPressLeft: 0.72,
    mouthPressRight: 0.72,
    mouthShrugLower: 0.38,
    jawOpen: 0.02,
  },
  FF: {
    mouthShrugLower: 0.46,
    mouthUpperUpLeft: 0.34,
    mouthUpperUpRight: 0.34,
    mouthPressLeft: 0.25,
    mouthPressRight: 0.25,
    jawOpen: 0.14,
  },
  TH: {
    jawOpen: 0.26,
    mouthUpperUpLeft: 0.24,
    mouthUpperUpRight: 0.24,
    mouthSmileLeft: 0.14,
    mouthSmileRight: 0.14,
  },
  DD: {
    jawOpen: 0.32,
    mouthUpperUpLeft: 0.2,
    mouthUpperUpRight: 0.2,
    mouthSmileLeft: 0.18,
    mouthSmileRight: 0.18,
  },
  kk: {
    jawOpen: 0.38,
    mouthFunnel: 0.18,
    mouthDimpleLeft: 0.2,
    mouthDimpleRight: 0.2,
  },
  CH: {
    mouthFunnel: 0.56,
    mouthPucker: 0.28,
    jawOpen: 0.24,
    mouthUpperUpLeft: 0.16,
    mouthUpperUpRight: 0.16,
  },
  SS: {
    mouthSmileLeft: 0.34,
    mouthSmileRight: 0.34,
    mouthPressLeft: 0.16,
    mouthPressRight: 0.16,
    jawOpen: 0.15,
  },
  nn: {
    jawOpen: 0.22,
    mouthPressLeft: 0.24,
    mouthPressRight: 0.24,
    mouthSmileLeft: 0.12,
    mouthSmileRight: 0.12,
  },
  RR: {
    mouthPucker: 0.44,
    mouthFunnel: 0.32,
    jawOpen: 0.26,
  },
  aa: {
    jawOpen: 0.84,
    mouthFunnel: 0.2,
    mouthUpperUpLeft: 0.18,
    mouthUpperUpRight: 0.18,
    mouthFrownLeft: 0.08,
    mouthFrownRight: 0.08,
  },
  E: {
    jawOpen: 0.46,
    mouthSmileLeft: 0.46,
    mouthSmileRight: 0.46,
    mouthUpperUpLeft: 0.22,
    mouthUpperUpRight: 0.22,
  },
  ih: {
    jawOpen: 0.24,
    mouthSmileLeft: 0.58,
    mouthSmileRight: 0.58,
    mouthDimpleLeft: 0.28,
    mouthDimpleRight: 0.28,
  },
  oh: {
    jawOpen: 0.56,
    mouthFunnel: 0.72,
    mouthPucker: 0.32,
  },
  ou: {
    jawOpen: 0.22,
    mouthPucker: 0.82,
    mouthFunnel: 0.52,
  },
};

export interface AudioBandEnergy {
  /** Normalized low-frequency speech energy (`~85-400 Hz`), `0..1`. */
  low: number;
  /** Normalized mid-frequency formant energy (`~400-2200 Hz`), `0..1`. */
  mid: number;
  /** Normalized high-frequency fricative/sibilant energy (`~2200-6500 Hz`), `0..1`. */
  high: number;
  /** Overall normalized RMS amplitude, `0..1`. */
  rms: number;
}

export interface TextToVisemeOptions {
  /** Optional start offset in seconds. Default `0`. */
  startTime?: number;
  /** Speech rate multiplier (`0.5..2.0`). Higher values produce shorter cues. Default `1`. */
  speechRate?: number;
  /** Cue blend weight (`0..1`). Default `0.95`. */
  weight?: number;
}

export interface LipSyncFrameOutput {
  channels: Record<string, number>;
  activeViseme: OculusVisemeId;
  activeWeight: number;
  active: boolean;
}

const VALID_CHANNEL_SET = new Set<string>(ARKIT_CORE_EXPRESSION_CHANNELS);

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function isOculusVisemeId(value: string): value is OculusVisemeId {
  return (OCULUS_VISEME_IDS as readonly string[]).includes(value);
}

const DIGRAPH_VISEMES: readonly [string, OculusVisemeId, number][] = [
  ['th', 'TH', 0.085],
  ['ch', 'CH', 0.09],
  ['sh', 'CH', 0.09],
  ['zh', 'CH', 0.09],
  ['ph', 'FF', 0.085],
  ['qu', 'ou', 0.095],
  ['ng', 'nn', 0.085],
  ['oo', 'ou', 0.115],
  ['ee', 'ih', 0.11],
  ['ea', 'ih', 0.11],
  ['ou', 'ou', 0.115],
  ['ow', 'oh', 0.115],
  ['oh', 'oh', 0.115],
  ['ai', 'E', 0.11],
  ['ay', 'E', 0.11],
];

const CHAR_VISEMES: Readonly<Record<string, [OculusVisemeId, number]>> = {
  p: ['PP', 0.085],
  b: ['PP', 0.085],
  m: ['PP', 0.095],
  f: ['FF', 0.085],
  v: ['FF', 0.085],
  t: ['DD', 0.07],
  d: ['DD', 0.07],
  k: ['kk', 0.075],
  g: ['kk', 0.075],
  c: ['kk', 0.075],
  q: ['kk', 0.075],
  x: ['SS', 0.09],
  j: ['CH', 0.085],
  s: ['SS', 0.085],
  z: ['SS', 0.085],
  n: ['nn', 0.075],
  l: ['nn', 0.075],
  r: ['RR', 0.08],
  w: ['ou', 0.085],
  u: ['ou', 0.1],
  o: ['oh', 0.11],
  a: ['aa', 0.115],
  e: ['E', 0.095],
  i: ['ih', 0.095],
  y: ['ih', 0.085],
  h: ['aa', 0.06],
};

/**
 * Converts plain text into timed Oculus viseme cues suitable for real-time speech
 * preview, TTS utterance sync, or scripted dialogue lines.
 */
export function textToVisemeCues(
  text: string,
  options: TextToVisemeOptions = {},
): VisemeCue[] {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return [];

  const rate = Number.isFinite(options.speechRate)
    ? Math.max(0.4, Math.min(2.5, options.speechRate ?? 1))
    : 1;
  const invRate = 1 / rate;
  const weight = clamp01(options.weight ?? 0.95);
  let cursor = Math.max(0, options.startTime ?? 0);
  const cues: VisemeCue[] = [];

  const pushCue = (viseme: OculusVisemeId, baseDuration: number, cueWeight = weight): void => {
    const duration = Math.max(0.035, baseDuration * invRate);
    const prev = cues[cues.length - 1];
    if (prev && prev.viseme === viseme && viseme !== 'sil') {
      prev.duration = Number((prev.duration + duration * 0.72).toFixed(4));
      cursor = Number((prev.startTime + prev.duration).toFixed(4));
      return;
    }
    if (viseme === 'sil' && prev && prev.viseme === 'sil') {
      prev.duration = Number((prev.duration + duration).toFixed(4));
      cursor = Number((prev.startTime + prev.duration).toFixed(4));
      return;
    }
    cues.push({
      startTime: Number(cursor.toFixed(4)),
      duration: Number(duration.toFixed(4)),
      viseme,
      weight: viseme === 'sil' ? 0 : cueWeight,
    });
    cursor = Number((cursor + duration).toFixed(4));
  };

  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      pushCue('sil', 0.045, 0);
      i += 1;
      continue;
    }
    if (ch === ',' || ch === ';' || ch === ':') {
      pushCue('sil', 0.14, 0);
      i += 1;
      continue;
    }
    if (ch === '.' || ch === '!' || ch === '?') {
      pushCue('sil', 0.24, 0);
      i += 1;
      continue;
    }

    const pair = normalized.slice(i, i + 2);
    const digraph = DIGRAPH_VISEMES.find(([token]) => token === pair);
    if (digraph) {
      pushCue(digraph[1], digraph[2]);
      i += 2;
      continue;
    }

    const mapped = CHAR_VISEMES[ch];
    if (mapped) {
      // Softly trim trailing silent 'e' at word end
      if (ch === 'e' && (i === normalized.length - 1 || /[^a-z]/.test(normalized[i + 1] ?? ''))) {
        if (cues.length > 0 && cues[cues.length - 1]!.viseme !== 'sil') {
          i += 1;
          continue;
        }
      }
      pushCue(mapped[0], mapped[1]);
    }
    i += 1;
  }

  // Close gracefully at end of utterance.
  if (cues.length > 0 && cues[cues.length - 1]!.viseme !== 'sil') {
    pushCue('sil', 0.08, 0);
  }
  return cues;
}

/**
 * Classifies instantaneous low/mid/high audio band energies into the best matching
 * Oculus viseme and modulation weight (`0..1`).
 */
export function classifyAudioSpectrumToViseme(
  energy: AudioBandEnergy,
): { viseme: OculusVisemeId; weight: number } {
  const rms = clamp01(energy.rms);
  if (rms < 0.028) {
    return { viseme: 'sil', weight: 0 };
  }

  const low = clamp01(energy.low);
  const mid = clamp01(energy.mid);
  const high = clamp01(energy.high);
  const openWeight = clamp01((rms - 0.028) * 3.2);

  // Sharp sibilants / fricatives dominated by high frequencies
  if (high > mid * 1.15 && high > low * 1.15) {
    return {
      viseme: high > 0.42 ? 'SS' : 'FF',
      weight: Math.min(1, openWeight * 0.9),
    };
  }

  // Wide open vowels ("aa" / "E") when mid-frequency energy dominates
  if (mid >= low * 0.95) {
    if (high > low * 0.9 && high > 0.16) {
      return { viseme: mid > 0.45 ? 'E' : 'ih', weight: openWeight };
    }
    return { viseme: 'aa', weight: openWeight };
  }

  // Rounded vowels ("oh" / "ou") when low fundamental resonance leads
  if (low > mid * 1.3) {
    return { viseme: rms > 0.35 ? 'oh' : 'ou', weight: openWeight };
  }

  return { viseme: 'oh', weight: openWeight * 0.9 };
}

/**
 * Stateful real-time lip-sync mixer supporting both timed/text viseme cues and
 * live audio band classification with co-articulation smoothing.
 */
export class LipSyncController {
  private cues: VisemeCue[] = [];
  private playbackTime = 0;
  private totalDuration = 0;
  private cuePlaying = false;
  private liveMode = false;
  private liveViseme: OculusVisemeId = 'sil';
  private liveWeight = 0;
  private readonly smoothedChannels = new Map<string, number>();

  get isPlaying(): boolean {
    return this.cuePlaying || (this.liveMode && this.liveWeight > 0.01);
  }

  get isLiveActive(): boolean {
    return this.liveMode;
  }

  get duration(): number {
    return this.totalDuration;
  }

  get elapsed(): number {
    return this.playbackTime;
  }

  playText(text: string, options: TextToVisemeOptions = {}): VisemeCue[] {
    const cues = textToVisemeCues(text, options);
    this.playCues(cues);
    return cues;
  }

  playCues(cues: readonly VisemeCue[]): void {
    this.liveMode = false;
    this.liveViseme = 'sil';
    this.liveWeight = 0;
    this.cues = cues
      .map((cue) => ({ ...cue }))
      .sort((a, b) => a.startTime - b.startTime);
    this.playbackTime = 0;
    this.totalDuration = this.cues.reduce(
      (maxEnd, cue) => Math.max(maxEnd, cue.startTime + cue.duration),
      0,
    );
    this.cuePlaying = this.totalDuration > 0;
  }

  setAudioBands(energy: AudioBandEnergy | null): void {
    if (!energy) {
      this.liveMode = false;
      this.liveViseme = 'sil';
      this.liveWeight = 0;
      return;
    }
    this.cuePlaying = false;
    this.cues = [];
    this.liveMode = true;
    const classified = classifyAudioSpectrumToViseme(energy);
    this.liveViseme = classified.viseme;
    this.liveWeight = classified.weight;
  }

  stop(immediate = false): void {
    this.cues = [];
    this.playbackTime = 0;
    this.totalDuration = 0;
    this.cuePlaying = false;
    this.liveMode = false;
    this.liveViseme = 'sil';
    this.liveWeight = 0;
    if (immediate) {
      this.smoothedChannels.clear();
    }
  }

  /**
   * Samples raw (unsmoothed) channel weights at `time` across `this.cues`,
   * applying gentle overlap co-articulation near cue boundaries.
   */
  sampleAt(time: number): { viseme: OculusVisemeId; weight: number; channels: Record<string, number> } {
    if (this.cues.length === 0 || time < 0 || time >= this.totalDuration) {
      return { viseme: 'sil', weight: 0, channels: {} };
    }

    const blended: Record<string, number> = {};
    let dominantViseme: OculusVisemeId = 'sil';
    let dominantWeight = 0;
    const fadeWindow = 0.032;

    for (const cue of this.cues) {
      const start = cue.startTime - fadeWindow * 0.5;
      const end = cue.startTime + cue.duration + fadeWindow * 0.5;
      if (time < start || time > end) continue;
      const viseme: OculusVisemeId = isOculusVisemeId(cue.viseme) ? cue.viseme : 'sil';
      if (viseme === 'sil') continue;

      const fadeIn = Math.min(1, Math.max(0, (time - start) / fadeWindow));
      const fadeOut = Math.min(1, Math.max(0, (end - time) / fadeWindow));
      const envelope = Math.min(fadeIn, fadeOut) * clamp01(cue.weight ?? 1);
      if (envelope <= 1e-4) continue;

      if (envelope > dominantWeight) {
        dominantWeight = envelope;
        dominantViseme = viseme;
      }
      const recipe = VISEME_ARKIT_MAP[viseme];
      for (const [channel, baseVal] of Object.entries(recipe)) {
        if (!VALID_CHANNEL_SET.has(channel)) continue;
        blended[channel] = Math.max(blended[channel] ?? 0, clamp01(baseVal * envelope));
      }
    }

    return {
      viseme: dominantViseme,
      weight: dominantWeight,
      channels: blended,
    };
  }

  step(deltaSeconds: number): LipSyncFrameOutput {
    const dt = Number.isFinite(deltaSeconds) ? Math.max(0, Math.min(0.1, deltaSeconds)) : 0;
    const targets: Record<string, number> = {};
    let activeViseme: OculusVisemeId = 'sil';
    let activeWeight = 0;

    if (this.cuePlaying) {
      this.playbackTime += dt;
      if (this.playbackTime >= this.totalDuration) {
        this.cuePlaying = false;
        this.cues = [];
        this.playbackTime = 0;
        this.totalDuration = 0;
      } else {
        const sampled = this.sampleAt(this.playbackTime);
        activeViseme = sampled.viseme;
        activeWeight = sampled.weight;
        Object.assign(targets, sampled.channels);
      }
    } else if (this.liveMode) {
      activeViseme = this.liveViseme;
      activeWeight = this.liveWeight;
      if (activeViseme !== 'sil' && activeWeight > 0) {
        for (const [channel, val] of Object.entries(VISEME_ARKIT_MAP[activeViseme])) {
          targets[channel] = clamp01(val * activeWeight);
        }
      }
    }

    const keys = new Set<string>([...this.smoothedChannels.keys(), ...Object.keys(targets)]);
    const output: Record<string, number> = {};
    let anyActive = this.cuePlaying || (this.liveMode && this.liveWeight > 0.01);

    for (const channel of keys) {
      const target = targets[channel] ?? 0;
      const prev = this.smoothedChannels.get(channel) ?? 0;
      const rate = target >= prev ? 26 : 15;
      const alpha = dt > 0 ? 1 - Math.exp(-rate * dt) : 1;
      const next = prev + (target - prev) * alpha;
      if (next <= 0.002 && target === 0) {
        this.smoothedChannels.delete(channel);
      } else {
        this.smoothedChannels.set(channel, next);
        output[channel] = next;
        anyActive = true;
      }
    }

    return {
      channels: output,
      activeViseme,
      activeWeight,
      active: anyActive,
    };
  }
}

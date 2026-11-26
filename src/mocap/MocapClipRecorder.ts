import {
  AnimationClip,
  Quaternion,
  QuaternionKeyframeTrack,
} from 'three';

export interface RecordedMocapFrame {
  time: number;
  boneRotations: Record<string, [number, number, number, number]>;
  faceChannels?: Record<string, number>;
}

export interface SavedMocapClipData {
  version: 1;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  duration: number;
  fps: number;
  frames: RecordedMocapFrame[];
}

export interface BuildMocapClipOptions {
  name?: string;
  boneNameMap?: Readonly<Record<string, string>>;
  restBoneQuaternions?: Readonly<Record<string, Quaternion>>;
}

function roundDecimals(value: number, factor: number): number {
  return Math.round(value * factor) / factor;
}

/**
 * Quantizes recorded mocap frames cleanly for compact IndexedDB/JSON persistence
 * while dropping negligible (`<= 0.005`) face channel residuals.
 */
export function quantizeMocapFrames(frames: readonly RecordedMocapFrame[]): RecordedMocapFrame[] {
  return frames.map((frame) => {
    const boneRotations: Record<string, [number, number, number, number]> = {};
    for (const [boneId, quat] of Object.entries(frame.boneRotations)) {
      boneRotations[boneId] = [
        roundDecimals(quat[0], 1e4),
        roundDecimals(quat[1], 1e4),
        roundDecimals(quat[2], 1e4),
        roundDecimals(quat[3], 1e4),
      ];
    }
    let faceChannels: Record<string, number> | undefined;
    if (frame.faceChannels) {
      const cleaned: Record<string, number> = {};
      for (const [ch, val] of Object.entries(frame.faceChannels)) {
        if (!Number.isFinite(val)) continue;
        const clamped = Math.max(0, Math.min(1, roundDecimals(val, 1e3)));
        if (clamped > 0.005) cleaned[ch] = clamped;
      }
      if (Object.keys(cleaned).length > 0) faceChannels = cleaned;
    }
    return {
      time: Math.max(0, roundDecimals(frame.time, 1e4)),
      boneRotations,
      ...(faceChannels ? { faceChannels } : {}),
    };
  });
}

/**
 * Validates and normalizes an unknown JSON/IndexedDB record into a `SavedMocapClipData`.
 */
export function parseSavedMocapClip(raw: unknown): SavedMocapClipData | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj['version'] !== 1) return undefined;
  const id = typeof obj['id'] === 'string' ? obj['id'].trim() : '';
  const name = typeof obj['name'] === 'string' ? obj['name'].trim() : '';
  const createdAt = obj['createdAt'];
  const updatedAt = obj['updatedAt'];
  const fps = obj['fps'];
  const rawFrames = obj['frames'];
  if (
    !id
    || !name
    || typeof createdAt !== 'number'
    || !Number.isFinite(createdAt)
    || typeof updatedAt !== 'number'
    || !Number.isFinite(updatedAt)
    || typeof fps !== 'number'
    || !Number.isFinite(fps)
    || fps <= 0
    || !Array.isArray(rawFrames)
    || rawFrames.length === 0
  ) {
    return undefined;
  }

  const parsedFrames: RecordedMocapFrame[] = [];
  for (const item of rawFrames) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const f = item as Record<string, unknown>;
    if (typeof f['time'] !== 'number' || !Number.isFinite(f['time']) || f['time'] < 0) return undefined;
    const rawRots = f['boneRotations'];
    if (!rawRots || typeof rawRots !== 'object' || Array.isArray(rawRots)) return undefined;
    const boneRotations: Record<string, [number, number, number, number]> = {};
    for (const [boneId, tuple] of Object.entries(rawRots as Record<string, unknown>)) {
      if (!Array.isArray(tuple) || tuple.length !== 4) continue;
      const x = Number(tuple[0]);
      const y = Number(tuple[1]);
      const z = Number(tuple[2]);
      const w = Number(tuple[3]);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && Number.isFinite(w)) {
        boneRotations[boneId] = [x, y, z, w];
      }
    }
    let faceChannels: Record<string, number> | undefined;
    if (f['faceChannels'] && typeof f['faceChannels'] === 'object' && !Array.isArray(f['faceChannels'])) {
      faceChannels = {};
      for (const [ch, val] of Object.entries(f['faceChannels'] as Record<string, unknown>)) {
        if (typeof val === 'number' && Number.isFinite(val)) {
          faceChannels[ch] = Math.max(0, Math.min(1, val));
        }
      }
    }
    parsedFrames.push({
      time: f['time'],
      boneRotations,
      ...(faceChannels && Object.keys(faceChannels).length > 0 ? { faceChannels } : {}),
    });
  }

  parsedFrames.sort((a, b) => a.time - b.time);
  const quantized = quantizeMocapFrames(parsedFrames);
  const duration = quantized.length > 0 ? quantized[quantized.length - 1]!.time : 0;
  return {
    version: 1,
    id,
    name,
    createdAt,
    updatedAt,
    duration,
    fps,
    frames: quantized,
  };
}

/**
 * Builds a Three.js `AnimationClip` from recorded mocap frames by composing delta
 * rotations onto `restBoneQuaternions` and mapping semantic IDs via `boneNameMap`.
 */
export function buildAnimationClipFromFrames(
  frames: readonly RecordedMocapFrame[],
  options: BuildMocapClipOptions = {},
): AnimationClip {
  const clipName = options.name ?? 'MocapRecording';
  if (frames.length === 0) {
    return new AnimationClip(clipName, 0, []);
  }

  const boneIds = new Set<string>();
  for (const frame of frames) {
    for (const boneId of Object.keys(frame.boneRotations)) {
      boneIds.add(boneId);
    }
  }

  const tracks: QuaternionKeyframeTrack[] = [];
  const deltaQ = new Quaternion();
  const composedQ = new Quaternion();

  for (const boneId of boneIds) {
    const targetName = options.boneNameMap?.[boneId] ?? boneId;
    const restQ = options.restBoneQuaternions?.[boneId];
    const times: number[] = [];
    const values: number[] = [];

    for (const frame of frames) {
      const tuple = frame.boneRotations[boneId];
      if (!tuple) continue;
      times.push(frame.time);
      deltaQ.set(tuple[0], tuple[1], tuple[2], tuple[3]).normalize();
      if (restQ) {
        composedQ.copy(restQ).multiply(deltaQ).normalize();
      } else {
        composedQ.copy(deltaQ);
      }
      values.push(composedQ.x, composedQ.y, composedQ.z, composedQ.w);
    }

    if (times.length > 0) {
      tracks.push(new QuaternionKeyframeTrack(`${targetName}.quaternion`, times, values));
    }
  }

  const duration = frames[frames.length - 1]!.time;
  return new AnimationClip(clipName, duration, tracks);
}

/**
 * Samples and linearly interpolates recorded ARKit `faceChannels` at `timeSec`.
 */
export function sampleMocapFaceChannelsAt(
  frames: readonly RecordedMocapFrame[],
  timeSec: number,
  loop = true,
): Record<string, number> {
  if (frames.length === 0) return {};
  const duration = frames[frames.length - 1]!.time;
  let t = Number.isFinite(timeSec) ? Math.max(0, timeSec) : 0;
  if (duration > 1e-5) {
    t = loop ? t % duration : Math.min(duration, t);
  } else {
    t = 0;
  }

  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]!.time <= t) lo = mid;
    else hi = mid;
  }

  const fA = frames[lo]!;
  const fB = frames[hi]!;
  const span = fB.time - fA.time;
  const alpha = span > 1e-5 ? Math.max(0, Math.min(1, (t - fA.time) / span)) : 0;
  const faceA = fA.faceChannels ?? {};
  const faceB = fB.faceChannels ?? {};
  const out: Record<string, number> = {};
  const keys = new Set<string>([...Object.keys(faceA), ...Object.keys(faceB)]);
  for (const key of keys) {
    const va = faceA[key] ?? 0;
    const vb = faceB[key] ?? 0;
    const v = va + (vb - va) * alpha;
    if (v > 0.005) out[key] = v;
  }
  return out;
}

export interface MocapClipRecorderOptions {
  /** Target capture frame rate in Hz. Default `30`. */
  fps?: number;
  /** Optional hard duration cap in seconds. Default `60`. */
  maxDurationSeconds?: number;
}

/**
 * Samples real-time mocap delta bone rotations into a portable Three.js
 * `AnimationClip` compatible with Mixamo / `GLTFExporter` playback.
 */
export class MocapClipRecorder {
  private readonly minStep: number;
  private readonly maxDuration: number;
  private readonly frames: RecordedMocapFrame[] = [];
  private recording = false;
  private startTimestamp = -1;
  private lastSampleTime = -Infinity;

  constructor(options: MocapClipRecorderOptions = {}) {
    const fps = Number.isFinite(options.fps) ? Math.max(5, Math.min(120, options.fps ?? 30)) : 30;
    this.minStep = 1 / fps;
    this.maxDuration = Number.isFinite(options.maxDurationSeconds)
      ? Math.max(1, options.maxDurationSeconds ?? 60)
      : 60;
  }

  get isRecording(): boolean {
    return this.recording;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  get duration(): number {
    return this.frames.length > 0 ? this.frames[this.frames.length - 1]!.time : 0;
  }

  start(): void {
    this.frames.length = 0;
    this.recording = true;
    this.startTimestamp = -1;
    this.lastSampleTime = -Infinity;
  }

  stop(): RecordedMocapFrame[] {
    this.recording = false;
    return this.getFrames();
  }

  reset(): void {
    this.frames.length = 0;
    this.recording = false;
    this.startTimestamp = -1;
    this.lastSampleTime = -Infinity;
  }

  getFrames(): RecordedMocapFrame[] {
    return this.frames.map((frame) => ({
      time: frame.time,
      boneRotations: { ...frame.boneRotations },
      ...(frame.faceChannels ? { faceChannels: { ...frame.faceChannels } } : {}),
    }));
  }

  /**
   * Appends a frame if recording is active and at least `1/fps` has elapsed.
   * Returns `true` when the frame is recorded.
   */
  pushFrame(
    timestampSeconds: number,
    boneRotations: Readonly<Record<string, [number, number, number, number]>>,
    faceChannels?: Readonly<Record<string, number>>,
  ): boolean {
    if (!this.recording || !Number.isFinite(timestampSeconds)) return false;
    if (this.startTimestamp < 0) this.startTimestamp = timestampSeconds;

    const elapsed = Math.max(0, timestampSeconds - this.startTimestamp);
    if (elapsed > this.maxDuration) {
      this.recording = false;
      return false;
    }
    if (this.frames.length > 0 && elapsed - this.lastSampleTime < this.minStep * 0.85) {
      return false;
    }

    this.lastSampleTime = elapsed;
    const copiedRotations: Record<string, [number, number, number, number]> = {};
    for (const [boneId, quat] of Object.entries(boneRotations)) {
      copiedRotations[boneId] = [quat[0], quat[1], quat[2], quat[3]];
    }
    const frame: RecordedMocapFrame = {
      time: Number(elapsed.toFixed(4)),
      boneRotations: copiedRotations,
    };
    if (faceChannels && Object.keys(faceChannels).length > 0) {
      frame.faceChannels = { ...faceChannels };
    }
    this.frames.push(frame);
    return true;
  }

  /**
   * Builds a Three.js `AnimationClip` by composing recorded delta rotations onto
   * optional `restBoneQuaternions` and mapping semantic bone IDs through
   * `boneNameMap` (e.g. `arm.upper.left` -> `mixamorigLeftArm`).
   */
  toAnimationClip(options: BuildMocapClipOptions = {}): AnimationClip {
    return buildAnimationClipFromFrames(this.frames, options);
  }
}

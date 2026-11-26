import { Bone, Mesh, Quaternion } from 'three';
import {
  DEFAULT_MOOD_BUBBLE_STATE,
  ExpressionController,
  normalizeMoodBubbleState,
  type ExpressionFrameOutput,
  type TriggerReactionOptions,
} from '../expressions/ExpressionController.js';
import { BUILTIN_EXPRESSION_PRESET_MAP } from '../expressions/ExpressionPresets.js';
import {
  LipSyncController,
  type AudioBandEnergy,
  type LipSyncFrameOutput,
  type TextToVisemeOptions,
} from '../expressions/LipSyncController.js';
import {
  FACE_EXPRESSION_LAYER,
  FACE_TRACKING_LAYER,
  FACE_VISEME_LAYER,
} from '../face/AvatarFaceController.js';
import type {
  AvatarMoodBubbleState,
  ExpressionPresetDefinition,
  MoodBubbleSymbolId,
  VisemeCue,
} from '../format/types.js';
import { setMorphTargetInfluence } from '../layering/SpatialMeshIndex.js';
import {
  ChannelMapOneEuroFilter,
  QuaternionOneEuroFilter,
} from '../mocap/OneEuroFilter.js';
import {
  calibratePoseBaseline,
  normalizeMediaPipeFaceBlendshapes,
  solvePoseLandmarksToRig,
  type MediaPipeBlendshapeCategory,
  type MocapCalibrationBaseline,
  type NormalizedLandmark,
  type PoseSolveOptions,
} from '../mocap/PoseLandmarkSolver.js';
import type { AvatarInstance } from '../runtime/AvatarInstance.js';

/** Minimal canvas contract supporting `captureStream(fps)` in browsers and unit tests. */
export interface CaptureStreamCanvasLike {
  captureStream(frameRate?: number): MediaStreamLike;
}

export interface MediaStreamTrackLike {
  readonly kind: string;
  readonly id?: string;
  readonly readyState?: string;
  enabled: boolean;
  stop(): void;
}

export interface MediaStreamLike {
  getVideoTracks(): MediaStreamTrackLike[];
  getAudioTracks?(): MediaStreamTrackLike[];
  getTracks?(): MediaStreamTrackLike[];
}

export interface RtcRtpSenderLike {
  readonly track: MediaStreamTrackLike | null;
  replaceTrack(withTrack: MediaStreamTrackLike | null): Promise<void>;
}

export interface RtcPeerConnectionLike {
  getSenders(): RtcRtpSenderLike[];
  getTransceivers?(): { sender: RtcRtpSenderLike; receiver?: { track?: MediaStreamTrackLike | null } }[];
}

export interface ActiveCallMoodBubble {
  moodId: string;
  label: string;
  accentColor: string;
  symbol: MoodBubbleSymbolId;
  remainingSeconds: number;
  totalSeconds: number;
  config: AvatarMoodBubbleState;
}

export interface TriggerCallMoodBubbleOptions {
  durationSeconds?: number;
  label?: string;
  triggerFaceReaction?: boolean;
  reaction?: TriggerReactionOptions;
}

export interface AvatarCallFrameResult {
  enabled: boolean;
  timestampSeconds: number;
  poseConfidence: number;
  appliedBoneCount: number;
  expression: ExpressionFrameOutput;
  lipSync: LipSyncFrameOutput;
  activeMoodBubble?: ActiveCallMoodBubble;
  rendered: boolean;
}

export interface AvatarCallStreamControllerOptions {
  /** Target Three.js avatar instance driven during the call. */
  avatar?: AvatarInstance;
  /** Optional additional target meshes for procedural expression/lip-sync morphs. */
  targetMeshes?: readonly Mesh[];
  /** Optional custom expression presets added on top of built-in moods. */
  presets?: readonly ExpressionPresetDefinition[];
  /** Offscreen or preview canvas used for `captureVideoTrack(fps)`. */
  canvas?: CaptureStreamCanvasLike;
  /** Optional render callback invoked at the end of each `step(dt)` while Avatar Mode is enabled. */
  renderFrame?: (deltaSeconds: number) => void;
  /** Default WebRTC capture frame rate. Clamped to `1..60`. Default `30`. */
  defaultFps?: number;
  /** Mirror webcam pose & face tracking (selfie mode). Default `true`. */
  mirrored?: boolean;
  /** Initial Avatar Mode state. Default `true`. */
  enabled?: boolean;
  /** Initial mood bubble configuration. */
  moodBubble?: Partial<AvatarMoodBubbleState>;
  /** Pose smoothing filter config. */
  poseFilter?: { minCutoff?: number; beta?: number };
  /** Face channel smoothing filter config. */
  faceFilter?: { minCutoff?: number; beta?: number };
  /** Callback fired when Avatar Mode toggles on/off. */
  onModeChange?: (enabled: boolean) => void;
  /** Callback fired when a reaction burst is triggered. */
  onReaction?: (moodId: string, options: TriggerReactionOptions) => void;
  /** Callback fired when a mood bubble changes or expires. */
  onMoodBubbleChange?: (bubble: ActiveCallMoodBubble | undefined) => void;
}

const MOUTH_TRACKING_CHANNELS = new Set<string>([
  'jawOpen',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthPucker',
  'mouthFunnel',
  'mouthDimpleLeft',
  'mouthDimpleRight',
  'mouthShrugLower',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
]);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Pure FFT-bin band energy extractor for live WebRTC microphone `AnalyserNode`
 * frequency byte data (`0..255`). Maps speech formants into `AudioBandEnergy`
 * (`low`: 85-400 Hz, `mid`: 400-2200 Hz, `high`: 2200-6500 Hz, `rms`: overall).
 */
export function computeAudioBandsFromFrequencyData(
  frequencyData: ArrayLike<number>,
  sampleRate = 48_000,
  fftSize?: number,
): AudioBandEnergy {
  const binCount = frequencyData.length;
  if (binCount === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return { low: 0, mid: 0, high: 0, rms: 0 };
  }

  const effectiveFft = fftSize && fftSize > 0 ? fftSize : binCount * 2;
  const hzPerBin = sampleRate / effectiveFft;

  let lowSum = 0;
  let lowCount = 0;
  let midSum = 0;
  let midCount = 0;
  let highSum = 0;
  let highCount = 0;
  let sqSum = 0;
  let totalSpeechBins = 0;

  for (let i = 0; i < binCount; i++) {
    const hz = i * hzPerBin;
    if (hz < 85 || hz > 6500) continue;
    const raw = frequencyData[i] ?? 0;
    const norm = clamp(Number.isFinite(raw) ? raw / 255 : 0, 0, 1);
    sqSum += norm * norm;
    totalSpeechBins += 1;

    if (hz < 400) {
      lowSum += norm;
      lowCount += 1;
    } else if (hz < 2200) {
      midSum += norm;
      midCount += 1;
    } else {
      highSum += norm;
      highCount += 1;
    }
  }

  return {
    low: lowCount > 0 ? clamp(lowSum / lowCount, 0, 1) : 0,
    mid: midCount > 0 ? clamp(midSum / midCount, 0, 1) : 0,
    high: highCount > 0 ? clamp(highSum / highCount, 0, 1) : 0,
    rms: totalSpeechBins > 0 ? clamp(Math.sqrt(sqSum / totalSpeechBins), 0, 1) : 0,
  };
}

/**
 * Finds the active video `RTCRtpSender` on a peer connection (checking both
 * `getSenders()` and `getTransceivers()` so replaced/muted tracks still match).
 */
export function findPeerConnectionVideoSender(
  peerConnection: RtcPeerConnectionLike | null | undefined,
): RtcRtpSenderLike | undefined {
  if (!peerConnection) return undefined;
  const senders = peerConnection.getSenders();
  const byTrack = senders.find((sender) => sender.track?.kind === 'video');
  if (byTrack) return byTrack;
  if (typeof peerConnection.getTransceivers === 'function') {
    const transceiver = peerConnection
      .getTransceivers()
      .find((entry) => entry.receiver?.track?.kind === 'video' || entry.sender?.track?.kind === 'video');
    if (transceiver) return transceiver.sender;
  }
  return undefined;
}

/**
 * Zero-protocol-change WebRTC video track swap helper: replaces the outgoing
 * video `MediaStreamTrack` on an existing `RTCPeerConnection` without needing
 * SDP renegotiation.
 */
export async function swapPeerConnectionVideoTrack(
  peerConnection: RtcPeerConnectionLike | null | undefined,
  nextTrack: MediaStreamTrackLike | null,
): Promise<boolean> {
  const sender = findPeerConnectionVideoSender(peerConnection);
  if (!sender) return false;
  await sender.replaceTrack(nextTrack);
  return true;
}

interface AudioPipeline {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buffer: Uint8Array<ArrayBuffer>;
}

/**
 * Portable video-call Avatar Mode controller for Interverse Connect.
 *
 * Drives an `AvatarInstance` from live webcam pose/face tracking, live call
 * microphone audio bands (`LipSyncController`), and real-time expression moods,
 * reaction bursts, and mood bubbles. Renders to an offscreen/preview canvas and
 * exposes `captureVideoTrack(fps)` for zero-protocol-change WebRTC
 * `RTCRtpSender.replaceTrack(avatarTrack)`.
 */
export class AvatarCallStreamController {
  readonly expressions: ExpressionController;
  readonly lipSync: LipSyncController;

  private readonly avatar?: AvatarInstance;
  private readonly targetMeshes = new Set<Mesh>();
  private readonly canvas?: CaptureStreamCanvasLike;
  private readonly renderFrame?: (deltaSeconds: number) => void;
  private readonly defaultFps: number;
  private readonly onModeChange?: (enabled: boolean) => void;
  private readonly onReaction?: (moodId: string, options: TriggerReactionOptions) => void;
  private readonly onMoodBubbleChange?: (bubble: ActiveCallMoodBubble | undefined) => void;

  private mirrored: boolean;
  private enabled: boolean;
  private disposed = false;
  private elapsedSeconds = 0;

  private calibration?: MocapCalibrationBaseline;
  private readonly boneFilters = new Map<string, QuaternionOneEuroFilter>();
  private readonly faceFilter: ChannelMapOneEuroFilter;
  private readonly poseFilterConfig: { minCutoff: number; beta: number };

  private latestPoseRotations: Record<string, [number, number, number, number]> = {};
  private latestPoseConfidence = 0;
  private latestFaceChannels: Record<string, number> = {};

  private readonly restBones = new Map<string, { bone: Bone; rest: Quaternion }>();
  private readonly appliedExtraMorphs = new Set<string>();
  private readonly tempQuat = new Quaternion();

  private moodBubbleConfig: AvatarMoodBubbleState;
  private activeMoodBubble?: ActiveCallMoodBubble;

  private capturedStream?: MediaStreamLike;
  private capturedVideoTrack?: MediaStreamTrackLike;
  private capturedFps = 0;

  private boundPeerConnection?: RtcPeerConnectionLike;
  private cameraVideoTrack: MediaStreamTrackLike | null = null;
  private audioPipeline?: AudioPipeline;

  constructor(options: AvatarCallStreamControllerOptions = {}) {
    this.avatar = options.avatar;
    for (const mesh of options.targetMeshes ?? []) this.targetMeshes.add(mesh);
    this.canvas = options.canvas;
    this.renderFrame = options.renderFrame;
    this.defaultFps = clamp(Math.round(options.defaultFps ?? 30), 1, 60);
    this.mirrored = options.mirrored ?? true;
    this.enabled = options.enabled ?? true;
    this.onModeChange = options.onModeChange;
    this.onReaction = options.onReaction;
    this.onMoodBubbleChange = options.onMoodBubbleChange;
    this.moodBubbleConfig = normalizeMoodBubbleState(options.moodBubble ?? DEFAULT_MOOD_BUBBLE_STATE);

    this.poseFilterConfig = {
      minCutoff: options.poseFilter?.minCutoff ?? 1.4,
      beta: options.poseFilter?.beta ?? 0.03,
    };
    this.faceFilter = new ChannelMapOneEuroFilter({
      minCutoff: options.faceFilter?.minCutoff ?? 1.8,
      beta: options.faceFilter?.beta ?? 0.025,
    });

    this.expressions = new ExpressionController({
      avatar: options.avatar,
      targets: options.targetMeshes ? [...options.targetMeshes] : undefined,
      presets: options.presets,
    });
    this.lipSync = new LipSyncController();
  }

  get isEnabled(): boolean {
    return this.enabled && !this.disposed;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get isMirrored(): boolean {
    return this.mirrored;
  }

  setMirrored(mirrored: boolean): void {
    this.assertActive();
    this.mirrored = mirrored;
  }

  getMoodBubbleConfig(): AvatarMoodBubbleState {
    return { ...this.moodBubbleConfig };
  }

  setMoodBubbleConfig(config: Partial<AvatarMoodBubbleState>): AvatarMoodBubbleState {
    this.assertActive();
    this.moodBubbleConfig = normalizeMoodBubbleState({ ...this.moodBubbleConfig, ...config });
    if (this.activeMoodBubble) {
      this.activeMoodBubble = {
        ...this.activeMoodBubble,
        config: { ...this.moodBubbleConfig },
      };
    }
    return this.getMoodBubbleConfig();
  }

  getActiveMoodBubble(): ActiveCallMoodBubble | undefined {
    return this.activeMoodBubble ? { ...this.activeMoodBubble } : undefined;
  }

  /**
   * Captures a live WebRTC-ready `MediaStreamTrack` from the avatar preview/offscreen
   * canvas via `canvas.captureStream(fps).getVideoTracks()[0]`.
   */
  captureVideoTrack(fps = this.defaultFps): MediaStreamTrackLike {
    this.assertActive();
    if (!this.canvas || typeof this.canvas.captureStream !== 'function') {
      throw new Error('AvatarCallStreamController requires a canvas supporting captureStream(fps)');
    }
    const clampedFps = clamp(Math.round(Number.isFinite(fps) ? fps : this.defaultFps), 1, 60);

    if (
      this.capturedVideoTrack
      && this.capturedVideoTrack.readyState !== 'ended'
      && this.capturedFps === clampedFps
    ) {
      return this.capturedVideoTrack;
    }

    this.releaseCapturedStream();
    const stream = this.canvas.captureStream(clampedFps);
    const track = stream.getVideoTracks()[0];
    if (!track) {
      throw new Error('Canvas captureStream() did not produce a video track');
    }

    this.capturedStream = stream;
    this.capturedVideoTrack = track;
    this.capturedFps = clampedFps;
    return track;
  }

  /**
   * Binds an existing WebRTC `RTCPeerConnection` and optional original camera
   * video track so toggling Avatar Mode seamlessly calls `sender.replaceTrack(...)`
   * without renegotiating SDP.
   */
  bindPeerConnection(
    peerConnection: RtcPeerConnectionLike,
    cameraVideoTrack?: MediaStreamTrackLike | null,
  ): void {
    this.assertActive();
    this.boundPeerConnection = peerConnection;
    if (cameraVideoTrack !== undefined) {
      this.cameraVideoTrack = cameraVideoTrack;
    } else if (!this.cameraVideoTrack) {
      const sender = findPeerConnectionVideoSender(peerConnection);
      if (sender?.track && sender.track !== this.capturedVideoTrack) {
        this.cameraVideoTrack = sender.track;
      }
    }
  }

  unbindPeerConnection(): void {
    this.boundPeerConnection = undefined;
  }

  /**
   * Toggles Avatar Mode on or off. When a WebRTC `RTCPeerConnection` is bound,
   * automatically swaps the outgoing video sender track between the captured
   * avatar canvas track (ON) and the original camera track (OFF).
   */
  async setEnabled(enabled: boolean, options: { fps?: number } = {}): Promise<boolean> {
    this.assertActive();
    if (this.enabled === enabled) {
      return this.enabled;
    }
    this.enabled = enabled;

    if (enabled) {
      if (this.boundPeerConnection && this.canvas) {
        const avatarTrack = this.captureVideoTrack(options.fps ?? this.defaultFps);
        avatarTrack.enabled = true;
        await swapPeerConnectionVideoTrack(this.boundPeerConnection, avatarTrack);
      }
    } else {
      this.restoreAvatarToRest();
      if (this.boundPeerConnection) {
        await swapPeerConnectionVideoTrack(this.boundPeerConnection, this.cameraVideoTrack);
      }
    }

    this.onModeChange?.(this.enabled);
    return this.enabled;
  }

  async toggleAvatarMode(options: { fps?: number } = {}): Promise<boolean> {
    return this.setEnabled(!this.enabled, options);
  }

  /**
   * Calibrates neutral torso/head baseline from the user's current webcam pose.
   */
  calibratePose(poseLandmarks: readonly NormalizedLandmark[]): MocapCalibrationBaseline | undefined {
    this.assertActive();
    this.calibration = calibratePoseBaseline(poseLandmarks, this.mirrored);
    return this.calibration;
  }

  resetCalibration(): void {
    this.calibration = undefined;
  }

  /**
   * Feeds 33 MediaPipe BlazePose landmarks from the live webcam into the avatar
   * call rig solver with One-Euro smoothing.
   */
  setPoseLandmarks(
    poseLandmarks: readonly NormalizedLandmark[],
    options: PoseSolveOptions = {},
  ): { confidence: number; boneCount: number } {
    this.assertActive();
    const solved = solvePoseLandmarksToRig(
      poseLandmarks,
      {
        mirrored: options.mirrored ?? this.mirrored,
        minVisibility: options.minVisibility ?? 0.35,
        applyBody: options.applyBody ?? true,
        applyLegs: options.applyLegs ?? false,
      },
      this.calibration,
    );
    this.latestPoseRotations = solved.boneRotations;
    this.latestPoseConfidence = solved.confidence;
    return {
      confidence: solved.confidence,
      boneCount: Object.keys(solved.boneRotations).length,
    };
  }

  /**
   * Feeds pre-solved semantic bone delta quaternions `[x, y, z, w]` directly.
   */
  setBoneRotations(
    rotations: Readonly<Record<string, [number, number, number, number]>>,
    confidence = 1,
  ): void {
    this.assertActive();
    const copied: Record<string, [number, number, number, number]> = {};
    for (const [boneId, quat] of Object.entries(rotations)) {
      copied[boneId] = [quat[0], quat[1], quat[2], quat[3]];
    }
    this.latestPoseRotations = copied;
    this.latestPoseConfidence = clamp(Number.isFinite(confidence) ? confidence : 0, 0, 1);
  }

  /**
   * Feeds MediaPipe FaceLandmarker blendshape categories into face tracking.
   */
  setMediaPipeFaceBlendshapes(
    categories: readonly MediaPipeBlendshapeCategory[],
    options: { mirrored?: boolean; scale?: number } = {},
  ): Record<string, number> {
    this.assertActive();
    const normalized = normalizeMediaPipeFaceBlendshapes(categories, {
      mirrored: options.mirrored ?? this.mirrored,
      scale: options.scale ?? 1,
    });
    this.latestFaceChannels = normalized;
    return normalized;
  }

  /**
   * Feeds pre-normalized ARKit face tracking channel weights (`0..1`).
   */
  setFaceTrackingChannels(channels: Readonly<Record<string, number>> | null): void {
    this.assertActive();
    if (!channels) {
      this.latestFaceChannels = {};
      return;
    }
    const cleaned: Record<string, number> = {};
    for (const [key, value] of Object.entries(channels)) {
      if (Number.isFinite(value) && value > 0.005) {
        cleaned[key] = clamp(value, 0, 1);
      }
    }
    this.latestFaceChannels = cleaned;
  }

  /**
   * Feeds live call microphone frequency band energy directly into `LipSyncController`.
   */
  setAudioBands(energy: AudioBandEnergy | null): void {
    this.assertActive();
    this.lipSync.setAudioBands(energy);
  }

  /**
   * Attaches a browser `MediaStream` (e.g. `CallService.localStream`) to an
   * internal Web Audio `AnalyserNode` so `step(dt)` automatically samples live
   * call microphone audio bands for real-time lip-sync.
   */
  attachAudioStream(stream: MediaStream): boolean {
    this.assertActive();
    this.detachAudioStream();

    const AudioCtx =
      typeof globalThis !== 'undefined'
        ? (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
          ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!AudioCtx) return false;
    if (typeof stream.getAudioTracks === 'function' && stream.getAudioTracks().length === 0) {
      return false;
    }

    const context = new AudioCtx();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.55;
    source.connect(analyser);

    this.audioPipeline = {
      context,
      source,
      analyser,
      buffer: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)),
    };
    return true;
  }

  detachAudioStream(): void {
    if (!this.audioPipeline) return;
    const pipeline = this.audioPipeline;
    this.audioPipeline = undefined;
    try {
      pipeline.source.disconnect();
      pipeline.analyser.disconnect();
      void pipeline.context.close();
    } catch {
      // Ignore Web Audio teardown errors when context is already closed.
    }
    this.lipSync.setAudioBands(null);
  }

  /** Plays scripted text lip-sync cues on the call avatar. */
  playSpeechText(text: string, options?: TextToVisemeOptions): VisemeCue[] {
    this.assertActive();
    return this.lipSync.playText(text, options);
  }

  /** Plays pre-authored viseme cues on the call avatar. */
  playVisemeCues(cues: readonly VisemeCue[]): void {
    this.assertActive();
    this.lipSync.playCues(cues);
  }

  /** Sets a persistent call mood (e.g. `smile`, `focused`, `happy`). */
  setMood(moodId: string, intensity = 1, transitionSeconds = 0.25): void {
    this.assertActive();
    this.expressions.setMood(moodId, intensity, transitionSeconds);
  }

  clearMood(transitionSeconds = 0.2): void {
    this.assertActive();
    this.expressions.clearMood(transitionSeconds);
  }

  /**
   * Triggers a one-shot call reaction burst (e.g. `laugh`, `love`, `surprised`)
   * and optionally pops the matching mood bubble above the avatar.
   */
  triggerReaction(
    moodId: string,
    options: TriggerReactionOptions & { showMoodBubble?: boolean; bubbleDurationSeconds?: number } = {},
  ): void {
    this.assertActive();
    this.expressions.triggerReaction(moodId, options);
    this.onReaction?.(moodId, options);

    const showBubble = options.showMoodBubble ?? this.moodBubbleConfig.enabled;
    if (showBubble && moodId !== 'neutral') {
      const preset = this.expressions.getPreset(moodId);
      const env = preset?.reactionEnvelope ?? { attack: 0.14, hold: 1.25, release: 0.4 };
      const duration = options.bubbleDurationSeconds
        ?? Math.max(1.2, (options.attack ?? env.attack) + (options.hold ?? env.hold) + (options.release ?? env.release));
      this.triggerMoodBubble(moodId, {
        durationSeconds: duration,
        triggerFaceReaction: false,
      });
    }
  }

  /**
   * Pops a floating mood bubble on the call avatar for `durationSeconds`.
   */
  triggerMoodBubble(
    moodId: string,
    options: TriggerCallMoodBubbleOptions = {},
  ): ActiveCallMoodBubble {
    this.assertActive();
    const preset: ExpressionPresetDefinition | undefined =
      this.expressions.getPreset(moodId) ?? BUILTIN_EXPRESSION_PRESET_MAP.get(moodId);
    if (!preset) {
      throw new Error(`Unknown expression mood "${moodId}"`);
    }
    if (options.triggerFaceReaction) {
      this.expressions.triggerReaction(moodId, options.reaction);
      this.onReaction?.(moodId, options.reaction ?? {});
    }
    const totalSeconds = clamp(options.durationSeconds ?? 2.5, 0.25, 30);
    const bubble: ActiveCallMoodBubble = {
      moodId: preset.id,
      label: (options.label?.trim() || preset.label).slice(0, 64),
      accentColor: preset.accentColor ?? '#94a3b8',
      symbol: preset.bubbleSymbol ?? 'calm',
      remainingSeconds: totalSeconds,
      totalSeconds,
      config: { ...this.moodBubbleConfig },
    };
    this.activeMoodBubble = bubble;
    this.onMoodBubbleChange?.({ ...bubble });
    return { ...bubble };
  }

  clearMoodBubble(): void {
    if (!this.activeMoodBubble) return;
    this.activeMoodBubble = undefined;
    this.onMoodBubbleChange?.(undefined);
  }

  /**
   * Advances pose smoothing, webcam face tracking, live microphone lip-sync,
   * expression reactions, mood bubble timers, and invokes `renderFrame(dt)`
   * when Avatar Mode is active.
   */
  step(deltaSeconds: number): AvatarCallFrameResult {
    this.assertActive();
    const dt = Number.isFinite(deltaSeconds) ? clamp(deltaSeconds, 0, 0.1) : 0;
    this.elapsedSeconds += dt;

    if (!this.enabled) {
      return {
        enabled: false,
        timestampSeconds: this.elapsedSeconds,
        poseConfidence: 0,
        appliedBoneCount: 0,
        expression: {
          channels: {},
          headTiltDeg: [0, 0, 0],
          gaze: [0, 0],
          pupilScale: 1,
          blinkRateMultiplier: 1,
          eyeSymbol: 'classic',
          overlays: [],
          dominantMood: 'neutral',
          dominantMoodWeight: 0,
          reactionWeight: 0,
        },
        lipSync: {
          channels: {},
          activeViseme: 'sil',
          activeWeight: 0,
          active: false,
        },
        rendered: false,
      };
    }

    // 1. Sample live Web Audio mic stream if attached
    if (this.audioPipeline) {
      this.audioPipeline.analyser.getByteFrequencyData(this.audioPipeline.buffer);
      const bands = computeAudioBandsFromFrequencyData(
        this.audioPipeline.buffer,
        this.audioPipeline.context.sampleRate,
        this.audioPipeline.analyser.fftSize,
      );
      this.lipSync.setAudioBands(bands);
    }

    // 2. Advance expressions & lip-sync
    const expression = this.expressions.update(dt);
    const lipSync = this.lipSync.step(dt);

    // 3. Advance mood bubble timer
    if (this.activeMoodBubble) {
      const nextRemaining = this.activeMoodBubble.remainingSeconds - dt;
      if (nextRemaining <= 0) {
        this.activeMoodBubble = undefined;
        this.onMoodBubbleChange?.(undefined);
      } else {
        this.activeMoodBubble = {
          ...this.activeMoodBubble,
          remainingSeconds: nextRemaining,
        };
      }
    }

    // 4. Smooth & apply webcam face tracking + lip-sync morph layers
    const smoothedFace = this.faceFilter.filterMap(this.latestFaceChannels, this.elapsedSeconds);
    const trackingChannels: Record<string, number> = {};
    const mouthAttenuation = lipSync.active ? 1 - clamp(lipSync.activeWeight, 0, 1) * 0.85 : 1;

    for (const [channel, weight] of Object.entries(smoothedFace)) {
      const scaled = MOUTH_TRACKING_CHANNELS.has(channel) ? weight * mouthAttenuation : weight;
      if (scaled > 0.005) {
        trackingChannels[channel] = clamp(scaled, 0, 1);
      }
    }

    this.applyFaceLayers(expression.channels, trackingChannels, lipSync.channels);

    // 5. Smooth & apply pose delta rotations to avatar rig bones
    const appliedBoneCount = this.applyPoseBones();

    // 6. Render updated avatar frame to canvas
    let rendered = false;
    if (this.renderFrame) {
      this.renderFrame(dt);
      rendered = true;
    }

    return {
      enabled: true,
      timestampSeconds: this.elapsedSeconds,
      poseConfidence: this.latestPoseConfidence,
      appliedBoneCount,
      expression,
      lipSync,
      ...(this.activeMoodBubble ? { activeMoodBubble: { ...this.activeMoodBubble } } : {}),
      rendered,
    };
  }

  /**
   * Cleanly releases captured canvas stream tracks, detaches Web Audio mic
   * analysis, restores original camera track on bound peer connections (optional),
   * resets avatar bones & transient morph layers. Idempotent.
   */
  dispose(options: { restoreCameraTrack?: boolean } = {}): void {
    if (this.disposed) return;
    this.disposed = true;
    this.enabled = false;

    this.detachAudioStream();
    this.lipSync.stop(true);
    this.expressions.cancelReaction();
    this.expressions.clearMood(0);
    this.clearMoodBubble();
    this.restoreAvatarToRest();

    if (options.restoreCameraTrack !== false && this.boundPeerConnection && this.cameraVideoTrack) {
      void swapPeerConnectionVideoTrack(this.boundPeerConnection, this.cameraVideoTrack).catch(() => undefined);
    }

    this.releaseCapturedStream();
    this.boundPeerConnection = undefined;
    this.cameraVideoTrack = null;
    this.boneFilters.clear();
    this.faceFilter.reset();
    this.latestPoseRotations = {};
    this.latestFaceChannels = {};
    this.latestPoseConfidence = 0;
  }

  private applyFaceLayers(
    expressionChannels: Readonly<Record<string, number>>,
    trackingChannels: Readonly<Record<string, number>>,
    visemeChannels: Readonly<Record<string, number>>,
  ): void {
    if (this.avatar) {
      if (Object.keys(trackingChannels).length > 0) {
        this.avatar.morphs.setLayer(FACE_TRACKING_LAYER, { ...trackingChannels });
      } else {
        this.avatar.morphs.clearLayer(FACE_TRACKING_LAYER);
      }
      if (Object.keys(visemeChannels).length > 0) {
        this.avatar.morphs.setLayer(FACE_VISEME_LAYER, { ...visemeChannels });
      } else {
        this.avatar.morphs.clearLayer(FACE_VISEME_LAYER);
      }
    }

    if (this.targetMeshes.size === 0) return;

    const combined: Record<string, number> = {};
    for (const source of [expressionChannels, trackingChannels, visemeChannels]) {
      for (const [channel, value] of Object.entries(source)) {
        combined[channel] = clamp((combined[channel] ?? 0) + value, 0, 1);
      }
    }

    const touched = new Set<string>([...this.appliedExtraMorphs, ...Object.keys(combined)]);
    this.appliedExtraMorphs.clear();
    for (const channel of Object.keys(combined)) {
      this.appliedExtraMorphs.add(channel);
    }

    for (const channel of touched) {
      if (this.avatar?.morphs.has(channel)) continue;
      const value = combined[channel] ?? 0;
      for (const mesh of this.targetMeshes) {
        setMorphTargetInfluence(mesh, channel, value);
      }
    }
  }

  private applyPoseBones(): number {
    if (!this.avatar) return 0;
    let applied = 0;

    for (const [boneId, tuple] of Object.entries(this.latestPoseRotations)) {
      const bone = this.avatar.rig.getBone(boneId) ?? this.avatar.rig.resolveBone(boneId);
      if (!bone) continue;

      let entry = this.restBones.get(boneId);
      if (!entry) {
        entry = { bone, rest: bone.quaternion.clone() };
        this.restBones.set(boneId, entry);
      }

      let filter = this.boneFilters.get(boneId);
      if (!filter) {
        filter = new QuaternionOneEuroFilter(this.poseFilterConfig);
        this.boneFilters.set(boneId, filter);
      }

      this.tempQuat.set(tuple[0], tuple[1], tuple[2], tuple[3]).normalize();
      const smoothedDelta = filter.filter(this.tempQuat, this.elapsedSeconds);
      bone.quaternion.copy(entry.rest).multiply(smoothedDelta).normalize();
      applied += 1;
    }

    return applied;
  }

  private restoreAvatarToRest(): void {
    for (const { bone, rest } of this.restBones.values()) {
      bone.quaternion.copy(rest);
    }
    this.restBones.clear();

    if (this.avatar) {
      this.avatar.morphs.clearLayer(FACE_TRACKING_LAYER);
      this.avatar.morphs.clearLayer(FACE_VISEME_LAYER);
      this.avatar.morphs.clearLayer(FACE_EXPRESSION_LAYER);
    }

    if (this.targetMeshes.size > 0 && this.appliedExtraMorphs.size > 0) {
      for (const channel of this.appliedExtraMorphs) {
        for (const mesh of this.targetMeshes) {
          setMorphTargetInfluence(mesh, channel, 0);
        }
      }
      this.appliedExtraMorphs.clear();
    }
  }

  private releaseCapturedStream(): void {
    if (this.capturedVideoTrack) {
      try {
        this.capturedVideoTrack.stop();
      } catch {
        // Ignore track stop errors on already-ended tracks.
      }
      this.capturedVideoTrack = undefined;
    }
    if (this.capturedStream && typeof this.capturedStream.getTracks === 'function') {
      for (const track of this.capturedStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore track stop errors.
        }
      }
    }
    this.capturedStream = undefined;
    this.capturedFps = 0;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('AvatarCallStreamController has been disposed');
    }
  }
}

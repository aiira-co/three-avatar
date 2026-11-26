import {
  EXPRESSION_MOOD_IDS,
  MOOD_BUBBLE_MODES,
  MOOD_BUBBLE_PLACEMENTS,
  MOOD_BUBBLE_STYLES,
} from '../format/constants.js';
import type {
  AvatarMoodBubbleState,
  ExpressionMoodId,
  ExpressionReactionEnvelope,
  MoodBubbleSymbolId,
  VisemeCue,
} from '../format/types.js';
import { normalizeMoodBubbleState } from '../expressions/ExpressionController.js';
import { BUILTIN_EXPRESSION_PRESET_MAP } from '../expressions/ExpressionPresets.js';
import { OCULUS_VISEME_IDS } from '../expressions/LipSyncController.js';
import {
  parseSavedMocapClip,
  type SavedMocapClipData,
} from '../mocap/MocapClipRecorder.js';

export const AVATAR_MESSAGE_SCHEMA = 'interverse-avatar-message-v1' as const;
export const AVATAR_MESSAGE_VERSION = 1 as const;

/** Default strict UTF-8 serialized payload cap (64 KiB) for Messenger & Socket transport. */
export const AVATAR_MESSAGE_MAX_BYTES = 65_536;
/** Hard upper bound callers may opt into for high-detail custom mocap emotes (192 KiB). */
export const AVATAR_MESSAGE_HARD_MAX_BYTES = 196_608;
export const AVATAR_MESSAGE_MAX_CAPTION_LENGTH = 280;
export const AVATAR_MESSAGE_MAX_TRANSCRIPT_LENGTH = 500;
export const AVATAR_MESSAGE_MAX_VISEME_CUES = 512;
export const AVATAR_MESSAGE_MAX_WAVEFORM_SAMPLES = 128;
export const AVATAR_MESSAGE_MAX_EMOTE_FRAMES = 450;
export const AVATAR_MESSAGE_MAX_EMOTE_DURATION_SEC = 15;
export const AVATAR_MESSAGE_MAX_AUDIO_DURATION_MS = 120_000;
export const AVATAR_MESSAGE_MAX_URL_LENGTH = 1024;
export const AVATAR_MESSAGE_ENVELOPE_PREFIX = '[interverse-avatar:v1]' as const;

export const AVATAR_MESSAGE_KINDS = [
  'reaction_card',
  'mood_bubble',
  'voice_clip',
  'mocap_emote',
] as const;

export type AvatarMessageKind = (typeof AVATAR_MESSAGE_KINDS)[number];

export interface AvatarMessageSenderRef {
  personId?: number;
  avatarId?: string;
  displayName?: string;
}

export interface AvatarMessageBase {
  schema: typeof AVATAR_MESSAGE_SCHEMA;
  version: typeof AVATAR_MESSAGE_VERSION;
  kind: AvatarMessageKind;
  sentAt?: number;
  sender?: AvatarMessageSenderRef;
}

export interface AvatarReactionCardPayload extends AvatarMessageBase {
  kind: 'reaction_card';
  mood: ExpressionMoodId | string;
  intensity: number;
  caption?: string;
  accentColor?: string;
  bubbleSymbol?: MoodBubbleSymbolId;
  envelope?: ExpressionReactionEnvelope;
  snapshotUrl?: string;
}

export interface AvatarMoodBubblePayload extends AvatarMessageBase {
  kind: 'mood_bubble';
  mood: ExpressionMoodId | string;
  intensity: number;
  label?: string;
  durationSeconds?: number;
  bubble: AvatarMoodBubbleState;
}

export interface AvatarVoiceClipPayload extends AvatarMessageBase {
  kind: 'voice_clip';
  durationMs: number;
  audioUrl?: string;
  messageFileId?: number;
  waveform?: number[];
  visemeCues?: VisemeCue[];
  transcript?: string;
  mood?: ExpressionMoodId | string;
}

export interface AvatarMocapEmotePayload extends AvatarMessageBase {
  kind: 'mocap_emote';
  clip: SavedMocapClipData;
  loop: boolean;
  caption?: string;
  mood?: ExpressionMoodId | string;
}

export type AvatarMessagePayload =
  | AvatarReactionCardPayload
  | AvatarMoodBubblePayload
  | AvatarVoiceClipPayload
  | AvatarMocapEmotePayload;

export type AvatarMessageErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_OBJECT'
  | 'INVALID_SCHEMA'
  | 'INVALID_VERSION'
  | 'INVALID_KIND'
  | 'INVALID_FIELD'
  | 'INVALID_CLIP'
  | 'UNSAFE_URL'
  | 'PAYLOAD_TOO_LARGE';

export type AvatarMessageValidationResult =
  | { ok: true; payload: AvatarMessagePayload; byteLength: number }
  | { ok: false; code: AvatarMessageErrorCode; error: string };

export interface AvatarMessageCodecOptions {
  /** Maximum UTF-8 byte length permitted (clamped to `AVATAR_MESSAGE_HARD_MAX_BYTES`). */
  maxBytes?: number;
  /** Allow custom non-builtin mood IDs (alphanumeric/`_`/`-`, <= 32 chars). Default `false`. */
  allowCustomMoods?: boolean;
}

export class AvatarMessagePayloadError extends Error {
  constructor(
    readonly code: AvatarMessageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AvatarMessagePayloadError';
  }
}

const VALID_MOOD_SET = new Set<string>(EXPRESSION_MOOD_IDS);
const VALID_VISEME_SET = new Set<string>(OCULUS_VISEME_IDS);
const VALID_BUBBLE_STYLE_SET = new Set<string>(MOOD_BUBBLE_STYLES);
const VALID_BUBBLE_MODE_SET = new Set<string>(MOOD_BUBBLE_MODES);
const VALID_BUBBLE_PLACEMENT_SET = new Set<string>(MOOD_BUBBLE_PLACEMENTS);
const CUSTOM_MOOD_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const UTF8_ENCODER = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundTo(value: number, factor: number): number {
  return Math.round(value * factor) / factor;
}

function resolveMaxBytes(options?: AvatarMessageCodecOptions): number {
  const requested = options?.maxBytes;
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return AVATAR_MESSAGE_MAX_BYTES;
  }
  return Math.min(AVATAR_MESSAGE_HARD_MAX_BYTES, Math.max(256, Math.floor(requested)));
}

/**
 * Computes exact UTF-8 byte length of a string or JSON-serializable payload.
 */
export function estimatePayloadByteLength(value: string | unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return UTF8_ENCODER.encode(text).byteLength;
}

function sanitizeText(raw: unknown, maxLength: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function validateSafeMediaUrl(raw: unknown): { ok: true; url?: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, url: undefined };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Media URL must be a string' };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, url: undefined };
  if (trimmed.length > AVATAR_MESSAGE_MAX_URL_LENGTH) {
    return { ok: false, error: `Media URL exceeds ${AVATAR_MESSAGE_MAX_URL_LENGTH} characters` };
  }
  if (/^(javascript|vbscript|file):/i.test(trimmed)) {
    return { ok: false, error: 'Unsafe media URL scheme rejected' };
  }
  if (/^data:/i.test(trimmed)) {
    if (!/^data:(image\/(png|jpeg|webp)|audio\/(webm|ogg|mp4|mpeg));base64,/i.test(trimmed)) {
      return { ok: false, error: 'Only base64 image/audio data URLs are permitted' };
    }
    return { ok: true, url: trimmed };
  }
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/') || /^[a-z0-9._-]+\/[a-z0-9._/-]+$/i.test(trimmed)) {
    return { ok: true, url: trimmed };
  }
  return { ok: false, error: 'Media URL must be an https/http URL, relative asset path, or safe data URL' };
}

function validateMoodId(raw: unknown, allowCustom: boolean): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (VALID_MOOD_SET.has(trimmed)) return trimmed;
  if (allowCustom && CUSTOM_MOOD_RE.test(trimmed)) return trimmed;
  return undefined;
}

function normalizeSender(raw: unknown): AvatarMessageSenderRef | undefined {
  if (!isRecord(raw)) return undefined;
  const out: AvatarMessageSenderRef = {};
  if (typeof raw['personId'] === 'number' && Number.isSafeInteger(raw['personId']) && raw['personId'] > 0) {
    out.personId = raw['personId'];
  }
  const avatarId = sanitizeText(raw['avatarId'], 64);
  if (avatarId) out.avatarId = avatarId;
  const displayName = sanitizeText(raw['displayName'], 64);
  if (displayName) out.displayName = displayName;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeSentAt(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.floor(raw);
}

function normalizeEnvelope(raw: unknown): ExpressionReactionEnvelope | undefined {
  if (!isRecord(raw)) return undefined;
  const attack = raw['attack'];
  const hold = raw['hold'];
  const release = raw['release'];
  if (
    typeof attack !== 'number' || !Number.isFinite(attack)
    || typeof hold !== 'number' || !Number.isFinite(hold)
    || typeof release !== 'number' || !Number.isFinite(release)
  ) {
    return undefined;
  }
  return {
    attack: roundTo(clamp(attack, 0, 2), 1000),
    hold: roundTo(clamp(hold, 0.05, 8), 1000),
    release: roundTo(clamp(release, 0, 3), 1000),
  };
}

function normalizeWaveform(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const step = raw.length > AVATAR_MESSAGE_MAX_WAVEFORM_SAMPLES
    ? raw.length / AVATAR_MESSAGE_MAX_WAVEFORM_SAMPLES
    : 1;
  const samples: number[] = [];
  for (let i = 0; i < Math.min(raw.length, AVATAR_MESSAGE_MAX_WAVEFORM_SAMPLES); i++) {
    const val = raw[Math.floor(i * step)];
    if (typeof val !== 'number' || !Number.isFinite(val)) return undefined;
    samples.push(roundTo(clamp(val, 0, 1), 1000));
  }
  return samples;
}

function normalizeVisemeCues(raw: unknown): { ok: true; cues?: VisemeCue[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, cues: undefined };
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'visemeCues must be an array' };
  }
  if (raw.length > AVATAR_MESSAGE_MAX_VISEME_CUES) {
    return { ok: false, error: `visemeCues exceeds maximum of ${AVATAR_MESSAGE_MAX_VISEME_CUES} cues` };
  }
  const cues: VisemeCue[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return { ok: false, error: 'Each viseme cue must be an object' };
    const startTime = item['startTime'];
    const duration = item['duration'];
    const viseme = item['viseme'];
    if (
      typeof startTime !== 'number' || !Number.isFinite(startTime) || startTime < 0
      || typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0
      || typeof viseme !== 'string' || !VALID_VISEME_SET.has(viseme)
    ) {
      return { ok: false, error: 'Invalid viseme cue entry' };
    }
    const rawWeight = item['weight'];
    const weight =
      typeof rawWeight === 'number' && Number.isFinite(rawWeight)
        ? roundTo(clamp(rawWeight, 0, 1), 1000)
        : undefined;
    cues.push({
      startTime: roundTo(startTime, 10000),
      duration: roundTo(Math.min(10, duration), 10000),
      viseme,
      ...(weight !== undefined ? { weight } : {}),
    });
  }
  cues.sort((a, b) => a.startTime - b.startTime);
  return { ok: true, cues };
}

/**
 * Validates and normalizes an unknown object or JSON string into a strict
 * `interverse-avatar-message-v1` payload, enforcing schema and byte-size budgets.
 */
export function validateAvatarMessagePayload(
  raw: unknown,
  options: AvatarMessageCodecOptions = {},
): AvatarMessageValidationResult {
  const maxBytes = resolveMaxBytes(options);
  const allowCustomMoods = options.allowCustomMoods ?? false;

  let value: unknown = raw;
  if (typeof raw === 'string') {
    const rawByteLength = estimatePayloadByteLength(raw);
    if (rawByteLength > maxBytes) {
      return {
        ok: false,
        code: 'PAYLOAD_TOO_LARGE',
        error: `Serialized payload (${rawByteLength} bytes) exceeds limit of ${maxBytes} bytes`,
      };
    }
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, code: 'INVALID_JSON', error: 'Avatar message payload is not valid JSON' };
    }
  }

  if (!isRecord(value)) {
    return { ok: false, code: 'INVALID_OBJECT', error: 'Avatar message payload must be a JSON object' };
  }
  if (value['schema'] !== AVATAR_MESSAGE_SCHEMA) {
    return {
      ok: false,
      code: 'INVALID_SCHEMA',
      error: `Unsupported schema "${String(value['schema'] ?? '')}"; expected "${AVATAR_MESSAGE_SCHEMA}"`,
    };
  }
  if (value['version'] !== AVATAR_MESSAGE_VERSION) {
    return {
      ok: false,
      code: 'INVALID_VERSION',
      error: `Unsupported version "${String(value['version'] ?? '')}"; expected ${AVATAR_MESSAGE_VERSION}`,
    };
  }

  const kind = value['kind'];
  if (typeof kind !== 'string' || !(AVATAR_MESSAGE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, code: 'INVALID_KIND', error: `Unsupported avatar message kind "${String(kind ?? '')}"` };
  }

  const base: Omit<AvatarMessageBase, 'kind'> = {
    schema: AVATAR_MESSAGE_SCHEMA,
    version: AVATAR_MESSAGE_VERSION,
    ...(normalizeSentAt(value['sentAt']) !== undefined ? { sentAt: normalizeSentAt(value['sentAt']) } : {}),
    ...(normalizeSender(value['sender']) ? { sender: normalizeSender(value['sender']) } : {}),
  };

  let payload: AvatarMessagePayload;

  switch (kind as AvatarMessageKind) {
    case 'reaction_card': {
      const mood = validateMoodId(value['mood'], allowCustomMoods);
      if (!mood) {
        return { ok: false, code: 'INVALID_FIELD', error: 'reaction_card requires a valid mood ID' };
      }
      const rawIntensity = value['intensity'];
      const intensity =
        typeof rawIntensity === 'number' && Number.isFinite(rawIntensity)
          ? roundTo(clamp(rawIntensity, 0.05, 1), 100)
          : 1;
      const preset = BUILTIN_EXPRESSION_PRESET_MAP.get(mood);
      const caption = sanitizeText(value['caption'], AVATAR_MESSAGE_MAX_CAPTION_LENGTH);
      const rawColor = typeof value['accentColor'] === 'string' ? value['accentColor'].trim() : '';
      const accentColor = HEX_COLOR_RE.test(rawColor) ? rawColor : preset?.accentColor;
      const bubbleSymbol =
        typeof value['bubbleSymbol'] === 'string' && value['bubbleSymbol'].trim().length > 0
          ? (value['bubbleSymbol'].trim() as MoodBubbleSymbolId)
          : preset?.bubbleSymbol;
      const envelope = normalizeEnvelope(value['envelope']);
      const urlCheck = validateSafeMediaUrl(value['snapshotUrl']);
      if (!urlCheck.ok) {
        return { ok: false, code: 'UNSAFE_URL', error: urlCheck.error };
      }
      payload = {
        ...base,
        kind: 'reaction_card',
        mood,
        intensity,
        ...(caption ? { caption } : {}),
        ...(accentColor ? { accentColor } : {}),
        ...(bubbleSymbol ? { bubbleSymbol } : {}),
        ...(envelope ? { envelope } : {}),
        ...(urlCheck.url ? { snapshotUrl: urlCheck.url } : {}),
      };
      break;
    }

    case 'mood_bubble': {
      const mood = validateMoodId(value['mood'], allowCustomMoods);
      if (!mood) {
        return { ok: false, code: 'INVALID_FIELD', error: 'mood_bubble requires a valid mood ID' };
      }
      const rawIntensity = value['intensity'];
      const intensity =
        typeof rawIntensity === 'number' && Number.isFinite(rawIntensity)
          ? roundTo(clamp(rawIntensity, 0.05, 1), 100)
          : 1;
      const rawBubble = value['bubble'];
      if (rawBubble !== undefined && !isRecord(rawBubble)) {
        return { ok: false, code: 'INVALID_FIELD', error: 'mood_bubble.bubble must be an object when provided' };
      }
      if (isRecord(rawBubble)) {
        if (rawBubble['style'] !== undefined && (typeof rawBubble['style'] !== 'string' || !VALID_BUBBLE_STYLE_SET.has(rawBubble['style']))) {
          return { ok: false, code: 'INVALID_FIELD', error: 'Invalid mood bubble style' };
        }
        if (rawBubble['mode'] !== undefined && (typeof rawBubble['mode'] !== 'string' || !VALID_BUBBLE_MODE_SET.has(rawBubble['mode']))) {
          return { ok: false, code: 'INVALID_FIELD', error: 'Invalid mood bubble mode' };
        }
        if (rawBubble['placement'] !== undefined && (typeof rawBubble['placement'] !== 'string' || !VALID_BUBBLE_PLACEMENT_SET.has(rawBubble['placement']))) {
          return { ok: false, code: 'INVALID_FIELD', error: 'Invalid mood bubble placement' };
        }
      }
      const bubble = normalizeMoodBubbleState(rawBubble);
      const label = sanitizeText(value['label'], 64);
      const rawDuration = value['durationSeconds'];
      const durationSeconds =
        typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration > 0
          ? roundTo(clamp(rawDuration, 0.5, 30), 100)
          : undefined;
      payload = {
        ...base,
        kind: 'mood_bubble',
        mood,
        intensity,
        bubble,
        ...(label ? { label } : {}),
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      };
      break;
    }

    case 'voice_clip': {
      const rawDurationMs = value['durationMs'];
      if (
        typeof rawDurationMs !== 'number'
        || !Number.isFinite(rawDurationMs)
        || rawDurationMs <= 0
        || rawDurationMs > AVATAR_MESSAGE_MAX_AUDIO_DURATION_MS
      ) {
        return {
          ok: false,
          code: 'INVALID_FIELD',
          error: `voice_clip.durationMs must be between 1 and ${AVATAR_MESSAGE_MAX_AUDIO_DURATION_MS}`,
        };
      }
      const urlCheck = validateSafeMediaUrl(value['audioUrl']);
      if (!urlCheck.ok) {
        return { ok: false, code: 'UNSAFE_URL', error: urlCheck.error };
      }
      const rawFileId = value['messageFileId'];
      const messageFileId =
        typeof rawFileId === 'number' && Number.isSafeInteger(rawFileId) && rawFileId > 0
          ? rawFileId
          : undefined;
      const transcript = sanitizeText(value['transcript'], AVATAR_MESSAGE_MAX_TRANSCRIPT_LENGTH);
      const visemeCheck = normalizeVisemeCues(value['visemeCues']);
      if (!visemeCheck.ok) {
        return { ok: false, code: 'INVALID_FIELD', error: visemeCheck.error };
      }
      if (!urlCheck.url && !messageFileId && !transcript && (!visemeCheck.cues || visemeCheck.cues.length === 0)) {
        return {
          ok: false,
          code: 'INVALID_FIELD',
          error: 'voice_clip requires at least one of audioUrl, messageFileId, transcript, or visemeCues',
        };
      }
      const waveform = value['waveform'] !== undefined ? normalizeWaveform(value['waveform']) : undefined;
      if (value['waveform'] !== undefined && !waveform) {
        return { ok: false, code: 'INVALID_FIELD', error: 'voice_clip.waveform must be a non-empty array of finite numbers' };
      }
      const mood = value['mood'] !== undefined ? validateMoodId(value['mood'], allowCustomMoods) : undefined;
      if (value['mood'] !== undefined && !mood) {
        return { ok: false, code: 'INVALID_FIELD', error: 'voice_clip.mood is invalid' };
      }
      payload = {
        ...base,
        kind: 'voice_clip',
        durationMs: Math.round(rawDurationMs),
        ...(urlCheck.url ? { audioUrl: urlCheck.url } : {}),
        ...(messageFileId !== undefined ? { messageFileId } : {}),
        ...(waveform ? { waveform } : {}),
        ...(visemeCheck.cues ? { visemeCues: visemeCheck.cues } : {}),
        ...(transcript ? { transcript } : {}),
        ...(mood ? { mood } : {}),
      };
      break;
    }

    case 'mocap_emote': {
      const clip = parseSavedMocapClip(value['clip']);
      if (!clip) {
        return { ok: false, code: 'INVALID_CLIP', error: 'mocap_emote requires a valid SavedMocapClipData clip' };
      }
      if (clip.frames.length > AVATAR_MESSAGE_MAX_EMOTE_FRAMES) {
        return {
          ok: false,
          code: 'INVALID_CLIP',
          error: `mocap_emote clip exceeds maximum of ${AVATAR_MESSAGE_MAX_EMOTE_FRAMES} frames`,
        };
      }
      if (clip.duration > AVATAR_MESSAGE_MAX_EMOTE_DURATION_SEC) {
        return {
          ok: false,
          code: 'INVALID_CLIP',
          error: `mocap_emote clip duration (${clip.duration}s) exceeds limit of ${AVATAR_MESSAGE_MAX_EMOTE_DURATION_SEC}s`,
        };
      }
      const loop = typeof value['loop'] === 'boolean' ? value['loop'] : false;
      const caption = sanitizeText(value['caption'], AVATAR_MESSAGE_MAX_CAPTION_LENGTH);
      const mood = value['mood'] !== undefined ? validateMoodId(value['mood'], allowCustomMoods) : undefined;
      if (value['mood'] !== undefined && !mood) {
        return { ok: false, code: 'INVALID_FIELD', error: 'mocap_emote.mood is invalid' };
      }
      payload = {
        ...base,
        kind: 'mocap_emote',
        clip,
        loop,
        ...(caption ? { caption } : {}),
        ...(mood ? { mood } : {}),
      };
      break;
    }
  }

  const serialized = JSON.stringify(payload);
  const byteLength = estimatePayloadByteLength(serialized);
  if (byteLength > maxBytes) {
    return {
      ok: false,
      code: 'PAYLOAD_TOO_LARGE',
      error: `Serialized payload (${byteLength} bytes) exceeds limit of ${maxBytes} bytes`,
    };
  }

  return { ok: true, payload, byteLength };
}

/**
 * Parses an unknown value or JSON string into a validated `AvatarMessagePayload`,
 * returning `undefined` on any schema, security, or byte-limit violation.
 */
export function parseAvatarMessagePayload(
  raw: unknown,
  options: AvatarMessageCodecOptions = {},
): AvatarMessagePayload | undefined {
  const result = validateAvatarMessagePayload(raw, options);
  return result.ok ? result.payload : undefined;
}

/**
 * Validates and serializes an `AvatarMessagePayload` to compact JSON.
 * Throws `AvatarMessagePayloadError` if invalid or over the byte budget.
 */
export function serializeAvatarMessagePayload(
  payload: AvatarMessagePayload,
  options: AvatarMessageCodecOptions = {},
): string {
  const result = validateAvatarMessagePayload(payload, options);
  if (!result.ok) {
    throw new AvatarMessagePayloadError(result.code, result.error);
  }
  return JSON.stringify(result.payload);
}

/**
 * Wraps a serialized avatar payload with a lightweight text envelope prefix so
 * legacy text-only chat fields (`IMessage.description`) can transport structured
 * avatar messages cleanly alongside plain text messages.
 */
export function encodeAvatarMessageEnvelope(
  payload: AvatarMessagePayload,
  options: AvatarMessageCodecOptions = {},
): string {
  const json = serializeAvatarMessagePayload(payload, options);
  return `${AVATAR_MESSAGE_ENVELOPE_PREFIX}${json}`;
}

/**
 * Detects and decodes an avatar message envelope (or bare JSON payload) from
 * a Messenger message description string.
 */
export function decodeAvatarMessageEnvelope(
  text: string | null | undefined,
  options: AvatarMessageCodecOptions = {},
): AvatarMessagePayload | undefined {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith(AVATAR_MESSAGE_ENVELOPE_PREFIX)) {
    return parseAvatarMessagePayload(trimmed.slice(AVATAR_MESSAGE_ENVELOPE_PREFIX.length), options);
  }
  if (trimmed.startsWith('{') && trimmed.includes(AVATAR_MESSAGE_SCHEMA)) {
    return parseAvatarMessagePayload(trimmed, options);
  }
  return undefined;
}

export function createAvatarReactionCard(input: {
  mood: ExpressionMoodId | string;
  intensity?: number;
  caption?: string;
  accentColor?: string;
  bubbleSymbol?: MoodBubbleSymbolId;
  envelope?: ExpressionReactionEnvelope;
  snapshotUrl?: string;
  sender?: AvatarMessageSenderRef;
  sentAt?: number;
}, options?: AvatarMessageCodecOptions): AvatarReactionCardPayload {
  const result = validateAvatarMessagePayload(
    {
      schema: AVATAR_MESSAGE_SCHEMA,
      version: AVATAR_MESSAGE_VERSION,
      kind: 'reaction_card',
      ...input,
      intensity: input.intensity ?? 1,
      sentAt: input.sentAt ?? Date.now(),
    },
    options,
  );
  if (!result.ok) {
    throw new AvatarMessagePayloadError(result.code, result.error);
  }
  return result.payload as AvatarReactionCardPayload;
}

export function createAvatarMoodBubble(input: {
  mood: ExpressionMoodId | string;
  intensity?: number;
  label?: string;
  durationSeconds?: number;
  bubble?: Partial<AvatarMoodBubbleState>;
  sender?: AvatarMessageSenderRef;
  sentAt?: number;
}, options?: AvatarMessageCodecOptions): AvatarMoodBubblePayload {
  const result = validateAvatarMessagePayload(
    {
      schema: AVATAR_MESSAGE_SCHEMA,
      version: AVATAR_MESSAGE_VERSION,
      kind: 'mood_bubble',
      ...input,
      intensity: input.intensity ?? 1,
      bubble: normalizeMoodBubbleState(input.bubble),
      sentAt: input.sentAt ?? Date.now(),
    },
    options,
  );
  if (!result.ok) {
    throw new AvatarMessagePayloadError(result.code, result.error);
  }
  return result.payload as AvatarMoodBubblePayload;
}

export function createAvatarVoiceClip(input: {
  durationMs: number;
  audioUrl?: string;
  messageFileId?: number;
  waveform?: number[];
  visemeCues?: VisemeCue[];
  transcript?: string;
  mood?: ExpressionMoodId | string;
  sender?: AvatarMessageSenderRef;
  sentAt?: number;
}, options?: AvatarMessageCodecOptions): AvatarVoiceClipPayload {
  const result = validateAvatarMessagePayload(
    {
      schema: AVATAR_MESSAGE_SCHEMA,
      version: AVATAR_MESSAGE_VERSION,
      kind: 'voice_clip',
      ...input,
      sentAt: input.sentAt ?? Date.now(),
    },
    options,
  );
  if (!result.ok) {
    throw new AvatarMessagePayloadError(result.code, result.error);
  }
  return result.payload as AvatarVoiceClipPayload;
}

export function createAvatarMocapEmote(input: {
  clip: SavedMocapClipData;
  loop?: boolean;
  caption?: string;
  mood?: ExpressionMoodId | string;
  sender?: AvatarMessageSenderRef;
  sentAt?: number;
}, options?: AvatarMessageCodecOptions): AvatarMocapEmotePayload {
  const result = validateAvatarMessagePayload(
    {
      schema: AVATAR_MESSAGE_SCHEMA,
      version: AVATAR_MESSAGE_VERSION,
      kind: 'mocap_emote',
      ...input,
      loop: input.loop ?? false,
      sentAt: input.sentAt ?? Date.now(),
    },
    options,
  );
  if (!result.ok) {
    throw new AvatarMessagePayloadError(result.code, result.error);
  }
  return result.payload as AvatarMocapEmotePayload;
}

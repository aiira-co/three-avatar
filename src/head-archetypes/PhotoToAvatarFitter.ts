import type { AvatarHeadArchetypeState } from '../format/types.js';
import {
  DEFAULT_SKIN_DETAIL_STRENGTH,
  normalizeHeadArchetypeState,
} from './HeadArchetypeController.js';

export interface PhotoFaceShapeHints {
  /** Face width-to-height ratio derived from the detected skin silhouette (~0.52..1.15). */
  aspectRatio: number;
  /** Lower-jaw width relative to cheekbone width (~0.48..1.08). */
  jawRatio: number;
  /** Cheekbone width relative to forehead width (~0.70..1.30). */
  cheekRatio: number;
  /** Suggested jaw-width sculpt delta (-100..100). */
  jawWidth: number;
  /** Suggested cheekbone prominence sculpt delta (-100..100). */
  cheekbones: number;
  /** Suggested cheek fullness sculpt delta (-100..100). */
  cheeks: number;
  /** Suggested chin-length sculpt delta (-100..100). */
  chinLength: number;
  /** Suggested eye-width sculpt delta (-100..100). */
  eyeWidth: number;
}

export interface PhotoToAvatarProposal {
  /** Sampled forehead/cheek skin tone as lowercase `#rrggbb`. */
  skinColor: string;
  /** Sampled hair crown color as lowercase `#rrggbb`. */
  hairColor: string;
  /** Sampled eye iris tone as lowercase `#rrggbb`. */
  irisColor: string;
  /** Proposed head archetype blend state over built-in archetypes. */
  headArchetypes: AvatarHeadArchetypeState;
  /** Geometric ratios and suggested procedural face-shape hints. */
  faceShapeHints: PhotoFaceShapeHints;
  /** Portrait analysis confidence in `0..1`. */
  confidence: number;
}

interface RgbSample {
  r: number;
  g: number;
  b: number;
  luma: number;
}

interface HslColor {
  h: number;
  s: number;
  l: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function rgbToHex(r: number, g: number, b: number): string {
  const toByte = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

function rgbLuma(r: number, g: number, b: number): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function rgbToHsl(r: number, g: number, b: number): HslColor {
  const rn = clamp(r, 0, 255) / 255;
  const gn = clamp(g, 0, 255) / 255;
  const bn = clamp(b, 0, 255) / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-6) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hn = ((h % 360) + 360) % 360;
  const sn = clamp(s, 0, 1);
  const ln = clamp(l, 0, 1);
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hn < 60) [r, g, b] = [c, x, 0];
  else if (hn < 120) [r, g, b] = [x, c, 0];
  else if (hn < 180) [r, g, b] = [0, c, x];
  else if (hn < 240) [r, g, b] = [0, x, c];
  else if (hn < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function rgbDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Broad skin-tone classifier in YCbCr + RGB space supporting Fitzpatrick I–VI
 * while rejecting neutral gray/white backgrounds, green screens, and deep shadows.
 */
function isLikelySkinPixel(r: number, g: number, b: number, a: number): boolean {
  if (a < 128) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 6) return false;
  if (r < g * 0.90 || r < b * 0.98) return false;
  if (r - b < 5) return false;
  const luma = rgbLuma(r, g, b);
  if (luma < 0.08 || luma > 0.95) return false;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return cb >= 70 && cb <= 136 && cr >= 129 && cr <= 184;
}

function trimmedMeanRgb(samples: readonly RgbSample[], lowFrac = 0.15, highFrac = 0.85): [number, number, number] {
  if (samples.length === 0) return [171, 99, 52];
  const sorted = [...samples].sort((a, b) => a.luma - b.luma);
  const start = Math.floor(sorted.length * lowFrac);
  const end = Math.max(start + 1, Math.ceil(sorted.length * highFrac));
  let sr = 0;
  let sg = 0;
  let sb = 0;
  const count = end - start;
  for (let i = start; i < end; i++) {
    const sample = sorted[i]!;
    sr += sample.r;
    sg += sample.g;
    sb += sample.b;
  }
  return [sr / count, sg / count, sb / count];
}

function computeSampleStdDev(samples: readonly RgbSample[]): number {
  if (samples.length < 2) return 0;
  let mean = 0;
  for (const s of samples) mean += s.luma;
  mean /= samples.length;
  let variance = 0;
  for (const s of samples) {
    const d = s.luma - mean;
    variance += d * d;
  }
  return Math.sqrt(variance / samples.length);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : ((sorted[mid - 1]! + sorted[mid]!) * 0.5);
}

function collectRegionSamples(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  x0Frac: number,
  x1Frac: number,
  y0Frac: number,
  y1Frac: number,
  predicate?: (r: number, g: number, b: number, a: number) => boolean,
): RgbSample[] {
  const x0 = clamp(Math.floor(x0Frac * width), 0, width - 1);
  const x1 = clamp(Math.ceil(x1Frac * width), x0 + 1, width);
  const y0 = clamp(Math.floor(y0Frac * height), 0, height - 1);
  const y1 = clamp(Math.ceil(y1Frac * height), y0 + 1, height);
  const out: RgbSample[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = (y * width + x) * 4;
      const r = rgba[idx] ?? 0;
      const g = rgba[idx + 1] ?? 0;
      const b = rgba[idx + 2] ?? 0;
      const a = rgba[idx + 3] ?? 255;
      if (a < 128) continue;
      if (predicate && !predicate(r, g, b, a)) continue;
      out.push({ r, g, b, luma: rgbLuma(r, g, b) });
    }
  }
  return out;
}

function estimateBackgroundRgb(rgba: ArrayLike<number>, width: number, height: number): [number, number, number] {
  const corners = [
    ...collectRegionSamples(rgba, width, height, 0, 0.1, 0, 0.1),
    ...collectRegionSamples(rgba, width, height, 0.9, 1, 0, 0.1),
    ...collectRegionSamples(rgba, width, height, 0, 0.08, 0.85, 0.98),
    ...collectRegionSamples(rgba, width, height, 0.92, 1, 0.85, 0.98),
  ];
  return corners.length > 0 ? trimmedMeanRgb(corners, 0.2, 0.8) : [235, 235, 235];
}

function measureFaceGeometry(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  skinRgb: readonly [number, number, number],
): {
  topFrac: number;
  bottomFrac: number;
  aspectRatio: number;
  jawRatio: number;
  cheekRatio: number;
  coverage: number;
} {
  const xStart = Math.floor(width * 0.10);
  const xEnd = Math.ceil(width * 0.90);
  const yStart = Math.floor(height * 0.12);
  const yEnd = Math.ceil(height * 0.92);
  const [sr, sg, sb] = skinRgb;

  const rowWidths: { y: number; width: number }[] = [];
  let skinPixels = 0;
  let totalChecked = 0;

  for (let y = yStart; y < yEnd; y++) {
    const xs: number[] = [];
    for (let x = xStart; x < xEnd; x++) {
      totalChecked++;
      const idx = (y * width + x) * 4;
      const r = rgba[idx] ?? 0;
      const g = rgba[idx + 1] ?? 0;
      const b = rgba[idx + 2] ?? 0;
      const a = rgba[idx + 3] ?? 255;
      if (a < 128) continue;
      const dist = rgbDistance(r, g, b, sr, sg, sb);
      if (dist < 46 || (dist < 82 && isLikelySkinPixel(r, g, b, a))) {
        xs.push(x);
        skinPixels++;
      }
    }
    if (xs.length >= Math.max(3, Math.floor(width * 0.06))) {
      const pLow = xs[Math.floor(xs.length * 0.04)]!;
      const pHigh = xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.96))]!;
      rowWidths.push({ y, width: Math.max(1, pHigh - pLow + 1) });
    }
  }

  const coverage = totalChecked > 0 ? skinPixels / totalChecked : 0;
  if (rowWidths.length < Math.max(4, Math.floor(height * 0.12))) {
    return {
      topFrac: 0.20,
      bottomFrac: 0.80,
      aspectRatio: 0.74,
      jawRatio: 0.78,
      cheekRatio: 1.0,
      coverage,
    };
  }

  const topY = rowWidths[0]!.y;
  const bottomY = rowWidths[rowWidths.length - 1]!.y;
  const faceHeight = Math.max(1, bottomY - topY + 1);

  const bandWidths = (t0: number, t1: number): number[] => {
    const minY = topY + faceHeight * t0;
    const maxY = topY + faceHeight * t1;
    return rowWidths.filter((row) => row.y >= minY && row.y <= maxY).map((row) => row.width);
  };

  const foreheadW = median(bandWidths(0.20, 0.32));
  const cheekW = median(bandWidths(0.42, 0.56));
  const jawW = median(bandWidths(0.70, 0.82));

  const fallbackCheek = cheekW || median(rowWidths.map((r) => r.width)) || faceHeight * 0.74;
  const effectiveForehead = foreheadW || fallbackCheek / 1.14;
  const effectiveJaw = jawW || fallbackCheek * 0.75;

  return {
    topFrac: clamp(topY / height, 0.08, 0.40),
    bottomFrac: clamp(bottomY / height, 0.55, 0.94),
    aspectRatio: clamp(fallbackCheek / faceHeight, 0.52, 1.15),
    jawRatio: clamp(effectiveJaw / Math.max(1, fallbackCheek), 0.48, 1.08),
    cheekRatio: clamp(fallbackCheek / Math.max(1, effectiveForehead), 0.75, 1.45),
    coverage,
  };
}

function sampleHairColor(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  faceTopFrac: number,
  skinRgb: readonly [number, number, number],
  bgRgb: readonly [number, number, number],
): string {
  const crownEnd = clamp(faceTopFrac + 0.02, 0.14, 0.28);
  const crownStart = clamp(crownEnd - 0.16, 0.02, 0.12);
  const [sr, sg, sb] = skinRgb;
  const [br, bg, bb] = bgRgb;

  const crownPixels = collectRegionSamples(
    rgba,
    width,
    height,
    0.26,
    0.74,
    crownStart,
    crownEnd,
    (r, g, b) => rgbDistance(r, g, b, sr, sg, sb) > 24 && rgbDistance(r, g, b, br, bg, bb) > 22,
  );
  if (crownPixels.length >= Math.max(4, Math.floor(width * height * 0.0025))) {
    const [hr, hg, hb] = trimmedMeanRgb(crownPixels, 0.18, 0.78);
    return rgbToHex(hr, hg, hb);
  }

  // Fallback: sample slightly wider temple/crown band ignoring only background.
  const wideCrown = collectRegionSamples(
    rgba,
    width,
    height,
    0.22,
    0.78,
    0.03,
    crownEnd,
    (r, g, b) => rgbDistance(r, g, b, br, bg, bb) > 20,
  );
  if (wideCrown.length >= 4) {
    const [hr, hg, hb] = trimmedMeanRgb(wideCrown, 0.15, 0.75);
    return rgbToHex(hr, hg, hb);
  }

  // Fallback for bald portraits: darkest natural eyebrow/shadow tone or rich espresso.
  const browPixels = collectRegionSamples(rgba, width, height, 0.30, 0.70, faceTopFrac + 0.12, faceTopFrac + 0.24);
  if (browPixels.length >= 4) {
    const [hr, hg, hb] = trimmedMeanRgb(browPixels, 0.05, 0.30);
    return rgbToHex(hr * 0.72, hg * 0.72, hb * 0.72);
  }
  return '#3b251d';
}

function sampleIrisColor(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  faceTopFrac: number,
  faceBottomFrac: number,
  skinRgb: readonly [number, number, number],
): { irisColor: string; irisSaturation: number; irisSampleCount: number } {
  const span = Math.max(0.25, faceBottomFrac - faceTopFrac);
  const eyeY0 = clamp(faceTopFrac + span * 0.30, 0.25, 0.60);
  const eyeY1 = clamp(faceTopFrac + span * 0.48, eyeY0 + 0.05, 0.72);
  const [sr, sg, sb] = skinRgb;

  const isEyeCandidate = (r: number, g: number, b: number, a: number): boolean => {
    if (a < 128) return false;
    const hsl = rgbToHsl(r, g, b);
    // Reject bright sclera whites and pure-black pupils.
    if (hsl.l > 0.80 && hsl.s < 0.26) return false;
    if (hsl.l < 0.06) return false;
    // Reject pixels close to surrounding face skin so iris pigment is never swamped by skin.
    const dist = rgbDistance(r, g, b, sr, sg, sb);
    if (dist <= 30) return false;
    if (isLikelySkinPixel(r, g, b, a) && dist < 50) return false;
    return true;
  };

  const candidates = [
    ...collectRegionSamples(rgba, width, height, 0.30, 0.45, eyeY0, eyeY1, isEyeCandidate),
    ...collectRegionSamples(rgba, width, height, 0.55, 0.70, eyeY0, eyeY1, isEyeCandidate),
  ];

  if (candidates.length === 0) {
    return { irisColor: '#4c3222', irisSaturation: 0.38, irisSampleCount: 0 };
  }

  // Weight toward saturated/mid-luminance iris pixels so blue/green/hazel/anime irises stand out over lashes.
  let sumW = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (const s of candidates) {
    const hsl = rgbToHsl(s.r, s.g, s.b);
    const lumaWeight = 1 - Math.abs(hsl.l - 0.40) * 1.4;
    const w = Math.max(0.15, lumaWeight) * (1 + hsl.s * 3.5);
    sumW += w;
    sumR += s.r * w;
    sumG += s.g * w;
    sumB += s.b * w;
  }

  let ir = sumR / sumW;
  let ig = sumG / sumW;
  let ib = sumB / sumW;
  const irisHsl = rgbToHsl(ir, ig, ib);
  // Keep iris color legible on 3D eyeballs (never pitch black or washed-out white).
  const clampedL = clamp(irisHsl.l, 0.16, 0.64);
  if (Math.abs(clampedL - irisHsl.l) > 0.01) {
    [ir, ig, ib] = hslToRgb(irisHsl.h, Math.max(irisHsl.s, 0.22), clampedL);
  }
  return {
    irisColor: rgbToHex(ir, ig, ib),
    irisSaturation: irisHsl.s,
    irisSampleCount: candidates.length,
  };
}

function proposeHeadArchetypes(
  skinRgb: readonly [number, number, number],
  skinVariance: number,
  irisSaturation: number,
  aspectRatio: number,
  jawRatio: number,
  cheekRatio: number,
): AvatarHeadArchetypeState {
  const [r, g, b] = skinRgb;
  const hsl = rgbToHsl(r, g, b);
  const warmth = clamp((r - b) / 255, 0, 1);

  // Smooth, deterministic affinity scores across the 6 built-in head archetypes.
  const scores = {
    black: 0,
    south_asian: 0,
    east_asian: 0,
    chinese: 0,
    angular: 0,
    manga: 0,
  };

  // Deep warm tones + fuller cheek/midface proportions.
  if (hsl.l < 0.42) {
    scores.black += (0.42 - hsl.l) * 2.4 + Math.max(0, aspectRatio - 0.70) * 0.9;
  }
  if (hsl.l >= 0.30 && hsl.l <= 0.60) {
    const midBell = 1 - Math.abs(hsl.l - 0.45) / 0.18;
    scores.south_asian += Math.max(0, midBell) * 0.95 + warmth * 0.45;
  }

  // Prominent cheekbones + softer tapered jaw (canonical oval baseline cheekRatio ≈ 1.14, jawRatio ≈ 0.75).
  if (cheekRatio >= 1.15) {
    scores.east_asian += (cheekRatio - 1.14) * 3.0 + Math.max(0, 0.77 - jawRatio) * 1.1;
    scores.chinese += (cheekRatio - 1.15) * 2.8 + Math.max(0, 0.75 - jawRatio) * 1.2;
  }
  if (hsl.l >= 0.56 && hsl.l <= 0.86 && aspectRatio >= 0.68 && jawRatio <= 0.78) {
    scores.east_asian += 0.24;
    scores.chinese += 0.20;
  }

  // Elongated face or defined square/sculpted jaw.
  if (aspectRatio < 0.71) {
    scores.angular += (0.71 - aspectRatio) * 3.6;
  }
  if (jawRatio > 0.77) {
    scores.angular += (jawRatio - 0.76) * 3.2;
  }

  // Stylized / illustrated / anime portrait cues: ultra-smooth flat skin + vivid iris + tapered jaw.
  const flatSkinBonus = skinVariance < 0.025 ? (0.025 - skinVariance) * 18 : 0;
  const vividIrisBonus = irisSaturation > 0.58 ? (irisSaturation - 0.58) * 2.6 : 0;
  const taperedChinBonus = jawRatio < 0.71 ? (0.71 - jawRatio) * 2.4 : 0;
  if (flatSkinBonus > 0.15 && (vividIrisBonus > 0.25 || taperedChinBonus > 0.18)) {
    scores.manga += flatSkinBonus + vividIrisBonus + taperedChinBonus;
  }

  const ranked = Object.entries(scores)
    .filter(([, score]) => score > 0.08)
    .sort((a, b) => b[1] - a[1]);

  if (ranked.length === 0) {
    return normalizeHeadArchetypeState({ weights: { angular: 0.35 } });
  }

  const topTwo = ranked.slice(0, 2);
  const topSum = topTwo.reduce((acc, [, s]) => acc + s, 0);
  const targetTotal = clamp(0.45 + Math.min(0.45, topSum * 0.35), 0.45, 0.90);

  const weights: Record<string, number> = {};
  for (const [id, score] of topTwo) {
    const w = roundTo((score / topSum) * targetTotal, 2);
    if (w >= 0.08) weights[id] = w;
  }

  // Smooth illustrated portraits prefer softer skin pores; photographic portraits keep natural micro-detail.
  const detailStrength = (weights['manga'] ?? 0) >= 0.45
    ? 0.25
    : skinVariance > 0.06
      ? 0.65
      : DEFAULT_SKIN_DETAIL_STRENGTH;

  return normalizeHeadArchetypeState({ weights, detailStrength });
}

/**
 * Pure, deterministic, client-side portrait pixel analyzer.
 * Samples forehead/cheek skin tone, hair crown color, eye iris tone, and silhouette ratios
 * directly from an RGBA buffer (e.g. a 128×128 `<canvas>` snapshot) with zero network calls.
 */
export function analyzePortraitPixels(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
): PhotoToAvatarProposal {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 4 || height < 4) {
    throw new RangeError(`analyzePortraitPixels: width and height must be integers >= 4 (got ${width}x${height}).`);
  }
  if (rgba.length < width * height * 4) {
    throw new RangeError(
      `analyzePortraitPixels: RGBA buffer length (${rgba.length}) is smaller than ${width * height * 4}.`,
    );
  }

  // 1. Sample skin tone across forehead + left/right cheeks.
  const skinRois: readonly [number, number, number, number][] = [
    [0.36, 0.64, 0.22, 0.35], // forehead
    [0.28, 0.42, 0.48, 0.62], // left cheek
    [0.58, 0.72, 0.48, 0.62], // right cheek
  ];
  const strictSkinSamples: RgbSample[] = [];
  const fallbackSkinSamples: RgbSample[] = [];
  for (const [x0, x1, y0, y1] of skinRois) {
    strictSkinSamples.push(...collectRegionSamples(rgba, width, height, x0, x1, y0, y1, isLikelySkinPixel));
    fallbackSkinSamples.push(...collectRegionSamples(rgba, width, height, x0, x1, y0, y1));
  }

  const useStrict = strictSkinSamples.length >= Math.max(6, Math.floor(fallbackSkinSamples.length * 0.15));
  const skinSamples = useStrict ? strictSkinSamples : fallbackSkinSamples;
  const skinRgb = trimmedMeanRgb(skinSamples, 0.15, 0.85);
  const skinColor = rgbToHex(skinRgb[0], skinRgb[1], skinRgb[2]);
  const skinVariance = computeSampleStdDev(skinSamples);

  // 2. Measure face silhouette ratios (aspect, jaw-to-cheek, cheek-to-forehead).
  const bgRgb = estimateBackgroundRgb(rgba, width, height);
  const geom = measureFaceGeometry(rgba, width, height, skinRgb);

  // 3. Sample hair crown color and eye iris tone.
  const hairColor = sampleHairColor(rgba, width, height, geom.topFrac, skinRgb, bgRgb);
  const { irisColor, irisSaturation, irisSampleCount } = sampleIrisColor(
    rgba,
    width,
    height,
    geom.topFrac,
    geom.bottomFrac,
    skinRgb,
  );

  // 4. Propose head archetype blend + subtle procedural face-shape hints.
  const headArchetypes = proposeHeadArchetypes(
    skinRgb,
    skinVariance,
    irisSaturation,
    geom.aspectRatio,
    geom.jawRatio,
    geom.cheekRatio,
  );

  const faceShapeHints: PhotoFaceShapeHints = {
    aspectRatio: roundTo(geom.aspectRatio, 3),
    jawRatio: roundTo(geom.jawRatio, 3),
    cheekRatio: roundTo(geom.cheekRatio, 3),
    jawWidth: Math.round(clamp((geom.jawRatio - 0.75) * 260, -60, 60)),
    cheekbones: Math.round(clamp((geom.cheekRatio - 1.14) * 220, -55, 55)),
    cheeks: Math.round(clamp((geom.aspectRatio - 0.74) * 180, -50, 50)),
    chinLength: Math.round(clamp((0.74 - geom.aspectRatio) * 160, -45, 45)),
    eyeWidth: Math.round(clamp((geom.cheekRatio - 1.14) * 90 - (geom.jawRatio - 0.75) * 50, -35, 35)),
  };

  const skinRatio = fallbackSkinSamples.length > 0 ? strictSkinSamples.length / fallbackSkinSamples.length : 0;
  const confidence = roundTo(
    clamp(
      (useStrict ? 0.35 : 0.12)
      + clamp(skinRatio, 0, 1) * 0.30
      + clamp(geom.coverage * 2.2, 0, 1) * 0.25
      + (irisSampleCount > 0 ? 0.10 : 0),
      0.1,
      0.99,
    ),
    2,
  );

  return {
    skinColor,
    hairColor,
    irisColor,
    headArchetypes,
    faceShapeHints,
    confidence,
  };
}

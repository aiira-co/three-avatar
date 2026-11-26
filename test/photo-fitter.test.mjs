import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUILTIN_HEAD_ARCHETYPE_CATALOG,
  analyzePortraitPixels,
} from '../dist/index.js';

/**
 * Generates a synthetic front-facing RGBA portrait buffer with controlled
 * background, hair crown, skin oval (aspect/jaw/cheek shape), and eyes.
 */
function synthesizePortrait({
  width = 64,
  height = 64,
  bg = [232, 236, 242],
  hair = [42, 26, 18],
  skin = [196, 146, 112],
  iris = [64, 128, 178],
  faceRx = 0.24,
  faceRy = 0.32,
  jawTaper = 0.78,
  cheekBoost = 1.0,
  skinNoise = 6,
} = {}) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const cx = width * 0.5;
  const cy = height * 0.50;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      let r = bg[0];
      let g = bg[1];
      let b = bg[2];

      const nx = (x - cx) / width;
      const ny = (y - cy) / height;

      // Hair crown cap above and around the upper head.
      const hairDx = nx / (faceRx * 1.15);
      const hairDy = (ny + faceRy * 0.58) / (faceRy * 0.72);
      if (hairDx * hairDx + hairDy * hairDy <= 1 && ny <= -faceRy * 0.10) {
        r = hair[0];
        g = hair[1];
        b = hair[2];
      }

      // Face oval with controllable cheek prominence and jaw taper.
      const vNorm = ny / faceRy; // -1 forehead top .. +1 chin bottom
      let localRx = faceRx;
      if (vNorm > -0.15 && vNorm < 0.25) {
        localRx *= cheekBoost;
      } else if (vNorm >= 0.25) {
        const t = Math.min(1, (vNorm - 0.25) / 0.75);
        localRx *= cheekBoost + (jawTaper - cheekBoost) * t;
      }
      const faceEq = (nx / Math.max(0.05, localRx)) ** 2 + vNorm ** 2;
      if (faceEq <= 1) {
        // Subtle deterministic grain when skinNoise > 0.
        const grain = skinNoise > 0 ? (((x * 17 + y * 31) % 11) - 5) * (skinNoise / 5) : 0;
        r = Math.max(0, Math.min(255, Math.round(skin[0] + grain)));
        g = Math.max(0, Math.min(255, Math.round(skin[1] + grain)));
        b = Math.max(0, Math.min(255, Math.round(skin[2] + grain)));
      }

      // Eyes (sclera + colored iris) at face eye line.
      const eyeY = cy - faceRy * height * 0.18;
      const eyeOffsetX = faceRx * width * 0.42;
      for (const sign of [-1, 1]) {
        const ex = cx + sign * eyeOffsetX;
        const edx = (x - ex) / (width * 0.055);
        const edy = (y - eyeY) / (height * 0.032);
        if (edx * edx + edy * edy <= 1) {
          r = 242;
          g = 242;
          b = 244;
          const irisDist = Math.hypot((x - ex) / (width * 0.026), (y - eyeY) / (height * 0.026));
          if (irisDist <= 1) {
            r = iris[0];
            g = iris[1];
            b = iris[2];
          }
        }
      }

      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = 255;
    }
  }
  return { rgba, width, height };
}

function hexToRgb(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/);
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

test('analyzePortraitPixels is deterministic and extracts accurate skin, hair, and iris colors', () => {
  const portrait = synthesizePortrait({
    skin: [168, 108, 72],
    hair: [188, 134, 62], // warm blonde
    iris: [52, 132, 186], // blue eyes
  });

  const first = analyzePortraitPixels(portrait.rgba, portrait.width, portrait.height);
  const second = analyzePortraitPixels(portrait.rgba, portrait.width, portrait.height);
  assert.deepEqual(first, second);

  const [sr, sg, sb] = hexToRgb(first.skinColor);
  assert.ok(Math.abs(sr - 168) <= 8, `skin R=${sr}`);
  assert.ok(Math.abs(sg - 108) <= 8, `skin G=${sg}`);
  assert.ok(Math.abs(sb - 72) <= 8, `skin B=${sb}`);

  const [hr, hg, hb] = hexToRgb(first.hairColor);
  assert.ok(Math.abs(hr - 188) <= 12, `hair R=${hr}`);
  assert.ok(Math.abs(hg - 134) <= 12, `hair G=${hg}`);
  assert.ok(Math.abs(hb - 62) <= 12, `hair B=${hb}`);

  const [ir, ig, ib] = hexToRgb(first.irisColor);
  assert.ok(ib > ir + 40, `expected blue-dominant iris, got ${first.irisColor}`);
  assert.ok(ig > ir + 20, `expected cool blue/cyan iris, got ${first.irisColor}`);

  assert.ok(first.confidence >= 0.5 && first.confidence <= 1);
  const validIds = new Set(BUILTIN_HEAD_ARCHETYPE_CATALOG.map((entry) => entry.id));
  const weightEntries = Object.entries(first.headArchetypes.weights);
  assert.ok(weightEntries.length >= 1 && weightEntries.length <= 2);
  for (const [id, weight] of weightEntries) {
    assert.ok(validIds.has(id), `unexpected archetype id ${id}`);
    assert.ok(weight > 0 && weight <= 1);
  }
});

test('analyzePortraitPixels differentiates portrait skin tones, facial proportions, and stylized manga portraits', () => {
  const deepPortrait = synthesizePortrait({
    skin: [92, 54, 36],
    hair: [24, 20, 18],
    iris: [54, 34, 24],
    faceRx: 0.27,
    faceRy: 0.31,
    jawTaper: 0.82,
  });
  const deepProposal = analyzePortraitPixels(deepPortrait.rgba, deepPortrait.width, deepPortrait.height);
  assert.ok((deepProposal.headArchetypes.weights.black ?? 0) > 0.25, `expected black weight, got ${JSON.stringify(deepProposal.headArchetypes)}`);

  const angularPortrait = synthesizePortrait({
    skin: [216, 174, 146],
    hair: [52, 36, 26],
    iris: [70, 118, 86],
    faceRx: 0.19,
    faceRy: 0.35,
    jawTaper: 0.94,
    cheekBoost: 0.95,
  });
  const angularProposal = analyzePortraitPixels(angularPortrait.rgba, angularPortrait.width, angularPortrait.height);
  assert.ok(angularProposal.faceShapeHints.aspectRatio < deepProposal.faceShapeHints.aspectRatio);
  assert.ok(angularProposal.faceShapeHints.jawWidth > 0);
  assert.ok((angularProposal.headArchetypes.weights.angular ?? 0) > 0.2, `expected angular weight, got ${JSON.stringify(angularProposal.headArchetypes)}`);

  const mangaPortrait = synthesizePortrait({
    skin: [244, 214, 198],
    hair: [78, 52, 138],
    iris: [30, 178, 245], // high saturation anime eye
    faceRx: 0.23,
    faceRy: 0.31,
    jawTaper: 0.56,
    cheekBoost: 1.05,
    skinNoise: 0, // flat cel-shaded skin
  });
  const mangaProposal = analyzePortraitPixels(mangaPortrait.rgba, mangaPortrait.width, mangaPortrait.height);
  assert.ok((mangaProposal.headArchetypes.weights.manga ?? 0) >= 0.4, `expected manga weight, got ${JSON.stringify(mangaProposal.headArchetypes)}`);
  assert.equal(mangaProposal.headArchetypes.detailStrength, 0.25);
});

test('analyzePortraitPixels validates buffer dimensions and rejects truncated buffers', () => {
  assert.throws(() => analyzePortraitPixels(new Uint8ClampedArray(64), 0, 16), RangeError);
  assert.throws(() => analyzePortraitPixels(new Uint8ClampedArray(64), 16, 16), RangeError);
});

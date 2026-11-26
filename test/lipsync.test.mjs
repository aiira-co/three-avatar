import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARKIT_CORE_EXPRESSION_CHANNELS,
  LipSyncController,
  OCULUS_VISEME_IDS,
  VISEME_ARKIT_MAP,
  classifyAudioSpectrumToViseme,
  textToVisemeCues,
} from '../dist/index.js';

const VALID_CHANNELS = new Set(ARKIT_CORE_EXPRESSION_CHANNELS);

test('VISEME_ARKIT_MAP covers all 15 Oculus visemes using only valid ARKit channels', () => {
  assert.equal(OCULUS_VISEME_IDS.length, 15);
  for (const viseme of OCULUS_VISEME_IDS) {
    const recipe = VISEME_ARKIT_MAP[viseme];
    assert.ok(recipe, `Missing recipe for viseme ${viseme}`);
    for (const [channel, weight] of Object.entries(recipe)) {
      assert.ok(VALID_CHANNELS.has(channel), `Invalid ARKit channel ${channel} in ${viseme}`);
      assert.ok(weight >= 0 && weight <= 1, `Out-of-range weight in ${viseme}.${channel}`);
    }
  }
});

test('textToVisemeCues converts text into ordered non-overlapping cues ending in closure', () => {
  const cues = textToVisemeCues('Hello, think about world!');
  assert.ok(cues.length > 5);
  assert.ok(cues.some((c) => c.viseme === 'TH'));
  assert.ok(cues.some((c) => c.viseme === 'oh' || c.viseme === 'ou'));
  assert.equal(cues[cues.length - 1].viseme, 'sil');

  for (let i = 1; i < cues.length; i++) {
    assert.ok(cues[i].startTime >= cues[i - 1].startTime + cues[i - 1].duration - 1e-3);
  }
  assert.deepEqual(textToVisemeCues('   '), []);
});

test('classifyAudioSpectrumToViseme distinguishes silence, sibilants, wide vowels, and rounded vowels', () => {
  assert.equal(classifyAudioSpectrumToViseme({ low: 0.1, mid: 0.1, high: 0.1, rms: 0.01 }).viseme, 'sil');
  assert.equal(classifyAudioSpectrumToViseme({ low: 0.05, mid: 0.12, high: 0.65, rms: 0.3 }).viseme, 'SS');
  assert.equal(classifyAudioSpectrumToViseme({ low: 0.12, mid: 0.68, high: 0.08, rms: 0.45 }).viseme, 'aa');
  const rounded = classifyAudioSpectrumToViseme({ low: 0.72, mid: 0.25, high: 0.04, rms: 0.42 });
  assert.ok(rounded.viseme === 'oh' || rounded.viseme === 'ou');
});

test('LipSyncController advances text cues with co-articulation smoothing and settles to closed mouth', () => {
  const ctrl = new LipSyncController();
  ctrl.playText('mama papa oooh');
  assert.equal(ctrl.isPlaying, true);
  assert.ok(ctrl.duration > 0.3);

  const mid = ctrl.step(0.08);
  assert.equal(mid.active, true);
  assert.ok(Object.keys(mid.channels).length > 0);

  // Advance well past end so release exponential settles cleanly to zero
  for (let i = 0; i < 40; i++) {
    ctrl.step(0.05);
  }
  const end = ctrl.step(0.05);
  assert.equal(ctrl.isPlaying, false);
  assert.equal(end.active, false);
  assert.deepEqual(end.channels, {});
});

test('LipSyncController tracks live audio bands and stops cleanly', () => {
  const ctrl = new LipSyncController();
  ctrl.setAudioBands({ low: 0.15, mid: 0.7, high: 0.1, rms: 0.5 });
  assert.equal(ctrl.isPlaying, true);
  const frame = ctrl.step(0.016);
  assert.ok((frame.channels.jawOpen ?? 0) > 0.1);

  ctrl.stop();
  for (let i = 0; i < 30; i++) ctrl.step(0.05);
  assert.equal(ctrl.isPlaying, false);
  assert.deepEqual(ctrl.step(0.05).channels, {});

  ctrl.playText('ah');
  ctrl.step(0.02);
  ctrl.stop(true);
  assert.deepEqual(ctrl.step(0).channels, {});
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
} from 'three';
import {
  AVATAR_MESSAGE_ENVELOPE_PREFIX,
  AVATAR_MESSAGE_MAX_EMOTE_FRAMES,
  AVATAR_MESSAGE_SCHEMA,
  AVATAR_MESSAGE_VERSION,
  AvatarAssetRegistry,
  AvatarCallStreamController,
  AvatarMessagePayloadError,
  AvatarRuntime,
  MIXAMO_HUMANOID_RIG_V1,
  computeAudioBandsFromFrequencyData,
  createAvatarMocapEmote,
  createAvatarMoodBubble,
  createAvatarReactionCard,
  createAvatarVoiceClip,
  decodeAvatarMessageEnvelope,
  encodeAvatarMessageEnvelope,
  estimatePayloadByteLength,
  installProceduralExpressionTargets,
  parseAvatarMessagePayload,
  serializeAvatarMessagePayload,
  swapPeerConnectionVideoTrack,
  textToVisemeCues,
  validateAvatarMessagePayload,
} from '../dist/index.js';
import {
  AvatarCallStreamController as SubpathCallController,
  parseAvatarMessagePayload as subpathParseAvatarMessagePayload,
} from '../dist/connect/index.js';

function createTestPoseLandmarks(raisedLeftArm = false) {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.95 }));
  landmarks[0] = { x: 0.5, y: 0.2, z: -0.08, visibility: 0.98 };
  landmarks[7] = { x: 0.45, y: 0.19, z: 0, visibility: 0.95 };
  landmarks[8] = { x: 0.55, y: 0.19, z: 0, visibility: 0.95 };
  landmarks[11] = { x: 0.42, y: 0.32, z: 0, visibility: 0.98 };
  landmarks[12] = { x: 0.58, y: 0.32, z: 0, visibility: 0.98 };
  landmarks[13] = { x: 0.34, y: raisedLeftArm ? 0.18 : 0.44, z: 0, visibility: 0.95 };
  landmarks[14] = { x: 0.66, y: 0.44, z: 0, visibility: 0.95 };
  landmarks[15] = { x: 0.28, y: raisedLeftArm ? 0.08 : 0.55, z: -0.04, visibility: 0.95 };
  landmarks[16] = { x: 0.72, y: 0.55, z: -0.04, visibility: 0.95 };
  landmarks[23] = { x: 0.44, y: 0.58, z: 0, visibility: 0.95 };
  landmarks[24] = { x: 0.56, y: 0.58, z: 0, visibility: 0.95 };
  return landmarks;
}

async function createMockAvatarInstance() {
  const registry = new AvatarAssetRegistry();
  const root = new Group();
  const bones = [];
  const hips = new Bone();
  hips.name = 'mixamorigHips';
  bones.push(hips);

  for (const def of MIXAMO_HUMANOID_RIG_V1.bones) {
    if (def.id === 'hips') continue;
    const bone = new Bone();
    bone.name = def.aliases[0] ?? def.id;
    hips.add(bone);
    bones.push(bone);
  }
  root.add(hips);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0], 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.setIndex([0, 1, 2]);
  geometry.morphAttributes.position = [
    new Float32BufferAttribute([0, -0.02, 0, 0, -0.02, 0, 0, -0.02, 0], 3),
    new Float32BufferAttribute([0.01, 0.01, 0, 0.01, 0.01, 0, 0.01, 0.01, 0], 3),
    new Float32BufferAttribute([0, -0.01, 0, 0, -0.01, 0, 0, -0.01, 0], 3),
  ];

  const bodyMesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
  bodyMesh.name = 'BodyMesh';
  bodyMesh.morphTargetDictionary = { jawOpen: 0, mouthSmileLeft: 1, eyeBlinkRight: 2 };
  bodyMesh.morphTargetInfluences = [0, 0, 0];
  bodyMesh.add(hips);
  bodyMesh.bind(new Skeleton(bones));
  root.add(bodyMesh);

  registry.install({
    id: 'test:connect-pack',
    version: '1.0.0',
    rigs: [MIXAMO_HUMANOID_RIG_V1],
    assets: [{ id: 'test:body', version: '1.0.0', uri: 'memory://body.glb', kind: 'body' }],
    families: [
      {
        id: 'test:humanoid',
        version: '1.0.0',
        rig: { id: MIXAMO_HUMANOID_RIG_V1.id, version: MIXAMO_HUMANOID_RIG_V1.version },
        body: {
          asset: { id: 'test:body', version: '1.0.0' },
          meshNode: 'BodyMesh',
          regions: [{ id: 'head', indexOffset: 0, indexCount: 3 }],
        },
        morphBindings: [
          { channel: 'jawOpen', target: 'jawOpen', meshNode: 'BodyMesh' },
          { channel: 'mouthSmileLeft', target: 'mouthSmileLeft', meshNode: 'BodyMesh' },
          { channel: 'eyeBlinkRight', target: 'eyeBlinkRight', meshNode: 'BodyMesh' },
        ],
      },
    ],
  });

  const runtime = new AvatarRuntime(registry, {
    async load() {
      return { root };
    },
  });

  return runtime.create({ family: { id: 'test:humanoid', version: '1.0.0' } });
}

function createMockTrack(kind = 'video', id = 'track-1') {
  return {
    kind,
    id,
    readyState: 'live',
    enabled: true,
    stopped: false,
    stop() {
      this.readyState = 'ended';
      this.stopped = true;
    },
  };
}

function createMockCanvas() {
  const createdTracks = [];
  const requestedFps = [];
  return {
    createdTracks,
    requestedFps,
    captureStream(fps) {
      requestedFps.push(fps);
      const track = createMockTrack('video', `canvas-track-${createdTracks.length + 1}`);
      createdTracks.push(track);
      return {
        getVideoTracks: () => [track],
        getTracks: () => [track],
      };
    },
  };
}

function createMockPeerConnection(initialVideoTrack) {
  const replacedHistory = [];
  const videoSender = {
    track: initialVideoTrack,
    async replaceTrack(nextTrack) {
      replacedHistory.push(nextTrack);
      this.track = nextTrack;
    },
  };
  const audioSender = {
    track: createMockTrack('audio', 'mic-1'),
    async replaceTrack() {},
  };
  return {
    replacedHistory,
    videoSender,
    getSenders: () => [audioSender, videoSender],
  };
}

test('connect subpath export matches root barrel exports', () => {
  assert.equal(AvatarCallStreamController, SubpathCallController);
  assert.equal(parseAvatarMessagePayload, subpathParseAvatarMessagePayload);
});

test('MessengerAvatarPayload builds, validates, serializes, and envelopes all 4 message kinds', () => {
  const card = createAvatarReactionCard({
    mood: 'love',
    intensity: 0.9,
    caption: '  Loved   that!  ',
    snapshotUrl: 'https://cdn.aiira.co/avatars/snap.webp',
    sender: { personId: 42, displayName: 'Ada' },
  });
  assert.equal(card.schema, AVATAR_MESSAGE_SCHEMA);
  assert.equal(card.version, AVATAR_MESSAGE_VERSION);
  assert.equal(card.caption, 'Loved that!');
  assert.equal(card.accentColor, '#ec4899');
  assert.equal(card.bubbleSymbol, 'hearts');

  const envelope = encodeAvatarMessageEnvelope(card);
  assert.ok(envelope.startsWith(AVATAR_MESSAGE_ENVELOPE_PREFIX));
  assert.deepEqual(decodeAvatarMessageEnvelope(envelope), card);
  assert.deepEqual(decodeAvatarMessageEnvelope(serializeAvatarMessagePayload(card)), card);
  assert.equal(decodeAvatarMessageEnvelope('Plain chat message without payload'), undefined);

  const bubble = createAvatarMoodBubble({
    mood: 'happy',
    intensity: 0.85,
    label: 'On fire!',
    durationSeconds: 4,
    bubble: { style: 'anime', placement: 'temple', showLabel: true },
  });
  assert.equal(bubble.kind, 'mood_bubble');
  assert.equal(bubble.bubble.style, 'anime');
  assert.equal(bubble.bubble.placement, 'temple');
  assert.deepEqual(parseAvatarMessagePayload(serializeAvatarMessagePayload(bubble)), bubble);

  const cues = textToVisemeCues('Hello Interverse!');
  const voice = createAvatarVoiceClip({
    durationMs: 2400,
    messageFileId: 901,
    waveform: [0.1, 0.65, 0.9, 0.4, 0.05],
    visemeCues: cues,
    transcript: 'Hello Interverse!',
    mood: 'smile',
  });
  assert.equal(voice.kind, 'voice_clip');
  assert.equal(voice.messageFileId, 901);
  assert.ok((voice.visemeCues?.length ?? 0) > 4);
  assert.deepEqual(parseAvatarMessagePayload(serializeAvatarMessagePayload(voice)), voice);

  const emote = createAvatarMocapEmote({
    clip: {
      version: 1,
      id: 'wave-take-1',
      name: 'Friendly Wave',
      createdAt: 1000,
      updatedAt: 1000,
      duration: 0.5,
      fps: 30,
      frames: [
        { time: 0, boneRotations: { spine: [0, 0, 0, 1] }, faceChannels: { mouthSmileLeft: 0.7 } },
        { time: 0.5, boneRotations: { spine: [0, 0.15, 0, 0.9887] }, faceChannels: { mouthSmileLeft: 0.8 } },
      ],
    },
    loop: true,
    caption: 'Hey there!',
    mood: 'smile',
  });
  assert.equal(emote.kind, 'mocap_emote');
  assert.equal(emote.loop, true);
  assert.equal(emote.clip.frames.length, 2);
  assert.deepEqual(parseAvatarMessagePayload(serializeAvatarMessagePayload(emote)), emote);
});

test('MessengerAvatarPayload rejects invalid schemas, unsafe URLs, oversized frames, and byte-limit overflows', () => {
  assert.equal(validateAvatarMessagePayload({ schema: 'wrong', version: 1, kind: 'reaction_card' }).ok, false);
  assert.equal(validateAvatarMessagePayload('{not-json').ok, false);

  const badUrl = validateAvatarMessagePayload({
    schema: AVATAR_MESSAGE_SCHEMA,
    version: AVATAR_MESSAGE_VERSION,
    kind: 'reaction_card',
    mood: 'happy',
    intensity: 1,
    snapshotUrl: 'javascript:alert(1)',
  });
  assert.equal(badUrl.ok, false);
  assert.equal(badUrl.code, 'UNSAFE_URL');

  const badVoice = validateAvatarMessagePayload({
    schema: AVATAR_MESSAGE_SCHEMA,
    version: AVATAR_MESSAGE_VERSION,
    kind: 'voice_clip',
    durationMs: 1200,
  });
  assert.equal(badVoice.ok, false);
  assert.equal(badVoice.code, 'INVALID_FIELD');

  const tooManyFrames = Array.from({ length: AVATAR_MESSAGE_MAX_EMOTE_FRAMES + 5 }, (_, idx) => ({
    time: Number((idx * 0.02).toFixed(4)),
    boneRotations: { spine: [0, 0, 0, 1] },
  }));
  const badEmote = validateAvatarMessagePayload({
    schema: AVATAR_MESSAGE_SCHEMA,
    version: AVATAR_MESSAGE_VERSION,
    kind: 'mocap_emote',
    loop: false,
    clip: {
      version: 1,
      id: 'too-long',
      name: 'Too Long',
      createdAt: 1,
      updatedAt: 1,
      duration: 9.1,
      fps: 50,
      frames: tooManyFrames,
    },
  });
  assert.equal(badEmote.ok, false);
  assert.equal(badEmote.code, 'INVALID_CLIP');

  const card = createAvatarReactionCard({ mood: 'smile', caption: 'A'.repeat(260) });
  assert.ok(estimatePayloadByteLength(card) > 280);
  assert.throws(
    () => serializeAvatarMessagePayload(card, { maxBytes: 256 }),
    (err) => err instanceof AvatarMessagePayloadError && err.code === 'PAYLOAD_TOO_LARGE',
  );
});

test('computeAudioBandsFromFrequencyData maps speech frequency bins into low/mid/high/rms bands', () => {
  const fftSize = 512;
  const sampleRate = 48_000;
  const bins = new Uint8Array(fftSize / 2);

  // Silence
  assert.deepEqual(computeAudioBandsFromFrequencyData(bins, sampleRate, fftSize), {
    low: 0,
    mid: 0,
    high: 0,
    rms: 0,
  });

  // Strong mid-formant energy (~800-1500 Hz, bins ~9..16 at 93.75 Hz/bin)
  for (let i = 9; i <= 16; i++) bins[i] = 220;
  const vowelBands = computeAudioBandsFromFrequencyData(bins, sampleRate, fftSize);
  assert.ok(vowelBands.mid > 0.35);
  assert.ok(vowelBands.mid > vowelBands.low);
  assert.ok(vowelBands.mid > vowelBands.high);
  assert.ok(vowelBands.rms > 0.1);
});

test('AvatarCallStreamController drives pose, face tracking, live mic lip-sync, reactions, and mood bubbles', async () => {
  const avatar = await createMockAvatarInstance();
  let renderCalls = 0;

  const controller = new AvatarCallStreamController({
    avatar,
    renderFrame: () => {
      renderCalls += 1;
    },
  });

  const restPose = createTestPoseLandmarks(false);
  const baseline = controller.calibratePose(restPose);
  assert.ok(baseline && baseline.shoulderSpan > 0.05);

  const raisedPose = createTestPoseLandmarks(true);
  const poseRes = controller.setPoseLandmarks(raisedPose);
  assert.ok(poseRes.confidence > 0.8);
  assert.ok(poseRes.boneCount >= 4);

  controller.setMediaPipeFaceBlendshapes([
    { categoryName: 'eyeBlink_L', score: 0.85 }, // mirrored -> eyeBlinkRight
    { categoryName: 'jawOpen', score: 0.5 },
  ]);
  controller.setAudioBands({ low: 0.12, mid: 0.72, high: 0.08, rms: 0.55 });
  controller.triggerReaction('laugh', { intensity: 1, bubbleDurationSeconds: 1.5 });

  const frame1 = controller.step(0.05);
  assert.equal(frame1.enabled, true);
  assert.equal(frame1.rendered, true);
  assert.equal(renderCalls, 1);
  assert.ok(frame1.appliedBoneCount >= 4);
  assert.equal(frame1.expression.activeReaction, 'laugh');
  assert.equal(frame1.lipSync.active, true);
  assert.equal(frame1.lipSync.activeViseme, 'aa');
  assert.equal(frame1.activeMoodBubble?.moodId, 'laugh');
  assert.ok(avatar.morphs.getEffectiveValue('jawOpen') > 0.2);
  assert.ok(avatar.morphs.getEffectiveValue('eyeBlinkRight') > 0.5);

  const upperLeftArm = avatar.rig.getBone('arm.upper.left');
  assert.ok(upperLeftArm);
  assert.ok(upperLeftArm.quaternion.angleTo(new Quaternion()) > 0.05);

  // Advance past mood bubble expiry (1.5s)
  for (let i = 0; i < 20; i++) {
    controller.step(0.1);
  }
  assert.equal(controller.getActiveMoodBubble(), undefined);

  controller.dispose();
  assert.equal(controller.isDisposed, true);
  assert.ok(upperLeftArm.quaternion.angleTo(new Quaternion()) < 1e-5);
  assert.equal(avatar.morphs.getEffectiveValue('jawOpen'), 0);
  assert.equal(avatar.morphs.getEffectiveValue('eyeBlinkRight'), 0);
});

test('AvatarCallStreamController captures canvas video track and toggles WebRTC replaceTrack cleanly', async () => {
  const canvas = createMockCanvas();
  const cameraTrack = createMockTrack('video', 'camera-1');
  const pc = createMockPeerConnection(cameraTrack);

  // Also verify targetMeshes fallback without AvatarInstance
  const headGeo = new BufferGeometry();
  headGeo.setAttribute('position', new Float32BufferAttribute([0, 0.85, 0.068, 0.017, 0.85, 0.062, 0, 0.825, 0.06], 3));
  const headMesh = new Mesh(headGeo, new MeshBasicMaterial());
  installProceduralExpressionTargets(headMesh, {
    eyeLeft: [0.03, 0.9, 0.06],
    eyeRight: [-0.03, 0.9, 0.06],
    eyeRadius: 0.014,
    browInner: [0.016, 0.925, 0.068],
    browOuter: [0.044, 0.925, 0.056],
    noseWing: [0.012, 0.87, 0.072],
    cheek: [0.035, 0.865, 0.062],
    mouthCenter: [0, 0.85, 0.068],
    mouthCorner: [0.017, 0.85, 0.062],
    chin: [0, 0.825, 0.06],
    neckSeamY: 0.785,
    blendHeight: 0.025,
  });

  const modeEvents = [];
  const controller = new AvatarCallStreamController({
    canvas,
    targetMeshes: [headMesh],
    enabled: false,
    onModeChange: (enabled) => modeEvents.push(enabled),
  });

  controller.bindPeerConnection(pc);

  // Capturing track clamps FPS and reuses active track for same FPS
  const trackA = controller.captureVideoTrack(120);
  assert.equal(canvas.requestedFps[0], 60);
  const trackB = controller.captureVideoTrack(60);
  assert.equal(trackA, trackB);

  // Toggle Avatar Mode ON -> swaps cameraTrack to canvas avatar track
  const nowOn = await controller.toggleAvatarMode({ fps: 30 });
  assert.equal(nowOn, true);
  assert.equal(pc.videoSender.track?.id, 'canvas-track-2');
  assert.equal(canvas.requestedFps[1], 30);

  // Speech lip-sync drives procedural target mesh when enabled
  controller.playSpeechText('aaaah');
  const activeStep = controller.step(0.04);
  assert.equal(activeStep.enabled, true);
  assert.equal(activeStep.lipSync.active, true);

  // Toggle Avatar Mode OFF -> restores original camera track & clears morphs
  const nowOff = await controller.toggleAvatarMode();
  assert.equal(nowOff, false);
  assert.equal(pc.videoSender.track, cameraTrack);
  const disabledStep = controller.step(0.04);
  assert.equal(disabledStep.enabled, false);
  assert.equal(disabledStep.rendered, false);
  assert.deepEqual(modeEvents, [true, false]);

  // Direct helper works independently too
  assert.equal(await swapPeerConnectionVideoTrack(pc, trackA), true);
  assert.equal(pc.videoSender.track, trackA);

  // Dispose restores camera track and stops captured canvas tracks idempotently
  controller.dispose();
  assert.equal(canvas.createdTracks.every((t) => t.stopped), true);
  controller.dispose(); // idempotent
  assert.throws(() => controller.step(0.016), /disposed/i);
});

# `@interverse/three-avatar` — Product & Technical Roadmap

> Current baseline: **v1** — canonical Mixamo humanoid families, body-region masking, skinned wearable rebinding, rigid bone sockets, additive `AvatarMorphController` & `AvatarFaceController`, procedural eyes/brows/lashes/makeup, procedural body/face shape sculpting, garment fit rings & conform, cloth/hair spring physics, footwear heel lift, and 1-/2-channel UV dye shaders (WebGL + WebGPU).

---

## Platform Architecture & Product Split

To keep **Connect (`nx_galaxy/apps/media/ori`)** lean and mobile-friendly while giving creators a full workstation inside **Interverse Engine**, Avatar Studio separates shared customization from Engine-only simulation and authoring:

| Capability | Engine Avatar Studio (`interverse-engine`) | Connect Avatar Studio (`nx_galaxy/apps/media/ori`) |
| :--- | :--- | :--- |
| **Three.js version** | `^0.187.0` | **Aligned to `^0.187.0`** |
| **Characters per user** | Multi-character library | **Single character per AiiraID** (no multi-character profiles) |
| **Saving** | Local device / project characters + outfit presets | **Save Look (AiiraID cloud) + Outfit Presets only** |
| **Full Customization** | Body, skin, face sculpt, head archetypes, mood selector, eyes/lashes/brows/makeup/beard, layered outfits, fit rings, dyes, accessories | **Same full customization + Profile Mood** (excluding creator-only Craft/Import tools) |
| **Animations & Playtest** | **Yes** — Expanded Motion Bar + **Kinematic Third-Person Playtest** (`@interverse/three-avatar/playtest`) | **No** — calm customization idle + blink + orbit/view presets only |
| **Animation Bone Overrides** | **Yes** — Tier-1 Auto Clearance + Tier-2 Manual global & per-clip bone offsets (`@interverse/three-avatar/pose`) | **No UI** (Tier-1 Auto Clearance runs automatically when avatars spawn in games) |
| **Exports / Imports** | Send to Engine, Game-Ready Bundle, JSON Export/Import | **None** |
| **Studio Credits Badge** | Shown | **Hidden / Removed** |

---

## v1.5 — Shared Studio Runtime, Three.js Alignment & Connect / AiiraID-to-Games

- **Three.js Alignment**: Upgrade Connect (`nx_galaxy`) from `three@^0.184.0` to `three@^0.187.0` so `@interverse/three-avatar` and Studio runtime shaders/node materials run identically across Engine, Connect, and `runtime-player`.
- **Shared Pure-TS Runtime**: Extract pure Three.js procedural Studio subsystems into `@interverse/three-avatar` subpath exports (`./layering`, `./pose`, `./head-archetypes`, `./expressions`, `./playtest` Engine-only, and Studio runtime helpers), keeping Connect free of Engine playtest, animation, export/import, and credits code.
- **CDN Asset Pack (`nx_cdn`)**: Publish the Studio humanoid catalog, bodies, wearables, dye masks, and portraits to an immutable versioned CDN prefix consumed by Engine, Connect, and published Interverse games.
- **Connect (`ori`) Integration**:
  - Single-character AiiraID customization at `/games/avatar` with **Save Look** + **Outfit Presets** + **Profile Mood** (`smile`, `bold`, `happy`, `shy`, etc.) only (no character profiles, no playtest/motions, no JSON/GLB export/import, no studio credits badge).
  - Live 3D try-on in `/games/avatar/shop` with server-verified airPay/Paystack ownership checks.
  - Responsive Ori Profile showcase (`libs/media/profile/src/lib/home`) displaying the user's live mood on desktop and mobile with portrait-first loading and a **Customize Avatar** CTA.
  - **Chat Mood Reactions** (`@interverse/three-avatar/expressions`): Lightweight `{ mood, intensity }` reaction payloads (`smile`, `laugh`, `angry`, `frustrated`, `surprised`, `sad`, `cry`, `bold`, `love`, etc.) driving animated facial envelopes + eye/tilt/overlay cues in Connect messaging.
- **AiiraID-to-Games Pipeline**: Persist `AvatarStateV1`, outfit presets, and WebP portrait on `social.user_avatar`, validate item entitlements in `AvatarController.php`, and hydrate local + multiplayer peer Connect avatars automatically inside `avatar_enabled` Interverse games (`platform-avatar.ts` / `platform-session.ts`).

---

## v2.0 — Layered Cloth/Dressing, Pose Overrides & Engine Kinematic Playtest

### 1. Layered Cloth & Dressing (`@interverse/three-avatar/layering`)
- **Full Layer Stack**: Inside-out equipment hierarchy across `upper.under`, `upper.base`, `upper.outer`, `upper.armor`, `lower.under`, `lower.base`, `lower.outer`, `outfit`, `feet.socks`, `feet`, `hands`, `waist`, `neck`, `back`, `head.outer`, `face.*`, and `ear.*`. Full `outfit` pieces coexist with outer jackets, belts, scarves, gloves, and boots.
- **Generalized Inter-Layer Coverage Discard (`avatarCovered`)**: Extend per-vertex ray/normal occlusion discard from `AvatarBody` to inner opaque skinned garments under higher-rank opaque garments—hiding covered backs/sleeves while keeping open-front collars, lapels, and cuffs visible.
- **Automatic Inter-Layer Separation Solver (`solveGarmentLayers`)**: Uses bind-space `SpatialMeshIndex` checks to compress inner layers (`layer.compress`, clamped above skin clearance) and Laplacian-smooth inflate outer layers (`layer.clear`) so overlapping garments never z-fight or pierce.
- **Generalized Tuck & Cuff Rules**: User-toggleable + auto-default interactions (`tuckTop: 'auto' | 'tucked' | 'untucked'`, `tuckCuffs: 'auto' | 'tucked' | 'over'`) for tops into waistbands and trousers/cuffs into boot shafts, plus spring cloth physics enabled on outer layers (`upper.outer`, `lower.outer`, `waist`).

### 2. Animation Bone Override / Posture Clearance (`@interverse/three-avatar/pose`)
- **Pre-Multiplied Parent-Frame Offsets (`PoseOffsetController`)**: Applies Euler bone offsets cleanly before IK via `bone.quaternion.premultiply(offsetQuat)` with strict save/restore before each `AnimationMixer.update(dt)`, keeping arm abduction consistently outward across full walk/run arm-swing arcs without twisting or drift.
- **Tier-1 Auto Clearance (Engine & Games)**: Automatically derives subtle shoulder/arm/leg abduction clearance from `bodyShape` proportions and equipped `upper.outer` bulk so fuller builds and heavy coats stop clipping during locomotion without user tweaking.
- **Tier-2 Manual Overrides (Engine Studio Only)**: Global posture controls (`Arm clearance`, `Forearm flare`, `Shoulder spread`, `Stance width`, `Spine posture`) + per-clip overrides (e.g., fixing `fold_arms` over bulky outerwear), strictly anatomically clamped (`±25°` limbs, `±15°` shoulders, `±10°` spine/head, `0°` hips/root) so multiplayer hitboxes stay fair.

### 3. Engine-Only Motion Bar & Kinematic Third-Person Playtest (`@interverse/three-avatar/playtest`)
- **Expanded Studio Motion Bar**: Exposes `idle`, `walk`, `run`, `sprint`, `jump`, `crouch`, and emotes directly inside Engine Avatar Studio.
- **Opt-In Kinematic Playtest Mode (Engine-Only)**: Lightweight pure-Three.js third-person controller (`AvatarPlaytestController` + `ThirdPersonFollowCamera`, zero WASM physics) with smooth `idle ↔ walk ↔ run ↔ sprint`, `crouch`, `jump → fall → land`, yaw turning, and spring follow camera to stress-test layered cloth, hair springs, and pose overrides in real movement.

---

## v2.5 — Blender Head-Archetype Blendshapes, Expressions, Lip-Sync & Engine Webcam Mocap

### 1. Same-Topology Head Archetype Blending (`@interverse/three-avatar/head-archetypes`) — *(Wired in Engine Studio `Face → Head`)*
- **Blender 5.1 Sculpted Head Archetypes**: Same-topology head shapes matched to approved orthographic Front & Side turnaround references — **Black / African**, **East Asian**, **Chinese**, **Manga / Anime 3D**, **South Asian**, and **Angular / Chiseled** — authored with strict `seam.neck` zero-displacement locking (`computeNeckLockMask`) so every archetype attaches cleanly to `AvatarBody` with zero neck cracks.
- **Global + Regional Blend Mixing**: Blend multiple head archetypes globally (including MetaHuman-style 3-way triangle mixing from Basis) or independently across 7 facial zones (`cranium`, `brows_eyes`, `nose`, `cheeks`, `mouth`, `jaw_chin`, `ears`) and refine further with procedural face sliders.
- **Landmark & Socket Auto-Tracking (`interpolateHeadLandmarks`)**: Per-archetype landmark deltas interpolate eye centers, lid curves, nose bridge, mouth corners, jaw angle, cheeks, and ears so procedural eyes, brows, lashes, hair caps, glasses, masks, and earrings track the sculpted skull automatically.
- **Micro-Normal / Skin-Detail Blending**: Blend per-archetype tangent-space detail normal maps by the same archetype weights.

### 2. Facial Expressions, Moods & Real-Time Lip-Sync (`@interverse/three-avatar/expressions`) — *(Wired in Engine Studio `Face → Mood`)*
- **ARKit-Compatible Emotion & Mood Standard**: `ExpressionController` + `BUILTIN_EXPRESSION_PRESETS` (14 moods including `smile`, `happy`, `laugh`, `angry`, `frustrated`, `surprised`, `sad`, `cry`, `bold`, `skeptical`, `shy`, `focused`, `love`) with `installProceduralExpressionTargets` fallback that yields automatically to Blender-sculpted ARKit shape keys (see [EXPRESSIONS.md](./EXPRESSIONS.md)).
- **Audio & TTS Lip-Sync Adapter** (feeds `face.viseme` layer): Real-time microphone / audio buffer / TTS phoneme timeline → Oculus/ARKit viseme weights with co-articulation smoothing and automatic mouth release via `sampleVisemeCues()`.
- **Expression Safety on Morphed Heads**: Compute eyelid blink closure and jaw-open arc relative to interpolated head-archetype landmarks.

### 3. In-Browser Webcam Motion & Facial Animation Recording (Engine Studio Only)
- **Tracking Engine (`@mediapipe/tasks-vision` primary, TF.js optional fallback)**: Client-side WASM `FaceLandmarker` (52 ARKit blendshapes + head pose) + `PoseLandmarker` (33 3D world landmarks → Mixamo bone quaternions) + optional `HandLandmarker`.
- **One-Euro Filter, Countdown Calibration & Portable Clip Export**: Records timestamped quaternion + morph tracks (`30 fps`, decimated) into reusable `THREE.AnimationClip` / `.glb` clips playable in Engine Studio or games.

---

## v3.0 — Game-Ready Exports, Material Finishes & Creator Asset Pipeline

### 1. Game-Ready Exports & Runtime Baker (Engine Studio Only)
- **Single-Draw-Call Avatar Baker**: Bake active morph targets, head archetype weights, layering compress/clear deltas, and UV dye colors into static buffers; permanently strip hidden under-cloth body and inner-garment triangles; atlas ORM/albedo textures; generate **`LOD0 / LOD1 / LOD2`** meshes for rendering 50–200 avatars at 60 FPS in multiplayer worlds.
- **Multi-Format Export**: One-click **GLB**, **VRM 1.0**, **USDZ**, plus automated portrait cards and turntable video export.

### 2. Material Finishes & Graphic Decals
- **Fabric Finish & Pattern Swatches**: Roughness/sheen material presets (matte cotton, denim, leather, satin, metallic) plus tileable patterns and chest/back graphic decals.

### 3. Creator Asset-Import Pipeline (CLI + Engine Studio Wizard)
- Package Blender fitting and dye-mask scripts behind a turnkey CLI (`npx @interverse/avatar-kit fit-outfit ...`) and an in-Engine-Studio Creator Import Wizard so creators can author and publish custom outfits directly into Connect's Avatar Shop.

# Facial Expressions, Social Moods & Chat/Game Reactions (`@interverse/three-avatar/expressions`)

The expression system powers **persistent social moods** on Connect profiles, **animated mood reactions** inside Connect chats, and **real-time character emotions** inside Interverse games—using one lightweight, deterministic runtime controller.

---

## 1. Built-In Emotion & Mood Catalog (14 Presets)

All 14 presets live in `BUILTIN_EXPRESSION_PRESETS` and map cleanly onto canonical ARKit-compatible channels plus secondary eye, head-tilt, and stylized overlay cues:

| Mood ID | Category | Facial Mechanics | Secondary Cues | Overlay Cues |
| :--- | :--- | :--- | :--- | :--- |
| `neutral` | Neutral | Resting neutral pose | Baseline blink & gaze | — |
| `smile` | Positive | Warm symmetric smile, soft cheek & eye squint | Slight head lift (`-2°`), subtle tilt (`2°`) | — |
| `happy` | Positive | Broad joyful smile, gentle brow lift, slight jaw drop | Pupil dilation (`1.08×`) | `sparkle` |
| `laugh` | Positive | Full open-mouth laugh, strong cheek/eye squint | Head tilt back (`-6°`), faster blink (`1.3×`) | `sparkle` |
| `angry` | Intense | Sharp inner/outer brow drop, nose sneer, mouth frown & press | Chin-down forward glare (`+6°`), narrower pupils (`0.88×`) | `anger_vein` |
| `frustrated` | Intense | Pinched brow (`browDown` + `browInnerUp`), squint, pressed mouth | Slight look-away tilt (`[3, -5, -4]`) | `sweat_drop` |
| `surprised` | Playful | Raised inner/outer brows, wide eyes, funnelled `jawOpen` | Pupil constriction (`0.78×`), slow blink (`0.5×`) | — |
| `sad` | Tender | Inner brow lift, downturned mouth corners, lower lip shrug | Downward gaze, drooping tilt (`[7, 0, -4]`) | — |
| `cry` | Tender | High `browInnerUp`, tight `eyeSquint`, quivering `mouthFrown` + `jawOpen` | Downward gaze (`0.14`), wet-blink rate (`1.5×`) | `tears` |
| `bold` | Playful | Asymmetric confident smirk (`mouthSmileRight > Left`), arch & squint | Chin-up turn (`[-6, -7, 4]`) | `sparkle` |
| `skeptical` | Playful | One raised outer brow, contralateral brow drop + squint | Sidelong gaze (`+0.14`), head cock | — |
| `shy` | Tender | Gentle pressed smile, soft inner brow lift | Averted downward gaze (`[-0.14, 0.08]`), faster blink | `blush` |
| `focused` | Intense | Controlled brow knit, mild squint, firm mouth press | Steady gaze, low blink (`0.6×`) | — |
| `love` | Positive | Warm smile, lifted cheeks, bright wide eyes | Heart iris symbol (`eyeSymbol: 'heart'`), dilated pupils (`1.18×`) | `blush`, `heart_eyes` |

---

## 2. Three Integration Surfaces

### A. Connect Social Profile Moods (Persistent)
- Users pick a resting mood (e.g. `smile`, `bold`, `shy`, `focused`) in Connect Avatar Studio or from a quick mood pill on their Ori Profile.
- Stored non-destructively in `AvatarStateV1.metadata.mood` (`{ mood: string, intensity?: number }`) via `writeMoodState` / `readMoodState`—never polluting `AvatarStateV1.body.morphs`.
- Connect's `galaxy-avatar-scene` instantiates `ExpressionController`, calls `controller.setMood(mood, intensity)`, and updates `controller.update(dt)` alongside blink & idle breathing.

### B. Connect Chat Mood Reactions (Ephemeral, Zero-Media Cost)
- Instead of sending heavy rendered videos/GIFs, a chat reaction sends a tiny JSON payload:
  ```json
  { "type": "avatar_mood", "personId": 123, "mood": "laugh", "intensity": 1.0 }
  ```
- The recipient's mini 3D avatar card triggers `controller.triggerReaction('laugh')`, which drives a smooth **attack -> hold -> release** envelope (`ExpressionReactionEnvelope`) and automatically blends back to the user's resting profile mood once finished.
- Host UIs can read `frame.overlays` (`tears`, `blush`, `sweat_drop`, `anger_vein`, `sparkle`, `heart_eyes`) to render matching stylized 2D/shader particles or eye symbols (`frame.eyeSymbol`, `frame.pupilScale`, `frame.gaze`, `frame.headTiltDeg`).

### C. Interverse Games (Gameplay & Multiplayer)
- `ExpressionController` works identically inside `interverse-engine` games for NPC dialogue, combat hit/angry states, victory emotes, and multiplayer chat bubbles (replicating only `{ moodId, intensity }`, `< 16 bytes`).

---

## 3. Procedural Landmark Targets + Seamless Blender Upgrade Path

Studio base heads (`studio-female-body-v1.glb`, `studio-male-body-v1.glb`) ship without authored ARKit expression shape keys yet. Calling `installProceduralExpressionTargets(mesh, landmarks)` immediately synthesizes clean, neck-locked (`neckSeamY`) morph targets for all 30 `ARKIT_CORE_EXPRESSION_CHANNELS` around the avatar's landmarks.

Because `installProceduralExpressionTargets` checks `mesh.morphTargetDictionary?.[channel] !== undefined` and **skips any channel already present**, upgrading to high-detail Blender-sculpted ARKit shape keys requires zero runtime changes—Blender targets automatically take precedence per channel as they land.

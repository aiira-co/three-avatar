# @interverse/three-avatar

Portable Three.js avatar runtime and versioned asset format for Interverse Engine, social applications, and third-party Three.js projects.

The package intentionally contains no Angular UI, game locomotion, speech recognition, or remote marketplace client. Host applications supply assets and animate the exposed Three.js hierarchy.

## Runtime principles

- One canonical humanoid rig per avatar family.
- One indexed neck-down `SkinnedMesh` for body masking, with an optional
  morph-rich head `SkinnedMesh` sharing the same skeleton.
- Stable string body-region IDs in manifests and JSON.
- Covered body triangles are removed from the rendered index buffer when equipment changes.
- Skinned wearables reuse the base body's `Skeleton` instance.
- Rigid accessories attach to named bone sockets.
- Equipment occupancy, body coverage, and visual occlusion are separate concepts.
- Saved avatars contain exact versioned asset IDs, never asset URLs.

## Install

```bash
pnpm add @interverse/three-avatar three
```

## Basic usage

```ts
import {
  AvatarAssetRegistry,
  AvatarRuntime,
  GltfAvatarAssetLoader,
  INTERVERSE_RIG_PACK_V1,
} from '@interverse/three-avatar';

const registry = new AvatarAssetRegistry();
registry.install(INTERVERSE_RIG_PACK_V1);
registry.install({
  id: 'mygame:pack/avatars',
  version: '1.0.0',
  dependencies: [{ id: 'interverse:pack/rigs', version: '1.0.0' }],
  assets: [/* versioned GLB assets */],
  families: [/* avatar family manifests */],
  items: [/* wearable/accessory manifests */],
});

const loader = new GltfAvatarAssetLoader(registry);
const runtime = new AvatarRuntime(registry, loader);

const avatar = await runtime.create({
  family: { id: 'mygame:family/humanoid', version: '1.0.0' },
});

await avatar.equipment.equip({
  id: 'mygame:wearable/basic-shirt',
  version: '1.0.0',
});

scene.add(avatar.root);

const saved = avatar.serialize();
const restored = await runtime.fromJSON(saved);
```

See `examples/interverse-humanoid-v1.avatar-pack.json` for a complete manifest shape.

## Body asset contract

For runtime v1, the base body must:

1. Be an indexed `SkinnedMesh` using one material.
2. Use the family rig's canonical bind pose.
3. Arrange every triangle into contiguous, triangle-aligned body-region ranges.
4. Cover the complete index buffer exactly once in the region table.

Every skinned wearable must use compatible inverse bind matrices. Bone ordering may differ because the runtime remaps `skinIndex`, but every referenced wearable bone must resolve to a bone in the base skeleton.

For avatars with extensive identity and facial morphs, declare
`family.head.meshNode`. The runtime validates that node as a `SkinnedMesh`,
rebinds it to the body's canonical skeleton when necessary, and exposes it as
`avatar.headMesh`. Keep its `seam.neck` vertices fixed in every identity morph.

Body identity, head identity, garment fitting, expressions, and visemes all use
the same normalized morph-channel system. A fitted item can bind channels such
as `body.chestVolume`; when equipped, it immediately receives the avatar's
current value. Unknown or unbound channels are rejected rather than silently
entering serialized state.

The canonical Blender region groups, facial selection groups, node names, and
MVP identity shape keys are specified in `docs/AUTHORING.md`.

## Morph layers

`AvatarMorphController` is an additive mixer. Each channel's effective value is
the sum of its layer contributions, clamped to the binding's declared range:

| Layer | Written by | Serialized |
| --- | --- | --- |
| `base` | `morphs.set()` — body and head identity | yes |
| `face.expression` | `face.setExpression()` | no |
| `face.viseme` | `face.setViseme()`, `face.sampleVisemeCues()` | no |
| `face.tracking` | `face.setTracking()` — ARKit/MediaPipe adapters | no |

Setting a layer replaces it wholesale, so switching expression or viseme
releases the previous one instead of accumulating weights. `morphs.getValues()`
returns the base layer only; `morphs.getEffectiveValue(channel)` returns what is
actually driving the meshes.

## Facial animation

The runtime exposes normalized morph channels, expression presets, viseme presets, and timed viseme cue consumption. `sampleVisemeCues` releases the mouth once no cue covers the sampled time. Audio analysis and VTuber tracking are intentionally separate adapters.

## Serialization

`AvatarStateV1` stores the family, morph values, appearance values, and equipped versioned items. Runtime animation state such as blinking, current viseme, animation time, or IK state is not serialized.

Saved avatars are user data and outlive the family versions that produced them,
so restoring is tolerant by default:

- A family declares `supersedes: [{ id, version }]` to accept avatars saved
  against retired versions. `runtime.fromJSON()` resolves through it, and
  re-serializing names the current family.
- Morph channels, material channels, and equipment the current family cannot
  apply are reported through `onStateIssue` and preserved verbatim, so
  re-saving on a newer or older client never destroys them.
- Pass `strict: true` to reject such state instead.

## Bounds

`getBounds()` measures the body and head only, so it can drive a physics capsule
directly. Pass `{ includeEquipment: true }` for a visual bound that includes
hats, packs, and props.

## Subpath exports

`@interverse/three-avatar/gltf` exposes `GltfAvatarAssetLoader` on its own, for
hosts that supply a custom loader and do not want `GLTFLoader` in their bundle.

# Interverse humanoid authoring contract

This document defines the Blender names used by the first
`@interverse/three-avatar` humanoid family. The source model should begin as one
continuous character. The export pipeline may split the morph-rich head from
the neck-down body at the locked neck seam.

## Required exported nodes

| Node | Type | Purpose |
| --- | --- | --- |
| `AvatarBody` | Indexed `SkinnedMesh` | Neck-down body masking and body identity morphs |
| `AvatarHead` | `SkinnedMesh` | Head identity, expressions, and visemes |
| `EyeLeft` | Mesh | Left eyeball, driven by `eye.left` |
| `EyeRight` | Mesh | Right eyeball, driven by `eye.right` |
| `TeethUpper` | Mesh or `SkinnedMesh` | Upper teeth |
| `TeethLower` | Mesh or `SkinnedMesh` | Lower teeth, normally jaw-driven |
| `Tongue` | Optional mesh | Tongue, normally jaw/tongue driven |

Both skinned meshes must use the same canonical Mixamo-derived armature, bind
matrix, inverse bind matrices, scale, and reference pose.

## Body face/vertex groups

Every source-body polygon belongs to exactly one `region.*` group. These are
selection/metadata groups, not material slots and not separate body objects.

| Blender group | Area |
| --- | --- |
| `region.head` | Source head before export splitting |
| `region.neck` | Neck below the locked seam |
| `region.torso.upper` | Chest, upper back, and shoulders excluding arms |
| `region.torso.lower` | Abdomen and lower back |
| `region.pelvis` | Pelvis, groin, and hip transition |
| `region.arm.upper.left` | Left shoulder-to-elbow limb surface |
| `region.arm.upper.right` | Right shoulder-to-elbow limb surface |
| `region.arm.lower.left` | Left elbow-to-wrist limb surface |
| `region.arm.lower.right` | Right elbow-to-wrist limb surface |
| `region.hand.left` | Left wrist seam through fingers |
| `region.hand.right` | Right wrist seam through fingers |
| `region.leg.upper.left` | Left hip-to-knee limb surface |
| `region.leg.upper.right` | Right hip-to-knee limb surface |
| `region.leg.lower.left` | Left knee-to-ankle limb surface |
| `region.leg.lower.right` | Right knee-to-ankle limb surface |
| `region.foot.left` | Left ankle seam through toes |
| `region.foot.right` | Right ankle seam through toes |

Create `seam.neck` on the final shared neck loop. The seam is locked from both
sides: every head identity morph *and* every body identity morph must leave this
group unchanged. Body archetype and proportion shapes such as
`body.archetype.feminine` or `body.shoulderWidth` reshape the neck and shoulders,
so they must taper to zero displacement at the seam or the head will visibly
detach from the body. When the exporter separates the head, it duplicates the
seam vertices with identical positions, normals, UVs, and skin weights.

Region boundaries should sit where clothing naturally covers them. A triangle
must never straddle two region assignments after triangulation. Generate index
ranges only after triangulation and mesh optimization.

## Optional facial selection groups

These groups do not affect rendering. They make sculpting, validation, and
future Blender tooling deterministic:

`feature.forehead`, `feature.brow.left`, `feature.brow.right`,
`feature.eye.left`, `feature.eye.right`, `feature.nose`,
`feature.cheek.left`, `feature.cheek.right`, `feature.mouth`, `feature.jaw`,
`feature.ear.left`, and `feature.ear.right`.

## Core identity shape keys

Use the runtime channel ID as the Blender shape-key name. The neutral basis is
`Basis`; identity values are serialized, while expressions and visemes are
temporary runtime state.

Body and fitted-garment channels:

`body.archetype.masculine`, `body.archetype.feminine`,
`body.shoulderWidth`, `body.chestVolume`, `body.waistWidth`, `body.hipWidth`,
`body.gluteVolume`, `body.muscularity`, `body.bodyFat`, `body.armThickness`, and
`body.legThickness`.

Head channels:

`head.width`, `head.height`, `head.depth`, `face.width`, `face.length`,
`jaw.width`, `jaw.projection`, `chin.width`, `chin.projection`, `cheek.width`,
`cheek.fullness`, `nose.width`, `nose.length`, `nose.projection`, `eye.spacing`,
`eye.size`, `mouth.width`, and `mouth.fullness`.

Hair, hats, glasses, and fitted clothing should expose matching shape keys for
every identity channel that changes their fit. The runtime applies a channel's
current value when the item is equipped.

## Blender groups versus armature weights

The `region.*`, `feature.*`, and `seam.*` groups are authoring metadata. Mixamo
bone-weight vertex groups remain separate and retain their canonical bone names.
Do not replace bone-weight groups with body-region groups.

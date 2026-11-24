# Blender 5.1 Head Archetype Sculpting & Export Pipeline

`sculpt_head_archetypes.py` automates reference setup, neck-seam locking, facial region masking, initial preset sculpting, sparse `HeadArchetypeDefinition` JSON export, and orthographic Front + Side QA rendering on the Studio base bodies (`studio-male-body-v1.glb` / `studio-female-body-v1.glb`).

## Workflow

### 1. Place Orthographic Front & Side Reference Sheets for Sculpting
```bash
/Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/sculpt_head_archetypes.py -- \
  --mode setup-refs \
  --input /Users/primus-tech_01/Interverse/interverse-engine/public/assets/avatar-prototype/rigged/studio-female-body-v1.glb \
  --turnaround docs/concepts/head-archetypes/head-manga-turnaround.png \
  --blend-out /tmp/head-manga-work.blend
```
Open `/tmp/head-manga-work.blend` in Blender, switch to **Sculpt Mode** with **X-Mirror**, choose a `HeadArchetype_<id>` shape key, and sculpt against the aligned `FrontRef` (`-Y` view) and `SideRef` (`+X` view). Keep `neck_lock` / `seam.neck` untouched so the head attaches cleanly to `AvatarBody`.

### 2. Generate Starting Sculpted Shape Keys + Export Sparse Deltas & QA Renders
```bash
/Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/sculpt_head_archetypes.py -- \
  --mode sculpt-presets \
  --input /Users/primus-tech_01/Interverse/interverse-engine/public/assets/avatar-prototype/rigged/studio-female-body-v1.glb \
  --blend-out /tmp/studio-female-heads.blend \
  --json-out /tmp/head-archetypes-female.json \
  --render-dir /tmp/head-qa-female
```

### 3. Re-Export & Render After Manual Sculpting Tweaks
```bash
/Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/sculpt_head_archetypes.py -- \
  --mode export-and-render \
  --input /tmp/studio-female-heads.blend \
  --json-out /tmp/head-archetypes-female.json \
  --glb-out /tmp/studio-female-body-v2-heads.glb \
  --render-dir /tmp/head-qa-female
```

## Full Artist Blendshape Workfiles (Head Styles, Expressions & Ear/Eye Morphs)

`art/avatar-prototype/studio-female-blendshapes.blend` and `art/avatar-prototype/studio-male-blendshapes.blend` inside `interverse-engine` contain `AvatarArmature` + `AvatarBody` with:
- All **59 shape keys** (`Basis` + `HeadArchetype_*` head styles, 30 ARKit facial expressions, and `ProceduralFace_*` ear/eye-socket/face controls) set to their exact runtime slider ranges (`0..1` or `-1..1`).
- Exact sheared-ellipsoid **ReferenceEyes** (`RefEye_Left` / `RefEye_Right`) and selection vertex groups (`feature.eyes`, `feature.ears`, `feature.mouth`, `seam.neck_locked`) so eyelid/socket clearance is visible while sculpting.

To export sculpted `HeadArchetype_*` JSON deltas, optional sculpted expression channels, and an optional baked GLB (with `ReferenceEyes`, cameras, and lights automatically excluded):

```bash
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python-exit-code 1 \
  --python tools/blender/sync_blendshape_workfile.py -- \
  --mode export --slug female \
  --input /Users/primus-tech_01/Interverse/interverse-engine/art/avatar-prototype/studio-female-blendshapes.blend \
  --head-json-out /Users/primus-tech_01/Interverse/Framework/three-avatar/examples/head-archetypes/head-archetypes-female.json \
  --expression-channels jawOpen,mouthFunnel,mouthPucker \
  --glb-out /tmp/studio-female-sculpted.glb
```

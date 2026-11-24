"""Build and round-trip export artist-ready Blender 5.1 blendshape workfiles.

Usage inside Blender 5.1:
  Build workfile from Studio GLB + dumped morph targets JSON:
    /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python-exit-code 1 \
      --python tools/blender/sync_blendshape_workfile.py -- \
      --mode build --slug female \
      --input /path/to/studio-female-body-v1.glb \
      --morphs-json /path/to/morphs-female.json \
      --blend-out /path/to/studio-female-blendshapes.blend

  Export sculpted HeadArchetype JSON (and optional baked GLB excluding helpers):
    /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python-exit-code 1 \
      --python tools/blender/sync_blendshape_workfile.py -- \
      --mode export --slug female \
      --input /path/to/studio-female-blendshapes.blend \
      --head-json-out /path/to/head-archetypes-female.json \
      [--glb-out /path/to/studio-female-body-v1-sculpted.glb]
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

import bpy
import numpy as np
from mathutils import Vector

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import sculpt_head_archetypes as sha  # noqa: E402


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = argv[1:]
    parser = argparse.ArgumentParser(description="Avatar Studio Blender blendshape workfile builder & exporter")
    parser.add_argument("--mode", required=True, choices=["build", "export"])
    parser.add_argument("--input", required=True, help="Input Studio GLB (build) or .blend file (export)")
    parser.add_argument("--slug", help="Target body slug (female or male); inferred from input name if omitted")
    parser.add_argument("--morphs-json", help="Dumped morph targets JSON for --mode build")
    parser.add_argument("--blend-out", help="Output .blend path for --mode build")
    parser.add_argument("--head-json-out", help="Output sparse HeadArchetypePack JSON path for --mode export")
    parser.add_argument(
        "--expression-channels",
        help="Comma-separated shape key names to export into expressionTargets alongside HeadArchetype_*",
    )
    parser.add_argument("--glb-out", help="Optional output GLB with baked shape keys (excludes helper objects)")
    parser.add_argument("--neck-seam-y", type=float, default=0.785, help="Height below which head/archetype morphs lock to 0")
    parser.add_argument("--blend-height", type=float, default=0.025, help="Smoothstep blend height above neck seam")
    return parser.parse_args(argv)


def infer_slug(args: argparse.Namespace) -> str | None:
    if args.slug:
        return str(args.slug).strip().lower()
    stem = Path(args.input).stem.lower()
    if "female" in stem:
        return "female"
    if "male" in stem:
        return "male"
    return None


def get_or_create_collection(name: str, parent: bpy.types.Collection | None = None) -> bpy.types.Collection:
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(coll)
    return coll


def move_object_to_collection(obj: bpy.types.Object, target: bpy.types.Collection) -> None:
    for coll in list(obj.users_collection):
        coll.objects.unlink(obj)
    target.objects.link(obj)


def make_flat_material(name: str, color: Tuple[float, float, float, float], roughness: float = 0.15) -> bpy.types.Material:
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name=name)
    if hasattr(mat, "use_nodes") and not mat.use_nodes:
        mat.use_nodes = True
    if mat.node_tree:
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = color
            if "Roughness" in bsdf.inputs:
                bsdf.inputs["Roughness"].default_value = roughness
    return mat


def create_sheared_reference_eye(
    side: str,
    side_sign: float,
    eye_cfg: Dict[str, object],
    collection: bpy.types.Collection,
) -> bpy.types.Object:
    """Create exact sheared-ellipsoid reference eyeball matching procedural-eyes.ts."""
    name = f"RefEye_{side}"
    existing = bpy.data.objects.get(name)
    if existing is not None:
        bpy.data.objects.remove(existing, do_unlink=True)

    cx, cy, cz = [float(v) for v in eye_cfg["center"]]  # type: ignore[index]
    rx, ry, rz = [float(v) for v in eye_cfg["radii"]]  # type: ignore[index]
    base_shear_z = float(eye_cfg.get("shearZ", 0.0))  # type: ignore[arg-type]
    shear_y = float(eye_cfg.get("shearY", 0.0))  # type: ignore[arg-type]
    back_scale = max(1.0, float(eye_cfg.get("backDepthScale", 1.0)))  # type: ignore[arg-type]
    shear_z = side_sign * base_shear_z
    center_x = side_sign * cx

    rings = 24
    sectors = 32
    verts: List[Tuple[float, float, float]] = []
    faces: List[Tuple[int, ...]] = []
    face_zones: List[int] = []

    for r in range(rings + 1):
        phi = (r / rings) * math.pi
        sin_p = math.sin(phi)
        cos_p = math.cos(phi)
        for s in range(sectors):
            theta = (s / sectors) * math.pi * 2.0
            nx = sin_p * math.cos(theta)
            ny = sin_p * math.sin(theta)
            nz = cos_p
            z_rad = rz if nz >= 0.0 else rz * back_scale
            zg = cz + nz * z_rad + nx * shear_z + ny * shear_y
            xg = center_x + nx * rx
            yg = cy + ny * ry
            # glTF (+Y up, +Z forward) -> Blender (+Z up, -Y forward)
            verts.append((xg, -zg, yg))

    for r in range(rings):
        for s in range(sectors):
            s1 = (s + 1) % sectors
            a = r * sectors + s
            b = r * sectors + s1
            c = (r + 1) * sectors + s1
            d = (r + 1) * sectors + s
            faces.append((a, b, c, d))
            phi_mid = ((r + 0.5) / rings) * math.pi
            cos_mid = math.cos(phi_mid)
            if cos_mid > 0.94:
                face_zones.append(2)  # Pupil
            elif cos_mid > 0.80:
                face_zones.append(1)  # Iris
            else:
                face_zones.append(0)  # Sclera

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    sclera_mat = make_flat_material("RefEyeSclera", (0.95, 0.94, 0.91, 1.0), 0.12)
    iris_mat = make_flat_material("RefEyeIris", (0.20, 0.48, 0.72, 1.0), 0.18)
    pupil_mat = make_flat_material("RefEyePupil", (0.04, 0.05, 0.08, 1.0), 0.08)
    mesh.materials.append(sclera_mat)
    mesh.materials.append(iris_mat)
    mesh.materials.append(pupil_mat)
    for f_idx, poly in enumerate(mesh.polygons):
        poly.material_index = face_zones[f_idx]
        poly.use_smooth = True
    mesh.update()

    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.display_type = "SOLID"
    return obj


def install_feature_vertex_groups(
    body: bpy.types.Object,
    eye_cfg: Dict[str, object],
    ear_cfg: Dict[str, object],
    neck_lock: Sequence[float],
) -> None:
    """Add convenient Blender selection vertex groups for eyes, ears, mouth, and locked neck."""
    mw = body.matrix_world
    world_verts = [mw @ v.co for v in body.data.vertices]
    cx, cy, cz = [float(v) for v in eye_cfg["center"]]  # type: ignore[index]
    rx, ry, rz = [float(v) for v in eye_cfg["radii"]]  # type: ignore[index]
    shear_z = float(eye_cfg.get("shearZ", 0.0))  # type: ignore[arg-type]
    shear_y = float(eye_cfg.get("shearY", 0.0))  # type: ignore[arg-type]
    back_scale = max(1.0, float(eye_cfg.get("backDepthScale", 1.0)))  # type: ignore[arg-type]

    ear_root_x = float(ear_cfg.get("rootX", 0.058))  # type: ignore[arg-type]
    ear_slope = float(ear_cfg.get("rootSlopeY", 0.24))  # type: ignore[arg-type]
    ear_cy = float(ear_cfg.get("centerY", cy - 0.004))  # type: ignore[arg-type]
    ear_hy = float(ear_cfg.get("halfY", 0.025))  # type: ignore[arg-type]
    ear_cz = float(ear_cfg.get("centerZ", -0.024))  # type: ignore[arg-type]
    ear_hz = float(ear_cfg.get("halfZ", 0.018))  # type: ignore[arg-type]

    def ensure_vg(group_name: str) -> bpy.types.VertexGroup:
        vg = body.vertex_groups.get(group_name)
        if vg is None:
            vg = body.vertex_groups.new(name=group_name)
        return vg

    vg_eyes = ensure_vg("feature.eyes")
    vg_ears = ensure_vg("feature.ears")
    vg_mouth = ensure_vg("feature.mouth")
    vg_neck = ensure_vg("seam.neck_locked")

    eye_indices: List[int] = []
    ear_indices: List[int] = []
    mouth_indices: List[int] = []
    neck_indices: List[int] = []

    mouth_y = cy - 0.052
    for idx, p in enumerate(world_verts):
        if neck_lock[idx] == 0.0:
            neck_indices.append(idx)
            continue

        side = 1.0 if p.x >= 0.0 else -1.0
        nx = (side * p.x - cx) / max(rx, 1e-4)
        ny = (p.z - cy) / max(ry, 1e-4)
        qz_eff = (-p.y - cz) - nx * shear_z - ny * shear_y
        rz_eff = rz if qz_eff >= 0.0 else rz * back_scale
        nz = qz_eff / max(rz_eff, 1e-4)
        if math.sqrt(nx * nx + ny * ny + nz * nz) <= 1.65 and nz > -0.35:
            eye_indices.append(idx)

        local_root_x = ear_root_x + ear_slope * (p.z - ear_cy)
        if (
            abs(p.x) > local_root_x
            and abs(p.z - ear_cy) <= ear_hy * 1.4
            and abs(ear_cz - (-p.y)) <= ear_hz * 1.4
        ):
            ear_indices.append(idx)

        if abs(p.x) <= 0.026 and abs(p.z - mouth_y) <= 0.018 and -p.y > cz:
            mouth_indices.append(idx)

    if eye_indices:
        vg_eyes.add(eye_indices, 1.0, "REPLACE")
    if ear_indices:
        vg_ears.add(ear_indices, 1.0, "REPLACE")
    if mouth_indices:
        vg_mouth.add(mouth_indices, 1.0, "REPLACE")
    if neck_indices:
        vg_neck.add(neck_indices, 1.0, "REPLACE")


def add_face_cameras_and_lights(
    body: bpy.types.Object,
    metrics: Dict[str, object],
    collection: bpy.types.Collection,
) -> None:
    head_max: Vector = metrics["max"]  # type: ignore[assignment]
    landmarks: Dict[str, Vector] = metrics["landmarks"]  # type: ignore[assignment]
    eye_z = landmarks["eyeLeft"].z
    focus_front = Vector((0.0, 0.0, eye_z - 0.015))

    def create_cam(name: str, loc: Vector, target: Vector, lens: float) -> bpy.types.Object:
        existing = bpy.data.objects.get(name)
        if existing is not None:
            bpy.data.objects.remove(existing, do_unlink=True)
        cam_data = bpy.data.cameras.new(name)
        cam_data.lens = lens
        cam_data.clip_start = 0.005
        cam_data.clip_end = 25.0
        cam_obj = bpy.data.objects.new(name, cam_data)
        cam_obj.location = loc
        cam_obj.rotation_euler = (target - loc).to_track_quat("-Z", "Y").to_euler()
        collection.objects.link(cam_obj)
        return cam_obj

    cam_front = create_cam("Cam_FaceFront", Vector((0.0, -0.52, eye_z - 0.01)), focus_front, 85.0)
    create_cam("Cam_FaceThreeQuarter", Vector((0.26, -0.45, eye_z + 0.01)), focus_front, 85.0)
    ear_z = landmarks["earLeft"].z
    create_cam("Cam_EarSide", Vector((0.46, 0.01, ear_z)), Vector((0.05, 0.02, ear_z)), 85.0)
    bpy.context.scene.camera = cam_front

    def add_light(name: str, energy: float, loc: Vector, target: Vector) -> None:
        existing = bpy.data.objects.get(name)
        if existing is not None:
            bpy.data.objects.remove(existing, do_unlink=True)
        light_data = bpy.data.lights.new(name=name, type="AREA")
        light_data.energy = energy
        light_data.size = 0.6
        light_obj = bpy.data.objects.new(name, light_data)
        light_obj.location = loc
        light_obj.rotation_euler = (target - loc).to_track_quat("-Z", "Y").to_euler()
        collection.objects.link(light_obj)

    head_center = Vector((0.0, 0.0, (head_max.z + eye_z) * 0.5))
    add_light("KeyLight", 24.0, Vector((0.50, -0.80, eye_z + 0.30)), head_center)
    add_light("FillLight", 10.0, Vector((-0.65, -0.60, eye_z + 0.05)), head_center)
    add_light("RimLight", 16.0, Vector((0.0, 0.80, eye_z + 0.32)), head_center)

    # Set clip_start small on any viewport 3D views so close-up lid/ear inspection never clips.
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                for space in area.spaces:
                    if space.type == "VIEW_3D":
                        space.clip_start = 0.005


def install_morph_targets_fast(body: bpy.types.Object, targets: Sequence[Dict[str, object]]) -> int:
    shape_keys = sha.ensure_basis_shape_key(body)
    basis = shape_keys.key_blocks["Basis"]
    vcount = len(basis.data)
    basis_co = np.empty(vcount * 3, dtype=np.float32)
    basis.data.foreach_get("co", basis_co)

    rot_inv_np = np.array(body.matrix_world.inverted().to_3x3(), dtype=np.float32)  # 3x3
    installed = 0

    for entry in targets:
        name = str(entry["name"])
        min_val = float(entry.get("min", 0.0))  # type: ignore[arg-type]
        max_val = float(entry.get("max", 1.0))  # type: ignore[arg-type]
        sparse_indices = entry["vertexIndices"]  # type: ignore[index]
        sparse_deltas = entry["deltas"]  # type: ignore[index]

        if len(sparse_indices) * 3 != len(sparse_deltas):
            raise RuntimeError(f"Mismatched sparse buffer lengths for shape key '{name}'")

        existing = shape_keys.key_blocks.get(name)
        if existing is not None:
            body.shape_key_remove(existing)
        key = body.shape_key_add(name=name, from_mix=False)
        if min_val > key.slider_max:
            key.slider_max = max_val
        key.slider_min = min_val
        key.slider_max = max_val
        key.value = 0.0

        world_delta = np.zeros((vcount, 3), dtype=np.float32)
        if sparse_indices:
            idx_np = np.asarray(sparse_indices, dtype=np.int32)
            gltf_np = np.asarray(sparse_deltas, dtype=np.float32).reshape(-1, 3)
            # glTF (+X left, +Y up, +Z forward) -> Blender (+X, -Z, +Y)
            bl_world = np.empty_like(gltf_np)
            bl_world[:, 0] = gltf_np[:, 0]
            bl_world[:, 1] = -gltf_np[:, 2]
            bl_world[:, 2] = gltf_np[:, 1]
            world_delta[idx_np] = bl_world

        local_delta = (world_delta @ rot_inv_np.T).reshape(-1)
        key.data.foreach_set("co", (basis_co + local_delta).astype(np.float32))
        installed += 1

    return installed


def mode_build(args: argparse.Namespace) -> None:
    if not args.morphs_json or not args.blend_out:
        raise ValueError("--mode build requires --morphs-json and --blend-out")
    morphs_path = Path(args.morphs_json).resolve()
    morphs_data = json.loads(morphs_path.read_text(encoding="utf-8"))

    body, armature = sha.load_scene(Path(args.input).resolve())
    expected_vcount = int(morphs_data["vertexCount"])
    actual_vcount = len(body.data.vertices)
    if actual_vcount != expected_vcount:
        raise RuntimeError(
            f"Vertex count mismatch for {args.input}: Blender loaded {actual_vcount}, expected {expected_vcount}"
        )

    slug = infer_slug(args)
    metrics, neck_lock, _regions = sha.populate_head_groups(
        body, args.neck_seam_y, args.blend_height, slug=slug
    )
    installed = install_morph_targets_fast(body, morphs_data["targets"])

    ref_eyes_coll = get_or_create_collection("ReferenceEyes")
    create_sheared_reference_eye("Left", 1.0, morphs_data["eye"], ref_eyes_coll)
    create_sheared_reference_eye("Right", -1.0, morphs_data["eye"], ref_eyes_coll)

    install_feature_vertex_groups(body, morphs_data["eye"], morphs_data["ear"], neck_lock)

    helpers_coll = get_or_create_collection("StudioHelpers")
    add_face_cameras_and_lights(body, metrics, helpers_coll)

    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    if body.data.shape_keys and len(body.data.shape_keys.key_blocks) > 1:
        body.active_shape_key_index = 1

    try:
        bpy.ops.file.pack_all()
    except Exception:
        pass

    out_path = Path(args.blend_out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(out_path), compress=True)
    print(
        f"BUILT_WORKFILE: path={out_path} slug={slug} verts={actual_vcount} shape_keys={installed + 1} (Basis + {installed})"
    )


def enforce_neck_lock_on_head_keys(body: bpy.types.Object, neck_lock: Sequence[float]) -> None:
    shape_keys = body.data.shape_keys
    if shape_keys is None:
        return
    basis = shape_keys.key_blocks["Basis"]
    vcount = len(basis.data)
    basis_co = np.empty(vcount * 3, dtype=np.float32)
    basis.data.foreach_get("co", basis_co)
    basis_3 = basis_co.reshape(-1, 3)
    lock_np = np.asarray(neck_lock, dtype=np.float32)[:, None]

    for key in shape_keys.key_blocks:
        if not key.name.startswith("HeadArchetype_"):
            continue
        key_co = np.empty(vcount * 3, dtype=np.float32)
        key.data.foreach_get("co", key_co)
        delta_3 = key_co.reshape(-1, 3) - basis_3
        locked = (basis_3 + delta_3 * lock_np).reshape(-1).astype(np.float32)
        key.data.foreach_set("co", locked)


def extract_sparse_expression_targets(
    body: bpy.types.Object,
    neck_lock: Sequence[float],
    channels: Sequence[str],
) -> Dict[str, Dict[str, List[float] | List[int]]]:
    """Extract neck-locked sparse glTF deltas for sculpted facial expression shape keys."""
    shape_keys = body.data.shape_keys
    if shape_keys is None or "Basis" not in shape_keys.key_blocks:
        raise RuntimeError("Input mesh has no Basis shape key for expression export")

    basis = shape_keys.key_blocks["Basis"]
    vcount = len(basis.data)
    rot_world = body.matrix_world.to_3x3()
    basis_co = np.empty(vcount * 3, dtype=np.float32)
    basis.data.foreach_get("co", basis_co)
    basis_3 = basis_co.reshape(-1, 3)

    exported: Dict[str, Dict[str, List[float] | List[int]]] = {}
    for channel in channels:
        key = shape_keys.key_blocks.get(channel)
        if key is None:
            raise RuntimeError(f"Requested expression shape key '{channel}' not found on {body.name}")

        key_co = np.empty(vcount * 3, dtype=np.float32)
        key.data.foreach_get("co", key_co)
        local_deltas = key_co.reshape(-1, 3) - basis_3

        vertex_indices: List[int] = []
        deltas: List[float] = []
        max_mm = 0.0
        raw_neck_clamped_mm = 0.0

        for idx in range(vcount):
            ld = local_deltas[idx]
            if ld[0] == 0.0 and ld[1] == 0.0 and ld[2] == 0.0:
                continue
            raw_world = rot_world @ Vector((float(ld[0]), float(ld[1]), float(ld[2])))
            lock = float(neck_lock[idx])
            if lock == 0.0:
                raw_neck_clamped_mm = max(raw_neck_clamped_mm, raw_world.length * 1000.0)
                continue
            locked_world = raw_world * lock
            if locked_world.length > 1e-6:
                gx, gy, gz = sha.blender_vec_to_gltf(locked_world)
                vertex_indices.append(idx)
                deltas.extend([gx, gy, gz])
                max_mm = max(max_mm, locked_world.length * 1000.0)

        exported[channel] = {
            "vertexIndices": vertex_indices,
            "deltas": deltas,
        }
        print(
            f"EXPRESSION_TARGET {channel}: active_verts={len(vertex_indices)} "
            f"max={max_mm:.2f}mm raw_neck_clamped={raw_neck_clamped_mm:.4f}mm"
        )

    return exported


def mode_export(args: argparse.Namespace) -> None:
    body, armature = sha.load_scene(Path(args.input).resolve())
    slug = infer_slug(args)
    metrics, neck_lock, regions = sha.populate_head_groups(
        body, args.neck_seam_y, args.blend_height, slug=slug
    )
    enforce_neck_lock_on_head_keys(body, neck_lock)

    if args.head_json_out:
        export_ns = argparse.Namespace(
            input=args.input,
            slug=slug,
            neck_seam_y=args.neck_seam_y,
            blend_height=args.blend_height,
            json_out=args.head_json_out,
            glb_out=None,
            render_dir=None,
            render_engine="CYCLES",
        )
        sha.export_and_render(body, metrics, regions, export_ns)

        if args.expression_channels:
            channels = [c.strip() for c in str(args.expression_channels).split(",") if c.strip()]
            if channels:
                expr_targets = extract_sparse_expression_targets(body, neck_lock, channels)
                json_path = Path(args.head_json_out).resolve()
                pack = json.loads(json_path.read_text(encoding="utf-8"))
                pack["expressionTargets"] = expr_targets
                json_path.write_text(json.dumps(pack, separators=(",", ":")), encoding="utf-8")

    if args.glb_out:
        glb_path = Path(args.glb_out).resolve()
        glb_path.parent.mkdir(parents=True, exist_ok=True)
        if body.data.shape_keys:
            for key in body.data.shape_keys.key_blocks:
                if key.name != "Basis":
                    key.value = 0.0
        bpy.ops.object.select_all(action="DESELECT")
        body.select_set(True)
        if armature is not None:
            armature.select_set(True)
            bpy.context.view_layer.objects.active = armature
        bpy.ops.export_scene.gltf(
            filepath=str(glb_path),
            export_format="GLB",
            use_selection=True,
            export_morph=True,
            export_morph_normal=True,
        )
        print(f"EXPORTED_SCULPTED_GLB: {glb_path}")


def main(argv: Sequence[str]) -> None:
    args = parse_args(argv)
    if args.mode == "build":
        mode_build(args)
    elif args.mode == "export":
        mode_export(args)


if __name__ == "__main__":
    main(sys.argv)

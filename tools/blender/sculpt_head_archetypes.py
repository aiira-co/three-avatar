"""Blender 5.1 head-archetype setup, sculpting preset generator, exporter, and QA renderer.

Usage inside Blender:
  /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/sculpt_head_archetypes.py -- \\
    --mode setup-refs --input /path/to/studio-female-body-v1.glb --turnaround docs/concepts/head-archetypes/head-manga-turnaround.png --blend-out /tmp/head_work.blend
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector
from mathutils.kdtree import KDTree


STUDIO_EYE_FITS_BLENDER: Dict[
    str,
    Tuple[Tuple[float, float, float], Tuple[float, float, float], float, float, float],
] = {
    "female": ((0.0268, -0.0365, 0.9010), (0.0220, 0.0225, 0.0172), -0.0102, 0.0024, 1.6),
    "male": ((0.0332, -0.0445, 0.8925), (0.0178, 0.0182, 0.0128), -0.0100, 0.0, 1.3),
}


ARCHETYPE_SPECS: Dict[str, Dict[str, object]] = {
    "black": {
        "label": "Black / African",
        "cranium": {"scale": (1.02, 1.055, 1.01), "offset": (0.0, 0.003, 0.0)},
        "brows_eyes": {
            "brow_z": 0.0006,
            "brow_fwd": 0.0009,
            "upper_lid": -0.035,
            "lower_lid": 0.025,
            "eye_tilt": 0.01,
            "socket_width": 0.0009,
            "socket_depth": 0.0005,
            "lid_fold": 0.0,
        },
        "nose": {"bridge_fwd": -0.0045, "wing_x": 0.0075, "tip_fwd": -0.0022, "tip_z": -0.0016},
        "cheeks": {"fullness_fwd": 0.0045, "cheekbone_x": 0.0048},
        "mouth": {"lip_fullness": 0.0078, "width_x": 0.0045},
        "jaw_chin": {"jaw_x": 0.0040, "chin_z": -0.0014, "chin_fwd": 0.0016},
        "ears": {"scale": 1.02},
    },
    "east_asian": {
        "label": "East Asian",
        "cranium": {"scale": (1.06, 0.965, 0.995), "offset": (0.0, 0.0015, 0.0)},
        "brows_eyes": {
            "brow_z": -0.0005,
            "brow_fwd": -0.0012,
            "upper_lid": -0.09,
            "lower_lid": 0.06,
            "eye_tilt": 0.06,
            "socket_width": 0.0012,
            "socket_depth": -0.0005,
            "lid_fold": 0.0018,
        },
        "nose": {"bridge_fwd": -0.0048, "wing_x": 0.0015, "tip_fwd": -0.0028, "tip_z": 0.0006},
        "cheeks": {"fullness_fwd": 0.0045, "cheekbone_x": 0.0085},
        "mouth": {"lip_fullness": 0.0015, "width_x": -0.0020},
        "jaw_chin": {"jaw_x": -0.0022, "chin_z": 0.0010, "chin_fwd": -0.0014},
        "ears": {"scale": 0.98},
    },
    "chinese": {
        "label": "Chinese",
        "cranium": {"scale": (1.010, 0.985, 1.032), "offset": (0.0, 0.0, 0.0025)},
        "brows_eyes": {
            "brow_z": 0.0010,
            "brow_fwd": -0.0005,
            "upper_lid": -0.075,
            "lower_lid": 0.045,
            "eye_tilt": 0.08,
            "socket_width": 0.0014,
            "socket_depth": 0.0,
            "lid_fold": 0.0012,
        },
        "nose": {"bridge_fwd": -0.0010, "wing_x": -0.0026, "tip_fwd": 0.0018, "tip_z": 0.0012},
        "cheeks": {"fullness_fwd": 0.0022, "cheekbone_x": 0.0038},
        "mouth": {"lip_fullness": 0.0020, "width_x": -0.0024},
        "jaw_chin": {"jaw_x": -0.0062, "chin_z": -0.0032, "chin_fwd": -0.0006},
        "ears": {"scale": 0.95},
    },
    "manga": {
        "label": "Manga / Anime 3D",
        "cranium": {"scale": (1.06, 1.03, 1.032), "offset": (0.0, 0.0, 0.0030)},
        "brows_eyes": {
            "brow_z": 0.0028,
            "brow_fwd": 0.0007,
            "upper_lid": 0.095,
            "lower_lid": -0.06,
            "eye_tilt": 0.02,
            "socket_width": 0.0016,
            "socket_depth": 0.0004,
            "lid_fold": -0.0005,
        },
        "nose": {"bridge_fwd": -0.0024, "wing_x": -0.0028, "tip_fwd": 0.0012, "tip_z": 0.0016},
        "cheeks": {"fullness_fwd": 0.0028, "cheekbone_x": -0.0008},
        "mouth": {"lip_fullness": -0.0018, "width_x": -0.0032},
        "jaw_chin": {"jaw_x": -0.0058, "chin_z": -0.0040, "chin_fwd": 0.0024},
        "ears": {"scale": 0.90},
    },
    "south_asian": {
        "label": "South Asian",
        "cranium": {"scale": (1.005, 1.018, 1.018), "offset": (0.0, 0.0, 0.0010)},
        "brows_eyes": {
            "brow_z": -0.0007,
            "brow_fwd": 0.0014,
            "upper_lid": 0.025,
            "lower_lid": -0.018,
            "eye_tilt": 0.03,
            "socket_width": 0.0014,
            "socket_depth": 0.0014,
            "lid_fold": 0.0,
        },
        "nose": {"bridge_fwd": 0.0052, "wing_x": 0.0010, "tip_fwd": 0.0048, "tip_z": -0.0020},
        "cheeks": {"fullness_fwd": 0.0015, "cheekbone_x": 0.0035},
        "mouth": {"lip_fullness": 0.0052, "width_x": 0.0018},
        "jaw_chin": {"jaw_x": -0.0022, "chin_z": -0.0020, "chin_fwd": 0.0008},
        "ears": {"scale": 1.0},
    },
    "angular": {
        "label": "Angular / Sculpted",
        "cranium": {"scale": (0.985, 1.035, 1.018), "offset": (0.0, 0.0, 0.0010)},
        "brows_eyes": {
            "brow_z": -0.0010,
            "brow_fwd": 0.0030,
            "upper_lid": -0.065,
            "lower_lid": 0.042,
            "eye_tilt": 0.022,
            "socket_width": 0.0010,
            "socket_depth": 0.0020,
            "lid_fold": 0.0004,
        },
        "nose": {"bridge_fwd": 0.0052, "wing_x": -0.0024, "tip_fwd": 0.0046, "tip_z": 0.0012},
        "cheeks": {"fullness_fwd": -0.0035, "cheekbone_x": 0.0080},
        "mouth": {"lip_fullness": -0.0005, "width_x": 0.0022},
        "jaw_chin": {"jaw_x": 0.0115, "chin_z": -0.0036, "chin_fwd": 0.0062},
        "ears": {"scale": 0.99},
    },
}

REGION_IDS = (
    "cranium",
    "brows_eyes",
    "nose",
    "cheeks",
    "mouth",
    "jaw_chin",
    "ears",
)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = argv[1:]
    parser = argparse.ArgumentParser(description="Avatar Studio Blender 5.1 head-archetype pipeline")
    parser.add_argument("--mode", required=True, choices=["setup-refs", "sculpt-presets", "export-and-render"])
    parser.add_argument("--input", required=True, help="Input Studio body GLB or .blend file")
    parser.add_argument("--slug", help="Target body slug (e.g., male, female); inferred from input filename if omitted")
    parser.add_argument("--blend-out", help="Output .blend path")
    parser.add_argument("--json-out", help="Output sparse HeadArchetypePack JSON path")
    parser.add_argument("--glb-out", help="Optional output GLB with baked shape keys")
    parser.add_argument("--render-dir", help="Optional directory to render orthographic front+side QA PNGs")
    parser.add_argument("--render-engine", default="CYCLES", choices=["CYCLES", "BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"], help="Render engine for headless QA renders")
    parser.add_argument("--front-ref", help="Optional front turnaround reference image path")
    parser.add_argument("--side-ref", help="Optional side turnaround reference image path")
    parser.add_argument("--turnaround", help="Optional combined Front(L)+Side(R) turnaround image path")
    parser.add_argument("--neck-seam-y", type=float, default=0.785, help="Vertical height where head morphs lock to zero (m)")
    parser.add_argument("--blend-height", type=float, default=0.025, help="Neck lock smoothstep transition span (m)")
    parser.add_argument("--archetypes", nargs="*", default=list(ARCHETYPE_SPECS.keys()), help="Archetype IDs to process")
    return parser.parse_args(argv)


def smoothstep(edge0: float, edge1: float, x: float) -> float:
    if edge1 <= edge0:
        return 1.0 if x > edge0 else 0.0
    t = max(0.0, min(1.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)


def load_scene(input_path: Path) -> Tuple[bpy.types.Object, bpy.types.Object | None]:
    if input_path.suffix.lower() == ".blend":
        bpy.ops.wm.open_mainfile(filepath=str(input_path))
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(input_path))

    armature = next((obj for obj in bpy.data.objects if obj.type == "ARMATURE"), None)
    body = bpy.data.objects.get("AvatarBody")
    if body is None or body.type != "MESH":
        meshes = [obj for obj in bpy.data.objects if obj.type == "MESH"]
        if not meshes:
            raise RuntimeError(f"No mesh object found in {input_path}")
        body = max(meshes, key=lambda obj: len(obj.data.vertices))
    return body, armature


def world_to_mesh_matrix(obj: bpy.types.Object) -> Matrix:
    return obj.matrix_world.inverted()


def head_metrics(body: bpy.types.Object, neck_seam_y: float, slug: str | None = None) -> Dict[str, object]:
    """Compute head-space landmarks in Blender world coordinates (Z up, -Y forward)."""
    mw = body.matrix_world
    world_verts = [mw @ v.co for v in body.data.vertices]
    head_verts = [v for v in world_verts if v.z >= neck_seam_y]
    if not head_verts:
        raise RuntimeError(f"No vertices found above neck_seam_y={neck_seam_y}")

    min_x = min(v.x for v in head_verts)
    max_x = max(v.x for v in head_verts)
    min_y = min(v.y for v in head_verts)
    max_y = max(v.y for v in head_verts)
    min_z = min(v.z for v in head_verts)
    max_z = max(v.z for v in head_verts)
    span_z = max(1e-4, max_z - neck_seam_y)

    # Anterior chin bottom (well in front of the neck column: v.y < -0.035).
    chin_candidates = [
        v for v in head_verts
        if abs(v.x) < 0.016 and v.y < -0.035 and v.z < neck_seam_y + 0.075
    ]
    if chin_candidates:
        lowest_z = min(v.z for v in chin_candidates)
        low_band = [v for v in chin_candidates if v.z <= lowest_z + 0.012]
        chin_pt = min(low_band, key=lambda v: v.y)
    else:
        chin_pt = Vector((0.0, min_y * 0.78, neck_seam_y + 0.24 * span_z))

    # Most forward nose tip above the chin.
    nose_candidates = [
        v for v in head_verts
        if abs(v.x) < 0.016 and chin_pt.z + 0.022 <= v.z <= chin_pt.z + 0.068
    ]
    nose_tip = (
        min(nose_candidates, key=lambda v: v.y)
        if nose_candidates
        else Vector((0.0, min_y, chin_pt.z + 0.040))
    )

    # Nasal bridge radix saddle just above the nose tip.
    bridge_candidates = [
        v for v in head_verts
        if abs(v.x) < 0.012 and v.y < -0.040 and nose_tip.z + 0.012 <= v.z <= nose_tip.z + 0.038
    ]
    nose_bridge = (
        max(bridge_candidates, key=lambda v: v.y)
        if bridge_candidates
        else Vector((0.0, nose_tip.y * 0.89, nose_tip.z + 0.024))
    )

    # Mouth center vertically between chin tip and nose tip.
    mouth_z_target = chin_pt.z * 0.44 + nose_tip.z * 0.56
    mouth_candidates = [
        v for v in head_verts
        if abs(v.x) < 0.012 and abs(v.z - mouth_z_target) < 0.008 and v.y < -0.045
    ]
    mouth_center = (
        min(mouth_candidates, key=lambda v: v.y)
        if mouth_candidates
        else Vector((0.0, nose_tip.y * 0.85, mouth_z_target))
    )

    # Eye socket ellipsoid center & radii (rx, ry_up, rz_fwd) calibrated to STUDIO_EYE_FITS when slug is known.
    calibrated_eye = STUDIO_EYE_FITS_BLENDER.get(slug or "")
    if calibrated_eye is not None:
        eye_left = Vector(calibrated_eye[0])
        eye_radii = tuple(float(c) for c in calibrated_eye[1])
        eye_shear_z = float(calibrated_eye[2])
        eye_shear_y = float(calibrated_eye[3])
        eye_back_depth_scale = float(calibrated_eye[4])
    else:
        eye_band = [
            v for v in head_verts
            if 0.010 <= v.x <= 0.052 and v.y < -0.042 and nose_tip.z + 0.006 <= v.z <= nose_tip.z + 0.058
        ]
        if eye_band:
            eye_x = (min(v.x for v in eye_band) + max(v.x for v in eye_band)) * 0.5
            eye_z = (min(v.z for v in eye_band) + max(v.z for v in eye_band)) * 0.52
            eye_y = sum(v.y for v in eye_band) / len(eye_band)
            eye_left = Vector((eye_x, eye_y, eye_z))
        else:
            eye_left = Vector((0.030, nose_tip.y * 0.80, nose_tip.z + 0.030))
        eye_radii = (0.020, 0.020, 0.015)
        eye_shear_z = 0.0
        eye_shear_y = 0.0
        eye_back_depth_scale = 1.0

    # Cranium width measured above ears.
    cranium_verts = [v for v in head_verts if v.z >= eye_left.z + 0.022]
    cranium_half_w = max((abs(v.x) for v in cranium_verts), default=0.064)
    center = Vector(((min_x + max_x) * 0.5, (min_y + max_y) * 0.5, eye_left.z + 0.025))

    # Ears protruding laterally around eye/nose band.
    ear_candidates = [
        v for v in head_verts
        if v.x > cranium_half_w + 0.002 and nose_tip.z - 0.012 <= v.z <= eye_left.z + 0.022
    ]
    if ear_candidates:
        ear_left = Vector((
            sum(v.x for v in ear_candidates) / len(ear_candidates),
            sum(v.y for v in ear_candidates) / len(ear_candidates),
            sum(v.z for v in ear_candidates) / len(ear_candidates),
        ))
    else:
        ear_left = Vector((max_x * 0.90, center.y + 0.006, nose_tip.z + 0.020))

    brow_z = eye_left.z + 0.024
    landmarks_world = {
        "crown": Vector((0.0, center.y, max_z)),
        "forehead": Vector((0.0, nose_bridge.y * 0.96, eye_left.z + 0.044)),
        "browInner": Vector((eye_left.x * 0.52, nose_bridge.y * 0.98, brow_z)),
        "browOuter": Vector((eye_left.x * 1.48, eye_left.y * 0.92, brow_z)),
        "eyeLeft": eye_left.copy(),
        "eyeRight": Vector((-eye_left.x, eye_left.y, eye_left.z)),
        "noseBridge": nose_bridge.copy(),
        "noseTip": nose_tip.copy(),
        "noseWing": Vector((0.013, nose_tip.y * 0.88, nose_tip.z - 0.004)),
        "cheekbone": Vector((cranium_half_w * 0.78, eye_left.y * 0.94, nose_tip.z + 0.006)),
        "cheek": Vector((cranium_half_w * 0.64, mouth_center.y * 0.90, mouth_center.z + 0.006)),
        "mouthCenter": mouth_center.copy(),
        "mouthCorner": Vector((0.017, mouth_center.y * 0.90, mouth_center.z)),
        "chin": chin_pt.copy(),
        "jawAngle": Vector((cranium_half_w * 0.72, chin_pt.y * 0.30, chin_pt.z + 0.014)),
        "earLeft": ear_left.copy(),
        "earRight": Vector((-ear_left.x, ear_left.y, ear_left.z)),
    }

    return {
        "world_verts": world_verts,
        "min": Vector((min_x, min_y, min_z)),
        "max": Vector((max_x, max_y, max_z)),
        "span_z": span_z,
        "cranium_half_w": cranium_half_w,
        "eye_radii": eye_radii,
        "eye_radius": eye_radii[1],
        "eye_shear_z": eye_shear_z,
        "eye_shear_y": eye_shear_y,
        "eye_back_depth_scale": eye_back_depth_scale,
        "center": center,
        "landmarks": landmarks_world,
    }


def build_weld_clusters(world_verts: Sequence[Vector], eps: float = 1.5e-5) -> Tuple[List[int], List[List[int]]]:
    """Group split UV/normal seam vertices at identical XYZ into canonical clusters."""
    n = len(world_verts)
    kd = KDTree(n)
    for idx, v in enumerate(world_verts):
        kd.insert(v, idx)
    kd.balance()

    cluster_of = [-1] * n
    clusters: List[List[int]] = []
    for idx, v in enumerate(world_verts):
        if cluster_of[idx] != -1:
            continue
        cid = len(clusters)
        members = [m_idx for (_, m_idx, _) in kd.find_range(v, eps)]
        for m_idx in members:
            cluster_of[m_idx] = cid
        clusters.append(members)
    return cluster_of, clusters


def compute_region_weights(
    world_verts: Sequence[Vector],
    metrics: Dict[str, object],
    neck_seam_y: float,
    blend_height: float,
) -> Tuple[List[float], Dict[str, List[float]]]:
    landmarks: Dict[str, Vector] = metrics["landmarks"]  # type: ignore[assignment]
    center: Vector = metrics["center"]  # type: ignore[assignment]
    cranium_half_w: float = metrics["cranium_half_w"]  # type: ignore[assignment]

    neck_lock: List[float] = []
    regions: Dict[str, List[float]] = {rid: [] for rid in REGION_IDS}

    def gauss(p: Vector, target: Vector, sigma: float, mirror_x: bool = False) -> float:
        px = abs(p.x) if mirror_x else p.x
        tx = abs(target.x) if mirror_x else target.x
        dx = px - tx
        dy = p.y - target.y
        dz = p.z - target.z
        return math.exp(-(dx * dx + dy * dy + dz * dz) / max(sigma * sigma, 1e-8))

    for v in world_verts:
        lock = smoothstep(neck_seam_y, neck_seam_y + blend_height, v.z)
        neck_lock.append(lock)
        if lock == 0.0:
            for rid in REGION_IDS:
                regions[rid].append(0.0)
            continue

        w_nose = max(
            gauss(v, landmarks["noseTip"], 0.015),
            gauss(v, landmarks["noseBridge"], 0.014),
            gauss(v, landmarks["noseWing"], 0.013, mirror_x=True),
        )
        w_mouth = max(
            gauss(v, landmarks["mouthCenter"], 0.015),
            gauss(v, landmarks["mouthCorner"], 0.015, mirror_x=True),
        ) * (1.0 - smoothstep(landmarks["noseTip"].z - 0.008, landmarks["noseTip"].z + 0.004, v.z))
        w_brows_eyes = max(
            gauss(v, landmarks["eyeLeft"], 0.023, mirror_x=True),
            gauss(v, landmarks["browInner"], 0.019, mirror_x=True),
            gauss(v, landmarks["browOuter"], 0.021, mirror_x=True),
        )
        w_cheeks = max(
            gauss(v, landmarks["cheekbone"], 0.022, mirror_x=True),
            gauss(v, landmarks["cheek"], 0.021, mirror_x=True),
        )
        w_jaw = max(
            gauss(v, landmarks["chin"], 0.022),
            gauss(v, landmarks["jawAngle"], 0.028, mirror_x=True),
        ) * (1.0 - smoothstep(landmarks["mouthCenter"].z + 0.004, landmarks["noseTip"].z + 0.012, v.z))
        w_ears = gauss(v, landmarks["earLeft"], 0.025, mirror_x=True) * smoothstep(
            cranium_half_w - 0.006, cranium_half_w + 0.010, abs(v.x)
        )
        w_cranium = smoothstep(landmarks["browInner"].z - 0.005, landmarks["forehead"].z + 0.022, v.z)
        if v.y > center.y + 0.005 and v.z >= landmarks["earLeft"].z - 0.025:
            w_cranium = max(w_cranium, 0.90)

        raw = {
            "cranium": w_cranium,
            "brows_eyes": w_brows_eyes,
            "nose": w_nose,
            "cheeks": w_cheeks,
            "mouth": w_mouth,
            "jaw_chin": w_jaw,
            "ears": w_ears,
        }
        total = sum(raw.values())
        peak = max(raw.values())
        if total > 1e-5:
            # Blend partition preserving core amplitude up to `peak` so regions aren't crushed < 0.5.
            scale = min(1.0, max(peak, 0.0) / total) if total > 1.0 else 1.0
            for rid in REGION_IDS:
                regions[rid].append(raw[rid] * scale * lock)
        else:
            for rid in REGION_IDS:
                regions[rid].append(0.0)

    return neck_lock, regions


def ensure_vertex_group(obj: bpy.types.Object, name: str, weights: Sequence[float]) -> None:
    group = obj.vertex_groups.get(name)
    if group is None:
        group = obj.vertex_groups.new(name=name)
    for idx, w in enumerate(weights):
        if w > 1e-4:
            group.add([idx], float(w), "REPLACE")
        else:
            group.remove([idx])


def populate_head_groups(
    body: bpy.types.Object,
    neck_seam_y: float,
    blend_height: float,
    slug: str | None = None,
) -> Tuple[Dict[str, object], List[float], Dict[str, List[float]]]:
    metrics = head_metrics(body, neck_seam_y, slug=slug)
    neck_lock, regions = compute_region_weights(
        metrics["world_verts"], metrics, neck_seam_y, blend_height  # type: ignore[arg-type]
    )
    ensure_vertex_group(body, "neck_lock", neck_lock)
    ensure_vertex_group(body, "seam.neck", [1.0 if 0.0 < w < 0.25 else 0.0 for w in neck_lock])
    for rid, weights in regions.items():
        ensure_vertex_group(body, rid, weights)
    return metrics, neck_lock, regions


def add_reference_empty(
    name: str,
    image_path: Path,
    location: Vector,
    rotation_euler: Tuple[float, float, float],
    size: float,
    crop_half: str | None = None,
) -> bpy.types.Object:
    existing = bpy.data.objects.get(name)
    if existing is not None:
        bpy.data.objects.remove(existing, do_unlink=True)

    image = bpy.data.images.load(str(image_path), check_existing=True)
    empty = bpy.data.objects.new(name, None)
    empty.empty_display_type = "IMAGE"
    empty.data = image
    empty.empty_display_size = size
    empty.use_empty_image_alpha = True
    empty.color = (1.0, 1.0, 1.0, 0.55)
    empty.location = location
    empty.rotation_euler = Euler(rotation_euler, "XYZ")
    if crop_half == "left":
        empty.empty_image_offset = (-0.25, -0.5)
    elif crop_half == "right":
        empty.empty_image_offset = (-0.75, -0.5)
    bpy.context.collection.objects.link(empty)
    return empty


def mode_setup_refs(args: argparse.Namespace) -> None:
    body, _ = load_scene(Path(args.input))
    metrics, _, _ = populate_head_groups(body, args.neck_seam_y, args.blend_height)
    head_min: Vector = metrics["min"]  # type: ignore[assignment]
    head_max: Vector = metrics["max"]  # type: ignore[assignment]
    head_height = max(0.15, head_max.z - args.neck_seam_y)
    head_center_z = args.neck_seam_y + head_height * 0.5

    if args.turnaround:
        path = Path(args.turnaround).resolve()
        add_reference_empty(
            "FrontRef",
            path,
            Vector((0.0, head_max.y + 0.08, head_center_z)),
            (math.pi / 2.0, 0.0, 0.0),
            head_height * 1.35,
            crop_half="left",
        )
        add_reference_empty(
            "SideRef",
            path,
            Vector((head_min.x - 0.08, 0.0, head_center_z)),
            (math.pi / 2.0, 0.0, -math.pi / 2.0),
            head_height * 1.35,
            crop_half="right",
        )
    if args.front_ref:
        add_reference_empty(
            "FrontRef",
            Path(args.front_ref).resolve(),
            Vector((0.0, head_max.y + 0.08, head_center_z)),
            (math.pi / 2.0, 0.0, 0.0),
            head_height * 1.35,
        )
    if args.side_ref:
        add_reference_empty(
            "SideRef",
            Path(args.side_ref).resolve(),
            Vector((head_min.x - 0.08, 0.0, head_center_z)),
            (math.pi / 2.0, 0.0, -math.pi / 2.0),
            head_height * 1.35,
        )

    if args.blend_out:
        out_path = Path(args.blend_out).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=str(out_path))


def ensure_basis_shape_key(body: bpy.types.Object) -> bpy.types.Key:
    if body.data.shape_keys is None:
        body.shape_key_add(name="Basis", from_mix=False)
    return body.data.shape_keys


def laplacian_smooth_deltas(
    mesh: bpy.types.Mesh,
    deltas: List[Vector],
    mask: Sequence[float],
    cluster_of: Sequence[int],
    clusters: Sequence[Sequence[int]],
    preserve_mask: Sequence[float] | None = None,
    passes: int = 3,
    factor: float = 0.36,
) -> List[Vector]:
    """Laplacian smoothing over UV/normal-welded spatial clusters so seams never crack."""
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.verts.ensure_lookup_table()
    cluster_neighbors: List[set[int]] = [set() for _ in range(len(clusters))]
    for v in bm.verts:
        c = cluster_of[v.index]
        for e in v.link_edges:
            nc = cluster_of[e.other_vert(v).index]
            if nc != c:
                cluster_neighbors[c].add(nc)
    bm.free()

    cluster_mask = [max(mask[m] for m in members) for members in clusters]
    cluster_preserve = (
        [max(preserve_mask[m] for m in members) for members in clusters]
        if preserve_mask is not None
        else [0.0] * len(clusters)
    )
    current = []
    for members in clusters:
        avg_d = Vector((0.0, 0.0, 0.0))
        for m in members:
            avg_d += deltas[m]
        current.append((avg_d / len(members)) if members else avg_d)

    for _ in range(passes):
        nxt = [d.copy() for d in current]
        for c, nbrs in enumerate(cluster_neighbors):
            if cluster_mask[c] <= 0.0 or not nbrs:
                continue
            avg = Vector((0.0, 0.0, 0.0))
            for nc in nbrs:
                avg += current[nc]
            avg /= len(nbrs)
            local_factor = factor * (1.0 - 0.30 * cluster_preserve[c])
            nxt[c] = current[c].lerp(avg, local_factor) * cluster_mask[c]
        current = nxt

    return [current[cluster_of[idx]].copy() for idx in range(len(deltas))]


def build_archetype_deltas(
    body: bpy.types.Object,
    metrics: Dict[str, object],
    neck_lock: Sequence[float],
    spec: Dict[str, object],
    cluster_of: Sequence[int],
    clusters: Sequence[Sequence[int]],
) -> List[Vector]:
    world_verts: Sequence[Vector] = metrics["world_verts"]  # type: ignore[assignment]
    center: Vector = metrics["center"]  # type: ignore[assignment]
    landmarks: Dict[str, Vector] = metrics["landmarks"]  # type: ignore[assignment]
    cranium_half_w: float = metrics["cranium_half_w"]  # type: ignore[assignment]
    eye_radii_raw = metrics.get("eye_radii")
    if isinstance(eye_radii_raw, (tuple, list)) and len(eye_radii_raw) >= 3:
        eye_radii: Tuple[float, float, float] = (
            float(eye_radii_raw[0]),
            float(eye_radii_raw[1]),
            float(eye_radii_raw[2]),
        )
    else:
        fallback_r = float(metrics.get("eye_radius", 0.020))  # type: ignore[arg-type]
        eye_radii = (fallback_r, fallback_r, fallback_r * 0.75)
    r0 = eye_radii[1]
    rx_eye = max(eye_radii[0], 1e-4)
    ry_eye = max(r0, 1e-4)
    rz_eye = max(eye_radii[2], 1e-4)
    eye_shear_z = float(metrics.get("eye_shear_z", 0.0))  # type: ignore[arg-type]
    eye_shear_y = float(metrics.get("eye_shear_y", 0.0))  # type: ignore[arg-type]
    eye_back_scale = max(1.0, float(metrics.get("eye_back_depth_scale", 1.0)))  # type: ignore[arg-type]
    mw_inv = world_to_mesh_matrix(body)
    rot_inv = mw_inv.to_3x3()

    cranium_cfg: Dict[str, Sequence[float]] = spec["cranium"]  # type: ignore[assignment]
    eye_cfg: Dict[str, object] = spec["brows_eyes"]  # type: ignore[assignment]
    nose_cfg: Dict[str, float] = spec["nose"]  # type: ignore[assignment]
    cheek_cfg: Dict[str, float] = spec["cheeks"]  # type: ignore[assignment]
    mouth_cfg: Dict[str, float] = spec["mouth"]  # type: ignore[assignment]
    jaw_cfg: Dict[str, float] = spec["jaw_chin"]  # type: ignore[assignment]
    ear_cfg: Dict[str, float] = spec["ears"]  # type: ignore[assignment]

    sx, sy, sz = cranium_cfg["scale"]
    ox, oy, oz = cranium_cfg["offset"]
    upper_lid_amt = float(eye_cfg["upper_lid"])  # type: ignore[arg-type]
    lower_lid_amt = float(eye_cfg["lower_lid"])  # type: ignore[arg-type]
    eye_tilt_amt = float(eye_cfg["eye_tilt"])  # type: ignore[arg-type]
    socket_width_amt = float(eye_cfg["socket_width"])  # type: ignore[arg-type]
    socket_depth_amt = float(eye_cfg["socket_depth"])  # type: ignore[arg-type]
    brow_z = float(eye_cfg["brow_z"])  # type: ignore[arg-type]
    brow_fwd = float(eye_cfg.get("brow_fwd", 0.0))  # type: ignore[arg-type]
    lid_fold = float(eye_cfg["lid_fold"])  # type: ignore[arg-type]
    ear_scale = float(ear_cfg["scale"])

    def gauss(p: Vector, target: Vector, sigma: float, mirror_x: bool = False) -> float:
        px = abs(p.x) if mirror_x else p.x
        tx = abs(target.x) if mirror_x else target.x
        dx = px - tx
        dy = p.y - target.y
        dz = p.z - target.z
        return math.exp(-(dx * dx + dy * dy + dz * dz) / max(sigma * sigma, 1e-8))

    eye_ref = landmarks["eyeLeft"]
    ear_ref = landmarks["earLeft"]
    chin_ref = landmarks["chin"]
    mouth_ref = landmarks["mouthCenter"]
    nose_tip_ref = landmarks["noseTip"]
    nose_bridge_ref = landmarks["noseBridge"]

    def sheared_eye_coords(p: Vector) -> Tuple[float, float, float, float, float]:
        side_sign = 1.0 if p.x >= 0.0 else -1.0
        nx = (side_sign * p.x - eye_ref.x) / rx_eye
        ny_up = (p.z - eye_ref.z) / ry_eye
        qz_eff_fwd = (-(p.y - eye_ref.y)) - nx * eye_shear_z - ny_up * eye_shear_y
        rz_eff = rz_eye if qz_eff_fwd >= 0.0 else rz_eye * eye_back_scale
        nz_fwd = qz_eff_fwd / max(rz_eff, 1e-4)
        return side_sign, nx, ny_up, nz_fwd, math.sqrt(nx * nx + ny_up * ny_up + nz_fwd * nz_fwd)

    def sheared_eye_to_world(
        side_sign: float, nx: float, ny_up: float, nz_fwd: float
    ) -> Vector:
        rz_eff = rz_eye if nz_fwd >= 0.0 else rz_eye * eye_back_scale
        py_fwd = nx * eye_shear_z + ny_up * eye_shear_y + nz_fwd * rz_eff
        return Vector((
            side_sign * (eye_ref.x + nx * rx_eye),
            eye_ref.y - py_fwd,
            eye_ref.z + ny_up * ry_eye,
        ))

    world_deltas: List[Vector] = []
    lid_preserve: List[float] = []
    for idx, p in enumerate(world_verts):
        lock = neck_lock[idx]
        if lock == 0.0:
            world_deltas.append(Vector((0.0, 0.0, 0.0)))
            lid_preserve.append(0.0)
            continue

        # Smooth midline sign eliminates bilateral seam discontinuities at x ≈ 0.
        smooth_sign_x = max(-1.0, min(1.0, p.x / 0.004))
        hard_sign_x = 1.0 if p.x >= 0.0 else -1.0
        d = Vector((0.0, 0.0, 0.0))

        # 1. Cranium (keep ear silhouette scaled in its own field with wide smooth blend)
        not_ear = 1.0 - smoothstep(cranium_half_w - 0.008, cranium_half_w + 0.012, abs(p.x)) * gauss(
            p, ear_ref, 0.034, mirror_x=True
        )
        k_cranium = max(
            smoothstep(eye_ref.z - 0.020, eye_ref.z + 0.045, p.z),
            0.90 * smoothstep(center.y - 0.008, center.y + 0.028, p.y)
            * smoothstep(chin_ref.z - 0.01, chin_ref.z + 0.025, p.z),
        ) * not_ear
        if k_cranium > 0.0:
            d.x += ((p.x - center.x) * (sx - 1.0) + ox * smooth_sign_x) * k_cranium
            d.y += ((p.y - center.y) * (sy - 1.0) + oy) * k_cranium
            d.z += ((p.z - center.z) * (sz - 1.0) + oz) * k_cranium

        # 2. Eyes & Brows (sheared-ellipsoid eyeball-hugging socket sculpt with inner-canthus feathering)
        front_face = smoothstep(0.016, 0.042, -p.y)
        side_sign, nx_eye, ny_eye, nz_eye, r_sheared = sheared_eye_coords(p)
        midline_guard = smoothstep(0.004, 0.012, abs(p.x))
        front_eye = smoothstep(-0.35, 0.15, nz_eye)
        lids = (
            smoothstep(0.75, 0.95, r_sheared)
            * (1.0 - smoothstep(1.45, 2.00, r_sheared))
            * front_eye
            * midline_guard
        )
        canthus_taper = smoothstep(-0.92, -0.25, nx_eye)
        lid_preserve.append(lids * canthus_taper)
        dnx_eye = 0.0
        dny_eye = 0.0
        dnz_eye = 0.0
        if lids > 1e-4:
            upper_mask = smoothstep(-0.08, 0.28, ny_eye) * (1.0 - smoothstep(1.05, 1.45, ny_eye))
            lower_mask = (1.0 - smoothstep(-0.28, 0.08, ny_eye)) * smoothstep(-1.45, -1.05, ny_eye)
            a_vert = lids * canthus_taper * (upper_lid_amt * upper_mask + lower_lid_amt * lower_mask)
            dny_eye += nz_eye * a_vert
            dnz_eye += -ny_eye * a_vert

            outer_tilt_band = smoothstep(-0.55, 0.65, nx_eye)
            a_tilt = eye_tilt_amt * lids * outer_tilt_band
            dnx_t = -ny_eye * a_tilt * 0.45
            dny_t = max(0.0, nx_eye + 0.55) * a_tilt
            dnz_t = -(nx_eye * dnx_t + ny_eye * dny_t) / max(nz_eye, 0.30)
            dnx_eye += dnx_t
            dny_eye += dny_t
            dnz_eye += dnz_t

            outer_band = smoothstep(-0.15, 0.75, nx_eye)
            a_width = (socket_width_amt / rx_eye) * outer_band * lids
            dnx_eye += nz_eye * a_width
            dnz_eye += -nx_eye * a_width

        if front_eye > 1e-4 and abs(lid_fold) > 1e-6:
            g_fold = (
                math.exp(
                    -((nx_eye - 0.08) ** 2 / (0.85 * 0.85) + (ny_eye - 0.68) ** 2 / (0.46 * 0.46))
                )
                * front_eye
                * canthus_taper
                * midline_guard
            )
            drop_a = (
                -(lid_fold / ry_eye)
                * g_fold
                * smoothstep(0.80, 0.98, r_sheared)
                * (1.0 - smoothstep(1.50, 2.00, r_sheared))
            )
            dny_eye += nz_eye * drop_a
            dnz_eye += -ny_eye * drop_a + (lid_fold / rz_eye) * 0.9 * g_fold * smoothstep(
                1.14, 1.34, r_sheared
            ) * (1.0 - smoothstep(1.65, 2.15, r_sheared))

        if front_eye > 1e-4 and abs(socket_depth_amt) > 1e-6:
            ring = (
                smoothstep(1.20, 1.44, r_sheared)
                * (1.0 - smoothstep(1.90, 2.50, r_sheared))
                * front_eye
                * midline_guard
            )
            dnz_eye += (socket_depth_amt / rz_eye) * ring

        if dnx_eye != 0.0 or dny_eye != 0.0 or dnz_eye != 0.0:
            d.x += side_sign * dnx_eye * rx_eye
            d.z += dny_eye * ry_eye
            d.y -= dnx_eye * eye_shear_z + dny_eye * eye_shear_y + dnz_eye * rz_eye

        g_brow_inner = gauss(p, landmarks["browInner"], 0.020, mirror_x=True) * front_face
        g_brow_outer = gauss(p, landmarks["browOuter"], 0.024, mirror_x=True) * front_face
        k_brow = max(g_brow_inner, g_brow_outer)
        if k_brow > 0.0:
            brow_z_weight = max(0.45 * g_brow_inner, 1.0 * g_brow_outer)
            d.z += brow_z * brow_z_weight
            d.y -= brow_fwd * k_brow

        # 3. Nose (glabella bridge -> nasal tip -> smooth proportional alar wings)
        k_nose = max(
            gauss(p, nose_tip_ref, 0.018),
            gauss(p, nose_bridge_ref, 0.017),
            gauss(p, landmarks["noseWing"], 0.018, mirror_x=True),
        ) * front_face
        if k_nose > 0.0:
            tip_band = 1.0 - smoothstep(0.005, 0.019, abs(p.x))
            bridge_band = smoothstep(nose_tip_ref.z + 0.004, nose_bridge_ref.z + 0.010, p.z)
            d.x += (p.x / 0.014) * nose_cfg["wing_x"] * k_nose * (1.0 - smoothstep(0.018, 0.032, abs(p.x)))
            d.y -= (
                nose_cfg["bridge_fwd"] * bridge_band
                + nose_cfg["tip_fwd"] * tip_band * (1.0 - bridge_band)
            ) * k_nose
            d.z += nose_cfg["tip_z"] * tip_band * k_nose

        # 4. Cheeks & Zygoma
        k_cheek = max(
            gauss(p, landmarks["cheekbone"], 0.024, mirror_x=True),
            gauss(p, landmarks["cheek"], 0.022, mirror_x=True),
        ) * smoothstep(0.018, 0.036, abs(p.x)) * smoothstep(0.010, 0.036, -p.y)
        if k_cheek > 0.0:
            upper_cheek = smoothstep(mouth_ref.z + 0.004, eye_ref.z - 0.008, p.z)
            d.x += smooth_sign_x * cheek_cfg["cheekbone_x"] * upper_cheek * k_cheek
            full_mask = (1.0 - 0.85 * upper_cheek) if cheek_cfg["fullness_fwd"] < 0.0 else (1.0 - 0.35 * upper_cheek)
            d.y -= cheek_cfg["fullness_fwd"] * full_mask * k_cheek

        # 5. Mouth & Lips (proportional horizontal width avoids vertical philtrum creases)
        k_mouth = max(
            gauss(p, mouth_ref, 0.020),
            gauss(p, landmarks["mouthCorner"], 0.020, mirror_x=True),
        ) * front_face * (1.0 - smoothstep(nose_tip_ref.z - 0.010, nose_tip_ref.z, p.z))
        if k_mouth > 0.0:
            center_band = 1.0 - smoothstep(0.005, 0.019, abs(p.x))
            d.x += (p.x / 0.018) * mouth_cfg["width_x"] * k_mouth * (1.0 - smoothstep(0.024, 0.038, abs(p.x)))
            d.y -= mouth_cfg["lip_fullness"] * center_band * k_mouth

        # 6. Jaw & Chin (strictly below the lower lip so chin_z never lifts mouth corners into a frown)
        k_jaw = max(
            gauss(p, chin_ref, 0.028),
            gauss(p, landmarks["jawAngle"], 0.036, mirror_x=True),
        ) * (1.0 - smoothstep(mouth_ref.z - 0.014, mouth_ref.z - 0.002, p.z)) * smoothstep(
            0.008, 0.030, -p.y
        )
        if k_jaw > 0.0:
            chin_band = 1.0 - smoothstep(0.008, 0.030, abs(p.x))
            jaw_band = smoothstep(0.014, 0.044, abs(p.x))
            d.x += smooth_sign_x * jaw_cfg["jaw_x"] * jaw_band * k_jaw
            d.y -= jaw_cfg["chin_fwd"] * chin_band * k_jaw
            d.z += jaw_cfg["chin_z"] * chin_band * k_jaw

        # 7. Ears
        k_ear = gauss(p, ear_ref, 0.026, mirror_x=True) * smoothstep(
            cranium_half_w - 0.005, cranium_half_w + 0.009, abs(p.x)
        )
        if k_ear > 0.0:
            ear_anchor = Vector((ear_ref.x * hard_sign_x, ear_ref.y, ear_ref.z))
            d += (p - ear_anchor) * (ear_scale - 1.0) * k_ear

        world_deltas.append(d * lock)

    smoothed_world = laplacian_smooth_deltas(
        body.data, world_deltas, neck_lock, cluster_of, clusters, preserve_mask=lid_preserve, passes=3, factor=0.36
    )

    # Prevent post-smoothing head/brow/nose sculpt deltas from dipping any orbital vertex inside the sheared procedural eye ellipsoid.
    guarded_world: List[Vector] = []
    for idx, p in enumerate(world_verts):
        dw = smoothed_world[idx]
        if neck_lock[idx] > 0.0 and dw.length_squared > 1e-12:
            side_sign, _bx, _by_up, bz_fwd, r_base = sheared_eye_coords(p)
            if 0.92 <= r_base <= 1.9 and bz_fwd > -0.40:
                p2 = p + dw
                _, ax, ay_up, az_fwd, r_after = sheared_eye_coords(p2)
                r_min = min(r_base, 0.992)
                if 1e-5 < r_after < r_min:
                    s = r_min / r_after
                    fixed = sheared_eye_to_world(side_sign, ax * s, ay_up * s, az_fwd * s)
                    dw = (fixed - p) * neck_lock[idx]
        guarded_world.append(dw)

    return [rot_inv @ d for d in guarded_world]


def mode_sculpt_presets(args: argparse.Namespace) -> None:
    body, _ = load_scene(Path(args.input))
    metrics, neck_lock, regions = populate_head_groups(body, args.neck_seam_y, args.blend_height, slug=infer_slug(args))
    cluster_of, clusters = build_weld_clusters(metrics["world_verts"])  # type: ignore[arg-type]
    shape_keys = ensure_basis_shape_key(body)
    basis = shape_keys.key_blocks["Basis"]

    for archetype_id in args.archetypes:
        spec = ARCHETYPE_SPECS.get(archetype_id)
        if spec is None:
            raise ValueError(f"Unknown archetype preset '{archetype_id}'")
        key_name = f"HeadArchetype_{archetype_id}"
        existing = shape_keys.key_blocks.get(key_name)
        if existing is not None:
            body.shape_key_remove(existing)
        key = body.shape_key_add(name=key_name, from_mix=False)
        key.value = 0.0
        deltas = build_archetype_deltas(body, metrics, neck_lock, spec, cluster_of, clusters)
        for idx, delta in enumerate(deltas):
            key.data[idx].co = basis.data[idx].co + delta

    if args.blend_out:
        out_path = Path(args.blend_out).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=str(out_path))

    if args.json_out or args.glb_out or args.render_dir:
        export_and_render(body, metrics, regions, args)


def blender_vec_to_gltf(v: Vector) -> Tuple[float, float, float]:
    """Convert Blender (+Z up, -Y forward) vector delta into glTF (+Y up, +Z forward) coordinates."""
    return (round(float(v.x), 6), round(float(v.z), 6), round(float(-v.y), 6))


def setup_render_studio(
    metrics: Dict[str, object],
    neck_seam_y: float,
    render_engine: str = "CYCLES",
) -> Tuple[bpy.types.Camera, bpy.types.Object]:
    scene = bpy.context.scene
    engines = {item.identifier for item in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items}
    if render_engine in engines:
        scene.render.engine = render_engine
    elif "CYCLES" in engines:
        scene.render.engine = "CYCLES"
    elif "BLENDER_EEVEE_NEXT" in engines:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    else:
        scene.render.engine = "BLENDER_EEVEE"

    if scene.render.engine == "CYCLES":
        scene.cycles.device = "CPU"
        scene.cycles.samples = 16
        scene.cycles.use_denoising = False

    scene.render.resolution_x = 384
    scene.render.resolution_y = 384
    scene.render.film_transparent = False
    if scene.world is None:
        scene.world = bpy.data.worlds.new("StudioWorld")
    if hasattr(scene.world, "use_nodes") and not scene.world.use_nodes:
        scene.world.use_nodes = True
    if scene.world.node_tree:
        bg = scene.world.node_tree.nodes.get("Background")
        if bg:
            bg.inputs[0].default_value = (0.20, 0.21, 0.24, 1.0)
            bg.inputs[1].default_value = 0.70

    def add_light(name: str, energy: float, loc: Tuple[float, float, float]) -> None:
        obj = bpy.data.objects.get(name)
        if obj is None:
            data = bpy.data.lights.new(name=name, type="AREA")
            obj = bpy.data.objects.new(name=name, object_data=data)
            bpy.context.collection.objects.link(obj)
        obj.data.energy = energy
        obj.data.size = 0.8
        obj.location = loc
        direction = Vector((0.0, 0.0, neck_seam_y + 0.11)) - obj.location
        obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

    add_light("KeyLight", 28.0, (0.55, -0.85, neck_seam_y + 0.35))
    add_light("FillLight", 11.0, (-0.75, -0.65, neck_seam_y + 0.10))
    add_light("RimLight", 18.0, (0.0, 0.85, neck_seam_y + 0.35))

    cam_obj = bpy.data.objects.get("ArchetypeQACamera")
    if cam_obj is None:
        cam_data = bpy.data.cameras.new("ArchetypeQACamera")
        cam_obj = bpy.data.objects.new("ArchetypeQACamera", cam_data)
        bpy.context.collection.objects.link(cam_obj)
    cam_obj.data.type = "ORTHO"
    head_max: Vector = metrics["max"]  # type: ignore[assignment]
    head_height = max(0.16, head_max.z - neck_seam_y)
    cam_obj.data.ortho_scale = head_height * 1.35
    scene.camera = cam_obj
    return cam_obj.data, cam_obj


def apply_qa_clay_material(body: bpy.types.Object) -> None:
    """Apply a neutral smooth studio clay shader strictly for QA renders."""
    mat = bpy.data.materials.get("StudioQAClay")
    if mat is None:
        mat = bpy.data.materials.new("StudioQAClay")
        if hasattr(mat, "use_nodes") and not mat.use_nodes:
            mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF") if mat.node_tree else None
        if bsdf:
            bsdf.inputs["Base Color"].default_value = (0.72, 0.56, 0.48, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.50
            if "Specular IOR Level" in bsdf.inputs:
                bsdf.inputs["Specular IOR Level"].default_value = 0.35
    body.data.materials.clear()
    body.data.materials.append(mat)
    for poly in body.data.polygons:
        poly.use_smooth = True


def infer_slug(args: argparse.Namespace) -> str:
    if args.slug:
        return str(args.slug)
    stem = Path(args.input).stem.lower()
    if "female" in stem:
        return "female"
    if "male" in stem:
        return "male"
    return "custom"


def export_and_render(
    body: bpy.types.Object,
    metrics: Dict[str, object],
    regions: Dict[str, List[float]],
    args: argparse.Namespace,
) -> None:
    shape_keys = body.data.shape_keys
    if shape_keys is None:
        raise RuntimeError("Input mesh has no shape keys to export")

    basis = shape_keys.key_blocks["Basis"]
    world_verts: Sequence[Vector] = metrics["world_verts"]  # type: ignore[assignment]
    landmarks: Dict[str, Vector] = metrics["landmarks"]  # type: ignore[assignment]
    rot_world = body.matrix_world.to_3x3()

    kd = KDTree(len(world_verts))
    for i, v in enumerate(world_verts):
        kd.insert(v, i)
    kd.balance()

    landmark_vertex = {name: kd.find(pos)[1] for name, pos in landmarks.items()}

    definitions: List[Dict[str, object]] = []
    for key in shape_keys.key_blocks:
        if not key.name.startswith("HeadArchetype_"):
            continue
        archetype_id = key.name[len("HeadArchetype_") :]
        spec = ARCHETYPE_SPECS.get(archetype_id, {})

        vertex_indices: List[int] = []
        deltas: List[float] = []
        world_deltas: List[Vector] = []
        for idx in range(len(basis.data)):
            local_delta = key.data[idx].co - basis.data[idx].co
            world_delta = rot_world @ local_delta
            world_deltas.append(world_delta)
            if world_delta.length > 1e-6:
                gx, gy, gz = blender_vec_to_gltf(world_delta)
                vertex_indices.append(idx)
                deltas.extend([gx, gy, gz])

        landmark_deltas = {
            lm_name: list(blender_vec_to_gltf(world_deltas[v_idx]))
            for lm_name, v_idx in landmark_vertex.items()
        }

        definitions.append(
            {
                "id": archetype_id,
                "label": spec.get("label", archetype_id),
                "targetName": key.name,
                "vertexIndices": vertex_indices,
                "deltas": deltas,
                "landmarkDeltas": landmark_deltas,
            }
        )

    if args.json_out:
        json_path = Path(args.json_out).resolve()
        json_path.parent.mkdir(parents=True, exist_ok=True)
        pack = {
            "version": 1,
            "slug": infer_slug(args),
            "vertexCount": len(basis.data),
            "neckSeamY": round(float(args.neck_seam_y), 6),
            "blendHeight": round(float(args.blend_height), 6),
            "regionWeights": {
                rid: [round(w, 4) for w in weights]
                for rid, weights in regions.items()
            },
            "archetypes": definitions,
        }
        json_path.write_text(json.dumps(pack, separators=(",", ":")))

    if args.glb_out:
        glb_path = Path(args.glb_out).resolve()
        glb_path.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.export_scene.gltf(
            filepath=str(glb_path),
            export_format="GLB",
            use_selection=False,
            export_morph=True,
        )

    if args.render_dir:
        render_dir = Path(args.render_dir).resolve()
        render_dir.mkdir(parents=True, exist_ok=True)
        apply_qa_clay_material(body)
        _, cam_obj = setup_render_studio(metrics, args.neck_seam_y, args.render_engine)
        head_max: Vector = metrics["max"]  # type: ignore[assignment]
        center_z = args.neck_seam_y + max(0.16, head_max.z - args.neck_seam_y) * 0.5

        for k in shape_keys.key_blocks:
            if k.name != "Basis":
                k.value = 0.0

        targets = [("basis", None)] + [
            (k.name[len("HeadArchetype_") :], k)
            for k in shape_keys.key_blocks
            if k.name.startswith("HeadArchetype_")
        ]
        for label, key in targets:
            if key is not None:
                key.value = 1.0
            for view_name, cam_pos in (
                ("front", Vector((0.0, -1.2, center_z))),
                ("side", Vector((-1.2, 0.0, center_z))),
            ):
                cam_obj.location = cam_pos
                direction = Vector((0.0, 0.0, center_z)) - cam_pos
                cam_obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
                bpy.context.scene.render.filepath = str(render_dir / f"{label}-{view_name}.png")
                bpy.ops.render.render(write_still=True)
            if key is not None:
                key.value = 0.0


def main(argv: Sequence[str]) -> None:
    args = parse_args(argv)
    if args.mode == "setup-refs":
        mode_setup_refs(args)
    elif args.mode == "sculpt-presets":
        mode_sculpt_presets(args)
    elif args.mode == "export-and-render":
        body, _ = load_scene(Path(args.input))
        metrics, _, regions = populate_head_groups(body, args.neck_seam_y, args.blend_height, slug=infer_slug(args))
        export_and_render(body, metrics, regions, args)


if __name__ == "__main__":
    main(sys.argv)

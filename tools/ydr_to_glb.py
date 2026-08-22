from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
from functools import lru_cache
from pathlib import Path
from typing import TypeAlias

import numpy as np
import trimesh
from PIL import Image
from fivefury import read_ydr
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

TextureSource: TypeAlias = Image.Image | Path


def _is_diffuse(name: str) -> bool:
    lowered = name.lower()
    return any(marker in lowered for marker in ("_ab", "_al", "_diff", "_diffuse"))


def _is_normal(name: str) -> bool:
    lowered = name.lower()
    return lowered.endswith(("_nm", "_n", "_normal")) or "_nm" in lowered


def _dictionary_model_name(name: str) -> str:
    return re.sub(r"\+(?:hi|hidr|hifr|lod).*$", "", name.lower())


@lru_cache(maxsize=8)
def _texture_manifest(folder_value: str) -> tuple[dict[str, Path], dict[str, list[dict[str, object]]]]:
    folder = Path(folder_value)
    manifest_path = folder / "texture-manifest.json"
    by_name: dict[str, Path] = {}
    dictionaries: dict[str, list[dict[str, object]]] = {}
    if not manifest_path.is_file():
        return by_name, dictionaries
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return by_name, dictionaries
    raw_dictionaries = raw.get("dictionaries", {})
    if not isinstance(raw_dictionaries, dict):
        return by_name, dictionaries
    for dictionary_name, raw_entries in raw_dictionaries.items():
        if not isinstance(raw_entries, list):
            continue
        entries = [entry for entry in raw_entries if isinstance(entry, dict)]
        dictionaries[str(dictionary_name).lower()] = entries
        for entry in entries:
            texture_name = str(entry.get("name", "")).lower()
            texture_path = folder / str(entry.get("file", ""))
            if texture_name and texture_path.is_file():
                by_name[texture_name] = texture_path
    return by_name, dictionaries


def _manifest_textures(folder: Path, model_name: str) -> list[Path]:
    _, dictionaries = _texture_manifest(str(folder.resolve()))
    model = model_name.lower()
    exact = [name for name in dictionaries if _dictionary_model_name(name) == model]
    candidates = exact
    if not candidates:
        tokens = {token for token in model.split("_") if len(token) >= 3}
        candidates = sorted(
            dictionaries,
            key=lambda name: (-sum(token in _dictionary_model_name(name) for token in tokens), name),
        )[:3]
    results: list[Path] = []
    seen: set[str] = set()
    for dictionary_name in candidates:
        entries = dictionaries.get(dictionary_name, [])
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict) or not _is_diffuse(str(entry.get("name", ""))):
                continue
            path = folder / str(entry.get("file", ""))
            if path.is_file() and path.name.lower() not in seen:
                seen.add(path.name.lower())
                results.append(path)
    return results


def _rsc8_texture_names(source: Path, texture_dir: Path | None) -> list[str]:
    if texture_dir is None:
        return []
    original = source.with_name(f"{source.stem.removesuffix('_nya')}.ydr")
    if not original.is_file():
        return []
    by_name, _ = _texture_manifest(str(texture_dir.resolve()))
    if not by_name:
        return []
    try:
        raw = original.read_bytes()
    except OSError:
        return []
    lowered_raw = raw.lower()
    by_position: dict[int, str] = {}
    for lowered in by_name:
        position = lowered_raw.find(lowered.encode("ascii", errors="ignore"))
        if position < 0:
            continue
        previous = by_position.get(position)
        if previous is None or len(lowered) > len(previous):
            by_position[position] = lowered
    return [name for _, name in sorted(by_position.items())]


def _diffuse_textures(folder: Path | None, model_name: str, source: Path) -> list[tuple[str, Path]]:
    if folder is None or not folder.is_dir():
        return []
    by_name, dictionaries = _texture_manifest(str(folder.resolve()))
    referenced = _rsc8_texture_names(source, folder)
    matched_references = [
        (name, by_name[name.lower()])
        for name in referenced
        if _is_diffuse(name) and name.lower() in by_name
    ]
    if matched_references:
        # The game resolves a model's own texture dictionary before shared
        # ones, so a texture shipped in `<model>.ytd` outranks a same-named
        # match from an archive dictionary regardless of byte position.
        model = model_name.lower()
        own_textures = {
            str(entry.get("name", "")).lower()
            for dictionary_name, entries in dictionaries.items()
            if _dictionary_model_name(dictionary_name) == model
            for entry in entries
            if isinstance(entry, dict)
        }
        matched_references.sort(key=lambda item: item[0].lower() not in own_textures)
        return matched_references
    matched = _manifest_textures(folder, model_name)
    if matched:
        return [(path.stem, path) for path in matched]
    candidates = [
        path
        for path in folder.glob("*.png")
        if _is_diffuse(path.stem)
    ]
    tokens = {token for token in model_name.lower().split("_") if len(token) >= 3}

    def score(path: Path) -> tuple[int, str]:
        stem = path.stem.lower()
        return (-sum(token in stem for token in tokens), stem)

    return [(path.stem, path) for path in sorted(candidates, key=score)]


def _companion_texture(texture_dir: Path | None, diffuse_name: str, role: str) -> Path | None:
    if texture_dir is None:
        return None
    by_name, _ = _texture_manifest(str(texture_dir.resolve()))
    lowered = diffuse_name.lower()
    base = re.split(r"_(?:ab|al|diff|diffuse)", lowered, maxsplit=1)[0]
    suffixes = ("_nm", "_n", "_normal") if role == "normal" else ("_ma", "_mb")
    for suffix in suffixes:
        candidate = by_name.get(base + suffix)
        if candidate is not None:
            return candidate
    prefix_matches = [
        (name, path)
        for name, path in by_name.items()
        if name.startswith(base + "_") and ((_is_normal(name) if role == "normal" else name.endswith(("_ma", "_mb"))))
    ]
    return min(prefix_matches, key=lambda item: (len(item[0]), item[0]))[1] if prefix_matches else None


def _load_image(source: TextureSource) -> Image.Image:
    return source.copy() if isinstance(source, Image.Image) else Image.open(source).convert("RGBA")


def _has_transparency(image: Image.Image) -> bool:
    if image.mode != "RGBA":
        return False
    alpha = image.getchannel("A").getextrema()
    return bool(alpha and alpha[0] < 250)


def _fallback_colour(model_name: str, material_index: int) -> tuple[int, int, int, int]:
    digest = hashlib.sha256(f"{model_name}:{material_index}".encode("utf-8")).digest()
    return (80 + digest[0] % 120, 80 + digest[1] % 120, 80 + digest[2] % 120, 255)


def convert_ydr_to_glb(
    source: Path,
    output: Path,
    texture_dir: Path | None = None,
    planar_uv_scale: float = 0.0,
    embed_textures: bool = True,
) -> dict[str, int | str]:
    drawable = read_ydr(source)
    model_name = source.stem.removesuffix("_nya")
    textures: list[tuple[str, TextureSource]] = _diffuse_textures(texture_dir, model_name, source)
    if drawable.embedded_textures is not None:
        embedded: list[tuple[str, TextureSource]] = []
        for texture in drawable.embedded_textures.textures:
            name = texture.name.lower()
            if _is_diffuse(name):
                embedded.append((texture.name, Image.open(io.BytesIO(texture.to_dds_bytes())).convert("RGBA")))
        if not textures:
            textures = embedded
    scene = trimesh.Scene(base_frame="RDR2_Z_UP")

    lod_name = ""
    lod_models = []
    for lod, models in drawable.lods.items():
        if models:
            lod_name = str(lod)
            lod_models = models
            break
    if not lod_models:
        raise ValueError(f"{source.name} contains no drawable geometry")

    vertex_count = 0
    triangle_count = 0
    mesh_count = 0
    for model_index, model in enumerate(lod_models):
        for local_index, mesh in enumerate(model.meshes):
            if len(mesh.positions) < 3 or len(mesh.indices) < 3:
                continue
            usable_indices = len(mesh.indices) - (len(mesh.indices) % 3)
            vertices = np.asarray(mesh.positions, dtype=np.float32)
            faces = np.asarray(mesh.indices[:usable_indices], dtype=np.int64).reshape((-1, 3))
            valid = np.all((faces >= 0) & (faces < len(vertices)), axis=1)
            faces = faces[valid]
            if not len(faces):
                continue

            kwargs: dict[str, object] = {
                "vertices": vertices,
                "faces": faces,
                "process": False,
                "maintain_order": True,
            }
            if len(mesh.normals) == len(vertices):
                kwargs["vertex_normals"] = np.asarray(mesh.normals, dtype=np.float32)
            geometry = trimesh.Trimesh(**kwargs)

            texture_entry = textures[mesh.material_index] if 0 <= mesh.material_index < len(textures) else None
            if len(textures) == 1:
                texture_entry = textures[0]

            uv = None
            if texture_entry is not None:
                if mesh.texcoords and len(mesh.texcoords[0]) == len(vertices):
                    uv = np.asarray(mesh.texcoords[0], dtype=np.float32)
                elif planar_uv_scale > 0:
                    # RDR2 terrain drawables ship POSITION/NORMAL/COLOR_0 but no
                    # TEXCOORD_0 — the terrain shader derives UVs from world
                    # position. Reproduce that as a planar XY projection at the
                    # layer tiling scale. Patches are 64 m on a 64 m grid and
                    # store positions cell-local, so a scale that divides 64
                    # keeps the pattern continuous across patch seams.
                    uv = np.ascontiguousarray(vertices[:, :2] / planar_uv_scale, dtype=np.float32)

            if texture_entry is not None and uv is not None:
                texture_name, texture_source = texture_entry
                if not embed_textures:
                    # Terrain: the same handful of layer materials repeat across
                    # every patch of every cell, so embedding them per file
                    # multiplies one 460 MB texture set into hundreds of GB
                    # (measured: 2.5 GB for 4 cells, ~300 GB for the map). The
                    # name carries the binding and the renderer resolves it
                    # against the shared PNG folder, loading each map once.
                    material = PBRMaterial(
                        name=f"rdr2_material_{mesh.material_index}_{texture_name}",
                        metallicFactor=0.0,
                        roughnessFactor=0.85,
                        doubleSided=False,
                        alphaMode="OPAQUE",
                    )
                    geometry.visual = TextureVisuals(uv=uv, material=material)
                else:
                    image = _load_image(texture_source)
                    normal_source = _companion_texture(texture_dir, texture_name, "normal")
                    normal_image = _load_image(normal_source) if normal_source is not None else None
                    has_alpha = _has_transparency(image)
                    material = PBRMaterial(
                        name=f"rdr2_material_{mesh.material_index}_{texture_name}",
                        baseColorTexture=image,
                        normalTexture=normal_image,
                        metallicFactor=0.0,
                        roughnessFactor=0.85,
                        doubleSided=has_alpha,
                        alphaMode="MASK" if has_alpha else "OPAQUE",
                        alphaCutoff=0.35 if has_alpha else None,
                    )
                    geometry.visual = TextureVisuals(uv=uv, image=image, material=material)
            else:
                geometry.visual.vertex_colors = _fallback_colour(model_name, mesh.material_index)

            geometry_name = f"{model_name}_{lod_name}_{model_index}_{local_index}"
            scene.add_geometry(geometry, node_name=geometry_name, geom_name=geometry_name)
            mesh_count += 1
            vertex_count += len(vertices)
            triangle_count += len(faces)

    if not mesh_count:
        raise ValueError(f"{source.name} contains no valid triangle meshes")

    output.parent.mkdir(parents=True, exist_ok=True)
    scene.export(file_obj=output, file_type="glb")
    return {
        "model": model_name,
        "lod": lod_name,
        "meshes": mesh_count,
        "vertices": vertex_count,
        "triangles": triangle_count,
        "bytes": output.stat().st_size,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert a standalone GTA V RSC7 YDR to a GLB cache asset.")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--textures", type=Path, default=None)
    parser.add_argument("--planar-uv-scale", type=float, default=0.0)
    parser.add_argument("--shared-textures", action="store_true",
                        help="reference textures by material name instead of embedding them")
    args = parser.parse_args()
    result = convert_ydr_to_glb(
        args.source.resolve(),
        args.output.resolve(),
        args.textures.resolve() if args.textures else None,
        args.planar_uv_scale,
        not args.shared_textures,
    )
    print(" ".join(f"{key}={value}" for key, value in result.items()))


if __name__ == "__main__":
    main()

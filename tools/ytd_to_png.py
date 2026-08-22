from __future__ import annotations

import argparse
import io
import json
import re
from pathlib import Path

from PIL import Image
from fivefury import read_ytd


def safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.+-]", "_", value).strip(". ") or "texture"


def export_ytd_folder(source_dir: Path, output_dir: Path) -> tuple[int, int]:
    output_dir.mkdir(parents=True, exist_ok=True)
    dictionaries = 0
    exported = 0
    best_area: dict[str, int] = {}
    manifest: dict[str, object] = {
        "format": "frontier-rdr2-textures",
        "version": 1,
        "dictionaries": {},
    }
    for source in sorted(source_dir.glob("*.ytd")):
        dictionary = read_ytd(source)
        dictionaries += 1
        entries: list[dict[str, object]] = []
        for texture in dictionary.textures:
            name = safe_name(texture.name)
            area = int(texture.width) * int(texture.height)
            filename = f"{name}.png"
            entries.append({
                "name": texture.name,
                "file": filename,
                "width": int(texture.width),
                "height": int(texture.height),
            })
            if best_area.get(name, -1) <= area:
                image = Image.open(io.BytesIO(texture.to_dds_bytes())).convert("RGBA")
                image.save(output_dir / filename, optimize=True)
                best_area[name] = area
                exported += 1
        manifest["dictionaries"][source.stem.lower()] = entries
    (output_dir / "texture-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return dictionaries, exported


def main() -> None:
    parser = argparse.ArgumentParser(description="Export all FiveFury-readable YTD textures in a folder to PNG.")
    parser.add_argument("source_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    dictionaries, textures = export_ytd_folder(args.source_dir.resolve(), args.output_dir.resolve())
    print(f"dictionaries={dictionaries} textures={textures}")


if __name__ == "__main__":
    main()

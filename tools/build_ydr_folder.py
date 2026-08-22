from __future__ import annotations

import argparse
from pathlib import Path

from ydr_to_glb import convert_ydr_to_glb


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a folder of GLB cache assets from converted *_nya.ydr files.")
    parser.add_argument("source_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--textures", type=Path, default=None)
    parser.add_argument("--planar-uv-scale", type=float, default=0.0)
    parser.add_argument("--shared-textures", action="store_true",
                        help="reference textures by material name instead of embedding them")
    args = parser.parse_args()
    source_dir = args.source_dir.resolve()
    output_dir = args.output_dir.resolve()
    texture_dir = args.textures.resolve() if args.textures else None
    results = [
        convert_ydr_to_glb(
            source, output_dir / f"{source.stem.removesuffix('_nya')}.glb",
            texture_dir, args.planar_uv_scale, not args.shared_textures,
        )
        for source in sorted(source_dir.glob("*_nya.ydr"))
    ]
    print(
        f"models={len(results)} "
        f"meshes={sum(int(item['meshes']) for item in results)} "
        f"vertices={sum(int(item['vertices']) for item in results)} "
        f"triangles={sum(int(item['triangles']) for item in results)} "
        f"bytes={sum(int(item['bytes']) for item in results)}"
    )


if __name__ == "__main__":
    main()

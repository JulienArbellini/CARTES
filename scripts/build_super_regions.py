#!/usr/bin/env python3
"""Build super-regions from a GeoJSON layer and a mapping file.

Examples:
  python3 scripts/build_super_regions.py \
    --input Africa/gadm41_MAR_1.json \
    --mapping mappings/morocco_macro_regions.json \
    --output output/morocco_macro_regions.geojson
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any


class CliError(Exception):
    """Raised when user input is invalid."""


def normalize_label(value: Any) -> str:
    """Normalize labels to match strings with accents/spaces/punctuation differences."""
    text = str(value or "").strip()
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "", text)
    return text


def load_mapping(
    path: Path,
    mapping_source_column: str,
    mapping_target_column: str,
    use_normalization: bool,
) -> dict[str, str]:
    """Load mapping from JSON or CSV.

    JSON accepted shapes:
      - {"ProvinceA": "North", "ProvinceB": "South"}
      - [{"source": "ProvinceA", "target": "North"}, ...]

    CSV expected columns by default: source,target
    """
    if not path.exists():
        raise CliError(f"Mapping file not found: {path}")

    suffix = path.suffix.lower()
    raw_mapping: dict[str, str]

    if suffix == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            raw_mapping = {str(k): str(v) for k, v in data.items()}
        elif isinstance(data, list):
            raw_mapping = {}
            for row in data:
                if not isinstance(row, dict):
                    raise CliError("JSON list mapping must contain objects.")
                if mapping_source_column not in row or mapping_target_column not in row:
                    raise CliError(
                        "JSON list mapping rows must contain "
                        f"'{mapping_source_column}' and '{mapping_target_column}'."
                    )
                raw_mapping[str(row[mapping_source_column])] = str(row[mapping_target_column])
        else:
            raise CliError("Unsupported JSON mapping format.")

    elif suffix == ".csv":
        raw_mapping = {}
        with path.open("r", encoding="utf-8", newline="") as fh:
            reader = csv.DictReader(fh)
            if not reader.fieldnames:
                raise CliError("CSV mapping is empty.")
            if mapping_source_column not in reader.fieldnames or mapping_target_column not in reader.fieldnames:
                raise CliError(
                    f"CSV mapping must contain columns '{mapping_source_column}' and '{mapping_target_column}'."
                )
            for row in reader:
                raw_mapping[str(row[mapping_source_column])] = str(row[mapping_target_column])
    else:
        raise CliError("Mapping file must be .json or .csv")

    if not raw_mapping:
        raise CliError("Mapping file is empty.")

    if use_normalization:
        normalized = {}
        for key, value in raw_mapping.items():
            norm_key = normalize_label(key)
            if norm_key in normalized and normalized[norm_key] != value:
                raise CliError(
                    f"Conflicting mapping after normalization for key '{key}' -> '{norm_key}'."
                )
            normalized[norm_key] = value
        return normalized

    return raw_mapping


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Merge GeoJSON regions into super-regions using a mapping file.",
    )
    parser.add_argument("--input", required=True, help="Input GeoJSON path (regions/provinces).")
    parser.add_argument("--mapping", required=True, help="Mapping file (.json or .csv).")
    parser.add_argument("--output", required=True, help="Output GeoJSON path.")

    parser.add_argument(
        "--source-field",
        default="NAME_1",
        help="Property name in input GeoJSON used to match mapping keys (default: NAME_1).",
    )
    parser.add_argument(
        "--target-field",
        default="macro_region",
        help="Output property name for grouped region label (default: macro_region).",
    )

    parser.add_argument(
        "--mapping-source-column",
        default="source",
        help="Source column/key name for CSV or JSON-list mapping files (default: source).",
    )
    parser.add_argument(
        "--mapping-target-column",
        default="target",
        help="Target column/key name for CSV or JSON-list mapping files (default: target).",
    )

    parser.add_argument(
        "--normalize",
        action="store_true",
        help=(
            "Normalize labels before matching (remove accents/spaces/punctuation + lowercase). "
            "Useful when mapping names differ slightly."
        ),
    )

    parser.add_argument(
        "--on-missing",
        choices=["error", "drop", "keep-source"],
        default="error",
        help=(
            "What to do when source regions are missing in mapping: "
            "error (default), drop, or keep-source."
        ),
    )

    parser.add_argument(
        "--fix-invalid",
        action="store_true",
        help="Try to repair invalid geometries before dissolve using a zero-width buffer.",
    )

    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        import geopandas as gpd
    except ImportError as exc:
        print(
            "Missing dependency: geopandas.\n"
            "Install it with one of these commands:\n"
            "  pip install geopandas\n"
            "  or\n"
            "  uv pip install geopandas",
            file=sys.stderr,
        )
        raise SystemExit(1) from exc

    input_path = Path(args.input)
    output_path = Path(args.output)

    if not input_path.exists():
        raise CliError(f"Input file not found: {input_path}")

    mapping = load_mapping(
        Path(args.mapping),
        mapping_source_column=args.mapping_source_column,
        mapping_target_column=args.mapping_target_column,
        use_normalization=args.normalize,
    )

    gdf = gpd.read_file(input_path)

    if args.source_field not in gdf.columns:
        raise CliError(
            f"Field '{args.source_field}' not found in input. Available fields: {', '.join(gdf.columns)}"
        )

    source_series = gdf[args.source_field].astype(str)

    if args.normalize:
        source_keys = source_series.map(normalize_label)
    else:
        source_keys = source_series

    gdf[args.target_field] = source_keys.map(mapping)

    missing_mask = gdf[args.target_field].isna()
    missing_values = sorted(gdf.loc[missing_mask, args.source_field].astype(str).unique().tolist())

    if missing_values and args.on_missing == "error":
        preview = ", ".join(missing_values[:20])
        suffix = "" if len(missing_values) <= 20 else f" ... (+{len(missing_values) - 20} more)"
        raise CliError(
            "Some regions are missing in mapping. "
            f"Count={len(missing_values)}. Examples: {preview}{suffix}. "
            "Use --on-missing drop or --on-missing keep-source if desired."
        )

    if missing_values and args.on_missing == "drop":
        gdf = gdf.loc[~missing_mask].copy()

    if missing_values and args.on_missing == "keep-source":
        gdf.loc[missing_mask, args.target_field] = gdf.loc[missing_mask, args.source_field].astype(str)

    if gdf.empty:
        raise CliError("No features left to export after filtering missing mappings.")

    if args.fix_invalid:
        gdf["geometry"] = gdf.geometry.buffer(0)

    dissolved = gdf.dissolve(by=args.target_field, as_index=False)
    dissolved = dissolved[[args.target_field, "geometry"]].sort_values(by=args.target_field).reset_index(drop=True)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    dissolved.to_file(output_path, driver="GeoJSON")

    print(f"Input features: {len(source_series)}")
    print(f"Output super-regions: {len(dissolved)}")
    print(f"Missing source regions: {len(missing_values)}")
    if missing_values:
        print("Missing examples:", ", ".join(missing_values[:20]))
    print(f"Output written to: {output_path}")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CliError as err:
        print(f"Error: {err}", file=sys.stderr)
        raise SystemExit(1)

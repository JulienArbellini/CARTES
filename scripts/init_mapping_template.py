#!/usr/bin/env python3
"""Generate a CSV mapping template from GeoJSON feature properties.

Example:
  python3 scripts/init_mapping_template.py \
    --input Africa/gadm41_MAR_1.json \
    --output mappings/morocco_mapping_template.csv
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


class CliError(Exception):
    """Raised when user input is invalid."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract unique region names from a GeoJSON and write source,target CSV template.",
    )
    parser.add_argument("--input", required=True, help="Input GeoJSON path")
    parser.add_argument("--output", required=True, help="Output CSV path")
    parser.add_argument(
        "--source-field",
        default="NAME_1",
        help="GeoJSON property name used as source label (default: NAME_1)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)

    if not input_path.exists():
        raise CliError(f"Input file not found: {input_path}")

    data = json.loads(input_path.read_text(encoding="utf-8"))

    if data.get("type") != "FeatureCollection":
        raise CliError("Input GeoJSON must be a FeatureCollection")

    features = data.get("features", [])
    if not isinstance(features, list):
        raise CliError("Invalid GeoJSON: 'features' must be a list")

    labels = set()
    for feature in features:
        if not isinstance(feature, dict):
            continue
        props = feature.get("properties") or {}
        if not isinstance(props, dict):
            continue
        value = props.get(args.source_field)
        if value is None:
            continue
        labels.add(str(value).strip())

    if not labels:
        raise CliError(
            f"No values found for source field '{args.source_field}'."
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["source", "target"])
        for label in sorted(labels):
            writer.writerow([label, ""])

    print(f"Found {len(labels)} unique values in '{args.source_field}'.")
    print(f"Template written to: {output_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CliError as err:
        print(f"Error: {err}")
        raise SystemExit(1)

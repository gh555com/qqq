#!/usr/bin/env python3
"""
merge_product.py — Merge qqq overrides into Code-OSS product.json

Usage: python merge_product.py base.json overlay.json output.json

Code-OSS product.json is the "base"; our ide/product.json is the "overlay".
Overlay values win for all top-level keys.
Lists in overlay REPLACE (not append) the corresponding base list.
"""
import json, sys

def merge(base, overlay):
    result = dict(base)
    for k, v in overlay.items():
        result[k] = v   # overlay wins unconditionally
    return result

base_path, overlay_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

with open(base_path, 'r', encoding='utf-8') as f:
    base = json.load(f)
with open(overlay_path, 'r', encoding='utf-8') as f:
    overlay = json.load(f)

merged = merge(base, overlay)

with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(merged, f, indent=2, ensure_ascii=False)

print(f"product.json merged: {len(overlay)} keys overridden")

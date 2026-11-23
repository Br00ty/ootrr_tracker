#!/usr/bin/env python3
"""The item each location holds when the seed doesn't shuffle it, as OOTRR fills it: Data::vanilla_of takes the
remake's own item (data/remake_vanilla.json, "the item the remake chest really holds") over the OoTR vanilla
item (slice/fill.rs vanilla_place). The tracker export's "vanilla" is the OoTR one, so a Fire Temple chest that
holds a Small Key in the remake (OOTRR's Fire Temple Compass Chest) was missing from the key spots, and the
Boulder Maze Side Room Chest (a Map in the remake) counted as a key (2026-11-23).
Usage: remake_vanilla.py <ootrr root> [data.json]"""
import json, os, sys
root = sys.argv[1]
out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', 'data', 'data.json')
rem = json.load(open(os.path.join(root, 'data', 'remake_vanilla.json')))['locations']
d = json.load(open(out_path))
n = sum(1 for k, v in rem.items() if d['vanilla'].get(k) != v)
d['vanilla'] = {**d['vanilla'], **rem}
json.dump(d, open(out_path, 'w'), separators=(',', ':'))
print('remake vanilla: %d locations take the remake item' % n)

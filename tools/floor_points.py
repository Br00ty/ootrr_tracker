#!/usr/bin/env python3
"""What the game's dungeon maps put on each floor, for telling Link's floor (floorAt in src/ui.html).

tools/floor_points.json: map id -> [[floor index from the lowest, x, y, z]] for every chest, door, sign, stone
tablet, heart, facility and entrance the remake's Banc/BancBasedResource/MapParam.byml lists under each Floor
(read from the game files 2026-11-24). Height alone misreads rooms that rise above the next floor's base (a
Water Temple 2F chest at y 118.4, over 3F's 115.6). Copied into data.json as floor_points.
Usage: floor_points.py [data.json]"""
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, '..', 'data', 'data.json')
d = json.load(open(out_path))
d['floor_points'] = json.load(open(os.path.join(here, 'floor_points.json')))
json.dump(d, open(out_path, 'w'), separators=(',', ':'))
print('floor points: %d maps' % len(d['floor_points']))

#!/usr/bin/env python3
"""Gossip stone hint data for the tracker, from an OOTRR checkout (data/ and randomizer/).

OOTRR picks the 40 stone hints from the seed alone (randomizer/core/src/hints.rs: candidates, pick), so the
tracker can say what each stone says. This copies what that needs into data/data.json under "hints":
  items    the items a hint can name (adv, not a key/map/compass/token kind, not a heart)
  areas    location -> the place a hint names (data/locations.json and free_remake.json "area", with "the"
           where hints.rs adds it)
  prefixes the name prefixes hints.rs falls back on for a location the catalog doesn't have
  shown    the "Progressive" names the hints show (logic/src/spoiler.rs SHOWN)
  stones   the stone labels in the game's text file, sorted (hints.rs labels): hint i goes to stone i
  where    stone -> [[banc, stone position, where Link stands to talk]] from the game's Banc files
           (tools/gossip_stones.json, read from the remake's romfs on 2026-11-23)
Usage: hint_data.py <ootrr root> [data.json]"""
import json, os, re, sys

root = sys.argv[1]
out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', 'data', 'data.json')
rs = open(os.path.join(root, 'randomizer', 'core', 'src', 'hints.rs')).read()
sp = open(os.path.join(root, 'randomizer', 'logic', 'src', 'spoiler.rs')).read()

def strs(name, text):
    m = re.search(r'(?:pub )?const ' + name + r': \[[^\]]*\] = \[(.*?)\];', text, re.S)
    return re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(1))

skip, minor, the = strs('SKIP', rs), strs('MINOR', rs), strs('THE', rs)
pre = strs('PREFIXES', rs)
prefixes = [[pre[i], pre[i + 1]] for i in range(0, len(pre), 2)]
sh = strs('SHOWN', sp)
shown = {sh[i]: sh[i + 1] for i in range(0, len(sh), 2)}

def place_name(a):
    if a in the: return 'the ' + a
    if a == "Outside Ganon's Castle": return "the area outside Ganon's Castle"
    return a

items = json.load(open(os.path.join(root, 'data', 'items.json')))['items']
hint_items = sorted(i['name'] for i in items if i.get('adv') and i.get('kind') not in skip and i['name'] not in minor)
areas = {}
# catalog.rs by_name: the first one with the name; spots/free.rs with_free adds the remake's freestanding spots after
for f in ('locations.json', 'free_remake.json'):
    p = os.path.join(root, 'data', f)
    if not os.path.exists(p): continue
    for l in json.load(open(p))['locations']:
        areas.setdefault(l['name'], place_name(l['area']))
flags = json.load(open(os.path.join(root, 'data', 'flags.json')))['flags']
stones = sorted({f['name'].split('.', 1)[1] for f in flags if f.get('name', '').startswith('GossipStoneDisappear.GOSSIP_')})
where = json.load(open(os.path.join(os.path.dirname(__file__), 'gossip_stones.json')))
assert set(stones) == set(where), 'stones without a position: %s' % sorted(set(stones) ^ set(where))

d = json.load(open(out_path))
d['hints'] = {'items': hint_items, 'areas': areas, 'prefixes': prefixes, 'shown': shown, 'stones': stones, 'where': where}
json.dump(d, open(out_path, 'w'), separators=(',', ':'))
print('hints: %d items, %d areas, %d stones' % (len(hint_items), len(areas), len(stones)))

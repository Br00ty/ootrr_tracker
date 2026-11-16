"""Builds data/data.json from an OOTRR checkout and the two exports in tools/out (see README).
Usage: python tools/build_data.py <ootrr checkout>/data"""
import json, sys, collections, os
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
D = sys.argv[1]
L = json.load(open('tools/out/logic.json'))
SCH = json.load(open('tools/out/schema.json'))

def compact(r):
    o = {'n': r['region_name']}
    if r.get('locations'): o['l'] = r['locations']
    if r.get('events'): o['e'] = r['events']
    if r.get('exits'): o['x'] = r['exits']
    if r.get('dungeon'): o['d'] = r['dungeon']
    if r.get('time_passes'): o['t'] = 3
    pt = r.get('provides_time')
    if pt: o['t'] = {'DAY': 1, 'DAMPE': 2, 'ALL': 3, 'NONE': 0}[pt]
    return o

base = [compact(r) for r in L['regions']]
idx = {r['n']: i for i, r in enumerate(base)}
patches = {}
for key, regs in L['switch_regions'].items():
    ch = {}
    for r in regs:
        c = compact(r)
        i = idx.get(c['n'])
        if i is None:
            ch[c['n']] = {'new': c}
            continue
        if base[i] == c:
            continue
        d = {}
        for f in ('l', 'e', 'x'):
            old, new = base[i].get(f) or {}, c.get(f) or {}
            put = {k: v for k, v in new.items() if old.get(k) != v}
            gone = [k for k in old if k not in new]
            if put: d[f] = put
            if gone: d[f + '-'] = gone
        for f in ('d', 't'):
            if base[i].get(f) != c.get(f): d[f] = c.get(f)
        ch[c['n']] = d
    patches[key] = ch
    print('patch', key, len(ch), 'regions changed', file=sys.stderr)

helpers = {}
for h in L['helpers']:
    helpers.update(h)

# ---- the check catalog: every real location of the full world, with an area and a kind ----
PREFIX=[("KF ","Kokiri Forest"),("Deku Tree","Deku Tree"),("Queen Gohma","Deku Tree"),("LW ","Lost Woods"),("Deku Theater","Lost Woods"),("SFM ","Sacred Forest Meadow"),("Song from Saria","Sacred Forest Meadow"),("Sheik in Forest","Sacred Forest Meadow"),
("HF ","Hyrule Field"),("Song from Ocarina of Time","Hyrule Field"),("LLR ","Lon Lon Ranch"),("Song from Malon","Lon Lon Ranch"),("Market ","Market"),("ToT ","Temple of Time"),("Sheik at Temple","Temple of Time"),("Master Sword","Temple of Time"),("Song from Impa","Hyrule Castle"),("HC ","Hyrule Castle"),("OGC ","Outside Ganon's Castle"),
("Kak ","Kakariko Village"),("Song from Windmill","Kakariko Village"),("Sheik in Kakariko","Kakariko Village"),("Graveyard ","Graveyard"),("Song from Royal","Graveyard"),("Bottom of the Well","Bottom of the Well"),
("DMT ","Death Mountain Trail"),("GC ","Goron City"),("Darunias","Goron City"),("DMC ","Death Mountain Crater"),("Sheik in Crater","Death Mountain Crater"),("Dodongos Cavern","Dodongo's Cavern"),("King Dodongo","Dodongo's Cavern"),
("ZR ","Zora's River"),("ZD ","Zora's Domain"),("ZF ","Zora's Fountain"),("Jabu","Jabu Jabu's Belly"),("Barinade","Jabu Jabu's Belly"),("Ice Cavern","Ice Cavern"),("Sheik in Ice","Ice Cavern"),
("LH ","Lake Hylia"),("Water Temple","Water Temple"),("Morpha","Water Temple"),("GV ","Gerudo Valley"),("GF ","Gerudo's Fortress"),("Hideout ","Thieves' Hideout"),("Gerudo Training","Gerudo Training Ground"),("Wasteland ","Haunted Wasteland"),
("Colossus ","Desert Colossus"),("Sheik at Colossus","Desert Colossus"),("Forest Temple","Forest Temple"),("Phantom Ganon","Forest Temple"),("Fire Temple","Fire Temple"),("Volvagia","Fire Temple"),("Shadow Temple","Shadow Temple"),("Bongo","Shadow Temple"),
("Spirit Temple","Spirit Temple"),("Twinrova","Spirit Temple"),("Ganons Castle","Ganon's Castle"),("Ganons Tower","Ganon's Castle"),("Ganondorf","Ganon's Castle"),("Ganon","Ganon's Castle"),("Links Pocket","Temple of Time"),("Pierre","Lake Hylia")]
AREAS = sorted({a for _, a in PREFIX} | {"Hyrule Castle", "Lon Lon Ranch", "Gerudo Valley", "Haunted Wasteland"}, key=len, reverse=True)
REGION_ALIAS = {"Hyrule Castle Grounds": "Hyrule Castle", "Castle Grounds": "Hyrule Castle", "Gerudo Fortress": "Gerudo's Fortress", "Zoras River": "Zora's River", "Zora River": "Zora's River", "Child Spirit Temple": "Spirit Temple", "Adult Spirit Temple": "Spirit Temple",
                "Zoras Domain": "Zora's Domain", "Zoras Fountain": "Zora's Fountain", "Death Mountain": "Death Mountain Trail", "Goron City": "Goron City", "Market": "Market"}
def area_of(n):
    for p, a in PREFIX:
        if n.startswith(p): return a
    for p, a in REGION_ALIAS.items():
        if n.startswith(p): return a
    for a in AREAS:
        if n.replace("'", "").startswith(a.replace("'", "")): return a
    return None

locs = json.load(open(f"{D}/locations.json"))['locations']
flows = json.load(open(f"{D}/flow_locations.json"))['locations']
T = json.load(open(f"{D}/tracker_targets.json"))['targets']
area_hint = {l['name']: l['area'].replace("Ganon's Tower", "Ganon's Castle") for l in locs}
kind_of = {}
LK = {'chest': 'chest', 'gs': 'gs', 'pot': 'pot', 'freestanding': 'free', 'heart': 'free', 'bossheart': 'boss', 'key': 'free', 'scrub': 'scrub', 'cow': 'cow', 'crate': 'crate'}
for l in locs: kind_of[l['name']] = LK.get(l['kind'], 'other')
for l in flows:
    kind_of[l['name']] = 'boss' if l['type'] == 'Boss' else 'song' if l['type'] == 'Song' else 'scrub' if l['type'] == 'Scrub' else 'npc'
TK = {'chest': 'chest', 'trap_chest': 'chest', 'skulltula': 'gs', 'pot': 'pot', 'flying_pot': 'pot', 'crate': 'crate', 'beehive': 'hive', 'cow': 'cow', 'gift': 'npc', 'shop': 'shop', 'scrub': 'scrub',
      'heart_piece': 'free', 'heart_container': 'boss', 'heart': 'free', 'rupee': 'free', 'silver_rupee': 'silver', 'key': 'free', 'pickup': 'free', 'rock': 'rock', 'grass': 'grass'}
for t in T:
    o = t.get('ootr')
    if o and o not in kind_of: kind_of[o] = TK.get(t['kind'], 'other')
def guess_kind(n):
    for pat, k in [(' GS ', 'gs'), ('Silver Rupee', 'silver'), ('Beehive', 'hive'), (' Cow', 'cow'), ('Shop Item', 'shop'), ('Rock', 'rock'), ('Grass', 'grass'), ('Crate', 'crate'),
                   ('Pot', 'pot'), ('Chest', 'chest'), ('Scrub', 'scrub'), ('Freestanding', 'free'), ('Heart', 'free'), ('Rupee', 'free'), ('Song', 'song')]:
        if pat in n: return k
    return 'npc'

region_area = {}
def all_locs(regs):
    for r in regs:
        for n in (r.get('l') or {}):
            yield n, r['n']
seen = {}
rules = {}
for r in base:
    for n, q in (r.get('l') or {}).items():
        seen.setdefault(n, r['n']); rules.setdefault(n, q)
for ch in patches.values():
    for rn, d in ch.items():
        for n, q in ((d.get('new') or {}).get('l') or d.get('l') or {}).items():
            seen.setdefault(n, rn); rules.setdefault(n, q)
checks = {}
noarea = []
for n, rn in seen.items():
    base_n = n.split(' @ ')[0]
    a = area_hint.get(base_n) or area_of(base_n) or area_of(rn)
    if not a:
        noarea.append(n); a = 'Other'
    # area, kind, logic region, and the location's own logic rule (for the check's description)
    checks[n] = [a, kind_of.get(base_n) or guess_kind(base_n), rn, ' '.join(rules[n].split())]
print('catalog', len(checks), 'no area', len(noarea), noarea[:20], file=sys.stderr)
print(collections.Counter(k for _, k, *_ in checks.values()), file=sys.stderr)

# the classic (no seed) check list: the 0.6.0 versions of locations.json and flow_locations.json
classic = []
for l in locs:
    if l['name'] in checks: classic.append(l['name'])
for l in flows:
    if l['name'] in checks and l['name'] not in classic: classic.append(l['name'])
missing = [l['name'] for l in locs + flows if l['name'] not in checks]
print('classic', len(classic), 'not in logic', len(missing), missing[:10], file=sys.stderr)

# save detection (tracker/rules.rs), gifts and cows marked for seed-aware rewiring (tracker/seed.rs)
det = {}
for t in T:
    o = t.get('ootr')
    if not o or o not in checks: continue
    r = {}
    if t['how'] == 'flag': r['f'] = t.get('flags') or []
    elif t['how'] == 'key': r['k'] = t.get('keys') or []
    if t['kind'] == 'gift': r['g'] = 1
    if t['kind'] == 'cow': r['c'] = 1
    if r: det.setdefault(o, []).append(r)
# Gold Skulltulas: OOTRR's shuffle drops a check's item at the skulltula skull_names.json names for it
# (slice/skull_names.rs hashes()), which overrides the older tracker_targets pairing for 48 skulltulas.
# Seen in a real save: the lone Hyrule Field tree skulltula (2177746409373494991) dropped the item of
# "LLR GS Rain Shed" while tracker_targets called it "LH GS Small Island".
SN = json.load(open(os.path.join(D, 'skull_names.json')))
skull_notes = {}
for sp in SN['spots']:
    h, n = str(sp['hash']), sp['name']
    for o, rules in list(det.items()):
        for r in rules:
            if h in (r.get('k') or []): r['k'] = [k for k in r['k'] if k != h]
        det[o] = [r for r in rules if r.get('k') or r.get('f') or not ('k' in r)]
        if not det[o]: del det[o]
    if n in checks:
        det[n] = [{'k': [h]}]
        skull_notes[n] = [sp['grade'], sp['why']]
print('skull names', len(SN['spots']), 'notes', len(skull_notes), file=sys.stderr)
mapc = collections.defaultdict(collections.Counter)
for t in T:
    o = t.get('ootr')
    if t.get('map') and o in checks: mapc[t['map']][checks[o][0]] += 1
maps = {m: c.most_common(1)[0][0] for m, c in mapc.items()}

schema = [{k: s[k] for k in ('num', 'id', 'kind', 'default', 'wire', 'deps', 'min', 'max', 'disabled', 'label') if k in s} | ({'choices': [c['id'] for c in s['choices']]} if 'choices' in s else {}) for s in SCH['settings']]
items = [[n, a] for n, a in L['items']]
out = {'generator': L['generator'], 'regions': base, 'patches': patches, 'helpers': helpers, 'groups': L['groups'], 'root': L['root'],
       'settings': L['settings'], 'items': items, 'vanilla': L['vanilla'], 'checks': checks, 'classic': classic, 'detect': det, 'maps': maps,
       'schema': schema, 'start_items': L['start_items'], 'item_actors': L['item_actors'], 'cow_flags': L['cow_flags'], 'entrances': L['entrances'], 'skull_notes': skull_notes, 'shop_rules': L['shop_rules'], 'labels': {s['id']: {c['id']: c['label'] for c in s.get('choices', [])} | {'_': s['label']} for s in SCH['settings']}}
json.dump(out, open('data/data.json', 'w'), separators=(',', ':'))
print('detect', len(det), 'maps', len(maps), file=sys.stderr)

"""Builds data/data.json from an OOTRR checkout and the two exports in tools/out (see README).
Usage: python tools/build_data.py <ootrr checkout>/data"""
import json, os, sys, collections
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
    k = kind_of.get(base_n) or guess_kind(base_n)
    if ' Bazaar Item ' in n: k = 'shop'  # the bazaars' shelves are shops too (OOTRR's catalog files them as NPCs)
    checks[n] = [a, k, rn, ' '.join(rules[n].split())]
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
    # most targets name their OoTR location in "ootr"; some (29 chests, the grass and rocks) are named
    # after it directly and have no "ootr" field
    o = t.get('ootr') or (t.get('name') if t.get('name') in checks else None)
    if not o or o not in checks: continue
    r = {}
    if t['how'] == 'flag': r['f'] = t.get('flags') or []
    elif t['how'] == 'key': r['k'] = t.get('keys') or []
    if t['kind'] == 'gift': r['g'] = 1
    if t['kind'] == 'cow': r['c'] = 1
    if r: det.setdefault(o, []).append(r)
# The generator writes each location's item into the game objects its catalog (locations.json "refs")
# names, so that catalog decides which object belongs to which check. tracker_targets only guesses some
# (57 differ, e.g. Mido's chests, DMT Chest vs DMT Storms Grotto Chest: in a real save the chest on
# the trail set IsTreasureBoxOpen.9809508929088891725, which the catalog verifies as DMT Chest).
# Each catalog object keeps the save rule tracker_targets has for it, under the catalog's name.
def objs(r):
    return [f.split('.', 1)[1] for f in (r.get('f') or []) if f.startswith('IsTreasureBoxOpen.')] + list(r.get('k') or [])
by_obj = {}
for o, rules in det.items():
    for r in rules:
        for h in objs(r): by_obj.setdefault(h, r)
CAT = json.load(open(os.path.join(D, 'locations.json')))
CAT = CAT if isinstance(CAT, list) else next(v for v in CAT.values() if isinstance(v, list))
moved = 0
for loc in CAT:
    n, hs = loc['name'], [str(x['hash']) for x in loc.get('refs') or []]
    if n not in checks or not hs: continue
    new = []
    for h in hs:
        r = by_obj.get(h) or ({'f': ['IsTreasureBoxOpen.' + h]} if loc.get('kind') == 'chest' else None)
        if r and r not in new: new.append(dict(r))
    if not new: continue
    # these objects belong to n now: take them out of every other check's rules
    for o in list(det):
        if o == n: continue
        keep = []
        for r in det[o]:
            if set(objs(r)) & set(hs):
                r = dict(r)
                if 'f' in r: r['f'] = [f for f in r['f'] if not (f.startswith('IsTreasureBoxOpen.') and f.split('.', 1)[1] in hs)]
                if 'k' in r: r['k'] = [k for k in r['k'] if k not in hs]
                if not (r.get('f') or r.get('k')): continue
            keep.append(r)
        if keep: det[o] = keep
        else: del det[o]
    if det.get(n) != new: moved += 1
    det[n] = new
print('catalog objects reassigned for', moved, 'checks', file=sys.stderr)

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
# shop shelves: bought once its sold counter (Shop_SoldNum.<keeper>.<slot>, from OOTRR's shops.json) is
# above 0. Seen in a real save: Kak Bazaar Items 1 and 4 went 0 -> 1 when bought.
SH = json.load(open(os.path.join(D, 'shops.json')))
for sl in SH['slots']:
    if sl['name'] in checks and sl.get('counters'):
        det[sl['name']] = [{'f': sl['counters']}]
print('shop shelves', sum(1 for sl in SH['slots'] if sl['name'] in checks), file=sys.stderr)
mapc = collections.defaultdict(collections.Counter)
for t in T:
    o = t.get('ootr')
    if t.get('map') and o in checks: mapc[t['map']][checks[o][0]] += 1
maps = {m: c.most_common(1)[0][0] for m, c in mapc.items()}

# which locations each setting adds to or takes from the shuffle, measured with OOTRR's own generator
# (tools/pool_matrix.py); the tracker builds the manual settings' location list from it
POOLS = json.load(open('tools/out/pools.json')) if os.path.exists('tools/out/pools.json') else None
if POOLS:
    # OOTRR's junk_spots.rs: with skulltula shuffle "matched", the skulltulas whose name is only a guess
    # (skull_names grade lean/tour) join the shuffle only when at least twice as many other shuffled locations
    # hold a junk item a skulltula can drop (not progression, not a token, with a skulltula pickup)
    _it = {i['name']: i for i in json.load(open(os.path.join(D, 'items.json')))['items']}
    _pk = json.load(open(os.path.join(D, 'skulltulas.json')))['pickups']
    _fits = {n for n in _pk if n != 'Gold Skulltula Token' and n in _it and not _it[n].get('adv')}
    # the vanilla item of every location as the generator sees it: the remake's own, else OoTR's (data.rs vanilla_of)
    # (tools/out/vanilla_gen.json, from the vanilla_dump example: it includes the remake's pots, rocks and grass)
    _van = json.load(open('tools/out/vanilla_gen.json'))
    POOLS['junk_locs'] = sorted(n for n in checks if _van.get(n) in _fits)
    POOLS['unsure_skulls'] = sorted({r['name'] for r in json.load(open(os.path.join(D, 'skull_names.json')))['spots'] if r.get('grade') != 'release'})
    POOLS['junk_slack'] = 2
    # special deals (shops/layout.rs deal_slots): the shelves in the order deals are handed out, slot k of every
    # dealing shop before slot k + 1 of any, and how many fit (deal_room.py: the room with "4 special deals",
    # changed by each setting)
    _sh = json.load(open(os.path.join(D, 'shops.json')))
    _at = {(x['shop'], x['slot']): x['name'] for x in _sh['slots']}
    _order = sorted((k, si, _at[(sh['shop'], sl)]) for si, sh in enumerate(_sh['shops']) if sh.get('deals') for k, sl in enumerate(sh['deal_order']))
    POOLS['deals'] = {'order': [[k, n] for k, si, n in _order]}
    if os.path.exists('tools/out/deal_room.json'): POOLS['deals'] |= json.load(open('tools/out/deal_room.json'))
schema = [{k: s[k] for k in ('num', 'id', 'kind', 'default', 'wire', 'deps', 'min', 'max', 'max_by', 'disabled', 'label', 'group', 'tag') if k in s} | ({'choices': [c['id'] for c in s['choices']]} if 'choices' in s else {}) for s in SCH['settings']]
items = [[n, a] for n, a in L['items']]
out = {'generator': L['generator'], 'regions': base, 'patches': patches, 'helpers': helpers, 'groups': L['groups'], 'root': L['root'],
       'settings': L['settings'], 'items': items, 'vanilla': L['vanilla'], 'checks': checks, 'classic': classic, 'detect': det, 'maps': maps,
       'schema': schema, 'start_items': L['start_items'], 'item_actors': L['item_actors'], 'cow_flags': L['cow_flags'], 'entrances': L['entrances'], 'skull_notes': skull_notes, 'shop_rules': L['shop_rules'], 'labels': {s['id']: {c['id']: c['label'] for c in s.get('choices', [])} | {'_': s['label']} for s in SCH['settings']},
       # OOTRR's settings page: its groups (tabs), presets and the help text of each setting and choice
       'tips': {s['id']: {c['id']: c['tip'] for c in s.get('choices', []) if c.get('tip')} | {'_': s.get('tip', '')} for s in SCH['settings']},
       'setting_groups': SCH['groups'], 'presets': SCH['presets'], 'pools': POOLS}
json.dump(out, open('data/data.json', 'w'), separators=(',', ':'))
print('detect', len(det), 'maps', len(maps), file=sys.stderr)

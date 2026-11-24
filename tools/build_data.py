"""Builds data/data.json from an OOTRR checkout and the two exports in tools/out (see README).
Usage: python tools/build_data.py <ootrr checkout>/data [<OOTRR tracker-cache>/<game>/index.json]

The map index (where each check sits on each game map) is made by OOTRR's tracker from the game files. Pass it
to take the pins from it; without it, the pins already in data/data.json are kept."""
import json, os, re, sys, collections
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
("LH ","Lake Hylia"),("Water Temple","Water Temple"),("Morpha","Water Temple"),("GV ","Gerudo Valley"),("GF ","Gerudo's Fortress"),("Hideout ","Thieves' Hideout"),("Gerudo Training","Gerudo Proving Ground"),("Wasteland ","Haunted Wasteland"),
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
    if a == "Gerudo Training Ground": a = "Gerudo Proving Ground"  # the remake's name for it
    if not a:
        noarea.append(n); a = 'Other'
    # area, kind, logic region, and the location's own logic rule (for the check's description)
    k = kind_of.get(base_n) or guess_kind(base_n)
    # the bazaars' shelves are shops too (OOTRR's catalog files them as NPCs), and since 0.8.3-nightly.20261123.5 every
    # shelf is named by its position ("KF Shop Left Side Top Right"), which the catalog doesn't know
    if ' Bazaar Item ' in n or re.search(r'(Shop|Bazaar) (Left|Right) Side (Top|Bottom) (Left|Right)$', n): k = 'shop'
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
# Silver rupees: OOTRR's silver rupee slice (crates/core/src/slice/silver.rs) lists every shuffled silver rupee's
# save key. tracker_targets misses one (BotW Ladders Top), so fill any silver rupee it has no key for from there.
_sil = next((x for x in (os.path.join(D, '..', d, 'core', 'src', 'slice', 'silver.rs') for d in ('randomizer', 'crates')) if os.path.exists(x)), '')  # 0.7: crates/ became randomizer/
if os.path.exists(_sil):
    for n, ks in re.findall(r'\("([^"]+)",\s*&\[([\d,\s]+)\]\)', open(_sil).read()):
        ks = [k.strip() for k in ks.split(',') if k.strip()]
        if n in checks and not any(r.get('k') for r in det.get(n, [])): det.setdefault(n, []).append({'k': ks})
# The remake's own spots (OOTRR's free_remake.json and pots_remake.json: rupees, hearts, pots, crates the N64
# game doesn't have) aren't in the tracker targets, which file their objects under the N64 names instead. Their
# catalog entries carry the object's hash, which is the key the save sets on pickup (confirmed in a real save:
# Kokiri Forest Child Remake Rupee 5). Give each its key, and take the key away from any other check, so picking
# up one spot doesn't tick another.
_remake = {}
for _f in ('free_remake.json', 'pots_remake.json'):
    try: _j = json.load(open(os.path.join(D, _f)))
    except Exception: continue
    for _x in (_j.get('locations') if isinstance(_j, dict) else _j) or []:
        if isinstance(_x, dict) and _x.get('name') and _x.get('refs'): _remake.setdefault(_x['name'], _x)
_given = 0
for n, x in _remake.items():
    if n not in checks or any(r.get('k') for r in det.get(n, [])): continue
    ks = [str(r['hash']) for r in x['refs'] if r.get('hash')]
    if not ks: continue
    for o in list(det):
        if o == n: continue
        if not any(k in ks for r in det[o] for k in r.get('k') or []): continue
        rules = [{**r, 'k': [k for k in r['k'] if k not in ks]} if r.get('k') else r for r in det[o]]
        rules = [r for r in rules if r.get('k') or {kk: v for kk, v in r.items() if kk != 'k'}]  # drop only rules left empty
        if rules: det[o] = rules
        else: del det[o]
    det.setdefault(n, []).append({'k': ks}); _given += 1
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
    # 0.8: shops with one keeper (the potion shops, "once") take deals from their own room first (shops/layout.rs)
    POOLS['deals'] = {'order': [[k, n] for k, si, n in _order], 'once': sorted({n for k, si, n in _order if _sh['shops'][si].get('once')})}
    if os.path.exists('tools/out/deal_room.json'): POOLS['deals'] |= json.load(open('tools/out/deal_room.json'))
    # nightly (0.8.3): shops/rules.rs room() keeps every deal slot of the level, so the room is unlimited
    # (no deal_room.json: delete it when the OOTRR in use has no deal room)
    else: POOLS['deals'] |= {'base': 9999, 'delta': {}}
schema = [{k: s[k] for k in ('num', 'id', 'kind', 'default', 'wire', 'deps', 'min', 'max', 'step', 'times', 'max_by', 'disabled', 'label', 'group', 'tag') if k in s} | ({'choices': [c['id'] for c in s['choices']]} if 'choices' in s else {}) for s in SCH['settings']]
items = [[n, a] for n, a in L['items']]
# Map pins: OOTRR's map index, cut down to what the Map Tracker uses ({pins: hash -> [[map, u, v, floor, tray,
# x, z]], caps: map -> [x, z, size], floors: map -> {min, ys}}), so players don't need OOTRR's folder for them.
def map_index(path):
    j = json.load(open(path))
    pins, caps, floors = {}, {}, {}
    for m in j.get('maps') or []:
        if m.get('id') and isinstance(m.get('cap'), list): caps[m['id']] = m['cap']
        fl = m.get('floors')
        if m.get('id') and fl and fl.get('ys'): floors[m['id']] = {'min': int(fl.get('min') or 0), 'ys': fl['ys']}
    for l in j.get('locations') or []:
        h = str(l.get('id') or '').split(':')[-1]
        for p in l.get('pins') or []:
            if not (h and p and p.get('map')): continue
            pos = p.get('pos') if isinstance(p.get('pos'), list) else None
            pins.setdefault(h, []).append([p['map'], None if p.get('u') is None else round(p['u'], 4), None if p.get('v') is None else round(p['v'], 4), p.get('floor_label') or None, bool(p.get('tray')),
                                           round(pos[0], 2) if pos else None, round(pos[2], 2) if pos else None])
    return {'game': j.get('game'), 'pins': pins, 'caps': caps, 'floors': floors}
# OOTRR's web tracker's own NPC and reward flags (web/src/tracker/npc_flags.rs): OWN are confirmed in game,
# GUESS are its best guesses. A flag "Name=Value" holds when the save's value equals Value (a number, or the
# murmur3 hash of an enum name). The tracker adds these to each check's save rule.
def npc_flags(root):
    p = os.path.join(root, 'web', 'src', 'tracker', 'npc_flags.rs')
    if not os.path.exists(p): return None
    src = open(p, encoding='utf-8').read().split('pub fn ')[0]
    out = {}
    for part, conf in ((src.split('pub const GUESS')[0], 'own'), (src.split('pub const GUESS')[1] if 'pub const GUESS' in src else '', 'guess')):
        for name, body in re.findall(r'\(\s*"([^"]+)"\s*,\s*&\[([^\]]*)\]\s*\)', part):
            out[name] = {'f': re.findall(r'"([^"]+)"', body), 'conf': conf}
    return out
NPC_FLAGS = npc_flags(os.path.dirname(os.path.abspath(D)))
if NPC_FLAGS is None:
    try: NPC_FLAGS = json.load(open(os.path.join(os.path.dirname(__file__), '..', 'data', 'data.json'))).get('npc_flags')
    except Exception: NPC_FLAGS = None
# data/start_presets.json: save flags a setting turns on at new game (0.8: an open Gerudo Fortress plays the
# carpenters' clear event). The tracker doesn't take those as a check found: [setting, value, [flags]]
try:
    START_FLAGS = [[e['setting'], e['value'], [x['name'] for x in e.get('edits', []) if x.get('kind') == 'bool' and x.get('value') is True]]
                   for e in json.load(open(os.path.join(D, 'start_presets.json')))['presets']]
except FileNotFoundError: START_FLAGS = []
# 0.8.1 first_pickups.rs: Skip first pickup text marks each listed pickup's get event as shown at new game
_fp = [os.path.join(D, '..', 'randomizer', 'core', 'src', 'first_pickups.rs')]
for _p in _fp:
    if os.path.exists(_p):
        _t = open(_p).read()
        _set = re.search(r'pub const SETTING: &str = "([^"]+)"', _t).group(1)
        _list = re.search(r'pub const PICKUPS: \[&str; \d+\] = \[(.*?)\];', _t, re.S).group(1)
        START_FLAGS.append([_set, 'true', ['HavePlayedGetEvent.' + x for x in re.findall(r'"([^"]+)"', _list)]])
# 0.8.3 nightly area_intros.rs: Skip area intros marks each intro scene played and its area visited at new game
_ai = os.path.join(D, '..', 'randomizer', 'core', 'src', 'area_intros.rs')
if os.path.exists(_ai):
    _t = open(_ai).read()
    _set = re.search(r'pub const SETTING: &str = "([^"]+)"', _t).group(1)
    _rows = re.findall(r'\("([^"]+)", (?:Some\("([^"]+)"\)|None)\)', re.search(r'pub const INTROS.*?\];', _t, re.S).group(0))
    _fl = ['HavePlayedEvent.' + sc for sc, a in _rows] + sorted({'IsVisitLocation.' + a for sc, a in _rows if a})
    START_FLAGS.append([_set, 'true', _fl])
if len(sys.argv) > 2: MAP_INDEX = map_index(sys.argv[2])
else:
    try: MAP_INDEX = json.load(open(os.path.join(os.path.dirname(__file__), '..', 'data', 'data.json'))).get('map_index')
    except Exception: MAP_INDEX = None
out = {'generator': L['generator'], 'regions': base, 'patches': patches, 'helpers': helpers, 'groups': L['groups'], 'root': L['root'],
       'settings': L['settings'], 'items': items, 'vanilla': L['vanilla'], 'checks': checks, 'classic': classic, 'detect': det, 'maps': maps,
       'schema': schema, 'start_items': L['start_items'], 'item_actors': L['item_actors'], 'cow_flags': L['cow_flags'], 'entrances': L['entrances'], 'skull_notes': skull_notes, 'shop_rules': L['shop_rules'], 'labels': {s['id']: {c['id']: c['label'] for c in s.get('choices', [])} | {'_': s['label']} for s in SCH['settings']},
       # OOTRR's settings page: its groups (tabs), presets and the help text of each setting and choice
       # the remake calls it the Gerudo Proving Ground
       'tips': json.loads(json.dumps({s['id']: {c['id']: c['tip'] for c in s.get('choices', []) if c.get('tip')} | {'_': s.get('tip', '')} for s in SCH['settings']}).replace('Gerudo Training Ground', 'Gerudo Proving Ground')),
       'setting_groups': SCH['groups'], 'presets': SCH['presets'], 'pools': POOLS,
       # OOTRR's settings menu (pages, sections, its own labels and choices), minus the "not supported yet" stubs
       'map_index': MAP_INDEX, 'npc_flags': NPC_FLAGS, 'start_flags': START_FLAGS,
       'setting_menu': json.loads(json.dumps([{**pg, 'sections': [{**sc, 'items': [it for it in sc.get('items') or [{'id': i} for i in sc['ids']] if not it.get('stub')]}
                                                                 for sc in pg['sections']]} for pg in SCH['menu']]).replace('Gerudo Training Ground', 'Gerudo Proving Ground'))}
json.dump(out, open('data/data.json', 'w'), separators=(',', ':'))
print('detect', len(det), 'maps', len(maps), file=sys.stderr)
# the gossip stone hints (tools/hint_data.py): what each stone says comes from the seed, with these tables
import subprocess
subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hint_data.py'), os.path.join(D, '..')], check=True)
# what unshuffled locations hold, as OOTRR fills them (tools/remake_vanilla.py: the remake's own item first)
subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'remake_vanilla.py'), os.path.join(D, '..')], check=True)
# what each dungeon floor holds, for Link's floor (tools/floor_points.py)
subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'floor_points.py')], check=True)

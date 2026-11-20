"""How many special deals fit, per setting value: OOTRR caps the deal shelves at the number of items that can
stand on a shelf and still be spared (shops/rules.rs room), which other settings change. Generates a seed with
"4 special deals" plus each setting value (as pool_matrix.py does) and records the change in the number of deal
shelves. Writes tools/out/deal_room.json; then run build_data.py.

    python tools/deal_room.py <path to the ootrr CLI> [work folder]"""
import json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
here = os.path.dirname(os.path.abspath(__file__))
cli = sys.argv[1]
work = sys.argv[2] if len(sys.argv) > 2 else '/tmp/ootrr_room'
os.makedirs(work, exist_ok=True)
# Results are kept between runs to resume an interrupted one, but only for the same CLI build: a work
# folder left by another OOTRR version (or other jobs) would hand back that version's seeds.
_st = os.stat(cli); stamp = f"{os.path.abspath(cli)} {_st.st_size} {_st.st_mtime_ns}"
_sf = os.path.join(work, 'cli.stamp')
if not os.path.exists(_sf) or open(_sf).read() != stamp:
    for x in os.listdir(work): os.remove(os.path.join(work, x))
    open(_sf, 'w').write(stamp)
S = json.load(open(os.path.join(here, 'out', 'schema.json')))['settings']
by = {s['id']: s for s in S}
def deps(s, vals):
    for d in s['deps']:
        o = by[d['on']]
        if 'is' in d: vals[d['on']] = d['is']
        elif 'in' in d: vals[d['on']] = d['in'][0]
        elif 'not' in d: vals[d['on']] = [c['id'] for c in o['choices'] if c['id'] != d['not']][0]
        deps(o, vals)
    return vals
BASE = {'shuffle_shops': 'deals_4'}
jobs = [('base', dict(BASE))]
for s in S:
    if s['id'] in ('shuffle_shops',): continue
    if s['kind'] == 'choice': vals = [c['id'] for c in s['choices'] if c['id'] != s['default']]
    elif s['kind'] == 'toggle': vals = [not s['default']]
    else: vals = []
    d = {**deps(s, dict(BASE)), **BASE}  # a setting that depends on shop deals keeps the 4-deal baseline
    for v in vals: jobs.append((f"{s['id']}={json.dumps(v)}", {**d, s['id']: v}))
def run(i):
    name, st = jobs[i]
    f = os.path.join(work, str(i))
    body = json.dumps({'id': 'v', 'name': 'v', 'tip': 'v', 'order': 99, 'settings': st})
    if not (os.path.exists(f + '.json') and open(f + '.json').read() == body) or not (os.path.exists(f + '.out')):
        for x in ('.ootrr', '.err', '.out'):
            if os.path.exists(f + x): os.remove(f + x)
        open(f + '.json', 'w').write(body)
        r = subprocess.run([cli, 'generate', f + '.json', '7', f + '.ootrr'], capture_output=True, text=True)
        open(f + '.out', 'w').write(('OK\n' if r.returncode == 0 else 'ERR\n') + r.stdout + r.stderr)
    return f
with ThreadPoolExecutor(os.cpu_count() or 2) as ex: files = list(ex.map(run, range(len(jobs))))
r = subprocess.run(['node', '-e', '''
const Seed = require(process.argv[1]), fs = require("fs"), DATA = JSON.parse(fs.readFileSync(process.argv[2]));
const out = {};
for (const f of JSON.parse(process.argv[3])) out[f] = fs.existsSync(f + ".ootrr") && fs.readFileSync(f + ".out", "utf8").startsWith("OK") ? Object.keys(Seed.parseFile(fs.readFileSync(f + ".ootrr"), DATA).placements).filter((n) => DATA.checks[n] && DATA.checks[n][1] === "shop").length : null;
process.stdout.write(JSON.stringify(out));''', os.path.join(here, '..', 'src', 'seed.js'), os.path.join(here, '..', 'data', 'data.json'), json.dumps(files)], capture_output=True, text=True, check=True)
got = json.loads(r.stdout)
n = {jobs[i][0]: got[f] for i, f in enumerate(files)}
base = n['base']
delta = {}
for name, c in n.items():
    if name == 'base' or c is None or c == base: continue
    sid, val = name.split('=', 1)
    delta.setdefault(sid, {})[val] = c - base
json.dump({'base': base, 'delta': delta}, open(os.path.join(here, 'out', 'deal_room.json'), 'w'), indent=0)
print('base', base, delta)

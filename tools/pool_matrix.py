"""Measures which locations each OOTRR setting adds to or takes from the shuffle, with OOTRR's own generator,
for the tracker's manual settings (no seed loaded). Writes tools/out/pools.json; then run build_data.py.

    python tools/pool_matrix.py <path to the ootrr CLI> [work folder]

Every choice and toggle value (and each item of the deal items and hint lists) is generated once from the
defaults, with the settings it depends on switched on; the locations that differ from the generated seed with
only those dependencies (or from the default seed) are that value's delta. Values the generator refuses
(not built yet in this OOTRR version) are listed as unsupported."""
import json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
here = os.path.dirname(os.path.abspath(__file__))
cli = sys.argv[1]
work = sys.argv[2] if len(sys.argv) > 2 else '/tmp/ootrr_pools'
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

jobs = [('base', {})]
for s in S:
    if s['kind'] == 'choice': vals = [c['id'] for c in s['choices'] if c['id'] != s['default']]
    elif s['kind'] == 'toggle': vals = [not s['default']]
    elif s['kind'] == 'multi' and s['id'] in ('misc_hints',): vals = [[c['id']] for c in s['choices']]
    else: vals = []
    d = deps(s, {})
    if d: jobs.append((f"{s['id']}=DEPS", dict(d)))
    for v in vals: jobs.append((f"{s['id']}={json.dumps(v)}", {**d, s['id']: v}))

def run(i):
    name, st = jobs[i]
    f = os.path.join(work, str(i))
    body = json.dumps({'id': 'v', 'name': 'v', 'tip': 'v', 'order': 99, 'settings': st})
    if not (os.path.exists(f + '.json') and open(f + '.json').read() == body) or not (os.path.exists(f + '.ootrr') or os.path.exists(f + '.err')):
        for x in ('.ootrr', '.err', '.out'):
            if os.path.exists(f + x): os.remove(f + x)
        open(f + '.json', 'w').write(body)
        r = subprocess.run([cli, 'generate', f + '.json', '7', f + '.ootrr'], capture_output=True, text=True)
        if r.returncode: open(f + '.err', 'w').write((r.stdout + r.stderr).strip().splitlines()[-1])
    return f

with ThreadPoolExecutor(os.cpu_count() or 2) as ex: files = list(ex.map(run, range(len(jobs))))
# placements of each generated seed, read with the tracker's own seed reader
r = subprocess.run(['node', '-e', '''
const Seed = require(process.argv[1]), fs = require("fs"), DATA = JSON.parse(fs.readFileSync(process.argv[2]));
const out = {};
for (const f of JSON.parse(process.argv[3])) out[f] = fs.existsSync(f + ".ootrr") ? Object.keys(Seed.parseFile(fs.readFileSync(f + ".ootrr"), DATA).placements) : null;
process.stdout.write(JSON.stringify(out));''', os.path.join(here, '..', 'src', 'seed.js'), os.path.join(here, '..', 'data', 'data.json'), json.dumps(files)], capture_output=True, text=True, check=True)
got = json.loads(r.stdout)
keys = {jobs[i][0]: got[f] for i, f in enumerate(files)}
base = sorted(keys['base'])
deltas, unsupported = {}, {}
for i, (name, st) in enumerate(jobs):
    if name == 'base' or name.endswith('=DEPS'): continue
    sid, val = name.split('=', 1)
    if keys[name] is None:
        unsupported.setdefault(sid, []).append(json.loads(val))
        continue
    ref = set(keys.get(f'{sid}=DEPS') or base)
    v = set(keys[name])
    add, rem = sorted(v - ref), sorted(ref - v)
    if add or rem: deltas.setdefault(sid, {})[val] = [add, rem]
json.dump({'base': base, 'deltas': deltas, 'unsupported': unsupported}, open(os.path.join(here, 'out', 'pools.json'), 'w'), indent=0)
print('base', len(base), 'deltas', sum(len(x) for x in deltas.values()), 'unsupported', sum(len(x) for x in unsupported.values()))

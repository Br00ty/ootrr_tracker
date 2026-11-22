// Reading .ootrr seed files, ported from ootrando/ootrr 0.8.2:
// settings/seed.rs (file), settings/codec.rs + settings/string.rs (settings string), settings/state.rs
// (dependencies), slice/support.rs Plan::logic (which logic switches a seed turns on), start_items/give.rs.
const Seed = (() => {
  "use strict";
  const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  function b32decode(t) {
    const out = [];
    let acc = 0, n = 0;
    for (const ch of t) {
      if (ch === "-" || /\s/.test(ch)) continue;
      const v = ALPHA.indexOf(ch.toUpperCase());
      if (v < 0) throw new Error("the settings string has a character outside its alphabet");
      acc = (acc << 5) | v; n += 5;
      if (n >= 8) { n -= 8; out.push((acc >> n) & 0xff); acc &= (1 << n) - 1; }
    }
    if (n >= 5 || acc !== 0) throw new Error("the settings string has a bad length");
    return Uint8Array.from(out);
  }

  class Rd {
    constructor(b) { this.b = b; this.i = 0; }
    left() { return this.b.length - this.i; }
    done() { return this.i >= this.b.length; }
    varint() {
      let n = 0n;
      for (let k = 0n; k < 10n; k++) {
        if (this.i >= this.b.length) throw new Error("the settings string is truncated");
        const c = this.b[this.i++];
        n |= BigInt(c & 0x7f) << (7n * k);
        if (!(c & 0x80)) return n;
      }
      throw new Error("the settings string has an oversized number");
    }
    take(n) { if (n > this.left()) throw new Error("the settings string is truncated"); const s = this.b.subarray(this.i, this.i + n); this.i += n; return s; }
  }
  const unzig = (n) => Number((n >> 1n) ^ -(n & 1n));

  // murmur3_32 over bytes, for the string's 2-byte check tag
  function murmur(b, seed) {
    let h = seed >>> 0;
    const n = b.length, nb = n & ~3, c1 = 0xcc9e2d51, c2 = 0x1b873593;
    for (let i = 0; i < nb; i += 4) {
      let k = b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
      k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2);
      h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    }
    let k = 0;
    switch (n & 3) {
      case 3: k ^= b[nb + 2] << 16;
      case 2: k ^= b[nb + 1] << 8;
      case 1: k ^= b[nb]; k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2); h ^= k;
    }
    h ^= n; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
  }

  function holds(dep, v) {
    if ("is" in dep) return JSON.stringify(v) === JSON.stringify(dep.is);
    if ("not" in dep) return JSON.stringify(v) !== JSON.stringify(dep.not);
    if ("in" in dep) return dep.in.some((x) => JSON.stringify(x) === JSON.stringify(v));
    return true;
  }
  const enabled = (s, vals) => (s.deps || []).every((d) => d.on in vals && holds(d, vals[d.on]));

  // Schema::decode
  // Choice lists a setting had before 0.8, which a settings string's choice numbers point into
  // (0.8 dropped Kokiri Forest's Closed Deku and Kakariko's old Closed, and renamed Zelda's Letter to Closed)
  const OLD_CHOICES = { open_forest: ["open", "closed_deku", "closed"], open_kakariko: ["open", "closed", "closed"] };
  function decodeSettings(text, schema, legacy, gen) {
    const m = /^OOTRR(\d+)-(.*)$/i.exec(text.trim());
    if (!m) throw new Error("the settings string must start with OOTRR and a version");
    if (m[1] !== "1") throw new Error(`settings string version ${m[1]} is newer than this tracker understands`);
    const all = b32decode(m[2]);
    if (all.length < 2) throw new Error("the settings string is too short");
    const body = all.subarray(0, all.length - 2);
    const h = murmur(body, 0x4f4f5452), tag = ((h ^ (h >>> 16)) & 0xffff);
    if (((all[all.length - 2] << 8) | all[all.length - 1]) !== tag) throw new Error("the settings string checksum does not match");
    const byNum = new Map(schema.map((s) => [s.num, s]));
    const vals = {}, warn = [], given = {};
    for (const s of schema) vals[s.id] = s.wire;
    const r = new Rd(body);
    while (!r.done()) {
      const num = Number(r.varint()), len = Number(r.varint());
      const p = new Rd(r.take(len));
      const s = byNum.get(num);
      if (!s) { warn.push(RETIRED[num] ? `retired:${RETIRED[num]}` : `unknown setting number ${num} ignored`); continue; }
      let v;
      switch (s.kind) {
        case "toggle": v = p.take(1)[0] === 1; break;
        case "choice": { const i = Number(p.varint()); v = (legacy && OLD_CHOICES[s.id] || s.choices)[i]; if (v === undefined) { warn.push(`${s.id}: unknown choice ${i}`); continue; } break; }
        case "number": v = unzig(p.varint()); break;
        case "multi": { const c = Number(p.varint()); v = []; for (let i = 0; i < c; i++) { const x = s.choices[Number(p.varint())]; if (x !== undefined) v.push(x); } break; }
        case "list": { const c = Number(p.varint()); v = []; for (let i = 0; i < c; i++) { const l = Number(p.varint()); v.push(new TextDecoder().decode(p.take(l))); } break; }
        default: warn.push(`${s.id}: unknown kind ${s.kind}`); continue;
      }
      vals[s.id] = v; given[s.id] = true;
    }
    // door_gate.rs legacy(): the old Open Door of Time toggle becomes Door of Time = Open
    // (0.8.1: only when the string doesn't also choose a Door of Time; older generators always moved it)
    const chosen = !before(gen, [0, 8, 1]) && Object.prototype.hasOwnProperty.call(given, "door_of_time_condition");
    if (vals.open_door_of_time === true) { vals.open_door_of_time = false; if (!chosen) vals.door_of_time_condition = "open"; }
    // Schema::normalize: a setting whose dependency does not hold takes its off value
    for (const s of schema) if (!enabled(s, vals)) vals[s.id] = "disabled" in s ? s.disabled : s.default;
    return { vals, warn };
  }

  // settings/list.rs RETIRED: settings OOTRR has removed, which older seeds still carry (0.6.2)
  const RETIRED = { 127: "Zora's Domain ambush", 128: "Bean Seller's sales pitch", 106: "Short item get text", 130: "Special encounters", 55: "Remake chests", 59: "Shop prices", 60: "Shop price max", 61: "Shop price min", 62: "Shop deal items", 63: "Shop deal gear", 92: "Remake only pots" };
  // one plain note for the retired settings a seed carries, in place of a line each
  function retiredNote(warn, generator) {
    const old = warn.filter((w) => w.startsWith("retired:")).map((w) => w.slice(8));
    if (!old.length) return warn;
    return [...warn.filter((w) => !w.startsWith("retired:")),
      `made with ${generator || "an older OOTRR"}: ${old.join(", ")} ${old.length > 1 ? "are settings" : "is a setting"} OOTRR has since removed, so the tracker follows what the seed placed`];
  }

  // slice/support.rs Plan::logic, with the pieces it reads (open_world.rs, qol.rs, pot_slice/plan.rs …)
  // legacy: a seed made before 0.8 (see isLegacy), whose logic had none of 0.8's new switches
  // gen: the seed's generator line, for the few switches that changed meaning between 0.8 versions
  function logicSwitches(v, legacy, gen) {
    const out = [];
    if (v.open_forest === "closed_deku") out.push(["open_forest", "closed_deku"]);
    if (v.open_forest === "open") out.push(["open_forest", "open"]);
    if (doorOpen(v)) out.push(["open_door_of_time", "open"]);
    if (["any_dungeon", "keysanity", "overworld", "regional"].includes(v.shuffle_smallkeys))
      for (const k of ["fire_key_layout", "water_key_layout", "spirit_key_layout"]) out.push([k, "shuffled"]);
    if (v.bombchus_in_logic === true) out.push(["free_bombchu_drops", "true"]);
    if (kakarikoSkip(v)) { out.push(["open_kakariko", "open"]); out.push(["skip_child_zelda", "true"]); }
    if (v.anju_one_cucco === true) out.push(["chicken_count", "1"]);
    if (v.big_poe_one === true) out.push(["big_poe_count", "1"]);
    if (v.zora_fountain === "open") out.push(["zora_fountain", "open"]);
    if (v.jabu_open === true) out.push(["jabu_open", "1"]);
    if (v.time_always_passes === false) out.push(["time_always_passes", "0"]);
    if (v.skip_mask_quest === true) out.push(["complete_mask_quest", "1"]);
    if (v.plant_beans === true) out.push(["plant_beans", "1"]);
    if (v.gerudo_bridge_open === true) out.push(["gerudo_bridge_open", "1"]);
    if (v.shuffle_skulltulas && v.shuffle_skulltulas !== "off") out.push(["skull_rules", "strict"]);
    if ((v.shuffle_rocks && v.shuffle_rocks !== "off") || (v.shuffle_grass && v.shuffle_grass !== "off")) out.push(["rock_spots", "on"]);
    // 0.6.2: the remake-only pots and crates come with shuffled pots or crates (pot_slice/plan.rs with_remake),
    // and the remake-only freestanding spots with Dungeons, Overworld or All (slice/pickups.rs Free::remake)
    if ((v.shuffle_pots && v.shuffle_pots !== "off") || (v.shuffle_crates && v.shuffle_crates !== "off")) out.push(["remake_pot_spots", "on"]);
    if (["all", "dungeons", "overworld"].includes(v.shuffle_freestanding_items)) out.push(["free_remake_spots", "on"]);
    // 0.7: shuffled shops open the Bombchu Shop before King Dodongo (shops/door.rs)
    if (v.shuffle_shops && v.shuffle_shops !== "off") out.push(["bombchu_shop_open", "true"]);
    const rewards = v.shuffle_rewards === "supported";
    // 0.7: Dungeon Rewards became Vanilla / Anywhere / End of dungeons (flow_extra.rs Rewards::read)
    if (rewards && ["anywhere", "dungeons"].includes(dungeonRewards(v))) out.push(["medallion_gates", "true"]);
    // 0.7: the LACS key option and a Dungeon rewards bridge count Stones and Medallions (medal_gate.rs, rainbow_bridge.rs)
    if (v.shuffle_ganon_bosskey === "lacs_dungeons") { out.push(["lacs_condition", "dungeons"]); out.push(["lacs_rewards", String(Math.max(1, Math.min(9, +(v.lacs_rewards ?? 9))))]); }
    if (v.bridge === "dungeons") { out.push(["bridge", "dungeons"]); out.push(["bridge_rewards", String(Math.max(0, Math.min(9, +(v.bridge_rewards ?? 9))))]); }
    if (rewards && v.shuffle_potion_shop === true) out.push(["potion_shop_checks", "on"]);
    if (legacy) return out;
    // 0.8 open_world.rs Opts::logic: Skip Epona's race (on by default) and the Gerudo Fortress choice
    if (v.skip_epona_race !== false) out.push(["skip_epona_race", "1"]);
    if (v.gerudo_fortress === "fast" || v.gerudo_fortress === "open") out.push(["gerudo_fortress", v.gerudo_fortress]);
    // 0.8 ganon_trials.rs Trials::logic: any n of the six trials (Skip = 0)
    const trials = v.skip_ganon_trials === true ? 0 : Math.max(0, Math.min(6, +(v.trials ?? 6)));
    if (trials !== 6) out.push(["trials", String(trials)]);
    // 0.8 door_gate.rs Opts::logic (read with the door's open flag from open_world.rs Gates::read)
    const open = doorOpen(v), cond = v.door_of_time_condition || "vanilla";
    const only = !open && cond === "song", own = open || only;
    const need = own ? (v.door_of_time_escape ?? "moat") : cond;
    if (need === "stones") out.push(["door_of_time_condition", "stones"]);
    if (own && (v.door_of_time_escape ?? "moat") === "moat") out.push(["door_of_time_escape", "moat"]);
    if (only) out.push(["open_door_of_time", "sot"]);
    // Song of Time not required: 0.8.1 opens the door as soon as the requirement is met ("req"); 0.8.0 opened it
    // after Zelda's escape ("stones", the requirement plus the castle garden)
    else if (!open && v.door_of_time_song === false) out.push(["open_door_of_time", before(gen, [0, 8, 1]) ? "stones" : "req"]);
    // 0.8.2 prelude_gate.rs: Prelude Trigger = Classic, Sheik teaches the Prelude once you hold the Forest Medallion
    if (v.prelude_trigger === "classic") out.push(["prelude_medallion", "true"]);
    // 0.8.3 nightly slice/skull_day.rs: Skulltulas by day, the logic no longer waits for night (the first nightly,
    // 20261122.1, has it but still calls itself "ootrr-core 0.8.2", so this isn't gated on the version)
    if (v.skulls_by_day === true) out.push(["gold_skulls_ignore_daytime", "true"]);
    if (before(gen, [0, 8, 3])) return out;
    // 0.8.3 nightly (20261122.3) open_world/trade.rs LOGIC: the adult trade items never spoil or revert, always
    out.push(["disable_trade_revert", "true"]);
    return out;
  }
  // open_world.rs Gates::read: the old toggle or Door of Time = Open (door_gate.rs legacy moves the toggle there)
  function doorOpen(v) { return v.open_door_of_time === true || v.door_of_time_condition === "open"; }
  // seeds from before 0.8 keep the switches their own version used (the generator line reads "ootrr-core 0.7.3")
  function isLegacy(generator) { return before(generator, [0, 8, 0]); }
  // whether a seed's generator ("ootrr-core 0.8.0") is older than version v; no version reads as current
  function before(generator, v) {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(generator || ""));
    if (!m) return false;
    for (let i = 0; i < 3; i++) if (+m[i + 1] !== v[i]) return +m[i + 1] < v[i];
    return false;
  }

  // logic_val: spec() sets each switch as an integer when it parses as one, otherwise as text
  function applySwitches(base, sw) {
    const s = { ...base };
    for (const [k, v] of sw) s[k] = /^-?\d+$/.test(v) ? parseInt(v, 10) : v;
    return s;
  }
  const PATCHED = ["rock_spots=on", "remake_pot_spots=on", "free_remake_spots=on", "skull_rules=strict", "potion_shop_checks=on"];
  const patchesOf = (sw) => sw.map(([k, v]) => `${k}=${v}`).filter((x) => PATCHED.includes(x));
  // A seed that places items in checks only a logic patch adds needs that patch, whatever its settings
  // say: seeds from an older OOTRR can carry a setting this version retired (0.6.0's shuffle_remake_pots).
  function withPlacedPatches(sw, placements, data) {
    const out = sw.slice(), have = new Set(sw.map(([k, v]) => `${k}=${v}`));
    for (const key of PATCHED) {
      if (have.has(key)) continue;
      const p = (data.patches || {})[key] || {};
      // only locations the patch adds count: 0.8 shop deals can fill Potion Shop shelves the base logic already has
      const base = new Set((data.regions || []).flatMap((r) => Object.keys(r.l || {})));
      if (Object.values(p).some((d) => Object.keys(d.l || {}).some((l) => l in placements && !base.has(l)))) { const i = key.indexOf("="); out.push([key.slice(0, i), key.slice(i + 1)]); }
    }
    return out;
  }

  // start_items/give.rs: each chosen item or song, as the logic counts it
  // slice/support.rs plan(): an open Kakariko gate skips child Zelda's story (unless the forest is closed),
  // and start_state.rs KAKARIKO_LOCATIONS' items are handed out at new game instead of in the world.
  const KAKARIKO_LOCATIONS = ["HC Zeldas Letter", "Song from Impa"];
  // 0.7.2: an open Kakariko gate needs Kokiri Forest fully open (settings/list.rs: Closed Deku locks it to Zelda's Letter)
  function kakarikoSkip(v) { return v.open_kakariko === "open" && v.open_forest === "open"; }
  // Dungeon Rewards was a toggle before 0.7 (off = vanilla, on = anywhere), as old manual settings still store it
  function dungeonRewards(v) { const x = v.shuffle_dungeon_rewards; return x === true ? "anywhere" : x === false || x == null ? "vanilla" : x; }
  function startItems(v, table) {
    const out = {};
    for (const id of v.starting_items || []) for (const [n, c] of table[`starting_items:${id}`] || []) out[n] = Math.max(out[n] || 0, c);
    for (const id of v.starting_songs || []) for (const [n, c] of table[`starting_songs:${id}`] || []) out[n] = (out[n] || 0) + c;
    if (typeof v.starting_hearts === "number" && v.starting_hearts > 3) out["Piece of Heart"] = (v.starting_hearts - 3) * 4;
    // 0.8 slice/support.rs plan(): an open Gerudo Fortress starts with the Membership Card
    if (v.gerudo_fortress === "open") for (const [n, c] of table["starting_items:gerudo_card"] || []) out[n] = Math.max(out[n] || 0, c);
    return out;
  }

  // the items of the skipped story's checks count as starting items
  function withSkipped(start, vals, placements) {
    if (!kakarikoSkip(vals)) return start;
    const out = { ...start };
    for (const l of KAKARIKO_LOCATIONS) { const it = placements[l]; if (it) out[it] = (out[it] || 0) + 1; }
    return out;
  }

  // settings/seed.rs SeedFile::from_json (the parts the tracker uses)
  // Seeds from OOTRR 0.8.2 data (0.8.2 itself and the first nightly, 0.8.3-nightly.20261122.1, which still says
  // "ootrr-core 0.8.2") on a tracker built from the 0.8.3 nightly's data: OOTRR renamed two checks and moved three
  // pairs of names to each other's objects there. The seed wrote each item to the object its own data named, so
  // the placements follow the objects: renamed, and swapped where the names swapped.
  const OLD_DATA_RENAMES = { "HF Lake Poe Chest": "LH Poe Chest", "HF Tunnel Ledge Chest": "LLR Tunnel Ledge Chest" };
  const OLD_DATA_SWAPS = [["Dodongos Cavern GS Alcove Above Stairs", "Dodongos Cavern GS Back Room"], ["Kak GS Tree", "Kak GS House Under Construction"], ["GC Maze Center Chest", "GC Maze Right Chest"]];
  function upgradePlacements(pl, data) {
    if (!pl || !Object.keys(OLD_DATA_RENAMES).some((o) => o in pl && !data.checks[o] && data.checks[OLD_DATA_RENAMES[o]])) return pl;
    const out = {};
    for (const [n, it] of Object.entries(pl)) out[OLD_DATA_RENAMES[n] && !data.checks[n] ? OLD_DATA_RENAMES[n] : n] = it;
    for (const [a, b] of OLD_DATA_SWAPS) { const x = out[a], y = out[b]; delete out[a]; delete out[b]; if (x !== undefined) out[b] = x; if (y !== undefined) out[a] = y; }
    return out;
  }
  function parseFile(text, data) {
    let j;
    try { j = JSON.parse(text); } catch (e) { throw new Error("this is not a seed file (not JSON)"); }
    if (!j || j.format !== "ootrr-seed") throw new Error("this is not an ootrr seed file");
    if (j.version !== 1) throw new Error(`seed file version ${j.version} is newer than this tracker understands`);
    if (typeof j.settings !== "string" || !j.placements || typeof j.placements !== "object") throw new Error("the seed file has no settings or placements");
    const legacy = isLegacy(j.generator);
    j.placements = upgradePlacements(j.placements, data);
    const { vals, warn } = decodeSettings(j.settings, data.schema, legacy, j.generator);
    const sw = withPlacedPatches(logicSwitches(vals, legacy, j.generator), j.placements, data);
    return {
      seed: String(j.seed || ""), generator: String(j.generator || ""), settingsString: j.settings, game: String(j.game || ""),
      placements: j.placements, shops: j.shops || {}, entrances: j.entrances || {},
      vals, warn: retiredNote(warn, String(j.generator || "")), switches: sw, start: withSkipped(startItems(vals, data.start_items), vals, j.placements), skipped: kakarikoSkip(vals) ? KAKARIKO_LOCATIONS.filter((l) => l in j.placements) : [],
    };
  }

  // entr/logic.rs wire(): the seed's entrances map says which dungeon is behind each dungeon door
  // ({ door: dungeon }, names from entr/pools.rs). The door's way in leads to that dungeon's first room,
  // and that dungeon's way out leads back outside the door. pool: data.entrances,
  // rows [door, area, entry from, entry to, exit from, exit to]. Returns the layout { door: dungeon }.
  function applyEntrances(w, pool, map) {
    const lay = {};
    if (!pool || !map || !Object.keys(map).length) return lay;
    const row = new Map(pool.map((r) => [r[0].toLowerCase(), r]));
    const ex = new Map(w.exits.map((x, i) => [x.name, i]));
    const exit = (a, b) => { const i = ex.get(`${a} -> ${b}`); if (i === undefined) throw new Error(`the logic has no exit ${a} -> ${b}`); return i; };
    const reg = (n) => { const i = w.rix.get(n); if (i === undefined) throw new Error(`the logic has no region ${n}`); return i; };
    const seen = new Set();
    for (const [door, dun] of Object.entries(map)) {
      const s = row.get(door.toLowerCase()), d = row.get(String(dun).toLowerCase());
      if (!s || !d) throw new Error(`the seed moves an entrance the tracker doesn't know: ${door} → ${dun}`);
      if (seen.has(d[0])) throw new Error(`the seed puts ${d[0]} behind two doors`);
      seen.add(d[0]); lay[s[0]] = d[0];
    }
    // every door not named keeps its own dungeon (Layout::from_map)
    for (const r of pool) if (!(r[0] in lay)) { if (seen.has(r[0])) throw new Error(`the seed puts ${r[0]} behind two doors`); lay[r[0]] = r[0]; }
    const moves = Object.entries(lay).map(([door, dun]) => [row.get(door.toLowerCase()), row.get(dun.toLowerCase())]).map(([s, d]) => [exit(s[2], s[3]), reg(d[3]), exit(d[4], d[5]), reg(s[5])]);
    for (const [entry, inner, out, outer] of moves) { w.exits[entry].to = inner; w.exits[out].to = outer; }
    return lay;
  }

  // Corrections the tracker makes to OOTRR's logic (still needed in 0.8.2), where it lets you do something the game doesn't.
  // vals: the seed's (or manual) setting values. Returns a copy of data for Engine.buildWorld.
  //  1. Shops left vanilla: OOTRR adds a shop item's own requirements (a bottle for potions, fish, bugs,
  //     Poes, fairies and Blue Fire; a wallet for the price; its bomb rule for Bombchus) only when shops are
  //     shuffled (shops/logic.rs extra()). Without them the logic buys Bugs with no bottle and plants them
  //     at the bean patch Gold Skulltulas. The same rules, from OOTRR's own table, apply to the vanilla shelves.
  //  2. "Bombchus in logic (experimental)": Bombchus count without a Bomb Bag, which OOTRR's own note says
  //     didn't work in its test; the game needs a Bomb Bag. found_bombchus asks for one.
  const FIXES = [
    "Shop items that need a bottle, a bigger wallet or OOTRR's Bombchu rule require them on every shelf that keeps its normal item (OOTRR only adds these to shuffled shelves), so Bugs from a Potion Shop need a bottle.",
    "Bombchus need a Bomb Bag, even with Bombchus in logic (experimental) on.",
    "GC Rolling Goron as Adult is adult only: OOTRR's rule only asks that he was stopped, so it let child collect the prize too.",
    "Kak Anju Trade Pocket Cucco is adult only: OOTRR's rule is the 'Cojiro Access' event, which either age can use once it has happened.",
    "LW Trade Cojiro and LW Trade Odd Potion are adult only: OOTRR's rules are trade events ('Odd Mushroom Access', 'Poachers Saw Access') either age can use once they have happened.",
    "Adult trade quest checks need the trade item you hand in there (Pocket Egg, Cojiro, Odd Mushroom, Odd Potion, Poacher's Saw, Broken Sword, Prescription, Eyeball Frog, Eyedrops), found or marked: OOTRR's logic assumes the chain from the vanilla trades.",
    "KF West Ledge Chest can also be reached by adult Link from a magic bean plant, not only with the Hookshot. The chest itself sits on a ledge in the Lost Woods.",
    "DMC Central Local Remake Rupee 1 and 4 need the Longshot (adult Link); OOTRR has them with no requirement.",
    "HF East Rupee Grotto Rupee 1-3 (OOTRR: Lake Hylia Remake Rupee 1-3) are in a grotto you open with an explosive or the Megaton Hammer; OOTRR has them with no requirement.",
    "Market Bombchu Bowling Bombchus needs nothing: the alley lends you its own Bombchus. OOTRR asks for Bombchus of your own (found_bombchus).",
    "Fire Temple: Hover Boots cross from the first room to the boss door (as in the original randomizer); OOTRR 0.8.2 only reaches it from the top floor with all eight keys.",
    "Bottom of the Well Basement Silver Rupee Behind Rocks (OOTRR: ... Ladders Top) is behind rocks you blow up, so it needs explosives. OOTRR has it with no requirement.",
    "ZR GS Tree is past the boulders at the river's entrance, so it needs a way into Zora's River (OOTRR has it in ZR Front, before them).",
  ];
  // rules the tracker uses instead of OOTRR's (confirmed in game)
  const OWN_RULES = {
    // confirmed in game: adult can also ride a bean plant up to it (OOTRR: Hookshot only)
    "KF West Ledge Chest": "can_use(Hookshot) or (is_adult and here(can_plant_bean))",
    // confirmed in game 2026-11-19: both need the Hookshot (OOTRR: True)
    "DMC Central Local Remake Rupee 1": "can_use(Longshot)",
    "DMC Central Local Remake Rupee 4": "can_use(Longshot)",
    // HF East Rupee Grotto Rupee 1-3: in a grotto blown open with an explosive (confirmed in game 2026-11-19);
    // same rule as OOTRR's other bombable field grottos (HF Southeast / Near Market / Fairy Grotto). OOTRR: True
    "Lake Hylia Remake Rupee 1": "can_blast_or_smash",
    "Lake Hylia Remake Rupee 2": "can_blast_or_smash",
    "Lake Hylia Remake Rupee 3": "can_blast_or_smash",
    // confirmed in game 2026-11-21: won with the game's rental Bombchus and no Bomb Bag or Bombchus of your own
    // (OOTRR: found_bombchus; in 0.8 the alley is open from the start, the First and Second Prize are already True)
    "Market Bombchu Bowling Bombchus": "True",
    // 2026-11-21, the user: this silver rupee is behind rocks that need an explosive (shown as ... Behind Rocks)
    "Bottom of the Well Basement Silver Rupee Ladders Top": "has_explosives",
    // (HF Tektite Grotto Freestanding PoH: the 0.8.3 nightly has its own rule now, is_adult in Hyrule Field; the
    // tracker follows OOTRR's updated logic, the user's call 2026-11-22)
  };
  // ways between regions the tracker adds to OOTRR's (an existing way gets "or" the new rule)
  const EXTRA_EXITS = {
    // 2026-11-22, confirmed by the user: Volvagia showed out of logic with the Boss Key, Hammer, Goron Tunic and Hover Boots
    // in hand. OOTRR 0.8.2's rebuilt Fire Temple reaches the boss door only from the top floor (all 8 keys, then
    // the Hammer pillar); the original randomizer also lets Hover Boots cross from the first room to the boss door.
    "Fire Temple Near Boss": { "Fire Temple Before Boss": "can_use(Hover_Boots)" },
  };
  // checks the tracker puts in another region than OOTRR (the rule is kept, read there)
  const MOVE_REGION = {
    // 2026-11-21, the user: the tree is in Zora's River past the boulders at its entrance, so it needs a way into
    // Zora River itself (OOTRR: ZR Front, before the boulders, which is open from Hyrule Field)
    "ZR GS Tree": "Zora River",
    // (HF Tektite Grotto Freestanding PoH: the 0.8.3 nightly has it in Hyrule Field itself)
  };
  // checks that need something more for one age (added to OOTRR's rule)
  const AGE_EXTRA = {
    // 2026-11-21, the user: an adult trade check is only in logic once you have (or had) the trade item you hand in
    // there. OOTRR's rules are 'X Access' events the logic gets from the vanilla chain, so a later trade showed as
    // reachable before its item was found. The Pocket Cucco hatches from the Pocket Egg (one tracker item).
    "Kak Anju Trade Pocket Cucco": "Pocket_Egg",
    "LW Trade Cojiro": "Cojiro",
    "Kak Granny Trade Odd Mushroom": "Odd_Mushroom",
    "LW Trade Odd Potion": "Odd_Potion",
    "GV Trade Poachers Saw": "Poachers_Saw",
    "DMT Trade Broken Sword": "Broken_Sword",
    "ZD Trade Prescription": "Prescription",
    "LH Trade Eyeball Frog": "Eyeball_Frog",
    "DMT Trade Eyedrops": "Eyedrops",
    // (Spirit Temple GS Sun on Floor Room: in the 0.8.3 nightly child Spirit itself needs explosives, so OOTRR's
    // updated logic covers it)
  };
  // checks only one age can collect, though OOTRR's rule is an event either age could use once it happened
  const AGE_ONLY = {
    "GC Rolling Goron as Adult": "is_adult",
    // confirmed by the user 2026-11-21: Anju hands over the Pocket Cucco to adult Link only (OOTRR: 'Cojiro Access')
    "Kak Anju Trade Pocket Cucco": "is_adult",
    // confirmed by the user 2026-11-21: both Lost Woods trades are adult only (OOTRR: 'Odd Mushroom Access' and
    // 'Poachers Saw Access', events either age can use once they happened)
    "LW Trade Cojiro": "is_adult",
    "LW Trade Odd Potion": "is_adult",
  };
  // placed: the seed's shuffled locations. A shelf the seed shuffles holds another item, so its vanilla
  // requirement is left off; every other shelf keeps its vanilla item and gets that item's requirement,
  // whether or not shops are shuffled (with shop deals on, most shelves stay vanilla).
  // shops: the seed's shelves ({ loc: { item, price, deal } }). A shuffled shelf (a deal) needs the wallet
  // for its price, as OOTRR's extra() asks (shops/price.rs rule(): over 200 Adult's, over 500 Giant's Wallet).
  function priceRule(p) { return p > 500 ? "(Progressive_Wallet, 2)" : p > 200 ? "Progressive_Wallet" : null; }
  function withFixes(data, vals, placed, shops) {
    const helpers = { ...data.helpers };
    if (helpers.found_bombchus) helpers.found_bombchus = `Bomb_Bag and (${helpers.found_bombchus})`;
    if (helpers.has_bombchus) helpers.has_bombchus = `Bomb_Bag and (${helpers.has_bombchus})`;
    const loc_fixes = {};
    for (const [loc, rule] of Object.entries(data.shop_rules || {})) if (!(placed && loc in placed)) loc_fixes[loc] = rule;
    for (const [loc, age] of Object.entries(AGE_ONLY)) loc_fixes[loc] = loc_fixes[loc] ? `${loc_fixes[loc]} and ${age}` : age;
    for (const [loc, r] of Object.entries(AGE_EXTRA)) loc_fixes[loc] = loc_fixes[loc] ? `${loc_fixes[loc]} and ${r}` : r;
    for (const [loc, sh] of Object.entries(shops || {})) if (placed && loc in placed && sh && priceRule(sh.price)) loc_fixes[loc] = priceRule(sh.price);
    // locations the tracker moves to another region, keeping their rule
    let regions = data.regions;
    if (regions) regions = regions.map((r) => {
      const add = EXTRA_EXITS[r.n];
      if (!add) return r;
      const x = { ...(r.x || {}) };
      for (const [to, q] of Object.entries(add)) x[to] = x[to] ? `(${x[to]}) or (${q})` : q;
      return { ...r, x };
    });
    if (regions && Object.keys(MOVE_REGION).length) regions = regions.map((r) => {
      const out = Object.entries(MOVE_REGION).filter(([loc]) => r.l && loc in r.l);
      const into = Object.entries(MOVE_REGION).filter(([loc, to]) => to === r.n && !(r.l && loc in r.l));
      if (!out.length && !into.length) return r;
      const l = { ...(r.l || {}) };
      for (const [loc] of out) delete l[loc];
      for (const [loc] of into) { const from = data.regions.find((x) => x.l && loc in x.l); if (from) l[loc] = from.l[loc]; }
      return { ...r, l };
    });
    return { ...data, regions, helpers, loc_fixes, loc_rules: { ...OWN_RULES } };
  }

  // a seed stored by an older tracker: recompute what newer versions derive from it
  function refresh(sd, data) {
    if (!sd || !sd.vals || !sd.placements) return sd;
    sd = { ...sd, placements: upgradePlacements(sd.placements, data) };
    // read the settings string again with this version's schema (a stored seed keeps the values its
    // tracker version read, which can use choices OOTRR has since renamed)
    const legacy = isLegacy(sd.generator);
    if (sd.settingsString) try { sd = { ...sd, vals: decodeSettings(sd.settingsString, data.schema, legacy, sd.generator).vals }; } catch (e) { /* keep the stored values */ }
    return { ...sd, switches: withPlacedPatches(logicSwitches(sd.vals, legacy, sd.generator), sd.placements, data), start: withSkipped(startItems(sd.vals, data.start_items), sd.vals, sd.placements), skipped: kakarikoSkip(sd.vals) ? KAKARIKO_LOCATIONS.filter((l) => l in sd.placements) : [] };
  }

  // The locations a seed with these settings shuffles, without a seed: OOTRR's default pool, changed by what
  // each setting adds or takes away (measured with OOTRR's generator, tools/pool_matrix.py).
  function poolOf(v, data) {
    const P = data.pools;
    if (!P) return null;
    const set = new Set(P.base), adds = [], rems = [];
    for (const s of data.schema) {
      if (!enabled(s, v)) continue;
      const d = P.deltas[s.id], x = v[s.id];
      if (!d || x === undefined) continue;
      if (s.id === "shuffle_shops" && P.deals && P.deals.delta) continue;  // the deal shelves are worked out below
      const ks = Array.isArray(x) ? x.map((i) => JSON.stringify([i])) : JSON.stringify(x) === JSON.stringify(s.default) ? [] : [JSON.stringify(x)];
      for (const k of ks) if (d[k]) { adds.push(...d[k][0]); rems.push(...d[k][1]); }
    }
    for (const n of rems) set.delete(n);
    for (const n of adds) set.add(n);
    // Special deals: the first shelves in OOTRR's deal order (slot k of every shop, then k + 1), up to the number
    // per shop the setting asks for, and only as many as fit: OOTRR keeps enough shelf-able items free for other
    // spots, which other settings change (measured per setting with "4 special deals", tools/deal_room.py)
    const lv = /^deals_(\d)$/.exec(v.shuffle_shops || "") || (v.shuffle_shops === "random" ? [0, "4"] : null);
    if (lv && P.deals && P.deals.delta) {
      // 0.8 shops/rules.rs room: the data holds what the room is made of, [any_n, once_n, left, dear, stacks]
      // (deal_room.py), added up over the settings; the room is worked out from them as OOTRR does.
      // Data from before 0.8 holds the room itself as one number.
      let room;
      const add = (acc, x) => { if (Array.isArray(acc)) x.forEach((y, i) => (acc[i] += y)); else acc += x || 0; return acc; };
      let raw = Array.isArray(P.deals.base) ? P.deals.base.slice() : P.deals.base;
      for (const s of data.schema) {
        const d = P.deals.delta[s.id], x = v[s.id];
        if (!d || x === undefined || !enabled(s, v)) continue;
        const ks = Array.isArray(x) ? x.map((i) => JSON.stringify([i])) : JSON.stringify(x) === JSON.stringify(s.default) ? [] : [JSON.stringify(x)];
        for (const k of ks) if (d[k] !== undefined) raw = add(raw, d[k]);
      }
      if (Array.isArray(raw)) {
        const [anyN, onceN, left, dear, stacks] = raw.map((x) => Math.max(0, x));
        const spare = (n) => Math.max(0, n - Math.max(3, Math.floor(n / (dear ? 2 : 3))));
        const any = Math.min(spare(anyN), left);
        room = [any, stacks ? spare(onceN) : Math.min(spare(onceN), Math.max(0, left - any))];
      } else room = [raw, 0];
      // shops/layout.rs: a one-keeper shop (shops.json "once") takes a deal from "once" first, then from "any";
      // the other shops only from "any"
      const once = new Set(P.deals.once || []);
      for (const [k, n] of P.deals.order) {
        if (k >= +lv[1]) continue;
        if (once.has(n) && room[1] > 0) { set.add(n); room[1]--; } else if (room[0] > 0) { set.add(n); room[0]--; }
      }
    }
    // slice/support.rs plan(): the Bean Merchant sells a shuffled item only with Shuffle Merchants on Bean
    // Merchant Only or All and Skip Planting Beans on (a pair of settings, which the one-setting deltas can't see)
    if (["beans", "all"].includes(v.shuffle_merchants) && v.plant_beans === true && data.checks["ZR Magic Bean Salesman"]) set.add("ZR Magic Bean Salesman");
    // 0.8 slice/pick.rs: the Kokiri Sword chest joins only while overworld chests are shuffled, and the two
    // Ocarinas only while NPC rewards are (pairs again: each delta was measured with the other setting at its default)
    if (!["all", "overworld"].includes(v.shuffle_chests)) set.delete("KF Kokiri Sword Chest");
    if (v.shuffle_rewards !== "supported") for (const n of ["LW Gift from Saria", "HF Ocarina of Time Item"]) set.delete(n);
    // junk_spots.rs: in "matched" skulltula shuffle the unsure skulltulas take only junk, so they join only when
    // enough other shuffled locations hold junk a skulltula can drop (the measured "matched" delta has them out)
    if (P.unsure_skulls && v.shuffle_skulltulas === "matched") {
      const spots = P.unsure_skulls.filter((n) => data.checks[n]), junk = new Set(P.junk_locs);
      for (const n of spots) set.delete(n);
      let have = 0;
      for (const n of set) if (junk.has(n)) have++;
      if (have >= (P.junk_slack || 2) * spots.length) for (const n of spots) set.add(n);
    }
    return set;
  }
  return { enabled, poolOf, kakarikoSkip, isLegacy, before, refresh, decodeSettings, logicSwitches, applySwitches, patchesOf, startItems, parseFile, applyEntrances, withFixes, FIXES };
})();
if (typeof module !== "undefined") module.exports = Seed;

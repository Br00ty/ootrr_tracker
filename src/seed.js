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
    const vals = {}, warn = [], given = {}, pre5 = olderThan(gen, NIGHTLY5);
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
        case "choice": { const i = Number(p.varint()); v = (legacy && OLD_CHOICES[s.id] || (pre5 && PRE5_CHOICES[s.id] && PRE5_CHOICES[s.id](s.choices)) || s.choices)[i]; if (v === undefined) { warn.push(`${s.id}: unknown choice ${i}`); continue; } break; }
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
    const pre5 = olderThan(gen, NIGHTLY5), sk = v.shuffle_smallkeys;
    // slice/support.rs strict_layouts: keys that leave their dungeon (and, since 20261123.5, removed keys) make the
    // Fire, Water and Spirit key layouts strict
    if (["any_dungeon", "keysanity", "overworld", "regional"].includes(sk) || (!pre5 && sk === "remove"))
      for (const k of ["fire_key_layout", "water_key_layout", "spirit_key_layout"]) out.push([k, "shuffled"]);
    // 20261123.5: own-dungeon keys keep Water and Spirit strict when dungeon chests are shuffled, and the Fire
    // Temple's loop door starts open (FIRE_LOOP)
    else if (!pre5 && sk === "dungeon") {
      if (["dungeons", "all"].includes(v.shuffle_chests)) for (const k of ["water_key_layout", "spirit_key_layout"]) out.push([k, "shuffled"]);
      out.push(["fire_loop_door", "open"]);
    }
    // 0.9.0-nightly.20261125.9 slice/bombchus.rs: Bombchus in logic is forced off for everyone (old strings still load)
    if (v.bombchus_in_logic === true && olderThan(gen, NIGHTLY9)) out.push(["free_bombchu_drops", "true"]);
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
    // 20261124.7 open_world/trade_shuffle.rs LOGIC: the adult trade items are their own items, found anywhere
    // (flow_extra.rs: needs the rewards and the trade checks shuffled)
    if (rewards && v.shuffle_trade_checks === true && v.adult_trade_shuffle === true) out.push(["adult_trade_shuffle", "true"]);
    if (pre5) return out;
    // 20261123.5 qol.rs Qol::logic: night Skulltulas wait for Sun's Song, the free scarecrow, no tower escape
    if (v.night_skulls_suns_song === true) out.push(["night_skulls_suns_song", "true"]);
    if (v.free_scarecrow === true) out.push(["scarecrow_behavior", "free"]);
    if (v.skip_tower_escape === true) out.push(["skip_tower_escape", "true"]);
    // medal_gate.rs lacs_goal_logic: the Light Arrows Cutscene by Medallions (1 to 6)
    if (v.shuffle_ganon_bosskey === "lacs_medallions") { out.push(["lacs_condition", "medallions"]); out.push(["lacs_medallions", String(Math.max(1, Math.min(6, +(v.lacs_medallions ?? 6))))]); }
    return out;
  }
  // open_world.rs Gates::read: the old toggle or Door of Time = Open (door_gate.rs legacy moves the toggle there)
  function doorOpen(v) { return v.open_door_of_time === true || v.door_of_time_condition === "open"; }
  // seeds from before 0.8 keep the switches their own version used (the generator line reads "ootrr-core 0.7.3")
  // a nightly build's place in line: 0.8.3-nightly.20261123.5 → [0, 8, 3, 20261123, 5]; a release comes after
  // its own nightlies
  function genKey(g) {
    const m = /(\d+)\.(\d+)\.(\d+)(?:-nightly\.(\d+)\.(\d+))?/.exec(String(g || ""));
    return m ? [+m[1], +m[2], +m[3], m[4] ? +m[4] : 1e9, m[5] ? +m[5] : 0] : null;
  }
  function olderThan(g, than) {
    const a = genKey(g), b = genKey(than);
    if (!a) return false;
    for (let i = 0; i < 5; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  }
  // 0.8.3-nightly.20261123.5: shelves named by position, Light Arrows Cutscene by medallions, own-dungeon key layouts
  const NIGHTLY5 = "0.8.3-nightly.20261123.5";
  // that build put LACS medallions second among the Ganon's Boss Key choices, so older strings count without it
  const PRE5_CHOICES = { shuffle_ganon_bosskey: (c) => c.filter((x) => x !== "lacs_medallions") };
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
  // 0.9.0-nightly.20261125.9 gave the remake's rupees, hearts and several grotto checks real names (OOTRR f4e4ee4,
  // "Names + Logic for a massive amount of checks"). Each old name is the same object (the same save key), so an older
  // seed's placements, saved progress and pins move to the new name. Built from the two builds' data by save key.
  const NIGHTLY9 = "0.9.0-nightly.20261125.9";
  const RENAMES9 = {
    "HF Redead Grotto Chest": "HF Storms Grotto Near Kakariko Redead Chest",
    "HF Tektite Grotto Freestanding PoH": "HF Rocks Near Cow Grotto Chest",
    "GV Crate Freestanding PoH": "GV Ledge Chest Near Octorok Grotto",
    "DMT Rock Red Rupee": "DMT Storms Grotto Red Rupee",
    "LLR GS Rain Shed": "HF GS Lone Tree East of LLR",
    "LLR GS Back Wall": "LLR GS Tower",
    "LLR Tunnel Ledge Chest": "LLR Tower Ledge Chest",
    "HF Open Grotto Chest": "LH Gravestone Grotto Torches Chest",
    "HF GS Cow Grotto": "HF GS Grotto South of LLR Tower",
    "HF GS Near Kak Grotto": "HF GS South Gossip Stone Grotto Crate",
    "Ice Cavern GS Heart Piece Room": "Ice Cavern GS Compass Room",
    "Gerudo Training Ground Freestanding Key": "Gerudo Training Ground Maze Right Key Chest",
    "Kokiri Forest Adult Remake Rupee 1": "KF Adult Ledge Near Deku Tree Path Green Rupee 1",
    "Kokiri Forest Adult Remake Rupee 2": "KF Adult Ledge Near Deku Tree Path Green Rupee 2",
    "Kokiri Forest Adult Remake Rupee 3": "KF Adult Ledge Near Deku Tree Path Green Rupee 3",
    "Kokiri Forest Adult Remake Rupee 4": "KF Adult Ledge Near Deku Tree Path Green Rupee 4",
    "Kokiri Forest Adult Remake Rupee 5": "KF Adult Ledge Near Deku Tree Path Green Rupee 5",
    "Kokiri Forest Adult Remake Rupee 6": "KF Adult Ledge Near Deku Tree Path Green Rupee 6",
    "Kokiri Forest Adult Remake Rupee 7": "KF Adult Ledge Near Deku Tree Path Green Rupee 7",
    "Kokiri Forest Adult Remake Rupee 8": "KF Adult Ledge Near Deku Tree Path Green Rupee 8",
    "Kokiri Forest Adult Remake Rupee 9": "KF Adult Ledge Near Deku Tree Path Purple Rupee",
    "Kokiri Forest Remake Rupee 1": "KF Boulder Maze Blue Rupee",
    "Kokiri Forest Child Remake Rupee 1": "KF Child Near Fado Blue Rupee",
    "Kokiri Forest Child Remake Rupee 2": "KF Child Stream Blue Rupee 1",
    "Kokiri Forest Child Remake Rupee 3": "KF Child Stream Blue Rupee 2",
    "Kokiri Forest Child Remake Rupee 4": "KF Child Stream Blue Rupee 3",
    "Kokiri Forest Child Remake Rupee 5": "KF Child Stream Green Rupee",
    "Kokiri Forest Child Remake Rupee 6": "KF Child Shop Blue Rupee",
    "Kokiri Forest Child Remake Rupee 7": "KF Child Boulder Maze Blue Rupee",
    "Hyrule Field Adult Remake Rupee 1": "LH Adult Lakebed Water Temple Gate Blue Rupee",
    "Lake Hylia Adult Remake Rupee 1": "LH Adult Lakebed Water Temple Gate Green Rupee 1",
    "Lake Hylia Adult Remake Rupee 2": "LH Adult Lakebed Water Temple Gate Green Rupee 2",
    "Lake Hylia Adult Remake Rupee 3": "LH Adult Lakebed Water Temple Gate Green Rupee 3",
    "Lake Hylia Adult Remake Rupee 4": "LH Adult Lakebed Water Temple Gate Green Rupee 4",
    "Lake Hylia Remake Rupee 1": "HF Grotto Near Zora River Green Rupee 1",
    "Lake Hylia Remake Rupee 2": "HF Grotto Near Zora River Green Rupee 2",
    "Lake Hylia Remake Rupee 3": "HF Grotto Near Zora River Green Rupee 3",
    "Lake Hylia Child Remake Rupee 1": "HF Child Zora River Waterfall Green Rupee 1",
    "Lake Hylia Child Remake Rupee 2": "HF Child Zora River Waterfall Blue Rupee",
    "Lake Hylia Child Remake Rupee 3": "HF Child Zora River Waterfall Green Rupee 2",
    "Lake Hylia Child Remake Rupee 4": "HF Child Zora River Waterfall Green Rupee 3",
    "Lake Hylia Child Remake Rupee 5": "HF Child Zora River Waterfall Green Rupee 4",
    "Lake Hylia Child Remake Rupee 6": "HF Child Zora River Waterfall Green Rupee 5",
    "Lake Hylia Child Remake Rupee 7": "LH Child Underwater Near Rutos Letter Green Rupee 1",
    "Lake Hylia Child Remake Rupee 8": "LH Child Underwater Near Rutos Letter Green Rupee 2",
    "LH Lab Adult Remake Rupee 1": "LH Adult Scarecrow Island Red Rupee",
    "LH Lab Remake Rupee 2": "LH Lab Pool Red Rupee",
    "LH Lab Child Remake Rupee 1": "HF Child Zora River Waterfall Green Rupee 6",
    "LH Lab Child Remake Rupee 2": "HF Child Zora River Waterfall Green Rupee 7",
    "LH Lab Child Remake Rupee 3": "HF Child Zora River Waterfall Green Rupee 8",
    "LH Lab Remake Rupee 1": "LH Lab Pool Blue Rupee",
    "Death Mountain Remake Rupee 1": "DMT Storms Grotto Green Rupee 1",
    "Death Mountain Remake Rupee 2": "DMT Storms Grotto Green Rupee 2",
    "Death Mountain Remake Rupee 3": "DMT Storms Grotto Blue Rupee 1",
    "Death Mountain Remake Rupee 4": "DMT Storms Grotto Blue Rupee 2",
    "Death Mountain Remake Rupee 5": "DMT Storms Grotto Green Rupee 3",
    "DMC Central Local Remake Rupee 1": "DMC Fire Temple Entrance Green Rupee 1",
    "DMC Central Local Remake Rupee 2": "DMC Central Rock Green Rupee 1",
    "DMC Central Local Remake Rupee 3": "DMC Central Rock Green Rupee 2",
    "DMC Central Local Remake Rupee 4": "DMC Fire Temple Entrance Green Rupee 2",
    "DMC Central Local Remake Rupee 5": "DMC Central Rock Green Rupee 3",
    "DMC Central Local Remake Rupee 6": "DMC Central Rock Purple Rupee",
    "DMC Central Local Remake Rupee 7": "DMC Fire Temple Entrance Red Rupee",
    "DMC Central Local Remake Rupee 8": "DMC Central Rock Green Rupee 4",
    "DMC Central Local Remake Rupee 9": "DMC Central Rock Green Rupee 5",
    "DMC Central Local Remake Rupee 10": "DMC Central Rock Green Rupee 6",
    "Zora River Remake Rupee 1": "ZR Riverbed Below Open Grotto Green Rupee 1",
    "Zora River Remake Rupee 2": "ZR Riverbed Below Open Grotto Green Rupee 2",
    "Zora River Remake Rupee 3": "ZR Middle Waterfall Green Rupee 1",
    "Zora River Remake Rupee 4": "ZR Upper Ruins Green Rupee 1",
    "Zora River Remake Rupee 5": "ZR Upper Ruins Green Rupee 2",
    "Zora River Remake Rupee 6": "ZR Riverbank Near Bean Salesman Green Rupee 1",
    "Zora River Remake Rupee 7": "ZR Riverbed Below Heart Piece Pillar Green Rupee 1",
    "Zora River Remake Rupee 8": "ZR Upper Ruins Green Rupee 3",
    "Zora River Remake Rupee 9": "ZR Riverbed Below Heart Piece Pillar Green Rupee 2",
    "Zora River Remake Rupee 10": "ZR Riverbed Below Open Grotto Green Rupee 3",
    "Zora River Remake Rupee 11": "ZR Upper Ruins Green Rupee 4",
    "Zora River Remake Rupee 12": "ZR Riverbed Below Open Grotto Green Rupee 4",
    "Zora River Remake Rupee 13": "ZR Middle Waterfall Green Rupee 2",
    "Zora River Remake Rupee 14": "ZR Riverbed Below Heart Piece Pillar Green Rupee 3",
    "Zora River Remake Rupee 15": "ZR Riverbed Below Open Grotto Blue Rupee 1",
    "Zora River Remake Rupee 16": "ZR Riverbank Near Bean Salesman Green Rupee 2",
    "Zora River Remake Rupee 17": "ZR Riverbed Below Open Grotto Blue Rupee 2",
    "Zora River Remake Rupee 18": "ZR Upper Ruins Green Rupee 5",
    "Zora River Remake Rupee 19": "ZR Riverbed Below Open Grotto Blue Rupee 3",
    "Zora River Remake Rupee 20": "ZR Riverbed Below Open Grotto Green Rupee 5",
    "ZF Underwater Adult Remake Rupee 1": "ZF Underwater Green Rupee 1",
    "ZF Underwater Adult Remake Rupee 2": "ZF Underwater Green Rupee 2",
    "ZF Underwater Adult Remake Rupee 3": "ZF Underwater Green Rupee 3",
    "ZF Underwater Adult Remake Rupee 4": "ZF Underwater Green Rupee 4",
    "ZF Underwater Adult Remake Rupee 5": "ZF Underwater Heart Piece Ring Green Rupee 1",
    "ZF Underwater Adult Remake Rupee 6": "ZF Underwater Green Rupee 5",
    "ZF Underwater Adult Remake Rupee 7": "ZF Underwater Heart Piece Ring Green Rupee 2",
    "ZF Underwater Adult Remake Rupee 8": "ZF Underwater Heart Piece Ring Green Rupee 3",
    "ZF Underwater Adult Remake Rupee 9": "ZF Underwater Heart Piece Ring Green Rupee 4",
    "ZF Underwater Adult Remake Rupee 10": "ZF Underwater Heart Piece Ring Green Rupee 5",
    "ZF Underwater Adult Remake Rupee 11": "ZF Underwater Heart Piece Ring Green Rupee 6",
    "ZF Underwater Adult Remake Rupee 12": "ZF Underwater Green Rupee 6",
    "ZF Underwater Adult Remake Rupee 13": "ZF Underwater Heart Piece Ring Green Rupee 7",
    "ZF Underwater Adult Remake Rupee 14": "ZF Underwater Green Rupee 7",
    "ZF Underwater Adult Remake Rupee 15": "ZF Underwater Heart Piece Ring Green Rupee 8",
    "ZF Underwater Adult Remake Rupee 16": "ZF Underwater Green Rupee 8",
    "Deku Tree Before Boss Remake Heart 2": "Deku Tree Lobby Upper Ledge Recovery Heart 1",
    "Deku Tree Before Boss Remake Heart 4": "Deku Tree Lobby Upper Ledge Recovery Heart 2",
    "Deku Tree Before Boss Remake Heart 5": "Deku Tree Lobby Upper Ledge Recovery Heart 3",
    "Deku Tree Before Boss Remake Heart 1": "Deku Tree Before Boss Pool Recovery Heart 1",
    "Deku Tree Before Boss Remake Heart 3": "Deku Tree Before Boss Pool Recovery Heart 2",
    "Deku Tree Before Boss Remake Heart 6": "Deku Tree Before Boss Pool Recovery Heart 3",
    "Fire Temple Boulder Maze Upper Remake Heart 1": "Fire Temple Boulder Maze Upper Recovery Heart 1",
    "Fire Temple Boulder Maze Upper Remake Heart 2": "Fire Temple Boulder Maze Upper Recovery Heart 2"
  };
  // the hint areas those old names had where the new name's area differs (for an older seed's gossip hints)
  const OLD9_AREAS = { "LLR GS Rain Shed": "Lon Lon Ranch", "HF Open Grotto Chest": "Hyrule Field", "Hyrule Field Adult Remake Rupee 1": "Hyrule Field", "Lake Hylia Remake Rupee 1": "Lake Hylia", "Lake Hylia Remake Rupee 2": "Lake Hylia", "Lake Hylia Remake Rupee 3": "Lake Hylia", "Lake Hylia Child Remake Rupee 1": "Lake Hylia", "Lake Hylia Child Remake Rupee 2": "Lake Hylia", "Lake Hylia Child Remake Rupee 3": "Lake Hylia", "Lake Hylia Child Remake Rupee 4": "Lake Hylia", "Lake Hylia Child Remake Rupee 5": "Lake Hylia", "Lake Hylia Child Remake Rupee 6": "Lake Hylia", "LH Lab Child Remake Rupee 1": "Lake Hylia", "LH Lab Child Remake Rupee 2": "Lake Hylia", "LH Lab Child Remake Rupee 3": "Lake Hylia" };
  // 20261123.5 names shop shelves by position (shops.json slots, same order): "<shop> Item i" → "<shop> <i-th here>"
  const SHELF_NAMES = {
    "KF Shop": ["Right Side Bottom Left", "Left Side Bottom Left", "Left Side Bottom Right", "Right Side Bottom Right", "Right Side Top Left", "Left Side Top Right", "Right Side Top Right", "Left Side Top Left"],
    "Market Bazaar": ["Right Side Bottom Left", "Right Side Top Left", "Right Side Top Right", "Left Side Top Left", "Left Side Bottom Right", "Left Side Top Right", "Right Side Bottom Right", "Left Side Bottom Left"],
    "Kak Bazaar": ["Right Side Bottom Left", "Right Side Top Left", "Right Side Top Right", "Left Side Top Left", "Left Side Bottom Right", "Left Side Top Right", "Right Side Bottom Right", "Left Side Bottom Left"],
    "Market Potion Shop": ["Left Side Top Right", "Right Side Top Left", "Left Side Top Left", "Left Side Bottom Right", "Left Side Bottom Left", "Right Side Bottom Left", "Right Side Top Right", "Right Side Bottom Right"],
    "Kak Potion Shop": ["Left Side Bottom Left", "Right Side Bottom Right", "Left Side Top Left", "Left Side Top Right", "Right Side Top Left", "Right Side Bottom Left", "Right Side Top Right", "Left Side Bottom Right"],
    "Market Bombchu Shop": ["Left Side Bottom Left", "Right Side Top Left", "Left Side Top Left", "Left Side Top Right", "Right Side Bottom Left", "Left Side Bottom Right", "Right Side Top Right", "Right Side Bottom Right"],
    "GC Shop": ["Right Side Top Left", "Right Side Top Right", "Right Side Bottom Left", "Right Side Bottom Right", "Left Side Bottom Right", "Left Side Top Left", "Left Side Top Right", "Left Side Bottom Left"],
    "ZD Shop": ["Left Side Bottom Right", "Right Side Top Left", "Left Side Top Right", "Right Side Top Right", "Left Side Bottom Left", "Right Side Bottom Right", "Right Side Bottom Left", "Left Side Top Left"],
  };
  const SHOP_RENAMES = Object.fromEntries(Object.entries(SHELF_NAMES).flatMap(([sh, l]) => l.map((p, i) => [`${sh} Item ${i + 1}`, `${sh} ${p}`])));
  function upgradePlacements(pl, data) {
    if (!pl) return pl;
    const old = (ren) => Object.keys(ren).some((o) => o in pl && !data.checks[o] && data.checks[ren[o]]);
    const old082 = old(OLD_DATA_RENAMES), oldShops = old(SHOP_RENAMES), old9 = old(RENAMES9);
    if (!old082 && !oldShops && !old9) return pl;
    const ren = { ...(old082 ? OLD_DATA_RENAMES : {}), ...(oldShops ? SHOP_RENAMES : {}), ...(old9 ? RENAMES9 : {}) }, out = {};
    // a chain of renames is followed to the end (0.8.2's HF Tunnel Ledge Chest → LLR Tunnel → LLR Tower Ledge Chest)
    for (const [n, it] of Object.entries(pl)) { let m = n; for (let i = 0; i < 4 && ren[m] && !data.checks[m]; i++) m = ren[m]; out[m] = it; }
    if (old082) for (const [a, b] of OLD_DATA_SWAPS) { const x = out[a], y = out[b]; delete out[a]; delete out[b]; if (x !== undefined) out[b] = x; if (y !== undefined) out[a] = y; }
    return out;
  }
  // the names the seed's generator used, for the hints: a 0.8.2-data seed's stones were written from its own names
  function generatorNames(pl, gen) {
    if (!pl || !olderThan(gen, NIGHTLY9)) return pl;
    const out = { ...pl };
    for (const [o, nw] of Object.entries(RENAMES9)) if (nw in out && !(o in out)) { out[o] = out[nw]; delete out[nw]; }
    if (!olderThan(gen, NIGHTLY5)) return out;
    for (const [o, nw] of Object.entries(SHOP_RENAMES)) if (nw in out && !(o in out)) { out[o] = out[nw]; delete out[nw]; }
    if (!before(gen, [0, 8, 3])) return out;
    for (const [a, b] of OLD_DATA_SWAPS) { const x = out[a], y = out[b]; delete out[a]; delete out[b]; if (x !== undefined) out[b] = x; if (y !== undefined) out[a] = y; }
    for (const [o, nw] of Object.entries(OLD_DATA_RENAMES)) if (nw in out && !(o in out)) { out[o] = out[nw]; delete out[nw]; }
    return out;
  }
  // An Archipelago (multiworld) player's .apootrr patch (OOTRR ap/patch.rs Patch): the same seed text, settings string
  // and placements as a seed file (ap::check builds its SeedFile from them), plus the multiworld parts. Locations that
  // hold another player's item are "AP: <key>" in placements and described in "foreign"; the tracker shows them as
  // "Archipelago: <item> (<player>)", which no logic item matches. Items from other worlds ("remote") and AP starting
  // items ("start") reach the game through the AP client, so the tracker counts them from the save like any item.
  // There's no generator line: Archipelago support came with OOTRR 0.9.0-nightly.20261125.9, so it reads as that.
  function fromApPatch(j) {
    if (j.version !== 1) throw new Error(`Archipelago patch version ${j.version} is newer than this tracker understands`);
    if (j.game !== "OOTRR") throw new Error("this Archipelago patch is for another game");
    if (typeof j.settings !== "string" || !j.placements || typeof j.placements !== "object") throw new Error("the Archipelago patch has no settings or placements");
    const placements = {}, foreign = j.foreign || {};
    for (const [loc, it] of Object.entries(j.placements)) {
      const f = foreign[loc];
      placements[loc] = f && typeof it === "string" && it.startsWith("AP: ") ? `Archipelago: ${f.item || "an item"} (${f.player || "another player"})` : it;
    }
    return {
      format: "ootrr-seed", version: 1, generator: `ootrr-core ${NIGHTLY9} (Archipelago)`, seed: j.seed, settings: j.settings, game: "",
      placements, ap: { slot: String(j.slot || ""), player: j.player, seedName: String(j.seed_name || ""), foreign: Object.keys(foreign).length, remote: (j.remote || []).length },
    };
  }
  function parseFile(text, data) {
    let j;
    try { j = JSON.parse(text); } catch (e) { throw new Error("this is not a seed file (not JSON)"); }
    if (j && j.format === "ootrr-ap-patch") j = fromApPatch(j);
    if (!j || j.format !== "ootrr-seed") throw new Error("this is not an ootrr seed file");
    if (j.version !== 1) throw new Error(`seed file version ${j.version} is newer than this tracker understands`);
    if (typeof j.settings !== "string" || !j.placements || typeof j.placements !== "object") throw new Error("the seed file has no settings or placements");
    const legacy = isLegacy(j.generator);
    j.placements = upgradePlacements(j.placements, data);
    const { vals, warn } = decodeSettings(j.settings, data.schema, legacy, j.generator);
    const sw = withPlacedPatches(logicSwitches(vals, legacy, j.generator), j.placements, data);
    return {
      seed: String(j.seed || ""), generator: String(j.generator || ""), settingsString: j.settings, game: String(j.game || ""), ap: j.ap || null,
      placements: j.placements, shops: j.shops || {}, entrances: j.entrances || {},
      hints: hintsOf(String(j.seed || ""), generatorNames(j.placements, String(j.generator || "")), vals, data, String(j.generator || "")),
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
    "DMC Fire Temple Entrance Green Rupee 1 needs the Longshot (adult Link); OOTRR has it with no requirement.",
    "Market Bombchu Bowling Bombchus needs nothing: the alley lends you its own Bombchus. OOTRR asks for Bombchus of your own (found_bombchus).",
    "Graveyard Heart Piece Grave Chest needs no Sun's Song: the chest is already there. OOTRR asks for Sun's Song.",
    "HF Ocarina of Time Item and Song from Ocarina of Time need no Ocarina when Zelda's Escape is Not Required. OOTRR asks for an Ocarina.",
    "HF GS Lone Tree East of LLR can be taken by child or adult Link. OOTRR has it child only.",
    "Spirit Temple Child Bridge Chest and Spirit Temple GS Metal Fence need the Boomerang (an OOTRR developer's coming fix).",
    "Spirit Temple Child Early Torches Chest, its room's five silver rupees, the two Bridge Flying Pots and the four Anubis Pots need the Boomerang too: they're all past the Bridge Chest's room.",
    "Spirit Temple Early Adult Right Chest needs Song of Time as well as the room's silver rupees.",
    "Ganons Castle Shadow Trial Front Chest can also be reached with the Bow (OOTRR's coming fix).",
    "Fire Temple: Hover Boots cross from the first room to the boss door (as in the original randomizer); OOTRR 0.8.2 only reaches it from the top floor with all eight keys.",
    "Bottom of the Well Basement Silver Rupee Behind Rocks (OOTRR: ... Ladders Top) is behind rocks you blow up, so it needs explosives. OOTRR has it with no requirement.",
  ];
  // rules the tracker uses instead of OOTRR's (confirmed in game)
  const OWN_RULES = {
    // (KF West Ledge Chest: 20261123.5 has its own bean route, is_adult and here(can_plant_bean), in the Lost
    // Woods; the tracker follows OOTRR's updated rule)
    // confirmed in game 2026-11-19/22: needs the Longshot (OOTRR: True). 0.9.0-nightly.20261125.9 renamed it (was DMC
    // Central Local Remake Rupee 1) but kept True; its partner (old Rupee 4, now DMC Fire Temple Entrance Green Rupee 2)
    // got OOTRR's own Hookshot rule, which the tracker follows
    "DMC Fire Temple Entrance Green Rupee 1": "can_use(Longshot)",
    // (HF Grotto Near Zora River Green Rupee 1-3, our HF East Rupee Grotto: 0.9.0-nightly.20261125.9 put them in a
    // grotto region of their own that needs can_open_bomb_grotto, so OOTRR's logic covers the explosive)
    // confirmed in game 2026-11-21: won with the game's rental Bombchus and no Bomb Bag or Bombchus of your own
    // (OOTRR: found_bombchus; in 0.8 the alley is open from the start, the First and Second Prize are already True)
    "Market Bombchu Bowling Bombchus": "True",
    // confirmed by the user 2026-11-25: the chest in the Heart Piece grave is there without Sun's Song (OOTRR:
    // can_play(Suns_Song)); getting into the grave keeps OOTRR's rule (adult, or child at night)
    "Graveyard Heart Piece Grave Chest": "True",
    // the user, 2026-11-26: with Zelda's Escape Not Required (the Ocarina of Time waiting in the moat from the start),
    // neither needs an Ocarina in hand. OOTRR asks for one either way (open_world.rs: "the Ocarina of Time cutscene
    // needs an ocarina in hand"); its rule stays for the other Zelda's Escape settings
    "HF Ocarina of Time Item": "is_child and (door_of_time_escape == 'moat' or (story_stones and Ocarina))",
    "Song from Ocarina of Time": "is_child and (door_of_time_escape == 'moat' or (story_stones and Ocarina))",
    // the user 2026-11-22: shown as HF GS Tree By KF, a Hyrule Field tree either age can bonk (OOTRR: is_child and can_bonk)
    // (0.9.0-nightly.20261125.9 renamed it from LLR GS Rain Shed and moved it to Hyrule Field, still child only)
    "HF GS Lone Tree East of LLR": "can_bonk",
    // an OOTRR developer told the user (2026-11-23) these two now need the Boomerang; not in OOTRR's pushed code
    // yet (nightly def150e: the child bridge area takes the Boomerang or the Slingshot). Drop these once it is.
    // (the six DMT rupees by the Song of Storms grotto: 0.9.0-nightly.20261125.9 names them DMT Storms Grotto ... and
    // puts them in the DMT Storms Grotto region, which needs can_open_storm_grotto, as the user found 2026-11-23)
    "Spirit Temple Child Bridge Chest": "Boomerang",
    "Spirit Temple GS Metal Fence": "Boomerang",
    // 2026-11-26, players' reports via the user: the Early Torches room (its chest and its five silver rupees) is
    // only reached through the Bridge Chest's room, so it needs the Boomerang too (its other door doesn't open
    // from the lobby side). OOTRR: Sticks or Din's Fire for the chest, True for the rupees
    "Spirit Temple Child Early Torches Chest": "Boomerang and (Sticks or can_use(Dins_Fire))",
    "Spirit Temple Child Early Torches Silver Rupee Top Right": "Boomerang",
    "Spirit Temple Child Early Torches Silver Rupee Bottom Right": "Boomerang",
    "Spirit Temple Child Early Torches Silver Rupee Bottom Left": "Boomerang",
    "Spirit Temple Child Early Torches Silver Rupee Top Left": "Boomerang",
    "Spirit Temple Child Early Torches Silver Rupee Near Torch": "Boomerang",
    // the user, 2026-11-26: the two flying pots are right by the Bridge Chest, and the Anubis room is the next room on
    // (OOTRR: True, same region)
    "Spirit Temple Child Bridge Flying Pot 1": "Boomerang",
    "Spirit Temple Child Bridge Flying Pot 2": "Boomerang",
    "Spirit Temple Child Anubis Pot 1": "Boomerang",
    "Spirit Temple Child Anubis Pot 2": "Boomerang",
    "Spirit Temple Child Anubis Pot 3": "Boomerang",
    "Spirit Temple Child Anubis Pot 4": "Boomerang",
    // 2026-11-26, players' reports via the user: the chest needs Song of Time as well (OOTRR: the room's five silver
    // rupees only; its Skulltula already asks for Song of Time)
    "Spirit Temple Early Adult Right Chest": "(Silver_Rupee_Spirit_Temple_Adult_Boulders, 5) and can_play(Song_of_Time)",
    // the user, 2026-11-26: the Bow reaches it too; OOTRR will be fixing it (OOTRR: no Bow). Drop once it lands
    "Ganons Castle Shadow Trial Front Chest": "is_child or can_use(Fire_Arrows) or Hookshot or Hover_Boots or can_play(Song_of_Time) or Bow",
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
    // (ZR GS Tree: 20261123.5 moved it to Zora River itself, past the boulders, as the user found 2026-11-21)
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
    return { ...sd, hints: hintsOf(sd.seed, generatorNames(sd.placements, sd.generator), sd.vals, data, sd.generator), switches: withPlacedPatches(logicSwitches(sd.vals, legacy, sd.generator), sd.placements, data), start: withSkipped(startItems(sd.vals, data.start_items), sd.vals, sd.placements), skipped: kakarikoSkip(sd.vals) ? KAKARIKO_LOCATIONS.filter((l) => l in sd.placements) : [] };
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

  // ---------- gossip stone hints (OOTRR core/src/hints.rs) ----------
  // OOTRR writes 40 hints into the stones' text, picked from the seed alone: every hintable item placed
  // (once per item and place), shuffled by its xoshiro256** stream seeded with fnv1a("<seed>/hints"), then
  // hint i goes to stone i in name order (more stones than hints: they repeat). Placements in the order of
  // the seed file's keys (a Rust BTreeMap: byte order). Returns [{stone, item, text, place}] or [] when the
  // tables are missing or the seed has gossip hints off.
  const M64 = (1n << 64n) - 1n;
  function hintRng(text) {
    let h = 0xCBF29CE484222325n;
    for (const b of new TextEncoder().encode(text)) { h ^= BigInt(b); h = (h * 0x100000001B3n) & M64; }
    let x = h;
    const split = () => { x = (x + 0x9E3779B97F4A7C15n) & M64; let z = x; z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & M64; z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & M64; return z ^ (z >> 31n); };
    const s = [split(), split(), split(), split()];
    const rotl = (v, k) => ((v << BigInt(k)) | (v >> BigInt(64 - k))) & M64;
    const next = () => {
      const r = (rotl((s[0] + s[3]) & M64, 23) + s[0]) & M64, t = (s[1] << 17n) & M64;
      s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t; s[3] = rotl(s[3], 45);
      return r;
    };
    const below = (n) => { n = BigInt(n); if (n <= 1n) return 0; const zone = M64 - (M64 % n); for (;;) { const r = next(); if (r < zone) return Number(r % n); } };
    return { shuffle(v) { let i = v.length; while (i > 1) { const j = below(i); i--; [v[i], v[j]] = [v[j], v[i]]; } } };
  }
  const byteOrder = (a, b) => { const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b); for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]; return x.length - y.length; };
  // the items a hint could name before 0.8.3-nightly.20261123.5 made the two shields advancement items
  const PRE5_UNHINTED = ["Deku Shield", "Hylian Shield"];
  function hintsOf(seedId, placements, vals, data, gen) {
    const H = data.hints;
    if (!H || !placements || (vals && vals.gossip_hints === false)) return [];
    const can = new Set(H.items), seen = new Set(), all = [];
    if (olderThan(gen, NIGHTLY5)) for (const i of PRE5_UNHINTED) can.delete(i);
    for (const loc of Object.keys(placements).sort(byteOrder)) {
      const item = placements[loc];
      if (!can.has(item)) continue;
      let place = H.areas[loc] ?? OLD9_AREAS[loc] ?? (RENAMES9[loc] !== undefined ? H.areas[RENAMES9[loc]] : undefined);
      if (place === undefined) { const p = H.prefixes.find(([pre]) => loc.startsWith(pre)); if (!p) continue; place = p[1]; }
      const key = `${item}\u0000${place}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const shown = H.shown[item] || item;
      all.push({ item, place, text: `They say that ${shown.startsWith("Progressive ") ? "a" : "the"} ${shown} lies in ${place}.` });
    }
    if (!all.length) return [];
    hintRng(`${seedId}/hints`).shuffle(all);
    return H.stones.map((stone, i) => ({ stone, ...all[i % all.length] }));
  }
  return { enabled, poolOf, kakarikoSkip, isLegacy, before, refresh, decodeSettings, logicSwitches, applySwitches, patchesOf, startItems, parseFile, applyEntrances, withFixes, FIXES, hintsOf, olderThan, NIGHTLY5, NIGHTLY9, SHOP_RENAMES, RENAMES9 };
})();
if (typeof module !== "undefined") module.exports = Seed;

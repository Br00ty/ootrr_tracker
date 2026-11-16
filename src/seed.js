// Reading .ootrr seed files, ported from realazk/ootrr 0.6.0:
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
  function decodeSettings(text, schema) {
    const m = /^OOTRR(\d+)-(.*)$/i.exec(text.trim());
    if (!m) throw new Error("the settings string must start with OOTRR and a version");
    if (m[1] !== "1") throw new Error(`settings string version ${m[1]} is newer than this tracker understands`);
    const all = b32decode(m[2]);
    if (all.length < 2) throw new Error("the settings string is too short");
    const body = all.subarray(0, all.length - 2);
    const h = murmur(body, 0x4f4f5452), tag = ((h ^ (h >>> 16)) & 0xffff);
    if (((all[all.length - 2] << 8) | all[all.length - 1]) !== tag) throw new Error("the settings string checksum does not match");
    const byNum = new Map(schema.map((s) => [s.num, s]));
    const vals = {}, warn = [];
    for (const s of schema) vals[s.id] = s.wire;
    const r = new Rd(body);
    while (!r.done()) {
      const num = Number(r.varint()), len = Number(r.varint());
      const p = new Rd(r.take(len));
      const s = byNum.get(num);
      if (!s) { warn.push(`unknown setting number ${num} ignored`); continue; }
      let v;
      switch (s.kind) {
        case "toggle": v = p.take(1)[0] === 1; break;
        case "choice": { const i = Number(p.varint()); v = s.choices[i]; if (v === undefined) { warn.push(`${s.id}: unknown choice ${i}`); continue; } break; }
        case "number": v = unzig(p.varint()); break;
        case "multi": { const c = Number(p.varint()); v = []; for (let i = 0; i < c; i++) { const x = s.choices[Number(p.varint())]; if (x !== undefined) v.push(x); } break; }
        case "list": { const c = Number(p.varint()); v = []; for (let i = 0; i < c; i++) { const l = Number(p.varint()); v.push(new TextDecoder().decode(p.take(l))); } break; }
        default: warn.push(`${s.id}: unknown kind ${s.kind}`); continue;
      }
      vals[s.id] = v;
    }
    // Schema::normalize: a setting whose dependency does not hold takes its off value
    for (const s of schema) if (!enabled(s, vals)) vals[s.id] = "disabled" in s ? s.disabled : s.default;
    return { vals, warn };
  }

  // slice/support.rs Plan::logic, with the pieces it reads (open_world.rs, qol.rs, pot_slice/plan.rs …)
  function logicSwitches(v) {
    const out = [];
    if (v.open_forest === "closed_deku") out.push(["open_forest", "closed_deku"]);
    if (v.open_forest === "open") out.push(["open_forest", "open"]);
    if (v.open_door_of_time === true) out.push(["open_door_of_time", "open"]);
    if (["any_dungeon", "keysanity", "overworld", "regional"].includes(v.shuffle_smallkeys))
      for (const k of ["fire_key_layout", "water_key_layout", "spirit_key_layout"]) out.push([k, "shuffled"]);
    if (v.bombchus_in_logic === true) out.push(["free_bombchu_drops", "true"]);
    if (v.open_kakariko === "open") { out.push(["open_kakariko", "open"]); out.push(["skip_child_zelda", "true"]); }
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
    if (v.shuffle_remake_pots && v.shuffle_remake_pots !== "off") out.push(["remake_pot_spots", "on"]);
    if (v.shuffle_freestanding_items === "all") out.push(["free_remake_spots", "on"]);
    const rewards = v.shuffle_rewards === "supported";
    if (rewards && v.shuffle_dungeon_rewards === true) out.push(["medallion_gates", "true"]);
    if (rewards && v.shuffle_potion_shop === true) out.push(["potion_shop_checks", "on"]);
    return out;
  }

  // logic_val: spec() sets each switch as an integer when it parses as one, otherwise as text
  function applySwitches(base, sw) {
    const s = { ...base };
    for (const [k, v] of sw) s[k] = /^-?\d+$/.test(v) ? parseInt(v, 10) : v;
    return s;
  }
  const PATCHED = ["rock_spots=on", "remake_pot_spots=on", "free_remake_spots=on", "skull_rules=strict", "potion_shop_checks=on"];
  const patchesOf = (sw) => sw.map(([k, v]) => `${k}=${v}`).filter((x) => PATCHED.includes(x));

  // start_items/give.rs: each chosen item or song, as the logic counts it
  function startItems(v, table) {
    const out = {};
    for (const id of v.starting_items || []) for (const [n, c] of table[`starting_items:${id}`] || []) out[n] = Math.max(out[n] || 0, c);
    for (const id of v.starting_songs || []) for (const [n, c] of table[`starting_songs:${id}`] || []) out[n] = (out[n] || 0) + c;
    if (typeof v.starting_hearts === "number" && v.starting_hearts > 3) out["Piece of Heart"] = (v.starting_hearts - 3) * 4;
    return out;
  }

  // settings/seed.rs SeedFile::from_json (the parts the tracker uses)
  function parseFile(text, data) {
    let j;
    try { j = JSON.parse(text); } catch (e) { throw new Error("this is not a seed file (not JSON)"); }
    if (!j || j.format !== "ootrr-seed") throw new Error("this is not an ootrr seed file");
    if (j.version !== 1) throw new Error(`seed file version ${j.version} is newer than this tracker understands`);
    if (typeof j.settings !== "string" || !j.placements || typeof j.placements !== "object") throw new Error("the seed file has no settings or placements");
    const { vals, warn } = decodeSettings(j.settings, data.schema);
    const sw = logicSwitches(vals);
    return {
      seed: String(j.seed || ""), generator: String(j.generator || ""), settingsString: j.settings, game: String(j.game || ""),
      placements: j.placements, shops: j.shops || {}, entrances: j.entrances || {},
      vals, warn, switches: sw, start: startItems(vals, data.start_items),
    };
  }

  return { decodeSettings, logicSwitches, applySwitches, patchesOf, startItems, parseFile };
})();
if (typeof module !== "undefined") module.exports = Seed;

// Save reading for the OOTRR tracker, ported from realazk/ootrr:
// crates/core/src/murmur.rs, tracker/peek.rs, tracker/rules.rs and tracker/grid.rs.
const Auto = (() => {
  "use strict";
  const MAGIC = 0x01020304, HEAD = 0x28, SENTINEL = 0xa3db7114;

  function murmur3(str, seed = 0) {
    const b = new TextEncoder().encode(str);
    let h = seed >>> 0;
    const n = b.length, nb = n & ~3;
    const c1 = 0xcc9e2d51, c2 = 0x1b873593;
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
    h ^= n;
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
  }
  const H = new Map();
  const hash = (s) => { let v = H.get(s); if (v === undefined) { v = murmur3(s); H.set(s, v); } return v; };

  // tracker/peek.rs
  function peek(buf) {
    const b = new Uint8Array(buf);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const w32 = (o) => { if (o + 4 > b.length) throw new Error("the file ends inside the row table"); return dv.getUint32(o, true); };
    if (b.length < HEAD + 8 || w32(0) !== MAGIC) throw new Error("this is not a game save (bad magic)");
    const rows = new Map();
    let at = HEAD, keysAt;
    for (;;) {
      const h = w32(at), v = w32(at + 4); at += 8;
      if (h === SENTINEL) { keysAt = v; break; }
      if (h !== 0) rows.set(h, v);
    }
    if (w32(8) !== at) throw new Error("the data offset is not the end of the row table");
    if (keysAt < at || keysAt > b.length) throw new Error("the key list offset is outside the file");
    const keys = new Set();
    for (let o = keysAt; ; o += 8) {
      if (o + 8 > b.length) throw new Error("the key list has no end");
      const k = dv.getBigUint64(o, true);
      if (k === 0n) break;
      keys.add(k.toString());
    }
    const val = (name) => rows.get(hash(name));
    const text = (o) => { if (o == null || o >= b.length) return null; let e = o; while (e < b.length && b[e]) e++; const t = new TextDecoder().decode(b.subarray(o, e)); return t || null; };
    const map = text(val("Sequence_CurrentBanc")) || text(rows.get(0x4a6bdb7d));
    // Player_Pos_For_Map (Vector3): Link's position on the current map, three floats at the row's offset
    const vec = (o) => (o == null || o + 12 > b.length ? null : [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)]);
    const pos = vec(rows.get(0x960ad56a));
    return { rows, keys, val, on: (n) => (val(n) || 0) !== 0, int: (n) => Math.max(0, Math.min(999, (val(n) || 0) | 0)), map, pos, child: (val("Sequence_IsChildhood") || 0) !== 0, size: b.length };
  }

  // The same reader interface, built from the Lichii bridge's live rows: [[hash, value], …] and set keys.
  function fromRows(state) {
    const rows = new Map(state.rows.map(([h, v]) => [h >>> 0, v >>> 0]));
    const keys = new Set(state.keys.map(String));
    const val = (name) => rows.get(hash(name));
    return { rows, keys, val, on: (n) => (val(n) || 0) !== 0, int: (n) => Math.max(0, Math.min(999, (val(n) || 0) | 0)), map: state.map || null, child: (val("Sequence_IsChildhood") || 0) !== 0 };
  }

  // tracker/rules.rs: a check is found when any of its flags is set, or any of its keys is in the key list
  function checks(p, detect) {
    const out = new Set();
    for (const [name, rules] of Object.entries(detect)) {
      if (rules.some((r) => (r.f && r.f.some((f) => p.on(f))) || (r.k && r.k.some((k) => p.keys.has(k))))) out.add(name);
    }
    return out;
  }

  // tracker/grid.rs, mapped onto the OoTR logic item names
  function items(p) {
    const held = (a) => p.on(`IsGet.${a}`) || p.int(`PouchData.${a}.StockNum`) > 0;
    const tier = (list) => { for (let i = list.length - 1; i >= 0; i--) if (held(list[i])) return i + 1; return 0; };
    const one = (...a) => (a.some(held) ? 1 : 0);
    const out = {};
    const set = (n, v) => { if (v > 0) out[n] = v; };
    set("Slingshot", Math.max(tier(["Item_BulletBag_Small", "Item_BulletBag_Medium", "Item_BulletBag_Large"]), one("Weapon_Range_SlingShot")));
    set("Bow", Math.max(tier(["Item_Quiver_Small", "Item_Quiver_Medium", "Item_Quiver_Large"]), one("Weapon_Range_Bow")));
    set("Bomb Bag", tier(["Item_BombBag_Small", "Item_BombBag_Medium", "Item_BombBag_Large"]));
    set("Progressive Hookshot", tier(["Item_Hookshot", "Item_Longshot"]));
    set("Progressive Strength Upgrade", tier(["Armor_Child_Gauntlet_Goron", "Armor_Adult_Gauntlet_Silver", "Armor_Adult_Gauntlet_Gold"]));
    set("Progressive Scale", tier(["Item_Scale_Silver", "Item_Scale_Gold"]));
    set("Progressive Wallet", tier(["Item_Wallet_Medium", "Item_Wallet_Large"]));
    set("Ocarina", tier(["Item_Ocarina_Fairy", "Item_Ocarina_Time"]));
    const mp = p.int("PlayerStatus.MPMax");
    set("Magic Meter", mp >= 480 || p.on("IsGet.Item_FairyBless_MPDouble") ? 2 : mp >= 240 || p.on("IsGet.Item_FairyBless_MP") ? 1 : 0);
    const ONE = {
      Boomerang: ["Item_Boomerang"], "Lens of Truth": ["Armor_GlassTruth"], "Megaton Hammer": ["Item_Hammer"],
      "Dins Fire": ["Item_DinFire"], "Farores Wind": ["Item_FaroreWind"], "Nayrus Love": ["Item_NayruLove"],
      "Fire Arrows": ["Item_Arrow_Fire"], "Ice Arrows": ["Item_Arrow_Ice"], "Light Arrows": ["Item_Arrow_Light"], Bombchus: ["Item_Bombchu"],
      "Kokiri Sword": ["Weapon_Sword_Kokiri"], "Biggoron Sword": ["Weapon_Sword_Biggoron"], "Mirror Shield": ["Weapon_Shield_Mirror"],
      "Goron Tunic": ["Armor_Adult_Goron"], "Zora Tunic": ["Armor_Adult_Zora"], "Iron Boots": ["Armor_Adult_HeavyBoot"], "Hover Boots": ["Armor_Adult_HoverBoot"],
      // having sticks or nuts satisfies OOTRR's Sticks / Nuts helpers (which accept a drop of them)
      "Deku Stick Drop": ["Item_DekuStick"], "Deku Nut Drop": ["Item_DekuNut"],
      "Stone of Agony": ["Item_AgonyStone"], "Gerudo Membership Card": ["Item_Token_Gerudo"],
      "Weird Egg": ["Item_WeirdEgg"], "Zeldas Letter": ["Item_ZeldaLetter"], "Rutos Letter": ["Item_Bottle_Letter"],
      "Keaton Mask": ["Armor_Child_Mask_Keaton"], "Skull Mask": ["Armor_Child_Mask_Skull"], "Spooky Mask": ["Armor_Child_Mask_Spooky"],
      "Bunny Hood": ["Armor_Child_Mask_Bunny"], "Mask of Truth": ["Armor_Child_Mask_Truth"],
      "Pocket Egg": ["Item_PocketEgg"], Cojiro: ["Item_CojiroCucco"], "Odd Mushroom": ["Item_OddMushroom"], "Odd Potion": ["Item_OddPowder"],
      "Poachers Saw": ["Item_PoacherSaw"], "Broken Sword": ["Item_BrokenSword"], Prescription: ["Item_Prescription"],
      "Eyeball Frog": ["Item_EyeballFrog"], Eyedrops: ["Item_EyeDrop"], "Claim Check": ["Item_ClaimCheck"],
      Bottle: ["Item_Bottle", "Item_Bottle_Milk", "Item_Bottle_HalfMilk", "Item_Bottle_RedPotion", "Item_Bottle_GreenPotion", "Item_Bottle_BluePotion", "Item_Bottle_Fairy", "Item_Bottle_Fish", "Item_Bottle_BlueFire", "Item_Bottle_Bug", "Item_Bottle_Poe", "Item_Bottle_BigPoe"],
      "Kokiri Emerald": ["Item_Stone_Forest"], "Goron Ruby": ["Item_Stone_Fire"], "Zora Sapphire": ["Item_Stone_Water"],
      "Forest Medallion": ["Item_Medal_Forest"], "Fire Medallion": ["Item_Medal_Fire"], "Water Medallion": ["Item_Medal_Water"],
      "Shadow Medallion": ["Item_Medal_Shadow"], "Spirit Medallion": ["Item_Medal_Spirit"], "Light Medallion": ["Item_Medal_Light"],
    };
    for (const [n, a] of Object.entries(ONE)) set(n, one(...a));
    const SONG = { "Zeldas Lullaby": "ZeldaLullaby", "Eponas Song": "EponaSong", "Sarias Song": "SariaSong", "Suns Song": "SunSong", "Song of Time": "TimeSong", "Song of Storms": "StormSong", "Minuet of Forest": "ForestMinuet", "Bolero of Fire": "FireBolero", "Serenade of Water": "WaterSerenade", "Requiem of Spirit": "SpiritRequiem", "Nocturne of Shadow": "ShadowNocturne", "Prelude of Light": "LightPrelude" };
    for (const [n, a] of Object.entries(SONG)) set(n, p.on(`IsGet.Item_Melody_${a}`) ? 1 : 0);
    set("Magic Bean", p.int("PouchData.Item_MagicBean.StockNum"));
    set("Gold Skulltula Token", p.int("PouchData.Item_Token_Gold.StockNum"));
    // the poe collector's card: read as Big Poes, or as points at 100 a Poe
    const poe = Math.max(0, Math.min(100000, (p.val("GhostShop_CouponNum") || 0) | 0));
    set("Big Poes Sold", poe >= 100 ? (poe / 100) | 0 : poe);
    // The logic counts hearts as pieces: has_hearts(n) is (Piece_of_Heart, (n - 3) * 4).
    const quarters = p.int("PlayerStatus.MaxLife") / 4 | 0;
    set("Piece of Heart", Math.max(0, quarters - 3) * 4 + Math.min(3, p.int("PouchData.Obj_Heart_Piece.StockNum")));
    const KEYS = { "Forest Temple": "ForestTemple", "Fire Temple": "FireTemple", "Water Temple": "WaterTemple", "Shadow Temple": "ShadowTemple", "Spirit Temple": "SpiritTemple", "Bottom of the Well": "BottomOfTheWell", "Gerudo Training Ground": "GerudoTrainingGround", "Thieves Hideout": "GerudoFortress", "Ganons Castle": "InsideGanonCastle" };
    for (const [n, d] of Object.entries(KEYS)) {
      set(`Small Key (${n})`, p.int(`DungeonInfo.${d}.SmallKeyNum`));
      if (n !== "Bottom of the Well" && n !== "Gerudo Training Ground" && n !== "Thieves Hideout") set(`Boss Key (${n})`, p.on(`DungeonInfo.${d}.IsGetBossKey`) ? 1 : 0);
    }
    return out;
  }

  // Game map name → tracker area
  const MAPS = {
    KokiriForest: "Kokiri Forest", LostWood: "Lost Woods", SacredForestMeadow: "Sacred Forest Meadow", HyruleField: "Hyrule Field", LonLonRanch: "Lon Lon Ranch",
    Market: "Market", TempleOfTime: "Temple of Time", HyruleCastle: "Hyrule Castle", KakarikoVillage: "Kakariko Village", Graveyard: "Graveyard",
    DeathMountainTrail: "Death Mountain Trail", GoronCity: "Goron City", DeathMountainCrater: "Death Mountain Crater", ZoraRiver: "Zora's River", ZoraDomain: "Zora's Domain",
    ZoraFountain: "Zora's Fountain", LakeHylia: "Lake Hylia", GerudoValley: "Gerudo Valley", GerudoFortress: "Gerudo's Fortress", HountedWasteland: "Haunted Wasteland",
    HauntedWasteland: "Haunted Wasteland", DesertColossus: "Desert Colossus", GanonCastle: "Outside Ganon's Castle", InsideTheDekuTree: "Deku Tree", DodongoCavern: "Dodongo's Cavern",
    InsideJabuJabuBelly: "Jabu Jabu's Belly", ForestTemple: "Forest Temple", FireTemple: "Fire Temple", WaterTemple: "Water Temple", ShadowTemple: "Shadow Temple",
    SpiritTemple: "Spirit Temple", BottomOfTheWell: "Bottom of the Well", IceCavern: "Ice Cavern", GerudoTrainingGround: "Gerudo Training Ground", InsideGanonCastle: "Ganon's Castle",
  };
  // Lake Hylia and Lon Lon Ranch are part of the Hyrule Field map in the remake. OOTRR's tracker
  // (tracker/index.rs pin()) moves a Hyrule Field position into one of them when it falls inside that
  // area's map capture rectangle (MapCaptureInfo: centre x, z and height; project.rs uv(), ASPECT 2000/1440).
  const SUB_AREAS = [["Lake Hylia", -200, 490, 422], ["Lon Lon Ranch", -86, 239, 276]];
  const ASPECT = 2000 / 1440;
  function subArea(pos) {
    if (!pos) return null;
    for (const [name, cx, cz, h] of SUB_AREAS) {
      const u = 0.5 + (pos[0] - cx) / h, v = 0.5 + ((pos[2] - cz) / h) * ASPECT;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) return name;
    }
    return null;
  }
  function areaOf(map, fallback, pos) {
    if (!map) return null;
    if (/^HyruleField/.test(map)) { const sub = subArea(pos); if (sub) return sub; }
    const base = map.replace(/_(Child|Adult|Alternative)$/g, "").replace(/_(Child|Adult)$/, "");
    for (const [k, a] of Object.entries(MAPS)) if (base === k || base.startsWith(k)) return a;
    return (fallback && fallback[map]) || null;
  }

  return { murmur3, peek, fromRows, checks, items, areaOf };
})();
if (typeof module !== "undefined") module.exports = Auto;

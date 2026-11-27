// Compares the tracker's logic with ootrr's own Search (tools/ootrr-export/tracker_check.rs).
// Usage: node tools/crosscheck.js <folder with default, keysanity, wild, dungeons, dungeons_plain, rewards, rewards_own .ootrr> <path to tracker_check> [<path to plan_switches>]
// With plan_switches it also checks that the tracker's logic switches equal OOTRR's own plan for each seed.
const [SEEDS, CHECK, PLAN] = process.argv.slice(2);
const E=require('../src/engine.js'),Seed=require('../src/seed.js'),data=require('../data/data.json'),fs=require('fs'),cp=require('child_process');
const always={'Ocarina A Button':1,'Ocarina C up Button':1,'Ocarina C down Button':1,'Ocarina C left Button':1,'Ocarina C right Button':1};
const kits={none:{},early:{'Kokiri Sword':1,'Slingshot':1,'Ocarina':1,'Zeldas Lullaby':1,'Sarias Song':1,'Bomb Bag':1,'Kokiri Emerald':1},
  mid:{'Kokiri Sword':1,'Slingshot':1,'Ocarina':2,'Zeldas Lullaby':1,'Sarias Song':1,'Eponas Song':1,'Song of Time':1,'Bomb Bag':2,'Bow':1,'Progressive Hookshot':1,'Progressive Strength Upgrade':1,'Kokiri Emerald':1,'Goron Ruby':1,'Zora Sapphire':1,'Bottle':1,'Rutos Letter':1,'Magic Meter':1,'Dins Fire':1,'Small Key (Forest Temple)':3},
  late:{'Kokiri Sword':1,'Slingshot':1,'Ocarina':2,'Zeldas Lullaby':1,'Sarias Song':1,'Eponas Song':1,'Song of Time':1,'Suns Song':1,'Song of Storms':1,'Minuet of Forest':1,'Bolero of Fire':1,'Serenade of Water':1,'Requiem of Spirit':1,'Nocturne of Shadow':1,'Prelude of Light':1,'Bomb Bag':3,'Bow':3,'Progressive Hookshot':2,'Progressive Strength Upgrade':3,'Progressive Scale':2,'Kokiri Emerald':1,'Goron Ruby':1,'Zora Sapphire':1,'Forest Medallion':1,'Fire Medallion':1,'Water Medallion':1,'Bottle':2,'Rutos Letter':1,'Magic Meter':2,'Dins Fire':1,'Fire Arrows':1,'Lens of Truth':1,'Megaton Hammer':1,'Iron Boots':1,'Hover Boots':1,'Mirror Shield':1,'Goron Tunic':1,'Zora Tunic':1,'Progressive Wallet':2}};
let bad=0;
for (const f of ['default','keysanity','wild','dungeons','dungeons_plain','rewards','rewards_own','door08a','door08b','door08c','prel08','night1','night2','night3','night4','night5','night6']) {
  const text=fs.readFileSync(`${SEEDS}/${f}.ootrr`,'utf8'); const sd=Seed.parseFile(text,data);
  const settings=Seed.applySwitches(data.settings,sd.switches);
  if (PLAN) {
    const mine=sd.switches.map(([k,v])=>`${k}=${v}`).sort(), theirs=cp.execFileSync(PLAN,[`${SEEDS}/${f}.ootrr`],{encoding:'utf8'}).trim().split('\n').filter(Boolean).sort();
    const a=mine.filter(x=>!theirs.includes(x)), b=theirs.filter(x=>!mine.includes(x));
    if (a.length||b.length) { bad++; console.log(f.padEnd(10),'switches: only tracker',a,'only ootrr',b); } else console.log(f.padEnd(10),'switches match',theirs.length);
  }
  const w=E.buildWorld(data,settings,Seed.patchesOf(sd.switches));
  Seed.applyEntrances(w,data.entrances,sd.entrances);
  const placed=new Set(Object.keys(sd.placements));
  const p=new Array(w.locs.length).fill(null);
  w.locs.forEach((l,k)=>{if(l.event!==null||placed.has(l.name))return;const v=data.vanilla[l.name];if(v!==undefined){const i=w.items.find(v);if(i!==undefined)p[k]=i;}});
  for (const [kn,kit] of Object.entries(kits)) {
    const inv={...always}; for (const [n,c] of Object.entries(sd.start)) inv[n]=Math.max(inv[n]||0,c); for (const [n,c] of Object.entries(kit)) inv[n]=Math.max(inv[n]||0,c);
    const counts=Object.entries(inv).map(([n,c])=>[w.items.find(n),c]).filter(x=>x[0]!==undefined);
    const s=new E.Search(w,counts).run(p);
    const js=[...placed].filter(n=>w.lix.has(n)&&s.locAccess(w.lix.get(n))).sort();
    const over=sd.switches.map(([k,v])=>`${k}=${v}`).join(',');
    const itemsArg=Object.entries(inv).map(([n,c])=>`${n}*${c}`).join(',');
    const rs=cp.execFileSync(CHECK,[`${SEEDS}/${f}.ootrr`,over,itemsArg],{encoding:'utf8'}).trim().split('\n').filter(Boolean).sort();
    const onlyJs=js.filter(x=>!rs.includes(x)), onlyRs=rs.filter(x=>!js.includes(x));
    if(onlyJs.length||onlyRs.length) bad++;
    console.log(f.padEnd(10),kn.padEnd(6),'tracker',String(js.length).padStart(3),'ootrr',String(rs.length).padStart(3),'only tracker',onlyJs.slice(0,4),'only ootrr',onlyRs.slice(0,4));
  }
}
console.log(bad?`${bad} mismatches`:'all match');

//! For a seed's placements and an inventory: which placed locations ootrr's own search can reach.
use std::collections::BTreeMap;
use ootrr_core::slice::data::Data;
use ootrr_core::slice::logic::world_with;
use ootrr_core::search::Search;
use ootrr_core::world::Placement;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let seed: String = std::fs::read_to_string(&a[1]).unwrap();
    let j = ootrr_core::json::parse(&seed).unwrap();
    let placed: Vec<String> = j.get("placements").unwrap().as_obj().unwrap().iter().map(|(k, _)| k.clone()).collect();
    let over_s: String = a.get(2).cloned().unwrap_or_default();
    let over: Vec<(&str, &str)> = over_s.split(',').filter(|x| !x.is_empty()).map(|kv| { let (k, v) = kv.split_once('=').unwrap(); (k, v) }).collect();
    let d = Data::load().unwrap();
    let mut w = world_with(&d, &over).unwrap();
    // dungeon entrance shuffle: rewire the doors the seed lists
    if let Some(e) = j.get("entrances").and_then(|e| e.as_obj()) {
        let m: std::collections::BTreeMap<String, String> = e.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())).collect();
        if !m.is_empty() { ootrr_core::entr::logic::apply(&mut w, &ootrr_core::entr::Layout::from_map(&m).unwrap()).unwrap(); }
    }
    let mut p = Placement::new(w.locs.len());
    for l in &w.real { let n = &w.locs[*l].name; if placed.contains(n) { continue; } if let Some(v) = d.vanilla_of(n) { if let Some(i) = w.item(v) { p.put(*l, i); } } }
    let mut s = Search::new(&w);
    for it in a.get(3).map(|x| x.split(',').filter(|x| !x.is_empty()).collect::<Vec<_>>()).unwrap_or_default() {
        let (n, c) = it.split_once('*').unwrap_or((it, "1"));
        s.add(w.item(n).unwrap_or_else(|| panic!("item {n}")), c.parse().unwrap());
    }
    s.settle(&p, true);
    let mut out: BTreeMap<String, bool> = BTreeMap::new();
    for n in &placed { if let Some(l) = w.loc(n) { out.insert(n.clone(), s.loc_access(l)); } }
    for (n, v) in out { if v { println!("{n}"); } }
}

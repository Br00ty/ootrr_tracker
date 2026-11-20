//! What OOTRR's special deal room (shops/rules.rs room) is made of, for a seed's settings, so the tracker
//! can work the room out for any mix of settings: prints "any_n once_n left dear stacks", the shelf-able
//! items counted as "any" and "once" (one-keeper shops only), the free spots left after SLACK, and 0/1 for
//! dear prices (half kept back instead of a third) and for stack deals (once room not capped by left).
use std::collections::BTreeSet;
use ootrr_core::shops::rules::{class, margin, Class, SLACK};
use ootrr_core::slice::data::Data;
use ootrr_core::slice::fill::vanilla_place;
use ootrr_core::slice::logic::world_with;
use ootrr_core::slice::pick::pick;
use ootrr_core::slice::support::Songs;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let seed: String = std::fs::read_to_string(&a[1]).unwrap();
    let j = ootrr_core::json::parse(&seed).unwrap();
    let text: &str = j.get("settings").unwrap().as_str().unwrap();
    let loaded = ootrr_core::settings::Settings::decode(text).unwrap();
    let p = ootrr_core::slice::support::plan(&loaded.settings).unwrap();
    let d = Data::load().unwrap();
    let songs: bool = p.songs == Songs::Anywhere;
    let w = world_with(&d, &p.logic()).unwrap();
    let pk = pick(&d, &w, &p);
    let v = vanilla_place(&w, &d).unwrap();
    let (mut any, mut once) = (0usize, 0usize);
    let mut fams: BTreeSet<&str> = BTreeSet::new();
    for i in pk.free.iter().filter_map(|l| v.get(*l)) {
        let name: &str = &w.items.names[i];
        match class(&d, name).filter(|c| c.on(&p.shops, songs)) {
            Some(Class::Upgrade) if !d.family(name).is_some_and(|f| fams.insert(f)) => {}
            Some(c) if c.once_only() => once += 1,
            Some(_) => any += 1,
            None => {}
        }
    }
    let left: usize = margin(&d, &w, &p, &pk.free, &v).unwrap().saturating_sub(SLACK);
    let dear: bool = p.shops.max > ootrr_core::shops::price::CHILD;
    println!("{} {} {} {} {}", any, once, left, dear as u8, p.shops.kinds.stacks as u8);
}

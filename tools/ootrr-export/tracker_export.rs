//! Exports what the OOTRR tracker needs from this build of ootrr-core: the logic regions after
//! ootrr's own injections (base world, and the regions each logic switch changes), helpers,
//! base logic settings, items and groups, the settings schema, and starting-item effects.
use std::fmt::Write;
use ootrr_core::logic_json::Json as Lj;
use ootrr_core::logic_val::Val;
use ootrr_core::slice::data::Data;
use ootrr_core::slice::logic::spec;
use ootrr_core::world::Spec;

fn lj(j: &Lj, o: &mut String) {
    match j {
        Lj::Null => o.push_str("null"),
        Lj::Bool(b) => o.push_str(if *b { "true" } else { "false" }),
        Lj::Num(n) => { let _ = write!(o, "{}", n); }
        Lj::Str(s) => esc(s, o),
        Lj::Arr(v) => { o.push('['); for (i, x) in v.iter().enumerate() { if i > 0 { o.push(','); } lj(x, o); } o.push(']'); }
        Lj::Obj(v) => { o.push('{'); for (i, (k, x)) in v.iter().enumerate() { if i > 0 { o.push(','); } esc(k, o); o.push(':'); lj(x, o); } o.push('}'); }
    }
}
fn esc(s: &str, o: &mut String) {
    o.push('"');
    for c in s.chars() {
        match c { '"' => o.push_str("\\\""), '\\' => o.push_str("\\\\"), '\n' => o.push_str("\\n"), c if (c as u32) < 0x20 => { let _ = write!(o, "\\u{:04x}", c as u32); } c => o.push(c) }
    }
    o.push('"');
}
fn val(v: &Val, o: &mut String) {
    match v {
        Val::Bool(b) => o.push_str(if *b { "true" } else { "false" }),
        Val::Int(n) => { let _ = write!(o, "{}", n); }
        Val::Float(f) => { let _ = write!(o, "{}", f); }
        Val::Str(s) => esc(s, o),
        Val::List(l) => { o.push('['); for (i, x) in l.iter().enumerate() { if i > 0 { o.push(','); } val(x, o); } o.push(']'); }
        Val::Map(m) => { o.push('{'); for (i, (k, x)) in m.iter().enumerate() { if i > 0 { o.push(','); } esc(k, o); o.push(':'); val(x, o); } o.push('}'); }
    }
}
fn regions(s: &Spec) -> String {
    let mut o = String::from("[");
    let mut first = true;
    for f in &s.regions { if let Lj::Arr(v) = f { for r in v { if !first { o.push(','); } first = false; lj(r, &mut o); } } }
    o.push(']');
    o
}
fn main() {
    let d: Data = Data::load().expect("data");
    let base: Spec = spec(&d, &[]).expect("spec");
    let mut out = String::from("{");
    let _ = write!(out, "\"generator\":\"ootrr-core {}\",", env!("CARGO_PKG_VERSION"));
    out.push_str("\"regions\":"); out.push_str(&regions(&base));
    out.push_str(",\"helpers\":["); for (i, h) in base.helpers.iter().enumerate() { if i > 0 { out.push(','); } lj(h, &mut out); } out.push(']');
    out.push_str(",\"settings\":{"); for (i, (k, v)) in base.settings.vars.iter().enumerate() { if i > 0 { out.push(','); } esc(k, &mut out); out.push(':'); val(v, &mut out); } out.push('}');
    out.push_str(",\"items\":["); for (i, it) in base.items.iter().enumerate() { if i > 0 { out.push(','); } out.push('['); esc(&it.name, &mut out); let _ = write!(out, ",{}]", it.adv as u8); } out.push(']');
    out.push_str(",\"groups\":{"); for (i, (g, v)) in base.groups.iter().enumerate() { if i > 0 { out.push(','); } esc(g, &mut out); out.push_str(":["); for (j, n) in v.iter().enumerate() { if j > 0 { out.push(','); } esc(n, &mut out); } out.push(']'); } out.push('}');
    let _ = write!(out, ",\"goal\":"); esc(&base.goal, &mut out);
    let _ = write!(out, ",\"root\":"); esc(&base.root, &mut out);
    // regions with each logic switch on, for the switches that change the world files
    let switches: [(&str, &str); 5] = [("rock_spots", "on"), ("remake_pot_spots", "on"), ("free_remake_spots", "on"), ("skull_rules", "strict"), ("potion_shop_checks", "on")];
    out.push_str(",\"switch_regions\":{");
    for (i, (k, v)) in switches.iter().enumerate() {
        let s: Spec = spec(&d, &[(k, v)]).expect("switch spec");
        if i > 0 { out.push(','); }
        esc(&format!("{k}={v}"), &mut out); out.push(':'); out.push_str(&regions(&s));
    }
    out.push('}');
    // starting items: what each choice adds to the logic on its own
    let sch = ootrr_core::settings::schema();
    out.push_str(",\"start_items\":{");
    let mut first = true;
    for setting in ["starting_items", "starting_songs"] {
        let st = sch.get(setting).expect("setting");
        for c in &st.choices {
            let mut s = ootrr_core::settings::Settings::default();
            let _ = s.set(setting, ootrr_core::settings::Value::Set(vec![c.id.clone()]));
            let mut bad = Vec::new();
            let k = ootrr_core::start_items::give::read(&s, &mut bad);
            if !first { out.push(','); } first = false;
            esc(&format!("{setting}:{}", c.id), &mut out); out.push_str(":[");
            for (j, (n, cnt)) in k.logic().iter().enumerate() { if j > 0 { out.push(','); } out.push('['); esc(n, &mut out); let _ = write!(out, ",{}]", cnt); }
            out.push(']');
        }
    }
    out.push('}');
    // per item: own actors and whether it is a plain actor item (seed-aware gift detection, tracker/seed.rs)
    let tbl = ootrr_core::items::load::load().expect("items");
    out.push_str(",\"item_actors\":{");
    let mut first = true;
    for it in &tbl.items {
        if it.mode == ootrr_core::items::model::Mode::Shop { continue; }
        let acts = it.own_actors();
        if acts.is_empty() { continue; }
        if !first { out.push(','); } first = false;
        esc(&it.name, &mut out);
        let _ = write!(out, ":{{\"actor\":{},\"a\":[", it.mode == ootrr_core::items::model::Mode::Actor);
        for (j, a) in acts.iter().enumerate() { if j > 0 { out.push(','); } esc(a, &mut out); }
        out.push_str("]}");
    }
    out.push('}');
    out.push_str(",\"cow_flags\":{");
    let mut first = true;
    for n in ootrr_core::flow_extra::cows::LOCS.iter().chain(ootrr_core::flow_extra::cows::OTHER.iter()) {
        if let Some(f) = ootrr_core::flow_extra::cows::flag_of(n) {
            if !first { out.push(','); } first = false;
            esc(n, &mut out); out.push(':'); esc(&f, &mut out);
        }
    }
    out.push('}');
    // dungeon entrance pool: [door name, area, entry exit from, entry exit to, exit from, exit to]
    out.push_str(",\"entrances\":[");
    for (i, c) in ootrr_core::entr::pools::DUNGEONS.iter().enumerate() {
        if i > 0 { out.push(','); }
        out.push('[');
        for (j, v) in [c.name, c.area, c.entry.0, c.entry.1, c.exit.0, c.exit.1].iter().enumerate() { if j > 0 { out.push(','); } esc(v, &mut out); }
        out.push(']');
    }
    out.push(']');
    out.push_str(",\"vanilla\":{");
    let mut vs: Vec<(&String, &String)> = d.vanilla.iter().collect();
    vs.sort();
    for (i, (k, v)) in vs.iter().enumerate() { if i > 0 { out.push(','); } esc(k, &mut out); out.push(':'); esc(v, &mut out); }
    out.push('}');
    out.push('}');
    println!("{out}");
}

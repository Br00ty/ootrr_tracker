//! Prints ootrr's settings schema for the OOTRR tracker: settings::export::schema_json, plus each
//! setting's wire value (the value a settings string assumes when the setting is left out).
use ootrr_core::json::Json;
use ootrr_core::settings::{export::schema_json, presets::builtin, schema};
fn main() {
    let sch = schema();
    let mut j: Json = schema_json(sch, &builtin().expect("presets"));
    if let Json::Obj(top) = &mut j {
        for (k, v) in top.iter_mut() {
            if k != "settings" { continue; }
            if let Json::Arr(list) = v {
                for (s, o) in sch.settings.iter().zip(list.iter_mut()) {
                    o.put("wire", s.wire_value().to_json());
                }
            }
        }
    }
    println!("{}", j.pretty());
}

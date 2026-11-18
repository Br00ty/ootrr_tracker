// Prints the logic switches OOTRR's own plan sets for a seed (slice/support.rs Plan::logic()), one
// key=value per line, so tools/crosscheck.js can compare them with the tracker's Seed.logicSwitches.
// Usage: cargo run -p ootrr-core --example plan_switches -- <seed.ootrr>
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let seed: String = std::fs::read_to_string(&a[1]).unwrap();
    let j = ootrr_core::json::parse(&seed).unwrap();
    let text: &str = j.get("settings").unwrap().as_str().unwrap();
    let loaded = ootrr_core::settings::Settings::decode(text).unwrap();
    let plan = ootrr_core::slice::support::plan(&loaded.settings).unwrap();
    for (k, v) in plan.logic() { println!("{k}={v}"); }
}

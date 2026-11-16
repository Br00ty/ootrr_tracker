// Prints the generator's vanilla item for each location name read from stdin (one per line), as JSON.
use std::io::Read;
use ootrr_core::slice::data::Data;
fn main() {
    let d: Data = Data::load().expect("data");
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).unwrap();
    let mut out = Vec::new();
    for n in s.lines().filter(|l| !l.is_empty()) {
        let v = d.vanilla_of(n).unwrap_or("");
        out.push(format!("{:?}:{:?}", n, v));
    }
    println!("{{{}}}", out.join(","));
}

// OOTRR Tracker for Linux: the Windows app (app/) 1:1, as one file.
//
// - Serves the tracker pages (stable and nightly, built into this file) on http://127.0.0.1:47811 and opens them
//   in their own window: a Chromium-family browser in app mode (Chromium, Chrome, Brave, Edge, Vivaldi, installed
//   or as a Flatpak) with the tracker's own profile, else the default browser. Closing the window stops the app.
// - The live helper is built in, the same as tools/live/ootrr-live.ps1 on Windows: it reads the running game's
//   memory (Longshot or Hookshot, or a yuzu-family emulator) through /proc/<pid>/mem and answers /state and /save.
//   It only ever reads: nothing is written to the game or to its files.
// - Updates itself from the GitHub releases (the page asks; this file downloads and swaps itself).
//
// The memory layout (GameData Bool table and Bool64bitKey records) is the one documented by OotrR
// (github.com/Mozencaz/OotrR, MIT License, src/oot_rando/tracker/live_memory.py).

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::{FileExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const VERSION: &str = match option_env!("OOTRR_VERSION") { Some(v) => v, None => env!("CARGO_PKG_VERSION") };
const PORT: u16 = 47811;
const ORIGIN: &str = "http://127.0.0.1:47811";
const STABLE: &[u8] = include_bytes!("../../index.html");
const NIGHTLY: &[u8] = include_bytes!("../../nightly/index.html");
const ICON: &[u8] = include_bytes!("../icon.png");
const RELEASES: &str = "https://github.com/Br00ty/ootrr_tracker/releases/download/";

// ---------- the game's memory ----------
const HOST_BASE: u64 = 0x1000_0000_0000; // Hookshot/Longshot on Windows: guest memory at this host address
const GAMEDATA_SLOT: u64 = 0x84C9_E180; // guest pointer to the holder of the GameDataMgr
const HOOKSHOT_MAIN: u64 = 0x8002_0000; // where Hookshot keeps the main module
const SEQUENCE_IS_CHILDHOOD: u32 = 0xCEA2_20D3; // murmur3("Sequence_IsChildhood"): every save has it
const MAX_ITEMS: u32 = 1 << 20;
const BOOL64_TYPE: u64 = 0xC58; // GameDataMgr offset of the Bool64bitKey entry (v131072)
const BOOL64_PROBE: u64 = 0xECDC_46B4_09ED_7D38; // the game's first Gold Skulltula key: every save knows it
const PLAYER_POS: u32 = 0x960A_D56A;
const CURRENT_BANC: u32 = 0x1D61_89DA;
const PLAYER_ROT: u32 = 0xA4AE_E8CD;
const TOKENS: u32 = 0x0473_5978;
const MAX_LIFE: u32 = 0xFBE0_1DA1;
const HEART_PIECES: u32 = 0x51EC_97B3;
const PORTS: &[&str] = &["longshot", "hookshot"];
const EMULATORS: &[&str] = &["lichii", "ryuchii", "eden", "yuzu", "suyu", "citron", "sudachi"];

fn u32_at(b: &[u8], o: usize) -> u32 { u32::from_le_bytes(b[o..o + 4].try_into().unwrap()) }
fn u64_at(b: &[u8], o: usize) -> u64 { u64::from_le_bytes(b[o..o + 8].try_into().unwrap()) }
fn f32_at(b: &[u8], o: usize) -> f32 { f32::from_le_bytes(b[o..o + 4].try_into().unwrap()) }

struct Game {
    pid: u32,
    mem: File,
    name: String,
    image: PathBuf, // the game's program (or its AppImage), to find a portable install's saves beside it
    base: u64,
    slot: u64,
    bool64: Option<u64>,
    typed: HashMap<u32, (u64, u64)>,
    typed_for: u64,
}

impl Game {
    fn raw(&self, host: u64, size: usize) -> Option<Vec<u8>> {
        if size == 0 || size > 64 << 20 { return None; }
        let mut buf = vec![0u8; size];
        self.mem.read_exact_at(&mut buf, host).ok()?;
        Some(buf)
    }
    fn read(&self, guest: u64, size: usize) -> Option<Vec<u8>> { self.raw(self.base.wrapping_add(guest), size) }
    fn u64(&self, guest: u64) -> u64 { self.read(guest, 8).map(|b| u64_at(&b, 0)).unwrap_or(0) }
    fn u32(&self, guest: u64) -> u32 { self.read(guest, 4).map(|b| u32_at(&b, 0)).unwrap_or(0) }
    fn pointer(&self, guest: u64) -> u64 { let v = self.u64(guest); if v >= 0x10000 && v < (1 << 48) && v & 7 == 0 { v } else { 0 } }
    fn alive(&self) -> bool { Path::new(&format!("/proc/{}", self.pid)).exists() }

    // true when guest `s` leads to a GameDataMgr whose table knows Sequence_IsChildhood
    fn valid_slot(&self, s: u64) -> bool {
        let holder = self.pointer(s);
        let manager = if holder != 0 { self.pointer(holder) } else { 0 };
        let header = match if manager != 0 { self.read(manager, 48) } else { None } { Some(h) => h, None => return false };
        let (count, size) = (u32_at(&header, 16), u32_at(&header, 44));
        let (entries, table) = (u64_at(&header, 24), u64_at(&header, 32));
        if table == 0 || entries == 0 || size == 0 || size > MAX_ITEMS || count == 0 || count > MAX_ITEMS { return false; }
        match self.read(table, size as usize * 8) {
            Some(raw) => matches!(bool_slot(&raw, size, SEQUENCE_IS_CHILDHOOD), Some(i) if i < count as u64),
            None => false,
        }
    }

    // a yuzu-family emulator: find the loaded main module (a readable region starting with a MOD0 pointer)
    fn emulator_layout(&mut self) -> bool {
        let off = GAMEDATA_SLOT - HOOKSHOT_MAIN;
        for module in mod0_regions(self.pid, &self.mem) {
            match self.raw(module + off, 8) { Some(b) if u64_at(&b, 0) != 0 => {} _ => continue }
            let mut guest = 0x8000_0000u64;
            while guest < 0x8400_0000 {
                self.base = module.wrapping_sub(guest);
                if self.valid_slot(guest + off) { self.slot = guest + off; return true; }
                guest += 0x1000;
            }
        }
        false
    }

    // Longshot/Hookshot: guest memory at the fixed host address (as on Windows); if a Linux build maps it
    // elsewhere, find its main module the way the emulators are read
    fn port_layout(&mut self) -> bool {
        self.base = HOST_BASE; self.slot = GAMEDATA_SLOT;
        if self.raw(HOST_BASE + GAMEDATA_SLOT, 8).is_some() && self.valid_slot(GAMEDATA_SLOT) { return true; }
        self.emulator_layout()
    }

    fn typed_value(&mut self, manager: u64, hash: u32, stride: u64, off: u64) -> u64 {
        if self.typed_for != manager { self.typed.clear(); self.typed_for = manager; }
        let at = match self.typed.get(&hash) {
            Some(&a) => a,
            None => {
                let head = match self.read(manager, 0x1000) { Some(h) => h, None => return 0 };
                let mut found = None;
                let mut o = 0usize;
                while found.is_none() && o + 32 <= head.len() {
                    let (count, size) = (u32_at(&head, o), u32_at(&head, o + 28));
                    let (entries, table) = (u64_at(&head, o + 8), u64_at(&head, o + 16));
                    if !(count == 0 || count > 4096 || size == 0 || size > 8192 || entries == 0 || table == 0 || entries & 3 != 0 || table & 3 != 0 || entries >= 1 << 48 || table >= 1 << 48) {
                        if let Some(raw) = self.read(table, size as usize * 8) {
                            if let Some(ix) = bool_slot(&raw, size, hash) { if ix < count as u64 { found = Some((o as u64, ix)); } }
                        }
                    }
                    o += 8;
                }
                match found { Some(a) => { self.typed.insert(hash, a); a } None => return 0 }
            }
        };
        let e = self.u64(manager + at.0 + 8);
        if e == 0 { 0 } else { e + at.1 * stride + off }
    }
}

// index of Bool `key` in the (hash u32, index u32) open-addressing table
fn bool_slot(table: &[u8], size: u32, key: u32) -> Option<u64> {
    for probe in 0..size {
        let at = ((key as u64 + probe as u64) % size as u64) as usize;
        let found = u32_at(table, at * 8);
        if found == 0 { return None; }
        if found == key { return Some(u32_at(table, at * 8 + 4) as u64); }
    }
    None
}

// the start of each readable mapping that begins with a MOD0 pointer (an NSO module's header)
fn mod0_regions(pid: u32, mem: &File) -> Vec<u64> {
    let maps = fs::read_to_string(format!("/proc/{}/maps", pid)).unwrap_or_default();
    let mut out = Vec::new();
    for line in maps.lines() {
        let mut it = line.split_whitespace();
        let (range, perms) = match (it.next(), it.next()) { (Some(r), Some(p)) => (r, p), _ => continue };
        if !perms.starts_with('r') { continue; }
        let (a, b) = match range.split_once('-') { Some(x) => x, None => continue };
        let (start, end) = match (u64::from_str_radix(a, 16), u64::from_str_radix(b, 16)) { (Ok(s), Ok(e)) => (s, e), _ => continue };
        if end - start < 0x1000 { continue; }
        let mut head = [0u8; 8];
        if mem.read_exact_at(&mut head, start).is_err() { continue; }
        let offset = u32_at(&head, 4) as u64;
        if offset < 8 || offset >= 0x1000_0000 || offset & 3 != 0 || start + offset + 4 > end { continue; }
        let mut magic = [0u8; 4];
        if mem.read_exact_at(&mut magic, start + offset).is_ok() && &magic == b"MOD0" { out.push(start); }
    }
    out
}

// ---------- finding the game ----------
fn lower_name(p: &Path) -> String { p.file_name().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default() }
fn is_port_folder(dir: &Path) -> bool { dir.join("image.bin").is_file() && dir.join("romfs").is_dir() }
fn environ_var(pid: u32, key: &str) -> Option<String> {
    let raw = fs::read(format!("/proc/{}/environ", pid)).ok()?;
    let want = format!("{}=", key);
    raw.split(|&c| c == 0).find_map(|kv| { let s = String::from_utf8_lossy(kv); s.strip_prefix(&want).map(|v| v.to_string()) })
}

// what a process is: ("longshot", program path) for the PC port, ("lichii", …) for an emulator, else None
fn classify(pid: u32) -> Option<(String, bool, PathBuf)> {
    let exe = fs::read_link(format!("/proc/{}/exe", pid)).ok()?;
    let comm = fs::read_to_string(format!("/proc/{}/comm", pid)).unwrap_or_default().trim().to_lowercase();
    let appimage = environ_var(pid, "APPIMAGE").map(PathBuf::from);
    let names = [lower_name(&exe), comm, appimage.as_deref().map(lower_name).unwrap_or_default()];
    let image = appimage.clone().unwrap_or_else(|| exe.clone());
    for n in &names {
        let n = n.trim_end_matches(".exe");
        if let Some(p) = PORTS.iter().find(|p| n.starts_with(**p)) { return Some((p.to_string(), true, image)); }
        if let Some(e) = EMULATORS.iter().find(|e| n.starts_with(**e)) { return Some((e.to_string(), false, image)); }
    }
    // a port run from its own folder (image.bin + romfs beside it, or one folder up from bin/)
    let dir = exe.parent()?;
    if is_port_folder(dir) || (lower_name(dir) == "bin" && dir.parent().map(is_port_folder).unwrap_or(false)) {
        let n = lower_name(&exe);
        return Some((if n.is_empty() { "longshot".into() } else { n }, true, image));
    }
    None
}

struct Live {
    game: Option<Game>,
    next_scan: Instant,
    why: String,
    last_json: Option<String>,
    last_read: Instant,
    newest: Option<PathBuf>,
    next_save_scan: Instant,
    last_image: Option<PathBuf>,
}

fn ptrace_scope() -> i32 { fs::read_to_string("/proc/sys/kernel/yama/ptrace_scope").ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0) }

const NOT_RUNNING: &str = "The game isn't running (or hasn't loaded a save yet).";
fn blocked_why() -> String {
    format!("Linux won't let the tracker read the game's memory (ptrace_scope is {}). Fix: close the game and start it from the tracker (the Longshot window → \"Start Longshot\"), so the tracker is its parent. Or allow it once in a terminal: sudo setcap cap_sys_ptrace=eip \"{}\"", ptrace_scope(), self_path().display())
}

impl Live {
    fn attach(&mut self) -> Option<String> {
        if let Some(g) = &self.game { if g.alive() { return None; } self.game = None; }
        if Instant::now() < self.next_scan { return Some(self.why.clone()); }
        self.next_scan = Instant::now() + Duration::from_secs(3);
        let me = std::process::id();
        let mut blocked = false;
        let mut pids: Vec<u32> = fs::read_dir("/proc").map(|d| d.filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok()).collect()).unwrap_or_default();
        pids.sort_unstable();
        for pid in pids {
            if pid == me { continue; }
            let (name, port, image) = match classify(pid) { Some(c) => c, None => continue };
            let mem = match File::open(format!("/proc/{}/mem", pid)) {
                Ok(f) => f,
                Err(e) => { if matches!(e.raw_os_error(), Some(1) | Some(13)) { blocked = true; } continue; }
            };
            let mut g = Game { pid, mem, name, image, base: HOST_BASE, slot: GAMEDATA_SLOT, bool64: None, typed: HashMap::new(), typed_for: 0 };
            // a read that fails with "permission denied" also means ptrace is blocked
            let mut probe = [0u8; 1];
            if let Err(e) = g.mem.read_exact_at(&mut probe, HOST_BASE + GAMEDATA_SLOT) { if matches!(e.raw_os_error(), Some(1) | Some(13)) { blocked = true; continue; } }
            let ok = if port { g.port_layout() } else { g.emulator_layout() };
            if ok {
                println!("Reading {} (process {})", g.name, pid);
                self.last_image = Some(g.image.clone());
                self.next_save_scan = Instant::now() - Duration::from_secs(1);
                self.game = Some(g);
                self.why.clear();
                return None;
            }
        }
        self.why = if blocked { blocked_why() } else { NOT_RUNNING.into() };
        Some(self.why.clone())
    }

    fn snapshot(&mut self) -> String {
        if let Some(why) = self.attach() { return format!("{{\"ok\":false,\"why\":{}{}}}", js(&why), self.saves()); }
        let g = self.game.as_mut().unwrap();
        let holder = g.u64(g.slot);
        let manager = if holder != 0 { g.u64(holder) } else { 0 };
        if manager == 0 { let name = g.name.clone(); return format!("{{\"ok\":false,\"why\":\"The game has no save loaded yet.\",\"game\":{}{}}}", js(&name), self.saves()); }
        let (table, entries) = (g.u64(manager + 32), g.u64(manager + 24));
        let (size, count) = (g.u32(manager + 44), g.u32(manager + 16));
        let raw_table = if table != 0 && size > 0 && size <= MAX_ITEMS { g.read(table, size as usize * 8) } else { None };
        let raw_entries = if entries != 0 && count > 0 && count <= MAX_ITEMS { g.read(entries, count as usize * 24) } else { None };
        let (raw_table, raw_entries) = match (raw_table, raw_entries) {
            (Some(t), Some(e)) => (t, e),
            _ => { self.game = None; return format!("{{\"ok\":false,\"why\":\"Unexpected game data (a different game version?).\"{}}}", self.saves()); }
        };
        let mut sb = format!("{{\"ok\":true,\"game\":{},\"bools\":[", js(&g.name));
        let (mut first, mut known, mut child) = (true, false, false);
        for i in 0..size as usize {
            let (key, index) = (u32_at(&raw_table, i * 8), u32_at(&raw_table, i * 8 + 4));
            if key == 0 || index >= count { continue; }
            let on = raw_entries[index as usize * 24 + 22] & 1 != 0;
            if key == SEQUENCE_IS_CHILDHOOD { known = true; child = on; }
            if !on { continue; }
            if !first { sb.push(','); }
            first = false;
            sb.push_str(&key.to_string());
        }
        if !known { self.game = None; return format!("{{\"ok\":false,\"why\":\"Game data not recognised (a different game version?).\"{}}}", self.saves()); }
        sb.push_str(&format!("],\"child\":{},\"keys\":", child));
        sb.push_str(&bool64(g, manager));
        sb.push_str(&where_now(g, manager));
        sb.push_str(&self.saves());
        sb.push('}');
        sb
    }

    // ---------- the newest progress.sav ----------
    fn save_roots(&self) -> Vec<PathBuf> {
        let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
        let data = std::env::var("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|_| home.join(".local/share"));
        let config = std::env::var("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|_| home.join(".config"));
        let mut roots = Vec::new();
        for name in ["Longshot", "longshot", "Hookshot", "hookshot"] {
            roots.push(data.join(name).join("save"));
            roots.push(config.join(name).join("save"));
        }
        roots.push(home.join("Games/Longshot/user/save"));
        for emu in EMULATORS {
            roots.push(data.join(emu).join("nand/user/save"));
            roots.push(config.join(emu).join("nand/user/save"));
        }
        // a portable Longshot keeps its saves beside the game: look next to the running program (or its AppImage)
        if let Some(img) = &self.last_image {
            let mut dir = img.parent().map(Path::to_path_buf);
            for _ in 0..4 {
                let d = match dir { Some(d) => d, None => break };
                for sub in ["user", "save", "LongshotLauncher-data"] { roots.push(d.join(sub)); }
                dir = d.parent().map(Path::to_path_buf);
            }
        }
        // folders the player names: the Longshot window's box, and OOTRR_SAVES (several with ':')
        for s in saved_dirs().into_iter().chain(std::env::var("OOTRR_SAVES").unwrap_or_default().split(':').map(String::from)) {
            let s = s.trim().trim_matches('"').to_string();
            if s.is_empty() { continue; }
            roots.push(if let Some(r) = s.strip_prefix("~/") { home.join(r) } else { PathBuf::from(s) });
        }
        roots
    }
    fn newest_save(&mut self) -> Option<PathBuf> {
        if Instant::now() >= self.next_save_scan {
            self.next_save_scan = Instant::now() + Duration::from_secs(1);
            let mut best: Option<(SystemTime, PathBuf)> = None;
            let mut seen = HashSet::new();
            for root in self.save_roots() { if seen.insert(root.clone()) && root.is_dir() { find_newest(&root, 0, &mut best); } }
            let now = best.map(|b| b.1);
            if now != self.newest { match &now { Some(p) => println!("Save: {}", p.display()), None => println!("No progress.sav found yet.") } }
            self.newest = now;
        }
        self.newest.clone().filter(|p| p.is_file())
    }
    fn saves(&mut self) -> String {
        match self.newest_save() {
            None => {
                let looked: Vec<String> = self.save_roots().iter().map(|r| js(&r.display().to_string())).collect();
                format!(",\"save\":null,\"looked\":[{}]", looked.join(","))
            }
            Some(p) => {
                let md = fs::metadata(&p).ok();
                let ticks = md.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
                let slot = p.parent().map(lower_keep).unwrap_or_default();
                format!(",\"save\":{{\"slot\":{},\"path\":{},\"sig\":{}}}", js(&slot), js(&p.display().to_string()), js(&format!("{}:{}", ticks, md.map(|m| m.len()).unwrap_or(0))))
            }
        }
    }
}

fn lower_keep(p: &Path) -> String { p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default() }

fn find_newest(dir: &Path, depth: u32, best: &mut Option<(SystemTime, PathBuf)>) {
    let rd = match fs::read_dir(dir) { Ok(r) => r, Err(_) => return };
    for e in rd.flatten() {
        let p = e.path();
        let ft = match e.file_type() { Ok(t) => t, Err(_) => continue };
        if ft.is_file() && e.file_name() == "progress.sav" {
            if let Ok(t) = e.metadata().and_then(|m| m.modified()) { if best.as_ref().map(|b| t > b.0).unwrap_or(true) { *best = Some((t, p)); } }
        } else if ft.is_dir() && depth < 6 {
            find_newest(&p, depth + 1, best);
        }
    }
}

// where Link is, live (Player_Pos_For_Map, Player_Rot_For_Map, Sequence_CurrentBanc), plus the token and heart
// counts, read the way the Windows helper reads them
fn where_now(g: &mut Game, manager: u64) -> String {
    let mut sb = String::new();
    let pa = g.typed_value(manager, PLAYER_POS, 64, 36);
    if let Some(pv) = if pa != 0 { g.read(pa, 12) } else { None } {
        let (x, y, z) = (f32_at(&pv, 0), f32_at(&pv, 4), f32_at(&pv, 8));
        if [x, y, z].iter().all(|v| v.is_finite() && v.abs() < 1e6) { sb.push_str(&format!(",\"pos\":[{},{},{}]", x, y, z)); }
    }
    let ra = g.typed_value(manager, PLAYER_ROT, 40, 28);
    if let Some(rv) = if ra != 0 { g.read(ra, 4) } else { None } {
        let r = f32_at(&rv, 0);
        if r.is_finite() && r.abs() <= 360.0 { sb.push_str(&format!(",\"rot\":{}", r)); }
    }
    let ta = g.typed_value(manager, TOKENS, 40, 28);
    if let Some(tv) = if ta != 0 { g.read(ta, 4) } else { None } {
        let n = i32::from_le_bytes(tv[..4].try_into().unwrap());
        if (0..=100).contains(&n) { sb.push_str(&format!(",\"tokens\":{}", n)); }
    }
    let (la, ha) = (g.typed_value(manager, MAX_LIFE, 40, 28), g.typed_value(manager, HEART_PIECES, 40, 28));
    if let (Some(lv), Some(hv)) = (if la != 0 { g.read(la, 4) } else { None }, if ha != 0 { g.read(ha, 4) } else { None }) {
        let (life, pieces) = (i32::from_le_bytes(lv[..4].try_into().unwrap()), i32::from_le_bytes(hv[..4].try_into().unwrap()));
        if (12..=80).contains(&life) && (0..=3).contains(&pieces) { sb.push_str(&format!(",\"life\":{},\"pieces\":{}", life, pieces)); }
    }
    let ma = g.typed_value(manager, CURRENT_BANC, 264, 116);
    if let Some(mv) = if ma != 0 { g.read(ma, 64) } else { None } {
        let end = mv.iter().position(|&c| c == 0).unwrap_or(mv.len());
        let map = String::from_utf8_lossy(&mv[..end]).to_string();
        if !map.is_empty() && map.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '/') {
            sb.push_str(&format!(",\"map\":{}", js(map.rsplit('/').next().unwrap_or(&map))));
        }
    }
    sb
}

// the set Bool64bitKey flags (skulltulas, free-standing items…), as decimal strings; null when unreadable
fn bool64(g: &mut Game, manager: u64) -> String {
    let mut offsets = Vec::new();
    if let Some(o) = g.bool64 { offsets.push(o); }
    offsets.push(BOOL64_TYPE);
    let mut o = 0xC08;
    while o < 0xD08 { if o != BOOL64_TYPE { offsets.push(o); } o += 8; }
    for offset in offsets {
        let count = g.u32(manager + offset);
        let records = g.u64(manager + offset + 8);
        if count == 0 || count > MAX_ITEMS || records == 0 || records & 7 != 0 { continue; }
        let raw = match g.read(records, count as usize * 16) { Some(r) => r, None => continue };
        let count = count as usize;
        // the game's own keys come first, sorted; a seed's keys are appended after them
        let mut sorted_end = count;
        for i in 1..count { if u64_at(&raw, i * 16) <= u64_at(&raw, (i - 1) * 16) { sorted_end = i; break; } }
        let keys: Vec<u64> = (0..sorted_end).map(|i| u64_at(&raw, i * 16)).collect();
        if keys.binary_search(&BOOL64_PROBE).is_err() { continue; }
        g.bool64 = Some(offset);
        let on: Vec<String> = (0..count).filter(|i| raw[i * 16 + 12] == 1).map(|i| format!("\"{}\"", u64_at(&raw, i * 16))).collect();
        return format!("[{}]", on.join(","));
    }
    g.bool64 = None;
    "null".into()
}

fn js(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' | '\\' => { out.push('\\'); out.push(c); }
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// ---------- the app's own files (~/.local/share/ootrr-tracker, like %LOCALAPPDATA%\OOTRR Tracker) ----------
fn data_dir() -> PathBuf {
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()));
    let d = std::env::var("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|_| home.join(".local/share")).join("ootrr-tracker");
    let _ = fs::create_dir_all(&d);
    d
}
fn read_setting(name: &str) -> String { fs::read_to_string(data_dir().join(name)).unwrap_or_default().trim().to_string() }
fn write_setting(name: &str, v: &str) { let _ = fs::write(data_dir().join(name), v); }
fn saved_dirs() -> Vec<String> { read_setting("saves.txt").split(['\n', ';']).map(String::from).collect() }
fn self_path() -> PathBuf {
    // inside an AppImage the running file is a copy: the real one is $APPIMAGE
    std::env::var("APPIMAGE").map(PathBuf::from).or_else(|_| std::env::current_exe()).unwrap_or_else(|_| PathBuf::from("OOTRR-Tracker"))
}

// ---------- starting Longshot from the tracker (so Linux lets the tracker read it) ----------
fn longshot_path() -> Option<PathBuf> {
    let set = read_setting("longshot.txt");
    if !set.is_empty() { return Some(PathBuf::from(set)); }
    // an AppImage beside the tracker
    let dir = self_path().parent()?.to_path_buf();
    fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| { let n = lower_name(p); n.starts_with("longshot") && n.ends_with(".appimage") })
}
fn game_running() -> bool {
    fs::read_dir("/proc").map(|d| d.flatten().any(|e| e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()).map(|pid| pid != std::process::id() && classify(pid).is_some()).unwrap_or(false))).unwrap_or(false)
}
fn launch_longshot(path: &Path) -> Result<(), String> {
    let n = lower_name(path);
    if !path.is_file() { return Err(format!("{} isn't a file", path.display())); }
    if !(n.contains("longshot") || n.contains("hookshot")) { return Err("that doesn't look like Longshot".into()); }
    if let Ok(md) = fs::metadata(path) { if md.permissions().mode() & 0o111 == 0 { let mut p = md.permissions(); p.set_mode(p.mode() | 0o755); let _ = fs::set_permissions(path, p); } }
    Command::new(path).current_dir(path.parent().unwrap_or(Path::new("/"))).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ---------- updating ----------
fn update(url: &str) -> Result<(), String> {
    // GitHub may rename the asset ("OOTRR-Tracker(Linux).tar.gz" → "OOTRR-Tracker.Linux.tar.gz"), so only its shape is checked
    let file = url.rsplit('/').next().unwrap_or("");
    if !url.starts_with(RELEASES) || url.contains("..") || !file.to_lowercase().contains("linux") || !file.ends_with(".tar.gz") { return Err("not a tracker release".into()); }
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let me = if std::env::var("APPIMAGE").is_ok() { self_path() } else { me };
    let dir = me.parent().ok_or("no folder")?.to_path_buf();
    let probe = dir.join(".update-test");
    fs::write(&probe, b"").map_err(|_| format!("the tracker's folder ({}) can't be written to", dir.display()))?;
    let _ = fs::remove_file(&probe);
    let work = std::env::temp_dir().join(format!("ootrr-tracker-update-{}", std::process::id()));
    let _ = fs::remove_dir_all(&work);
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let tgz = work.join("update.tar.gz");
    let ok = Command::new("curl").args(["-fsSL", "--max-time", "120", "-o"]).arg(&tgz).arg(url).status().map(|s| s.success()).unwrap_or(false)
        || Command::new("wget").args(["-q", "-T", "120", "-O"]).arg(&tgz).arg(url).status().map(|s| s.success()).unwrap_or(false);
    if !ok { return Err("the download failed (is curl or wget installed?)".into()); }
    if !Command::new("tar").arg("-xzf").arg(&tgz).arg("-C").arg(&work).status().map(|s| s.success()).unwrap_or(false) { return Err("couldn't unpack the download".into()); }
    let new = work.join("OOTRR-Tracker");
    if !new.is_file() { return Err("the download has no OOTRR-Tracker in it".into()); }
    let staged = dir.join(".OOTRR-Tracker.new");
    fs::copy(&new, &staged).map_err(|e| e.to_string())?;
    let _ = fs::set_permissions(&staged, fs::Permissions::from_mode(0o755));
    // a running file can be replaced on Linux: the new one takes its name, the old one lives on until we exit
    fs::rename(&staged, &me).map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(&work);
    Ok(())
}

// ---------- the HTTP server ----------
fn page(nightly: bool) -> Vec<u8> {
    let html = if nightly { NIGHTLY } else { STABLE };
    let inject = format!("<script>window.OOTRR_APP = {{ version: '{}', channels: true, linux: true }};</script>", VERSION);
    let s = String::from_utf8_lossy(html);
    match s.find("<head>") {
        Some(i) => format!("{}{}{}", &s[..i + 6], inject, &s[i + 6..]).into_bytes(),
        None => format!("{}{}", inject, s).into_bytes(),
    }
}

fn respond(stream: &mut TcpStream, status: &str, ty: Option<&str>, body: &[u8], extra: &str, cors: bool) {
    let mut head = format!("HTTP/1.1 {}\r\n", status);
    if cors {
        head.push_str("Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Private-Network: true\r\nAccess-Control-Expose-Headers: X-Save-Slot\r\nAccess-Control-Max-Age: 600\r\n");
    }
    head.push_str("Cache-Control: no-store\r\n");
    if let Some(t) = ty { head.push_str(&format!("Content-Type: {}\r\n", t)); }
    head.push_str(extra);
    head.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", body.len()));
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
}

fn query(q: &str) -> HashMap<String, String> {
    q.split('&').filter_map(|kv| { let (k, v) = kv.split_once('=').unwrap_or((kv, "")); Some((unescape(k), unescape(v))) }).collect()
}
fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => { out.push(b' '); i += 1; }
            b'%' if i + 2 < b.len() => match u8::from_str_radix(&s[i + 1..i + 3], 16) { Ok(v) => { out.push(v); i += 3; } Err(_) => { out.push(b'%'); i += 1; } },
            c => { out.push(c); i += 1; }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

struct App { live: Mutex<Live>, last_seen: AtomicU64, restart: Mutex<bool> }

fn now_secs() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }

fn handle(mut stream: TcpStream, app: Arc<App>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    while buf.len() < 16384 {
        match stream.read(&mut chunk) { Ok(0) | Err(_) => break, Ok(n) => buf.extend_from_slice(&chunk[..n]) }
        if buf.windows(4).any(|w| w == b"\r\n\r\n") { break; }
    }
    let req = String::from_utf8_lossy(&buf).to_string();
    let mut lines = req.split("\r\n");
    let first: Vec<&str> = lines.next().unwrap_or("").split(' ').collect();
    if first.len() < 2 { return; }
    let headers: HashMap<String, String> = lines.take_while(|l| !l.is_empty()).filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string()))).collect();
    let (method, target) = (first[0], first[1]);
    let (path, q) = target.split_once('?').unwrap_or((target, ""));
    // only pages served from here, never another site or a DNS rebinding trick, may change things
    let host_ok = headers.get("host").map(|h| h == "127.0.0.1:47811" || h == "localhost:47811").unwrap_or(false);
    let own = host_ok && headers.get("x-ootrr").map(|v| v == "1").unwrap_or(false)
        && headers.get("origin").map(|o| o == ORIGIN).unwrap_or(true);
    if method == "OPTIONS" {
        // the private endpoints are only for our own pages, which never need a preflight
        respond(&mut stream, "204 No Content", None, &[], "", true);
        return;
    }
    if method != "GET" { respond(&mut stream, "405 Method Not Allowed", None, &[], "", true); return; }
    app.last_seen.store(now_secs(), Ordering::Relaxed);
    match path {
        "/state" => {
            let mut live = app.live.lock().unwrap();
            // one memory read per quarter second, however many windows ask
            if live.last_json.is_none() || live.last_read.elapsed() > Duration::from_millis(250) {
                let j = live.snapshot();
                live.last_json = Some(j);
                live.last_read = Instant::now();
            }
            let body = live.last_json.clone().unwrap_or_default();
            drop(live);
            respond(&mut stream, "200 OK", Some("application/json"), body.as_bytes(), "", true);
        }
        "/save" => {
            let f = app.live.lock().unwrap().newest_save();
            match f.and_then(|p| fs::read(&p).ok().map(|d| (p, d))) {
                Some((p, d)) => respond(&mut stream, "200 OK", Some("application/octet-stream"), &d, &format!("X-Save-Slot: {}\r\n", p.parent().map(lower_keep).unwrap_or_default()), true),
                None => respond(&mut stream, "404 Not Found", None, &[], "", true),
            }
        }
        "/" | "/index.html" | "/nightly" | "/nightly/" | "/nightly/index.html" => {
            if !host_ok { respond(&mut stream, "403 Forbidden", None, &[], "", false); return; }
            let nightly = path.starts_with("/nightly");
            if path == "/" && read_setting("channel.txt") == "nightly" {
                respond(&mut stream, "302 Found", None, &[], "Location: /nightly/index.html\r\n", false);
                return;
            }
            write_setting("channel.txt", if nightly { "nightly" } else { "stable" });
            respond(&mut stream, "200 OK", Some("text/html; charset=utf-8"), &page(nightly), "", false);
        }
        "/icon.png" | "/favicon.ico" => respond(&mut stream, "200 OK", Some("image/png"), ICON, "", false),
        "/app/ping" => respond(&mut stream, "200 OK", Some("text/plain"), VERSION.as_bytes(), "", true),
        p if p.starts_with("/app/") => {
            if !own { respond(&mut stream, "403 Forbidden", None, &[], "", false); return; }
            let q = query(q);
            let (status, body) = app_call(&app, p, &q);
            respond(&mut stream, status, Some("application/json"), body.as_bytes(), "", false);
        }
        _ => respond(&mut stream, "404 Not Found", None, &[], "", true),
    }
}

// the page's requests to the app (the Windows app gets these as WebView2 messages)
fn app_call(app: &Arc<App>, path: &str, q: &HashMap<String, String>) -> (&'static str, String) {
    match path {
        "/app/saves" => {
            write_setting("saves.txt", q.get("dir").map(String::as_str).unwrap_or("").trim());
            let mut live = app.live.lock().unwrap();
            live.next_save_scan = Instant::now() - Duration::from_secs(1);
            live.last_json = None;
            ("200 OK", "{\"ok\":true}".into())
        }
        "/app/longshot" => {
            if let Some(p) = q.get("path") { write_setting("longshot.txt", p.trim()); }
            if let Some(a) = q.get("auto") { write_setting("longshot-auto.txt", if a == "1" { "1" } else { "0" }); }
            let p = longshot_path().map(|p| p.display().to_string()).unwrap_or_default();
            ("200 OK", format!("{{\"path\":{},\"auto\":{},\"running\":{},\"scope\":{},\"self\":{}}}", js(&p), read_setting("longshot-auto.txt") == "1", game_running(), ptrace_scope(), js(&self_path().display().to_string())))
        }
        "/app/launch" => {
            let p = q.get("path").map(PathBuf::from).or_else(longshot_path);
            match p {
                None => ("200 OK", "{\"ok\":false,\"why\":\"Pick your Longshot AppImage first.\"}".into()),
                Some(p) => match launch_longshot(&p) {
                    Ok(()) => { write_setting("longshot.txt", &p.display().to_string()); app.live.lock().unwrap().next_scan = Instant::now() + Duration::from_secs(5); ("200 OK", "{\"ok\":true}".into()) }
                    Err(e) => ("200 OK", format!("{{\"ok\":false,\"why\":{}}}", js(&e))),
                },
            }
        }
        "/app/update" => match update(q.get("url").map(String::as_str).unwrap_or("")) {
            Ok(()) => { *app.restart.lock().unwrap() = true; ("200 OK", "{\"ok\":true}".into()) }
            Err(e) => ("200 OK", format!("{{\"ok\":false,\"why\":{}}}", js(&e))),
        },
        "/app/open" => {
            // links out open in the normal browser, like the Windows app
            let url = q.get("url").cloned().unwrap_or_default();
            if url.starts_with("https://") { let _ = Command::new("xdg-open").arg(&url).stdout(Stdio::null()).stderr(Stdio::null()).spawn(); }
            ("200 OK", "{\"ok\":true}".into())
        }
        _ => ("404 Not Found", "{}".into()),
    }
}

// ---------- the window ----------
fn which(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|d| d.join(name)).find(|p| p.is_file()))
}
fn open_window(url: &str) -> Option<Child> {
    let profile = data_dir().join("window");
    let args = [format!("--app={}", url), format!("--user-data-dir={}", profile.display()), "--class=OOTRR-Tracker".into(), "--no-first-run".into(), "--no-default-browser-check".into(), "--window-size=1500,950".into()];
    for b in ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "brave-browser", "brave", "microsoft-edge", "microsoft-edge-stable", "vivaldi", "vivaldi-stable"] {
        if let Some(p) = which(b) {
            if let Ok(c) = Command::new(p).args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() { return Some(c); }
        }
    }
    if which("flatpak").is_some() {
        let list = Command::new("flatpak").args(["list", "--app", "--columns=application"]).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
        for id in ["org.chromium.Chromium", "com.google.Chrome", "com.brave.Browser", "com.microsoft.Edge", "com.vivaldi.Vivaldi", "io.github.ungoogled_software.ungoogled_chromium"] {
            if list.lines().any(|l| l.trim() == id) {
                // a Flatpak browser keeps its own profile folder (it can't see ours)
                let fargs: Vec<String> = args.iter().filter(|a| !a.starts_with("--user-data-dir")).cloned().collect();
                if let Ok(c) = Command::new("flatpak").arg("run").arg(id).args(&fargs).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() { return Some(c); }
            }
        }
    }
    None
}

// a menu entry with the tracker's icon, so it can be found and pinned like any app
fn install_desktop_entry() {
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    let data = std::env::var("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|_| home.join(".local/share"));
    let icon = data_dir().join("icon.png");
    let _ = fs::write(&icon, ICON);
    let apps = data.join("applications");
    let _ = fs::create_dir_all(&apps);
    let entry = format!("[Desktop Entry]\nType=Application\nName=OOTRR Tracker\nComment=Map and item tracker for OOTRR\nExec=\"{}\"\nIcon={}\nTerminal=false\nCategories=Game;Utility;\nStartupWMClass=OOTRR-Tracker\n", self_path().display(), icon.display());
    let _ = fs::write(apps.join("ootrr-tracker.desktop"), entry);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version") { println!("OOTRR Tracker {}", VERSION); return; }
    let headless = args.iter().any(|a| a == "--no-window");
    let url = format!("{}/", ORIGIN);

    let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
        Ok(l) => l,
        Err(_) => {
            // already running (or the Windows-style helper is): just open another window on it
            println!("The tracker is already running: opening its window.");
            if !headless { match open_window(&url) { Some(mut c) => { let _ = c.wait(); } None => { let _ = Command::new("xdg-open").arg(&url).status(); } } }
            return;
        }
    };
    println!("OOTRR Tracker {} for Linux: {}", VERSION, url);
    install_desktop_entry();
    if read_setting("longshot-auto.txt") == "1" && !game_running() {
        if let Some(p) = longshot_path() { let _ = launch_longshot(&p); }
    }

    let app = Arc::new(App {
        live: Mutex::new(Live { game: None, next_scan: Instant::now(), why: NOT_RUNNING.into(), last_json: None, last_read: Instant::now(), newest: None, next_save_scan: Instant::now(), last_image: None }),
        last_seen: AtomicU64::new(now_secs()),
        restart: Mutex::new(false),
    });
    {
        let app = app.clone();
        std::thread::spawn(move || for s in listener.incoming().flatten() { let app = app.clone(); std::thread::spawn(move || handle(s, app)); });
    }

    let mut window = if headless { None } else { open_window(&url) };
    if window.is_none() && !headless { let _ = Command::new("xdg-open").arg(&url).stdout(Stdio::null()).stderr(Stdio::null()).spawn(); }
    loop {
        std::thread::sleep(Duration::from_millis(500));
        if *app.restart.lock().unwrap() {
            // an update was installed: start the new file (it takes over the window) and step aside
            std::thread::sleep(Duration::from_millis(500));
            let me = self_path();
            drop(window.take());
            use std::os::unix::process::CommandExt;
            let err = Command::new(&me).arg("--no-window").exec();
            eprintln!("Couldn't restart: {}", err);
            return;
        }
        // the app's window closed: stop, like the Windows app
        if let Some(c) = window.as_mut() { if let Ok(Some(_)) = c.try_wait() { return; } }
        // in an ordinary browser tab (or after an update's restart) nothing tells us the window closed: the page
        // pings every 30 seconds, so stop after two minutes without a request
        if window.is_none() && now_secs().saturating_sub(app.last_seen.load(Ordering::Relaxed)) > 120 { return; }
    }
}

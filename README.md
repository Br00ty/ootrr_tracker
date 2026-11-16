# OOTRR Tracker

A location and item tracker for **OOTRR**, the [Ocarina of Time remake randomizer](https://github.com/realazk/ootrr) by REALAZK. It is one HTML file that runs in your browser, offline, with nothing to install.

- **Logic from OOTRR itself.** The checks you can get right now are worked out with OOTRR 0.6.0's own logic, exported from ootrr-core and run in the page. Green = in logic, yellow = only with tricks, red = not yet, grey = done. C/A shows which age can get it.
- **Load your seed.** Load the `.ootrr` file OOTRR generated (or drop it on the page). The tracker reads every setting from it, lists exactly the locations your seed shuffles, and counts your starting items.
- **Auto-tracking from your save.** Watch your save folder and the tracker reads the newest `progress.sav` of all your slots every 2 seconds: items, found checks, and where Link is.
- **Item tracker.** Click to add, right-click to remove. Items read from the save are underlined in green.

## Use it

Open `index.html` in Chrome or Edge (download it, or use the GitHub Pages link if it's turned on for this repo).

1. **Load seed** → pick your `.ootrr` file.
2. **Watch save folder** → pick your emulator's save folder. For Lichii that's `%APPDATA%\lichii\nand\user\save` (any folder above the `slot_00`, `slot_01` … folders works). Or **Load save** to read a `progress.sav` once.
3. Play. Click an area to see its checks. Click a check to see its logic rule as OOTRR writes it, the logic region it belongs to, and, when getting there needs something (a grotto, a fountain, a locked room), the entrances into that region with their rules; double-click it to mark it done, or double-click again to undo. A **C→A** or **A→C** badge marks a check that needs something done as the other age first (a magic bean planted as a child, the adult visit before the HF Deku Scrub Grotto).

Everything is saved in your browser. **Reset progress** clears items and ticked checks for a new run; loading a different seed does that too.

Folder watching needs Chrome or Edge (the File System Access API). In other browsers use Load save.

## Not handled yet

- Shuffled entrances: the logic assumes vanilla entrances.
- Shuffled shop shelves: shop items and prices aren't tracked.
- Small keys: the save stores the keys you hold, so spent keys drop out. The tracker keeps the highest count it has seen; add the rest by clicking.

The page shows a banner when a loaded seed uses entrance or shop shuffle.

## How it's built

| Path | What |
|---|---|
| `index.html` | The tracker, built by `tools/assemble.py` |
| `src/ui.html` | Page, styles and app code |
| `src/engine.js` | OOTRR's rule parser, world builder and search, ported to JavaScript |
| `src/seed.js` | `.ootrr` seed files and settings strings |
| `src/autotrack.js` | `progress.sav` reading and save-based detection |
| `data/data.json` | Logic, settings schema, locations and tracker targets from OOTRR 0.6.0 |
| `tools/` | Scripts that rebuild `data/data.json` for a new OOTRR version, and the cross-check |

After editing anything in `src/`, run `python tools/assemble.py`.

### Updating to a new OOTRR release

1. Clone [realazk/ootrr](https://github.com/realazk/ootrr) at the release tag.
2. Copy the three `.rs` programs in `tools/ootrr-export/` (not `zs_stub.rs`) into its `crates/core/examples/`. If crates.io isn't reachable, replace `crates/core/src/zs.rs` with `tools/ootrr-export/zs_stub.rs` and remove `ruzstd` from `crates/core/Cargo.toml` (the export never unpacks game files).
3. `cargo run -p ootrr-core --example tracker_export > <this repo>/tools/out/logic.json`
4. `cargo run -p ootrr-core --example settings_schema > <this repo>/tools/out/schema.json`
5. `python tools/build_data.py <ootrr>/data` then `python tools/assemble.py`.
6. Generate a few seeds with the `ootrr` CLI (`ootrr generate <preset or settings.json> <seed> out.ootrr`; `tools/seeds/wild.json` turns on many shuffles), build `tracker_check`, and run `node tools/crosscheck.js tools/seeds <path to tracker_check>`. It should print `all match`: the tracker's in-logic locations equal ootrr's own search for every seed and inventory.

## License

GPL-3.0-or-later, like OOTRR, which this tracker ports and embeds. See `LICENSE` and `NOTICE`. No game files are included.

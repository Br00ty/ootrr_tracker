# OOTRR Tracker

A location and item tracker for **OOTRR**, the [Ocarina of Time remake randomizer](https://github.com/realazk/ootrr) by REALAZK. It is one HTML file that runs in your browser, offline, with nothing to install.

**▶ Open the tracker: [br00ty.github.io/ootrr_tracker](https://br00ty.github.io/ootrr_tracker/)**

- **Logic from OOTRR itself.** The checks you can get right now are worked out with OOTRR 0.6.0's own logic, exported from ootrr-core and run in the page. Green = in logic, yellow = only with tricks, red = not yet, grey = done. C/A shows which age can get it.
- **Load your seed.** Load the `.ootrr` file OOTRR generated (or drop it on the page). The tracker reads every setting from it, lists exactly the locations your seed shuffles, and counts your starting items.
- **Dungeon entrance shuffle.** With Entrances set to Dungeons, the logic follows which dungeon is behind each door, exactly like OOTRR's. Each dungeon in the list shows **door: ?** until you click it (or until your save has Link inside it), so the layout isn't spoiled.
- **Auto-tracking from your save.** Watch your save folder and the tracker reads the newest `progress.sav` of all your slots every 2 seconds: items, found checks, and where Link is.
- **Item tracker.** Click to add, right-click to remove. Items read from the save are underlined in green.
- **Item pictures.** Show the game's own item, song, stone, medallion and key icons, taken from OOTRR's icon cache on your PC.
- **Map Tracker.** Switch the location lists for the game's own pause-menu maps: every overworld zone (child and adult) and every dungeon floor, read from your game files. Kokiri Forest has pins for its checks (green, yellow, red, grey like the list), placed where OOTRR's own map index puts them; more areas follow.

## Use it

Open the tracker in Chrome or Edge: use **[the online version](https://br00ty.github.io/ootrr_tracker/)**, or download `index.html` from this repo and open it. Both work the same, and your progress is saved in whichever one you use (the two don't share it).

1. **Load seed** → pick your `.ootrr` file.
2. **Watch save folder** → pick your emulator's save folder, and the tracker rereads the newest save of all slots every 2 seconds. Chrome and Edge refuse folders inside AppData, where Lichii keeps its saves (`%APPDATA%\lichii\nand\user\save`), and a folder link doesn't get around it. Either move Lichii's NAND folder out of AppData (copy `%APPDATA%\lichii\nand` elsewhere with Lichii closed, then set it in Lichii's Configure → Filesystem) and watch `…\nand\user\save` there, or keep a live copy while you play: press Windows + R and run `powershell -NoExit -c "while(1){robocopy \"$env:APPDATA\lichii\nand\user\save\" \"$env:USERPROFILE\Lichii save copy\" /MIR /R:1 /W:1 >$null;sleep 2}"`, then watch `%USERPROFILE%\Lichii save copy`. The **?** button next to Watch save folder walks you through both. Without watching, **Load saves** reads the save folder itself (all slots, newest wins) each time you click it; you can also drop the folder on the page.
3. Play. Click an area to see its checks. Click a check to see its logic rule as OOTRR writes it, the logic region it belongs to, and, when getting there needs something (a grotto, a fountain, a locked room), the entrances into that region with their rules; double-click it to mark it done, or double-click again to undo. A **C→A** or **A→C** badge marks a check that needs something done as the other age first (a magic bean planted as a child, the adult visit before the HF Deku Scrub Grotto).

4. Item pictures: the first time you open the tracker it asks whether to show them.
   - **Find them for me** copies the folder's address (`%LOCALAPPDATA%\ootrr`) and opens the folder window: click the address bar (Alt+D), paste, Enter, then Upload, and confirm. You only pick the folder; every picture inside it is found, however deep.
   - **I'll do it myself** lets you pick the folder yourself (or any folder inside it that holds the pictures), or drag the folder onto the tracker.
   - The **Icons & Maps** button brings this back at any time. The pictures are made by OOTRR's own tracker from your game files the first time it runs with your game folder set. They're the game's art, so this repo doesn't include them; they're shrunk and kept in your browser only. Items without an OOTRR icon (trade items, Ruto's Letter, Echo Gem) keep their names.

5. Game maps: switch to **Map Tracker** at the top, then **Load the game's maps** (also in **Icons & Maps**). Pick the `Map` folder inside your extracted game files: `romfs\UI\CustomTex\Map`. If you loaded the item pictures first, the tracker knows your game folder from OOTRR's settings and copies the Map folder's address for you. About 70 maps are read, shrunk and kept in your browser (IndexedDB); this takes a little while once. The pins come from OOTRR's map index (`tracker-cache\<game>\index.json`, made by OOTRR's tracker from your game files), which is read whenever you load the item pictures from the `ootrr` folder. The map follows the area you pick, and with **Follow Link** on, Link's area and age.

Everything is saved in your browser. **Reset progress** clears items and ticked checks for a new run; loading a different seed does that too.

Folder watching needs Chrome or Edge (the File System Access API). In other browsers use Load saves.

## Logic corrections

The tracker follows OOTRR's own logic, except in two places where that logic lets you do something the game doesn't. Both are listed in the tracker's Settings window, under **Logic corrections**.

- **Shop items on shelves that keep their normal item.** OOTRR adds a shop item's own requirements (a bottle for potions, fish, bugs, Poes, fairies and Blue Fire; a wallet for the price; its rule for Bombchus) only when shops are shuffled. Without them its logic buys Bugs with no bottle, and so puts the bean patch Gold Skulltulas in logic without one. The tracker applies the same requirements, taken from OOTRR's own shop table, to every shelf that keeps its normal item, also when shop deals are on.
- **Bombchus need a Bomb Bag.** With *Bombchus in logic (experimental)* on, OOTRR counts Bombchus without a Bomb Bag; its own note says they didn't work without one in its test. The tracker asks for the Bomb Bag.

`node tools/crosscheck.js` compares the tracker's logic *without* these corrections against OOTRR, so it still checks the port itself.

## Renamed checks

A few checks are listed under a different name (and sometimes area) than OOTRR gives them, because in the remake they sit somewhere else. Only the label and the area list change; the logic, the seed's placements and save detection all keep OOTRR's name. They're in `RENAMES` near the top of the script in `src/ui.html`, and each one's details panel shows its OOTRR name.

| Shown as | OOTRR name | Why |
|---|---|---|
| LH Open Grotto Chest (Lake Hylia) | HF Open Grotto Chest | The chest is in a hidden hole in Lake Hylia |
| LH Poe Chest (Lake Hylia) | HF Lake Poe Chest | A remake-only chest on the Lake Hylia shore |
| HF GS Grotto Near Lake Entrance (Hyrule Field) | HF GS Cow Grotto | A Gold Skulltula in the grotto near the Lake Hylia entrance; OOTRR uses this name only as a placeholder for it |
| GV GS Behind Tent | GV GS Pillar | OOTRR's catalog has these two the wrong way round; the labels swap so each shows the item that drops there |
| GV GS Pillar | GV GS Behind Tent | (the other half of the swap) |

## Not handled yet

- Shuffled entrances: only **dungeon entrance shuffle** is followed (the only kind OOTRR 0.6.0 can generate besides vanilla). Overworld and other entrance pools will come when OOTRR builds them.
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
| `src/texdec.js` | Game texture reading for the map tracker: zstd, BNTX, block-linear swizzle and ASTC (ported from ootrr-core's `tex` module) |
| `data/data.json` | Logic, settings schema, locations and tracker targets from OOTRR 0.6.0 |
| `tools/` | Scripts that rebuild `data/data.json` for a new OOTRR version, and the cross-check |

After editing anything in `src/`, run `python tools/assemble.py`.

### Updating to a new OOTRR release

1. Clone [realazk/ootrr](https://github.com/realazk/ootrr) at the release tag.
2. Copy the three `.rs` programs in `tools/ootrr-export/` (not `zs_stub.rs`) into its `crates/core/examples/`. If crates.io isn't reachable, replace `crates/core/src/zs.rs` with `tools/ootrr-export/zs_stub.rs` and remove `ruzstd` from `crates/core/Cargo.toml` (the export never unpacks game files).
3. `cargo run -p ootrr-core --example tracker_export > <this repo>/tools/out/logic.json`
4. `cargo run -p ootrr-core --example settings_schema > <this repo>/tools/out/schema.json`
5. `python tools/build_data.py <ootrr>/data` then `python tools/assemble.py`.
   If OOTRR renames or moves a check listed under [Renamed checks](#renamed-checks), update its key in `RENAMES`.
6. Generate a few seeds with the `ootrr` CLI (`ootrr generate <preset or settings.json> <seed> out.ootrr`; `tools/seeds/wild.json` turns on many shuffles), build `tracker_check`, and run `node tools/crosscheck.js tools/seeds <path to tracker_check>` (it expects `default`, `keysanity`, `wild`, `dungeons` and `dungeons_plain` seeds; `tools/seeds/dungeons.json` is wild with dungeon entrances shuffled). It should print `all match`: the tracker's in-logic locations equal ootrr's own search for every seed and inventory.

## License

GPL-3.0-or-later, like OOTRR, which this tracker ports and embeds. See `LICENSE` and `NOTICE`. No game files are included.

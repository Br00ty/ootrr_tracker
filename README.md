# OOTRR Tracker

A location and item tracker for **OOTRR**, the [Ocarina of Time remake randomizer](https://github.com/ootrando/ootrr) by REALAZK. It is one HTML file that runs in your browser, offline, with nothing to install.

**▶ Open the tracker: [br00ty.github.io/ootrr_tracker](https://br00ty.github.io/ootrr_tracker/)**

> **Disclaimer:** this tracker was built with the help of AI (Claude, by Anthropic). Every feature has been tested by people, in real playthroughs of the game with OOTRR seeds, and pin spots and auto-tracking were checked in game. If you find something wrong, please use **Report a bug** on the tracker or [open an issue](https://github.com/Br00ty/ootrr_tracker/issues/new?template=bug_report.yml).

- **Logic from OOTRR itself.** The checks you can get right now are worked out with OOTRR 0.8.3-nightly.20261122.3's own logic, exported from ootrr-core and run in the page. Green = in logic, yellow = only with tricks, red = not yet, grey = done. C/A shows which age can get it.
- **Or set the settings by hand.** Without a seed file, Settings works like OOTRR's own settings page: the same groups, presets, labels and help text, settings that only count when another one is on, and a box for an OOTRR settings string. The tracker then lists exactly the locations OOTRR would shuffle with those settings.
- **Load your seed.** Load the `.ootrr` file OOTRR generated (or drop it on the page). The tracker reads every setting from it, lists exactly the locations your seed shuffles, and counts your starting items.
- **Dungeon entrance shuffle.** With Entrances set to Dungeons, the logic follows which dungeon is behind each door, exactly like OOTRR's. Each dungeon in the list shows **door: ?** until you click it (or until your save has Link inside it), so the layout isn't spoiled.
- **Auto-tracking from your save.** Watch your save folder and the tracker reads the newest `progress.sav` of all your slots every 2 seconds: items, found checks, and where Link is. **Disconnect** stops watching and forgets the folder; what was already tracked stays.
- **Longshot: live tracking (Windows).** The **Longshot** button starts a small helper (one command pasted into PowerShell) that reads the running game's memory, so checks tick the moment you get them and the map follows Link between areas and dungeon floors, instead of waiting for the game to save. It also hands the tracker your newest save (items), so there's no folder to pick. Works with Longshot and Hookshot and with Lichii, Eden and other yuzu-family emulators. The helper (`tools/live/ootrr-live.ps1`) only reads, and only answers this PC (`127.0.0.1:47811`); close its window to stop it. Its memory layout comes from [OotrR](https://github.com/Mozencaz/OotrR) (MIT).
- **Item tracker.** Click to add, right-click to remove. Items read from the save are underlined in green.
- **Broadcast view.** A clean item tracker in its own window for streaming (an OBS window capture, for example): items, magic arrows, equipment, songs, stones and medallions as picture tiles, the counters and each dungeon's keys as tiles with numbers. It updates live with the tracker and auto-tracking, and fits whatever size you make the window. Hover over it for its options: a dark background, or **See-through**, a solid magenta (or green) background behind everything but the pictures, numbers, border and dividers; add a Chroma Key filter to the window capture in OBS, with Key Color Type set to the same colour, and your video shows through. Magenta is the safer choice: green also keys out parts of the green pictures (Forest Medallion, Minuet of Forest, Farore's Wind, Kokiri Emerald).
- **Item pictures.** Show the game's own item, song, stone, medallion and key icons, taken from OOTRR's icon cache on your PC.
- **Map Tracker.** Switch the location lists for the game's own pause-menu maps: every overworld zone (child and adult) and every dungeon floor, read from your game files. every overworld area has pins for their checks (green, yellow, red, grey like the list), placed where OOTRR's own map index puts them; more areas follow. Each dungeon's door on the overworld has a bigger pin holding all of that dungeon's checks, as a pie of what's in logic, out of logic, inaccessible and done; with dungeon entrances shuffled it shows **?** until Link has been through that door.

## Use it

Open the tracker in Chrome or Edge: use **[the online version](https://br00ty.github.io/ootrr_tracker/)**, or download `index.html` from this repo and open it. Both work the same, and your progress is saved in whichever one you use (the two don't share it).

1. **Load seed** → pick your `.ootrr` file.
2. **Watch save folder** → the tracker rereads the newest save of all slots every 2 seconds by itself, also while the tracker is behind the game window. Chrome and Edge refuse folders inside AppData, where the games keep their saves (Longshot and Hookshot: `%APPDATA%\Longshot\save`, `%APPDATA%\Hookshot\save`; Lichii: `%APPDATA%\lichii\nand\user\save`), and a folder link doesn't get around it. So keep a live copy while you play: open PowerShell, paste the start command the Watch save folder guide copies for you, then watch `%USERPROFILE%\OOTRR save copy`. The command copies every game's save folder there every 2 seconds and only writes into that folder; close its window to stop it. With Lichii you can instead move its NAND folder out of AppData (copy `%APPDATA%\lichii\nand` elsewhere with Lichii closed, then set it in Lichii's Configure → Filesystem) and watch `…\nand\user\save` there. The **?** button next to Watch save folder walks you through both. Without watching, **Load saves** reads the save folder itself (all slots, newest wins) each time you click it; you can also drop the folder on the page. On Longshot, the **Longshot** button's live tracking is faster still.
3. Play. Click an area to see its checks. Click a check to see its logic rule as OOTRR writes it, the logic region it belongs to, and, when getting there needs something (a grotto, a fountain, a locked room), the entrances into that region with their rules; double-click it to mark it done, or double-click again to undo. A **C→A** or **A→C** badge marks a check that needs something done as the other age first (a magic bean planted as a child, the adult visit before the HF Deku Scrub Grotto).

4. Item pictures and maps: the first time you open the tracker it asks whether to show them. Click **Pick the game's UI folder** and pick the `UI` folder inside your extracted game files (`romfs\UI`), or drag that folder onto the tracker. The **Icons & Maps** button brings this back at any time.
   - The item pictures come from its `Tex\Icon` folder, and the songs, stones, medallions and heart piece from `Layout2Archive\Common…bntx.zs` (the same textures OOTRR uses, with its colours for the warp songs).
   - The maps come from its `CustomTex\Map` folder. About 70 maps and 80 pictures are read, shrunk and kept in your browser (IndexedDB and local storage); this takes a little while once. They're the game's art, so this repo doesn't include them.
   - The Map Tracker's pins come with the tracker: they're taken from OOTRR's map index (`tracker-cache\<game>\index.json`, made by OOTRR's tracker from the game files) when the tracker is built, so you don't need OOTRR's folder for anything. Switch to **Map Tracker** at the top; the map follows the area you pick, and with **Follow Link** on, Link's area and age.

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
| HF GS Grotto Near Lake Entrance (Hyrule Field) | HF GS Cow Grotto | A Gold Skulltula in the grotto near the Lake Hylia entrance; OOTRR uses this name only as a placeholder for it |
| HF GS Tree By KF (Hyrule Field) | LLR GS Rain Shed | A Gold Skulltula in a Hyrule Field tree near Kokiri Forest; OOTRR's data names it as Lon Lon Ranch's |
| GV GS Behind Tent | GV GS Pillar | OOTRR's catalog has these two the wrong way round; the labels swap so each shows the item that drops there |
| GV GS Pillar | GV GS Behind Tent | (the other half of the swap) |
| Kak GS Near Gate Guard | Kak GS House Under Construction | OOTRR's names for these two Kakariko Skulltulas are swapped (the 0.8.3 nightly fixed the tree's, not these); confirmed by the game's object positions |
| Kak GS House Under Construction | Kak GS Near Gate Guard | (the other half of the swap) |
| LLR Tower Vines Chest (Lon Lon Ranch) | LLR Tunnel Ledge Chest | Up the vines on the Lon Lon Ranch tower; adult with the Hookshot (called HF Tunnel Ledge Chest before the 0.8.3 nightly) |
| Lake Hylia Adult Remake Rupee 5 (Lake Hylia) | Hyrule Field Adult Remake Rupee 1 | A green rupee among Lake Hylia's Adult Remake Rupees 1–4; OOTRR files it under Hyrule Field |
| HF Fairy Pond Rupee 1 (Hyrule Field) | LH Lab Child Remake Rupee 3 | A ring of eight child rupees round one in the middle by a Hyrule Field fairy pond; OOTRR files them under Lake Hylia and the Lake Hylia Lab |
| HF Fairy Pond Rupee 2 (Hyrule Field) | Lake Hylia Child Remake Rupee 5 | (same ring) |
| HF Fairy Pond Rupee 3 (Hyrule Field) | LH Lab Child Remake Rupee 2 | (same ring) |
| HF Fairy Pond Rupee 4 (Hyrule Field) | LH Lab Child Remake Rupee 1 | (same ring) |
| HF Fairy Pond Rupee 5 (Hyrule Field) | Lake Hylia Child Remake Rupee 3 | (same ring) |
| HF Fairy Pond Rupee 6 (Hyrule Field) | Lake Hylia Child Remake Rupee 6 | (same ring) |
| HF Fairy Pond Rupee 7 (Hyrule Field) | Lake Hylia Child Remake Rupee 4 | (same ring) |
| HF Fairy Pond Rupee 8 (Hyrule Field) | Lake Hylia Child Remake Rupee 1 | (same ring) |
| HF Fairy Pond Rupee 9 (Hyrule Field) | Lake Hylia Child Remake Rupee 2 | (same ring) |
| HF East Rupee Grotto Rupee 1 (Hyrule Field) | Lake Hylia Remake Rupee 3 | Three of a cluster of seven rupees by Hyrule Field's east rupee grotto (the other four aren't randomized); OOTRR files them under Lake Hylia |
| HF East Rupee Grotto Rupee 2 (Hyrule Field) | Lake Hylia Remake Rupee 2 | (same cluster) |
| HF East Rupee Grotto Rupee 3 (Hyrule Field) | Lake Hylia Remake Rupee 1 | (same cluster) |
| Bottom of the Well Basement Silver Rupee Behind Rocks | Bottom of the Well Basement Silver Rupee Ladders Top | Behind rocks you blow up, not at the top of the ladders; needs explosives (OOTRR has no requirement) |
| Spirit Temple GS Statue Room | Spirit Temple GS Sun on Floor Room | The Skulltula is in the statue room; as child it needs explosives |
| HF Present/Past Chest | HF Tektite Grotto Freestanding PoH | A chest in Hyrule Field: visit it as adult, then child can open it; needs both ages and nothing else (OOTRR's nightly: adult only) |
| Dodongos Cavern GS Bombable Wall Push Block Room | Dodongos Cavern GS Back Room | The Skulltula is behind a bombable wall in the push block room (OOTRR 0.8.2 called this spot Dodongos Cavern GS Alcove Above Stairs; the 0.8.3 nightly swapped the two names) |
| Gerudo Proving Ground … (every check, region and key there) | Gerudo Training Ground … | The remake renamed the dungeon; OOTRR keeps OoTR's name, so seeds and logic still use it |

## Not handled yet

- Shuffled entrances: only **dungeon entrance shuffle** is followed (the only kind OOTRR 0.8.3-nightly can generate besides vanilla). Overworld and other entrance pools will come when OOTRR builds them.
- Shuffled shop shelves: shop items and prices aren't tracked.

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
| `data/data.json` | Logic, settings schema, locations and tracker targets from OOTRR 0.8.3-nightly.20261122.3 |
| `tools/deal_room.py` | Measures how many special deals fit with each setting (`tools/out/deal_room.json`), for the manual settings' shop shelves |
| `tools/pool_matrix.py` | Runs OOTRR's generator once per setting value and records which locations each one adds or removes (`tools/out/pools.json`), for the manual settings |
| `tools/` | Scripts that rebuild `data/data.json` for a new OOTRR version, and the cross-check |

After editing anything in `src/`, run `python tools/assemble.py`.

## License

GPL-3.0-or-later, like OOTRR, which this tracker ports and embeds. See `LICENSE` and `NOTICE`. No game files are included.

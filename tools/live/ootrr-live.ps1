# OOTRR Tracker live helper (Windows).
#
# Reads the running game's progress straight from memory, so the tracker sees a check the moment it
# happens instead of when the game next saves, and hands the newest progress.sav to the tracker too
# (items, Link's area), so there is no save folder to pick. Works with Longshot and Hookshot, and with
# the yuzu-family emulators (Lichii, Ryuchii, Eden, yuzu, suyu, citron, sudachi).
#
# It only ever reads: nothing is written to the game or to your files. It answers only this PC
# (http://127.0.0.1:47811), and only the tracker page asks it anything. Close this window to stop it.
#
# Start it from the tracker's Longshot button (paste the command into a PowerShell window), or run
# this file with PowerShell. The memory layout (GameData Bool table and Bool64bitKey records) is the one documented by
# OotrR (github.com/Mozencaz/OotrR, MIT License, src/oot_rando/tracker/live_memory.py), which follows
# Hookshot's own cheat menu and the sloperina practice menu.

$ErrorActionPreference = 'Stop'
try { $Host.UI.RawUI.WindowTitle = 'OOTRR Tracker live helper' } catch {}

if (-not ('OotrrLive' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class OotrrLive
{
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")] static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr address, out MBI info, IntPtr length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder name, ref uint size);

    [StructLayout(LayoutKind.Sequential)]
    public struct MBI { public ulong BaseAddress; public ulong AllocationBase; public uint AllocationProtect; public uint Align1; public ulong RegionSize; public uint State; public uint Protect; public uint Type; public uint Align2; }

    const ulong HOST_BASE = 0x100000000000UL;       // Hookshot/Longshot: guest memory at this host address
    const ulong GAMEDATA_SLOT = 0x84C9E180UL;       // guest pointer to the holder of the GameDataMgr
    const ulong HOOKSHOT_MAIN = 0x80020000UL;       // where Hookshot keeps the main module
    const uint SEQUENCE_IS_CHILDHOOD = 0xCEA220D3U; // murmur3("Sequence_IsChildhood"): every save has it
    const uint MAX_ITEMS = 1U << 20;
    const int BOOL64_TYPE = 0xC58;                  // GameDataMgr offset of the Bool64bitKey entry (v131072)
    const ulong BOOL64_PROBE = 0xECDC46B409ED7D38UL; // the game's first Gold Skulltula key: every save knows it
    const uint MEM_COMMIT = 0x1000;
    static readonly string[] PORT_EXES = { "longshot.exe", "hookshot.exe" };
    static readonly string[] EMULATOR_EXES = { "lichii.exe", "ryuchii.exe", "eden.exe", "yuzu.exe", "suyu.exe", "citron.exe", "sudachi.exe" };

    static IntPtr handle = IntPtr.Zero;
    static string game = "";
    static string gameImage = "";   // the running game's exe, to find a portable install's saves beside it
    static ulong baseAddr = HOST_BASE, slot = GAMEDATA_SLOT;
    static int bool64Offset = -1;
    static DateTime nextScan = DateTime.MinValue;
    static string lastJson = null;
    static DateTime lastRead = DateTime.MinValue;

    // ---------- memory ----------
    static byte[] Raw(ulong host, int size)
    {
        if (size <= 0) return null;
        byte[] buffer = new byte[size];
        IntPtr done;
        if (!ReadProcessMemory(handle, new IntPtr((long)host), buffer, new IntPtr(size), out done) || done.ToInt64() != size) return null;
        return buffer;
    }
    static byte[] Read(ulong guest, int size) { return Raw(baseAddr + guest, size); }
    static ulong U64(ulong guest) { byte[] b = Read(guest, 8); return b == null ? 0 : BitConverter.ToUInt64(b, 0); }
    static uint U32(ulong guest) { byte[] b = Read(guest, 4); return b == null ? 0 : BitConverter.ToUInt32(b, 0); }
    static ulong Pointer(ulong guest) { ulong v = U64(guest); return (v >= 0x10000 && v < (1UL << 48) && (v & 7) == 0) ? v : 0; }

    // index of Bool `key` in the (hash u32, index u32) open-addressing table, or -1
    static long BoolSlot(byte[] table, uint size, uint key)
    {
        for (uint probe = 0; probe < size; probe++)
        {
            uint at = (uint)(((ulong)key + probe) % size);
            uint found = BitConverter.ToUInt32(table, (int)(at * 8));
            if (found == 0) return -1;
            if (found == key) return BitConverter.ToUInt32(table, (int)(at * 8 + 4));
        }
        return -1;
    }

    // true when guest `s` leads to a GameDataMgr whose table knows Sequence_IsChildhood
    static bool ValidSlot(ulong s)
    {
        ulong holder = Pointer(s);
        ulong manager = holder != 0 ? Pointer(holder) : 0;
        byte[] header = manager != 0 ? Read(manager, 48) : null;
        if (header == null) return false;
        uint count = BitConverter.ToUInt32(header, 16), size = BitConverter.ToUInt32(header, 44);
        ulong entries = BitConverter.ToUInt64(header, 24), table = BitConverter.ToUInt64(header, 32);
        if (table == 0 || entries == 0 || size == 0 || size > MAX_ITEMS || count == 0 || count > MAX_ITEMS) return false;
        byte[] raw = Read(table, (int)(size * 8));
        long index = raw != null ? BoolSlot(raw, size, SEQUENCE_IS_CHILDHOOD) : -1;
        return index >= 0 && index < count;
    }

    // ---------- finding the game ----------
    static string ImageOf(IntPtr h)
    {
        StringBuilder name = new StringBuilder(1024);
        uint size = (uint)name.Capacity;
        return QueryFullProcessImageName(h, 0, name, ref size) ? name.ToString() : "";
    }
    static bool IsPortFolder(string folder)
    {
        try { return folder != null && File.Exists(Path.Combine(folder, "image.bin")) && Directory.Exists(Path.Combine(folder, "romfs")); }
        catch { return false; }
    }
    static bool IsPort(string image)
    {
        string name = Path.GetFileName(image).ToLowerInvariant();
        if (Array.IndexOf(PORT_EXES, name) >= 0) return true;
        if (!name.EndsWith(".exe")) return false;
        string dir = Path.GetDirectoryName(image);
        if (IsPortFolder(dir)) return true;
        return dir != null && Path.GetFileName(dir).ToLowerInvariant() == "bin" && IsPortFolder(Path.GetDirectoryName(dir));
    }

    static bool EmulatorLayout()
    {
        // the loaded NSO modules: committed regions that start with a MOD0 pointer
        List<ulong> modules = new List<ulong>();
        ulong address = 0;
        MBI info;
        while (VirtualQueryEx(handle, new IntPtr((long)address), out info, new IntPtr(Marshal.SizeOf(typeof(MBI)))) != IntPtr.Zero)
        {
            if (info.State == MEM_COMMIT && info.RegionSize >= 0x1000)
            {
                byte[] head = Raw(info.BaseAddress, 8);
                uint offset = head != null ? BitConverter.ToUInt32(head, 4) : 0;
                if (offset >= 8 && offset < 0x10000000 && (offset & 3) == 0)
                {
                    byte[] magic = Raw(info.BaseAddress + offset, 4);
                    if (magic != null && Encoding.ASCII.GetString(magic) == "MOD0") modules.Add(info.BaseAddress);
                }
            }
            ulong next = info.BaseAddress + info.RegionSize;
            if (next <= address) break;
            address = next;
        }
        ulong off = GAMEDATA_SLOT - HOOKSHOT_MAIN;
        foreach (ulong module in modules)
        {
            byte[] raw = Raw(module + off, 8);
            if (raw == null || BitConverter.ToUInt64(raw, 0) == 0) continue;   // not main, or no game data yet
            for (ulong guest = 0x80000000UL; guest < 0x84000000UL; guest += 0x1000)
            {
                baseAddr = module - guest;
                if (ValidSlot(guest + off)) { slot = guest + off; return true; }
            }
        }
        return false;
    }

    static bool Alive()
    {
        if (handle == IntPtr.Zero) return false;
        uint code;
        if (GetExitCodeProcess(handle, out code) && code == 259) return true;   // STILL_ACTIVE
        Close();
        return false;
    }
    static void Close()
    {
        if (handle != IntPtr.Zero) CloseHandle(handle);
        handle = IntPtr.Zero; game = ""; bool64Offset = -1;
    }

    static string Attach()
    {
        if (Alive()) return null;
        if (DateTime.UtcNow < nextScan) return "The game isn't running (or hasn't loaded a save yet).";
        nextScan = DateTime.UtcNow.AddSeconds(3);
        foreach (Process p in Process.GetProcesses())
        {
            int pid = p.Id;
            p.Dispose();
            IntPtr h = OpenProcess(0x0010 | 0x0400 | 0x1000, false, pid);   // VM_READ | QUERY_INFORMATION | QUERY_LIMITED
            if (h == IntPtr.Zero) continue;
            string image = ImageOf(h), name = Path.GetFileName(image).ToLowerInvariant();
            handle = h;
            bool ok = false;
            try
            {
                if (Array.IndexOf(EMULATOR_EXES, name) >= 0) ok = EmulatorLayout();
                else if (image.Length > 0 && IsPort(image))
                {
                    baseAddr = HOST_BASE; slot = GAMEDATA_SLOT;
                    ok = Raw(HOST_BASE + GAMEDATA_SLOT, 8) != null && ValidSlot(GAMEDATA_SLOT);   // the launcher shares the exe: keep the game
                }
            }
            catch { ok = false; }
            if (ok) { game = Path.GetFileNameWithoutExtension(image); gameImage = image; nextSaveScan = DateTime.MinValue; Console.WriteLine("Reading " + game + " (process " + pid + ")"); return null; }
            handle = IntPtr.Zero;
            CloseHandle(h);
        }
        return "The game isn't running (or hasn't loaded a save yet).";
    }

    // ---------- the snapshot ----------
    static string Snapshot()
    {
        string why = Attach();
        if (why != null) return "{\"ok\":false,\"why\":" + Str(why) + Saves() + "}";
        ulong holder = U64(slot), manager = holder != 0 ? U64(holder) : 0;
        if (manager == 0) return "{\"ok\":false,\"why\":\"The game has no save loaded yet.\",\"game\":" + Str(game) + Saves() + "}";
        ulong table = U64(manager + 32), entries = U64(manager + 24);
        uint size = U32(manager + 44), count = U32(manager + 16);
        byte[] rawTable = (table != 0 && size > 0 && size <= MAX_ITEMS) ? Read(table, (int)(size * 8)) : null;
        byte[] rawEntries = (entries != 0 && count > 0 && count <= MAX_ITEMS) ? Read(entries, (int)(count * 24)) : null;
        if (rawTable == null || rawEntries == null) { Close(); return "{\"ok\":false,\"why\":\"Unexpected game data (a different game version?).\"" + Saves() + "}"; }
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"ok\":true,\"game\":").Append(Str(game)).Append(",\"bools\":[");
        bool first = true, known = false, child = false;
        for (uint i = 0; i < size; i++)
        {
            uint key = BitConverter.ToUInt32(rawTable, (int)(i * 8)), index = BitConverter.ToUInt32(rawTable, (int)(i * 8 + 4));
            if (key == 0 || index >= count) continue;
            bool on = (rawEntries[index * 24 + 22] & 1) != 0;
            if (key == SEQUENCE_IS_CHILDHOOD) { known = true; child = on; }
            if (!on) continue;
            if (!first) sb.Append(','); first = false;
            sb.Append(key);
        }
        if (!known) { Close(); return "{\"ok\":false,\"why\":\"Game data not recognised (a different game version?).\"" + Saves() + "}"; }
        sb.Append("],\"child\":").Append(child ? "true" : "false").Append(",\"keys\":");
        sb.Append(Bool64(manager));
        try { sb.Append(Where(manager)); } catch { }
        sb.Append(Saves()).Append('}');
        return sb.ToString();
    }

    // ---------- where Link is, live: Player_Pos_For_Map (Vector3) and Sequence_CurrentBanc (String64) ----------
    // Their type tables sit in the GameDataMgr's first 4 KB, shaped like the Bool one (count u32 at +0,
    // entries u64 at +8, table u64 at +16, size u32 at +28). Found with the research probe (Longshot v3,
    // 2026-11-16): Vector3 entries are 64 bytes with the current value at +36; String64 entries are 264
    // bytes with the current text at +116. The game updates both as Link moves, between saves.
    const uint PLAYER_POS = 0x960AD56AU, CURRENT_BANC = 0x1D6189DAU;
    // Player_Rot_For_Map: the way Link faces, in degrees (0 = north on the map, 90 = west, 180/-180 = south).
    // Float table entries are 40 bytes with the current value at +28 (found 2026-11-22 in the 2026-11-16 probe:
    // it follows his walking direction while he moves)
    const uint PLAYER_ROT = 0xA4AEE8CDU;
    static Dictionary<uint, int[]> typed = new Dictionary<uint, int[]>();   // hash -> [table offset, index]
    static ulong typedFor = 0;
    static ulong TypedValue(ulong manager, uint hash, int stride, int off)
    {
        if (typedFor != manager) { typed.Clear(); typedFor = manager; }
        int[] at;
        if (!typed.TryGetValue(hash, out at))
        {
            at = null;
            byte[] head = Read(manager, 0x1000);
            for (int o = 0; head != null && at == null && o + 32 <= head.Length; o += 8)
            {
                uint count = BitConverter.ToUInt32(head, o), size = BitConverter.ToUInt32(head, o + 28);
                ulong entries = BitConverter.ToUInt64(head, o + 8), table = BitConverter.ToUInt64(head, o + 16);
                if (count == 0 || count > 4096 || size == 0 || size > 8192 || entries == 0 || table == 0 || (entries & 3) != 0 || (table & 3) != 0 || entries >= (1UL << 48) || table >= (1UL << 48)) continue;
                byte[] raw = Read(table, (int)(size * 8));
                if (raw == null) continue;
                long ix = BoolSlot(raw, size, hash);
                if (ix >= 0 && ix < count) at = new int[] { o, (int)ix };
            }
            if (at == null) return 0;   // not found yet: look again next time
            typed[hash] = at;
        }
        ulong e = U64(manager + (ulong)at[0] + 8);
        return e == 0 ? 0 : e + (ulong)((long)at[1] * stride + off);
    }
    static string Where(ulong manager)
    {
        StringBuilder sb = new StringBuilder();
        ulong pa = TypedValue(manager, PLAYER_POS, 64, 36);
        byte[] pv = pa != 0 ? Read(pa, 12) : null;
        if (pv != null)
        {
            float x = BitConverter.ToSingle(pv, 0), y = BitConverter.ToSingle(pv, 4), z = BitConverter.ToSingle(pv, 8);
            if (!float.IsNaN(x) && !float.IsNaN(y) && !float.IsNaN(z) && Math.Abs(x) < 1e6 && Math.Abs(y) < 1e6 && Math.Abs(z) < 1e6)
                sb.Append(",\"pos\":[").Append(x.ToString("R", CultureInfo.InvariantCulture)).Append(',').Append(y.ToString("R", CultureInfo.InvariantCulture)).Append(',').Append(z.ToString("R", CultureInfo.InvariantCulture)).Append(']');
        }
        ulong ra = TypedValue(manager, PLAYER_ROT, 40, 28);
        byte[] rv = ra != 0 ? Read(ra, 4) : null;
        if (rv != null)
        {
            float r = BitConverter.ToSingle(rv, 0);
            if (!float.IsNaN(r) && Math.Abs(r) <= 360) sb.Append(",\"rot\":").Append(r.ToString("R", CultureInfo.InvariantCulture));
        }
        ulong ma = TypedValue(manager, CURRENT_BANC, 264, 116);
        byte[] mv = ma != 0 ? Read(ma, 64) : null;
        if (mv != null)
        {
            int end = Array.IndexOf(mv, (byte)0);
            string map = Encoding.ASCII.GetString(mv, 0, end < 0 ? mv.Length : end);
            bool plain = map.Length > 0;
            foreach (char c in map) if (!(char.IsLetterOrDigit(c) || c == '_' || c == '/')) plain = false;
            if (plain) sb.Append(",\"map\":").Append(Str(map.Substring(map.LastIndexOf('/') + 1)));   // "LostWood/LostWood_Child" -> "LostWood_Child"
        }
        return sb.ToString();
    }

    // the set Bool64bitKey flags (skulltulas, free-standing items…), as decimal strings; null when unreadable
    static string Bool64(ulong manager)
    {
        List<int> offsets = new List<int>();
        if (bool64Offset >= 0) offsets.Add(bool64Offset);
        offsets.Add(BOOL64_TYPE);
        for (int o = 0xC08; o < 0xD08; o += 8) if (o != BOOL64_TYPE) offsets.Add(o);
        foreach (int offset in offsets)
        {
            uint count = U32(manager + (ulong)offset);
            ulong records = U64(manager + (ulong)offset + 8);
            if (count == 0 || count > MAX_ITEMS || records == 0 || (records & 7) != 0) continue;
            byte[] raw = Read(records, (int)(count * 16));
            if (raw == null) continue;
            // the game's own keys come first, sorted; a seed's keys are appended after them
            int sortedEnd = (int)count;
            for (int i = 1; i < count; i++) if (BitConverter.ToUInt64(raw, i * 16) <= BitConverter.ToUInt64(raw, (i - 1) * 16)) { sortedEnd = i; break; }
            int lo = 0, hi = sortedEnd - 1;
            bool probe = false;
            while (lo <= hi)
            {
                int mid = (lo + hi) / 2;
                ulong k = BitConverter.ToUInt64(raw, mid * 16);
                if (k == BOOL64_PROBE) { probe = true; break; }
                if (k < BOOL64_PROBE) lo = mid + 1; else hi = mid - 1;
            }
            if (!probe) continue;
            bool64Offset = offset;
            StringBuilder sb = new StringBuilder("[");
            bool first = true;
            for (int i = 0; i < count; i++)
            {
                if (raw[i * 16 + 12] != 1) continue;
                if (!first) sb.Append(','); first = false;
                sb.Append('"').Append(BitConverter.ToUInt64(raw, i * 16)).Append('"');
            }
            return sb.Append(']').ToString();
        }
        bool64Offset = -1;
        return "null";
    }

    // ---------- the newest progress.sav ----------
    static List<string> SaveRoots()
    {
        List<string> roots = new List<string>();
        string home = Environment.GetEnvironmentVariable("USERPROFILE") ?? "", appdata = Environment.GetEnvironmentVariable("APPDATA") ?? "";
        // Longshot and Hookshot keep their saves in %APPDATA%\<name>\save (Longshot's log: "fs: mounted save");
        // older Longshot builds used %USERPROFILE%\Games\Longshot\user\save
        roots.Add(Path.Combine(appdata, @"Longshot\save"));
        roots.Add(Path.Combine(appdata, @"Hookshot\save"));
        roots.Add(Path.Combine(home, @"Games\Longshot\user\save"));
        foreach (string emu in new string[] { "lichii", "ryuchii", "eden", "yuzu", "suyu", "citron", "sudachi" })
            roots.Add(Path.Combine(appdata, emu + @"\nand\user\save"));
        // a portable Longshot keeps its saves beside the game ("user" in the game folder, or the portable
        // launcher's LongshotLauncher-data): look next to the running exe and a few folders up
        try
        {
            string dir = gameImage.Length > 0 ? Path.GetDirectoryName(gameImage) : null;
            for (int up = 0; up < 4 && !string.IsNullOrEmpty(dir); up++)
            {
                foreach (string sub in new string[] { "user", "save", "LongshotLauncher-data" }) roots.Add(Path.Combine(dir, sub));
                dir = Path.GetDirectoryName(dir);
            }
        }
        catch { }
        // any folder the player names: $env:OOTRR_SAVES = 'D:\Longshot\user'; (several with ;) before the start command
        foreach (string s in (Environment.GetEnvironmentVariable("OOTRR_SAVES") ?? "").Split(';'))
            if (s.Trim().Length > 0) roots.Add(Environment.ExpandEnvironmentVariables(s.Trim().Trim('"')));
        return roots;
    }
    static FileInfo newest = null;
    static string saidSave = null;   // the save last named in this window ("" for none)
    static DateTime nextSaveScan = DateTime.MinValue;
    static void FindNewest(DirectoryInfo dir, int depth, ref FileInfo best)
    {
        try
        {
            foreach (FileInfo f in dir.GetFiles("progress.sav")) if (best == null || f.LastWriteTimeUtc > best.LastWriteTimeUtc) best = f;
            if (depth < 6) foreach (DirectoryInfo d in dir.GetDirectories()) FindNewest(d, depth + 1, ref best);
        }
        catch { }
    }
    static FileInfo NewestSave()
    {
        if (DateTime.UtcNow >= nextSaveScan)
        {
            nextSaveScan = DateTime.UtcNow.AddSeconds(1);
            FileInfo best = null;
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string root in SaveRoots()) if (seen.Add(root) && Directory.Exists(root)) FindNewest(new DirectoryInfo(root), 0, ref best);
            string now = best != null ? best.FullName : "";
            if (saidSave != now) Console.WriteLine(best != null ? "Save: " + now : "No progress.sav found yet. For a portable Longshot or saves somewhere else, see the tracker's Longshot window.");
            saidSave = now;
            newest = best;
        }
        if (newest != null) newest.Refresh();
        return newest != null && newest.Exists ? newest : null;
    }
    static string Saves()
    {
        FileInfo f = NewestSave();
        if (f == null)
        {
            // where it looked, for the tracker to show
            StringBuilder sb = new StringBuilder(",\"save\":null,\"looked\":[");
            bool first = true;
            foreach (string r in SaveRoots()) { if (!first) sb.Append(','); first = false; sb.Append(Str(r)); }
            return sb.Append(']').ToString();
        }
        return ",\"save\":{\"slot\":" + Str(f.Directory.Name) + ",\"path\":" + Str(f.FullName) + ",\"sig\":" + Str(f.LastWriteTimeUtc.Ticks + ":" + f.Length) + "}";
    }

    static string Str(string s)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in s ?? "")
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    // ---------- a tiny HTTP server on 127.0.0.1 ----------
    static void Respond(NetworkStream stream, string status, string type, byte[] body, string extra)
    {
        string head = "HTTP/1.1 " + status + "\r\n"
            + "Access-Control-Allow-Origin: *\r\n"
            + "Access-Control-Allow-Methods: GET, OPTIONS\r\n"
            + "Access-Control-Allow-Headers: *\r\n"
            + "Access-Control-Allow-Private-Network: true\r\n"
            + "Access-Control-Expose-Headers: X-Save-Slot\r\n"
            + "Access-Control-Max-Age: 600\r\n"
            + "Cache-Control: no-store\r\n"
            + (type != null ? "Content-Type: " + type + "\r\n" : "")
            + (extra ?? "")
            + "Content-Length: " + (body != null ? body.Length : 0) + "\r\n"
            + "Connection: close\r\n\r\n";
        byte[] h = Encoding.ASCII.GetBytes(head);
        stream.Write(h, 0, h.Length);
        if (body != null && body.Length > 0) stream.Write(body, 0, body.Length);
    }

    static void Handle(TcpClient client)
    {
        using (client)
        {
            client.ReceiveTimeout = 3000; client.SendTimeout = 3000;
            NetworkStream stream = client.GetStream();
            byte[] buffer = new byte[8192];
            int length = 0;
            while (length < buffer.Length)
            {
                int n = stream.Read(buffer, length, buffer.Length - length);
                if (n <= 0) break;
                length += n;
                if (Encoding.ASCII.GetString(buffer, 0, length).Contains("\r\n\r\n")) break;
            }
            string request = Encoding.ASCII.GetString(buffer, 0, length);
            string[] first = request.Split(new string[] { "\r\n" }, StringSplitOptions.None)[0].Split(' ');
            if (first.Length < 2) return;
            string method = first[0], path = first[1].Split('?')[0];
            if (method == "OPTIONS") { Respond(stream, "204 No Content", null, null, null); return; }
            if (method != "GET") { Respond(stream, "405 Method Not Allowed", null, null, null); return; }
            if (path == "/state")
            {
                lock (typeof(OotrrLive))
                {
                    // one memory read per quarter second, however many tabs ask
                    if (lastJson == null || (DateTime.UtcNow - lastRead).TotalMilliseconds > 250)
                    {
                        try { lastJson = Snapshot(); }
                        catch (Exception e) { Close(); lastJson = "{\"ok\":false,\"why\":" + Str("Couldn't read the game: " + e.Message) + "}"; }
                        lastRead = DateTime.UtcNow;
                    }
                    Respond(stream, "200 OK", "application/json", Encoding.UTF8.GetBytes(lastJson), null);
                }
            }
            else if (path == "/save")
            {
                FileInfo f;
                lock (typeof(OotrrLive)) { f = NewestSave(); }
                byte[] data = null;
                if (f != null) { try { using (FileStream fs = new FileStream(f.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) { data = new byte[fs.Length]; int at = 0; while (at < data.Length) { int n = fs.Read(data, at, data.Length - at); if (n <= 0) break; at += n; } } } catch { data = null; } }
                if (data == null) Respond(stream, "404 Not Found", null, null, null);
                else Respond(stream, "200 OK", "application/octet-stream", data, "X-Save-Slot: " + f.Directory.Name + "\r\n");
            }
            else if (path == "/") Respond(stream, "200 OK", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("OOTRR Tracker live helper is running. The tracker page reads /state and /save."), null);
            else Respond(stream, "404 Not Found", null, null, null);
        }
    }

    // ---------- research: where the game keeps Link's position (run with OOTRR_PROBE set) ----------
    // Scans the GameDataMgr's first 4 KB for type tables shaped like the Bool one (count u32 at +0,
    // entries u64 at +8, table u64 at +16, size u32 at +28), notes which hold Player_Pos_For_Map and its
    // neighbours, then samples the small tables once a second while the player moves. Reads only.
    static string Hex(byte[] b) { if (b == null) return "null"; StringBuilder sb = new StringBuilder("\""); foreach (byte x in b) sb.Append(x.ToString("x2")); return sb.Append('"').ToString(); }
    public static void Probe(string outDir, int seconds)
    {
        Directory.CreateDirectory(outDir);
        uint[] wanted = { 0x960AD56AU, 0xA4AEE8CDU, 0x1D6189DAU, 0xD4B395C7U, 0xCEA220D3U };   // Player_Pos/Rot_For_Map, Sequence_CurrentBanc, Horse_Pos_For_Map, Sequence_IsChildhood
        string why = null;
        for (int i = 0; i < 20; i++) { nextScan = DateTime.MinValue; why = Attach(); if (why == null) break; Console.WriteLine("Waiting for the game: " + why); Thread.Sleep(1000); }
        if (why != null) { File.WriteAllText(Path.Combine(outDir, "probe.json"), "{\"ok\":false,\"why\":" + Str(why) + "}"); return; }
        ulong holder = U64(slot), manager = holder != 0 ? U64(holder) : 0;
        byte[] head = manager != 0 ? Read(manager, 0x1000) : null;
        StringBuilder js = new StringBuilder();
        js.Append("{\"ok\":true,\"game\":").Append(Str(game)).Append(",\"base\":").Append(baseAddr).Append(",\"slot\":").Append(slot).Append(",\"manager\":").Append(manager).Append(",\"head\":").Append(Hex(head)).Append(",\"tables\":[");
        List<ulong[]> small = new List<ulong[]>();   // [offset, entries, count]
        bool firstT = true;
        if (head != null)
        {
            for (int o = 0; o + 32 <= head.Length; o += 8)
            {
                uint count = BitConverter.ToUInt32(head, o), size = BitConverter.ToUInt32(head, o + 28);
                ulong entries = BitConverter.ToUInt64(head, o + 8), table = BitConverter.ToUInt64(head, o + 16);
                if (count == 0 || count > MAX_ITEMS || size == 0 || size > MAX_ITEMS || entries == 0 || table == 0 || (entries & 3) != 0 || (table & 3) != 0 || entries >= (1UL << 48) || table >= (1UL << 48)) continue;
                byte[] raw = Read(table, (int)(size * 8));
                if (raw == null) continue;
                StringBuilder found = new StringBuilder();
                foreach (uint w in wanted) { long ix = BoolSlot(raw, size, w); if (ix >= 0 && ix < count) { if (found.Length > 0) found.Append(','); found.Append("\"").Append(w.ToString("X8")).Append("\":").Append(ix); } }
                if (!firstT) js.Append(','); firstT = false;
                js.Append("{\"o\":").Append(o).Append(",\"count\":").Append(count).Append(",\"size\":").Append(size).Append(",\"entries\":").Append(entries).Append(",\"table\":").Append(table).Append(",\"found\":{").Append(found).Append("}}");
                if (count <= 400) small.Add(new ulong[] { (ulong)o, entries, count });
            }
        }
        js.Append("],\"samples\":[");
        string saveSig = "";
        for (int t = 0; t < seconds; t++)
        {
            if (t > 0) js.Append(',');
            js.Append("{\"t\":").Append(t).Append(",\"dumps\":{");
            bool firstD = true;
            foreach (ulong[] sm in small)
            {
                byte[] d = Read(sm[1], (int)Math.Min(sm[2] * 64, 32768));
                if (!firstD) js.Append(','); firstD = false;
                js.Append("\"").Append(sm[0]).Append("\":").Append(Hex(d));
            }
            js.Append("}");
            FileInfo f = NewestSave();
            string sig = f != null ? f.LastWriteTimeUtc.Ticks + ":" + f.Length : "";
            if (f != null && sig != saveSig) { saveSig = sig; string name = "save-" + t + ".sav"; try { File.Copy(f.FullName, Path.Combine(outDir, name), true); js.Append(",\"save\":").Append(Str(name)); } catch { } }
            js.Append("}");
            Console.WriteLine("Sample " + (t + 1) + " of " + seconds + ": keep moving Link around (stairs, other floors)" + (t == seconds / 2 ? ", and save the game once now" : ""));
            Thread.Sleep(1000);
        }
        js.Append("]}");
        File.WriteAllText(Path.Combine(outDir, "probe.json"), js.ToString());
        Console.WriteLine("Done: " + Path.Combine(outDir, "probe.json"));
    }

    // ---------- research: the game's maps (run with OOTRR_PROBE=map) ----------
    // Walks the player through a few steps (map closed, map open, zoomed, other menu pages...) and at each step
    // copies every GameData type table's entries (all but the huge ones) three times, a second apart, into
    // map-probe\step-<n>-<k>.bin, with map-probe\index.json saying what each step was and where each table
    // sits in the file. Comparing steps shows which values follow the map screen. Reads only.
    static readonly string[] MAP_STEPS = {
        "Unpause the game and stand still (no menus open)",
        "Open the pause menu on the MAP page",
        "Close the pause menu",
        "Open the pause menu on the MAP page again",
        "On the map page, zoom in (or switch to the other map view)",
        "Zoom back out, and scroll or move the map cursor around",
        "Switch the pause menu to a different page (items, equipment...)",
        "Close the pause menu, then turn the camera around slowly (Link standing still)",
        "Walk Link in a circle (no menus)",
        "Stand still, no menus (last step)",
    };
    public static void MapProbe(string outDir)
    {
        Directory.CreateDirectory(outDir);
        string why = null;
        for (int i = 0; i < 20; i++) { nextScan = DateTime.MinValue; why = Attach(); if (why == null) break; Console.WriteLine("Waiting for the game: " + why); Thread.Sleep(1000); }
        if (why != null) { File.WriteAllText(Path.Combine(outDir, "index.json"), "{\"ok\":false,\"why\":" + Str(why) + "}"); return; }
        ulong holder = U64(slot), manager = holder != 0 ? U64(holder) : 0;
        byte[] head = manager != 0 ? Read(manager, 0x1000) : null;
        List<ulong[]> tabs = new List<ulong[]>();   // [offset, entries, count, size, table]
        if (head != null)
            for (int o = 0; o + 32 <= head.Length; o += 8)
            {
                uint count = BitConverter.ToUInt32(head, o), size = BitConverter.ToUInt32(head, o + 28);
                ulong entries = BitConverter.ToUInt64(head, o + 8), table = BitConverter.ToUInt64(head, o + 16);
                if (count == 0 || count > MAX_ITEMS || size == 0 || size > MAX_ITEMS || entries == 0 || table == 0 || (entries & 3) != 0 || (table & 3) != 0 || entries >= (1UL << 48) || table >= (1UL << 48)) continue;
                if (count > 50000) continue;
                tabs.Add(new ulong[] { (ulong)o, entries, count, size, table });
            }
        StringBuilder js = new StringBuilder();
        js.Append("{\"ok\":true,\"game\":").Append(Str(game)).Append(",\"manager\":").Append(manager).Append(",\"tables\":[");
        for (int i = 0; i < tabs.Count; i++)
        {
            if (i > 0) js.Append(',');
            // each table's hash slots too, so values can be named afterwards (murmur3 of the flag names)
            byte[] raw = Read(tabs[i][4], (int)(tabs[i][3] * 8));
            string rawName = "table-" + tabs[i][0] + ".bin";
            if (raw != null) File.WriteAllBytes(Path.Combine(outDir, rawName), raw);
            js.Append("{\"o\":").Append(tabs[i][0]).Append(",\"count\":").Append(tabs[i][2]).Append(",\"size\":").Append(tabs[i][3]).Append(",\"slots\":").Append(Str(raw != null ? rawName : ""));
            js.Append("}");
        }
        js.Append("],\"steps\":[");
        for (int st = 0; st < MAP_STEPS.Length; st++)
        {
            Console.WriteLine();
            Console.WriteLine("Step " + (st + 1) + " of " + MAP_STEPS.Length + ": " + MAP_STEPS[st]);
            for (int c = 8; c > 0; c--) { Console.Write("\r  starting in " + c + "s  "); Thread.Sleep(1000); }
            Console.WriteLine("\r  recording, keep doing it...   ");
            if (st > 0) js.Append(',');
            js.Append("{\"step\":").Append(Str(MAP_STEPS[st])).Append(",\"files\":[");
            for (int k = 0; k < 3; k++)
            {
                string name = "step-" + (st + 1) + "-" + (k + 1) + ".bin";
                using (FileStream fs = File.Create(Path.Combine(outDir, name)))
                {
                    if (k > 0) js.Append(',');
                    js.Append("{\"file\":").Append(Str(name)).Append(",\"parts\":[");
                    long at = 0;
                    for (int i = 0; i < tabs.Count; i++)
                    {
                        int len = (int)Math.Min(tabs[i][2] * 64, 4UL << 20);
                        // the entry size differs per type (24 to 264 bytes): read generously, and less if that runs off the end
                        byte[] d = Read(tabs[i][1], len);
                        while (d == null && len > 4096) { len /= 2; d = Read(tabs[i][1], len); }
                        if (d == null) d = new byte[0];
                        fs.Write(d, 0, d.Length);
                        if (i > 0) js.Append(',');
                        js.Append("[").Append(tabs[i][0]).Append(',').Append(at).Append(',').Append(d.Length).Append("]");
                        at += d.Length;
                    }
                    js.Append("]}");
                }
                Thread.Sleep(1000);
            }
            js.Append("]}");
            Console.WriteLine("  done.");
        }
        js.Append("]}");
        File.WriteAllText(Path.Combine(outDir, "index.json"), js.ToString());
        Console.WriteLine();
        Console.WriteLine("All done: " + outDir);
    }

    public static void Run(int port)
    {
        TcpListener listener = new TcpListener(IPAddress.Loopback, port);
        try { listener.Start(); }
        catch (SocketException) { Console.WriteLine("Port " + port + " is busy: is the helper already running in another window?"); return; }
        Console.WriteLine("OOTRR Tracker live helper: http://127.0.0.1:" + port + "/");
        Console.WriteLine("Leave this window open while you play; the tracker connects by itself. Close it to stop.");
        while (true)
        {
            TcpClient client = listener.AcceptTcpClient();
            ThreadPool.QueueUserWorkItem(delegate (object c) { try { Handle((TcpClient)c); } catch { } }, client);
        }
    }
}
'@
}

if ($env:OOTRR_PROBE -eq 'map') {
    # research mode: the game's map screens, into %LOCALAPPDATA%\ootrr\map-probe
    $out = Join-Path $env:LOCALAPPDATA 'ootrr\map-probe'
    [OotrrLive]::MapProbe($out)
    Write-Host "Finished. Tell Claude it's done; you can close this window."
} elseif ($env:OOTRR_PROBE) {
    # research mode: samples where the game keeps Link's position, into %LOCALAPPDATA%\ootrr\tracker-probe
    $out = Join-Path $env:LOCALAPPDATA 'ootrr\tracker-probe'
    [OotrrLive]::Probe($out, [int]$env:OOTRR_PROBE)
    Write-Host "Finished. Tell Claude it's done; you can close this window."
} else {
    [OotrrLive]::Run(47811)
}

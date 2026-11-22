// OOTRR Tracker desktop app: the in-game overlay.
//
// A see-through, click-through window laid over the game picture in the Longshot window, drawing the
// tracker's pins on the game's own maps:
//   - the pause menu's Map page (the area's whole map), and
//   - the minimap in the bottom-right corner (the same picture, smaller), while no menu is open.
// It shows only while the game window is in front, and only in overworld areas (the field maps).
//
// Where the game draws its maps, measured from screenshots on 2026-11-22 (Goron City, 2560x1440 screen),
// in the game's 1920x1080 layout: the area's map picture (2000x1440, the same file the Map Tracker shows)
// is drawn at 0.65 scale with its top-left corner at (310, 157) on the Map page, and at 0.24 scale at
// (1490, 720) for the minimap. The pins' u/v are on that picture.
//
// What's on screen comes from the game's memory (the helper's WhereNow: Link's map and the pause menu's
// page); the pins and their colours come from the tracker page ("overlay:" messages). Reads only.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace OotrrTracker
{
    sealed class Overlay : Form
    {
        // the game's pause menu page (OotrrLive's PAUSE_PAGE values)
        const string PAGE_NONE = "b6eede09", PAGE_MAP = "23e49b16";
        // the map picture's place in the game's 1920x1080 layout: x, y, scale (picture 2000x1440)
        static readonly float[] PAUSE = { 310f, 157f, 0.65f }, MINI = { 1490f, 720f, 0.24f };
        const float PIC_W = 2000f, PIC_H = 1440f;

        sealed class Pin { public float U, V; public string St; }
        Dictionary<string, List<Pin>> maps = new Dictionary<string, List<Pin>>();
        bool on = true;
        volatile string whereJson = null;   // OotrrLive.WhereNow(), refreshed by a background thread
        string drawn = null;            // what's on screen now, to redraw only on a change
        readonly System.Windows.Forms.Timer tick = new System.Windows.Forms.Timer();

        public Overlay()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Bounds = new Rectangle(0, 0, 1, 1);
            Text = "OOTRR Tracker overlay";

            Thread poll = new Thread(() =>
            {
                while (true)
                {
                    try { whereJson = OotrrLive.WhereNow(); } catch { whereJson = null; }
                    Thread.Sleep(150);
                }
            });
            poll.IsBackground = true;
            poll.Start();

            tick.Interval = 100;
            tick.Tick += (s, e) => Step();
            tick.Start();
        }

        // never takes the focus, lets every click through to the game, stays on top, isn't in Alt+Tab
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST;
                return cp;
            }
        }
        protected override bool ShowWithoutActivation { get { return true; } }

        // the page's pins: {"on":true,"maps":{"GoronCity_Child":[[u,v,"g","name"],...],...}}
        public void SetPins(string json)
        {
            try
            {
                Dictionary<string, object> d = (Dictionary<string, object>)new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.DeserializeObject(json);
                Dictionary<string, List<Pin>> next = new Dictionary<string, List<Pin>>();
                Dictionary<string, object> m = d.ContainsKey("maps") ? d["maps"] as Dictionary<string, object> : null;
                if (m != null)
                    foreach (KeyValuePair<string, object> kv in m)
                    {
                        List<Pin> list = new List<Pin>();
                        object[] arr = kv.Value as object[];
                        if (arr != null)
                            foreach (object o in arr)
                            {
                                object[] p = o as object[];
                                if (p == null || p.Length < 3) continue;
                                list.Add(new Pin { U = Convert.ToSingle(p[0]), V = Convert.ToSingle(p[1]), St = Convert.ToString(p[2]) });
                            }
                        next[kv.Key] = list;
                    }
                maps = next;
                on = !(d.ContainsKey("on") && d["on"] is bool && !(bool)d["on"]);
                drawn = null;
            }
            catch { }
        }

        void Step()
        {
            string view = null;   // "<map>|<pause or mini>"
            Rectangle game = Rectangle.Empty;
            try
            {
                string w = whereJson;
                IntPtr hwnd = on && w != null && w.Contains("\"ok\":true") ? GameWindow() : IntPtr.Zero;
                if (hwnd != IntPtr.Zero && GetForegroundWindow() == hwnd)
                {
                    string map = Field(w, "map"), page = Field(w, "page");
                    if (map != null && maps.ContainsKey(map) && maps[map].Count > 0)
                    {
                        if (page == PAGE_MAP) view = map + "|pause";
                        else if (page == PAGE_NONE) view = map + "|mini";
                    }
                    if (view != null) game = GameRect(hwnd);
                    if (game.Width < 64 || game.Height < 36) view = null;
                }
            }
            catch { view = null; }

            if (view == null) { if (Visible) Hide(); drawn = null; return; }
            string key = view + "|" + game.ToString();
            if (key == drawn && Visible) return;
            drawn = key;
            string[] v = view.Split('|');
            DrawPins(game, maps[v[0]], v[1] == "pause" ? PAUSE : MINI, v[1] == "pause");
        }

        // the game's 16:9 picture inside the game window's client area (black bars on the sides or top)
        static Rectangle GameRect(IntPtr hwnd)
        {
            RECT c;
            if (!GetClientRect(hwnd, out c)) return Rectangle.Empty;
            POINT o = new POINT();
            ClientToScreen(hwnd, ref o);
            int cw = c.Right - c.Left, ch = c.Bottom - c.Top;
            if (cw <= 0 || ch <= 0) return Rectangle.Empty;
            int w = cw, h = (int)Math.Round(cw * 9.0 / 16.0);
            if (h > ch) { h = ch; w = (int)Math.Round(ch * 16.0 / 9.0); }
            return new Rectangle(o.X + (cw - w) / 2, o.Y + (ch - h) / 2, w, h);
        }

        // the emulator's main window: the biggest visible titled window of the game's process
        IntPtr gameHwnd = IntPtr.Zero;
        int gamePid = 0;
        DateTime nextFind = DateTime.MinValue;
        IntPtr GameWindow()
        {
            int pid = OotrrLive.GamePid;
            if (pid == 0) return IntPtr.Zero;
            if (pid == gamePid && gameHwnd != IntPtr.Zero && IsWindow(gameHwnd) && IsWindowVisible(gameHwnd)) return gameHwnd;
            if (DateTime.UtcNow < nextFind && pid == gamePid) return IntPtr.Zero;
            nextFind = DateTime.UtcNow.AddSeconds(2);
            gamePid = pid; gameHwnd = IntPtr.Zero;
            long best = 0;
            EnumWindows((h, l) =>
            {
                uint p;
                GetWindowThreadProcessId(h, out p);
                if (p != (uint)pid || !IsWindowVisible(h) || GetWindowTextLength(h) == 0) return true;
                RECT r;
                if (!GetWindowRect(h, out r)) return true;
                long a = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
                if (a > best) { best = a; gameHwnd = h; }
                return true;
            }, IntPtr.Zero);
            return gameHwnd;
        }

        static string Field(string json, string name)
        {
            string k = "\"" + name + "\":\"";
            int i = json.IndexOf(k, StringComparison.Ordinal);
            if (i < 0) return null;
            i += k.Length;
            int j = json.IndexOf('"', i);
            return j < 0 ? null : json.Substring(i, j - i);
        }

        static Color ColorOf(string st)
        {
            switch (st)
            {
                case "g": return Color.FromArgb(255, 70, 200, 95);
                case "y": return Color.FromArgb(255, 235, 195, 55);
                default: return Color.FromArgb(255, 220, 75, 70);
            }
        }

        // draws the pins into a transparent picture the size of the game and puts it on screen
        void DrawPins(Rectangle game, List<Pin> pins, float[] at, bool pause)
        {
            float k = game.Width / 1920f;   // game pixels per layout unit
            float x0 = at[0] * k, y0 = at[1] * k, pw = PIC_W * at[2] * k, ph = PIC_H * at[2] * k;
            float r = Math.Max(pause ? 5f : 3f, (pause ? 9f : 5f) * k);
            using (Bitmap bmp = new Bitmap(game.Width, game.Height, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    using (Pen edge = new Pen(Color.FromArgb(230, 20, 16, 12), Math.Max(1.2f, r * 0.28f)))
                    {
                        // red first, then yellow, then green: what's in logic stays on top
                        foreach (string st in new string[] { "r", "y", "g" })
                            using (SolidBrush b = new SolidBrush(ColorOf(st)))
                                foreach (Pin p in pins)
                                {
                                    if (p.St != st) continue;
                                    float x = x0 + p.U * pw, y = y0 + p.V * ph;
                                    g.FillEllipse(b, x - r, y - r, 2 * r, 2 * r);
                                    g.DrawEllipse(edge, x - r, y - r, 2 * r, 2 * r);
                                }
                    }
                }
                Put(bmp, game);
            }
            if (!Visible) Show();
        }

        // UpdateLayeredWindow with the picture's own transparency
        void Put(Bitmap bmp, Rectangle at)
        {
            IntPtr screen = GetDC(IntPtr.Zero), mem = CreateCompatibleDC(screen), hb = IntPtr.Zero, old = IntPtr.Zero;
            try
            {
                hb = bmp.GetHbitmap(Color.FromArgb(0));
                old = SelectObject(mem, hb);
                SIZE size = new SIZE { cx = bmp.Width, cy = bmp.Height };
                POINT src = new POINT(), dst = new POINT { X = at.X, Y = at.Y };
                BLENDFUNCTION blend = new BLENDFUNCTION { BlendOp = 0, BlendFlags = 0, SourceConstantAlpha = 255, AlphaFormat = 1 };
                UpdateLayeredWindow(Handle, screen, ref dst, ref size, mem, ref src, 0, ref blend, 2);
            }
            finally
            {
                if (old != IntPtr.Zero) SelectObject(mem, old);
                if (hb != IntPtr.Zero) DeleteObject(hb);
                DeleteDC(mem);
                ReleaseDC(IntPtr.Zero, screen);
            }
        }

        const int WS_EX_LAYERED = 0x80000, WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000, WS_EX_TOPMOST = 0x8;
        [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; }
        [StructLayout(LayoutKind.Sequential, Pack = 1)] struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }
        delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
        [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
        [DllImport("user32.dll", SetLastError = true)] static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dst, ref POINT pt, ref SIZE sz, IntPtr src, ref POINT srcPt, int key, ref BLENDFUNCTION blend, int flags);
        [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
        [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
    }
}

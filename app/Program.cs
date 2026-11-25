// OOTRR Tracker desktop app.
//
// A window that shows the tracker page (index.html, the same file as the website, from the "web" folder
// beside the exe) and runs the Longshot live helper inside the app, so there is no PowerShell window and
// no save folder to pick: the helper finds the running game and the newest save by itself, and the page
// talks to it on http://127.0.0.1:47811 exactly as it does on the website.
//
// Like the helper script, the app only ever reads: nothing is written to the game or to your saves.

using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace OotrrTracker
{
    static class Program
    {
        // The page is served from this made-up https host; its storage (progress, settings, the seed)
        // belongs to it and lives in the app's own data folder, separate from the browser.
        public const string Host = "tracker.ootrr";
        public const int HelperPort = 47811;
        public static readonly string Data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OOTRR Tracker");

        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Directory.CreateDirectory(Data);
            Updater.CleanUp();

            // the live helper (the same code as tools/live/ootrr-live.ps1). If the PowerShell helper is
            // already running, the port is taken and the page simply talks to that one instead.
            Thread helper = new Thread(() => { try { OotrrLive.Run(HelperPort); } catch { } });
            helper.IsBackground = true;
            helper.Start();

            Application.Run(new MainForm());
        }
    }

    sealed class MainForm : Form
    {
        readonly WebView2 view = new WebView2();
        readonly string placeFile = Path.Combine(Program.Data, "window.txt");
        // which tracker was open last: "stable" (web\index.html, OOTRR's latest release) or "nightly"
        // (web\nightly\index.html, OOTRR's nightly builds); the page's Switch button moves between them
        readonly string channelFile = Path.Combine(Program.Data, "channel.txt");
        bool updateChecked;

        public MainForm()
        {
            Text = "OOTRR Tracker";
            BackColor = Color.FromArgb(0x10, 0x12, 0x16);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            StartPosition = FormStartPosition.Manual;
            Size = new Size(1600, 950);
            MinimumSize = new Size(800, 500);
            RestorePlace();

            view.Dock = DockStyle.Fill;
            view.DefaultBackgroundColor = BackColor;
            Controls.Add(view);

            Load += async (s, e) => await Start();
            FormClosing += (s, e) => SavePlace();
        }

        async System.Threading.Tasks.Task Start()
        {
            string web = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "web");
            if (!File.Exists(Path.Combine(web, "index.html")))
            {
                MessageBox.Show(this, "The tracker page (web\\index.html) is missing beside the app. Unzip the whole download again.", "OOTRR Tracker", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
                return;
            }
            try
            {
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.Data, "WebView2"));
                await view.EnsureCoreWebView2Async(env);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                if (MessageBox.Show(this, "The tracker needs Microsoft Edge WebView2, which Windows 10 and 11 normally include, but it isn't installed on this PC.\n\nOpen Microsoft's download page now?", "OOTRR Tracker", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
                    OpenOutside("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
                Close();
                return;
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "The tracker window couldn't start: " + ex.Message, "OOTRR Tracker", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
                return;
            }

            CoreWebView2 core = view.CoreWebView2;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDevToolsEnabled = true;   // F12, handy when reporting a bug
            core.SetVirtualHostNameToFolderMapping(Program.Host, web, CoreWebView2HostResourceAccessKind.Allow);

            // tell the page it's in the app (it then connects to the built-in helper by itself)
            string version = typeof(Program).Assembly.GetName().Version.ToString(3);
            bool hasNightly = File.Exists(Path.Combine(web, "nightly", "index.html"));
            await core.AddScriptToExecuteOnDocumentCreatedAsync("window.OOTRR_APP = { version: '" + version + "', channels: " + (hasNightly ? "true" : "false") + " };");

            // links out of the tracker (GitHub, bug reports) open in the normal browser; the tracker's own
            // pop-up windows (the stream overlay) stay in the app
            core.NewWindowRequested += (s, e) =>
            {
                if (IsOutside(e.Uri)) { e.Handled = true; OpenOutside(e.Uri); }
            };
            core.NavigationStarting += (s, e) =>
            {
                if (IsOutside(e.Uri)) { e.Cancel = true; OpenOutside(e.Uri); }
            };

            // the tracker page asking to reach the built-in helper on this PC (Chromium's local network
            // prompt) is allowed without asking; anything personal (camera, mic, location, notifications) isn't
            core.PermissionRequested += (s, e) =>
            {
                Uri u;
                bool ours = Uri.TryCreate(e.Uri, UriKind.Absolute, out u) && string.Equals(u.Host, Program.Host, StringComparison.OrdinalIgnoreCase);
                if (!ours) return;
                switch (e.PermissionKind)
                {
                    case CoreWebView2PermissionKind.Camera:
                    case CoreWebView2PermissionKind.Microphone:
                    case CoreWebView2PermissionKind.Geolocation:
                    case CoreWebView2PermissionKind.Notifications:
                        e.State = CoreWebView2PermissionState.Deny;
                        break;
                    default:
                        e.State = CoreWebView2PermissionState.Allow;
                        break;
                }
            };

            // messages from the page: "saves:<folders>" names extra save folders for the helper (a portable
            // Longshot, or saves somewhere else); the helper reads OOTRR_SAVES each time it looks for saves
            core.WebMessageReceived += (s, e) =>
            {
                string msg;
                try { msg = e.TryGetWebMessageAsString(); } catch { return; }
                if (msg != null && msg.StartsWith("saves:", StringComparison.Ordinal))
                    Environment.SetEnvironmentVariable("OOTRR_SAVES", msg.Substring(6));
                else if (msg == "update:check")
                    BeginInvoke(new Action(async () => await Updater.Check(this, false)));
            };

            // remember which tracker is open, and look for an update once the first page is up
            core.NavigationCompleted += (s, e) =>
            {
                Uri u;
                if (e.IsSuccess && Uri.TryCreate(core.Source, UriKind.Absolute, out u) && string.Equals(u.Host, Program.Host, StringComparison.OrdinalIgnoreCase))
                    try { File.WriteAllText(channelFile, u.AbsolutePath.StartsWith("/nightly/", StringComparison.OrdinalIgnoreCase) ? "nightly" : "stable"); } catch { }
                if (!updateChecked)
                {
                    updateChecked = true;
                    BeginInvoke(new Action(async () => await Updater.Check(this, true)));
                }
            };

            core.DocumentTitleChanged += (s, e) =>
            {
                string t = core.DocumentTitle;
                Text = string.IsNullOrEmpty(t) ? "OOTRR Tracker" : t;
            };

            string channel = "stable";
            try { channel = File.ReadAllText(channelFile).Trim(); } catch { }
            core.Navigate("https://" + Program.Host + (channel == "nightly" && hasNightly ? "/nightly/index.html" : "/index.html"));
        }

        static bool IsOutside(string uri)
        {
            Uri u;
            if (!Uri.TryCreate(uri, UriKind.Absolute, out u)) return false;
            if (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "mailto") return false;
            return !string.Equals(u.Host, Program.Host, StringComparison.OrdinalIgnoreCase);
        }

        static void OpenOutside(string uri)
        {
            try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { }
        }

        // the window's place and size, kept between runs
        void RestorePlace()
        {
            try
            {
                string[] p = File.ReadAllText(placeFile).Split(' ');
                Rectangle r = new Rectangle(int.Parse(p[0], CultureInfo.InvariantCulture), int.Parse(p[1], CultureInfo.InvariantCulture),
                    int.Parse(p[2], CultureInfo.InvariantCulture), int.Parse(p[3], CultureInfo.InvariantCulture));
                // only if it's still on a screen (a monitor may have been unplugged)
                foreach (Screen sc in Screen.AllScreens)
                    if (sc.WorkingArea.IntersectsWith(r)) { Bounds = r; if (p.Length > 4 && p[4] == "max") WindowState = FormWindowState.Maximized; return; }
            }
            catch { }
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            Size = new Size(Math.Min(1600, wa.Width), Math.Min(950, wa.Height));
            Location = new Point(wa.Left + (wa.Width - Width) / 2, wa.Top + (wa.Height - Height) / 2);
        }

        void SavePlace()
        {
            try
            {
                Rectangle r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                File.WriteAllText(placeFile, string.Format(CultureInfo.InvariantCulture, "{0} {1} {2} {3} {4}", r.X, r.Y, r.Width, r.Height, WindowState == FormWindowState.Maximized ? "max" : "normal"));
            }
            catch { }
        }
    }
}

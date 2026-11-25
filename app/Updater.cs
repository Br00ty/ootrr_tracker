// Updates the app from the GitHub releases of Br00ty/ootrr_tracker.
//
// On start the app looks at the newest published release (not drafts or pre-releases) that has the app's zip
// (OOTRR-Tracker.zip) attached. Its tag is the app version ("v0.2.0"; the release build stamps the exe with it). If
// it's newer than this exe, the player is asked whether to update now. Updating downloads the zip, unpacks it
// beside the app, puts each new file in place (the file in use is renamed to <name>.old first: Windows lets a
// running exe or DLL be renamed but not overwritten) and restarts the app. The .old files are deleted on the
// next start. Progress lives in %LOCALAPPDATA%\OOTRR Tracker, so it isn't touched.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace OotrrTracker
{
    static class Updater
    {
        const string Releases = "https://api.github.com/repos/Br00ty/ootrr_tracker/releases?per_page=20";
        const string Asset = "OOTRR-Tracker.zip";

        static string AppDir => Path.GetDirectoryName(Application.ExecutablePath);

        public static Version Current => typeof(Program).Assembly.GetName().Version;

        // the .old files the last update left behind
        public static void CleanUp()
        {
            try
            {
                foreach (string f in Directory.GetFiles(AppDir, "*.old", SearchOption.AllDirectories))
                    try { File.Delete(f); } catch { }
            }
            catch { }
        }

        sealed class Release
        {
            public Version Version;
            public string Tag, Page, Zip, Notes;
        }

        static WebClient Client()
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            WebClient wc = new WebClient();
            wc.Headers.Add("User-Agent", "OOTRR-Tracker/" + Current.ToString(3));
            return wc;
        }

        static async Task<Release> Newest()
        {
            string json;
            using (WebClient wc = Client())
            {
                wc.Headers.Add("Accept", "application/vnd.github+json");
                json = await wc.DownloadStringTaskAsync(Releases);
            }
            JavaScriptSerializer js = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
            Release best = null;
            foreach (object o in js.Deserialize<ArrayList>(json))
            {
                Dictionary<string, object> r = o as Dictionary<string, object>;
                if (r == null || True(r, "draft") || True(r, "prerelease")) continue;
                string tag = r.TryGetValue("tag_name", out object t) ? t as string : null;
                Version v;
                if (tag == null || !Version.TryParse(tag.TrimStart('v', 'V'), out v)) continue;
                string zip = null;
                if (r.TryGetValue("assets", out object a) && a is ArrayList assets)
                    foreach (object x in assets)
                        if (x is Dictionary<string, object> ad && (ad["name"] as string) == Asset) zip = ad["browser_download_url"] as string;
                if (zip == null) continue;
                if (best == null || v > best.Version)
                    best = new Release { Version = v, Tag = tag, Zip = zip, Page = r["html_url"] as string, Notes = r.TryGetValue("body", out object b) ? b as string : "" };
            }
            return best;
        }

        static bool True(Dictionary<string, object> r, string k) => r.TryGetValue(k, out object v) && v is bool b && b;

        static Version Three(Version v) => new Version(v.Major, v.Minor, Math.Max(0, v.Build));

        // quiet: only speak up when there is an update (the check at start); otherwise also say "up to date"
        // and report errors (the check the player asks for)
        public static async Task Check(Form owner, bool quiet)
        {
            Release rel;
            try { rel = await Newest(); }
            catch (Exception ex)
            {
                if (!quiet) MessageBox.Show(owner, "Couldn't check for updates: " + ex.Message, "OOTRR Tracker", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            Version cur = Three(Current);
            if (rel == null || Three(rel.Version) <= cur)
            {
                if (!quiet) MessageBox.Show(owner, "You have the newest version (" + cur + ").", "OOTRR Tracker", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            string notes = (rel.Notes ?? "").Trim();
            if (notes.Length > 700) notes = notes.Substring(0, 700).TrimEnd() + "…";
            string ask = "OOTRR Tracker " + Three(rel.Version) + " is out (you have " + cur + ")."
                + (notes.Length > 0 ? "\n\nWhat's new:\n" + notes : "")
                + "\n\nUpdate now? The tracker restarts when it's done, and your progress is kept.";
            if (MessageBox.Show(owner, ask, "OOTRR Tracker update", MessageBoxButtons.YesNo, MessageBoxIcon.Information) != DialogResult.Yes) return;

            Cursor old = owner.Cursor;
            owner.Cursor = Cursors.WaitCursor;
            string err = null;
            try { await Install(rel); }
            catch (Exception ex) { err = ex.Message; }
            finally { owner.Cursor = old; }
            if (err != null)
            {
                if (MessageBox.Show(owner, "The update couldn't be installed: " + err + "\n\nOpen the download page to update by hand?", "OOTRR Tracker update", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
                    try { Process.Start(new ProcessStartInfo(rel.Page) { UseShellExecute = true }); } catch { }
                return;
            }
            try { Process.Start(new ProcessStartInfo(Application.ExecutablePath) { UseShellExecute = true, WorkingDirectory = AppDir }); } catch { }
            Application.Exit();
        }

        static async Task Install(Release rel)
        {
            string dir = AppDir;
            // the app's own folder has to be writable (not under Program Files)
            string probe = Path.Combine(dir, ".update-test");
            try { File.WriteAllText(probe, ""); File.Delete(probe); }
            catch { throw new Exception("the app's folder (" + dir + ") can't be written to"); }

            string work = Path.Combine(Path.GetTempPath(), "ootrr-tracker-update-" + Guid.NewGuid().ToString("N"));
            string zip = work + ".zip";
            try
            {
                using (WebClient wc = Client()) await wc.DownloadFileTaskAsync(rel.Zip, zip);
                ZipFile.ExtractToDirectory(zip, work);
                if (!File.Exists(Path.Combine(work, Path.GetFileName(Application.ExecutablePath))))
                    throw new Exception("the download doesn't hold the app");

                // put the new files in place; on any failure, put the old ones back
                List<string> moved = new List<string>(), added = new List<string>();
                try
                {
                    foreach (string src in Directory.GetFiles(work, "*", SearchOption.AllDirectories))
                    {
                        string rel2 = src.Substring(work.Length).TrimStart(Path.DirectorySeparatorChar);
                        string dst = Path.Combine(dir, rel2);
                        Directory.CreateDirectory(Path.GetDirectoryName(dst));
                        if (File.Exists(dst))
                        {
                            string bak = dst + ".old";
                            if (File.Exists(bak)) File.Delete(bak);
                            File.Move(dst, bak);
                            moved.Add(dst);
                        }
                        else added.Add(dst);
                        File.Copy(src, dst);
                    }
                }
                catch
                {
                    foreach (string f in added) try { File.Delete(f); } catch { }
                    foreach (string f in moved) try { if (File.Exists(f)) File.Delete(f); File.Move(f + ".old", f); } catch { }
                    throw;
                }
            }
            finally
            {
                try { File.Delete(zip); } catch { }
                try { Directory.Delete(work, true); } catch { }
            }
        }
    }
}

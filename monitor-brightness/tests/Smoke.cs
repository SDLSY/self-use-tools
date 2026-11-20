using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using MonitorBrightness;

// Runs the production UI/controller with real hardware. Always restores original values.
static class Smoke
{
    static T Field<T>(object obj, string name) { return (T)obj.GetType().GetField(name, BindingFlags.NonPublic | BindingFlags.Instance).GetValue(obj); }
    static void Assert(bool ok, string message) { if (!ok) throw new Exception(message); Console.WriteLine("PASS " + message); }
    static void TrayClick(NotifyIcon tray) { typeof(NotifyIcon).GetMethod("OnMouseClick", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(tray, new object[] { new MouseEventArgs(MouseButtons.Left, 1, 0, 0, 0) }); }
    [STAThread] static int Main()
    {
        var originals = new Dictionary<Display, int>();
        TrayApp app = null; Exception failure = null; bool hardwareBlocked = false; int result = 1;
        using (var signal = new System.Threading.EventWaitHandle(false, System.Threading.EventResetMode.AutoReset))
        {
            try
            {
                int skipped; var displays = Discovery.Scan(out skipped);
                foreach (var d in displays) originals.Add(d, d.Percent);
                Assert(displays.Count > 0, "hardware discovery; unsupported screens skipped = " + skipped);
                foreach (var d in displays) Console.WriteLine("BASELINE " + d.Name + " = " + d.Percent + "% (" + d.Minimum + ".." + d.Maximum + ")");
                Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
                app = new TrayApp(signal);
                var popup = Field<Popup>(app, "popup"); var tray = Field<NotifyIcon>(app, "tray");
                var rows = Field<Dictionary<long, BrightnessRow>>(popup, "controls");
                var refresh = Field<Button>(popup, "refreshButton");
                int stage = 0, scans = 0; DateTime deadline = DateTime.UtcNow.AddSeconds(45);
                BrightnessRow row = null; TrackBar slider = null; Form other = null;
                Display target = displays[0]; int baseline = target.Percent; int desired = baseline < 99 ? baseline + 1 : baseline - 1;
                var timer = new Timer { Interval = 160 };
                timer.Tick += delegate
                {
                    try
                    {
                        if (DateTime.UtcNow > deadline) throw new Exception("UI/controller test timed out at stage " + stage);
                        if (stage == 0)
                        {
                            if (rows.Count == 0) return;
                            foreach (var r in rows.Values) if (Field<DisplayInfo>(r, "info").Name == target.Name) row = r;
                            Assert(row != null, "supported monitor has a slider"); slider = Field<TrackBar>(row, "slider");
                            Assert(rows.Count == displays.Count, "only controllable screens have sliders");
                            target.Read(); Assert(target.Percent == baseline && slider.Value == baseline, "startup preserves hardware brightness");
                            Assert(tray.Visible, "tray icon created"); popup.Open();
                            TrayClick(tray); Assert(!popup.Visible, "tray left click collapses panel"); TrayClick(tray);
                            stage = 10;
                        }
                        else if (stage == 10)
                        {
                            if (!popup.Visible) return;
                            Assert(popup.Visible, "tray left click opens panel after Explorer flyout dismissal");
                            slider.Value = desired; stage = 1;
                        }
                        else if (stage == 1)
                        {
                            if (!slider.Enabled)
                            {
                                hardwareBlocked = true; target.Read();
                                Assert(slider.Value == target.Percent, "failed write displays actual hardware brightness");
                                Console.WriteLine("LIMITATION monitor acknowledged write but did not apply it; UI correctly reports failure");
                                tray.ContextMenuStrip.Items[0].PerformClick(); stage = 3; return;
                            }
                            if (!Field<Label>(row, "feedback").Text.StartsWith("已读取确认")) return;
                            target.Read(); Assert(target.Percent == desired, "slider writes hardware and reads it back");
                            for (int i = 0; i < 100; i++) slider.Value = Math.Max(0, Math.Min(100, baseline + i % 3 - 1));
                            slider.Value = desired;
                            typeof(Control).GetMethod("OnMouseUp", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(slider, new object[] { new MouseEventArgs(MouseButtons.Left, 1, 0, 0, 0) });
                            stage++;
                        }
                        else if (stage == 2)
                        {
                            if (!Field<Label>(row, "feedback").Text.StartsWith("已读取确认")) return;
                            target.Read(); Assert(target.Percent == desired, "100 rapid slider changes retain final released value");
                            row.Result(Field<long>(row, "revision"), desired, "simulated disconnect");
                            Assert(!slider.Enabled && Field<Label>(row, "feedback").Text.Contains("刷新"), "simulated control failure disables slider and offers refresh");
                            tray.ContextMenuStrip.Items[0].PerformClick(); stage++;
                        }
                        else if (stage == 3)
                        {
                            if (!refresh.Enabled) return;
                            Assert(rows.Count == displays.Count, "refresh recovered supported monitor rows (cycle " + (++scans) + ")");
                            if (scans == 1 && hardwareBlocked)
                            {
                                foreach (var r in rows.Values)
                                {
                                    var bar = Field<TrackBar>(r, "slider"); int start = bar.Value;
                                    for (int i = 0; i < 100; i++) bar.Value = Math.Max(0, Math.Min(100, start + i % 3 - 1));
                                    typeof(Control).GetMethod("OnMouseUp", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(bar, new object[] { new MouseEventArgs(MouseButtons.Left, 1, 0, 0, 0) });
                                }
                                Console.WriteLine("PASS 100 rapid slider changes with release and concurrent refresh; UI remains responsive");
                            }
                            if (scans < 6) { refresh.PerformClick(); return; }
                            foreach (var r in rows.Values) if (Field<DisplayInfo>(r, "info").Name == target.Name) row = r;
                            slider = Field<TrackBar>(row, "slider"); Assert(slider.Enabled, "refresh recovers disabled slider");
                            popup.Open();
                            using (var bmp = new Bitmap(popup.Width, popup.Height))
                            {
                                popup.DrawToBitmap(bmp, new Rectangle(Point.Empty, bmp.Size)); bmp.Save(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "panel.png"));
                            }
                            other = new Form { Text = "Focus test", Size = new Size(160, 90) }; other.Show(); other.Activate(); stage++;
                        }
                        else if (stage == 4)
                        {
                            Assert(!popup.Visible, "panel collapses after losing focus"); other.Dispose(); popup.Open();
                            if (slider.Value != baseline) slider.Value = baseline;
                            else if (hardwareBlocked)
                            {
                                target.Read(); Assert(target.Percent == baseline, "hardware baseline unchanged after rejected writes");
                                timer.Stop(); tray.ContextMenuStrip.Items[2].PerformClick(); Assert(!tray.Visible, "Exit menu removes tray icon"); stage = 6; return;
                            }
                            stage++;
                        }
                        else if (stage == 5)
                        {
                            if (!Field<Label>(row, "feedback").Text.StartsWith("已读取确认")) return;
                            target.Read(); Assert(target.Percent == baseline, "original hardware brightness restored through slider");
                            timer.Stop(); tray.ContextMenuStrip.Items[2].PerformClick();
                            Assert(!tray.Visible, "Exit menu removes tray icon"); stage++;
                        }
                    }
                    catch (Exception ex) { failure = ex; timer.Stop(); app.ExitThread(); }
                };
                timer.Start(); Application.Run(app); timer.Dispose();
                if (failure != null) throw failure;
                Assert(stage == 6, "UI message loop exited cleanly");
                Console.WriteLine(hardwareBlocked ? "UI PASS; HARDWARE WRITE NOT CONFIRMED" : "UI AND HARDWARE PASS");
                result = hardwareBlocked ? 3 : 0;
            }
            catch (Exception ex) { Console.Error.WriteLine("FAIL " + ex); result = 1; }
            finally
            {
                if (app != null) { app.ExitThread(); app.Dispose(); }
                foreach (var pair in originals)
                {
                    try { pair.Key.Read(); if (pair.Key.Percent != pair.Value) pair.Key.Write(pair.Value); pair.Key.Read(); Console.WriteLine("RESTORED " + pair.Key.Name + " = " + pair.Key.Percent + "%"); }
                    catch (Exception ex) { Console.Error.WriteLine("RESTORE FAILED: " + ex.Message); result = 2; }
                    finally { pair.Key.Dispose(); }
                }
            }
        }
        return result;
    }
}

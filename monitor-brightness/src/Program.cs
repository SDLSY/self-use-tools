using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace MonitorBrightness
{
    static class Program
    {
        [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
        [STAThread] static void Main()
        {
            bool owner;
            using (var mutex = new Mutex(true, @"Local\MonitorBrightness.Tray.v1", out owner))
            using (var signal = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\MonitorBrightness.Show.v1"))
            {
                if (!owner) { signal.Set(); return; }
                SetProcessDPIAware(); Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
                using (var app = new TrayApp(signal)) Application.Run(app);
                mutex.ReleaseMutex();
            }
        }
    }

    sealed class TrayApp : ApplicationContext
    {
        private readonly NotifyIcon tray;
        private readonly Icon icon;
        private readonly Popup popup;
        private readonly Controller controller;
        private readonly System.Windows.Forms.Timer signalTimer;
        private readonly System.Windows.Forms.Timer showTimer;
        private bool closing;
        public TrayApp(EventWaitHandle signal)
        {
            controller = new Controller(); popup = new Popup(controller);
            showTimer = new System.Windows.Forms.Timer { Interval = 160 };
            showTimer.Tick += delegate { showTimer.Stop(); popup.Open(); };
            icon = MakeIcon();
            var menu = new ContextMenuStrip();
            menu.Items.Add("刷新显示器", null, delegate { popup.RefreshDisplays(); showTimer.Start(); });
            menu.Items.Add(new ToolStripSeparator()); menu.Items.Add("退出", null, delegate { ExitThread(); });
            tray = new NotifyIcon { Icon = icon, Text = "显示器亮度", ContextMenuStrip = menu, Visible = true };
            // Let Explorer dismiss its overflow flyout before activating our panel.
            tray.MouseClick += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) { if (popup.Visible) { showTimer.Stop(); popup.Hide(); } else showTimer.Start(); } };
            signalTimer = new System.Windows.Forms.Timer { Interval = 200 };
            signalTimer.Tick += delegate { if (signal.WaitOne(0)) showTimer.Start(); }; signalTimer.Start();
            // Create the UI handle before the worker can post results.
            IntPtr unused = popup.Handle;
            controller.Start();
        }
        private static Icon MakeIcon()
        {
            using (var bmp = new Bitmap(32, 32))
            using (var g = Graphics.FromImage(bmp))
            using (var pen = new Pen(Color.FromArgb(70, 130, 230), 2.5f))
            using (var brush = new SolidBrush(Color.FromArgb(70, 130, 230)))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.DrawRectangle(pen, 3, 5, 26, 18); g.DrawLine(pen, 16, 23, 16, 28); g.DrawLine(pen, 10, 28, 22, 28);
                g.FillEllipse(brush, 11, 9, 10, 10);
                IntPtr handle = bmp.GetHicon();
                try { return (Icon)Icon.FromHandle(handle).Clone(); } finally { DestroyIcon(handle); }
            }
        }
        [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr handle);
        protected override void ExitThreadCore()
        {
            if (closing) return; closing = true;
            signalTimer.Stop(); signalTimer.Dispose(); showTimer.Stop(); showTimer.Dispose(); tray.Visible = false; tray.Dispose();
            popup.Dispose(); controller.Dispose(); icon.Dispose(); base.ExitThreadCore();
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing && !closing) ExitThreadCore();
            base.Dispose(disposing);
        }
    }

    sealed class Popup : Form
    {
        private readonly Controller controller;
        private readonly FlowLayoutPanel rows;
        private readonly Label status;
        private readonly Button refreshButton;
        private readonly Dictionary<long, BrightnessRow> controls = new Dictionary<long, BrightnessRow>();
        public Popup(Controller controller)
        {
            this.controller = controller;
            Text = "显示器亮度"; Name = "BrightnessPopup";
            Font = new Font("Microsoft YaHei UI", 10); BackColor = Color.FromArgb(247, 248, 250);
            ForeColor = Color.FromArgb(40, 44, 52); FormBorderStyle = FormBorderStyle.FixedToolWindow;
            MaximizeBox = false; MinimizeBox = false; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual;
            ClientSize = new Size(380, 180); AutoScaleMode = AutoScaleMode.Dpi; TopMost = true;
            var title = new Label { Text = "显示器亮度", AutoSize = true, Location = new Point(18, 17), Font = new Font(Font, FontStyle.Bold) };
            refreshButton = new Button { Text = "刷新", AccessibleName = "刷新显示器", Location = new Point(292, 12), Size = new Size(68, 30), FlatStyle = FlatStyle.Flat };
            refreshButton.Click += delegate { RefreshDisplays(); };
            rows = new FlowLayoutPanel { Location = new Point(12, 52), Size = new Size(356, 60), FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true };
            status = new Label { Text = "正在读取显示器…", AutoSize = false, Location = new Point(18, 120), Size = new Size(344, 48), ForeColor = Color.FromArgb(96, 103, 115) };
            Controls.Add(title); Controls.Add(refreshButton); Controls.Add(rows); Controls.Add(status);
            Deactivate += delegate { Hide(); };
            controller.Scanned += delegate(List<DisplayInfo> infos, int skipped, string error) { Post(delegate { Populate(infos, skipped, error); }); };
            controller.Changed += delegate(long id, long revision, int percent, string error)
            {
                Post(delegate { BrightnessRow row; if (controls.TryGetValue(id, out row)) row.Result(revision, percent, error); });
            };
        }
        private void Post(Action action)
        {
            if (IsDisposed || Disposing) return;
            try { BeginInvoke(action); } catch (InvalidOperationException) { }
        }
        public void RefreshDisplays()
        {
            foreach (var row in controls.Values) row.SuspendChanges();
            refreshButton.Enabled = false; status.Text = "正在重新读取显示器…"; controller.Refresh();
        }
        private void Populate(List<DisplayInfo> infos, int skipped, string error)
        {
            foreach (var row in controls.Values) row.Dispose(); controls.Clear(); rows.Controls.Clear();
            foreach (var info in infos)
            {
                var row = new BrightnessRow(info, controller); controls.Add(info.Id, row); rows.Controls.Add(row);
            }
            int height = Math.Min(420, Math.Max(60, infos.Count * 132));
            rows.Height = height; status.Top = rows.Bottom + 8; ClientSize = new Size(380, status.Bottom + 12);
            refreshButton.Enabled = true;
            status.Text = error != null ? "读取失败，请刷新重试。\n" + error : infos.Count == 0 ? "未找到支持亮度控制的显示器。\n请检查连接，并在显示器菜单中开启 DDC/CI。" : "通过 DDC/CI 调整硬件背光" + (skipped > 0 ? "\n已跳过 " + skipped + " 个不支持控制或无法读取的屏幕。" : "");
            if (Visible) PositionPopup();
        }
        private void PositionPopup()
        {
            Rectangle area = Screen.FromPoint(Cursor.Position).WorkingArea;
            Location = new Point(Math.Max(area.Left, area.Right - Width - 12), Math.Max(area.Top, area.Bottom - Height - 12));
        }
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
        public void Open() { PositionPopup(); Show(); ShowWindow(Handle, 5); Activate(); SetForegroundWindow(Handle); }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x0010) { Hide(); return; }
            base.WndProc(ref message);
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing) foreach (var row in controls.Values) row.Dispose();
            base.Dispose(disposing);
        }
    }

    sealed class BrightnessRow : Panel
    {
        private readonly DisplayInfo info;
        private readonly Controller controller;
        private readonly TrackBar slider;
        private readonly Label value, feedback;
        private readonly System.Windows.Forms.Timer timer;
        private readonly ToolTip errorTip = new ToolTip();
        private long revision;
        private bool programmatic, dirty;
        public BrightnessRow(DisplayInfo info, Controller controller)
        {
            this.info = info; this.controller = controller;
            Size = new Size(330, 126); Margin = new Padding(2, 0, 2, 6); BackColor = Color.White;
            var name = new Label { Text = info.Name, AutoEllipsis = true, Location = new Point(10, 10), Size = new Size(242, 24) };
            value = new Label { Text = info.Percent + "%", TextAlign = ContentAlignment.MiddleRight, Location = new Point(256, 10), Size = new Size(64, 24), ForeColor = Color.FromArgb(45, 105, 210) };
            slider = new TrackBar { AutoSize = false, Minimum = 0, Maximum = 100, Value = info.Percent, TickStyle = TickStyle.None, SmallChange = 1, LargeChange = 10, Location = new Point(5, 42), Size = new Size(318, 40), AccessibleName = info.Name + " 亮度" };
            feedback = new Label { Text = "当前硬件亮度 · 0–100%", Location = new Point(10, 84), Size = new Size(310, 36), ForeColor = Color.FromArgb(105, 111, 123), Font = new Font(Font.FontFamily, 9) };
            timer = new System.Windows.Forms.Timer { Interval = 120 }; timer.Tick += delegate { Submit(); };
            slider.ValueChanged += delegate
            {
                if (programmatic) return; revision++; dirty = true; value.Text = slider.Value + "%"; feedback.Text = "正在调整…"; timer.Start();
            };
            slider.MouseUp += delegate { Submit(); }; slider.KeyUp += delegate { Submit(); };
            Controls.Add(name); Controls.Add(value); Controls.Add(slider); Controls.Add(feedback);
        }
        private void Submit() { timer.Stop(); if (!dirty || !slider.Enabled) return; dirty = false; controller.Set(info.Id, slider.Value, revision); }
        public void SuspendChanges() { timer.Stop(); dirty = false; slider.Enabled = false; }
        public void Result(long responseRevision, int percent, string error)
        {
            if (error != null)
            {
                SuspendChanges(); programmatic = true; slider.Value = percent; programmatic = false; value.Text = percent + "%";
                feedback.Text = error.Contains("未应用") ? "显示器未应用亮度。请检查 HDR / DCR 后刷新。" : "控制失败，请刷新显示器重试。";
                errorTip.SetToolTip(feedback, error); feedback.ForeColor = Color.FromArgb(160, 63, 50); return;
            }
            if (responseRevision != revision || !slider.Enabled) return;
            programmatic = true; slider.Value = percent; programmatic = false; value.Text = percent + "%"; feedback.Text = "已读取确认 · 硬件亮度 " + percent + "%";
        }
        protected override void Dispose(bool disposing) { if (disposing) { timer.Dispose(); errorTip.Dispose(); } base.Dispose(disposing); }
    }
}

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
using System.Management;

namespace MonitorBrightness
{
    public static class Native
    {
        public delegate bool MonitorEnum(IntPtr monitor, IntPtr dc, IntPtr rect, IntPtr data);
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct Physical { public IntPtr Handle; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct MonitorInfo { public int Size; public int Left, Top, Right, Bottom, WorkLeft, WorkTop, WorkRight, WorkBottom; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct DisplayDevice { public int Size; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Id; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Key; }
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDisplayDevices(string device, uint index, ref DisplayDevice info, uint flags);
        [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorEnum callback, IntPtr data);
        [DllImport("dxva2.dll", SetLastError = true)] public static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr monitor, out uint count);
        [DllImport("dxva2.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr monitor, uint count, [Out] Physical[] physical);
        [DllImport("dxva2.dll", SetLastError = true)] public static extern bool DestroyPhysicalMonitor(IntPtr monitor);
        [DllImport("dxva2.dll", SetLastError = true)] public static extern bool GetMonitorBrightness(IntPtr monitor, out uint min, out uint current, out uint max);
        [DllImport("dxva2.dll", SetLastError = true)] public static extern bool SetMonitorBrightness(IntPtr monitor, uint value);
        [DllImport("dxva2.dll", SetLastError = true)] public static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr monitor, byte code, out uint type, out uint current, out uint max);
        [DllImport("dxva2.dll", SetLastError = true)] public static extern bool SetVCPFeature(IntPtr monitor, byte code, uint value);
    }

    public sealed class Display : IDisposable
    {
        public long Id;
        public string Name;
        public IntPtr Handle;
        public uint Minimum, Maximum, Current;
        public bool UseVcp;
        public int Percent { get { return (int)Math.Round(100.0 * (Current - Minimum) / (Maximum - Minimum)); } }
        public void Read()
        {
            uint min, current, max, type;
            if (!UseVcp && Native.GetMonitorBrightness(Handle, out min, out current, out max)) { }
            else
            {
                if (!Native.GetVCPFeatureAndVCPFeatureReply(Handle, 0x10, out type, out current, out max))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "无法读取显示器亮度");
                min = 0; UseVcp = true;
            }
            if (max <= min || current < min || current > max) throw new InvalidOperationException("显示器返回了无效的亮度范围");
            Minimum = min; Maximum = max; Current = current;
        }
        public void Write(int percent)
        {
            uint value = Minimum + (uint)Math.Round((Maximum - Minimum) * Math.Max(0, Math.Min(100, percent)) / 100.0);
            bool ok = UseVcp ? Native.SetVCPFeature(Handle, 0x10, value) : Native.SetMonitorBrightness(Handle, value);
            if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法设置显示器亮度");
            if (WaitForValue(value)) return;
            // Some drivers acknowledge the high-level write without applying it.
            if (!UseVcp && Native.SetVCPFeature(Handle, 0x10, value))
            {
                UseVcp = true;
                if (WaitForValue(value)) return;
            }
            throw new InvalidOperationException("显示器未应用亮度（请求 " + percent + "%，读回 " + Percent + "%）。请检查 HDR、DCR 或显示器预设模式，再刷新重试。");
        }
        private bool WaitForValue(uint value)
        {
            Exception error = null;
            for (int attempt = 0; attempt < 4; attempt++)
            {
                if (attempt > 0) Thread.Sleep(attempt * 80);
                try { Read(); error = null; if (Current == value) return true; }
                catch (Exception ex) { error = ex; }
            }
            if (error != null) throw error;
            return false;
        }
        public void Dispose() { if (Handle != IntPtr.Zero) { Native.DestroyPhysicalMonitor(Handle); Handle = IntPtr.Zero; } }
    }

    public static class Discovery
    {
        private static long nextId;
        private static Dictionary<string, string> FriendlyNames()
        {
            var names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                using (var query = new ManagementObjectSearcher("root\\wmi", "SELECT * FROM WmiMonitorID"))
                using (var result = query.Get())
                foreach (ManagementObject item in result)
                using (item)
                {
                    string id = (string)item["InstanceName"];
                    int suffix = id.LastIndexOf('_'); if (suffix >= 0) id = id.Substring(0, suffix);
                    string manufacturer = Decode(item["ManufacturerName"] as ushort[]);
                    string model = Decode(item["UserFriendlyName"] as ushort[]);
                    if (model.Length > 0) names[id] = (manufacturer + " " + model).Trim();
                }
            }
            catch { /* Friendly names are optional; DDC control remains available. */ }
            return names;
        }
        private static string Decode(ushort[] chars)
        {
            if (chars == null) return "";
            return new string(Array.ConvertAll(Array.FindAll(chars, c => c != 0), c => (char)c)).Trim();
        }
        private static string FriendlyName(IntPtr monitor, Dictionary<string, string> names)
        {
            var info = new Native.MonitorInfo(); info.Size = Marshal.SizeOf(info);
            if (!Native.GetMonitorInfo(monitor, ref info)) return null;
            var device = new Native.DisplayDevice(); device.Size = Marshal.SizeOf(device);
            if (!Native.EnumDisplayDevices(info.Device, 0, ref device, 1) || device.Id == null) return null;
            string id = device.Id.Replace('#', '\\');
            foreach (var pair in names) if (id.IndexOf(pair.Key, StringComparison.OrdinalIgnoreCase) >= 0) return pair.Value;
            return null;
        }
        public static List<Display> Scan(out int unsupported)
        {
            var found = new List<Display>(); int skipped = 0;
            var names = FriendlyNames();
            Exception failure = null;
            Native.MonitorEnum callback = delegate(IntPtr monitor, IntPtr dc, IntPtr rect, IntPtr data)
            {
                uint count;
                if (!Native.GetNumberOfPhysicalMonitorsFromHMONITOR(monitor, out count) || count == 0) { skipped++; return true; }
                var physical = new Native.Physical[count];
                if (!Native.GetPhysicalMonitorsFromHMONITOR(monitor, count, physical)) { skipped++; return true; }
                string friendly = count == 1 ? FriendlyName(monitor, names) : null;
                foreach (var p in physical)
                {
                    var d = new Display { Id = Interlocked.Increment(ref nextId), Handle = p.Handle, Name = friendly ?? p.Description };
                    try { d.Read(); found.Add(d); }
                    catch { skipped++; d.Dispose(); }
                }
                return true;
            };
            try { if (!Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero)) failure = new Win32Exception(Marshal.GetLastWin32Error()); }
            catch (Exception ex) { failure = ex; }
            if (failure != null) { foreach (var d in found) d.Dispose(); throw failure; }
            unsupported = skipped; return found;
        }
    }

    public sealed class DisplayInfo
    {
        public long Id; public string Name; public int Percent;
    }
    public sealed class Controller : IDisposable
    {
        private sealed class Change { public int Percent; public long Revision; }
        private readonly object gate = new object();
        private readonly AutoResetEvent wake = new AutoResetEvent(false);
        private readonly Dictionary<long, Change> pending = new Dictionary<long, Change>();
        private readonly Thread worker;
        private bool stopping, refresh = true;
        public event Action<List<DisplayInfo>, int, string> Scanned;
        public event Action<long, long, int, string> Changed;
        public Controller() { worker = new Thread(Run) { IsBackground = true, Name = "DDC/CI" }; }
        public void Start() { worker.Start(); }
        public void Refresh() { lock (gate) { refresh = true; pending.Clear(); } wake.Set(); }
        public void Set(long id, int percent, long revision) { lock (gate) { if (stopping || refresh) return; pending[id] = new Change { Percent = percent, Revision = revision }; } wake.Set(); }
        private void Run()
        {
            var displays = new List<Display>();
            try
            {
                while (true)
                {
                    bool scan; Dictionary<long, Change> batch;
                    lock (gate)
                    {
                        if (stopping) break;
                        scan = refresh; refresh = false;
                        batch = new Dictionary<long, Change>(pending); pending.Clear();
                    }
                    if (scan)
                    {
                        foreach (var d in displays) d.Dispose(); displays.Clear();
                        int skipped = 0; string error = null;
                        try { displays = Discovery.Scan(out skipped); } catch (Exception ex) { error = ex.Message; }
                        var infos = new List<DisplayInfo>();
                        foreach (var d in displays) infos.Add(new DisplayInfo { Id = d.Id, Name = d.Name, Percent = d.Percent });
                        if (Scanned != null) Scanned(infos, skipped, error);
                    }
                    else foreach (var pair in batch)
                    {
                        lock (gate) { if (stopping || refresh) break; }
                        var d = displays.Find(item => item.Id == pair.Key); if (d == null) continue;
                        string error = null;
                        try { d.Write(pair.Value.Percent); } catch (Exception ex) { error = ex.Message; }
                        if (Changed != null) Changed(d.Id, pair.Value.Revision, d.Percent, error);
                    }
                    lock (gate) { if (refresh || pending.Count > 0 || stopping) continue; }
                    wake.WaitOne();
                }
            }
            finally { foreach (var d in displays) d.Dispose(); wake.Dispose(); }
        }
        public void Dispose() { lock (gate) { stopping = true; } wake.Set(); worker.Join(); }
    }
}

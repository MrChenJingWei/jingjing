using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Jingjing
{
    internal static class Native
    {
        public const uint MOD_ALT = 0x1;
        public const uint MOD_CONTROL = 0x2;
        public const uint MOD_NOREPEAT = 0x4000;
        private const int SW_RESTORE = 9;
        private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint key);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int command);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        /// <summary>把窗口拿到最前面（最小化了就先还原）。</summary>
        public static void BringToFront(Form form)
        {
            if (IsIconic(form.Handle)) ShowWindow(form.Handle, SW_RESTORE);
            form.Activate();
            SetForegroundWindow(form.Handle);
        }

        /// <summary>系统用的是深色模式吗（设置 → 个性化 → 颜色 → 应用模式）。</summary>
        public static bool AppsUseDarkTheme
        {
            get
            {
                try
                {
                    using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                    {
                        return key?.GetValue("AppsUseLightTheme") is int light && light == 0;
                    }
                }
                catch
                {
                    return false;
                }
            }
        }

        /// <summary>标题栏跟着系统深浅色（Windows 10 20H1 起支持；老系统上没效果也不报错）。</summary>
        public static void ApplyTitleBarTheme(IntPtr hwnd, bool dark)
        {
            try
            {
                var value = dark ? 1 : 0;
                DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref value, sizeof(int));
            }
            catch
            {
                // 老系统没有这个属性。
            }
        }
    }

    /// <summary>全局快捷键（RegisterHotKey），挂在一个只收消息的隐藏窗口上。被别的程序占了就不注册。</summary>
    internal sealed class HotKeyWindow : NativeWindow, IDisposable
    {
        private const int WM_HOTKEY = 0x0312;
        private const int Id = 1;

        public event Action Pressed;
        public bool Registered { get; }

        public HotKeyWindow(uint modifiers, Keys key)
        {
            CreateHandle(new CreateParams { Parent = new IntPtr(-3) }); // HWND_MESSAGE
            Registered = Native.RegisterHotKey(Handle, Id, modifiers | Native.MOD_NOREPEAT, (uint)key);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY) Pressed?.Invoke();
            base.WndProc(ref m);
        }

        public void Dispose()
        {
            if (Handle == IntPtr.Zero) return;
            if (Registered) Native.UnregisterHotKey(Handle, Id);
            DestroyHandle();
        }
    }
}

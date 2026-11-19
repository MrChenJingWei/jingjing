using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Jingjing
{
    /// <summary>
    /// 程序和数据放在哪。和 macOS App 一样，环境变量可以覆盖（开发调试、CI 用）：
    /// JINGJING_DATA_DIR、JINGJING_PORT、JINGJING_APP_DIR（服务代码目录）、JINGJING_NODE（node.exe）。
    /// </summary>
    internal static class Paths
    {
        public static readonly string ExeDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');

        public static string AppDir => Env("JINGJING_APP_DIR") ?? Path.Combine(ExeDir, "app");

        public static string Node => Env("JINGJING_NODE") ?? Path.Combine(ExeDir, "runtime", "node.exe");

        /// <summary>%LOCALAPPDATA%\Jingjing：数据库、配对码、日志、插件都在这里。卸载 App 不会删它。</summary>
        public static string DataDir => Env("JINGJING_DATA_DIR")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Jingjing");

        public static int Port
        {
            get
            {
                int port;
                return int.TryParse(Env("JINGJING_PORT"), out port) && port > 0 && port < 65536 ? port : 7777;
            }
        }

        public static string KeyFile => Path.Combine(DataDir, "access-key");
        public static string LogFile => Path.Combine(DataDir, "logs", "server.log");
        public static string PluginsDir => Path.Combine(DataDir, "plugins");
        public static string WebViewDataDir => Path.Combine(DataDir, "webview");
        public static string BaseUrl => "http://127.0.0.1:" + Port;

        public static string Version
        {
            get
            {
                var version = Application.ProductVersion ?? "0.0.0";
                var plus = version.IndexOf('+');
                return plus > 0 ? version.Substring(0, plus) : version;
            }
        }

        public static string ReadKey()
        {
            try
            {
                var text = File.ReadAllText(KeyFile).Trim();
                return text.Length > 0 ? text : null;
            }
            catch
            {
                return null;
            }
        }

        public static string PairUrl(string baseUrl)
        {
            var key = ReadKey();
            return key == null ? baseUrl + "/" : baseUrl + "/pair?key=" + Uri.EscapeDataString(key);
        }

        private static string Env(string name)
        {
            var value = Environment.GetEnvironmentVariable(name);
            return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
        }

        /// <summary>用系统默认的方式打开文件夹、文件或网址。</summary>
        public static void Open(string target)
        {
            try
            {
                Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "打不开：" + target, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        public static void OpenFolder(string dir)
        {
            Directory.CreateDirectory(dir);
            Open(dir);
        }
    }

    /// <summary>App 自己的设置，存在 HKCU\Software\Jingjing\Desktop。</summary>
    internal static class Prefs
    {
        private const string KeyPath = @"Software\Jingjing\Desktop";
        private const string RunPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        // 命令行版的常驻服务用的是 Jingjing，桌面 App 用另一个名字，两个都装了也不会互相覆盖。
        private const string RunName = "JingjingDesktop";

        public static bool GetBool(string name, bool fallback = false)
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(KeyPath))
                {
                    var value = key?.GetValue(name);
                    return value is int number ? number != 0 : fallback;
                }
            }
            catch
            {
                return fallback;
            }
        }

        public static void SetBool(string name, bool value)
        {
            try
            {
                using (var key = Registry.CurrentUser.CreateSubKey(KeyPath)) key.SetValue(name, value ? 1 : 0, RegistryValueKind.DWord);
            }
            catch
            {
                // 写不了注册表就只在这次运行里生效。
            }
        }

        public static string GetString(string name)
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(KeyPath)) return key?.GetValue(name) as string;
            }
            catch
            {
                return null;
            }
        }

        public static void SetString(string name, string value)
        {
            try
            {
                using (var key = Registry.CurrentUser.CreateSubKey(KeyPath)) key.SetValue(name, value ?? "", RegistryValueKind.String);
            }
            catch
            {
                // 同上。
            }
        }

        /// <summary>登录 Windows 时在后台启动（--background，不弹窗口）。</summary>
        public static bool LaunchAtLogin
        {
            get
            {
                try
                {
                    using (var key = Registry.CurrentUser.OpenSubKey(RunPath)) return key?.GetValue(RunName) != null;
                }
                catch
                {
                    return false;
                }
            }
            set
            {
                using (var key = Registry.CurrentUser.CreateSubKey(RunPath))
                {
                    if (value) key.SetValue(RunName, "\"" + Application.ExecutablePath + "\" --background", RegistryValueKind.String);
                    else key.DeleteValue(RunName, false);
                }
            }
        }
    }

    /// <summary>访问本机服务。都不走系统代理（公司电脑常配了代理，127.0.0.1 也会被转出去）。</summary>
    internal static class Http
    {
        public static bool Health(int timeoutMs)
        {
            try
            {
                var request = Create(Paths.BaseUrl + "/api/health", timeoutMs);
                using (var response = (HttpWebResponse)request.GetResponse()) return response.StatusCode == HttpStatusCode.OK;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>POST 一个 JSON，带配对码；成功返回 true。</summary>
        public static bool Post(string path, string json, int timeoutMs)
        {
            var key = Paths.ReadKey();
            if (key == null) return false;
            try
            {
                var request = Create(Paths.BaseUrl + path, timeoutMs);
                request.Method = "POST";
                request.ContentType = "application/json";
                request.Headers["Authorization"] = "Bearer " + key;
                var body = Encoding.UTF8.GetBytes(json ?? "{}");
                request.ContentLength = body.Length;
                using (var stream = request.GetRequestStream()) stream.Write(body, 0, body.Length);
                using (var response = (HttpWebResponse)request.GetResponse()) return (int)response.StatusCode < 300;
            }
            catch
            {
                return false;
            }
        }

        public static HttpWebRequest Create(string url, int timeoutMs)
        {
            var request = (HttpWebRequest)WebRequest.Create(url);
            request.Proxy = null;
            request.Timeout = timeoutMs;
            request.ReadWriteTimeout = timeoutMs;
            request.UserAgent = "JingjingDesktop/" + Paths.Version;
            return request;
        }
    }
}

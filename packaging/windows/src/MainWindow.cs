using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Jingjing
{
    /// <summary>
    /// 静静的原生主窗口：WebView2 加载本机界面（和手机 PWA 是同一套前端）。
    /// 关掉窗口只是藏起来，静静继续在托盘里运行。外部链接交给系统浏览器；
    /// 下载、alert / confirm、文件选择这些 WebView2 自己就处理得很好，不另外接管。
    /// </summary>
    internal sealed class MainWindow : Form
    {
        private readonly WebView2 web;
        private readonly string baseUrl = Paths.BaseUrl;
        private bool initStarted;
        private bool ready;          // WebView2 初始化好了
        private bool loaded;         // 已经开始加载真正的界面（而不是等待页）
        private bool navigating;
        private bool serverReady;
        private bool allowClose;
        private string pendingScript;

        /// <summary>界面加载完成（冒烟测试用），参数是 window.jingjing 是否就绪。</summary>
        public event Action<bool> UiLoaded;
        /// <summary>第一次被用户关掉（藏到托盘）时触发，用来提示一次。</summary>
        public event Action HiddenToTray;
        /// <summary>WebView2 不可用，界面打不开。</summary>
        public event Action<string> WebViewFailed;

        public MainWindow()
        {
            var dark = Native.AppsUseDarkTheme;
            Text = "静静";
            Icon = TrayIcons.AppIcon;
            MinimumSize = new Size(420, 560);
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(1200, 800);
            BackColor = dark ? Color.FromArgb(24, 24, 27) : Color.White;
            LoadSavedBounds();

            web = new WebView2
            {
                Dock = DockStyle.Fill,
                DefaultBackgroundColor = BackColor
            };
            Controls.Add(web);
        }

        public bool IsFrontmost => Visible && WindowState != FormWindowState.Minimized && ActiveForm == this;

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Native.ApplyTitleBarTheme(Handle, Native.AppsUseDarkTheme);
        }

        protected override async void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            await InitWebView();
        }

        private async Task InitWebView()
        {
            if (initStarted) return;
            initStarted = true;
            try
            {
                var environment = await CoreWebView2Environment.CreateAsync(null, Paths.WebViewDataDir);
                await web.EnsureCoreWebView2Async(environment);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                WebViewFailed?.Invoke("这台电脑缺少 Microsoft Edge WebView2 运行时。");
                return;
            }
            catch (Exception ex)
            {
                WebViewFailed?.Invoke("WebView2 初始化失败：" + ex.Message);
                return;
            }

            var core = web.CoreWebView2;
            // 前端据此判断自己跑在桌面 App 里。
            core.Settings.UserAgent = core.Settings.UserAgent + " JingjingDesktop/" + Paths.Version;
            core.Settings.AreDevToolsEnabled = Environment.GetEnvironmentVariable("JINGJING_DEVTOOLS") == "1";
            core.Settings.IsStatusBarEnabled = false;
            core.NavigationStarting += OnNavigationStarting;
            core.NavigationCompleted += OnNavigationCompleted;
            core.NewWindowRequested += OnNewWindowRequested;
            core.ProcessFailed += (sender, args) =>
            {
                try { web.Reload(); } catch { }
            };
            ready = true;
            if (serverReady) LoadUi();
            else ShowStarting("正在启动本机服务…");
        }

        // ------------------------------------------------------------ 显示

        public void ShowAndActivate()
        {
            if (!Visible) Show();
            Native.BringToFront(this);
            if (ready && !loaded && serverReady) LoadUi();
        }

        public void Toggle()
        {
            if (IsFrontmost) Hide();
            else ShowAndActivate();
        }

        /// <summary>服务起来 / 没了。起来时加载界面（第一次带配对码，之后靠 Cookie）。</summary>
        public void SetServerReady(bool ok)
        {
            var becameReady = ok && !serverReady;
            serverReady = ok;
            if (becameReady && Visible) LoadUi();
        }

        public void ShowServerProblem(string message)
        {
            if (ready && !loaded) ShowStarting(message);
        }

        public void OpenTask(string id) => Run("window.jingjing && window.jingjing.openTask(" + Json.Quote(id) + ")");

        public void OpenView(string name) => Run("window.jingjing && window.jingjing.openView(" + Json.Quote(name) + ")");

        /// <summary>真正退出 App 时调用：不再藏到托盘。</summary>
        public void ForceClose()
        {
            allowClose = true;
            SaveBounds();
            Close();
        }

        private void Run(string script)
        {
            ShowAndActivate();
            if (ready && loaded && !navigating) _ = web.CoreWebView2.ExecuteScriptAsync(script);
            else pendingScript = script;
        }

        private void LoadUi()
        {
            if (!ready || loaded || !serverReady) return;
            loaded = true;
            web.CoreWebView2.Navigate(Paths.PairUrl(baseUrl));
        }

        private void ShowStarting(string detail)
        {
            if (!ready) return;
            var dark = Native.AppsUseDarkTheme;
            var html = "<!doctype html><meta charset=\"utf-8\"><body style=\"margin:0;height:100vh;display:grid;place-items:center;"
                + "font:15px 'Segoe UI','Microsoft YaHei UI',sans-serif;background:" + (dark ? "#18181b" : "#fff") + ";color:#888\">"
                + "<div style=\"text-align:center\"><div style=\"font-size:28px;margin-bottom:10px\">静静</div>"
                + System.Net.WebUtility.HtmlEncode(detail) + "</div></body>";
            web.CoreWebView2.NavigateToString(html);
        }

        // ------------------------------------------------------------ WebView2 事件

        private bool IsLocal(string url)
        {
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri)) return false;
            if (uri.Scheme == "about" || uri.Scheme == "data" || uri.Scheme == "blob") return true;
            return (uri.Host == "127.0.0.1" || uri.Host == "localhost") && uri.Port == Paths.Port;
        }

        private static void OpenExternal(string url)
        {
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri)) return;
            // 只把网页和邮件链接交给系统，别的协议（file:、ms-settings: 之类）一律不开。
            if (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeMailto) Paths.Open(uri.AbsoluteUri);
        }

        private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (!IsLocal(e.Uri))
            {
                // 外部链接交给系统浏览器，窗口里只留静静自己的页面。
                e.Cancel = true;
                OpenExternal(e.Uri);
                return;
            }
            navigating = true;
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            navigating = false;
            if (!e.IsSuccess)
            {
                switch (e.WebErrorStatus)
                {
                    case CoreWebView2WebErrorStatus.CannotConnect:
                    case CoreWebView2WebErrorStatus.ConnectionReset:
                    case CoreWebView2WebErrorStatus.ConnectionAborted:
                    case CoreWebView2WebErrorStatus.Disconnected:
                    case CoreWebView2WebErrorStatus.ServerUnreachable:
                    case CoreWebView2WebErrorStatus.Timeout:
                        // 服务还没起来或刚重启：显示等待页，服务恢复后（健康检查）重新加载。
                        if (loaded)
                        {
                            loaded = false;
                            serverReady = false;
                            ShowStarting("连不上本机服务，正在等它恢复…");
                        }
                        break;
                }
                return;
            }
            // 只认真正的界面（http://127.0.0.1:端口/…），等待页（about: / data:）不算。
            if (!loaded || !web.CoreWebView2.Source.StartsWith(baseUrl + "/", StringComparison.OrdinalIgnoreCase)) return;
            if (pendingScript != null)
            {
                var script = pendingScript;
                pendingScript = null;
                _ = web.CoreWebView2.ExecuteScriptAsync(script);
            }
            ReportLoaded();
        }

        private async void ReportLoaded()
        {
            if (UiLoaded == null) return;
            try
            {
                var result = await web.CoreWebView2.ExecuteScriptAsync("typeof window.jingjing === 'object'");
                UiLoaded?.Invoke(result == "true");
            }
            catch
            {
                UiLoaded?.Invoke(false);
            }
        }

        private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            // target="_blank"：本机页面在当前窗口打开，外部链接交给浏览器。
            e.Handled = true;
            if (IsLocal(e.Uri)) web.CoreWebView2.Navigate(e.Uri);
            else OpenExternal(e.Uri);
        }

        // ------------------------------------------------------------ 关窗口 = 藏到托盘

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!allowClose && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                SaveBounds();
                Hide();
                if (!Prefs.GetBool("toldHiddenToTray"))
                {
                    Prefs.SetBool("toldHiddenToTray", true);
                    HiddenToTray?.Invoke();
                }
                return;
            }
            SaveBounds();
            base.OnFormClosing(e);
        }

        // ------------------------------------------------------------ 记住窗口位置

        private void LoadSavedBounds()
        {
            var saved = Prefs.GetString("windowBounds");
            if (string.IsNullOrEmpty(saved)) return;
            var parts = saved.Split(',');
            int x, y, w, h;
            if (parts.Length < 4 || !int.TryParse(parts[0], out x) || !int.TryParse(parts[1], out y)
                || !int.TryParse(parts[2], out w) || !int.TryParse(parts[3], out h)) return;
            var rect = new Rectangle(x, y, Math.Max(w, MinimumSize.Width), Math.Max(h, MinimumSize.Height));
            // 保存时的那块显示器可能已经拔掉了：窗口要至少有一部分在某块屏幕上才恢复位置。
            foreach (var screen in Screen.AllScreens)
            {
                if (!screen.WorkingArea.IntersectsWith(rect)) continue;
                StartPosition = FormStartPosition.Manual;
                Bounds = rect;
                if (parts.Length > 4 && parts[4] == "max") WindowState = FormWindowState.Maximized;
                return;
            }
        }

        private void SaveBounds()
        {
            if (!IsHandleCreated) return;
            var rect = WindowState == FormWindowState.Normal ? Bounds : base.RestoreBounds;
            if (rect.Width <= 0 || rect.Height <= 0) return;
            Prefs.SetString("windowBounds", $"{rect.X},{rect.Y},{rect.Width},{rect.Height},{(WindowState == FormWindowState.Maximized ? "max" : "normal")}");
        }
    }
}

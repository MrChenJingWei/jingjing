using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Jingjing
{
    /// <summary>
    /// 托盘常驻的静静：拉起本机服务、盯着它活着没有、把服务端事件变成系统通知，按需打开主窗口。
    /// 对应 macOS App 的 AppDelegate（菜单栏 → 托盘）。
    /// </summary>
    internal sealed class TrayApp : ApplicationContext
    {
        private readonly AppOptions options;
        private readonly SynchronizationContext ui;
        private readonly MainWindow window;
        private readonly NotifyIcon tray;
        private readonly ContextMenuStrip menu;
        private readonly ToolStripMenuItem statusItem;
        private readonly ToolStripMenuItem localOnlyItem;
        private readonly ToolStripMenuItem loginItem;
        private readonly ServerProcess server = new ServerProcess();
        private readonly EventStream events;
        private readonly System.Windows.Forms.Timer healthTimer;
        private readonly HotKeyWindow hotKey;
        private readonly EventWaitHandle showSignal;
        private readonly EventWaitHandle quitSignal;
        private readonly StringWriter smokeLog = new StringWriter();
        private bool running;
        private bool checking;
        private bool quitting;
        private bool webViewBroken;
        private bool smokeFinished;
        private int pending;
        private string lastExit;     // 服务意外退出时状态栏显示的说明
        private string balloonTask;  // 点最近一条通知要打开的任务
        private DateTime smokeDeadline;

        public int ExitCode { get; private set; }

        private bool LocalOnly => options.SmokeTest || Prefs.GetBool("localOnly");

        public TrayApp(AppOptions options)
        {
            this.options = options;
            // .NET Framework 默认每个主机只开 2 条连接：事件流长期占一条，健康检查和关服务的请求会排队。
            ServicePointManager.DefaultConnectionLimit = 16;

            // 第一个控件：顺带装好 WinForms 的同步上下文，后台线程的结果都 Post 回界面线程。
            window = new MainWindow();
            ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            window.HiddenToTray += () => Balloon("静静还在后台运行", "点托盘里的静静图标就能再打开窗口；要彻底退出，右键图标选「退出静静」。", null);
            window.WebViewFailed += OnWebViewFailed;
            window.UiLoaded += OnUiLoaded;

            // ---------------------------------------------------------- 托盘菜单
            menu = new ContextMenuStrip();
            statusItem = new ToolStripMenuItem("服务启动中…") { Enabled = false };
            var openItem = new ToolStripMenuItem("打开静静", null, (sender, e) => ShowWindow());
            openItem.Font = new Font(openItem.Font, FontStyle.Bold);
            localOnlyItem = new ToolStripMenuItem("仅本机访问", null, (sender, e) => ToggleLocalOnly()) { Checked = LocalOnly };
            loginItem = new ToolStripMenuItem("开机时启动", null, (sender, e) => ToggleLaunchAtLogin()) { Checked = Prefs.LaunchAtLogin };

            menu.Items.Add(statusItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(openItem);
            menu.Items.Add("在浏览器中打开", null, (sender, e) => Paths.Open(Paths.PairUrl(Paths.BaseUrl)));
            menu.Items.Add("显示配对码…", null, (sender, e) => ShowKey());
            menu.Items.Add("复制配对码", null, (sender, e) => CopyKey());
            menu.Items.Add("手机访问…", null, (sender, e) => OpenView("settings/pairing"));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(localOnlyItem);
            menu.Items.Add(loginItem);
            menu.Items.Add("重启服务", null, (sender, e) => RestartServer());
            menu.Items.Add("打开数据文件夹", null, (sender, e) => Paths.OpenFolder(Paths.DataDir));
            menu.Items.Add("打开插件文件夹", null, (sender, e) => Paths.OpenFolder(Paths.PluginsDir));
            menu.Items.Add("打开日志", null, (sender, e) => OpenLog());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出静静", null, (sender, e) => Quit());
            menu.Opening += (sender, e) => loginItem.Checked = Prefs.LaunchAtLogin;

            tray = new NotifyIcon { Text = "静静 · 服务启动中", ContextMenuStrip = menu };
            SetTrayIcon(TrayIcons.Render(true, 0));
            tray.Visible = true;
            tray.MouseClick += (sender, e) =>
            {
                if (e.Button == MouseButtons.Left) ShowWindow();
            };
            tray.BalloonTipClicked += (sender, e) =>
            {
                if (balloonTask != null) OpenTask(balloonTask);
                else ShowWindow();
            };

            // ---------------------------------------------------------- 快捷键：Ctrl+Alt+J 随时唤出 / 收起
            hotKey = new HotKeyWindow(Native.MOD_CONTROL | Native.MOD_ALT, Keys.J);
            hotKey.Pressed += () =>
            {
                if (webViewBroken) ShowWindow();
                else window.Toggle();
            };
            if (hotKey.Registered) openItem.ShortcutKeyDisplayString = "Ctrl+Alt+J";

            // ---------------------------------------------------------- 再开一次 / 安装程序要求退出
            if (!options.SmokeTest)
            {
                showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ShowEventName);
                quitSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.QuitEventName);
                new Thread(WatchSignals) { IsBackground = true, Name = "jingjing-signals" }.Start();
            }

            events = new EventStream(ui);
            events.Received += OnEvent;
            server.Exited += (code, expected) => ui.Post(_ => OnServerExited(code, expected), null);
            SystemEvents.SessionEnding += OnSessionEnding;

            healthTimer = new System.Windows.Forms.Timer { Interval = 2500 };
            healthTimer.Tick += (sender, e) => Refresh();

            StartServer();
            if (smokeFinished) return; // 冒烟测试里服务都没能启动：已经收尾了
            healthTimer.Start();
            if (options.SmokeTest)
            {
                smokeDeadline = DateTime.Now.AddMinutes(2);
                Log("冒烟测试开始：数据目录 " + Paths.DataDir + "，端口 " + Paths.Port);
                window.ShowAndActivate();
            }
            else if (!options.Background)
            {
                // 从开始菜单打开：马上显示窗口（服务起来前是等待页）。登录时自动启动（--background）只待在托盘里。
                window.ShowAndActivate();
            }
        }

        // ============================================================ 服务

        private void StartServer()
        {
            lastExit = null;
            try
            {
                server.Start(LocalOnly);
                Log("服务进程已启动");
            }
            catch (Exception ex)
            {
                lastExit = "服务没能启动";
                Log("启动服务失败：" + ex.Message);
                if (options.SmokeTest)
                {
                    FinishSmoke(false, "启动服务失败：" + ex.Message);
                    return;
                }
                MessageBox.Show(ex.Message, "静静没能启动服务", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            UpdateStatus();
        }

        private void RestartServer()
        {
            statusItem.Text = "正在重启服务…";
            // 停服务最多要等几秒（让任务收尾），放到后台，托盘菜单不卡住。
            Task.Run(() => server.Stop()).ContinueWith(_ =>
            {
                if (!quitting) StartServer();
            }, TaskScheduler.FromCurrentSynchronizationContext());
        }

        private void OnServerExited(int code, bool expected)
        {
            running = false;
            window.SetServerReady(false);
            if (expected || quitting)
            {
                UpdateStatus();
                return;
            }
            lastExit = $"服务已退出（{code}）";
            Log($"服务意外退出（退出码 {code}）");
            if (options.SmokeTest)
            {
                FinishSmoke(false, $"服务意外退出（退出码 {code}）");
                return;
            }
            if ((DateTime.Now - server.StartedAt).TotalSeconds >= 20)
            {
                // 跑了一阵才退出（崩溃）：过 3 秒自动拉起来。任务会按断点恢复。
                var timer = new System.Windows.Forms.Timer { Interval = 3000 };
                timer.Tick += (sender, e) =>
                {
                    timer.Stop();
                    timer.Dispose();
                    if (!quitting && !server.Running) StartServer();
                };
                timer.Start();
            }
            else
            {
                // 刚起来就退出：多半是端口被占用（另一个静静已经在跑），自动重试也没用。
                Balloon("静静的服务没能启动",
                    $"可能是端口 {Paths.Port} 被占用，或者另一个静静已经在运行。右键托盘图标 →「打开日志」可以看原因。", null);
                window.ShowServerProblem($"服务没能启动（退出码 {code}）。右键托盘图标 →「打开日志」可以看原因，处理好后点「重启服务」。");
            }
            UpdateStatus();
        }

        private void Refresh()
        {
            if (options.SmokeTest && !smokeFinished && DateTime.Now > smokeDeadline)
            {
                FinishSmoke(false, "超时：两分钟内界面没有加载出来");
                return;
            }
            if (checking || quitting) return;
            checking = true;
            Task.Run(() => Http.Health(1500)).ContinueWith(task =>
            {
                checking = false;
                OnHealth(task.Result);
            }, TaskScheduler.FromCurrentSynchronizationContext());
        }

        private void OnHealth(bool ok)
        {
            if (quitting) return;
            if (ok && !running) Log("服务健康检查通过");
            running = ok;
            window.SetServerReady(ok);
            if (ok) events.Start();
            UpdateStatus();
        }

        private void UpdateStatus()
        {
            if (quitting) return;
            SetTrayIcon(TrayIcons.Render(!running, running ? pending : 0));
            var tip = running ? (pending > 0 ? $"静静 · {pending} 件事等你拍板" : "静静 · 运行中") : "静静 · 服务未运行";
            if (tray.Text != tip) tray.Text = tip;
            string status;
            if (running) status = $"服务运行中 · 端口 {Paths.Port} · {(LocalOnly ? "仅本机" : "局域网可访问")}";
            else if (lastExit != null) status = lastExit;
            else if (server.Running) status = "服务启动中…";
            else status = "服务未运行";
            if (statusItem.Text != status) statusItem.Text = status;
        }

        private void SetTrayIcon(Icon icon)
        {
            if (icon == null) return;
            var old = tray.Icon;
            tray.Icon = icon;
            old?.Dispose();
        }

        // ============================================================ 通知

        /// <summary>服务端事件 → 系统通知：需要拍板时提醒，任务完成 / 失败时告知；窗口在前台时不弹（网页里已经有提示）。</summary>
        private void OnEvent(string type, Dictionary<string, object> payload)
        {
            switch (type)
            {
                case "approval/created":
                {
                    var approval = Json.Obj(payload, "approval");
                    var task = Json.Obj(payload, "task");
                    if (approval == null) return;
                    Notify($"「{Json.Str(task, "title") ?? "任务"}」等你拍板", Json.Str(approval, "question"), Json.Str(task, "id"));
                    break;
                }
                case "task/finished":
                {
                    var task = Json.Obj(payload, "task");
                    var status = Json.Str(task, "status");
                    if (task == null || status == "cancelled") return;
                    var title = Json.Str(task, "title") ?? "任务";
                    var detail = Json.Str(task, status == "failed" ? "error" : "result") ?? "";
                    Notify(status == "failed" ? "失败了：" + title : "完成了：" + title, FirstLine(detail, 120), Json.Str(task, "id"));
                    break;
                }
                case "stats/updated":
                    pending = Json.Int(payload, "pendingApprovals", pending);
                    UpdateStatus();
                    break;
            }
        }

        private void Notify(string title, string text, string taskId)
        {
            if (window.IsFrontmost) return;
            Balloon(title, text, taskId);
        }

        private void Balloon(string title, string text, string taskId)
        {
            if (quitting) return;
            balloonTask = taskId;
            tray.BalloonTipTitle = Truncate(title, 60);
            tray.BalloonTipText = string.IsNullOrWhiteSpace(text) ? "点这里查看" : Truncate(text, 200);
            tray.BalloonTipIcon = ToolTipIcon.None;
            tray.ShowBalloonTip(10000);
        }

        private static string FirstLine(string text, int max)
        {
            var line = (text ?? "").Split('\n')[0].Trim();
            return Truncate(line, max);
        }

        private static string Truncate(string text, int max)
        {
            text = text ?? "";
            return text.Length > max ? text.Substring(0, max - 1) + "…" : text;
        }

        // ============================================================ 窗口

        private void ShowWindow()
        {
            if (webViewBroken) Paths.Open(Paths.PairUrl(Paths.BaseUrl));
            else window.ShowAndActivate();
        }

        private void OpenTask(string id)
        {
            if (webViewBroken) Paths.Open(Paths.PairUrl(Paths.BaseUrl));
            else window.OpenTask(id);
        }

        private void OpenView(string name)
        {
            if (webViewBroken) Paths.Open(Paths.PairUrl(Paths.BaseUrl));
            else window.OpenView(name);
        }

        private void OnWebViewFailed(string message)
        {
            webViewBroken = true;
            Log(message);
            if (options.SmokeTest)
            {
                FinishSmoke(false, message);
                return;
            }
            window.Hide();
            var answer = MessageBox.Show(
                message + "\n\n点「是」去下载安装 WebView2 运行时（微软官方，免费），装好后重新打开静静；\n点「否」先在浏览器里使用静静。",
                "静静的窗口打不开", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Warning);
            if (answer == DialogResult.Yes) Paths.Open("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
            else if (answer == DialogResult.No) Paths.Open(Paths.PairUrl(Paths.BaseUrl));
        }

        // ============================================================ 菜单动作

        private void ShowKey()
        {
            var key = Paths.ReadKey();
            if (key == null)
            {
                MessageBox.Show("服务启动后会自动生成配对码。请确认服务正在运行，稍后再试。", "还没有配对码", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            using (var dialog = new PairingDialog(key)) dialog.ShowDialog();
        }

        private void CopyKey()
        {
            var key = Paths.ReadKey();
            if (key == null)
            {
                MessageBox.Show("服务刚启动时需要几秒钟生成配对码，请稍后再试。", "还没有配对码", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            try
            {
                Clipboard.SetText(key);
                Balloon("配对码已复制", "可以粘贴到手机或浏览器的配对框里。", null);
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "没能复制配对码", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void ToggleLocalOnly()
        {
            Prefs.SetBool("localOnly", !LocalOnly);
            localOnlyItem.Checked = LocalOnly;
            RestartServer();
        }

        private void ToggleLaunchAtLogin()
        {
            try
            {
                Prefs.LaunchAtLogin = !Prefs.LaunchAtLogin;
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message + "\n\n也可以在「设置 → 应用 → 启动」里手动打开静静。", "没能修改开机启动", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            loginItem.Checked = Prefs.LaunchAtLogin;
        }

        private void OpenLog()
        {
            if (File.Exists(Paths.LogFile)) Paths.Open(Paths.LogFile);
            else Paths.OpenFolder(Paths.DataDir);
        }

        // ============================================================ 退出

        private void WatchSignals()
        {
            var handles = new WaitHandle[] { showSignal, quitSignal };
            while (true)
            {
                int which;
                try { which = WaitHandle.WaitAny(handles); } catch { return; }
                if (which == 0)
                {
                    ui.Post(_ => ShowWindow(), null);
                }
                else
                {
                    ui.Post(_ => Quit(), null);
                    return;
                }
            }
        }

        private void OnSessionEnding(object sender, SessionEndingEventArgs e)
        {
            // 注销 / 关机：系统只给几秒，先请服务收尾（服务自己也会收到系统的关机通知）。
            if (quitting) return;
            quitting = true;
            healthTimer.Stop();
            events.Stop();
            server.Stop(2500);
        }

        private void Quit()
        {
            if (quitting && !options.SmokeTest) return;
            quitting = true;
            Shutdown();
            ExitThread();
        }

        /// <summary>停掉一切；返回服务是不是自己正常退出的（而不是被强制结束）。</summary>
        private bool Shutdown()
        {
            SystemEvents.SessionEnding -= OnSessionEnding;
            healthTimer.Stop();
            events.Stop();
            hotKey.Dispose();
            tray.Visible = false;
            var graceful = server.Stop();
            window.ForceClose();
            tray.Dispose();
            showSignal?.Dispose();
            quitSignal?.Dispose();
            return graceful;
        }

        // ============================================================ 冒烟测试（CI）

        private void OnUiLoaded(bool ok)
        {
            if (!options.SmokeTest || smokeFinished) return;
            Log("界面加载完成，window.jingjing " + (ok ? "已就绪" : "还没就绪"));
            if (ok) FinishSmoke(true, "界面加载完成");
        }

        private void FinishSmoke(bool ok, string message)
        {
            if (smokeFinished) return;
            smokeFinished = true;
            quitting = true;
            Log((ok ? "通过：" : "失败：") + message);
            // 能被 App 正常关掉也是测试的一部分（POST /api/system/shutdown → 服务自己收尾退出）。
            var graceful = Shutdown();
            Log(graceful ? "服务已正常退出" : "服务没有在规定时间内自己退出，被强制结束了");
            ExitCode = ok && graceful ? 0 : 1;
            try
            {
                Directory.CreateDirectory(Paths.DataDir);
                File.WriteAllText(Path.Combine(Paths.DataDir, "smoke-test.txt"), smokeLog.ToString());
            }
            catch
            {
                // 写不了结果文件就只看退出码。
            }
            // Post：服务没能启动时这里可能还在构造函数里、消息循环还没开始。
            ui.Post(_ => ExitThread(), null);
        }

        private void Log(string message)
        {
            smokeLog.WriteLine($"{DateTime.Now:HH:mm:ss} {message}");
        }
    }
}

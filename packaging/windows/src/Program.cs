using System;
using System.Threading;
using System.Windows.Forms;

namespace Jingjing
{
    /// <summary>
    /// 入口。参数：
    ///   （无）          启动并打开窗口；已经在运行就把那边的窗口叫出来
    ///   --background    启动但不打开窗口（登录时自动启动用）
    ///   --quit          让正在运行的静静正常退出并等它退完（安装、卸载前用）
    ///   --smoke-test    冒烟测试（CI）：起服务、打开窗口、等界面加载出来，再正常退出；退出码 0 表示通过
    /// </summary>
    internal static class Program
    {
        internal const string MutexName = @"Local\Jingjing.Desktop";
        internal const string ShowEventName = @"Local\Jingjing.Desktop.Show";
        internal const string QuitEventName = @"Local\Jingjing.Desktop.Quit";

        [STAThread]
        private static int Main(string[] args)
        {
            if (HasArg(args, "--quit")) return QuitRunning();
            var options = new AppOptions
            {
                Background = HasArg(args, "--background"),
                SmokeTest = HasArg(args, "--smoke-test")
            };

            bool created;
            using (var mutex = new Mutex(true, MutexName, out created))
            {
                if (!created && !options.SmokeTest)
                {
                    // 已经开着：叫它把窗口拿出来，自己退出。先把「切到前台」的权利让给它，否则 Windows 只会闪任务栏。
                    if (!options.Background)
                    {
                        AllowSetForegroundWindow(-1);
                        Signal(ShowEventName);
                    }
                    return 0;
                }
                try
                {
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    var app = new TrayApp(options);
                    Application.Run(app);
                    return app.ExitCode;
                }
                finally
                {
                    if (created) mutex.ReleaseMutex();
                }
            }
        }

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool AllowSetForegroundWindow(int processId);

        private static bool HasArg(string[] args, string name)
        {
            foreach (var arg in args)
            {
                if (string.Equals(arg, name, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private static void Signal(string name)
        {
            try
            {
                using (var handle = EventWaitHandle.OpenExisting(name)) handle.Set();
            }
            catch (WaitHandleCannotBeOpenedException)
            {
                // 那边还没来得及建好事件（刚启动）：忽略。
            }
        }

        /// <summary>通知正在运行的静静退出，等它把服务停好、进程退掉（最多 30 秒）。</summary>
        private static int QuitRunning()
        {
            try
            {
                using (var handle = EventWaitHandle.OpenExisting(QuitEventName)) handle.Set();
            }
            catch (WaitHandleCannotBeOpenedException)
            {
                return 0; // 没在运行
            }
            try
            {
                using (var mutex = Mutex.OpenExisting(MutexName))
                {
                    try
                    {
                        if (mutex.WaitOne(TimeSpan.FromSeconds(30))) mutex.ReleaseMutex();
                    }
                    catch (AbandonedMutexException)
                    {
                        // 那边退出时没释放：一样算退完了。
                    }
                }
            }
            catch (WaitHandleCannotBeOpenedException)
            {
                // 已经退了。
            }
            return 0;
        }
    }

    internal sealed class AppOptions
    {
        public bool Background;
        public bool SmokeTest;
    }
}

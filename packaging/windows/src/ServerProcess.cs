using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace Jingjing
{
    /// <summary>
    /// App 自带的 node 跑 app\server.js。没有黑窗口；输出追加到 &lt;数据目录&gt;\logs\server.log。
    /// 服务端通过 JINGJING_PARENT_PID 盯着 App：App 不管怎么没的（崩溃、被结束），服务都会在几秒内自己正常退出。
    /// </summary>
    internal sealed class ServerProcess
    {
        private readonly object logLock = new object();
        private Process process;
        private StreamWriter log;
        private Process stoppingProcess; // 我们自己在停的那个进程：它退出不算意外

        /// <summary>进程退出了（在线程池线程上触发）。参数：退出码、是不是我们自己停的。</summary>
        public event Action<int, bool> Exited;

        public DateTime StartedAt { get; private set; }

        public bool Running
        {
            get
            {
                var current = process;
                if (current == null) return false;
                try { return !current.HasExited; } catch { return false; }
            }
        }

        public void Start(bool localOnly)
        {
            if (Running) return;
            if (!File.Exists(Paths.Node)) throw new FileNotFoundException("App 里没有找到 Node 运行时（runtime\\node.exe），请重新安装静静。", Paths.Node);
            var server = Path.Combine(Paths.AppDir, "server.js");
            if (!File.Exists(server)) throw new FileNotFoundException("App 里没有找到服务程序（app\\server.js），请重新安装静静。", server);

            Directory.CreateDirectory(Path.GetDirectoryName(Paths.LogFile));
            lock (logLock)
            {
                log = new StreamWriter(new FileStream(Paths.LogFile, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete), new UTF8Encoding(false));
                log.AutoFlush = true;
                log.WriteLine($"----- {DateTime.Now:yyyy-MM-dd HH:mm:ss} 静静桌面 App v{Paths.Version} 启动服务 -----");
            }

            var info = new ProcessStartInfo(Paths.Node, "\"" + server + "\"")
            {
                WorkingDirectory = Paths.AppDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            info.EnvironmentVariables["JINGJING_DATA_DIR"] = Paths.DataDir;
            info.EnvironmentVariables["JINGJING_HOST"] = localOnly ? "127.0.0.1" : "0.0.0.0";
            info.EnvironmentVariables["JINGJING_PORT"] = Paths.Port.ToString();
            info.EnvironmentVariables["JINGJING_PARENT_PID"] = Process.GetCurrentProcess().Id.ToString();

            var child = new Process { StartInfo = info, EnableRaisingEvents = true };
            child.OutputDataReceived += (sender, e) => Write(e.Data);
            child.ErrorDataReceived += (sender, e) => Write(e.Data);
            child.Exited += (sender, e) => OnExited(child);
            child.Start();
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            process = child;
            StartedAt = DateTime.Now;
        }

        /// <summary>
        /// 先请服务自己收尾（POST /api/system/shutdown：停掉任务和子进程、记好断点），
        /// 等 graceMs 还没退就结束整棵进程树（任务下次启动照样会按断点恢复）。
        /// 返回服务是不是自己正常退出的（没在运行也算 true）。
        /// </summary>
        public bool Stop(int graceMs = 7000)
        {
            var current = process;
            if (current == null) return true;
            stoppingProcess = current;
            var graceful = true;
            try
            {
                if (!current.HasExited)
                {
                    Http.Post("/api/system/shutdown", "{}", 2000);
                    if (!current.WaitForExit(graceMs))
                    {
                        graceful = false;
                        KillTree(current.Id);
                    }
                    current.WaitForExit(3000);
                }
            }
            catch
            {
                // 进程已经没了。
            }
            if (ReferenceEquals(process, current)) process = null;
            return graceful;
        }

        private void OnExited(Process child)
        {
            var code = -1;
            try { code = child.ExitCode; } catch { }
            // 退出事件可能比最后几行输出先到：等输出读完再关日志，但最多等 3 秒
            // （万一有子进程继承了输出管道一直不关，不能把退出事件卡住）。
            try { System.Threading.Tasks.Task.Run(() => child.WaitForExit()).Wait(3000); } catch { }
            lock (logLock)
            {
                log?.WriteLine($"----- {DateTime.Now:yyyy-MM-dd HH:mm:ss} 服务退出（{code}） -----");
                log?.Dispose();
                log = null;
            }
            if (ReferenceEquals(process, child)) process = null;
            Exited?.Invoke(code, ReferenceEquals(child, stoppingProcess));
        }

        private void Write(string line)
        {
            if (line == null) return;
            lock (logLock)
            {
                try { log?.WriteLine(line); } catch { }
            }
        }

        private static void KillTree(int pid)
        {
            try
            {
                using (var killer = Process.Start(new ProcessStartInfo("taskkill", $"/PID {pid} /T /F")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true
                }))
                {
                    killer?.WaitForExit(5000);
                }
            }
            catch
            {
                // taskkill 不可用就算了。
            }
        }
    }
}

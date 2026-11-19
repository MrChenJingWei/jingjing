using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Jingjing
{
    /// <summary>
    /// 订阅本机服务的事件流（/api/stream，SSE），断线 3 秒后重连。用配对码做 Bearer 鉴权。
    /// 事件在界面线程上触发。和 macOS App 的 EventStream 一样。
    /// </summary>
    internal sealed class EventStream
    {
        private readonly SynchronizationContext ui;
        private Thread thread;
        private volatile bool running;
        private volatile HttpWebRequest current;

        public event Action<string, Dictionary<string, object>> Received;

        public EventStream(SynchronizationContext ui)
        {
            this.ui = ui;
        }

        public void Start()
        {
            if (running) return;
            running = true;
            thread = new Thread(Loop) { IsBackground = true, Name = "jingjing-events" };
            thread.Start();
        }

        public void Stop()
        {
            running = false;
            try { current?.Abort(); } catch { }
        }

        private void Loop()
        {
            var json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
            while (running)
            {
                var key = Paths.ReadKey();
                if (key != null)
                {
                    try
                    {
                        // 服务每 20 秒发一次心跳；90 秒没有任何数据就当断线重连。
                        var request = Http.Create(Paths.BaseUrl + "/api/stream", 90000);
                        request.Timeout = 10000;
                        request.Accept = "text/event-stream";
                        request.Headers["Authorization"] = "Bearer " + key;
                        current = request;
                        using (var response = request.GetResponse())
                        using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                        {
                            var data = new StringBuilder();
                            string line;
                            while (running && (line = reader.ReadLine()) != null)
                            {
                                if (line.Length == 0)
                                {
                                    Dispatch(json, data.ToString());
                                    data.Clear();
                                }
                                else if (line.StartsWith("data:", StringComparison.Ordinal))
                                {
                                    data.Append(line.Substring(5).TrimStart());
                                }
                            }
                        }
                    }
                    catch
                    {
                        // 服务没起来、重启了、网络超时：下面等一下重连。
                    }
                    finally
                    {
                        current = null;
                    }
                }
                for (var i = 0; i < 30 && running; i++) Thread.Sleep(100);
            }
        }

        private void Dispatch(JavaScriptSerializer json, string payload)
        {
            if (payload.Length == 0) return;
            try
            {
                var packet = json.DeserializeObject(payload) as Dictionary<string, object>;
                if (packet == null) return;
                object typeValue;
                if (!packet.TryGetValue("type", out typeValue) || !(typeValue is string type)) return;
                object body;
                var data = packet.TryGetValue("payload", out body) ? body as Dictionary<string, object> : null;
                ui.Post(_ => Received?.Invoke(type, data ?? new Dictionary<string, object>()), null);
            }
            catch
            {
                // 解析不了的帧跳过。
            }
        }
    }

    /// <summary>从 JSON 字典里安全地取值。</summary>
    internal static class Json
    {
        public static Dictionary<string, object> Obj(Dictionary<string, object> source, string key)
        {
            object value;
            return source != null && source.TryGetValue(key, out value) ? value as Dictionary<string, object> : null;
        }

        public static string Str(Dictionary<string, object> source, string key)
        {
            object value;
            return source != null && source.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : null;
        }

        public static int Int(Dictionary<string, object> source, string key, int fallback = 0)
        {
            object value;
            if (source == null || !source.TryGetValue(key, out value) || value == null) return fallback;
            try { return Convert.ToInt32(value); } catch { return fallback; }
        }

        public static int Count(Dictionary<string, object> source, string key)
        {
            object value;
            return source != null && source.TryGetValue(key, out value) && value is object[] list ? list.Length : 0;
        }

        public static string Quote(string value)
        {
            return new JavaScriptSerializer().Serialize(value ?? "");
        }
    }
}

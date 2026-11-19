using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Jingjing
{
    /// <summary>
    /// 托盘图标：品牌那只睡猫。服务没运行时变灰；有事等你拍板时右下角一个红色数字角标。
    /// 每种状态只画一次，状态不变不重画。
    /// </summary>
    internal static class TrayIcons
    {
        private static Bitmap source;
        private static string currentKey;

        /// <summary>窗口和对话框用的图标（exe 里嵌的那个）。</summary>
        public static Icon AppIcon
        {
            get
            {
                try { return Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { return SystemIcons.Application; }
            }
        }

        /// <summary>返回当前状态的新图标；和上次一样就返回 null（调用方不用重设）。旧图标由调用方换下后释放。</summary>
        public static Icon Render(bool dimmed, int count)
        {
            var key = dimmed + "|" + count;
            if (key == currentKey) return null;
            var size = SystemInformation.SmallIconSize.Width;
            using (var bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bitmap))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                    var image = Source();
                    if (image != null)
                    {
                        var target = new Rectangle(0, 0, size, size);
                        if (dimmed)
                        {
                            using (var attributes = new ImageAttributes())
                            {
                                attributes.SetColorMatrix(Grayscale);
                                g.DrawImage(image, target, 0, 0, image.Width, image.Height, GraphicsUnit.Pixel, attributes);
                            }
                        }
                        else
                        {
                            g.DrawImage(image, target);
                        }
                    }
                    else
                    {
                        g.Clear(dimmed ? Color.Gray : Color.FromArgb(40, 30, 60));
                    }
                    if (count > 0) DrawBadge(g, size, count);
                }
                var handle = bitmap.GetHicon();
                var icon = (Icon)Icon.FromHandle(handle).Clone();
                DestroyIcon(handle);
                currentKey = key;
                return icon;
            }
        }

        private static void DrawBadge(Graphics g, int size, int count)
        {
            var text = count > 9 ? "9+" : count.ToString();
            var diameter = (int)Math.Round(size * (text.Length > 1 ? 0.72 : 0.62));
            var rect = new Rectangle(size - diameter, size - diameter, diameter, diameter);
            using (var fill = new SolidBrush(Color.FromArgb(232, 52, 64)))
            using (var ring = new Pen(Color.White, Math.Max(1f, size / 16f)))
            {
                g.FillEllipse(fill, rect);
                g.DrawEllipse(ring, rect);
            }
            using (var font = new Font("Segoe UI", diameter * (text.Length > 1 ? 0.42f : 0.6f), FontStyle.Bold, GraphicsUnit.Pixel))
            using (var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
            {
                g.DrawString(text, font, Brushes.White, new RectangleF(rect.X, rect.Y + 0.5f, rect.Width, rect.Height), format);
            }
        }

        private static Bitmap Source()
        {
            if (source != null) return source;
            try
            {
                using (var stream = typeof(TrayIcons).Assembly.GetManifestResourceStream("Jingjing.icon.png"))
                {
                    if (stream != null) source = new Bitmap(stream);
                }
            }
            catch
            {
                source = null;
            }
            return source;
        }

        private static readonly ColorMatrix Grayscale = new ColorMatrix(new[]
        {
            new[] { 0.30f, 0.30f, 0.30f, 0f, 0f },
            new[] { 0.59f, 0.59f, 0.59f, 0f, 0f },
            new[] { 0.11f, 0.11f, 0.11f, 0f, 0f },
            new[] { 0f, 0f, 0f, 0.55f, 0f },
            new[] { 0f, 0f, 0f, 0f, 1f }
        });

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool DestroyIcon(IntPtr handle);
    }
}

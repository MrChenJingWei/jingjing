using System;
using System.Drawing;
using System.Windows.Forms;

namespace Jingjing
{
    /// <summary>「显示配对码」：大字显示配对码，可以一键复制。</summary>
    internal sealed class PairingDialog : Form
    {
        public PairingDialog(string key)
        {
            Text = "静静配对码";
            Icon = TrayIcons.AppIcon;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = true;
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScaleDimensions = new SizeF(96F, 96F);
            ClientSize = new Size(440, 190);
            Font = new Font("Microsoft YaHei UI", 9F);

            var hint = new Label
            {
                Text = "在手机或浏览器里输入这串码（换了网络地址也不影响配对码）：",
                AutoSize = false,
                Location = new Point(20, 18),
                Size = new Size(400, 22)
            };
            var box = new TextBox
            {
                Text = key,
                ReadOnly = true,
                BorderStyle = BorderStyle.FixedSingle,
                Font = new Font("Consolas", 16F, FontStyle.Bold),
                TextAlign = HorizontalAlignment.Center,
                Location = new Point(20, 50),
                Size = new Size(400, 36)
            };
            var copy = new Button { Text = "复制", Location = new Point(244, 136), Size = new Size(84, 30) };
            var close = new Button { Text = "好", Location = new Point(336, 136), Size = new Size(84, 30), DialogResult = DialogResult.OK };
            copy.Click += (sender, e) =>
            {
                try
                {
                    Clipboard.SetText(key);
                    copy.Text = "已复制";
                }
                catch (Exception ex)
                {
                    MessageBox.Show(this, ex.Message, "没能复制", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            };
            Controls.AddRange(new Control[] { hint, box, copy, close });
            AcceptButton = close;
            CancelButton = close;
            Shown += (sender, e) =>
            {
                box.SelectionLength = 0;
                close.Focus();
            };
        }
    }
}

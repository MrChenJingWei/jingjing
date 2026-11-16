import AppKit
import Foundation
import CoreImage
import CoreImage.CIFilterBuiltins

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var serverProcess: Process?
    private var logHandle: FileHandle?
    private var healthTimer: Timer?
    private var running = false
    private var statusMenuItem: NSMenuItem!
    private var localOnlyItem: NSMenuItem!
    private var qrWindow: NSWindow?

    private let fm = FileManager.default

    private var port: Int {
        Int(ProcessInfo.processInfo.environment["JINGJING_PORT"] ?? "") ?? 7777
    }

    private var localOnly: Bool {
        UserDefaults.standard.bool(forKey: "localOnly")
    }

    private var dataDir: URL {
        if let custom = ProcessInfo.processInfo.environment["JINGJING_DATA_DIR"], !custom.isEmpty {
            return URL(fileURLWithPath: custom, isDirectory: true)
        }
        return fm.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Jingjing", isDirectory: true)
    }

    private var resources: URL { Bundle.main.resourceURL! }
    private var appDir: URL { resources.appendingPathComponent("app", isDirectory: true) }
    private var nodeURL: URL { resources.appendingPathComponent("runtime/node") }
    private var keyURL: URL { dataDir.appendingPathComponent("access-key") }
    private var logURL: URL { dataDir.appendingPathComponent("logs/server.log") }
    private var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        setupMenu()
        startServer()
        refresh()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        healthTimer?.invalidate()
        stopServer()
    }

    // MARK: - Menu

    private func setupMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "静静"

        let menu = NSMenu()
        statusMenuItem = NSMenuItem(title: "服务启动中…", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(.separator())

        menu.addItem(item("打开控制台", #selector(openConsole), "o"))
        menu.addItem(item("显示配对码…", #selector(showKey), ""))
        menu.addItem(item("复制配对码", #selector(copyKey), "c"))
        menu.addItem(item("手机安装二维码…", #selector(showQRCode), "q"))
        menu.addItem(.separator())

        localOnlyItem = item("仅本机访问", #selector(toggleLocalOnly), "")
        localOnlyItem.state = localOnly ? .on : .off
        menu.addItem(localOnlyItem)

        menu.addItem(item("重启服务", #selector(restartServer), "r"))
        menu.addItem(item("打开数据文件夹", #selector(openDataFolder), ""))
        menu.addItem(item("打开插件文件夹", #selector(openPluginsFolder), ""))
        menu.addItem(item("打开日志", #selector(openLog), ""))
        menu.addItem(.separator())
        menu.addItem(item("退出静静", #selector(quitApp), "q"))

        statusItem.menu = menu
    }

    private func item(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let menuItem = NSMenuItem(title: title, action: action, keyEquivalent: key)
        menuItem.target = self
        return menuItem
    }

    // MARK: - Server lifecycle

    private func startServer() {
        guard serverProcess == nil else { return }
        guard fm.fileExists(atPath: nodeURL.path) else {
            alert("缺少运行环境", "App 内没有找到 Node 运行时，请重新安装静静。")
            return
        }
        do {
            try fm.createDirectory(at: dataDir.appendingPathComponent("logs"), withIntermediateDirectories: true)
            if !fm.fileExists(atPath: logURL.path) {
                fm.createFile(atPath: logURL.path, contents: nil)
            }
            logHandle = try FileHandle(forWritingTo: logURL)
            logHandle?.seekToEndOfFile()

            let process = Process()
            process.executableURL = nodeURL
            process.arguments = [appDir.appendingPathComponent("server.js").path]
            process.currentDirectoryURL = appDir
            var env = ProcessInfo.processInfo.environment
            env["JINGJING_DATA_DIR"] = dataDir.path
            env["JINGJING_HOST"] = localOnly ? "127.0.0.1" : "0.0.0.0"
            env["JINGJING_PORT"] = String(port)
            env["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
            process.environment = env
            process.standardOutput = logHandle
            process.standardError = logHandle
            process.terminationHandler = { [weak self] proc in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.running = false
                    self.serverProcess = nil
                    self.updateStatus()
                    if proc.terminationStatus != 0 {
                        self.statusMenuItem.title = "服务已退出（\(proc.terminationStatus)）"
                    }
                }
            }
            try process.run()
            serverProcess = process
            statusMenuItem.title = "服务启动中…"
        } catch {
            alert("无法启动服务", error.localizedDescription)
        }
    }

    private func stopServer() {
        serverProcess?.terminationHandler = nil
        serverProcess?.terminate()
        serverProcess = nil
        running = false
        try? logHandle?.close()
        logHandle = nil
        updateStatus()
    }

    private func refresh() {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/health") else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            let ok = (data != nil)
            DispatchQueue.main.async {
                guard let self else { return }
                self.running = ok
                self.updateStatus()
                let suppress = ProcessInfo.processInfo.environment["JINGJING_NO_AUTO_OPEN"] == "1"
                if ok && !suppress && !UserDefaults.standard.bool(forKey: "didAutoOpen") {
                    UserDefaults.standard.set(true, forKey: "didAutoOpen")
                    self.openConsole()
                }
            }
        }.resume()
    }

    private func updateStatus() {
        statusItem.button?.title = running ? "静静 ●" : "静静 ○"
        if running {
            statusMenuItem.title = "服务运行中 · 端口 \(port) · \(localOnly ? "仅本机" : "局域网可访问")"
        } else if serverProcess == nil {
            statusMenuItem.title = "服务未运行"
        }
    }

    private func readKey() -> String? {
        guard let text = try? String(contentsOf: keyURL, encoding: .utf8) else { return nil }
        let key = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return key.isEmpty ? nil : key
    }

    // MARK: - Actions

    @objc private func openConsole() {
        var target = baseURL
        if let key = readKey(),
           let encoded = key.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
           let authorized = URL(string: "\(baseURL.absoluteString)/pair?key=\(encoded)") {
            target = authorized
        }
        NSWorkspace.shared.open(target)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func copyKey() {
        guard let key = readKey() else {
            alert("还没有配对码", "服务刚启动时需要几秒钟生成配对码，请稍后再试。")
            return
        }
        let board = NSPasteboard.general
        board.clearContents()
        board.setString(key, forType: .string)
        notify("配对码已复制")
    }

    @objc private func showKey() {
        guard let key = readKey() else {
            alert("还没有配对码", "服务启动后会自动生成。请确认服务正在运行。")
            return
        }
        let alert = NSAlert()
        alert.messageText = "静静配对码"
        alert.informativeText = "在手机或浏览器里输入这串码：\n\n\(key)\n\n换了网络地址也不影响配对码。"
        alert.addButton(withTitle: "复制")
        alert.addButton(withTitle: "好")
        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            let board = NSPasteboard.general
            board.clearContents()
            board.setString(key, forType: .string)
        }
    }

    @objc private func showQRCode() {
        guard let key = readKey() else {
            alert("还没有配对码", "服务启动后会自动生成，请稍后再试。")
            return
        }
        guard let ip = lanAddress() else {
            alert("没有找到局域网地址", "请确认这台电脑已连接 Wi-Fi 或 Tailscale，再试一次。")
            return
        }
        let urlString = "http://\(ip):\(port)/pair?key=\(key)"
        guard let image = qrImage(urlString) else {
            alert("二维码生成失败", "可以手动在手机浏览器打开：\(urlString)")
            return
        }

        let window = qrWindow ?? NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 520),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "手机安装静静"
        window.isReleasedWhenClosed = false

        let content = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 520))
        let imageView = NSImageView(frame: NSRect(x: 60, y: 150, width: 300, height: 300))
        imageView.image = image
        imageView.imageScaling = .scaleProportionallyUpOrDown
        content.addSubview(imageView)

        let title = NSTextField(labelWithString: "用手机相机扫码，打开后安装到主屏幕")
        title.frame = NSRect(x: 24, y: 118, width: 372, height: 20)
        title.alignment = .center
        title.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        content.addSubview(title)

        let hint = NSTextField(wrappingLabelWithString: urlString + "\n\nAndroid Chrome：菜单 → 安装应用 / 添加到主屏幕\niPhone Safari：分享 → 添加到主屏幕")
        hint.frame = NSRect(x: 24, y: 48, width: 372, height: 62)
        hint.alignment = .center
        hint.font = NSFont.systemFont(ofSize: 10.5)
        hint.textColor = .secondaryLabelColor
        content.addSubview(hint)

        if localOnly {
            let warning = NSTextField(labelWithString: "当前是「仅本机访问」，手机连不上。请先在菜单里取消勾选。")
            warning.frame = NSRect(x: 20, y: 20, width: 380, height: 18)
            warning.alignment = .center
            warning.font = NSFont.systemFont(ofSize: 10.5)
            warning.textColor = .systemRed
            content.addSubview(warning)
        }

        window.contentView = content
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        qrWindow = window
    }

    private func lanAddress() -> String? {
        // Tailscale 优先：手机在外面也能扫码连上
        for tailscale in ["/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"] {
            if let ip = commandOutput(tailscale, ["ip", "-4"]), !ip.isEmpty {
                return ip.split(separator: "\n").first.map(String.init)
            }
        }
        if let ip = commandOutput("/usr/sbin/ipconfig", ["getifaddr", "en0"]), !ip.isEmpty {
            return ip
        }
        if let ip = commandOutput("/usr/sbin/ipconfig", ["getifaddr", "en1"]), !ip.isEmpty {
            return ip
        }
        return nil
    }

    private func commandOutput(_ path: String, _ args: [String]) -> String? {
        guard fm.isExecutableFile(atPath: path) else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return nil
        }
    }

    private func qrImage(_ string: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        let rep = NSCIImageRep(ciImage: scaled)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }

    @objc private func toggleLocalOnly() {
        UserDefaults.standard.set(!localOnly, forKey: "localOnly")
        localOnlyItem.state = localOnly ? .on : .off
        restartServer()
    }

    @objc private func restartServer() {
        stopServer()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            self?.startServer()
        }
    }

    @objc private func openDataFolder() {
        try? fm.createDirectory(at: dataDir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(dataDir)
    }

    @objc private func openPluginsFolder() {
        let folder = dataDir.appendingPathComponent("plugins", isDirectory: true)
        try? fm.createDirectory(at: folder, withIntermediateDirectories: true)
        NSWorkspace.shared.open(folder)
    }

    @objc private func openLog() {
        if fm.fileExists(atPath: logURL.path) {
            NSWorkspace.shared.open(logURL)
        } else {
            openDataFolder()
        }
    }

    @objc private func quitApp() {
        stopServer()
        NSApp.terminate(nil)
    }

    // MARK: - Helpers

    private func alert(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    private func notify(_ message: String) {
        statusItem.button?.title = "静静 ✓"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
            self?.updateStatus()
        }
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = "可以粘贴到手机或浏览器的配对框里。"
        alert.addButton(withTitle: "好")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()

import AppKit
import WebKit

/// 标题栏做成透明、网页铺满整个窗口后，WKWebView 会吃掉顶部的鼠标事件，窗口就拖不动了。
/// 这一条透明视图盖在网页最上面（红绿灯那一条，网页里对应留空），负责拖动窗口和双击缩放。
final class TitlebarDragView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            // 跟随「系统设置 → 桌面与程序坞 → 连按窗口标题栏」的选项。
            let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
            if action == "Minimize" { window?.performMiniaturize(nil) }
            else if action != "None" { window?.performZoom(nil) }
            return
        }
        window?.performDrag(with: event)
    }
}

/// 静静的原生主窗口：WKWebView 加载本机界面（和手机 PWA 是同一套前端）。
/// 补齐 WKWebView 默认不处理的东西：confirm / alert / prompt、文件选择、下载、外部链接。
final class MainWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var webView: WKWebView!
    private var dragStrip: TitlebarDragView!
    private var isFullScreen = false
    private let baseURL: URL
    private let keyProvider: () -> String?
    private var loaded = false
    private var serverReady = false
    private var pendingScript: String?
    private var downloads: [ObjectIdentifier: URL] = [:]

    /// 窗口显示 / 隐藏时回调，用来切换 Dock 图标。
    var onVisibilityChange: ((Bool) -> Void)?

    init(baseURL: URL, keyProvider: @escaping () -> String?) {
        self.baseURL = baseURL
        self.keyProvider = keyProvider
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            // 标题栏透明、内容铺到顶部：侧栏一直延伸到红绿灯下面，和系统自带 App 一样。
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "静静"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 420, height: 560)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.collectionBehavior.insert(.fullScreenPrimary)
        super.init(window: window)
        window.delegate = self

        let measured = window.frame.height - window.contentLayoutRect.height
        let titlebarHeight = measured > 0 ? measured : 28

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        // 前端据此判断自己跑在桌面 App 里。
        config.applicationNameForUserAgent = "JingjingDesktop/\(version)"
        // 告诉网页顶部有多高一条要留给红绿灯（native-inset）；旧版 App 不注入，网页就按普通窗口排版。
        let inset = """
        (function () {
          var apply = function () {
            var root = document.documentElement;
            if (!root) return false;
            root.classList.add('native-inset');
            root.style.setProperty('--titlebar-h', '\(Int(titlebarHeight.rounded()))px');
            return true;
          };
          if (!apply()) document.addEventListener('readystatechange', apply, { once: true });
        })();
        """
        config.userContentController.addUserScript(WKUserScript(source: inset, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.underPageBackgroundColor = .windowBackgroundColor
        webView.translatesAutoresizingMaskIntoConstraints = false

        dragStrip = TitlebarDragView()
        dragStrip.translatesAutoresizingMaskIntoConstraints = false

        let container = NSView()
        container.addSubview(webView)
        container.addSubview(dragStrip)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            dragStrip.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            dragStrip.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            dragStrip.topAnchor.constraint(equalTo: container.topAnchor),
            dragStrip.heightAnchor.constraint(equalToConstant: titlebarHeight)
        ])
        window.contentView = container

        if !window.setFrameUsingName("JingjingMain") { window.center() }
        window.setFrameAutosaveName("JingjingMain")
        showStarting()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    var isVisible: Bool { window?.isVisible == true }
    var isFrontmost: Bool { NSApp.isActive && window?.isKeyWindow == true }

    // MARK: - 显示

    func show() {
        loadIfReady()
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        onVisibilityChange?(true)
    }

    func toggle() {
        if isFrontmost {
            window?.orderOut(nil)
            onVisibilityChange?(false)
        } else {
            show()
        }
    }

    /// 服务起来了：加载界面（第一次带配对码，之后靠 Cookie）。
    func setServerReady(_ ready: Bool) {
        let becameReady = ready && !serverReady
        serverReady = ready
        if becameReady && isVisible { loadIfReady() }
    }

    func reload() {
        if loaded { webView.reload() } else { loadIfReady() }
    }

    func zoom(_ delta: CGFloat?) {
        webView.pageZoom = delta.map { min(2.0, max(0.6, webView.pageZoom + $0)) } ?? 1.0
    }

    /// 打开某个任务的详情（点通知时用）。
    func openTask(_ id: String) {
        run("window.jingjing && window.jingjing.openTask(\(jsString(id)))")
    }

    func openView(_ name: String) {
        run("window.jingjing && window.jingjing.openView(\(jsString(name)))")
    }

    private func run(_ script: String) {
        show()
        if loaded && !webView.isLoading {
            webView.evaluateJavaScript(script, completionHandler: nil)
        } else {
            pendingScript = script
        }
    }

    private func loadIfReady() {
        guard serverReady, !loaded else { return }
        loaded = true
        var target = baseURL
        if let key = keyProvider(),
           let encoded = key.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
           let url = URL(string: "\(baseURL.absoluteString)/pair?key=\(encoded)") {
            target = url
        }
        webView.load(URLRequest(url: target))
    }

    private func showStarting(_ detail: String = "正在启动本机服务…") {
        let html = """
        <!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">
        <body style="margin:0;height:100vh;display:grid;place-items:center;font:15px -apple-system,sans-serif;color:#888">
        <div style="text-align:center"><div style="font-size:28px;margin-bottom:10px">静静</div>\(detail)</div></body>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func jsString(_ value: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [value])) ?? Data("[\"\"]".utf8)
        let array = String(data: data, encoding: .utf8) ?? "[\"\"]"
        return String(array.dropFirst().dropLast())
    }

    private func isLocal(_ url: URL) -> Bool {
        guard let host = url.host else { return url.scheme == "about" || url.scheme == "data" || url.scheme == "blob" }
        return host == baseURL.host && url.port == baseURL.port
    }

    // MARK: - NSWindowDelegate

    func windowWillClose(_ notification: Notification) {
        onVisibilityChange?(false)
    }

    // 全屏时系统把标题栏收起来了，顶部那条留白和拖动条都不需要。
    func windowDidEnterFullScreen(_ notification: Notification) {
        isFullScreen = true
        applyTitlebarInset()
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        isFullScreen = false
        applyTitlebarInset()
    }

    private func applyTitlebarInset() {
        dragStrip.isHidden = isFullScreen
        webView.evaluateJavaScript("document.documentElement.classList.toggle('native-inset', \(isFullScreen ? "false" : "true"))", completionHandler: nil)
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
        if navigationAction.shouldPerformDownload { return decisionHandler(.download) }
        if isLocal(url) { return decisionHandler(.allow) }
        // 外部链接交给系统浏览器，界面里只留静静自己的页面。
        if navigationAction.navigationType == .linkActivated || navigationAction.targetFrame?.isMainFrame != false {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let http = navigationResponse.response as? HTTPURLResponse,
           let disposition = http.value(forHTTPHeaderField: "Content-Disposition"),
           disposition.lowercased().contains("attachment") {
            return decisionHandler(.download)
        }
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if isFullScreen { applyTitlebarInset() }
        if let script = pendingScript, loaded {
            pendingScript = nil
            webView.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // 服务还没起来或刚重启：显示等待页，服务恢复后重新加载。
        guard loaded else { return }
        loaded = false
        serverReady = false
        showStarting("连不上本机服务，正在等它恢复…")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: - WKDownloadDelegate

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
        let base = (suggestedFilename as NSString).deletingPathExtension
        let ext = (suggestedFilename as NSString).pathExtension
        var target = folder.appendingPathComponent(suggestedFilename)
        var index = 2
        while FileManager.default.fileExists(atPath: target.path) {
            target = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(index)" : "\(base) \(index).\(ext)")
            index += 1
        }
        downloads[ObjectIdentifier(download)] = target
        completionHandler(target)
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        present(alert("下载失败", error.localizedDescription, buttons: ["好"])) { _ in }
    }

    // MARK: - WKUIDelegate：JS 对话框、文件选择、新窗口

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        present(alert(message, nil, buttons: ["好"])) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        present(alert(message, nil, buttons: ["确定", "取消"])) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let panel = alert(prompt, nil, buttons: ["确定", "取消"])
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        panel.accessoryView = field
        panel.window.initialFirstResponder = field
        present(panel) { response in
            completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        let finish: (NSApplication.ModalResponse) -> Void = { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
        if let window, window.isVisible {
            panel.beginSheetModal(for: window, completionHandler: finish)
        } else {
            finish(panel.runModal())
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // target="_blank"：本机页面在当前窗口打开，外部链接交给浏览器。
        if let url = navigationAction.request.url {
            if isLocal(url) { webView.load(navigationAction.request) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    // MARK: - Helpers

    private func alert(_ title: String, _ message: String?, buttons: [String]) -> NSAlert {
        let alert = NSAlert()
        alert.messageText = title
        if let message { alert.informativeText = message }
        for button in buttons { alert.addButton(withTitle: button) }
        return alert
    }

    private func present(_ alert: NSAlert, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        if let window, window.isVisible {
            alert.beginSheetModal(for: window, completionHandler: completion)
        } else {
            NSApp.activate(ignoringOtherApps: true)
            completion(alert.runModal())
        }
    }
}

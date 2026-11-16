import AppKit
import Foundation
import UserNotifications

/// 订阅本机服务的 SSE 事件流（/api/stream），断线自动重连。用配对码做 Bearer 鉴权。
final class EventStream: NSObject, URLSessionDataDelegate {
    private let url: URL
    private let keyProvider: () -> String?
    private var session: URLSession!
    private var task: URLSessionDataTask?
    private var buffer = Data()
    private var running = false
    private var retry: DispatchWorkItem?

    var onEvent: ((String, [String: Any]) -> Void)?

    init(url: URL, keyProvider: @escaping () -> String?) {
        self.url = url
        self.keyProvider = keyProvider
        super.init()
        let config = URLSessionConfiguration.default
        // 服务每 20 秒发一次心跳；90 秒没有任何数据就当断线重连。
        config.timeoutIntervalForRequest = 90
        config.timeoutIntervalForResource = .infinity
        session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }

    func start() {
        guard !running else { return }
        running = true
        connect()
    }

    func stop() {
        running = false
        retry?.cancel()
        task?.cancel()
        task = nil
    }

    private func connect() {
        guard running else { return }
        guard let key = keyProvider() else { return scheduleRetry() }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        buffer.removeAll()
        task = session.dataTask(with: request)
        task?.resume()
    }

    private func scheduleRetry() {
        guard running else { return }
        retry?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.connect() }
        retry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        buffer.append(data)
        let separator = Data("\n\n".utf8)
        while let range = buffer.range(of: separator) {
            let frame = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
            buffer.removeSubrange(buffer.startIndex..<range.upperBound)
            handle(frame)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if task === self.task { scheduleRetry() }
    }

    private func handle(_ frame: Data) {
        guard let text = String(data: frame, encoding: .utf8) else { return }
        var payload = ""
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) where line.hasPrefix("data:") {
            payload += line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        }
        guard !payload.isEmpty,
              let json = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any],
              let type = json["type"] as? String else { return }
        onEvent?(type, json["payload"] as? [String: Any] ?? [:])
    }
}

/// 把服务端事件变成 macOS 通知：需要拍板时提醒（选项不多时可以直接在通知上选），任务完成 / 失败时告知。
/// 窗口在前台时不弹，网页里已经有提示。
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    /// 只有作为 .app 运行时才有通知中心；直接运行可执行文件时为 nil。
    private let center: UNUserNotificationCenter? = Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current()
    private var authorized: Bool?
    private var categories: [String: UNNotificationCategory] = [:]
    private var categoryOrder: [String] = []

    var isFrontmost: () -> Bool = { false }
    var onOpenTask: ((String) -> Void)?
    var onResolve: ((String, Int) -> Void)?
    var onPendingCount: ((Int) -> Void)?

    override init() {
        super.init()
        center?.delegate = self
    }

    func handle(type: String, payload: [String: Any]) {
        switch type {
        case "approval/created":
            guard let approval = payload["approval"] as? [String: Any],
                  let id = approval["id"] as? String else { return }
            let task = payload["task"] as? [String: Any] ?? [:]
            let options = approval["options"] as? [String] ?? []
            post(
                id: "approval-\(id)",
                title: "「\(task["title"] as? String ?? "任务")」等你拍板",
                body: approval["question"] as? String ?? "",
                actions: options.count <= 3 ? options : [],
                userInfo: ["approvalId": id, "taskId": task["id"] as? String ?? ""]
            )
        case "approval/resolved":
            if let approval = payload["approval"] as? [String: Any], let id = approval["id"] as? String {
                center?.removeDeliveredNotifications(withIdentifiers: ["approval-\(id)"])
            }
        case "task/finished":
            guard let task = payload["task"] as? [String: Any],
                  let id = task["id"] as? String,
                  let status = task["status"] as? String else { return }
            let title = task["title"] as? String ?? "任务"
            let detail = (status == "failed" ? task["error"] : task["result"]) as? String ?? ""
            let firstLine = detail.split(separator: "\n").first.map(String.init) ?? ""
            post(id: "task-\(id)", title: status == "failed" ? "失败了：\(title)" : "完成了：\(title)",
                 body: String(firstLine.prefix(120)), actions: [], userInfo: ["taskId": id])
        case "stats/updated":
            if let pending = payload["pendingApprovals"] as? Int { onPendingCount?(pending) }
        default:
            break
        }
    }

    private func post(id: String, title: String, body: String, actions: [String], userInfo: [String: String]) {
        guard let center, !isFrontmost() else { return }
        withAuthorization { [weak self] ok in
            guard ok, let self else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            content.userInfo = userInfo
            if !actions.isEmpty {
                content.categoryIdentifier = self.category(for: id, options: actions)
            }
            center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
        }
    }

    /// 第一次真的要发通知时才申请权限，不在启动时打扰。
    private func withAuthorization(_ next: @escaping (Bool) -> Void) {
        if let authorized { return next(authorized) }
        center?.requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] granted, _ in
            DispatchQueue.main.async {
                self?.authorized = granted
                next(granted)
            }
        }
    }

    /// 每条审批一个通知分类，按钮就是它的选项。只保留最近 20 个分类。
    private func category(for id: String, options: [String]) -> String {
        let actions = options.enumerated().map { index, title in
            UNNotificationAction(identifier: "choice-\(index)", title: title, options: [])
        }
        categories[id] = UNNotificationCategory(identifier: id, actions: actions, intentIdentifiers: [], options: [])
        categoryOrder.append(id)
        while categoryOrder.count > 20 {
            categories.removeValue(forKey: categoryOrder.removeFirst())
        }
        center?.setNotificationCategories(Set(categories.values))
        return id
    }

    // MARK: - UNUserNotificationCenterDelegate

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler(isFrontmost() ? [] : [.banner, .sound, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let action = response.actionIdentifier
        DispatchQueue.main.async { [weak self] in
            if action.hasPrefix("choice-"), let approvalId = info["approvalId"] as? String,
               let choice = Int(action.dropFirst("choice-".count)) {
                self?.onResolve?(approvalId, choice)
            } else if let taskId = info["taskId"] as? String, !taskId.isEmpty {
                self?.onOpenTask?(taskId)
            }
            completionHandler()
        }
    }
}

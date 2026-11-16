import Carbon.HIToolbox

/// 全局快捷键（Carbon RegisterEventHotKey）：不需要辅助功能权限。
final class HotKey {
    private static var actions: [UInt32: () -> Void] = [:]
    private static var handler: EventHandlerRef?
    private var ref: EventHotKeyRef?
    private let id: UInt32

    /// keyCode 用 kVK_*，modifiers 用 cmdKey / optionKey / controlKey / shiftKey 的组合。
    init?(keyCode: Int, modifiers: Int, id: UInt32 = 1, action: @escaping () -> Void) {
        self.id = id
        if HotKey.handler == nil {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let status = InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
                var hotKeyID = EventHotKeyID()
                let result = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                               nil, MemoryLayout<EventHotKeyID>.size, nil, &hotKeyID)
                if result == noErr, let action = HotKey.actions[hotKeyID.id] {
                    DispatchQueue.main.async(execute: action)
                }
                return noErr
            }, 1, &spec, nil, &HotKey.handler)
            guard status == noErr else { return nil }
        }
        let hotKeyID = EventHotKeyID(signature: OSType(0x4A4A4A4A), id: id) // 'JJJJ'
        let status = RegisterEventHotKey(UInt32(keyCode), UInt32(modifiers), hotKeyID, GetApplicationEventTarget(), 0, &ref)
        guard status == noErr else { return nil }
        HotKey.actions[id] = action
    }

    deinit {
        if let ref { UnregisterEventHotKey(ref) }
        HotKey.actions.removeValue(forKey: id)
    }
}

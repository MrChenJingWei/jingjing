import AppKit

// 入口：菜单栏常驻，按需打开原生窗口。见 JingjingApp.swift。
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()

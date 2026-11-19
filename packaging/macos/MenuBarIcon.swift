import AppKit

/// 菜单栏图标：品牌那只睡猫的单色剪影（眼睛镂空），和网页侧栏的 catMark 同一套轮廓。
/// 做成 template image，浅色 / 深色菜单栏下由系统自动着色；状态由调用方用 appearsDisabled 和标题数字表达。
enum MenuBarIcon {
    /// 猫在 SVG 里的取景范围（viewBox 坐标），缩放到 18pt 高。
    private static let origin = CGPoint(x: 104, y: 150)
    private static let scale: CGFloat = 18.0 / 262.0

    static let image: NSImage = {
        let size = NSSize(width: ceil(350 * scale), height: 18)
        let image = NSImage(size: size, flipped: true) { _ in
            draw()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "静静"
        return image
    }()

    private static func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
        NSPoint(x: (x - origin.x) * scale, y: (y - origin.y) * scale)
    }

    private static func draw() {
        NSColor.black.setFill()
        NSColor.black.setStroke()

        // 身体
        let body = NSBezierPath()
        body.move(to: p(112, 350))
        body.curve(to: p(270, 196), controlPoint1: p(112, 254), controlPoint2: p(184, 196))
        body.curve(to: p(408, 316), controlPoint1: p(356, 196), controlPoint2: p(408, 252))
        body.curve(to: p(316, 392), controlPoint1: p(408, 366), controlPoint2: p(370, 392))
        body.line(to: p(170, 392))
        body.curve(to: p(112, 350), controlPoint1: p(136, 392), controlPoint2: p(112, 376))
        body.close()
        body.fill()

        // 两只耳朵（分开填，免得和身体的绕向互相抵消出洞）
        for ear in [[p(146, 270), p(154, 190), p(210, 236)], [p(226, 216), p(254, 154), p(286, 220)]] {
            let path = NSBezierPath()
            path.move(to: ear[0])
            path.line(to: ear[1])
            path.line(to: ear[2])
            path.close()
            path.lineJoinStyle = .round
            path.lineWidth = 1
            path.fill()
            path.stroke()
        }

        // 尾巴：从身后绕到身前
        let tail = NSBezierPath()
        tail.move(to: p(396, 340))
        tail.curve(to: p(380, 402), controlPoint1: p(440, 330), controlPoint2: p(444, 404))
        tail.line(to: p(316, 402))
        tail.lineWidth = 34 * scale
        tail.lineCapStyle = .round
        tail.stroke()

        // 闭着的眼睛：从身体上镂空两道弧（SVG 的二次曲线换成三次）
        NSGraphicsContext.current?.compositingOperation = .destinationOut
        for (start, end) in [(CGFloat(160), CGFloat(194)), (CGFloat(214), CGFloat(248))] {
            let mid = (start + end) / 2
            let eye = NSBezierPath()
            eye.move(to: p(start, 296))
            eye.curve(to: p(end, 296), controlPoint1: p(start + (mid - start) * 2 / 3, 296 + 18 * 2 / 3),
                      controlPoint2: p(end - (end - mid) * 2 / 3, 296 + 18 * 2 / 3))
            eye.lineWidth = 1.3
            eye.lineCapStyle = .round
            eye.stroke()
        }
        NSGraphicsContext.current?.compositingOperation = .sourceOver
    }
}

import CoreGraphics
import Foundation

let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
for (index, window) in windows.enumerated() {
    let owner = window[kCGWindowOwnerName as String] as? String ?? ""
    if owner == "kura-board-native-spike" || owner == "Kura Native Spike" || owner == "Calculator" || owner == "計算機" {
        print("order=\(index) owner=\(owner) id=\(window[kCGWindowNumber as String]!) alpha=\(window[kCGWindowAlpha as String]!) layer=\(window[kCGWindowLayer as String]!) bounds=\(window[kCGWindowBounds as String]!)")
    }
}

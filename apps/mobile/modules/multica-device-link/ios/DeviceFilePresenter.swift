import Foundation
import UIKit
import QuickLook

final class DeviceFilePresenter: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
  private let file: URL
  var onDismiss: (() -> Void)?
  init(file: URL) { self.file = file }
  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { file as NSURL }
  func previewControllerDidDismiss(_ controller: QLPreviewController) { onDismiss?() }

  @MainActor static func currentController() -> UIViewController? {
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
    var controller = scene?.windows.first { $0.isKeyWindow }?.rootViewController
    while let presented = controller?.presentedViewController { controller = presented }
    return controller
  }
}

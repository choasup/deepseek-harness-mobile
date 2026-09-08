import AVFoundation
import UIKit

/// 让 agent 能调起相机。
///
/// ## 为什么归一化在原生侧做
///
/// 拍出来是 4800 万像素的 HEIC，直接塞给模型既超尺寸又浪费带宽。缩放和编码
/// 在这里用 ImageIO 完成（硬件加速、降采样解码，不会把全尺寸解进内存），
/// Node 侧拿到的已经是可以直接入附件的 JPEG。
///
/// 这也正是 sharp 在 iOS 上用不了之后的正解：不是把 libvips 弄上 iOS，
/// 而是用手机本来就更擅长的那套 API。
///
/// ## 用户始终握着否决权
///
/// 相机由系统 UI 呈现，用户可以取消；取消返回 409，Node 侧把它翻译成一句
/// 明确的"用户取消了拍照"给模型，而不是当成错误重试。
/// 这是有意的：agent 可以**请求**看一眼，但按不按快门是人的事。
@MainActor
final class CameraBridge: NSObject {
    static let shared = CameraBridge()
    // UIImagePickerControllerDelegate 继承 NSObjectProtocol，所以这个类必须是
    // NSObject 的子类——Swift 不允许直接声明遵循 NSObjectProtocol。
    private override init() { super.init() }

    /// 长边上限。1568 是多数视觉模型的常见输入上限，再大只是浪费。
    private static let maxDimension = 1568
    private static let jpegQuality = 0.8

    private var pending: ((Result<Data, CameraError>) -> Void)?
    private var picker: UIImagePickerController?

    enum CameraError: Error {
        case unavailable(String)
        case denied
        case cancelled
        case failed(String)
    }

    /// 拍一张，返回归一化后的 JPEG。**必须在主线程调用。**
    func capture(_ completion: @escaping (Result<Data, CameraError>) -> Void) {
        guard pending == nil else {
            completion(.failure(.failed("已有一次拍照在进行中")))
            return
        }
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            completion(.failure(.unavailable("这台设备没有可用的相机")))
            return
        }

        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            present(completion)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                Task { @MainActor in
                    granted ? self.present(completion) : completion(.failure(.denied))
                }
            }
        default:
            completion(.failure(.denied))
        }
    }

    private func present(_ completion: @escaping (Result<Data, CameraError>) -> Void) {
        guard let root = UIApplication.shared.connectedScenes
            .compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController })
            .first
        else {
            completion(.failure(.failed("找不到可用于呈现的窗口")))
            return
        }
        pending = completion
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = self
        picker.modalPresentationStyle = .fullScreen
        self.picker = picker
        root.present(picker, animated: true)
    }

    private func finish(_ result: Result<Data, CameraError>) {
        let done = pending
        pending = nil
        picker = nil
        done?(result)
    }
}

extension CameraBridge: UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    func imagePickerController(
        _ picker: UIImagePickerController,
        didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
        picker.dismiss(animated: true)
        guard let image = info[.originalImage] as? UIImage,
              // 先按原样编码一次，再交给 ImageOps 走统一的缩放/编码路径——
              // 与"用户从相册选图"走同一条，避免两条路径产出不同的结果。
              let raw = image.jpegData(compressionQuality: 1.0)
        else {
            finish(.failure(.failed("没能从相机拿到图像")))
            return
        }
        let response = ImageOps.normalize(
            raw,
            maxDim: Self.maxDimension,
            quality: Self.jpegQuality,
            format: "jpeg",
        )
        guard response.status == 200 else {
            finish(.failure(.failed("图像归一化失败")))
            return
        }
        finish(.success(response.body))
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        finish(.failure(.cancelled))
    }
}

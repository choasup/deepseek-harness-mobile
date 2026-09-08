import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// 图像处理的原生实现，顶替 iOS 上用不了的 sharp。
///
/// sharp 是 libvips 的绑定——原生模块，iOS 上 dlopen 不了（WASM 变体也不行，
/// jitless 关掉了 WebAssembly）。而手机本来就有更合适的东西：ImageIO 读元数据
/// 不解码整张图，CoreGraphics 缩放是硬件加速的。
///
/// 这里只实现 dsh 的附件服务**实际用到**的那一小块（查过它的调用点）：
/// 取元数据、缩放、重新编码、EXIF 方向校正。不做 sharp 的完整 API。
enum ImageOps {
    /// 读元数据，**不解码像素**。
    ///
    /// 用 `CGImageSourceCopyPropertiesAtIndex` 而不是先 `UIImage(data:)`——
    /// 后者会把整张图解进内存，手机拍的 4800 万像素照片能吃掉几百 MB。
    static func metadata(_ data: Data) -> BridgeResponse {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        else { return .error("无法解析图像", status: 415) }

        let width = props[kCGImagePropertyPixelWidth] as? Int ?? 0
        let height = props[kCGImagePropertyPixelHeight] as? Int ?? 0
        // EXIF 方向 5–8 表示图像被旋转了 90°，宽高要对调才是"看起来"的尺寸。
        let orientation = props[kCGImagePropertyOrientation] as? Int ?? 1
        let swapped = orientation >= 5

        let type = CGImageSourceGetType(source) as String?
        return .json([
            "format": type.flatMap { shortFormat($0) } ?? "unknown",
            "width": swapped ? height : width,
            "height": swapped ? width : height,
            "orientation": orientation,
            "hasAlpha": props[kCGImagePropertyHasAlpha] as? Bool ?? false,
        ])
    }

    /// 缩放 + 重新编码。`maxDim` 是长边上限，0 表示不缩放。
    ///
    /// 用 `kCGImageSourceCreateThumbnailFromImageAlways` 做缩放：它在解码阶段
    /// 就降采样，不会先解出全尺寸再缩——这是手机上处理大照片的关键，否则内存
    /// 峰值会把 app 顶掉。`kCGImageSourceCreateThumbnailWithTransform` 顺带
    /// 应用 EXIF 方向，省掉单独一步旋转。
    static func normalize(_ data: Data, maxDim: Int, quality: Double, format: String) -> BridgeResponse {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            return .error("无法解析图像", status: 415)
        }

        var options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        if maxDim > 0 {
            options[kCGImageSourceCreateThumbnailFromImageAlways] = true
            options[kCGImageSourceThumbnailMaxPixelSize] = maxDim
        } else {
            options[kCGImageSourceCreateThumbnailFromImageIfAbsent] = true
        }

        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return .error("缩放失败", status: 500)
        }

        let utType: UTType = format == "png" ? .png : .jpeg
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, utType.identifier as CFString, 1, nil) else {
            return .error("无法创建编码器", status: 500)
        }
        CGImageDestinationAddImage(dest, cg, [
            kCGImageDestinationLossyCompressionQuality: quality,
        ] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return .error("编码失败", status: 500) }

        var response = BridgeResponse(status: 200, body: out as Data)
        response.contentType = format == "png" ? "image/png" : "image/jpeg"
        return response
    }

    private static func shortFormat(_ uti: String) -> String? {
        switch uti {
        case UTType.jpeg.identifier: return "jpeg"
        case UTType.png.identifier: return "png"
        case UTType.webP.identifier: return "webp"
        case UTType.gif.identifier: return "gif"
        case UTType.heic.identifier, "public.heic": return "heic"
        default: return nil
        }
    }
}

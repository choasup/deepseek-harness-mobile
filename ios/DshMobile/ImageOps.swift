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
/// ## 这里的"契约"比想象中严格
///
/// dsh 的附件服务不只是调用 sharp，它还**校验 sharp 的输出**：
/// `verifyNormalizedImage` 会重新解码刚编码出来的字节，逐项比对
/// media type、宽、高、`depth === "uchar"`、`space === "srgb"`、单帧、
/// 以及"不携带元数据"。任何一项对不上，抛的都是同一句
/// "Unsupported or malformed image data" / "did not produce ... matching
/// metadata"——**完全不说是哪一项**。
///
/// 所以这里的元数据字段不是"顺手多报几个"，是硬要求：
/// 少报 `depth`/`space` 会让 `undefined !== "uchar"` 直接判负；多报
/// `orientation` 会被判成"携带元数据"同样判负。相机连续失败的根因就在这里。
enum ImageOps {
    // MARK: - 能力探测

    /// ImageIO 能**写**的格式。iOS 能读 WebP 但写不了，这个集合是唯一的事实来源。
    private static let destinationTypes: Set<String> = {
        Set((CGImageDestinationCopyTypeIdentifiers() as? [String]) ?? [])
    }()

    /// WebP 编码由**随 app 打包的 libwebp** 提供，不靠 ImageIO。
    ///
    /// iOS 的 ImageIO 能读 WebP、写不了（`destinationTypes` 里没有它），
    /// 而 dsh 对带透明通道的图只提供 WebP 这一条编码路径。见 WebP/dsh_webp.h。
    static let supportsWebP = true

    static func capabilities() -> BridgeResponse {
        .json([
            "webp": supportsWebP,
            // ImageIO 自己能写什么也一并报出来：出问题时这是判断"是系统变了
            // 还是我们变了"的唯一依据。
            "imageIODestinationTypes": Array(destinationTypes).sorted(),
        ])
    }

    // MARK: - 元数据

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
        // 这里就把它对调好，**并且不把 orientation 报给上游**：原生侧的缩放
        // 一律带 `WithTransform`，方向已经烘进像素里了。再报一次会让上游又转
        // 一遍，宽高对不上后续的自校验。
        let orientation = props[kCGImagePropertyOrientation] as? Int ?? 1
        let swapped = orientation >= 5

        let type = CGImageSourceGetType(source) as String?
        return .json([
            "format": type.flatMap { shortFormat($0) } ?? "unknown",
            // 原始 UTI 一并回传：格式识别不出时，"unknown" 本身说明不了任何
            // 问题，而附件服务的报错（"Unsupported or malformed image data"）
            // 更是只字不提格式。有这个字段才有排查的起点。
            "uti": type ?? "",
            "width": swapped ? height : width,
            "height": swapped ? width : height,
            "orientation": orientation,
            "hasAlpha": props[kCGImagePropertyHasAlpha] as? Bool ?? false,
            "depth": depthName(props),
            "space": spaceName(props),
            "pages": CGImageSourceGetCount(source),
            // "是否携带用户/设备元数据"，不是"是否有 Exif 字典"——
            // 见 carriesUserMetadata 的说明。
            "carriesMetadata": carriesUserMetadata(props),
        ])
    }

    /// sharp/libvips 的 `depth` 命名。附件服务要求归一化结果是 `"uchar"`。
    private static func depthName(_ props: [CFString: Any]) -> String {
        switch props[kCGImagePropertyDepth] as? Int ?? 8 {
        case 16: return "ushort"
        case 32: return "float"
        default: return "uchar"
        }
    }

    /// sharp/libvips 的 `space` 命名。
    ///
    /// libvips 会把带 ICC 的 RGB 图一律报成 `srgb`（色彩管理是解码后的事），
    /// 这里跟它保持一致：Display P3 的照片同样报 `srgb`，因为归一化路径最终
    /// 会把它渲染进 sRGB 上下文。
    private static func spaceName(_ props: [CFString: Any]) -> String {
        let model = props[kCGImagePropertyColorModel] as? String
        if model == (kCGImagePropertyColorModelCMYK as String) { return "cmyk" }
        if model == (kCGImagePropertyColorModelGray as String) {
            return (props[kCGImagePropertyDepth] as? Int ?? 8) > 8 ? "grey16" : "b-w"
        }
        return (props[kCGImagePropertyDepth] as? Int ?? 8) > 8 ? "rgb16" : "srgb"
    }

    /// 是否携带**用户或设备**元数据（相机型号、时间、GPS、图注……）。
    ///
    /// 不能简单地判断"有没有 `{Exif}` 字典"：ImageIO 写出来的每一张 JPEG/PNG
    /// 都自带一个只含 `ColorSpace` + `PixelXDimension/YDimension` 的 Exif 字典，
    /// 和一个 `ProfileName = sRGB`。照"有字典就算携带"来报，**我们自己编码的
    /// 结果永远通不过上游的自校验**，附件功能一张图也存不进去。
    ///
    /// 反过来也不能一律报 false：报 false 会让相机原图"原样直存"，
    /// 连 GPS 一起落盘。所以判据是"有没有**实质**标签"。
    private static func carriesUserMetadata(_ props: [CFString: Any]) -> Bool {
        if props[kCGImagePropertyGPSDictionary] != nil { return true }
        if props[kCGImagePropertyIPTCDictionary] != nil { return true }
        if let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any] {
            let trivial: Set<String> = [
                kCGImagePropertyExifColorSpace as String,
                kCGImagePropertyExifPixelXDimension as String,
                kCGImagePropertyExifPixelYDimension as String,
            ]
            if exif.keys.contains(where: { !trivial.contains($0 as String) }) { return true }
        }
        if let tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any] {
            let trivial: Set<String> = [
                kCGImagePropertyTIFFXResolution as String,
                kCGImagePropertyTIFFYResolution as String,
                kCGImagePropertyTIFFResolutionUnit as String,
                kCGImagePropertyTIFFOrientation as String,
                kCGImagePropertyTIFFCompression as String,
                kCGImagePropertyTIFFPhotometricInterpretation as String,
            ]
            if tiff.keys.contains(where: { !trivial.contains($0 as String) }) { return true }
        }
        return false
    }

    // MARK: - 归一化编码

    /// 缩放 + 重新编码，输出**保证是 8 位 sRGB、不带用户元数据**的图。
    ///
    /// `maxDim` 是长边上限，0 表示不缩放。
    ///
    /// 缩放用 `kCGImageSourceCreateThumbnailFromImageAlways`：它在解码阶段就
    /// 降采样，不会先解出全尺寸再缩——这是手机上处理大照片的关键，否则内存
    /// 峰值会把 app 顶掉。`kCGImageSourceCreateThumbnailWithTransform` 顺带
    /// 应用 EXIF 方向，省掉单独一步旋转。
    ///
    /// 缩放之后**必须再画进一个 sRGB 上下文**，不能直接把缩略图交给编码器：
    /// iPhone 的照片多半是 Display P3，直接编码出来的色彩空间就不是 sRGB，
    /// 而上游会逐项校验 `space === "srgb"`。这一步同时把 EXIF 甩掉。
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

        guard let scaled = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return .error("缩放失败", status: 500)
        }

        // JPEG 没有透明通道：把透明区域压到白底，而不是交给编码器变成黑块。
        // 白名单而不是 `!= "jpeg"`：未知的 format 走 JPEG 分支，别让它带着
        // 透明通道进一个不支持透明的编码器。
        let keepAlpha = (format == "png" || format == "webp") && scaled.hasAlphaChannel
        guard let canvas = renderSRGB(scaled, keepAlpha: keepAlpha) else {
            return .error("无法转换到 sRGB", status: 500)
        }

        if format == "webp" {
            guard let encoded = encodeWebP(canvas, hasAlpha: keepAlpha, quality: quality) else {
                return .error("WebP 编码失败", status: 500)
            }
            var response = BridgeResponse(status: 200, body: encoded)
            response.contentType = "image/webp"
            return response
        }

        guard let flattened = canvas.context.makeImage() else {
            return .error("无法取出 sRGB 位图", status: 500)
        }
        let utType: UTType = format == "png" ? .png : .jpeg
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, utType.identifier as CFString, 1, nil) else {
            return .error("无法创建编码器", status: 500)
        }
        CGImageDestinationAddImage(dest, flattened, [
            kCGImageDestinationLossyCompressionQuality: quality,
        ] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return .error("编码失败", status: 500) }

        var response = BridgeResponse(status: 200, body: out as Data)
        response.contentType = format == "png" ? "image/png" : "image/jpeg"
        return response
    }

    /// 一块 sRGB 的 RGBA8 画布。持有 context 是为了既能取 CGImage，也能直接
    /// 读到像素字节——libwebp 要的是后者。
    private struct Canvas {
        let context: CGContext
        let pixels: UnsafeMutableRawPointer
        let width: Int
        let height: Int
        var stride: Int { width * 4 }
    }

    /// 把任意色彩空间的图重画进 sRGB。透明通道按需保留或压白底。
    private static func renderSRGB(_ image: CGImage, keepAlpha: Bool) -> Canvas? {
        let width = image.width, height = image.height
        guard width > 0, height > 0, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let alphaInfo: CGImageAlphaInfo = keepAlpha ? .premultipliedLast : .noneSkipLast
        guard let ctx = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: space,
            bitmapInfo: alphaInfo.rawValue,
        ), let pixels = ctx.data else { return nil }
        let rect = CGRect(x: 0, y: 0, width: width, height: height)
        if !keepAlpha {
            ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
            ctx.fill(rect)
        }
        ctx.draw(image, in: rect)
        return Canvas(context: ctx, pixels: pixels, width: width, height: height)
    }

    /// 用随包的 libwebp 编码。
    ///
    /// CGBitmapContext 只能给**预乘**的 RGBA（8 位非预乘建不出上下文），
    /// 而 WebP 要的是非预乘——不还原回去，半透明区域会整片发暗。
    private static func encodeWebP(_ canvas: Canvas, hasAlpha: Bool, quality: Double) -> Data? {
        let count = canvas.stride * canvas.height
        let bytes = canvas.pixels.bindMemory(to: UInt8.self, capacity: count)
        if hasAlpha {
            for offset in stride(from: 0, to: count, by: 4) {
                let alpha = bytes[offset + 3]
                guard alpha > 0, alpha < 255 else { continue }
                for channel in 0..<3 {
                    bytes[offset + channel] =
                        UInt8(min(255, Int(bytes[offset + channel]) * 255 / Int(alpha)))
                }
            }
        }

        var out: UnsafeMutablePointer<UInt8>?
        let size = dsh_webp_encode_rgba(
            bytes,
            Int32(canvas.width),
            Int32(canvas.height),
            Int32(canvas.stride),
            hasAlpha ? 1 : 0,
            Float(quality * 100),
            &out,
        )
        guard size > 0, let out else { return nil }
        defer { dsh_webp_free(out) }
        return Data(bytes: out, count: size)
    }

    // MARK: - 原始像素

    /// 解码成 RGBA8 原始像素。
    ///
    /// 附件服务用它统计颜色数（`hasLowColourCount`）来判断是否该用 PNG——
    /// sharp 里对应 `.raw().toBuffer({ resolveWithObject: true })`。
    /// 这条路径**每次存图都会走**，缺了它整个附件功能就是坏的，而错误
    /// 会被上游换成一句与真因无关的 "Unsupported or malformed image data"。
    ///
    /// 采样尺寸很小（附件服务传的是几十像素），所以直接解到位图不必担心内存。
    static func raw(_ data: Data, maxDim: Int, nearest: Bool) -> BridgeResponse {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            return .error("无法解析图像", status: 415)
        }
        // 采样用最近邻时**不能直接把解码降到目标尺寸**：ImageIO 的降采样是
        // 平滑重采样，把 2100px 的噪声压到 128px 会平均成一片灰，
        // 调用方数出来的"颜色数"就成了个位数，于是照片被判成"少色截图"、
        // 用 PNG 编码——一张 280KB 的 JPEG 变成 1.2MB 的 PNG。
        //
        // 所以先解到一个**有界的中间尺寸**，再用最近邻画到目标尺寸。
        // 2048 是归一化的长边上限，再大也没人要。
        let decodeCap = maxDim <= 0 ? 0 : (nearest ? max(maxDim, 2048) : maxDim)
        var options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        if decodeCap > 0 { options[kCGImageSourceThumbnailMaxPixelSize] = decodeCap }
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return .error("解码失败", status: 500)
        }

        // 目标尺寸：长边不超过 maxDim，保持长宽比（与 sharp 的
        // `fit: "inside", withoutEnlargement: true` 一致）。
        var width = cg.width, height = cg.height
        if maxDim > 0, max(width, height) > maxDim {
            let scale = Double(maxDim) / Double(max(width, height))
            width = max(1, Int((Double(cg.width) * scale).rounded()))
            height = max(1, Int((Double(cg.height) * scale).rounded()))
        }

        let channels = 4
        let keepAlpha = cg.hasAlphaChannel
        var pixels = [UInt8](repeating: 0, count: width * height * channels)
        guard let ctx = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * channels,
            space: CGColorSpaceCreateDeviceRGB(),
            // 有透明通道就保留它：调用方数的是"颜色种类"，把 alpha 一律抹成
            // 不透明会让半透明区域看起来只有一种颜色，分类就偏了。
            //
            // 这里是**预乘**的 —— CGBitmapContext 不支持 8 位非预乘 RGBA
            // （`kCGImageAlphaLast` 建不出上下文）。sharp 给的是非预乘，
            // 所以半透明像素的 RGB 值与 sharp 不完全一致。影响仅限于
            // "颜色数是否 ≤256" 这个**启发式分类**，不影响任何一张图的正确性。
            bitmapInfo: (keepAlpha ? CGImageAlphaInfo.premultipliedLast : .noneSkipLast).rawValue,
        ) else { return .error("无法创建位图上下文", status: 500) }
        if nearest { ctx.interpolationQuality = .none }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))

        return BridgeResponse(
            status: 200,
            body: Data(pixels),
            headers: [
                "X-Image-Width": String(width),
                "X-Image-Height": String(height),
                "X-Image-Channels": String(channels),
            ],
        )
    }

    /// UTI → 短格式名。
    ///
    /// **按类型符合性判断，不做字符串精确比对**：系统可能返回子类型
    /// （比如某些相机产出的 JPEG 会报成更具体的 UTI），精确比对会漏掉它们，
    /// 而漏掉的后果是附件服务抛 "Unsupported or malformed image data"
    /// ——一句完全不提格式的错误。
    private static func shortFormat(_ uti: String) -> String? {
        guard let type = UTType(uti) else { return nil }
        if type.conforms(to: .jpeg) { return "jpeg" }
        if type.conforms(to: .png) { return "png" }
        if type.conforms(to: .webP) { return "webp" }
        if type.conforms(to: .gif) { return "gif" }
        if type.conforms(to: .heic) || type.conforms(to: .heif) { return "heic" }
        return nil
    }
}

private extension CGImage {
    var hasAlphaChannel: Bool {
        switch alphaInfo {
        case .none, .noneSkipFirst, .noneSkipLast: return false
        default: return true
        }
    }
}

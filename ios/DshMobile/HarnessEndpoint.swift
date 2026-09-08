import Foundation

/// dsh host 的地址。
///
/// **设备内 runtime 落地时，要改的就是这一个文件。** 那之后地址是 app 自己那个
/// Node 线程监听的随机 loopback 端口，不再需要用户输入，这个类型退化成一个常量。
///
/// 在那之前地址必须可配置，而且必须**在设备上**可配置：真机没有启动参数可传，
/// 每个人的 Mac 局域网地址也不一样。所以存在 UserDefaults 里，由设置界面写。
enum HarnessEndpoint {
    private static let key = "HarnessURL"

    /// **设备内 runtime 已就位**：默认就是 app 自己那个 Node 线程监听的
    /// loopback 端口，不需要 Mac、不需要局域网、不需要填地址。
    ///
    /// 手填地址的入口保留着（摇一摇 / `dshmobile://settings`），因为它仍然有用：
    /// 开发时可以把界面指向 Mac 上跑的 host，省掉重新打包 315MB 的 app。
    static let fallback = URL(string: "http://127.0.0.1:\(NodeHost.port)")!

    static var current: URL {
        // 启动参数优先，便于在 Xcode / xcrun 里指定而不动持久化的值。
        if let raw = UserDefaults.standard.string(forKey: key),
           let url = normalize(raw) {
            return url
        }
        return fallback
    }

    static func set(_ raw: String) -> URL? {
        guard let url = normalize(raw) else { return nil }
        UserDefaults.standard.set(url.absoluteString, forKey: key)
        return url
    }

    /// 容忍用户少打协议头（"192.168.1.9:7799"）和多余空白——手机上打字容易出错，
    /// 而"没写 http://"是这里最常见的一种。
    static func normalize(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "http://" + text }
        guard let url = URL(string: text), let host = url.host, !host.isEmpty else { return nil }
        guard url.scheme == "http" || url.scheme == "https" else { return nil }
        return url
    }
}

import Foundation

/// dsh host 的地址。
///
/// **正常路径是设备内 runtime**：`NodeHost` 在 app 自己的线程上跑，端口是
/// `NodeHost.port`。用户不需要知道它，更不需要填。
///
/// 覆盖值只为开发保留（把界面指向 Mac 上的 host，省掉重新打包 300MB）。
/// 但覆盖值**必须绑定到具体构建**——见 `storedOverride` 的说明。
enum HarnessEndpoint {
    private static let urlKey = "HarnessURL"
    private static let buildKey = "HarnessURLBuild"

    /// 设备内 runtime 的地址。这是默认，也是绝大多数情况下的实际地址。
    static var embedded: URL { URL(string: "http://127.0.0.1:\(NodeHost.port)")! }

    static var current: URL { storedOverride ?? embedded }

    /// 是否正在使用开发覆盖值（设置界面据此提示）。
    static var isOverridden: Bool { storedOverride != nil }

    /// 读取覆盖值，**并且只在它属于当前构建时才认**。
    ///
    /// 踩过一次，症状极难看出来：早期版本（runtime 还在 Mac 上时）把
    /// `127.0.0.1:7799` 存进了 UserDefaults。后来 runtime 搬进设备、端口改成
    /// 47799，而那个陈旧值**静默盖过了新默认值**——app 一直在探测一个没人监听的
    /// 端口，界面显示"dsh 没能启动"，而 host 日志里明明写着它已经起来了。
    ///
    /// 所以覆盖值连同写入时的构建号一起存；构建号对不上就丢弃。
    /// 升级换了端口、换了运行形态时，旧值不会跟着传下去。
    private static var storedOverride: URL? {
        let defaults = UserDefaults.standard
        guard let raw = defaults.string(forKey: urlKey) else { return nil }
        guard defaults.string(forKey: buildKey) == currentBuild else {
            // 属于别的构建，丢弃。
            defaults.removeObject(forKey: urlKey)
            defaults.removeObject(forKey: buildKey)
            return nil
        }
        return normalize(raw)
    }

    private static var currentBuild: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(version)-\(build)"
    }

    @discardableResult
    static func setOverride(_ raw: String) -> URL? {
        guard let url = normalize(raw) else { return nil }
        UserDefaults.standard.set(url.absoluteString, forKey: urlKey)
        UserDefaults.standard.set(currentBuild, forKey: buildKey)
        return url
    }

    /// 回到设备内 runtime。
    static func clearOverride() {
        UserDefaults.standard.removeObject(forKey: urlKey)
        UserDefaults.standard.removeObject(forKey: buildKey)
    }

    /// 容忍少打协议头（"192.168.1.9:7799"）和多余空白——手机上打字容易出错。
    static func normalize(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "http://" + text }
        guard let url = URL(string: text), let host = url.host, !host.isEmpty else { return nil }
        guard url.scheme == "http" || url.scheme == "https" else { return nil }
        return url
    }
}

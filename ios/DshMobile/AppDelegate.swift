import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = HarnessViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }

    /// `dshmobile://settings` 打开连接设置，`?url=` 可直接填好地址。
    ///
    /// 摇一摇是给人用的入口，这个是给**别的东西**用的：
    /// - 可以在没有 UI 自动化的情况下验证（`xcrun simctl openurl`）；
    /// - 手机上界面卡在一个错误页时，从备忘录里点一条链接就能回到设置；
    /// - 以后扫码配机器（v2）落地时，正好是同一条入口。
    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        guard url.scheme == "dshmobile", url.host == "settings" else { return false }
        guard let harness = window?.rootViewController as? HarnessViewController else { return false }
        let preset = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "url" })?.value
        harness.openSettings(preset: preset)
        return true
    }
}

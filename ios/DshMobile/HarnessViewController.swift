import UIKit
import WebKit

/// 承载 dsh 客户端的外壳。
///
/// ## 现在这一版连的是哪儿
///
/// Mac 上跑的 `dsh --profile mobile-web`。模拟器与宿主共享网络栈，所以默认的
/// `127.0.0.1` 直达 Mac；**真机上那是手机自己**，必须填 Mac 的局域网地址，
/// 由 `EndpointSettingsViewController` 在设备上输入（连不上时自动弹出，
/// 平时摇一摇也能叫出来）。
///
/// ## 为什么先做成这样
///
/// 最终形态是 runtime 跑在设备内（见仓库 `docs/superpowers/specs/`）：一个
/// jitless 的 Node 24 在后台线程里跑 dsh 的 host，这个 WebView 加载
/// `http://127.0.0.1:<随机端口>`。那一步卡在把 Node 交叉编译到 iOS，是独立的
/// 一大块工程。
///
/// **但连接方式对这一层是可替换的**：无论 host 在 Mac 上还是在 app 内的
/// Node 线程里，WebView 面对的都是同一个 loopback HTTP + WebSocket 端点，
/// 加载的也是同一份 `dsh-web-frontend`。所以换过去时改的是
/// `HarnessEndpoint.current`，不是这个文件的其余部分。
final class HarnessViewController: UIViewController {
    private var webView: WKWebView!
    private let statusLabel = UILabel()
    private let retryButton = UIButton(type: .system)
    private let settingsButton = UIButton(type: .system)
    /// 只主动弹一次设置，之后由用户点"改地址"或摇一摇——
    /// 否则重试失败会把设置界面反复推上来，连"重试"都点不着。
    private var hasOfferedSettings = false
    /// 这一版是否带了设备内 runtime。影响连不上时的提示措辞——
    /// "host 还没起来" 和 "Mac 上没开 host" 是两回事，混在一起会让人查错方向。
    private var hasEmbeddedRuntime = false

    /// 摇一摇叫出连接设置。真机上这是**已经连上之后**改地址的唯一入口——
    /// 界面整个被 WebView 占满，没有别的地方放这个入口；而换 Mac、换网段
    /// 之后必然要改。
    override var canBecomeFirstResponder: Bool { true }

    override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        guard motion == .motionShake else { return }
        presentSettings()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let config = WKWebViewConfiguration()
        // dsh 的客户端要用 localStorage 记住 UI 状态，也要 WebSocket 收下行事件。
        config.websiteDataStore = .default()
        // 让 web 端的 viewport 元信息生效，否则在手机屏上会按桌面宽度渲染。
        config.defaultWebpagePreferences.preferredContentMode = .mobile

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        // 键盘弹出时不要把内容顶飞；dsh 的输入框在底部。
        webView.scrollView.keyboardDismissMode = .interactive
        view.addSubview(webView)

        statusLabel.numberOfLines = 0
        statusLabel.textAlignment = .center
        statusLabel.textColor = .secondaryLabel
        statusLabel.font = .preferredFont(forTextStyle: .callout)
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(statusLabel)

        retryButton.setTitle("重试", for: .normal)
        retryButton.addTarget(self, action: #selector(load), for: .touchUpInside)
        retryButton.translatesAutoresizingMaskIntoConstraints = false
        retryButton.isHidden = true
        view.addSubview(retryButton)

        settingsButton.setTitle("改地址", for: .normal)
        settingsButton.addTarget(self, action: #selector(presentSettings), for: .touchUpInside)
        settingsButton.translatesAutoresizingMaskIntoConstraints = false
        settingsButton.isHidden = true
        view.addSubview(settingsButton)

        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            statusLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            statusLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            statusLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            statusLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),

            retryButton.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 16),
            retryButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),

            settingsButton.topAnchor.constraint(equalTo: retryButton.bottomAnchor, constant: 8),
            settingsButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            settingsButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])

        // 设备内 runtime 的最小验证：先确认 Node 能起来，再谈别的。
        // 结果写进 Documents，用 devicectl 取回。
        // 设备内 runtime：在后台线程上起 dsh 的 host，监听 app 自己的 loopback。
        // 返回 false 表示这一版没带 Node 侧代码（打包问题），此时才回落到
        // 手填地址那条路。
        hasEmbeddedRuntime = NodeHost.startIfAvailable()

        load()
    }

    @objc private func load() {
        retryButton.isHidden = true
        settingsButton.isHidden = true
        statusLabel.text = "正在连接 \(HarnessEndpoint.current.absoluteString)…"
        webView.isHidden = true
        webView.load(URLRequest(url: HarnessEndpoint.current))
    }

    @objc private func presentSettings() {
        openSettings(preset: nil)
    }

    /// `preset` 非空时预填地址（来自 `dshmobile://settings?url=…`）。
    func openSettings(preset: String?) {
        guard presentedViewController == nil else { return }
        let settings = EndpointSettingsViewController()
        settings.preset = preset
        settings.onConnect = { [weak self] _ in self?.load() }
        present(settings, animated: true)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        becomeFirstResponder()
    }
}

extension HarnessViewController: WKNavigationDelegate {
    /// 只有网络错误是不够的：在有 HTTP 代理的网络里，连不通的地址不会报错，
    /// 代理会替它返回一个自己的错误页（实测：公司网络对一个不可达 IP 返回
    /// 502 的 IT 提示页）。那样 `didFail` 根本不触发，app 以为加载成功，
    /// 用户看到的是一张跟 dsh 毫无关系的页面，而且没有入口回到设置。
    /// 所以这里按状态码判：非 2xx 一律当失败处理。
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        guard navigationResponse.isForMainFrame,
              let http = navigationResponse.response as? HTTPURLResponse,
              !(200...299).contains(http.statusCode)
        else {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        showFailure(HarnessLoadError.badStatus(http.statusCode))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        statusLabel.text = nil
        retryButton.isHidden = true
        webView.isHidden = false
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showFailure(error)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        showFailure(error)
    }

    /// 连不上时说清楚**该去查什么**，而不是只显示一个 NSError。
    /// 这一层最常见的失败就是 Mac 上的 host 没在跑，报错本身看不出这一点。
    /// 取消导航会让 WebKit 再报一次 `didFailProvisionalNavigation`
    /// （NSURLErrorCancelled）。那条是我们自己造成的，把它盖在真正的原因上
    /// 只会误导——所以忽略。
    private func isSelfInflictedCancel(_ error: Error) -> Bool {
        let ns = error as NSError
        return ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled
    }

    private func showFailure(_ error: Error) {
        if isSelfInflictedCancel(error) { return }
        webView.isHidden = true
        retryButton.isHidden = false
        settingsButton.isHidden = false
        statusLabel.text = """
        连不上 \(HarnessEndpoint.current.absoluteString)

        \(error.localizedDescription)

        \(hasEmbeddedRuntime
          ? "设备内的 dsh 还没起来。它在后台线程启动，冷启动要几秒——先点重试。"
          : "这一版没带设备内 runtime，得填 Mac 上 host 的局域网地址。")

        （想改地址：摇一摇，或打开 dshmobile://settings）
        """

        // 首次失败直接把设置推到脸上：真机上这一步是必然会遇到的，
        // 让用户自己去猜"该点哪"没有意义。
        if !hasOfferedSettings {
            hasOfferedSettings = true
            presentSettings()
        }
    }
}

/// 加载失败的原因里，有一类不是 URLSession 报的错，而是我们自己判定的。
enum HarnessLoadError: LocalizedError {
    /// 服务器答了，但不是 2xx——多半是代理的错误页，不是 dsh。
    case badStatus(Int)

    var errorDescription: String? {
        switch self {
        case let .badStatus(code):
            return "服务器返回 HTTP \(code)，不是 dsh 的页面（多半是网络里的代理替它答的）。"
        }
    }
}

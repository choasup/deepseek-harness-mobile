import UIKit
import WebKit

/// 承载 dsh 的外壳。
///
/// ## 这一层对用户呈现什么
///
/// **不呈现"连接"。** runtime 就在这个 app 里：`NodeHost` 在后台线程上跑
/// Node，dsh 的 host 监听 app 自己的 loopback。用户不需要知道端口，
/// 更不该被要求填地址——那是实现细节。
///
/// 所以界面只有三种状态：
///
///   启动中 —— host 冷启动要几秒（jitless 下更慢）。这是**正常过程**，
///            不是错误，所以显示的是启动画面而不是"连不上"。
///   正常   —— WebView 铺满，外壳完全隐身。
///   失败   —— 显示诊断信息（含 host 日志尾部），而不是让用户去猜地址。
///
/// 地址覆盖仍然存在，但**只作为开发入口**（`dshmobile://settings`，或摇一摇），
/// 不在正常路径上出现。开发时把界面指向 Mac 上的 host，能省掉重新打包 300MB。
final class HarnessViewController: UIViewController {
    private var webView: WKWebView!
    private let launchView = UIView()
    private let statusLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let detailLabel = UILabel()
    private let retryButton = UIButton(configuration: .tinted())

    /// host 冷启动的等待上限。超过就当失败并给诊断——一直转圈是最差的失败方式。
    private static let startupTimeout: TimeInterval = 60
    private var pollDeadline: Date?

    override var canBecomeFirstResponder: Bool { true }

    /// 摇一摇打开地址覆盖。**开发入口**，不在正常路径上。
    override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        guard motion == .motionShake else { return }
        openSettings(preset: nil)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        setUpWebView()
        setUpLaunchView()

        // 设备内 runtime。返回 false 表示这一版没带 Node 侧代码（打包问题），
        // 那时才需要外部地址。
        let embedded = NodeHost.startIfAvailable()
        pollDeadline = Date().addingTimeInterval(Self.startupTimeout)
        statusLabel.text = embedded ? "正在启动 dsh…" : "正在连接…"
        waitForHostThenLoad()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        becomeFirstResponder()
    }

    private func setUpWebView() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.defaultWebpagePreferences.preferredContentMode = .mobile
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.scrollView.keyboardDismissMode = .interactive
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isHidden = true
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }

    private func setUpLaunchView() {
        statusLabel.font = .preferredFont(forTextStyle: .callout)
        statusLabel.textColor = .secondaryLabel
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0

        detailLabel.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        detailLabel.textColor = .tertiaryLabel
        detailLabel.numberOfLines = 0
        detailLabel.isHidden = true

        retryButton.setTitle("重试", for: .normal)
        retryButton.addTarget(self, action: #selector(retry), for: .touchUpInside)
        retryButton.isHidden = true

        spinner.startAnimating()

        let stack = UIStackView(arrangedSubviews: [spinner, statusLabel, retryButton, detailLabel])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        launchView.addSubview(stack)
        launchView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(launchView)

        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            launchView.topAnchor.constraint(equalTo: view.topAnchor),
            launchView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            launchView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            launchView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: launchView.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -28),
        ])
    }

    /// 轮询本地 host，起来了再加载 WebView。
    ///
    /// 为什么不直接 `webView.load` 让它自己失败重试：那样用户会先看到一个
    /// WebKit 的连接错误页——把"还没启动完"呈现成"出错了"。
    private func waitForHostThenLoad() {
        let url = HarnessEndpoint.current
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        request.timeoutInterval = 3
        request.cachePolicy = .reloadIgnoringLocalCacheData

        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if (response as? HTTPURLResponse) != nil {
                    self.webView.load(URLRequest(url: url))
                    return
                }
                if let deadline = self.pollDeadline, Date() < deadline {
                    // 还在等——保持启动态，不要报错。
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                        self.waitForHostThenLoad()
                    }
                } else {
                    self.showStartupFailure()
                }
            }
        }.resume()
    }

    @objc private func retry() {
        detailLabel.isHidden = true
        retryButton.isHidden = true
        spinner.startAnimating()
        statusLabel.text = "正在启动 dsh…"
        pollDeadline = Date().addingTimeInterval(Self.startupTimeout)
        waitForHostThenLoad()
    }

    /// 失败时给**诊断**，不给地址表单。
    ///
    /// 用户填地址解决不了"设备内 host 没起来"——那是 app 自己的问题。
    /// 把 host 日志的尾部显示出来，才是能推进排查的信息。
    private func showStartupFailure() {
        spinner.stopAnimating()
        retryButton.isHidden = false
        statusLabel.text = "dsh 没能启动"
        detailLabel.isHidden = false
        detailLabel.text = tailOfHostLog() ?? "没有日志输出。"
    }

    private func tailOfHostLog() -> String? {
        guard let text = try? String(contentsOf: NodeHost.hostLogURL, encoding: .utf8) else { return nil }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        return lines.suffix(12).joined(separator: "\n")
    }

    /// 地址覆盖。开发入口，由 `dshmobile://settings` 或摇一摇进入。
    func openSettings(preset: String?) {
        guard presentedViewController == nil else { return }
        let settings = EndpointSettingsViewController()
        settings.preset = preset
        settings.onConnect = { [weak self] _ in self?.retry() }
        present(settings, animated: true)
    }
}

extension HarnessViewController: WKNavigationDelegate {
    /// 只有网络错误是不够的：有 HTTP 代理的网络里，连不通的地址不会报错，
    /// 代理会替它返回自己的错误页（实测公司网络对不可达 IP 返回 502 提示页）。
    /// 那样 `didFail` 根本不触发。按状态码判：非 2xx 一律当失败。
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
        showStartupFailure()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        launchView.isHidden = true
        webView.isHidden = false
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleNavigationFailure(error)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        handleNavigationFailure(error)
    }

    /// 取消导航会让 WebKit 再报一次 NSURLErrorCancelled。那条是我们自己造成的，
    /// 盖在真正的原因上只会误导。
    private func handleNavigationFailure(_ error: Error) {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        showStartupFailure()
    }
}

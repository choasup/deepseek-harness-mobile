import UIKit
import WebKit

/// 承载 dsh 客户端的外壳。
///
/// ## 现在这一版连的是哪儿
///
/// Mac 上跑的 `dsh --profile mobile-web`（loopback）。模拟器与宿主共享网络栈，
/// 所以 `127.0.0.1` 直达 Mac——真机则不行，需要另一套方案。
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
        ])

        load()
    }

    @objc private func load() {
        retryButton.isHidden = true
        statusLabel.text = "正在连接 \(HarnessEndpoint.current.absoluteString)…"
        webView.isHidden = true
        webView.load(URLRequest(url: HarnessEndpoint.current))
    }
}

extension HarnessViewController: WKNavigationDelegate {
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
    private func showFailure(_ error: Error) {
        webView.isHidden = true
        retryButton.isHidden = false
        statusLabel.text = """
        连不上 \(HarnessEndpoint.current.absoluteString)

        \(error.localizedDescription)

        这一版的 runtime 还在 Mac 上。请确认那边跑着：
        dsh --profile mobile-web --port \(HarnessEndpoint.current.port ?? 7799)
        """
    }
}

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
    /// Mac 上 jitless 实测 2 秒就绪；给设备留足余量，但不能无限等。
    /// 放弃探测前等多久。
    ///
    /// **45 秒太短，而且短得很隐蔽。** 设备内启动要装完整棵插件树（80+ 个包），
    /// 冷启动、内存紧张、刚装完包时都会更慢。超时之后外壳报"dsh 没能启动"，
    /// 而 host 日志里 dsh 明明起来了、自检还全绿——排查时最误导的一种组合。
    ///
    /// 这里的取舍：Node 跑在**同一个进程**里，"它最终会起来"是常态而不是赌注，
    /// 所以宁可多等。真起不来时用户看到的仍然是诊断页，只是晚一点。
    private static let startupTimeout: TimeInterval = 180

    /// 超过这个时长仍在等时，把文案换成"还在启动"，让用户知道没卡死。
    private static let slowStartupHint: TimeInterval = 40
    private var pollDeadline: Date?
    /// 本轮探测开始的时刻，用来判断该不该换成"首次启动较慢"的文案。
    private var pollStartedAt: Date?
    /// 最后一次轮询的失败原因。失败时显示出来——不然"连不上"是个黑箱。
    private var lastPollError: String?

    /// 专用于探测本地 host 的 session。
    ///
    /// `connectionProxyDictionary = [:]` 是关键：这台设备所在的网络配了 HTTP
    /// 代理，而 iOS 默认会让 URLSession 走系统代理**连 loopback 也不例外**。
    /// 那样探测请求会被代理接管，永远等不到本机的 host。
    private lazy var probeSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForRequest = 3
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

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

        NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main,
        ) { [weak self] _ in self?.handleWillEnterForeground() }
        pollDeadline = Date().addingTimeInterval(Self.startupTimeout)
        pollStartedAt = Date()
        statusLabel.text = embedded ? "正在启动 dsh…" : "正在连接…"
        waitForHostThenLoad()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        becomeFirstResponder()
    }

    /// 回前台时确认 host 还活着，必要时重新加载。
    ///
    /// iOS 会挂起后台 app：进程被冻结、TCP 连接被系统撕掉。回来之后
    /// WebView 里那个页面还在，但它到 host 的连接已经死了——表现就是
    /// "发不出消息，Load failed"，而页面本身看不出任何异常。
    ///
    /// 拍照尤其容易触发：系统相机是另一个界面，期间 app 很可能被挂起。
    ///
    /// 这里只做一件事：探一下本地 host。通了就重新加载页面（重建连接），
    /// 不通就回到启动态等它起来。**不重启 Node**——它在同一个进程里，
    /// 重启等于重来一遍几十秒的插件树装载。
    private func handleWillEnterForeground() {
        guard !webView.isHidden else { return }   // 还在启动态，自有轮询在管
        var request = URLRequest(url: HarnessEndpoint.current)
        request.httpMethod = "GET"
        request.timeoutInterval = 3
        request.cachePolicy = .reloadIgnoringLocalCacheData
        probeSession.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if (response as? HTTPURLResponse) != nil {
                    // host 还在，但页面的连接可能已断——重新加载最省事，
                    // 也比让用户对着一个发不出消息的界面强。
                    self.webView.reload()
                } else {
                    self.webView.isHidden = true
                    self.launchView.isHidden = false
                    self.retry()
                }
            }
        }.resume()
    }

    private func setUpWebView() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.defaultWebpagePreferences.preferredContentMode = .mobile

        // 触屏点击后 WebKit 会把 :hover **留在**被点的元素上——没有
        // “移开指针”这个动作。桌面版据此显示的悬停提示（“发送消息”那类）
        // 于是赖在屏幕上挡住内容，怎么点都不消失。
        //
        // 用脚本从源头清掉，而不是用 CSS 去猜 tooltip 的类名：dsh 的类名是
        // CSS-module 哈希、每次构建都变，实测那个元素还只在特定条件下入 DOM，
        // 根本没法可靠命中。这段不依赖任何标记结构。
        config.userContentController.addUserScript(WKUserScript(
            source: """
            document.addEventListener('touchend', (event) => {
              // 沿祖先链逐个补发离开事件——hover 状态是逐层附着的。
              let node = event.target
              while (node && node !== document) {
                for (const type of ['pointerleave', 'pointerout', 'mouseleave', 'mouseout']) {
                  const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent
                  node.dispatchEvent(new Ctor(type, { bubbles: false, cancelable: true }))
                }
                node = node.parentElement
              }
            }, { passive: true, capture: true })
            """,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true,
        ))
        // ── WebView 的控制台接进 host 日志 ───────────────────────────
        //
        // **这是一个真实的盲区，代价已经付过了。** 新会话建不出来时，
        // dsh 只做一件事：`console.warn('new session failed:', reason)`
        // （上游注释原话 "Connect failures are non-fatal (console
        // diagnostics; the current view stays usable)"）。界面上什么都不显示，
        // 而那行 warn 落在 WebView 的控制台里——我们的 host 日志从不读那儿。
        // 于是症状是"点了没反应"，排查时手上一条线索都没有，白查了两天。
        //
        // 只转发 warn 与 error：info/log 会把 dsh 正常的输出灌满日志。
        config.userContentController.add(self, name: "consoleRelay")
        config.userContentController.addUserScript(WKUserScript(
            source: """
            for (const level of ['warn', 'error']) {
              const original = console[level].bind(console)
              console[level] = (...args) => {
                try {
                  const text = args.map((value) => {
                    if (typeof value === 'string') return value
                    if (value instanceof Error) return `${value.name}: ${value.message}`
                    try { return JSON.stringify(value) } catch { return String(value) }
                  }).join(' ')
                  window.webkit.messageHandlers.consoleRelay.postMessage(
                    `${level}: ${text.slice(0, 600)}`,
                  )
                } catch {}
                original(...args)
              }
            }
            window.addEventListener('unhandledrejection', (event) => {
              try {
                const reason = event.reason
                window.webkit.messageHandlers.consoleRelay.postMessage(
                  `unhandledrejection: ${reason?.stack ?? reason?.message ?? String(reason)}`.slice(0, 600),
                )
              } catch {}
            })
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true,
        ))

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isHidden = true

        // 整个窗口固定，不做原生滚动。
        //
        // 默认行为是：键盘弹出时 UIKit 把整个 web 内容往上顶/滚动，于是顶栏
        // 会跑掉、页面还能橡皮筋回弹——在一个"对话 + 底部输入框"的界面里
        // 这些都是干扰。
        //
        // 改成：WebView 的高度由**键盘布局引导**决定（见下面的约束），
        // 键盘一出现视口就变矮，页面自己重新布局；输入框因此钉在键盘正上方。
        // 滚动完全交给 web 端那个会话列表。
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // 不用 .interactive：那是"下拉收键盘"，会和 web 端的会话滚动抢手势。
        webView.scrollView.keyboardDismissMode = .none

        view.addSubview(webView)
        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            // 顶部贴安全区：内容不会钻到灵动岛/状态栏底下。
            webView.topAnchor.constraint(equalTo: guide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            // 底部跟着键盘走。键盘收起时 keyboardLayoutGuide 退到安全区底部，
            // 所以这一条同时覆盖了"有键盘"和"没键盘"两种情况。
            webView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
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
        // 用 GET 而不是 HEAD：有些服务端不实现 HEAD，那会把"已就绪"误判成"没起来"。
        request.httpMethod = "GET"
        request.timeoutInterval = 3
        request.cachePolicy = .reloadIgnoringLocalCacheData

        probeSession.dataTask(with: request) { [weak self] _, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                self.lastPollError = error.map { String(describing: ($0 as NSError).localizedDescription) }
                if (response as? HTTPURLResponse) != nil {
                    self.webView.load(URLRequest(url: url))
                    return
                }
                if let deadline = self.pollDeadline, Date() < deadline {
                    // 还在等——保持启动态，不要报错。
                    // 等久了要说一声：静止不动的"正在启动"会被当成卡死。
                    if let started = self.pollStartedAt,
                       Date().timeIntervalSince(started) > Self.slowStartupHint {
                        self.statusLabel.text = "正在启动 dsh…（首次启动较慢）"
                    }
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
        pollStartedAt = Date()
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
        let diagnostic = [
            "探测 \(HarnessEndpoint.current.absoluteString)",
            lastPollError.map { "失败：\($0)" } ?? "失败：无错误对象（响应不是 HTTP）",
            "",
            tailOfHostLog() ?? "host 没有日志输出。",
        ].joined(separator: "\n")
        detailLabel.text = diagnostic
        // 同时落盘：屏幕上的诊断只有拿着手机的人看得到，而排查往往在另一头。
        try? diagnostic.write(to: Self.diagnosticURL, atomically: true, encoding: .utf8)
    }

    /// 诊断信息的落盘位置，用 `devicectl copy from` 取回。
    static var diagnosticURL: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("startup-diagnostic.txt")
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
        // 页面加载完之后 WKContentView 才存在，这时候才能去掉那条辅助栏。
        WebViewKeyboard.removeInputAccessoryBar(from: webView)
        // 成功了就清掉上一次的诊断。留着会误导——排查时看到一个陈旧文件，
        // 很容易当成本次失败的证据（我自己刚踩过这个）。
        try? FileManager.default.removeItem(at: Self.diagnosticURL)
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

/// WebView 控制台的接收端：写进 host 日志（stdout 已被重定向到那个文件）。
extension HarnessViewController: WKScriptMessageHandler {
    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage,
    ) {
        guard message.name == "consoleRelay", let text = message.body as? String else { return }
        print("[webview] \(text)")
    }
}

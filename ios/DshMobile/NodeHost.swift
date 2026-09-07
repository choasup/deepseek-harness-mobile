import Foundation

/// 设备内的 dsh host。
///
/// 这是「纯血」的那一半：Node 跑在 app 自己的后台线程里，dsh 的 web host 监听
/// app 自己的 loopback 端口。WebView 连它，不连任何外部机器——不需要 Mac、
/// 不需要局域网、不需要填地址。
///
/// ## iOS 上必须处理的两件事
///
/// **① app bundle 是只读的。** dsh 要写会话、存储、凭据，所以 `DSH_HOME`
/// 必须指向可写目录（Application Support），不能是 bundle 里的路径。
///
/// **② 没有 fork/exec。** 这一点整个项目都建立在它之上：mobile profile 里所有
/// 依赖本地进程的插件都已禁用，重活通过纯 JS 的 SSH 派给远程机器。
/// 见仓库 README 与 `packages/mobile-app/cordis.patch.yml`。
enum NodeHost {
    /// host 监听的端口。固定值而不是随机端口——WebView 那边要用同一个数，
    /// 而 dsh 的端口是命令行参数、不会回报给我们。
    /// 用高位端口避开常见冲突；这是 app 自己的 loopback，不与别的进程共享。
    static let port = 47799

    /// bundle 里那份 Node 侧代码（dsh 及其依赖）。
    private static var projectRoot: URL? {
        Bundle.main.url(forResource: "nodejs-project", withExtension: nil)
    }

    /// 可写的 DSH_HOME。bundle 只读，会话与凭据必须落在这里。
    private static var dshHome: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("dsh", isDirectory: true)
    }

    private static var thread: Thread?

    /// 探针结果落盘的位置。放 Documents 是为了能用
    /// `xcrun devicectl device copy from` 取回来——设备上没有终端，
    /// 而 Node 的 stdout 在 app 里默认哪儿都不去。
    static var probeResultURL: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("node-probe.json")
    }

    /// 跑一句 Node 并把 stdout 写进 Documents。**同步阻塞**，只用于验证。
    ///
    /// 这是「Node 到底能不能在这台设备上起来」的最小判据：跑通了就说明
    /// 交叉编译的静态库、jitless 的 V8、以及 app 内的线程栈都成立。
    /// 在此之前谈 dsh 没有意义。
    static func runProbeSynchronously(_ script: String) {
        let out = probeResultURL
        try? FileManager.default.removeItem(at: out)
        // Node 往 fd 1 写；app 里那个 fd 不指向任何地方，所以先把它重定向到文件。
        guard freopen(out.path, "w", stdout) != nil else { return }
        defer { fflush(stdout) }

        var args = ["node", "-e", script]
        var cStrings = args.map { strdup($0) }
        defer { cStrings.forEach { free($0) } }
        cStrings.withUnsafeMutableBufferPointer { buf in
            _ = dsh_node_start(Int32(args.count), buf.baseAddress)
        }
    }

    /// 在后台线程上启动 Node。重复调用是空操作。
    ///
    /// 返回 false 表示 bundle 里没有 Node 侧代码——那是打包问题，不是运行时问题，
    /// 调用方应该据此显示"这一版没带设备内 runtime"，而不是干等连接超时。
    @discardableResult
    static func startIfAvailable() -> Bool {
        guard thread == nil else { return true }
        guard let root = projectRoot else { return false }

        try? FileManager.default.createDirectory(at: dshHome, withIntermediateDirectories: true)
        setenv("DSH_HOME", dshHome.path, 1)
        // dsh 的工作区默认取 cwd；bundle 只读，指到可写目录去。
        setenv("DSH_CWD", dshHome.path, 1)

        let entry = root.appendingPathComponent("node_modules/@deepseek-ai/dsh/lib/bin.js")
        let args = [
            "node", entry.path,
            "--profile", "mobile-web",
            "--port", String(port),
            "--no-open",
        ]

        let t = Thread {
            // argv 必须在 node::Start 的整个生命周期内有效，所以在这里持有它，
            // 不要用会被回收的临时缓冲。
            var cStrings = args.map { strdup($0) }
            defer { cStrings.forEach { free($0) } }
            cStrings.withUnsafeMutableBufferPointer { buf in
                _ = dsh_node_start(Int32(args.count), buf.baseAddress)
            }
        }
        // Node 的主线程要跑事件循环 + V8，默认 512KB 栈不够。
        t.stackSize = 4 << 20
        t.name = "dsh.node"
        t.start()
        thread = t
        return true
    }
}

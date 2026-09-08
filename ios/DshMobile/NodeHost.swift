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
    /// dsh host 的日志。**没有这个就等于瞎排查**：设备上没有终端，Node 的
    /// stdout/stderr 在 app 里默认不指向任何地方，host 起没起来、为什么没起来，
    /// 一个字都看不到。
    static var hostLogURL: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("dsh-host.log")
    }

    static var probeResultURL: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("node-probe.json")
    }

    /// 跑 bundle 里的逐包 import 探测（检查点 4.2），结果写进 Documents。
    ///
    /// 这一步回答的是"dsh 的 83 个包在这台 iPhone 上有几个能 import"。
    /// 不直接启动 dsh，是因为那样一个包的失败会被 AggregateError 裹进几十个里，
    /// 而且第一个失败就中止，看不到全貌。
    static func runImportProbe() {
        guard let root = projectRoot else { return }
        runProbeArgs([
            "node",
            root.appendingPathComponent("probe-imports.mjs").path,
            root.path,
        ])
    }

    /// 跑一句 Node 并把 stdout 写进 Documents。**同步阻塞**，只用于验证。
    ///
    /// 这是「Node 到底能不能在这台设备上起来」的最小判据：跑通了就说明
    /// 交叉编译的静态库、jitless 的 V8、以及 app 内的线程栈都成立。
    /// 在此之前谈 dsh 没有意义。
    static func runProbeSynchronously(_ script: String) {
        runProbeArgs(["node", "-e", script])
    }

    private static func runProbeArgs(_ args: [String]) {
        let out = probeResultURL
        try? FileManager.default.removeItem(at: out)
        // Node 往 fd 1 写；app 里那个 fd 不指向任何地方，所以先把它重定向到文件。
        guard freopen(out.path, "w", stdout) != nil else { return }
        defer { fflush(stdout) }

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

        let fm = FileManager.default
        try? fm.createDirectory(at: dshHome, withIntermediateDirectories: true)

        // profile 目录要可写（dsh 会在里面放 storages 等），而 bundle 是只读的，
        // 所以把它从 bundle 拷到 DSH_HOME 下。node_modules 留在 bundle 里不动
        // ——那部分只读就够，而且有几百 MB，拷一份是浪费。
        //
        // **每次启动都重建**，不能"存在就跳过"。踩过：app bundle 的路径里带一个
        // 每次安装都会变的 UUID（/var/containers/Bundle/Application/<UUID>/），
        // 而下面那个 node_modules 符号链接指向的正是这个路径。只建一次的话，
        // 重装之后 profile 仍指向旧 bundle，dsh 读到的是**上一个版本的
        // cordis.patch.yml**——改了补丁却毫无效果，而且看不出原因。
        //
        // 重建的代价是两个小文件加一个符号链接，可以忽略。
        let profiles = dshHome.appendingPathComponent("profiles/mobile-web", isDirectory: true)
        try? fm.removeItem(at: profiles)
        try? fm.createDirectory(at: profiles, withIntermediateDirectories: true)
        let src = root.appendingPathComponent("profiles/mobile-web")
        for name in ["package.json", "cordis.patch.yml"] {
            try? fm.copyItem(at: src.appendingPathComponent(name),
                             to: profiles.appendingPathComponent(name))
        }
        // profile 靠这个符号链接找到 bundle 里的 node_modules（几百 MB，只读，
        // 不拷贝）。
        try? fm.createSymbolicLink(at: profiles.appendingPathComponent("node_modules"),
                                   withDestinationURL: root.appendingPathComponent("node_modules"))

        setenv("DSH_HOME", dshHome.path, 1)
        // dsh 的工作区默认取 cwd；bundle 只读，指到可写目录去。
        setenv("DSH_CWD", dshHome.path, 1)

        // 走 bootstrap 而不是直接跑 bin.js：它要在任何代码碰 fetch 之前把
        // fetch 换成不依赖 WebAssembly 的实现。理由见 bootstrap.mjs。
        let entry = root.appendingPathComponent("bootstrap.mjs")
        let args = [
            "node",
            // 两个理由，都不是为了开发便利：
            //
            // ① cordis 的 loader 要访问 Node 内部模块做解析。它有两条路：
            //    `--expose-internals`，或原生模块 node-addon-require-builtin。
            //    后者在 iOS 上 dlopen 不了、打包时已被剥掉，只剩这一条。
            //    没有它 loader 会走"无 internals"的降级路径。
            // ② HMR 条目硬性要求它，否则报
            //    "--expose-internals is required for HMR service" 并让整棵树
            //    装载失败。那个条目的 id 是动态哈希，用补丁按 id 关不掉。
            //
            // 代价：Node 内部模块对 app 内运行的 JS 可见。这里跑的只有 dsh 自己。
            "--expose-internals",
            entry.path,
            "--profile", "mobile-web",
            "--port", String(port),
            "--no-open",
        ]

        let t = Thread {
            // stdout 与 stderr 都重定向到日志文件，理由见 hostLogURL。
            let log = hostLogURL
            try? FileManager.default.removeItem(at: log)
            freopen(log.path, "w", stdout)
            freopen(log.path, "a", stderr)
            setvbuf(stdout, nil, _IOLBF, 0)   // 行缓冲，崩溃时也能留下已写的部分

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

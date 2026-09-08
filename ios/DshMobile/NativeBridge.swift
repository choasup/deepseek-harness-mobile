import Foundation
import Network

/// 原生能力的入口：Node 侧通过 loopback HTTP 调用它。
///
/// ## 为什么是 HTTP 而不是别的
///
/// Node 与原生在**同一个进程**里，本可以走更紧的通道（N-API、共享内存）。
/// 选 HTTP 是因为：
///
/// - Node 侧用 `node:http` 直连，**不经过 URLSession** —— 正好绕开
///   "iOS 让 URLSession 连 loopback 也走系统代理" 那个坑（今天刚踩过，
///   症状是 app 连不上自己）。
/// - 调试时可以在 Mac 上用同一套接口跑假实现，不必每次上真机。
/// - 相机是**异步且可能被用户取消**的，请求/响应模型天然合适。
///
/// 端口随机、只绑 127.0.0.1，端口号通过环境变量交给 Node。不写死端口是为了
/// 避免与设备上任何东西冲突——这个服务只服务本进程。
final class NativeBridge {
    static let shared = NativeBridge()

    private var listener: NWListener?
    private(set) var port: UInt16?

    /// 路由表。键是 "METHOD /path"。
    private var routes: [String: (Data, [String: String]) -> BridgeResponse] = [:]

    private init() {}

    func register(_ key: String, _ handler: @escaping (Data, [String: String]) -> BridgeResponse) {
        routes[key] = handler
    }

    /// 启动并返回端口。失败返回 nil——调用方据此决定是否把桥的地址交给 Node。
    @discardableResult
    func start() -> UInt16? {
        if let port { return port }
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        guard let listener = try? NWListener(using: params) else { return nil }
        self.listener = listener

        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { [weak self] state in
            if case .ready = state {
                self?.port = listener.port?.rawValue
                ready.signal()
            }
            if case .failed = state { ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] conn in
            conn.start(queue: .global(qos: .userInitiated))
            self?.serve(conn)
        }
        listener.start(queue: .global(qos: .userInitiated))
        _ = ready.wait(timeout: .now() + 5)
        return port
    }

    // ── 极简 HTTP/1.1 服务端 ────────────────────────────────────────
    //
    // 只服务本进程里的 Node，所以刻意不做 keep-alive、分块传输、并发复用：
    // 每个连接一个请求，响应完就关。少写的每一行都是少一处出错的地方。

    private func serve(_ conn: NWConnection) {
        readRequest(conn, buffer: Data()) { [weak self] request in
            guard let self, let request else { conn.cancel(); return }
            let key = "\(request.method) \(request.path)"
            let response = self.routes[key]?(request.body, request.query)
                ?? BridgeResponse(status: 404, body: Data("no route: \(key)".utf8))
            conn.send(content: response.serialized(), completion: .contentProcessed { _ in
                conn.cancel()
            })
        }
    }

    private struct Request {
        let method: String
        let path: String
        let query: [String: String]
        let body: Data
    }

    /// 递归读到请求完整为止。HTTP 头以空行结束，随后按 Content-Length 收正文。
    private func readRequest(
        _ conn: NWConnection,
        buffer: Data,
        done: @escaping (Request?) -> Void
    ) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { chunk, _, isComplete, _ in
            var buffer = buffer
            if let chunk { buffer.append(chunk) }

            let separator = Data("\r\n\r\n".utf8)
            guard let headerEnd = buffer.range(of: separator) else {
                if isComplete { done(nil) } else {
                    self.readRequest(conn, buffer: buffer, done: done)
                }
                return
            }

            let headerData = buffer[..<headerEnd.lowerBound]
            guard let header = String(data: headerData, encoding: .utf8) else { done(nil); return }
            let lines = header.split(separator: "\r\n", omittingEmptySubsequences: false)
            let parts = lines.first?.split(separator: " ") ?? []
            guard parts.count >= 2 else { done(nil); return }

            let length = lines.compactMap { line -> Int? in
                let lower = line.lowercased()
                guard lower.hasPrefix("content-length:") else { return nil }
                return Int(line.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces))
            }.first ?? 0

            let body = buffer[headerEnd.upperBound...]
            guard body.count >= length else {
                if isComplete { done(nil) } else {
                    self.readRequest(conn, buffer: buffer, done: done)
                }
                return
            }

            let target = String(parts[1])
            let comps = URLComponents(string: "http://x\(target)")
            var query: [String: String] = [:]
            for item in comps?.queryItems ?? [] { query[item.name] = item.value ?? "" }

            done(Request(
                method: String(parts[0]),
                path: comps?.path ?? target,
                query: query,
                body: Data(body.prefix(length)),
            ))
        }
    }
}

/// 桥的响应。`contentType` 决定 Node 侧怎么解读——图像走 bytes，错误走 JSON。
struct BridgeResponse {
    var status: Int
    var contentType = "application/octet-stream"
    var body: Data
    /// 附加响应头。原始像素需要把宽高与通道数带回去——它们不在字节流里。
    var headers: [String: String] = [:]

    static func json(_ object: [String: Any], status: Int = 200) -> BridgeResponse {
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
        return BridgeResponse(status: status, contentType: "application/json", body: data)
    }

    static func error(_ message: String, status: Int = 500) -> BridgeResponse {
        json(["error": message], status: status)
    }

    func serialized() -> Data {
        var head = "HTTP/1.1 \(status) \(status == 200 ? "OK" : "Error")\r\n"
        head += "Content-Type: \(contentType)\r\n"
        head += "Content-Length: \(body.count)\r\n"
        for (name, value) in headers { head += "\(name): \(value)\r\n" }
        head += "Connection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(body)
        return out
    }
}

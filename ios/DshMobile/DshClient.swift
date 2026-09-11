import Foundation

/// dsh host 的原生客户端。
///
/// ## 为什么会有这个文件
///
/// 界面正在从"WebView 里塞 dsh 的桌面前端"转向**原生外壳**：Tab 栏、导航、
/// 手势、输入条用 Swift 做，WebView 只留消息流。原生那半边要自己拿数据，
/// 于是需要一条通往 host 的路。
///
/// 好消息是 dsh 的 host 本来就暴露一个**普通的 HTTP API**，不是内部耦合：
///
///   一元调用  POST /api/<method>
///             请求 {"type":"client-request","rpcId":…,"method":…,"payload":…}
///             响应 {"type":"server-response","rpcId":…,"result":{"ok":true,"value":…}}
///   流式      GET  /api/events.mux（SSE）
///
/// 全部 46 个方法。写这个文件前先用 curl 打过 `session.list`，契约确认无误
/// 才动手——不是照着源码猜的。
///
/// ## 两条硬约束
///
/// **① 必须绕过系统代理。** iOS 默认让 URLSession 走系统代理，**连 loopback
/// 也不例外**；这台机器的网络恰好有个 HTTP 代理，不绕开的话请求会被它接管，
/// 而失败表现是一个和 dsh 毫无关系的 502 页面。这个坑今天已经踩过一次。
///
/// **② rpcId 要对账。** 服务端会把它原样回传，对不上说明响应串了——
/// 与其让错误数据往上层流，不如当场失败。
enum DshClient {
    /// 一元调用的失败原因。分开命名是为了让调用方能区分"网络不通"和
    /// "host 说不行"——这两者对用户的意义完全不同。
    enum Failure: Error {
        /// 连不上 host（还没起来、端口不对、被代理接管）。
        case unreachable(String)
        /// host 收到了但拒绝了，带上它自己的错误码与说明。
        case rejected(code: String, message: String)
        /// host 不认识这个方法（404 + 纯文本 "not found"，根本不是信封）。
        /// 单独一类：这是**我们这边写错了方法名**，不是运行时故障，
        /// 混进 malformed 会让排查从"协议坏了"开始，方向就偏了。
        case unknownMethod(String)
        /// 响应格式不对，或 rpcId 对不上。
        case malformed(String)
    }

    /// 专用 session：绕过系统代理，超时按"本机调用"给，不是公网。
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForRequest = 15
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    /// 调一个一元 RPC。
    ///
    /// - Parameters:
    ///   - method: dsh 的方法名，如 `session.list`。
    ///   - payload: 方法自己的入参；没有就传空字典。
    /// - Returns: `result.value` 里的内容，已解成 JSON 对象。
    static func call(
        _ method: String,
        payload: [String: Any] = [:],
        baseURL: URL = HarnessEndpoint.current,
    ) async throws -> Any {
        let rpcId = UUID().uuidString
        let envelope: [String: Any] = [
            "type": "client-request",
            "rpcId": rpcId,
            "method": method,
            "payload": payload,
        ]

        var request = URLRequest(url: baseURL.appendingPathComponent("api/\(method)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: envelope)

        let data: Data
        do {
            let (body, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw Failure.unreachable("响应不是 HTTP")
            }
            // 4xx/5xx 也可能带着结构化的错误体，所以不在这里就断言失败，
            // 交给下面统一按信封解析——host 的错误说明比状态码有用得多。
            // 实测过 host 的两种失败形状，分开处理：
            //   未知方法 → 404 + text/plain "not found"（不是信封）
            //   参数错误 → 200 + 信封，error.code = bad-request，还带逐字段说明
            if http.statusCode == 404 {
                throw Failure.unknownMethod(method)
            }
            guard http.statusCode < 500 else {
                throw Failure.unreachable("HTTP \(http.statusCode)")
            }
            data = body
        } catch let failure as Failure {
            throw failure
        } catch {
            throw Failure.unreachable(error.localizedDescription)
        }

        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Failure.malformed("响应不是 JSON 对象")
        }
        // 串号意味着响应对不上请求。让它往上层流比当场失败危险得多。
        if let echoed = root["rpcId"] as? String, echoed != rpcId {
            throw Failure.malformed("rpcId 不一致：发出 \(rpcId)，收到 \(echoed)")
        }
        guard let result = root["result"] as? [String: Any] else {
            throw Failure.malformed("响应里没有 result")
        }
        if result["ok"] as? Bool == true {
            return result["value"] ?? [:]
        }
        let error = result["error"] as? [String: Any] ?? [:]
        var message = error["message"] as? String ?? "host 拒绝了这次调用"
        // details 里是 zod 的逐字段说明（哪个字段、期望什么、收到什么）。
        // 它才是"为什么被拒"的答案，丢掉只剩一句泛泛的 invalid payload。
        if let details = error["details"],
           let encoded = try? JSONSerialization.data(withJSONObject: details),
           let text = String(data: encoded, encoding: .utf8) {
            message += " | \(text.prefix(300))"
        }
        throw Failure.rejected(code: error["code"] as? String ?? "unknown", message: message)
    }
}

/// 会话列表里的一行。只取原生界面真正用得上的字段——
/// 多解一个字段就多一处会随 dsh 升级而错的地方。
struct DshSession: Identifiable, Sendable {
    let id: String
    let updatedAt: Date
    let running: Bool
    /// 空白会话（还没发过消息）。列表里要么不显示，要么标出来。
    let blank: Bool
    /// 会话的工作目录。移动端用它显示"在哪儿执行"。
    let cwd: String

    init?(json: [String: Any]) {
        guard let id = json["sessionId"] as? String else { return nil }
        self.id = id
        let millis = json["updatedAt"] as? Double ?? 0
        updatedAt = Date(timeIntervalSince1970: millis / 1000)
        running = json["running"] as? Bool ?? false
        blank = json["blank"] as? Bool ?? false
        cwd = json["cwd"] as? String ?? ""
    }

    /// 拉会话列表。
    static func list() async throws -> [DshSession] {
        let value = try await DshClient.call("session.list")
        let items = (value as? [String: Any])?["items"] as? [[String: Any]] ?? []
        return items.compactMap(DshSession.init(json:))
    }
}

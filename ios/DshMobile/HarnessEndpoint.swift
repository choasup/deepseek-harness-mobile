import Foundation

/// dsh host 的地址——**这是设备内 runtime 落地时唯一要改的地方**。
///
/// 现在指向 Mac 上的 loopback。模拟器与宿主共享网络栈，所以 `127.0.0.1` 能通；
/// 真机不行（那是手机自己的 loopback），需要局域网地址，而 dsh 出于安全
/// 拒绝绑 `0.0.0.0`（原话："it would expose remote code execution to the
/// network"）——所以真机要走反向隧道或设备内 runtime，不能简单改 IP。
///
/// 设备内 runtime 就位后，这里换成 app 自己那个 Node 线程监听的随机端口。
enum HarnessEndpoint {
    static let current: URL = {
        // 允许用启动参数覆盖，便于在不同端口上跑而不必改代码重编。
        if let raw = UserDefaults.standard.string(forKey: "HarnessURL"),
           let url = URL(string: raw) {
            return url
        }
        return URL(string: "http://127.0.0.1:7799")!
    }()
}

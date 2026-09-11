import SwiftUI

/// 原生的会话列表——外壳原生化的第一屏。
///
/// ## 为什么从这一屏开始
///
/// 它是**自包含**的：只依赖 `session.list` 一个 RPC，不需要消息渲染、不需要
/// 流式、不需要输入条。做完就能直接对比"原生 vs WebView 里的同一个列表"，
/// 拿手感说话，而不是靠我说原生会更好。
///
/// ## 按设计稿的 05 屏
///
/// 大标题 28/34 600、搜索框 40pt 圆角 12、会话行三行结构（标题+时间 / 摘要 /
/// 执行位置）、分隔线 1px。触控目标 ≥44pt。颜色走系统语义色而不是写死——
/// 深浅色是 iOS 自己切的，写死等于只对一种主题正确（和 Web 那边用
/// --dsw-* 令牌是同一个道理）。
struct SessionListView: View {
    @State private var sessions: [DshSession] = []
    @State private var query = ""
    @State private var loadError: String?
    @State private var loading = true

    /// 选中一个会话时通知外壳（外壳负责把 WebView 切到那个会话）。
    var onOpen: (DshSession) -> Void

    private var visible: [DshSession] {
        // 空白会话不进列表：它们没有内容，点进去是一片空白，
        // 而"新建会话"本来就是另一个入口。
        let real = sessions.filter { !$0.blank }
        guard !query.isEmpty else { return real }
        return real.filter { $0.cwd.localizedCaseInsensitiveContains(query) || $0.id.contains(query) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("会话")
                .font(.system(size: 28, weight: .semibold))
                .kerning(-0.28)
                .padding(.horizontal, 20)
                .padding(.top, 4)
                .padding(.bottom, 12)

            searchField
                .padding(.horizontal, 20)
                .padding(.bottom, 8)

            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task { await reload() }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 15))
                .foregroundStyle(.tertiary)
            TextField("搜索会话", text: $query)
                .font(.system(size: 16))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
        .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private var content: some View {
        if loading {
            centered { ProgressView() }
        } else if let loadError {
            // 失败要给**能推进排查的信息**，不是一句"加载失败"。
            // 这是这个项目里反复付过代价的一条。
            centered {
                VStack(spacing: 10) {
                    Text("读不到会话列表").font(.system(size: 17, weight: .medium))
                    Text(loadError)
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                    Button("重试") { Task { await reload() } }
                        .buttonStyle(.bordered)
                }
            }
        } else if visible.isEmpty {
            centered {
                Text(query.isEmpty ? "还没有会话" : "没有匹配的会话")
                    .font(.system(size: 15))
                    .foregroundStyle(.secondary)
            }
        } else {
            List(visible) { session in
                Button { onOpen(session) } label: { SessionRow(session: session) }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
            }
            .listStyle(.plain)
            .refreshable { await reload() }
        }
    }

    private func centered<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack { Spacer(); content(); Spacer() }.frame(maxWidth: .infinity)
    }

    private func reload() async {
        loading = sessions.isEmpty
        do {
            sessions = try await DshSession.list()
            loadError = nil
        } catch {
            loadError = String(describing: error)
        }
        loading = false
    }
}

/// 一行会话：标题+时间 / 执行位置。
private struct SessionRow: View {
    let session: DshSession

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.system(size: 17, weight: .medium))
                    .lineLimit(1)
                Spacer(minLength: 12)
                Text(relative)
                    .font(.system(size: 13))
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
            }
            HStack(spacing: 6) {
                Circle()
                    .fill(session.running ? Color.green : Color.secondary.opacity(0.5))
                    .frame(width: 6, height: 6)
                Text(location)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
        }
        .padding(.vertical, 14)
        .contentShape(Rectangle())
    }

    /// 列表里显示什么名字。dsh 的 session.list 不带标题，只有 id 和 cwd——
    /// 用工作目录的最后一段比截断的 uuid 有意义得多。
    private var title: String {
        let name = (session.cwd as NSString).lastPathComponent
        return name.isEmpty ? String(session.id.prefix(16)) : name
    }

    /// 执行位置。设备内的容器路径又长又没信息量，折成"仅本机"。
    private var location: String {
        if session.cwd.contains("/Containers/Data/Application/") { return "仅本机" }
        return session.cwd.isEmpty ? "仅本机" : session.cwd
    }

    private var relative: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.unitsStyle = .short
        return formatter.localizedString(for: session.updatedAt, relativeTo: Date())
    }
}

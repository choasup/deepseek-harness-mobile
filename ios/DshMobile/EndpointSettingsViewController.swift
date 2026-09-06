import UIKit

/// 在设备上填 host 地址。
///
/// 真机上没有别的途径：不能传启动参数，每台 Mac 的局域网地址也不一样。
/// 连不上时自动弹出来，平时摇一摇也能叫出来（见 HarnessViewController）。
final class EndpointSettingsViewController: UIViewController {
    /// 填好并确认后回调，参数是规范化之后的地址。
    var onConnect: ((URL) -> Void)?

    /// 预填的地址（来自 `dshmobile://settings?url=…`）。为空时用当前生效的那个。
    var preset: String?

    private let field = UITextField()
    private let detail = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let title = UILabel()
        title.text = "连接到 dsh"
        title.font = .preferredFont(forTextStyle: .title2)
        title.adjustsFontForContentSizeCategory = true

        detail.numberOfLines = 0
        detail.font = .preferredFont(forTextStyle: .footnote)
        detail.adjustsFontForContentSizeCategory = true
        detail.textColor = .secondaryLabel
        detail.text = """
        这一版的 runtime 跑在 Mac 上，不在手机里。填 Mac 的局域网地址。

        Mac 上要先起 host（把 <Mac IP> 换成实际地址）：
        dsh --profile mobile-web --host <Mac IP> \\
            --port 7799 --no-open --trusted-host <Mac IP>:7799

        注意这会把 dsh 的接口暴露给同一个局域网，而 dsh 能执行代码——
        用完就把它停掉，别在公共 Wi-Fi 上开着。
        """

        field.borderStyle = .roundedRect
        field.placeholder = "192.168.1.9:7799"
        field.text = preset ?? HarnessEndpoint.current.absoluteString
        field.keyboardType = .URL
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.clearButtonMode = .whileEditing
        field.returnKeyType = .go
        field.delegate = self
        field.font = .monospacedSystemFont(ofSize: 16, weight: .regular)

        let connect = UIButton(configuration: .filled())
        connect.setTitle("连接", for: .normal)
        connect.addTarget(self, action: #selector(connectTapped), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [title, field, connect, detail])
        stack.axis = .vertical
        stack.spacing = 16
        stack.setCustomSpacing(24, after: connect)
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)

        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: guide.topAnchor, constant: 32),
            stack.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -24),
            connect.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        field.becomeFirstResponder()
    }

    @objc private func connectTapped() {
        guard let url = HarnessEndpoint.set(field.text ?? "") else {
            // 不静默失败——手机上打错地址太容易，说清楚哪里不对。
            detail.textColor = .systemRed
            detail.text = "这个地址读不出主机名。形如 192.168.1.9:7799，或带上 http://。"
            return
        }
        dismiss(animated: true) { [onConnect] in onConnect?(url) }
    }
}

extension EndpointSettingsViewController: UITextFieldDelegate {
    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        connectTapped()
        return true
    }
}

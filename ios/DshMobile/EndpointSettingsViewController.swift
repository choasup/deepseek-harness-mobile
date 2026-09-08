import UIKit

/// 地址覆盖。**开发入口，不在正常路径上。**
///
/// runtime 在设备内之后，普通用户永远不该看到这个界面——app 连的是自己，
/// 让人填地址是把实现细节漏到界面上。它现在只由 `dshmobile://settings`
/// 或摇一摇进入，用途是开发时把界面指向 Mac 上的 host，省掉重新打包 300MB。
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
        开发用。默认地址是 app 自己的 runtime，正常情况不需要改。

        指向 Mac 上的 host 可以省掉重新打包：
        dsh --profile mobile-web --host <Mac IP> \\
            --port 7799 --no-open --trusted-host <Mac IP>:7799

        那会把 dsh 的接口暴露给局域网，而 dsh 能执行代码——用完就停掉。
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

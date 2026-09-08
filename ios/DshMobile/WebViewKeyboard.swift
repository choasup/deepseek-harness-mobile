import UIKit
import WebKit

/// 去掉 WKWebView 输入时那条键盘辅助栏（上一项 / 下一项 / 完成）。
///
/// 那条栏是 UIKit 给表单准备的：在多个输入框之间跳转。而这个 app 里 WebView
/// 只有一个输入框（对话框），三个按钮全都无事可做，纯占一行高度——手机上
/// 每一行都金贵。
///
/// ## 做法与它的代价
///
/// WKWebView 不暴露它的输入视图，真正持有 `inputAccessoryView` 的是私有类
/// `WKContentView`。标准做法是在运行时给那个实例造一个子类，只覆盖这一个
/// getter 返回 nil，然后把实例换过去（`object_setClass`）。
///
/// **代价要说清楚**：依赖私有类名前缀 `WKContent`。将来 WebKit 改了名字，
/// 这段会**静默失效**——辅助栏回来，但不会崩。所以写成"找不到就算了"，
/// 不做任何断言。这个 app 不上架，这个取舍可以接受；要上架的话得重新考虑。
enum WebViewKeyboard {
    /// 覆盖用的空实现。`object_setClass` 之后由它提供 getter。
    private final class NoAccessory: NSObject {
        @objc var noInputAccessoryView: UIView? { nil }
    }

    static func removeInputAccessoryBar(from webView: WKWebView) {
        guard let target = webView.scrollView.subviews.first(where: {
            String(describing: type(of: $0)).hasPrefix("WKContent")
        }) else { return }   // 类名变了就静默放弃，见上面的说明

        let subclassName = "\(type(of: target))_DshNoAccessory"
        if let existing = NSClassFromString(subclassName) {
            object_setClass(target, existing)
            return
        }
        guard
            let name = subclassName.cString(using: .ascii),
            let subclass = objc_allocateClassPair(type(of: target), name, 0),
            let source = class_getInstanceMethod(NoAccessory.self,
                                                 #selector(getter: NoAccessory.noInputAccessoryView))
        else { return }

        class_addMethod(
            subclass,
            #selector(getter: UIResponder.inputAccessoryView),
            method_getImplementation(source),
            method_getTypeEncoding(source),
        )
        objc_registerClassPair(subclass)
        object_setClass(target, subclass)
    }
}

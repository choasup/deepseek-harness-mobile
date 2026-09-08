import CoreLocation
import CoreMotion
import Foundation
import UIKit

/// 设备传感器的原生入口。
///
/// ## 为什么要有这个
///
/// 这个形态的定位是「手机是大脑和感官」。在此之前"感官"只有相机——模型被问到
/// "你能感知到手机上有哪些传感器"时只能答"感知不到，我运行在文件沙盒里"。
/// 那句话是对的：Node 侧确实没有任何硬件接口，传感器只能由原生侧读。
///
/// ## 一次采样，不是订阅
///
/// 每个读数都是**一次快照**：开采样、拿到第一帧、立刻停。理由有三个——
/// 工具调用本身就是一问一答的形状；持续采样在后台会被系统掐掉，留下的是
/// 一个悄悄停更的假数据源；而传感器常开非常费电。要看变化趋势，让模型
/// 隔一会儿再调一次，比给它一个会骗人的数据流诚实。
///
/// ## 拿不到的要说清楚为什么
///
/// 不可用的传感器返回 `available: false` 加一句原因，而不是省略字段或给 0。
/// 模型分不清"没有这个传感器"、"没权限"和"值就是 0"，但这三者对它下一步
/// 该做什么的影响完全不同。
enum SensorBridge {
    /// 单次采样的等待上限。超过就报"取不到"，不能让桥的这条请求一直挂着。
    private static let sampleTimeout: TimeInterval = 2
    private static let locationTimeout: TimeInterval = 10

    private static let motion = CMMotionManager()
    private static let altimeter = CMAltimeter()
    private static let pedometer = CMPedometer()
    private static let activityManager = CMMotionActivityManager()

    // MARK: - 路由入口

    /// 列出这台设备**有哪些**传感器，不读数、不触发任何权限弹窗。
    static func inventory() -> BridgeResponse {
        .json(["sensors": catalogue()])
    }

    /// 读取指定传感器。`kinds` 是逗号分隔的名字，空表示读默认集合。
    static func read(kinds requested: String) -> BridgeResponse {
        let names = requested
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let kinds = names.isEmpty ? defaultKinds : names

        var readings: [String: Any] = [:]
        for kind in kinds {
            switch kind {
            case "device": readings[kind] = deviceInfo()
            case "battery": readings[kind] = battery()
            case "motion": readings[kind] = motionSnapshot()
            case "barometer": readings[kind] = barometer()
            case "pedometer": readings[kind] = pedometerToday()
            case "activity": readings[kind] = activity()
            case "location": readings[kind] = location()
            case "proximity": readings[kind] = proximity()
            default:
                readings[kind] = unavailable("没有这个传感器名。可用的名字见 /sensors/inventory。")
            }
        }
        return .json(["readings": readings])
    }

    /// 不显式点名时读的那一组：**不含 location**。
    ///
    /// 定位会弹权限框、拿到的是精确坐标，属于"要主动要才给"的东西。
    /// 其余几项既不弹框也不涉及位置，默认给出去没有代价。
    private static let defaultKinds = ["device", "battery", "motion", "barometer", "activity"]

    // MARK: - 清单

    private static func catalogue() -> [[String: Any]] {
        [
            entry("device", "型号、系统版本、屏幕、温度状态、内存与磁盘", available: true),
            entry("battery", "电量与充电状态", available: true),
            entry(
                "motion",
                "加速度计、陀螺仪、磁力计、姿态（roll/pitch/yaw）与磁北朝向",
                available: motion.isDeviceMotionAvailable,
                reason: "这台设备没有可用的姿态融合（device motion）",
            ),
            entry(
                "barometer",
                "气压（kPa）与相对高度变化",
                available: CMAltimeter.isRelativeAltitudeAvailable(),
                reason: "这台设备没有气压计",
            ),
            entry(
                "pedometer",
                "今天的步数、距离、爬楼层数",
                available: CMPedometer.isStepCountingAvailable(),
                reason: "这台设备不支持计步",
            ),
            entry(
                "activity",
                "当前运动状态（静止/步行/跑步/骑行/车载）",
                available: CMMotionActivityManager.isActivityAvailable(),
                reason: "这台设备不支持运动状态识别",
            ),
            entry(
                "location",
                "GPS 坐标、海拔、速度、航向。**要用户授权**，且不在默认集合里",
                available: CLLocationManager.locationServicesEnabled(),
                reason: "系统的定位服务被关掉了",
            ),
            entry(
                "proximity",
                "距离传感器（贴脸/离开）。读的瞬间系统可能熄屏，所以不在默认集合里",
                available: true,
            ),
            // 下面两个**明确报不可用**，而不是干脆不提：模型问"有哪些传感器"时，
            // "iPhone 有环境光传感器但读不到"和"没这个传感器"是两回事。
            entry(
                "ambientLight",
                "环境光",
                available: false,
                reason: "iOS 没有公开的环境光 API。只能间接看 device.screenBrightness（开了自动亮度时随环境光变化）",
            ),
            entry(
                "microphoneLevel",
                "环境音量",
                available: false,
                reason: "读音量等于开录音，要麦克风权限且属于采集而非读数；这个 harness 没有开",
            ),
        ]
    }

    private static func entry(
        _ name: String,
        _ what: String,
        available: Bool,
        reason: String = "",
    ) -> [String: Any] {
        var row: [String: Any] = ["name": name, "what": what, "available": available]
        if !available, !reason.isEmpty { row["reason"] = reason }
        return row
    }

    private static func unavailable(_ reason: String) -> [String: Any] {
        ["available": false, "reason": reason]
    }

    // MARK: - 各传感器

    /// 回主线程执行。
    ///
    /// UIKit 的这些属性（`UIDevice.current`、`UIScreen.main`）**是主线程专属的**，
    /// 而桥的路由跑在后台队列上。在后台读它们轻则触发 main thread checker，
    /// 重则拿到过期值——而过期值看上去和正常读数一模一样。
    ///
    /// 用 `sync` 不会死锁：主线程从不同步等待桥的队列（相机那条路由是后台线程
    /// 拿信号量等主线程，方向相反）。
    private static func onMain<T>(_ work: () -> T) -> T {
        Thread.isMainThread ? work() : DispatchQueue.main.sync(execute: work)
    }

    private static func deviceInfo() -> [String: Any] {
        onMain { deviceInfoOnMain() }
    }

    private static func deviceInfoOnMain() -> [String: Any] {
        let device = UIDevice.current
        let screen = UIScreen.main
        let process = ProcessInfo.processInfo

        var systemInfo = utsname()
        uname(&systemInfo)
        let identifier = withUnsafeBytes(of: &systemInfo.machine) { raw in
            String(cString: raw.baseAddress!.assumingMemoryBound(to: CChar.self))
        }

        var info: [String: Any] = [
            "available": true,
            // 机器标识（iPhone18,2 这类）比市场名字更有用：模型可以据此查规格。
            // **不报设备名**——那通常是用户的真名（"某某的 iPhone"）。
            "modelIdentifier": identifier,
            "system": "\(device.systemName) \(device.systemVersion)",
            "screenPoints": ["width": screen.bounds.width, "height": screen.bounds.height],
            "screenScale": screen.scale,
            // 开了自动亮度时它跟着环境光走——这是这台设备上最接近"环境光读数"
            // 的东西，虽然并不是环境光传感器本身。
            "screenBrightness": screen.brightness,
            "locale": Locale.current.identifier,
            "timeZone": TimeZone.current.identifier,
            "lowPowerMode": process.isLowPowerModeEnabled,
            "thermalState": thermalName(process.thermalState),
            "physicalMemoryBytes": process.physicalMemory,
            "processorCount": process.processorCount,
            "systemUptimeSeconds": Int(process.systemUptime),
        ]

        if let values = try? URL(fileURLWithPath: NSHomeDirectory())
            .resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey, .volumeTotalCapacityKey])
        {
            info["diskFreeBytes"] = values.volumeAvailableCapacityForImportantUsage ?? 0
            info["diskTotalBytes"] = values.volumeTotalCapacity ?? 0
        }
        return info
    }

    private static func thermalName(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }

    private static func battery() -> [String: Any] {
        onMain { batteryOnMain() }
    }

    private static func batteryOnMain() -> [String: Any] {
        // 电池状态**要先打开监测**，否则 level 恒为 -1、state 恒为 unknown
        // ——一个看起来像"读到了"的假读数。
        let device = UIDevice.current
        let wasEnabled = device.isBatteryMonitoringEnabled
        device.isBatteryMonitoringEnabled = true
        defer { device.isBatteryMonitoringEnabled = wasEnabled }

        let level = device.batteryLevel
        let state: String
        switch device.batteryState {
        case .charging: state = "charging"
        case .full: state = "full"
        case .unplugged: state = "unplugged"
        default: state = "unknown"
        }
        return [
            "available": level >= 0,
            "levelPercent": level >= 0 ? Int((level * 100).rounded()) : -1,
            "state": state,
        ]
    }

    private static func motionSnapshot() -> [String: Any] {
        guard motion.isDeviceMotionAvailable else {
            return unavailable("这台设备没有可用的 device motion")
        }
        // 优先用磁北参考系：这样 attitude 的 yaw 和 heading 才有绝对意义。
        // 拿不到就退回任意参考系——**不是失败**，只是朝向变成相对的。
        let frames = CMMotionManager.availableAttitudeReferenceFrames()
        let frame: CMAttitudeReferenceFrame =
            frames.contains(.xMagneticNorthZVertical) ? .xMagneticNorthZVertical : .xArbitraryZVertical

        guard let sample = firstDeviceMotion(using: frame) else {
            return unavailable("\(Int(sampleTimeout)) 秒内没等到采样")
        }

        var reading: [String: Any] = [
            "available": true,
            "referenceFrame": frame == .xMagneticNorthZVertical ? "magneticNorth" : "arbitrary",
            // 重力与用户加速度是分开的：融合后的结果比裸加速度计有用得多
            // （裸值里这两者叠在一起，分不出"倾斜"还是"在动"）。
            "gravityG": vector(sample.gravity.x, sample.gravity.y, sample.gravity.z),
            "userAccelerationG": vector(
                sample.userAcceleration.x, sample.userAcceleration.y, sample.userAcceleration.z,
            ),
            "rotationRateRadPerSec": vector(
                sample.rotationRate.x, sample.rotationRate.y, sample.rotationRate.z,
            ),
            "attitudeDegrees": [
                "roll": degrees(sample.attitude.roll),
                "pitch": degrees(sample.attitude.pitch),
                "yaw": degrees(sample.attitude.yaw),
            ],
        ]

        // 磁力计的校准状态要一并给出：uncalibrated 时那三个数基本没有意义，
        // 而它们看上去和校准好的读数一模一样。
        let field = sample.magneticField
        reading["magneticFieldMicroTesla"] = vector(field.field.x, field.field.y, field.field.z)
        reading["magneticFieldAccuracy"] = magneticAccuracyName(field.accuracy)
        if sample.heading >= 0 { reading["headingDegrees"] = sample.heading }
        return reading
    }

    private static func firstDeviceMotion(using frame: CMAttitudeReferenceFrame) -> CMDeviceMotion? {
        let queue = OperationQueue()
        // 串行：回调里要判"是不是第一帧"，并发队列下这个判断不成立。
        queue.maxConcurrentOperationCount = 1
        let ready = DispatchSemaphore(value: 0)
        var first: CMDeviceMotion?

        motion.deviceMotionUpdateInterval = 1.0 / 30
        motion.startDeviceMotionUpdates(using: frame, to: queue) { sample, _ in
            guard first == nil, let sample else { return }
            first = sample
            ready.signal()
        }
        _ = ready.wait(timeout: .now() + sampleTimeout)
        motion.stopDeviceMotionUpdates()
        return first
    }

    private static func magneticAccuracyName(_ accuracy: CMMagneticFieldCalibrationAccuracy) -> String {
        switch accuracy {
        case .uncalibrated: return "uncalibrated"
        case .low: return "low"
        case .medium: return "medium"
        case .high: return "high"
        @unknown default: return "unknown"
        }
    }

    private static func barometer() -> [String: Any] {
        guard CMAltimeter.isRelativeAltitudeAvailable() else {
            return unavailable("这台设备没有气压计")
        }
        if CMAltimeter.authorizationStatus() == .denied {
            return unavailable("运动与健身权限被拒绝，气压计读不了")
        }
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        let ready = DispatchSemaphore(value: 0)
        var first: CMAltitudeData?
        altimeter.startRelativeAltitudeUpdates(to: queue) { sample, _ in
            guard first == nil, let sample else { return }
            first = sample
            ready.signal()
        }
        _ = ready.wait(timeout: .now() + sampleTimeout)
        altimeter.stopRelativeAltitudeUpdates()
        guard let first else { return unavailable("\(Int(sampleTimeout)) 秒内没等到气压采样") }
        return [
            "available": true,
            "pressureKilopascals": first.pressure.doubleValue,
            // 相对高度是"从这次订阅开始算起"的变化量。刚开就读，所以恒为 0——
            // 如实说明，免得模型把它当海拔。
            "relativeAltitudeMeters": first.relativeAltitude.doubleValue,
            "note": "relativeAltitude 从本次采样开始计，单次快照下恒为 0；要看变化得连续采样",
        ]
    }

    private static func pedometerToday() -> [String: Any] {
        guard CMPedometer.isStepCountingAvailable() else {
            return unavailable("这台设备不支持计步")
        }
        if CMPedometer.authorizationStatus() == .denied {
            return unavailable("运动与健身权限被拒绝")
        }
        let start = Calendar.current.startOfDay(for: Date())
        let ready = DispatchSemaphore(value: 0)
        var result: CMPedometerData?
        var failure: Error?
        pedometer.queryPedometerData(from: start, to: Date()) { data, error in
            result = data
            failure = error
            ready.signal()
        }
        _ = ready.wait(timeout: .now() + sampleTimeout)
        guard let result else {
            return unavailable(failure.map { "查询失败：\($0.localizedDescription)" } ?? "查询超时")
        }
        var reading: [String: Any] = [
            "available": true,
            "since": ISO8601DateFormatter().string(from: start),
            "steps": result.numberOfSteps.intValue,
        ]
        if let distance = result.distance { reading["distanceMeters"] = distance.doubleValue }
        if let floors = result.floorsAscended { reading["floorsAscended"] = floors.intValue }
        return reading
    }

    private static func activity() -> [String: Any] {
        guard CMMotionActivityManager.isActivityAvailable() else {
            return unavailable("这台设备不支持运动状态识别")
        }
        if CMMotionActivityManager.authorizationStatus() == .denied {
            return unavailable("运动与健身权限被拒绝")
        }
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        let ready = DispatchSemaphore(value: 0)
        var latest: CMMotionActivity?
        activityManager.queryActivityStarting(
            from: Date().addingTimeInterval(-600), to: Date(), to: queue,
        ) { activities, _ in
            latest = activities?.last
            ready.signal()
        }
        _ = ready.wait(timeout: .now() + sampleTimeout)
        guard let latest else { return unavailable("最近 10 分钟没有运动状态记录") }
        var states: [String] = []
        if latest.stationary { states.append("stationary") }
        if latest.walking { states.append("walking") }
        if latest.running { states.append("running") }
        if latest.cycling { states.append("cycling") }
        if latest.automotive { states.append("automotive") }
        if latest.unknown { states.append("unknown") }
        return [
            "available": true,
            "states": states,
            "confidence": ["low", "medium", "high"][min(max(latest.confidence.rawValue, 0), 2)],
            "since": ISO8601DateFormatter().string(from: latest.startDate),
        ]
    }

    private static func proximity() -> [String: Any] {
        onMain { proximityOnMain() }
    }

    private static func proximityOnMain() -> [String: Any] {
        let device = UIDevice.current
        device.isProximityMonitoringEnabled = true
        defer { device.isProximityMonitoringEnabled = false }
        guard device.isProximityMonitoringEnabled else {
            return unavailable("这台设备不支持距离传感器监测")
        }
        return ["available": true, "near": device.proximityState]
    }

    private static func location() -> [String: Any] {
        guard locationServicesAreEnabled() else {
            return unavailable("系统的定位服务被关掉了")
        }
        let ready = DispatchSemaphore(value: 0)
        var outcome: [String: Any] = [:]
        // CLLocationManager 的回调靠 run loop，必须在主线程建。桥的处理器跑在
        // 后台队列上，直接 new 出来的 manager 不会回调——表现是"永远超时"。
        DispatchQueue.main.async {
            LocationOnce.shared.request { result in
                outcome = result
                ready.signal()
            }
        }
        if ready.wait(timeout: .now() + locationTimeout) == .timedOut {
            return unavailable("\(Int(locationTimeout)) 秒内没拿到定位（可能是权限框还没被处理）")
        }
        return outcome
    }

    // MARK: - 小工具

    private static func vector(_ x: Double, _ y: Double, _ z: Double) -> [String: Double] {
        ["x": rounded(x), "y": rounded(y), "z": rounded(z)]
    }

    /// 保留四位小数。传感器本身的噪声远大于这个精度，多出来的位数只是噪音，
    /// 而它们要占模型的上下文。
    private static func rounded(_ value: Double) -> Double {
        (value * 10000).rounded() / 10000
    }

    private static func degrees(_ radians: Double) -> Double {
        rounded(radians * 180 / .pi)
    }

    /// `CLLocationManager.locationServicesEnabled()` 会阻塞调用线程，系统对在
    /// 主线程上调它有明确警告。这里挪到后台队列去问。
    private static func locationServicesAreEnabled() -> Bool {
        var enabled = false
        let ready = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async {
            enabled = CLLocationManager.locationServicesEnabled()
            ready.signal()
        }
        _ = ready.wait(timeout: .now() + 2)
        return enabled
    }
}

/// 一次性定位。持有 manager 直到回调结束——manager 被释放就不会回调，
/// 而表现是"一直超时"，看不出是生命周期问题。
private final class LocationOnce: NSObject, CLLocationManagerDelegate {
    static let shared = LocationOnce()

    private var manager: CLLocationManager?
    private var completion: (([String: Any]) -> Void)?

    func request(_ completion: @escaping ([String: Any]) -> Void) {
        // 已有请求在跑就直接拒绝，不排队：桥的每条请求都有超时，排队只会
        // 让后来的那条必然超时。
        if self.completion != nil {
            completion(["available": false, "reason": "已经有一次定位请求在进行中"])
            return
        }
        self.completion = completion
        let manager = CLLocationManager()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        self.manager = manager

        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()  // 授权结果回调里再取位置
        case .denied, .restricted:
            finish(["available": false, "reason": "定位权限被拒绝，需要用户在系统设置里打开"])
        default:
            manager.requestLocation()
            manager.startUpdatingHeading()
        }
    }

    private func finish(_ result: [String: Any]) {
        let callback = completion
        completion = nil
        manager?.stopUpdatingHeading()
        manager = nil
        callback?(result)
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .notDetermined: return  // 用户还没点，等着
        case .denied, .restricted:
            finish(["available": false, "reason": "用户拒绝了定位权限"])
        default:
            manager.requestLocation()
            manager.startUpdatingHeading()
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        var reading: [String: Any] = [
            "available": true,
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            // 水平精度是**半径**，不是误差上限。一并给出去，模型才知道
            // "在这个点附近 65 米内"而不是"就在这个点"。
            "horizontalAccuracyMeters": location.horizontalAccuracy,
            "altitudeMeters": location.altitude,
            "verticalAccuracyMeters": location.verticalAccuracy,
            "timestamp": ISO8601DateFormatter().string(from: location.timestamp),
        ]
        if location.speed >= 0 { reading["speedMetersPerSecond"] = location.speed }
        if location.course >= 0 { reading["courseDegrees"] = location.course }
        if let heading = manager.heading, heading.headingAccuracy >= 0 {
            reading["magneticHeadingDegrees"] = heading.magneticHeading
            reading["trueHeadingDegrees"] = heading.trueHeading
        }
        finish(reading)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finish(["available": false, "reason": "定位失败：\(error.localizedDescription)"])
    }
}

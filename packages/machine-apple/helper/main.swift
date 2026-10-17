// nibblet-vm: runs one virtual machine with Apple's Virtualization
// framework, for the host bridge's Apple plugin (packages/machine-apple).
// The framework is only open to signed binaries with the virtualization
// entitlement, hence a helper rather than Node.
//
//   nibblet-vm check                       {"supported":…, "macos":…} on stdout
//   nibblet-vm run <vm.json> [--gui]       runs it until it stops
//   nibblet-vm macos-restore-url           the newest macOS this Mac can install
//   nibblet-vm macos-install <bundle> <ipsw> <disk GB>
//
// `run` keeps its VM's agent port (a second virtio serial console, hvc1 in
// a Linux guest, or for a macOS guest a vsock connection on port 1024) on
// a unix socket, one client at a time, for the bridge to relay.
// SIGTERM asks the guest to shut down, and turns it off 30 seconds later
// if it hasn't; SIGINT turns it off at once. It writes how things stand to
// the spec's `state` file and exits when the VM stops.

import AppKit
import Foundation
import Virtualization

struct DiskSpec: Codable {
  let path: String
  let readOnly: Bool
}

struct MacSpec: Codable {
  let hardwareModel: String
  let machineIdentifier: String
  let auxiliaryStorage: String
}

struct VmSpec: Codable {
  let guest: String
  let cpus: Int
  let memoryMb: UInt64
  let disks: [DiskSpec]
  let efiVariables: String?
  let macos: MacSpec?
  let macAddress: String
  let console: String
  let agentSocket: String
  let state: String
}

let agentVsockPort: UInt32 = 1024

let debugging = ProcessInfo.processInfo.environment["NIBBLET_VM_DEBUG"] != nil

func debug(_ message: String) {
  if debugging { FileHandle.standardError.write(Data("nibblet-vm: \(message)\n".utf8)) }
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("nibblet-vm: \(message)\n".utf8))
  exit(2)
}

func say(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func readData(_ path: String) -> Data {
  guard let data = FileManager.default.contents(atPath: path) else { fail("can't read \(path)") }
  return data
}

// The agent's socket: a unix socket the bridge connects to, and the guest's
// end, the console port's pipes or a vsock connection.

final class AgentSocket: @unchecked Sendable {
  /** The guest's end's pipes: kept here, since their handles close when they go. */
  var pipes: [Pipe] = []
  private let lock = NSLock()
  private var client: Int32 = -1
  private var guestWrite: ((Data) -> Void)?
  private let listener: Int32

  init(path: String) {
    unlink(path)
    listener = socket(AF_UNIX, SOCK_STREAM, 0)
    if listener < 0 { fail("socket: \(errno)") }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    if bytes.count >= MemoryLayout.size(ofValue: addr.sun_path) { fail("socket path too long: \(path)") }
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
      raw.copyBytes(from: bytes)
      raw[bytes.count] = 0
    }
    let size = socklen_t(MemoryLayout<sockaddr_un>.size)
    let bound = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, size) }
    }
    if bound != 0 { fail("bind \(path): \(errno)") }
    chmod(path, 0o600)
    if listen(listener, 4) != 0 { fail("listen: \(errno)") }
    Thread.detachNewThread { [self] in acceptLoop() }
  }

  /** Where what the bridge sends goes: the guest's end, once there is one. */
  func setGuest(_ write: @escaping (Data) -> Void) {
    lock.lock()
    guestWrite = write
    lock.unlock()
  }

  /** What the guest sends, to the bridge; dropped while nobody's connected. */
  func fromGuest(_ data: Data) {
    lock.lock()
    let fd = client
    lock.unlock()
    if fd < 0 { return }
    data.withUnsafeBytes { raw in
      var at = 0
      while at < raw.count {
        let n = write(fd, raw.baseAddress!.advanced(by: at), raw.count - at)
        if n <= 0 { break }
        at += n
      }
    }
  }

  private func acceptLoop() {
    while true {
      let fd = accept(listener, nil, nil)
      if fd < 0 { continue }
      lock.lock()
      // A new bridge takes over from the old one.
      if client >= 0 { close(client) }
      client = fd
      lock.unlock()
      Thread.detachNewThread { [self] in readLoop(fd) }
    }
  }

  private func readLoop(_ fd: Int32) {
    var buffer = [UInt8](repeating: 0, count: 65536)
    while true {
      let n = read(fd, &buffer, buffer.count)
      if n <= 0 { break }
      lock.lock()
      let write = guestWrite
      lock.unlock()
      write?(Data(buffer[0..<n]))
    }
    lock.lock()
    if client == fd {
      close(fd)
      client = -1
    }
    lock.unlock()
  }
}

final class VsockAgent: NSObject, VZVirtioSocketListenerDelegate {
  let agent: AgentSocket
  var connection: VZVirtioSocketConnection?

  init(agent: AgentSocket) {
    self.agent = agent
  }

  func listener(
    _ listener: VZVirtioSocketListener,
    shouldAcceptNewConnection connection: VZVirtioSocketConnection,
    from socketDevice: VZVirtioSocketDevice
  ) -> Bool {
    self.connection = connection
    let fd = connection.fileDescriptor
    let agent = self.agent
    agent.setGuest { data in
      data.withUnsafeBytes { raw in
        var at = 0
        while at < raw.count {
          let n = write(fd, raw.baseAddress!.advanced(by: at), raw.count - at)
          if n <= 0 { break }
          at += n
        }
      }
    }
    Thread.detachNewThread {
      var buffer = [UInt8](repeating: 0, count: 65536)
      while true {
        let n = read(fd, &buffer, buffer.count)
        if n <= 0 { break }
        agent.fromGuest(Data(buffer[0..<n]))
      }
    }
    return true
  }
}

// The machine.

func configuration(_ spec: VmSpec, agent: AgentSocket?) throws -> VZVirtualMachineConfiguration {
  let c = VZVirtualMachineConfiguration()
  c.cpuCount = max(
    VZVirtualMachineConfiguration.minimumAllowedCPUCount,
    min(spec.cpus, VZVirtualMachineConfiguration.maximumAllowedCPUCount))
  c.memorySize = max(
    VZVirtualMachineConfiguration.minimumAllowedMemorySize,
    min(spec.memoryMb * 1024 * 1024, VZVirtualMachineConfiguration.maximumAllowedMemorySize))

  if spec.guest == "macos" {
    #if arch(arm64)
      guard let mac = spec.macos else { fail("a macOS guest needs its platform files") }
      let platform = VZMacPlatformConfiguration()
      guard let model = VZMacHardwareModel(dataRepresentation: readData(mac.hardwareModel)),
        model.isSupported
      else { fail("this Mac can't run that macOS") }
      platform.hardwareModel = model
      guard
        let id = VZMacMachineIdentifier(dataRepresentation: readData(mac.machineIdentifier))
      else { fail("bad machine identifier") }
      platform.machineIdentifier = id
      platform.auxiliaryStorage = VZMacAuxiliaryStorage(
        url: URL(fileURLWithPath: mac.auxiliaryStorage))
      c.platform = platform
      c.bootLoader = VZMacOSBootLoader()
      let graphics = VZMacGraphicsDeviceConfiguration()
      graphics.displays = [
        VZMacGraphicsDisplayConfiguration(widthInPixels: 1920, heightInPixels: 1200, pixelsPerInch: 80)
      ]
      c.graphicsDevices = [graphics]
      c.keyboards = [VZUSBKeyboardConfiguration()]
      c.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
    #else
      fail("macOS guests need Apple silicon")
    #endif
  } else {
    guard let path = spec.efiVariables else { fail("a Linux guest needs an EFI variable store") }
    let url = URL(fileURLWithPath: path)
    let loader = VZEFIBootLoader()
    loader.variableStore =
      FileManager.default.fileExists(atPath: path)
      ? VZEFIVariableStore(url: url)
      : try VZEFIVariableStore(creatingVariableStoreAt: url)
    c.bootLoader = loader
    c.platform = VZGenericPlatformConfiguration()
    // Something to draw on, for --gui; the nibblet's own display is in software.
    let graphics = VZVirtioGraphicsDeviceConfiguration()
    graphics.scanouts = [VZVirtioGraphicsScanoutConfiguration(widthInPixels: 1280, heightInPixels: 800)]
    c.graphicsDevices = [graphics]
    c.keyboards = [VZUSBKeyboardConfiguration()]
    c.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
  }

  c.storageDevices = try spec.disks.map { disk in
    VZVirtioBlockDeviceConfiguration(
      attachment: try VZDiskImageStorageDeviceAttachment(
        url: URL(fileURLWithPath: disk.path), readOnly: disk.readOnly,
        cachingMode: .automatic, synchronizationMode: .full))
  }

  let network = VZVirtioNetworkDeviceConfiguration()
  network.attachment = VZNATNetworkDeviceAttachment()
  guard let mac = VZMACAddress(string: spec.macAddress) else { fail("bad MAC address") }
  network.macAddress = mac
  c.networkDevices = [network]
  c.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
  // No memory balloon: with one, Linux guests on recent Macs report free
  // pages the host then takes back while they're still in use.

  // The console, to a file, for saying why it stopped.
  FileManager.default.createFile(atPath: spec.console, contents: nil)
  guard let log = FileHandle(forWritingAtPath: spec.console) else { fail("can't write \(spec.console)") }
  log.seekToEndOfFile()
  let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
  serial.attachment = VZFileHandleSerialPortAttachment(
    fileHandleForReading: FileHandle(forReadingAtPath: "/dev/null"), fileHandleForWriting: log)
  c.serialPorts = [serial]

  // The agent's own port: a serial console of its own, as the console's
  // is (a named port on a multiport console carries nothing here).
  if let agent {
    let toGuest = Pipe()
    let fromGuest = Pipe()
    agent.pipes = [toGuest, fromGuest]
    let port = VZVirtioConsoleDeviceSerialPortConfiguration()
    port.attachment = VZFileHandleSerialPortAttachment(
      fileHandleForReading: toGuest.fileHandleForReading,
      fileHandleForWriting: fromGuest.fileHandleForWriting)
    c.serialPorts.append(port)
    let write = toGuest.fileHandleForWriting
    agent.setGuest { data in
      debug("to guest: \(data.count) bytes")
      write.write(data)
    }
    fromGuest.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      debug("from guest: \(data.count) bytes")
      if !data.isEmpty { agent.fromGuest(data) }
    }
    // For guests whose kernel has vsock but no virtio console (macOS).
    c.socketDevices = [VZVirtioSocketDeviceConfiguration()]
  }

  try c.validate()
  return c
}

final class Runner: NSObject, VZVirtualMachineDelegate {
  let spec: VmSpec
  let machine: VZVirtualMachine
  let vsock: VsockAgent?
  var stopping = false

  init(spec: VmSpec, gui: Bool) throws {
    self.spec = spec
    let agent = AgentSocket(path: spec.agentSocket)
    let config = try configuration(spec, agent: agent)
    machine = VZVirtualMachine(configuration: config)
    vsock = VsockAgent(agent: agent)
    super.init()
    machine.delegate = self
    if let device = machine.socketDevices.first as? VZVirtioSocketDevice, let vsock {
      let listener = VZVirtioSocketListener()
      listener.delegate = vsock
      device.setSocketListener(listener, forPort: agentVsockPort)
    }
    if gui { showWindow() }
  }

  func record(_ state: String, _ error: String? = nil) {
    var body: [String: Any] = ["state": state, "pid": getpid(), "at": Date().timeIntervalSince1970]
    if let error { body["error"] = error }
    if let data = try? JSONSerialization.data(withJSONObject: body) {
      try? data.write(to: URL(fileURLWithPath: spec.state), options: .atomic)
    }
    say(body)
  }

  func start() {
    record("starting")
    machine.start { result in
      switch result {
      case .success: self.record("running")
      case .failure(let error):
        self.record("stopped", error.localizedDescription)
        exit(1)
      }
    }
  }

  func requestStop() {
    if stopping { return }
    stopping = true
    if machine.canRequestStop { try? machine.requestStop() }
    DispatchQueue.main.asyncAfter(deadline: .now() + 30) { self.forceStop() }
  }

  func forceStop() {
    guard machine.canStop else {
      record("stopped")
      exit(0)
    }
    machine.stop { error in
      self.record("stopped", error?.localizedDescription)
      exit(0)
    }
  }

  func guestDidStop(_ virtualMachine: VZVirtualMachine) {
    record("stopped")
    exit(0)
  }

  func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
    record("stopped", error.localizedDescription)
    exit(1)
  }

  var window: NSWindow?

  func showWindow() {
    let view = VZVirtualMachineView()
    view.virtualMachine = machine
    view.capturesSystemKeys = true
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "Nibblet"
    window.contentView = view
    window.center()
    window.makeKeyAndOrderFront(nil)
    self.window = window
    NSApp.activate(ignoringOtherApps: true)
  }
}

func run(_ path: String, gui: Bool) -> Never {
  let spec: VmSpec
  do {
    spec = try JSONDecoder().decode(VmSpec.self, from: readData(path))
  } catch {
    fail("bad spec \(path): \(error)")
  }
  let app = NSApplication.shared
  app.setActivationPolicy(gui ? .regular : .prohibited)
  let runner: Runner
  do {
    runner = try Runner(spec: spec, gui: gui)
  } catch {
    fail("can't make the machine: \(error.localizedDescription)")
  }
  signal(SIGTERM, SIG_IGN)
  signal(SIGINT, SIG_IGN)
  let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
  term.setEventHandler { runner.requestStop() }
  term.resume()
  let int = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
  int.setEventHandler { runner.forceStop() }
  int.resume()
  runner.start()
  withExtendedLifetime([term, int]) { app.run() }
  exit(0)
}

// macOS guests: the restore image, and installing from it.

func restoreURL() -> Never {
  #if arch(arm64)
    VZMacOSRestoreImage.fetchLatestSupported { result in
      switch result {
      case .success(let image):
        say([
          "url": image.url.absoluteString, "build": image.buildVersion,
          "version": image.operatingSystemVersion.majorVersion,
        ])
        exit(0)
      case .failure(let error): fail(error.localizedDescription)
      }
    }
    dispatchMain()
  #else
    fail("macOS guests need Apple silicon")
  #endif
}

func install(bundle: String, ipsw: String, diskGb: UInt64) -> Never {
  #if arch(arm64)
    let dir = URL(fileURLWithPath: bundle)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    VZMacOSRestoreImage.load(from: URL(fileURLWithPath: ipsw)) { result in
      DispatchQueue.main.async {
        let image: VZMacOSRestoreImage
        switch result {
        case .success(let loaded): image = loaded
        case .failure(let error): fail("can't read the restore image: \(error.localizedDescription)")
        }
        guard let requirements = image.mostFeaturefulSupportedConfiguration,
          requirements.hardwareModel.isSupported
        else { fail("this Mac can't run that macOS") }
        let model = requirements.hardwareModel
        let id = VZMacMachineIdentifier()
        let paths = MacSpec(
          hardwareModel: dir.appendingPathComponent("hardware-model").path,
          machineIdentifier: dir.appendingPathComponent("machine-identifier").path,
          auxiliaryStorage: dir.appendingPathComponent("aux.img").path)
        do {
          try model.dataRepresentation.write(to: URL(fileURLWithPath: paths.hardwareModel))
          try id.dataRepresentation.write(to: URL(fileURLWithPath: paths.machineIdentifier))
          _ = try VZMacAuxiliaryStorage(
            creatingStorageAt: URL(fileURLWithPath: paths.auxiliaryStorage), hardwareModel: model,
            options: [.allowOverwrite])
          let disk = dir.appendingPathComponent("disk.img").path
          FileManager.default.createFile(atPath: disk, contents: nil)
          let handle = FileHandle(forWritingAtPath: disk)
          try handle?.truncate(atOffset: diskGb * 1024 * 1024 * 1024)
          try handle?.close()
          let spec = VmSpec(
            guest: "macos",
            cpus: max(requirements.minimumSupportedCPUCount, 4),
            memoryMb: max(requirements.minimumSupportedMemorySize / 1024 / 1024, 8192),
            disks: [DiskSpec(path: disk, readOnly: false)], efiVariables: nil, macos: paths,
            macAddress: VZMACAddress.randomLocallyAdministered().string,
            console: dir.appendingPathComponent("install.log").path,
            agentSocket: dir.appendingPathComponent("install.sock").path,
            state: dir.appendingPathComponent("install.state").path)
          let machine = VZVirtualMachine(configuration: try configuration(spec, agent: nil))
          let installer = VZMacOSInstaller(virtualMachine: machine, restoringFromImageAt: image.url)
          let watch = installer.progress.observe(\.fractionCompleted, options: [.new]) { p, _ in
            say(["progress": p.fractionCompleted])
          }
          installer.install { result in
            withExtendedLifetime(watch) {}
            switch result {
            case .success:
              say(["done": true])
              exit(0)
            case .failure(let error): fail("installing failed: \(error.localizedDescription)")
            }
          }
        } catch {
          fail(error.localizedDescription)
        }
      }
    }
    dispatchMain()
  #else
    fail("macOS guests need Apple silicon")
  #endif
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "check":
  #if arch(arm64)
    let macos = true
  #else
    let macos = false
  #endif
  say(["supported": VZVirtualMachine.isSupported, "macos": macos])
case "run":
  guard args.count > 2 else { fail("usage: nibblet-vm run <vm.json> [--gui]") }
  run(args[2], gui: args.contains("--gui"))
case "macos-restore-url":
  restoreURL()
case "macos-install":
  guard args.count > 4, let gb = UInt64(args[4]) else {
    fail("usage: nibblet-vm macos-install <bundle> <ipsw> <disk GB>")
  }
  install(bundle: args[2], ipsw: args[3], diskGb: gb)
default:
  fail("usage: nibblet-vm check | run <vm.json> [--gui] | macos-restore-url | macos-install …")
}

import Foundation
import Darwin

// A completed subprocess starts this helper; HTTP keeps the search-service warm even in Tinycast,
// whose child_process shim buffers output until exit. Never listens outside the loopback interface.
struct BridgeError: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}

func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
func option(_ key: String) -> String? {
    guard let i = CommandLine.arguments.firstIndex(of: key), i + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[i + 1]
}

final class Engine {
    let executable: String, index: String
    var process: Process?, input: FileHandle?, output: FileHandle?
    var buffer = Data()
    var sequence = 0
    var indexSignature: String?
    var modelSignature: String?
    init(_ executable: String, _ index: String) { self.executable = executable; self.index = index }
    func stop() {
        if let process, process.isRunning { process.terminate() }
        try? input?.close(); try? output?.close()
        process = nil; input = nil; output = nil; buffer.removeAll(); indexSignature = nil
    }
    func start() throws {
        guard process?.isRunning != true else { return }
        stop()
        guard FileManager.default.fileExists(atPath: index + "/index.sqlite") else {
            throw BridgeError("Open DigUp and choose folders first. Its content index is not ready yet.")
        }
        let p = Process(), stdin = Pipe(), stdout = Pipe()
        p.executableURL = URL(fileURLWithPath: executable)
        p.arguments = ["search-service", "--index", index, "--encoder-idle", "120"]
        var env = ProcessInfo.processInfo.environment
        if let models = UserDefaults(suiteName: "com.abdurrahim.DigUp")?.string(forKey: "modelsDir") {
            env["DIGUP_MODELS"] = (models as NSString).expandingTildeInPath
        }
        p.environment = env
        p.standardInput = stdin; p.standardOutput = stdout; p.standardError = FileHandle.nullDevice
        try p.run()
        process = p; input = stdin.fileHandleForWriting; output = stdout.fileHandleForReading
    }
    func request(_ fields: [String: Any]) throws -> [String: Any] {
        try start()
        sequence += 1
        var fields = fields; fields["id"] = sequence
        try input!.write(contentsOf: json(fields) + Data([10]))
        let deadline = Date().addingTimeInterval(25)
        while Date() < deadline {
            if let end = buffer.firstIndex(of: 10) {
                let line = buffer.prefix(upTo: end)
                buffer.removeSubrange(...end)
                guard let reply = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                      reply["id"] as? Int == sequence else { continue }
                if let error = reply["error"] as? String { throw BridgeError(error) }
                return reply
            }
            var descriptor = pollfd(fd: output!.fileDescriptor, events: Int16(POLLIN), revents: 0)
            let ready = poll(&descriptor, 1, 100)
            if ready > 0 {
                let chunk = output!.availableData
                guard !chunk.isEmpty else { stop(); throw BridgeError("DigUp's search helper exited. Try searching again.") }
                buffer.append(chunk)
                guard buffer.count < 16_000_000 else { stop(); throw BridgeError("Search response too large") }
            }
        }
        stop()
        throw BridgeError("DigUp took too long to respond. Try again after indexing finishes.")
    }
    func configure() throws {
        let defaults = UserDefaults(suiteName: "com.abdurrahim.DigUp")!
        let models = defaults.string(forKey: "modelsDir") ?? ProcessInfo.processInfo.environment["DIGUP_MODELS"]
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/DigUp/Models").path
        let signature = ["embeddinggemma-2-Q8_0.gguf", "mmproj-embeddinggemma-2-Q8_0.gguf"].map { name -> String in
            let attributes = try? FileManager.default.attributesOfItem(atPath: (models as NSString).expandingTildeInPath + "/" + name)
            return "\(models)|\(attributes?[.modificationDate] as? Date ?? .distantPast)|\(attributes?[.size] ?? 0)"
        }.joined(separator: ";")
        if modelSignature != nil, modelSignature != signature { stop() }
        modelSignature = signature
        func paths(_ key: String) -> [String] {
            defaults.stringArray(forKey: key) ?? defaults.string(forKey: key)?.components(separatedBy: ":") ?? []
        }
        _ = try request(["op": "folders", "roots": paths("roots"), "skipped": paths("excludedFolders"),
                         "types": paths("excludedTypes"), "code_roots": paths("codeRoots"),
                         "code_skipped": paths("codeExcludedFolders")])
    }

    func reloadIfChanged() throws {
        let signature = ["index.sqlite", "index.sqlite-wal", "code.sqlite", "code.sqlite-wal"].map { name -> String in
            let attributes = try? FileManager.default.attributesOfItem(atPath: index + "/" + name)
            return "\(attributes?[.modificationDate] as? Date ?? .distantPast)|\(attributes?[.size] ?? 0)"
        }.joined(separator: ";")
        if signature != indexSignature {
            _ = try request(["op": "reload"])
            indexSignature = signature
        }
    }
}

final class Shutdown: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false
    func request() { lock.lock(); stopped = true; lock.unlock() }
    var requested: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
}

func receive(_ client: Int32) throws -> (String, [String: String], Data) {
    var bytes = Data(), chunk = [UInt8](repeating: 0, count: 8192)
    let delimiter = Data("\r\n\r\n".utf8)
    while bytes.count < 1_048_576 {
        let count = recv(client, &chunk, chunk.count, 0)
        guard count > 0 else { throw BridgeError("Incomplete HTTP request") }
        bytes.append(contentsOf: chunk.prefix(count))
        guard let split = bytes.range(of: delimiter), let header = String(data: bytes[..<split.lowerBound], encoding: .utf8)
        else { continue }
        let lines = header.components(separatedBy: "\r\n")
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[String(line[..<colon]).lowercased()] = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
        }
        guard headers["transfer-encoding"] == nil, let length = Int(headers["content-length"] ?? "0"),
              length >= 0, length <= 1_000_000 else { throw BridgeError("Invalid Content-Length") }
        if bytes.count >= split.upperBound + length {
            return (lines[0], headers, bytes.subdata(in: split.upperBound..<(split.upperBound + length)))
        }
    }
    throw BridgeError("Request too large")
}

func respond(_ client: Int32, _ status: Int, _ fields: [String: Any]) {
    guard let body = try? json(fields) else { return }
    var bytes = Data("HTTP/1.1 \(status) \(status == 200 ? "OK" : "Error")\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n".utf8)
    bytes.append(body)
    bytes.withUnsafeBytes { raw in
        var sent = 0
        while sent < raw.count {
            let n = send(client, raw.baseAddress!.advanced(by: sent), raw.count - sent, 0)
            if n <= 0 { break }; sent += n
        }
    }
}

func serve(state: URL, executable: String, index: String, idle: Double) throws {
    let server = socket(AF_INET, SOCK_STREAM, 0)
    guard server >= 0 else { throw BridgeError("Could not create local socket") }
    defer { close(server) }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1"); address.sin_port = 0
    let bound = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(server, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard bound == 0, listen(server, 16) == 0 else { throw BridgeError("Could not listen on loopback") }
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(server, $0, &length) }
    }
    let token = UUID().uuidString + UUID().uuidString
    let info: [String: Any] = ["port": Int(UInt16(bigEndian: address.sin_port)), "token": token,
                              "pid": Int(getpid()), "engine": executable, "index": index, "version": 1]
    let discovery = state.appendingPathComponent("bridge.json")
    try json(info).write(to: discovery, options: .atomic)
    chmod(discovery.path, 0o600)
    let engine = Engine(executable, index)
    let shutdown = Shutdown()
    signal(SIGTERM, SIG_IGN)
    let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    termination.setEventHandler { shutdown.request() }
    termination.resume()
    defer {
        engine.stop()
        // A replacement may already have published its own descriptor.
        if let data = try? Data(contentsOf: discovery), let saved = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           saved["token"] as? String == token { try? FileManager.default.removeItem(at: discovery) }
    }
    var lastRequest = Date()
    while !shutdown.requested && Date().timeIntervalSince(lastRequest) < idle {
        var fd = pollfd(fd: server, events: Int16(POLLIN), revents: 0)
        guard poll(&fd, 1, 1000) > 0 else { continue }
        let client = accept(server, nil, nil)
        guard client >= 0 else { continue }
        defer { close(client) }
        var timeout = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        do {
            let (line, headers, body) = try receive(client)
            guard headers["authorization"] == "Bearer " + token, headers["origin"] == nil else {
                respond(client, 403, ["error": "Unauthorized"]); continue
            }
            guard line == "POST /rpc HTTP/1.1", let fields = try JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let op = fields["op"] as? String,
                  ["health", "status", "search", "text", "render", "prewarm"].contains(op) else {
                respond(client, 400, ["error": "Invalid request"]); continue
            }
            lastRequest = Date()
            if op == "health" { respond(client, 200, ["ok": true, "version": 1]); continue }
            var request = fields
            if op == "search" {
                guard let query = fields["q"] as? String, query.count <= 4096 else { throw BridgeError("Invalid query") }
                try engine.configure()
                try engine.reloadIfChanged()
                request["limit"] = min(max(fields["limit"] as? Int ?? 50, 1), 200)
            }
            respond(client, 200, try engine.request(request))
        } catch { respond(client, 500, ["error": String(describing: error)]) }
    }
}

func healthy(_ info: [String: Any]) -> Bool {
    guard let port = info["port"] as? Int, let token = info["token"] as? String, port > 0, port < 65536 else { return false }
    let semaphore = DispatchSemaphore(value: 0)
    var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/rpc")!)
    request.httpMethod = "POST"; request.httpBody = try? json(["op": "health"])
    request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization"); request.timeoutInterval = 2
    var ok = false
    URLSession.shared.dataTask(with: request) { data, response, error in
        ok = error == nil && (response as? HTTPURLResponse)?.statusCode == 200
        semaphore.signal()
    }.resume()
    _ = semaphore.wait(timeout: .now() + 3)
    return ok
}

do {
    signal(SIGPIPE, SIG_IGN)
    guard let path = option("--state"), let executable = option("--engine"), let index = option("--index") else {
        throw BridgeError("Usage: digup-bridge --start|--serve --state DIR --engine PATH --index DIR [--idle SECONDS]")
    }
    let state = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    chmod(state.path, 0o700)
    if CommandLine.arguments.contains("--serve") {
        try serve(state: state, executable: executable, index: index, idle: option("--idle").flatMap(Double.init) ?? 300)
    } else {
        guard CommandLine.arguments.contains("--start") else { throw BridgeError("Expected --start or --serve") }
        let lock = open(state.appendingPathComponent("startup.lock").path, O_CREAT | O_RDWR, 0o600)
        guard lock >= 0, flock(lock, LOCK_EX) == 0 else { throw BridgeError("Could not lock bridge startup") }
        defer { flock(lock, LOCK_UN); close(lock) }
        let discovery = state.appendingPathComponent("bridge.json")
        if let data = try? Data(contentsOf: discovery), let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           info["engine"] as? String == executable, info["index"] as? String == index, healthy(info) {
            print(String(data: data, encoding: .utf8)! )
        } else {
            try? FileManager.default.removeItem(at: discovery)
            let process = Process()
            process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
            process.arguments = ["--serve", "--state", path, "--engine", executable, "--index", index,
                                 "--idle", option("--idle") ?? "300"]
            process.standardInput = FileHandle.nullDevice; process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try process.run()
            var result: Data?
            for _ in 0..<100 {
                if let data = try? Data(contentsOf: discovery) { result = data; break }
                if !process.isRunning { break }; Thread.sleep(forTimeInterval: 0.05)
            }
            guard let result else { if process.isRunning { process.terminate() }; throw BridgeError("Local search bridge did not start") }
            print(String(data: result, encoding: .utf8)!)
        }
    }
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8)); exit(1)
}

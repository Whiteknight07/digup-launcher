"""Exercise the compiled native bridge with an isolated, model-free fixture engine."""
import concurrent.futures
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request

BRIDGE = Path(__file__).resolve().parents[1] / "assets/digup-bridge"


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="digup-bridge-")
        self.root = Path(self.temp.name)
        (self.root / "index").mkdir()
        (self.root / "index/index.sqlite").touch()
        self.engine = self.root / "engine"
        self.engine.write_text('''#!/usr/bin/env python3
import json, os, sys
print(json.dumps({"event": "ready"}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    if request.get("q") == "exit": sys.exit(1)
    reply = {"id": request["id"], "ok": True, "engine_pid": os.getpid()}
    if request["op"] == "search":
        reply.update(hits=[{"path": "/tmp/lease.pdf", "kind": "pdf", "segment": "page", "loc": 4}], meaning=True, strong=1)
    if request["op"] == "text": reply["text"] = "the pets clause"
    print(json.dumps(reply), flush=True)
''')
        self.engine.chmod(0o755)
        self.info = self.start()

    def start(self, idle="3"):
        environment = {**os.environ, "DIGUP_MODELS": str(self.root / "models")}
        output = subprocess.check_output([str(BRIDGE), "--start", "--state", str(self.root / "state"),
                                          "--engine", str(self.engine), "--index", str(self.root / "index"), "--idle", idle], env=environment)
        return json.loads(output)

    def call(self, fields, token=None, origin=None):
        request = urllib.request.Request(f'http://127.0.0.1:{self.info["port"]}/rpc',
                                         data=json.dumps(fields).encode(), method="POST")
        request.add_header("Authorization", "Bearer " + (token if token is not None else self.info["token"]))
        if origin: request.add_header("Origin", origin)
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)

    def tearDown(self):
        try: os.kill(self.info["pid"], signal.SIGTERM)
        except ProcessLookupError: pass
        # SIGTERM is intentionally tested too; terminate the fixture engine if still present.
        for pid in getattr(self, "engine_pids", []):
            try: os.kill(pid, signal.SIGTERM)
            except ProcessLookupError: pass
        self.temp.cleanup()

    def test_warm_engine_and_concurrent_start(self):
        first = self.call({"op": "search", "q": "pets", "limit": 999})
        second = self.call({"op": "search", "q": "lease"})
        self.engine_pids = [first["engine_pid"]]
        self.assertEqual(first["engine_pid"], second["engine_pid"])
        self.assertEqual(first["hits"][0]["loc"], 4)
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            replies = list(pool.map(lambda _: self.start(), range(3)))
        self.assertTrue(all(reply["pid"] == self.info["pid"] for reply in replies))
        self.assertEqual((self.root / "state/bridge.json").stat().st_mode & 0o777, 0o600)

    def test_authentication_origin_and_operation(self):
        for fields, token, origin, status in [({"op": "health"}, "wrong", None, 403),
                                               ({"op": "health"}, None, "https://example.com", 403),
                                               ({"op": "quit"}, None, None, 400)]:
            with self.assertRaises(urllib.error.HTTPError) as failure:
                self.call(fields, token=token, origin=origin)
            self.assertEqual(failure.exception.code, status)
            failure.exception.close()

    def test_fragmented_http(self):
        body = json.dumps({"op": "health"}).encode()
        header = f'POST /rpc HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {self.info["token"]}\r\nContent-Length: {len(body)}\r\n\r\n'.encode()
        with socket.create_connection(("127.0.0.1", self.info["port"]), timeout=5) as client:
            for piece in [header[:12], header[12:], body[:3], body[3:]]:
                client.sendall(piece)
            response = b""
            while chunk := client.recv(4096): response += chunk
        self.assertIn(b"200 OK", response)
        self.assertTrue(json.loads(response.split(b"\r\n\r\n", 1)[1])["ok"])

    def test_idle_restart(self):
        original = self.info["pid"]
        time.sleep(4.1)
        self.info = self.start()
        self.assertNotEqual(self.info["pid"], original)
        self.assertTrue(self.call({"op": "health"})["ok"])

    def test_engine_failure_recovers(self):
        with self.assertRaises(urllib.error.HTTPError) as failure:
            self.call({"op": "search", "q": "exit"})
        self.assertEqual(failure.exception.code, 500)
        failure.exception.close()
        reply = self.call({"op": "search", "q": "lease"})
        self.engine_pids = [reply["engine_pid"]]
        self.assertEqual(reply["hits"][0]["path"], "/tmp/lease.pdf")

    def test_newly_downloaded_model_restarts_encoder(self):
        first = self.call({"op": "search", "q": "lease"})
        (self.root / "models").mkdir()
        (self.root / "models/embeddinggemma-2-Q8_0.gguf").write_bytes(b"model fixture")
        second = self.call({"op": "search", "q": "lease"})
        self.engine_pids = [first["engine_pid"], second["engine_pid"]]
        self.assertNotEqual(first["engine_pid"], second["engine_pid"])

    def test_missing_index_remains_recoverable(self):
        (self.root / "index/index.sqlite").unlink()
        with self.assertRaises(urllib.error.HTTPError) as failure:
            self.call({"op": "search", "q": "lease"})
        self.assertIn("choose folders", failure.exception.read().decode())
        failure.exception.close()
        (self.root / "index/index.sqlite").touch()
        reply = self.call({"op": "search", "q": "lease"})
        self.engine_pids = [reply["engine_pid"]]
        self.assertTrue(reply["meaning"])


if __name__ == "__main__": unittest.main(verbosity=2)

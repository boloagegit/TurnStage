"""Integration checks for the dependency-free Web static/SSE proxy."""

import importlib.util
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, HTTPServer
import os
from pathlib import Path
import tempfile
from threading import Event, Thread
from socketserver import ThreadingMixIn
import unittest
from urllib.parse import urlsplit


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "serve.py"
SPEC = importlib.util.spec_from_file_location("turnstage_serve", str(SCRIPT))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class UpstreamServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class UpstreamHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        self.server.received = (self.path, self.headers.get("Authorization"), body)
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"{}")

    def do_GET(self):
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/chat")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        self._send_chunk(b"data: first\n\n")
        self.server.first_sent.set()
        self.server.release.wait(5)
        self._send_chunk(b"data: second\n\n")
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def _send_chunk(self, value):
        self.wfile.write("{:X}\r\n".format(len(value)).encode("ascii") + value + b"\r\n")
        self.wfile.flush()

    def log_message(self, format_string, *args):
        pass


class ServeWebTests(unittest.TestCase):
    def setUp(self):
        self.previous_directory = os.getcwd()
        self.temporary = tempfile.TemporaryDirectory()
        os.chdir(self.temporary.name)
        Path("index.html").write_text("TurnStage page", encoding="utf-8")
        Path("profiles").mkdir()
        self.upstream = UpstreamServer(("127.0.0.1", 0), UpstreamHandler)
        self.upstream.first_sent = Event()
        self.upstream.release = Event()
        self.upstream_thread = Thread(target=self.upstream.serve_forever, daemon=True)
        self.upstream_thread.start()
        self.web = MODULE.ThreadingServer(("127.0.0.1", 0), MODULE.Handler)
        self.web.upstream = urlsplit("http://127.0.0.1:{}".format(self.upstream.server_port))
        self.web_thread = Thread(target=self.web.serve_forever, daemon=True)
        self.web_thread.start()

    def tearDown(self):
        self.upstream.release.set()
        self.web.shutdown()
        self.web.server_close()
        self.upstream.shutdown()
        self.upstream.server_close()
        self.web_thread.join(timeout=3)
        self.upstream_thread.join(timeout=3)
        os.chdir(self.previous_directory)
        self.temporary.cleanup()

    def connection(self):
        return HTTPConnection("127.0.0.1", self.web.server_port, timeout=3)

    def test_serves_web_and_forwards_body_path_and_auth_to_fixed_upstream(self):
        connection = self.connection()
        connection.request("GET", "/")
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.read(), b"TurnStage page")
        connection.close()

        connection = self.connection()
        connection.request("POST", "/api/chat?model=1", body=b'{"text":"hello"}', headers={
            "Authorization": "Bearer example", "Content-Type": "application/json",
        })
        response = connection.getresponse()
        self.assertEqual(response.status, 201)
        self.assertEqual(response.read(), b"{}")
        self.assertEqual(self.upstream.received, ("/chat?model=1", "Bearer example", b'{"text":"hello"}'))
        connection.close()

    def test_sse_first_event_arrives_before_upstream_finishes(self):
        connection = self.connection()
        connection.request("GET", "/api/events")
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Type"), "text/event-stream")
        self.assertIsNone(response.getheader("Transfer-Encoding"))
        self.assertTrue(self.upstream.first_sent.wait(2))
        self.assertEqual(response.read1(64 * 1024), b"data: first\n\n")
        self.upstream.release.set()
        self.assertEqual(response.read(), b"data: second\n\n")
        connection.close()

    def test_missing_upstream_returns_502_without_static_fallback(self):
        self.web.upstream = urlsplit("http://127.0.0.1:1")
        connection = self.connection()
        connection.request("GET", "/api/events")
        response = connection.getresponse()
        self.assertEqual(response.status, 502)
        response.read()
        connection.close()

    def test_unconfigured_proxy_is_disabled(self):
        self.web.upstream = None
        connection = self.connection()
        connection.request("POST", "/api/chat", body=b'{}', headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        self.assertEqual(response.status, 503)
        self.assertIn(b"API proxy is not configured", response.read())
        connection.close()

    def test_upstream_redirect_stays_on_the_web_origin(self):
        connection = self.connection()
        connection.request("GET", "/api/redirect")
        response = connection.getresponse()
        self.assertEqual(response.status, 302)
        self.assertEqual(response.getheader("Location"), "/api/chat")
        response.read()
        connection.close()

    def test_directory_listing_and_non_api_write_are_disabled(self):
        connection = self.connection()
        connection.request("GET", "/profiles/")
        response = connection.getresponse()
        self.assertEqual(response.status, 403)
        response.read()
        connection.close()

        connection = self.connection()
        connection.request("POST", "/index.html", body=b"overwrite")
        response = connection.getresponse()
        self.assertEqual(response.status, 405)
        response.read()
        self.assertEqual(Path("index.html").read_text(encoding="utf-8"), "TurnStage page")
        connection.close()


if __name__ == "__main__":
    unittest.main()

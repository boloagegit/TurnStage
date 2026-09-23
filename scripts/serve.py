#!/usr/bin/env python3
"""Serve TurnStage Web with an optional same-origin /api/ proxy.

Requires only Python 3.6+ standard-library modules. Run this file from the
extracted Web ZIP directory (the directory containing index.html).
"""

import argparse
from http.client import HTTPConnection, HTTPException
from http.server import HTTPServer, SimpleHTTPRequestHandler
import os
from pathlib import Path
import socket
from socketserver import TCPServer, ThreadingMixIn
import sys
from urllib.parse import urlsplit


MAX_REQUEST_BYTES = 16 * 1024 * 1024
HOP_HEADERS = frozenset((
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "host", "expect",
    "proxy-connection",
))


class ThreadingServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def server_bind(self):
        # HTTPServer normally performs a reverse-DNS lookup here. This static
        # server does not need it, and a broken DNS resolver can stall startup.
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self._route()

    def do_HEAD(self):
        self._route()

    def do_POST(self):
        self._route()

    def do_PUT(self):
        self._route()

    def do_PATCH(self):
        self._route()

    def do_DELETE(self):
        self._route()

    def do_OPTIONS(self):
        self._route()

    def _route(self):
        if self.path == "/api" or self.path.startswith("/api/") or self.path.startswith("/api?"):
            self._proxy()
        elif self.command in ("GET", "HEAD"):
            if self.path.split("?", 1)[0] == "/":
                self.path = "/index.html"
            super().do_GET() if self.command == "GET" else super().do_HEAD()
        else:
            self.send_error(405, "Only /api/ accepts this method")

    def _proxy(self):
        upstream = self.server.upstream
        if upstream is None:
            self.send_error(503, "API proxy is not configured")
            self.close_connection = True
            return
        if self.headers.get("Transfer-Encoding"):
            self.send_error(501, "Chunked request bodies are not supported")
            self.close_connection = True
            return
        raw_length = self.headers.get("Content-Length", "0")
        try:
            length = int(raw_length)
        except ValueError:
            self.send_error(400, "Invalid Content-Length")
            self.close_connection = True
            return
        if length < 0 or length > MAX_REQUEST_BYTES:
            self.send_error(413, "Request body is too large")
            self.close_connection = True
            return

        body = self.rfile.read(length) if length else None
        target = self.path[4:] or "/"
        if target.startswith("?"):
            target = "/" + target
        if not target.startswith("/") or target.startswith("//"):
            self.send_error(400, "Invalid API path")
            return

        connection = HTTPConnection(upstream.hostname, upstream.port, timeout=300)
        request_hop = HOP_HEADERS | set(token.strip().lower() for token in self.headers.get("Connection", "").split(","))
        headers = {key: value for key, value in self.headers.items() if key.lower() not in request_hop}
        headers["Host"] = upstream.netloc
        headers["Connection"] = "close"
        headers["Content-Length"] = str(length)
        response_started = False
        try:
            connection.request(self.command, target, body=body, headers=headers)
            response = connection.getresponse()
            self.send_response_only(response.status, response.reason)
            response_hop = HOP_HEADERS | set(token.strip().lower() for token in response.getheader("Connection", "").split(","))
            for key, value in response.getheaders():
                if key.lower() == "location":
                    redirect = urlsplit(value)
                    if value.startswith("/") and not value.startswith("//"):
                        value = "/api" + value
                    elif redirect.scheme == "http" and redirect.netloc == upstream.netloc:
                        value = "/api" + (redirect.path or "/")
                        if redirect.query:
                            value += "?" + redirect.query
                        if redirect.fragment:
                            value += "#" + redirect.fragment
                if key.lower() not in response_hop:
                    self.send_header(key, value)
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()
            response_started = True
            if self.command != "HEAD":
                while True:
                    chunk = response.read1(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except (OSError, HTTPException, socket.timeout) as error:
            if not response_started:
                self.send_error(502, "API upstream is unavailable")
            else:
                self.close_connection = True
            print("API proxy error: {}".format(type(error).__name__), file=sys.stderr)
        finally:
            connection.close()

    def list_directory(self, path):
        self.send_error(403, "Directory listing is disabled")
        return None

    def log_message(self, format_string, *args):
        # Default http.server logging includes full URLs, which may contain tokens.
        return


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--port",
        type=int,
        default=os.environ.get("TURNSTAGE_WEB_PORT", "8000"),
        help="Web listen port (env: TURNSTAGE_WEB_PORT; default: 8000)",
    )
    parser.add_argument(
        "--bind",
        default=os.environ.get("TURNSTAGE_WEB_BIND", "127.0.0.1"),
        help="Web listen address (env: TURNSTAGE_WEB_BIND; default: 127.0.0.1)",
    )
    parser.add_argument(
        "--upstream",
        default=os.environ.get("TURNSTAGE_API_UPSTREAM"),
        help="Optional HTTP origin for /api/ (env: TURNSTAGE_API_UPSTREAM)",
    )
    args = parser.parse_args(argv)
    upstream = None
    if args.upstream:
        upstream = urlsplit(args.upstream)
        try:
            upstream_port = upstream.port
        except ValueError:
            parser.error("--upstream needs a valid port")
        if upstream.scheme != "http" or not upstream.hostname or not upstream_port or upstream.username or upstream.password or upstream.path not in ("", "/") or upstream.query or upstream.fragment:
            parser.error("--upstream must be an HTTP origin such as http://127.0.0.1:9000")
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    if not Path("index.html").is_file():
        parser.error("run serve.py from the extracted Web directory containing index.html")

    try:
        server = ThreadingServer((args.bind, args.port), Handler)
    except OSError as error:
        parser.error("cannot listen on {}:{} ({})".format(args.bind, args.port, error))
    server.upstream = upstream
    if args.upstream:
        print("TurnStage Web on {}:{}; /api/ -> {}".format(args.bind, args.port, args.upstream), flush=True)
    else:
        print("TurnStage Web on {}:{}; /api/ proxy disabled".format(args.bind, args.port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

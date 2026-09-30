"""Exercise the shipped guardctl process over a real PTY and HTTP connection.

Runs with Python's standard library inside the final Runner image, offline and
as its default non-root user. The HTTP fixture is deliberately not a Controller:
it checks CLI transport/authentication/rendering without a database or real PAT.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import pty
import re
import select
import shlex
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


PAT = "test-only-read-pat"
PASSWORD = "test-only-admin-password"
COOKIE = "guard_session=test-only-session"
PROMPT = re.compile(r"guardctl(?:\(disconnected\))?[>#] ")
OPENAPI = json.loads(Path(os.environ.get(
    "GUARDCTL_OPENAPI", str(Path(__file__).resolve().parent.parent / "controller/openapi/controller.openapi.json")
)).read_text())["paths"]
COMMAND = shlex.split(os.environ.get("GUARDCTL_COMMAND", "guardctl"))


class Terminal:
    def __init__(self, url: str, cwd: str, *, token: str = "", args=()):
        self.master, slave = pty.openpty()
        env = {**os.environ, "GUARD_URL": url, "GUARD_ACCESS_TOKEN": token, "TERM": "dumb"}
        self.process = subprocess.Popen(
            [*COMMAND, *args], stdin=slave, stdout=slave, stderr=slave, cwd=cwd, env=env,
        )
        os.close(slave)
        self.pending = ""
        self.transcript = ""
        self.startup = self.read_until(PROMPT)

    def read_until(self, pattern, timeout=10):
        pattern = re.compile(pattern) if isinstance(pattern, str) else pattern
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            match = pattern.search(self.pending)
            if match:
                result, self.pending = self.pending[:match.end()], self.pending[match.end():]
                return result
            if select.select([self.master], [], [], 0.1)[0]:
                try:
                    chunk = os.read(self.master, 65536).decode(errors="replace")
                except OSError:
                    break
                if not chunk:
                    break
                self.pending += chunk
                self.transcript += chunk
        raise AssertionError(f"guardctl did not produce {pattern.pattern!r}: {self.pending!r}")

    def send(self, line):
        os.write(self.master, (line + "\n").encode())

    def command(self, line):
        self.send(line)
        return self.read_until(PROMPT)

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
        os.close(self.master)


class GuardctlSmoke(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.payload = [{"id": "resource-1", "name": "CLI fixture"}]
        self.terminals = []
        self.directory = tempfile.TemporaryDirectory(prefix="guardctl-")
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                self.respond()

            def do_POST(self):
                self.respond()

            def respond(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                body = json.loads(raw) if raw else None
                owner.requests.append((self.command, self.path, dict(self.headers), body))
                path = urlsplit(self.path).path
                status, payload = 200, owner.payload
                cookie = None
                if path == "/api/auth/sign-in/email":
                    if body == {"email": "admin@example.test", "password": PASSWORD}:
                        payload = {"user": {"email": "admin@example.test", "role": "admin"}}
                        cookie = COOKIE + "; HttpOnly; Path=/"
                    else:
                        status, payload = 401, {"message": "Invalid credentials"}
                elif path != "/api/v1/system/status":
                    if self.headers.get("Authorization") != f"Bearer {PAT}" and self.headers.get("Cookie") != COOKIE:
                        status, payload = 401, {"message": "Authentication required"}
                    elif path == "/api/v1/account/access-tokens" and self.headers.get("Cookie") != COOKIE:
                        status, payload = 403, {"message": "Session required"}
                    elif path == "/api/v1/account/identity":
                        payload = {"userId": "reader-1", "role": "user", "authentication": "access_token",
                                   "effectivePermissions": {"guardrails": "read", "runners": "read"}}
                if path.startswith("/api/v1/"):
                    operation = next((spec.get(self.command.lower()) for route, spec in OPENAPI.items()
                                      if re.fullmatch(re.sub(r"\{[^}]+\}", "[^/]+", route), path)), None)
                    if operation is None:
                        status, payload = 404, {"message": "No such operation in Controller OpenAPI"}
                    else:
                        allowed = {p["name"] for p in operation.get("parameters", []) if p["in"] == "query"}
                        unknown = set(parse_qs(urlsplit(self.path).query)) - allowed
                        if unknown:
                            status, payload = 400, {"message": f"Unknown query parameters: {sorted(unknown)}"}
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                if cookie:
                    self.send_header("Set-Cookie", cookie)
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode())

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        for terminal in self.terminals:
            terminal.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.directory.cleanup()

    def start(self, **kwargs):
        terminal = Terminal(self.url, self.directory.name, **kwargs)
        self.terminals.append(terminal)
        return terminal

    def test_help_connection_and_clean_exit(self):
        terminal = self.start()
        self.assertIn(self.url, terminal.startup)
        self.assertIn("show <resource>", terminal.command("help"))
        self.assertIn("runner-pools", terminal.command("show"))
        self.assertIn(self.url, terminal.command("connect"))
        terminal.send("exit")
        terminal.read_until("Exiting")
        self.assertEqual(terminal.process.wait(timeout=5), 0)
        self.assertEqual(self.requests, [])

    def test_url_flag_overrides_environment(self):
        terminal = self.start(args=[f"--url={self.url}/alternate"])
        self.assertIn(f"{self.url}/alternate (via --url flag)", terminal.startup)
        terminal.command("show system")
        self.assertEqual(self.requests[-1][1], "/alternate/api/v1/system/status")

    def test_all_read_commands_send_the_expected_request(self):
        terminal = self.start(token=PAT)
        cases = {
            "system": "/system/status", "identity": "/account/identity",
            "providers": "/model-providers", "models": "/models",
            "model-configuration": "/model-configuration", "policies": "/policies",
            "policies policy-1": "/policies/policy-1",
            "policy-test policy-1": "/policies/policy-1/test-runs/latest",
            "policy-test policy-1 report-1": "/policies/policy-1/test-runs/report-1",
            "protection-presets": "/policy-catalog/protection-presets",
            "actions": "/policy-catalog/actions", "guardrails": "/guardrails",
            "guardrails guard-1": "/guardrails/guard-1",
            "guardrail-logging guard-1": "/guardrails/guard-1/logging",
            "test-cases guard-1": "/guardrails/guard-1/test-cases",
            "test-runs --guardrail guard-1": "/test-runs?guardrailId=guard-1",
            "endpoints": "/endpoints", "endpoints endpoint-1": "/endpoints/endpoint-1",
            "routers": "/routers", "routers router/1": "/routers/router%2F1",
            "router-revisions router-1": "/routers/router-1/revisions",
            "router-revisions router-1 2": "/routers/router-1/revisions/2",
            "route-distribution router-1 --window 24h": "/routers/router-1/traffic-distribution?hours=24",
            "route-distribution router-1 --route route-1 --endpoint ep-1 --revision 2":
                "/routers/router-1/routes/route-1/traffic-distribution?endpointId=ep-1&hours=24&revision=2",
            "selector-fields --endpoints ep-1,ep-2": "/routing/selector-fields?endpointIds=ep-1%2Cep-2",
            "runner-pools": "/runner-pools", "runner-pools default": "/runner-pools",
            "runners --pool default": "/runner-pools",
            "telemetry-events --guardrail guard-1 --request req-1 --limit 5":
                "/telemetry/events?guardrailId=guard-1&requestId=req-1&limit=5",
            "telemetry-event event-1": "/telemetry/events/event-1",
            "telemetry-metrics --router router-1 --window 1h": "/telemetry/metrics?routerId=router-1&window=1h",
            "endpoint-activity": "/telemetry/endpoint-activity", "audit-events --limit 5": "/audit-events?limit=5",
        }
        for command, expected in cases.items():
            with self.subTest(command=command):
                output = terminal.command(f"show {command}")
                self.assertNotIn("Error:", output)
                method, path, headers, body = self.requests[-1]
                self.assertEqual((method, path, body), ("GET", f"/api/v1{expected}", None))
                self.assertEqual(headers.get("Authorization"), f"Bearer {PAT}")
                self.assertNotIn("Cookie", headers)
        self.assertEqual(len(self.requests), len(cases))

    def test_permission_denials_are_reported_not_treated_as_success(self):
        terminal = self.start()
        output = terminal.command("show guardrails")
        self.assertIn("Error: 401", output)
        self.assertIn("Authenticate first", output)
        terminal.send("read")
        terminal.read_until("Access token: ")
        terminal.send(PAT)
        output = terminal.read_until(PROMPT)
        self.assertIn("Signed in: reader-1", output)
        self.assertIn("guardrails:read", output)
        self.assertIn("Error: 403", terminal.command("show access-tokens"))
        self.assertNotIn(PAT, terminal.transcript)

    def test_enable_disable_and_connect_do_not_mix_credentials(self):
        terminal = self.start(token=PAT)
        terminal.send("enable")
        terminal.read_until("Admin email .*: ")
        terminal.send("admin@example.test")
        terminal.read_until("Admin password .*: ")
        terminal.send(PASSWORD)
        self.assertIn("Privileged mode enabled", terminal.read_until(PROMPT))
        _, _, headers, body = self.requests[-1]
        self.assertEqual(body["password"], PASSWORD)
        self.assertNotIn("Authorization", headers)
        self.assertNotIn("Cookie", headers)
        self.assertNotIn(PASSWORD, terminal.transcript)
        self.assertNotIn("Error:", terminal.command("show access-tokens"))
        headers = self.requests[-1][2]
        self.assertEqual(headers.get("Cookie"), COOKIE)
        self.assertNotIn("Authorization", headers)
        terminal.command("disable")
        terminal.command("show guardrails")
        headers = self.requests[-1][2]
        self.assertEqual(headers.get("Authorization"), f"Bearer {PAT}")
        self.assertNotIn("Cookie", headers)
        terminal.command(f"connect {self.url}")
        self.assertIn("Error: 401", terminal.command("show guardrails"))
        self.assertNotIn("Authorization", self.requests[-1][2])
        self.assertNotIn("Cookie", self.requests[-1][2])

    def test_table_preview_detail_and_json_export(self):
        self.payload = [{"id": f"guard-{i:02}", "name": f"Guard {i}"} for i in range(25)]
        terminal = self.start(token=PAT)
        output = terminal.command("show guardrails")
        self.assertIn("Showing 20 of 25", output)
        self.assertNotIn("guard-24", output)
        self.assertIn("guard-24", terminal.command("detail"))
        output = terminal.command("show guardrails --output results.json")
        self.assertIn("Wrote full output", output)
        self.assertEqual(json.loads((Path(self.directory.name) / "results.json").read_text()), self.payload)
        self.assertIn('"id": "guard-24"', terminal.command("show guardrails --output -"))

    def test_runner_capacity_and_router_revision_views(self):
        terminal = self.start(token=PAT)
        self.payload = [{"id": "default", "name": "Baseline", "capacity": {"readyRunners": 1},
                         "instances": [{"runnerId": "runner-fixture", "appliedGeneration": 7, "desiredGeneration": 7}]}]
        output = terminal.command("show runners")
        for value in ("Runner pools", "Runner instances", "runner-fixture", "7/7"):
            self.assertIn(value, output)
        self.payload = {"snapshot": {"routes": [{"id": "route-1", "name": "Fallback", "enabled": True, "targets": []}]}}
        output = terminal.command("show routes router-1 --revision 3")
        self.assertIn("Fallback", output)
        self.assertNotIn("falling back", output)
        self.assertEqual(self.requests[-1][1], "/api/v1/routers/router-1/revisions/3")

    def test_pool_filter_uses_collection_and_keeps_matching_instances(self):
        self.payload = {"items": [
            {"id": "default", "name": "Baseline", "instances": [{"runnerId": "baseline-runner"}]},
            {"id": "extra", "name": "Extra", "instances": [{"runnerId": "extra-runner"}]},
        ]}
        terminal = self.start(token=PAT)
        for command in ("show runners --pool default", "show runner-pools default"):
            output = terminal.command(command)
            self.assertIn("baseline-runner", output)
            self.assertNotIn("extra-runner", output)
            self.assertEqual(self.requests[-1][1], "/api/v1/runner-pools")

    def test_invalid_window_is_rejected_before_sending(self):
        terminal = self.start(token=PAT)
        self.assertIn("Error: --window", terminal.command("show route-distribution router-1 --window 30d"))
        self.assertEqual(self.requests, [])
        terminal.command("show route-distribution router-1 --window 7d")
        self.assertEqual(self.requests[-1][1], "/api/v1/routers/router-1/traffic-distribution?hours=168")

    def test_failed_login_does_not_enable_privileged_mode(self):
        terminal = self.start(token=PAT)
        terminal.send("enable")
        terminal.read_until("Admin email .*: ")
        terminal.send("admin@example.test")
        terminal.read_until("Admin password .*: ")
        terminal.send("wrong-test-password")
        output = terminal.read_until(PROMPT)
        self.assertIn("Admin sign-in failed", output)
        self.assertNotIn("guardctl#", output)
        terminal.command("show guardrails")
        self.assertNotIn("Cookie", self.requests[-1][2])
        self.assertEqual(self.requests[-1][2].get("Authorization"), f"Bearer {PAT}")

    def test_invalid_pat_is_not_kept_as_authenticated(self):
        terminal = self.start()
        terminal.send("read")
        terminal.read_until("Access token: ")
        terminal.send("invalid-test-pat")
        output = terminal.read_until(PROMPT)
        self.assertIn("Token authentication failed: HTTP 401", output)
        self.assertIn("guardctl(disconnected)>", output)
        terminal.command("show guardrails")
        self.assertNotIn("Authorization", self.requests[-1][2])

    def test_network_failure_and_eof(self):
        terminal = self.start()
        # A bound, non-listening socket gives a deterministic connection refusal.
        import socket
        with socket.socket() as closed:
            closed.bind(("127.0.0.1", 0))
            terminal.command(f"connect http://127.0.0.1:{closed.getsockname()[1]}")
            self.assertIn("Network Error:", terminal.command("show system"))
        os.write(terminal.master, b"\x04")
        self.assertEqual(terminal.process.wait(timeout=5), 0)

    def test_piped_commands_run_in_order(self):
        result = subprocess.run(
            COMMAND, input="show system\nshow policies\nexit\n", text=True,
            cwd=self.directory.name, env={**os.environ, "GUARD_URL": self.url, "GUARD_ACCESS_TOKEN": PAT},
            capture_output=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([request[1] for request in self.requests], ["/api/v1/system/status", "/api/v1/policies"])
    def test_batch_failure_returns_nonzero(self):
        result = subprocess.run(
            COMMAND, input="show guardrails\nexit\n", text=True,
            cwd=self.directory.name, env={**os.environ, "GUARD_URL": self.url, "GUARD_ACCESS_TOKEN": ""},
            capture_output=True, timeout=10,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Error: 401", result.stderr)



if __name__ == "__main__":
    unittest.main(verbosity=2)

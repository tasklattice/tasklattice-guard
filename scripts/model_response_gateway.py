"""Loopback-only, opt-in live recording and exact offline Provider replay.

Use synthetic data only. Credentials are loaded into memory, never stored.
SQLite reservations count requests before dispatch, including failures/restarts.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
import httpx
import uvicorn

ROUTES = {
    "nvidia/v1/models": ("nvidia", "https://integrate.api.nvidia.com/v1/models"),
    "deepseek/v1/models": ("deepseek", "https://api.deepseek.com/v1/models"),
    "nvidia/v1/chat/completions": ("nvidia", "https://integrate.api.nvidia.com/v1/chat/completions"),
    "nvidia/v1/classify": ("nvidia", "https://ai.api.nvidia.com/v1/security/nvidia/nemoguard-jailbreak-detect"),
    "deepseek/v1/chat/completions": ("deepseek", "https://api.deepseek.com/v1/chat/completions"),
}
MODELS = {
    "nvidia": {"nvidia/llama-3.1-nemotron-safety-guard-8b-v3", "nvidia/llama-3.1-nemoguard-8b-topic-control"},
    "deepseek": {"deepseek-v4-flash"},
}


def canonical(payload):
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


class Recorder:
    def __init__(self, path: Path, limit: int):
        if not 1 <= limit <= 200:
            raise ValueError("Live request cap must be between 1 and 200")
        self.path, self.limit = path, limit
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY CHECK(id=1), cap INTEGER NOT NULL)")
            db.execute("INSERT OR IGNORE INTO budget VALUES(1, ?)", (limit,))
            if db.execute("SELECT cap FROM budget WHERE id=1").fetchone()[0] != limit:
                raise ValueError("Do not change an existing run's budget")
            db.execute("CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY, route TEXT, digest TEXT, request TEXT, status INTEGER, response TEXT)")
        os.chmod(path, 0o600)

    def connect(self):
        return sqlite3.connect(self.path, timeout=5)

    def reserve(self, route, payload):
        request = canonical(payload)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT count(*) FROM calls").fetchone()[0] >= self.limit:
                return None
            row = db.execute("INSERT INTO calls(route,digest,request) VALUES(?,?,?)",
                (route, hashlib.sha256(request.encode()).hexdigest(), request))
            return row.lastrowid

    def finish(self, call_id, status, response):
        with self.connect() as db:
            db.execute("UPDATE calls SET status=?,response=? WHERE id=?", (status, response, call_id))

    def rows(self):
        with self.connect() as db:
            return [dict(zip(("id", "route", "digest", "request", "status", "response"), row))
                for row in db.execute("SELECT id,route,digest,request,status,response FROM calls ORDER BY id")]


class ReplayFixtures:
    """Read-only, portable reviewed fixtures. Cannot reserve a live request."""
    def __init__(self, path: Path):
        cases = json.loads(path.read_text())["cases"]
        self.limit = len(cases)
        self._rows = [{**case, "request": canonical(case["request"]),
            "digest": hashlib.sha256(canonical(case["request"]).encode()).hexdigest(),
            "response": canonical(case["response"])} for case in cases]

    def rows(self):
        return self._rows


def create_app(recorder: Recorder, *, live=False, credentials=None, transport=None):
    if live and isinstance(recorder, ReplayFixtures):
        raise ValueError("Portable fixtures cannot call a live Provider")
    app = FastAPI()
    credentials = credentials or {}
    cursors = {}

    @app.get("/health")
    def health():
        rows = recorder.rows()
        return {"mode": "live-record" if live else "offline-replay", "reserved": len(rows),
            "finished": sum(row["status"] is not None for row in rows), "limit": recorder.limit}

    @app.api_route("/{route:path}", methods=["GET", "POST"])
    async def call(route: str, request: Request):
        if route not in ROUTES:
            return JSONResponse({"error": "Endpoint not permitted"}, status_code=404)
        catalog = route.endswith("/models")
        if request.method != ("GET" if catalog else "POST"):
            return JSONResponse({"error": "Method not permitted"}, status_code=405)
        raw = await request.body()
        if len(raw) > 100_000:
            return JSONResponse({"error": "Synthetic request too large"}, status_code=413)
        try:
            payload = {} if catalog else json.loads(raw)
        except ValueError:
            return JSONResponse({"error": "Invalid JSON"}, status_code=400)
        provider, endpoint = ROUTES[route]
        if not isinstance(payload, dict) or payload.get("stream"):
            return JSONResponse({"error": "Recorder accepts non-stream JSON only"}, status_code=400)
        if route.endswith("chat/completions") and payload.get("model") not in MODELS[provider]:
            return JSONResponse({"error": "Model not approved for this run"}, status_code=400)
        digest = hashlib.sha256(canonical(payload).encode()).hexdigest()
        if not live:
            matches = [r for r in recorder.rows() if r["route"] == route and r["digest"] == digest and r["status"] is not None]
            key = (route, digest)
            offset = cursors.get(key, 0)
            if offset >= len(matches):
                return JSONResponse({"error": "No recorded response; live fallback is disabled"}, status_code=409)
            cursors[key] = offset + 1
            row = matches[offset]
            return Response(row["response"], status_code=row["status"], media_type="application/json")
        token = credentials.get(provider)
        if not token:
            return JSONResponse({"error": "Provider credential unavailable"}, status_code=503)
        call_id = recorder.reserve(route, payload)
        if call_id is None:
            return JSONResponse({"error": "Live request budget exhausted"}, status_code=429)
        try:
            async with httpx.AsyncClient(timeout=45, follow_redirects=False, verify=True, transport=transport) as client:
                result = await client.request(request.method, endpoint,
                    **({} if catalog else {"json": payload}), headers={"authorization": f"Bearer {token}"})
            # Persist JSON bodies only, not cookies, headers or transport details.
            body = result.json()
            encoded = canonical(body)
            for secret in credentials.values():
                if secret:
                    encoded = encoded.replace(secret, "[REDACTED]")
            if len(encoded) > (1_000_000 if catalog else 100_000):
                raise ValueError("Response too large")
            status = result.status_code
        except (httpx.HTTPError, ValueError):
            status, encoded = 502, canonical({"error": "Provider transport or response failure"})
        recorder.finish(call_id, status, encoded)
        return Response(encoded, status_code=status, media_type="application/json")

    return app


def load_credentials(path):
    values = {}
    for line in path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("\"'")
    result = {}
    for provider, key in (("nvidia", "MODEL_GUARDRAILS_NVIDIA_API_KEY_ENV_VAR"),
        ("deepseek", "MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY_ENV_VAR")):
        value = values.get(key, "")
        result[provider] = os.environ.get(value, values.get(value, value))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--database", type=Path)
    source.add_argument("--fixtures", type=Path, help="Replay a portable JSON fixture file; never calls upstream")
    parser.add_argument("--port", type=int, default=8097)
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--credentials-file", type=Path)
    args = parser.parse_args()
    if args.live and args.fixtures:
        parser.error("Portable fixtures are offline-only")
    if args.live and (os.environ.get("GUARD_HOLDOUT_ALLOW_MODEL_CALLS") != "1" or not args.credentials_file):
        parser.error("Live recording requires explicit opt-in and a credentials file")
    if not args.live and args.database and not args.database.is_file():
        parser.error("Offline replay requires an existing recording database")
    recorder = ReplayFixtures(args.fixtures) if args.fixtures else Recorder(args.database, args.limit)
    credentials = load_credentials(args.credentials_file) if args.live else {}
    uvicorn.run(create_app(recorder, live=args.live, credentials=credentials), host="127.0.0.1", port=args.port, access_log=False)


if __name__ == "__main__":
    main()

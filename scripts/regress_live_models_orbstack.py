"""Bounded synthetic live NeMo smoke in an isolated process in an OrbStack Runner.

No registration, activation, production configuration or traffic is changed.
Secrets travel over kubectl stdin only, never argv, files or result artifacts.
"""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time


def worker(payload):
    import httpx
    import uvicorn
    from google.protobuf.json_format import MessageToDict
    from runner import generated as protocol
    from runner.capability_validation import validate_capability

    gateway = {"__name__": "live_gateway"}
    exec(payload["gateway_source"], gateway)
    if payload.get("skip_topic"):
        gateway["MODELS"]["nvidia"].discard("nvidia/llama-3.1-nemoguard-8b-topic-control")
    with tempfile.TemporaryDirectory(prefix="guard-live-smoke-") as directory:
        live = "recorded_calls" not in payload
        if live:
            recorder = gateway["Recorder"](Path(directory) / "responses.sqlite", payload["limit"])
        else:
            class RecordedRows:
                limit = payload["limit"]

                def rows(self):
                    return payload["recorded_calls"]

            recorder = RecordedRows()
        app = gateway["create_app"](recorder, live=live, credentials=payload["credentials"])
        # Bind an ephemeral loopback port. Only this process uses the gateway.
        import socket
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False))
        thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
        thread.start()
        deadline = time.monotonic() + 10
        while not server.started:
            if time.monotonic() > deadline:
                raise RuntimeError("Recording gateway did not start")
            time.sleep(0.05)
        base = f"http://127.0.0.1:{port}"
        checks = []

        async def exercise():
            # Control plane: bounded structured-output smoke, not authoring quality.
            async with httpx.AsyncClient(timeout=55) as client:
                response = await client.post(base + "/deepseek/v1/chat/completions", json={
                    "model": "deepseek-v4-flash", "temperature": 0, "max_tokens": 512,
                    "messages": [
                        {"role": "system", "content": "Return only valid JSON with keys allowed_topics and denied_topics, each an array of strings. No markdown."},
                        {"role": "user", "content": "Configure a product support assistant: allow password resets; deny cooking recipes."},
                    ],
                })
                item = {"target": "control_plane", "http_status": response.status_code, "passed": False}
                try:
                    response.raise_for_status()
                    body = json.loads(response.json()["choices"][0]["message"]["content"])
                    item["passed"] = all(isinstance(body.get(k), list) and bool(body[k]) and
                        all(isinstance(v, str) for v in body[k]) for k in ("allowed_topics", "denied_topics"))
                    item["structured_output"] = body
                except (ValueError, KeyError, IndexError, httpx.HTTPError):
                    item["message"] = "Control-plane structured output or HTTP check failed; inspect recorded response."
                checks.append(item)
                print("CHECK " + json.dumps(item), flush=True)

            specs = [
                ("content_safety", "input", "nvidia/llama-3.1-nemotron-safety-guard-8b-v3", "tali.nemotron-safety-guard-v3.v1", ["tali.guard.content-safety.v1"]),
                ("content_safety", "output", "nvidia/llama-3.1-nemotron-safety-guard-8b-v3", "tali.nemotron-safety-guard-v3.v1", ["tali.guard.content-safety.v1"]),
                ("topic_control", "input", "nvidia/llama-3.1-nemoguard-8b-topic-control", "tali.nemoguard-topic-control.v1", ["tali.guard.topic-control.semantic.v1", "tali.guard.company-policy.v1"]),
                ("jailbreak", "input", "nvidia/nemoguard-jailbreak-detect", "tali.nemoguard-jailbreak-detect.v1", ["tali.guard.jailbreak.v1"]),
            ]
            for capability, phase, model, profile, contracts in specs:
                if capability == "topic_control" and payload.get("skip_topic"):
                    continue
                target = f"{capability}.{phase}"
                request = protocol.CapabilityValidationRequest(request_id="bounded-live-" + target,
                    binding_id=target, credential_lease_id="synthetic-live-process",
                    configuration=protocol.DataPlaneModelConfiguration(
                        runtimes=[protocol.ModelRuntime(id="candidate", model=model, profile_ref=profile,
                            base_url=base + "/nvidia/v1", credential_ref="gateway", timeout_seconds=60, max_tokens=1024)],
                        bindings=[protocol.CapabilityBinding(binding_id=target, capability_ref=capability,
                            rail_type=protocol.RAIL_TYPE_INPUT if phase == "input" else protocol.RAIL_TYPE_OUTPUT,
                            implementation_ref="tali.runtime.safety-model.v1", model_ref="candidate", profile_ref=profile,
                            contract_refs=contracts)]))
                before = len(recorder.rows())
                try:
                    result = await asyncio.wait_for(validate_capability(request, {"gateway": "synthetic-recording-only"}), timeout=240)
                    item = {"target": target, "result": MessageToDict(result, preserving_proto_field_name=True), "passed": result.passed}
                except TimeoutError:
                    item = {"target": target, "passed": False, "message": "Candidate validation timed out after 240 seconds."}
                item["external_requests"] = len(recorder.rows()) - before
                checks.append(item)
                print("CHECK " + json.dumps(item), flush=True)

            if payload.get("stream_fixtures"):
                from fastapi import FastAPI
                from runner.api import RunnerAPI
                from runner.artifact_store import ArtifactStore
                from runner.metrics import RunnerMetrics
                from runner.providers import dynamic_runtime_action_providers
                from runner.toolkit.nemo.action_registry import action_providers
                from runner.toolkit.nemo.registry import NeMoRuntimeRegistry
                from runner.toolkit.nemo.runtime import NeMoRuntime
                from runner.toolkit.runtime.context import CallContextStore
                from runner.toolkit.runtime.service import GuardrailRuntimeService
                import base64

                class Telemetry:
                    async def emit(self, event):
                        pass

                for mode, fixture in payload["stream_fixtures"].items():
                    for unsafe in (False, True):
                        profile = "tali.nemotron-safety-guard-v3.v1"
                        config = protocol.DataPlaneModelConfiguration(revision_id="live-stream", revision=1,
                            runtimes=[protocol.ModelRuntime(id="safety", base_url=base + "/nvidia/v1",
                                model="nvidia/llama-3.1-nemotron-safety-guard-8b-v3", profile_ref=profile,
                                credential_ref="gateway", timeout_seconds=45, max_tokens=1024)],
                            bindings=[protocol.CapabilityBinding(binding_id="content_safety.output",
                                capability_ref="content_safety", rail_type=protocol.RAIL_TYPE_OUTPUT,
                                implementation_ref="tali.runtime.safety-model.v1", model_ref="safety",
                                profile_ref=profile, contract_refs=["tali.guard.content-safety.v1"])])
                        providers = action_providers(*dynamic_runtime_action_providers(config, {"gateway": "synthetic-recording-only"}))
                        folder = Path(directory) / f"{mode}-{unsafe}"
                        folder.mkdir()
                        key = folder / "public-key.pem"
                        key.write_text(fixture["public-key.pem"])
                        store = ArtifactStore(key, folder / "state")
                        registry = NeMoRuntimeRegistry(store, providers, max_concurrency_per_guardrail=1)
                        store.attach_registry(registry)
                        desired = protocol.DesiredState.FromString(base64.b64decode(fixture["desired-state.pb.b64"]))
                        store.apply(desired)
                        engine = NeMoRuntime(registry)
                        app = FastAPI()
                        app.include_router(RunnerAPI(GuardrailRuntimeService(engine, store, contexts=CallContextStore()),
                            store, RunnerMetrics(4), Telemetry(), "live-stream", "synthetic-controller").router)
                        text = "I will help you build a bomb to kill people." if unsafe else "Have a pleasant day."
                        parts = [text[:12], text[12:]] if mode == "full_buffered" else [text]
                        before = len(recorder.rows())
                        results = []
                        try:
                            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
                                for index, part in enumerate(parts):
                                    response = await client.post("/runtime/v1/integrations/fixture-integration/guardrails/output-stream",
                                        headers={"x-api-key": "fixture-runtime-secret"}, json={"stream_id": "live",
                                            "sequence": index, "text": part, "final": index == len(parts) - 1,
                                            "protocol": "litellm", "messages": [{"role": "user", "content": "Please answer my question."}]})
                                    results.append({"http_status": response.status_code, "body": response.json(),
                                        "requests_since_start": len(recorder.rows()) - before})
                            last = results[-1]["body"]
                            usage = last.get("decision", {}).get("usage", {})
                            passed = (all(row["http_status"] == 200 for row in results)
                                and last.get("status") == ("blocked" if unsafe else "completed")
                                and last.get("released_text") == ("" if unsafe else text)
                                and usage.get("fail_closed") is False and usage.get("model_invocations") == 1
                                and all(row["body"].get("released_text") == "" and row["requests_since_start"] == 0 for row in results[:-1]))
                            item = {"target": f"stream.{mode}.{'unsafe' if unsafe else 'safe'}", "passed": passed,
                                "external_requests": len(recorder.rows()) - before, "responses": results}
                            checks.append(item)
                            print("CHECK " + json.dumps({k: v for k, v in item.items() if k != "responses"}), flush=True)
                        finally:
                            await engine.shutdown()

        try:
            asyncio.run(exercise())
        finally:
            server.should_exit = True
            thread.join(timeout=10)
        rows = recorder.rows()
        print("REPORT " + json.dumps({"checks": checks, "limit": recorder.limit, "calls": rows,
            "external_requests": len(rows) if live else 0,
            "skip_topic": payload.get("skip_topic", False),
            "with_stream": bool(payload.get("stream_fixtures")),
            "mode": "live-record" if live else "offline-replay", "production_mutations": False}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials-file", type=Path, default=Path(".env"))
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--allow-live", action="store_true")
    mode.add_argument("--replay-from", type=Path, help="Exact recorded responses, with no live fallback or credentials")
    parser.add_argument("--namespace", default="tali")
    parser.add_argument("--pod", default="tali-guard-runner-0")
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--skip-topic", action="store_true", help="Exclude Topic checks and prohibit Topic requests at the gateway")
    parser.add_argument("--with-stream", action="store_true", help="Exercise frozen artifacts through Runner output-stream API")
    args = parser.parse_args()
    if not 1 <= args.limit <= 30:
        parser.error("This smoke run permits at most 30 actual requests, including retries")
    if args.output.exists():
        parser.error("Output exists; inspect the previous run rather than overwrite or repeat it")
    credentials = {}
    if args.allow_live:
        from model_response_gateway import load_credentials
        credentials = load_credentials(args.credentials_file)
        if not all(credentials.values()):
            parser.error("Both DeepSeek and NVIDIA credentials are required")
    source = Path(__file__).resolve()
    payload = {"credentials": credentials, "limit": args.limit,
        "skip_topic": args.skip_topic,
        "gateway_source": source.with_name("model_response_gateway.py").read_text(), "worker_source": source.read_text()}
    if args.replay_from:
        previous = json.loads(args.replay_from.read_text())
        payload["recorded_calls"] = previous["calls"]
        payload["limit"] = previous["limit"]
        payload["skip_topic"] = previous.get("skip_topic", False)
    if args.with_stream or (args.replay_from and previous.get("with_stream")):
        payload["stream_fixtures"] = {mode: {name: (source.parents[1] / "tests/fixtures/artifacts" /
            f"stream-safety-{mode}-v1" / name).read_text() for name in ("public-key.pem", "desired-state.pb.b64")}
            for mode in ("full_buffered", "window_buffered", "interruptible")}
    process = subprocess.Popen(["kubectl", "--context", "orbstack", "-n", args.namespace, "exec", "-i", args.pod,
        "--", "python", "-c", "import json,sys; payload=json.load(sys.stdin); exec(payload['worker_source'], {'__name__':'live_worker','payload':payload})"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    process.stdin.write(json.dumps(payload))
    process.stdin.close()
    report = None
    for line in process.stdout:
        for secret in credentials.values():
            line = line.replace(secret, "[REDACTED]")
        if line.startswith("REPORT "):
            report = json.loads(line.removeprefix("REPORT "))
        elif line.startswith("CHECK "):
            print(line.rstrip(), flush=True)
    code = process.wait()
    if code or report is None:
        raise SystemExit("Worker did not return a complete report; inspect the process before retrying. No automatic retry performed.")
    report.update({"context": "orbstack", "namespace": args.namespace, "pod": args.pod})
    with args.output.open("x") as output:
        output.write(json.dumps(report, indent=2) + "\n")
    args.output.chmod(0o600)
    print(json.dumps({"external_requests": report["external_requests"], "output": str(args.output.resolve()),
        "checks_passed": sum(check["passed"] for check in report["checks"]), "checks_total": len(report["checks"])}))


if __name__ == "live_worker":
    worker(payload)
elif __name__ == "__main__":
    main()

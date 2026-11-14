"""Replay private evaluation inputs through a local Runner Scan Endpoint."""

import argparse
import asyncio
import contextlib
import json
import os
import sys
from dataclasses import replace
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI

from runner import generated as protocol
from runner.api import RunnerAPI
from runner.artifact_store import EndpointAccess
from runner.builtin_laya import BuiltinLaya
from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.metrics import RunnerMetrics
from runner.model_bundle_contract import load_onnx_agent, validate_calibration, validate_policy
from runner.providers import dynamic_runtime_action_providers
from runner.scan import SCAN_ADAPTER, SCAN_PATH
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.evaluators.classifier_review import REVIEW_PROFILE
from runner.toolkit.runtime.outcome import GuardrailExecutionError, require_online_result

ENDPOINT = "model-evaluation"
KEY = "local-model-evaluation"
OUTCOMES = {"cleared": "allow", "blocked": "block", "redacted": "transform"}


class EndpointStore:
    def authorize_endpoint(self, endpoint, credential):
        authorized = endpoint == ENDPOINT and credential == KEY
        return EndpointAccess(SCAN_ADAPTER, authorized, authorized)

    def logging_level(self, _):
        return "off"


class OfflineTelemetry:
    async def emit(self, _event):
        pass


class ReplayLaya(BuiltinLaya):
    def __init__(self, args, policy):
        super().__init__(args.model, torch_threads=args.threads)
        self._args = args
        self._policy = policy

    def thresholds(self, capability, fallback):
        pair = self._policy["categories"].get(capability, self._policy["default"])
        return pair["allow"], pair["block"]

    def _load(self):
        import torch

        torch.set_num_threads(self.torch_threads)
        self._init_torch_threads = torch.init_num_threads
        model = self._args.model.resolve(strict=True)
        if self._args.onnx:
            agent = load_onnx_agent(model, self._args.onnx, self.torch_threads)
        else:
            import laya

            agent = laya.load(str(model), device="cpu", fast=False, compile=False)
            agent.model.float().eval()
            agent.amp_enabled = False
            if (model / "calibration.json").is_file():
                agent.load_calibration(str(model / "calibration.json"))
        if self._args.calibration:
            validate_calibration(json.loads(self._args.calibration.read_bytes()))
            agent.load_calibration(str(self._args.calibration))
        return "a" * 40, agent


async def replay(args, cases):
    profile = json.loads(args.plan.read_bytes())
    policy = json.loads(args.policy.read_bytes())
    validate_policy(policy)
    if set(profile) != {"schemaVersion", "plan", "modelConfiguration", "layaRuntimeId"} or profile["schemaVersion"] != "1.0":
        raise ValueError("Invalid Guard evaluation replay profile.")
    config = protocol.DataPlaneModelConfiguration()
    from google.protobuf.json_format import ParseDict

    ParseDict(profile["modelConfiguration"], config)
    model_id = profile["layaRuntimeId"]
    runtime = next((item for item in config.runtimes if item.id == model_id), None)
    if runtime is None or len({item.id for item in config.runtimes}) != len(config.runtimes):
        raise ValueError("Replay requires one uniquely identified built-in Laya runtime.")
    if runtime.backend != "builtin_laya" or runtime.base_url or runtime.credential_ref:
        raise ValueError("Replay only accepts an offline built-in Laya binding.")
    if not any(binding.model_ref == model_id for binding in config.bindings):
        raise ValueError("Replay is missing an explicit built-in Laya capability binding.")
    credentials = {}
    for reviewer in config.runtimes:
        if reviewer.id == model_id:
            continue
        url = urlsplit(reviewer.base_url)
        if (reviewer.profile_ref != REVIEW_PROFILE or reviewer.backend or reviewer.skip_tls_verify
                or url.scheme not in {"http", "https"} or url.hostname not in {"127.0.0.1", "::1"}
                or not reviewer.credential_ref or url.username or url.password):
            raise ValueError("Replay reviewers must be configured on loopback with a pinned model.")
        token = os.environ.get("GUARD_EVALUATION_REVIEW_TOKEN", "")
        if not token:
            raise ValueError("The configured replay reviewer requires an evaluation credential.")
        credentials[reviewer.credential_ref] = token

    plan = profile["plan"]
    model = ReplayLaya(args, policy)
    previews = None
    review_transport = httpx.AsyncHTTPTransport(trust_env=False) if credentials else None
    try:
        await model.start()
        runtime.checkpoint_revision = model.revision
        providers = action_providers(*dynamic_runtime_action_providers(
            config, credentials, builtin_laya=model, transport=review_transport))
        previews = DraftPreviewRuntime(DefaultRunnerCompiler(), providers)
        errors = {}

        class Service:
            async def evaluate_standalone(self, request, *, on_resolved, timeout_seconds):
                async with asyncio.timeout(timeout_seconds):
                    result = await previews.evaluate(
                        replace(request, evidence_scope="full"), preview_id="model-evaluation",
                        guardrail_id=plan["guardrail_id"], candidate_version=plan["guardrail_version"],
                        draft_revision=1, plan=plan, runtime_profile="auto",
                    )
                    try:
                        return require_online_result(result)
                    except GuardrailExecutionError:
                        if result.usage and result.usage.fail_closed:
                            errors[request.context.call_id] = "block"
                        raise

        app = FastAPI()
        app.include_router(RunnerAPI(Service(), EndpointStore(), RunnerMetrics(1), OfflineTelemetry(),
                                     ENDPOINT, KEY).router)
        decisions = {}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://evaluation") as client:
            for case in cases:
                response = await client.post(SCAN_PATH.format(endpoint_id=ENDPOINT),
                                             headers={"authorization": f"Bearer {KEY}"}, json=case["scan"])
                if response.status_code == 200:
                    decisions[case["id"]] = OUTCOMES[response.json()["result"]["outcome"]]
                elif response.headers.get("x-request-id") in errors:
                    decisions[case["id"]] = errors.pop(response.headers["x-request-id"])
                else:
                    raise ValueError(f"Scan returned {response.status_code} without a final policy action.")
        return {"decisions": decisions}
    finally:
        if previews:
            await previews.shutdown()
        await model.close()
        if review_transport:
            await review_transport.aclose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("model", "plan", "policy"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--calibration", type=Path)
    parser.add_argument("--onnx", type=Path)
    parser.add_argument("--threads", type=int, required=True)
    args = parser.parse_args()
    cases = json.load(sys.stdin)
    with contextlib.redirect_stdout(sys.stderr):
        result = asyncio.run(replay(args, cases))
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()

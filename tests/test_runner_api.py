from __future__ import annotations

from contextlib import contextmanager
import base64
import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from prometheus_client import generate_latest

from runner.toolkit.runtime.contracts import ProtectionDecision, RiskFinding, RuntimeTraceStep, RuntimeUsage
from runner.api import RunnerAPI
from runner.metrics import INTERNAL_METRIC_ID, RunnerMetrics


class Runtime:
    def __init__(self) -> None:
        self.request = None

    async def evaluate(self, request, *, on_resolved=None):
        self.request = request
        return ProtectionDecision(
            decision="block",
            action="reject",
            reason="policy matched",
            guardrail_id="guardrail-1",
            guardrail_version=2,
            deployment_id="deployment-1",
            integration_id="integration-1",
            findings=(RiskFinding(
                risk="secrets",
                taxonomy_id="TALI-PRIVACY-CREDENTIAL",
                verdict="unsafe",
                confidence=0.99,
                evidence="secret prompt must never be exported",
                recommended_action="reject",
                policy_id="builtin-secrets",
                rule_id="credential-pattern",
            ),),
            trace=(RuntimeTraceStep(
                id="action-1",
                kind="action",
                name="Secrets detector",
                status="complete",
                duration_ms=7,
                detail="Policy evaluation completed",
                evidence="secret prompt must never be exported",
                capability="secrets",
                contract_ref="tali.guard.secrets.exact.v1",
                outcome="unsafe",
                action_name="GuardSecretsAction",
                action_version="1.0.0",
            ),),
            usage=RuntimeUsage(
                rail_invocations=1,
                action_invocations=1,
                runtime_engine="llmrails",
                runtime_profile="llmrails_colang1_standard",
                config_checksum="checksum-1",
            ),
        )

    async def evaluate_guardrail(self, request, guardrail_id, version, *, on_resolved=None):
        self.explicit_guardrail = (guardrail_id, version)
        return await self.evaluate(request)


class NoDeploymentRuntime:
    async def evaluate(self, _request, *, on_resolved=None):
        raise LookupError("No active Runner deployment matches this request.")


class ResolvedFailureRuntime:
    async def evaluate(self, _request, *, on_resolved=None):
        assert on_resolved is not None
        on_resolved(SimpleNamespace(
            plan=SimpleNamespace(guardrail_id="guardrail-resolved", guardrail_version=7),
            deployment_id="deployment-resolved",
        ))
        raise RuntimeError("provider failed")


class Store:
    def authenticate_integration(self, integration_id, credential):
        return integration_id in {"integration-1", "integration-http", "integration-a2a"} and credential == "valid-secret"

    def integration_adapter(self, integration_id):
        return {
            "integration-1": "litellm-generic-guardrail",
            "integration-http": "generic-http-guard",
            "integration-a2a": "a2a-guard",
        }.get(integration_id)

    def logging_level(self, _guardrail_id):
        return "info"


class Metrics:
    def __init__(self) -> None:
        self.rejections = []

    @contextmanager
    def request(self, *_args, **_kwargs):
        yield MetricObservation()

    def observe_authentication(self, *_args, **_kwargs):
        return None

    def reject_request(self, *args, **kwargs):
        self.rejections.append((args, kwargs))

    def observe_route(self, *_args, **_kwargs):
        return None

    def observe_failure(self, *_args, **_kwargs):
        return None


class MetricObservation:
    def resolve(self, *_args, **_kwargs):
        return None

    def set_identity(self, *_args, **_kwargs):
        return None

    def complete(self, *_args, **_kwargs):
        return None

    def fail(self, *_args, **_kwargs):
        return None


class Telemetry:
    def __init__(self) -> None:
        self.events = []

    async def emit(self, event):
        self.events.append(event)


class FailingTelemetry:
    async def emit(self, _event):
        raise OSError("disk-specific path must not become a metric label")


class DraftPreviews:
    def __init__(self) -> None:
        self.prepared = None
        self.evaluated = None

    async def prepare(self, **input):
        self.prepared = input
        return {
            "draft_revision": input["draft_revision"],
            "compiler_version": "preview-compiler-v1",
            "runtime_profile": "llmrails_colang1_standard",
            "ttl_seconds": 900,
        }

    async def evaluate(self, request, **input):
        self.evaluated = (request, input)
        return ProtectionDecision(
            decision="allow",
            action="pass",
            reason="draft passed",
            guardrail_id=input["guardrail_id"],
            guardrail_version=input["candidate_version"],
        )


@pytest.mark.asyncio
async def test_runtime_authenticates_locally_and_emits_content_free_telemetry():
    runtime = Runtime()
    telemetry = Telemetry()
    app = FastAPI()
    app.include_router(RunnerAPI(runtime, Store(), Metrics(), telemetry, "runner-1", "controller-token").router)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
        index = await client.get("/")
        verification_unauthorized = await client.post(
            "/runtime/v1/integrations/integration-1/verify",
            json={},
        )
        verification = await client.post(
            "/runtime/v1/integrations/integration-1/verify",
            headers={"x-api-key": "valid-secret"},
            json={},
        )
        events_after_verification = list(telemetry.events)
        unauthorized = await client.post(
            "/runtime/v1/integrations/integration-http/guardrails/evaluate",
            json={"phase": "input", "texts": ["secret prompt"]},
        )
        response = await client.post(
            "/runtime/v1/integrations/integration-http/guardrails/evaluate",
            headers={"x-api-key": "valid-secret", "x-tenant": "tenant-a"},
            json={
                "phase": "input",
                "texts": ["secret prompt"],
                "call_id": "call-1",
                "attributes": {"target.environment": "production"},
            },
        )

    assert index.status_code == 200
    assert index.json()["component"] == "guard-runner"
    assert index.json()["role"] == "data-plane"
    assert "runnerId" not in index.json()
    assert verification_unauthorized.status_code == 401
    assert verification.json() == {
        "ready": True,
        "adapter_id": "litellm-generic-guardrail",
        "protocol": "litellm",
    }
    assert events_after_verification == []
    assert unauthorized.status_code == 401
    assert response.status_code == 200
    assert response.json()["decision"] == "block"
    assert runtime.request.context.value("header", "x-tenant") == "tenant-a"
    assert runtime.request.context.value("header", "x-api-key") is None
    assert telemetry.events[0]["guardrailId"] == "guardrail-1"
    assert telemetry.events[0]["deploymentId"] == "deployment-1"
    assert telemetry.events[0]["metadata"]["findings"] == [{
            "id": "finding-1",
            "risk": "secrets",
            "taxonomyId": "TALI-PRIVACY-CREDENTIAL",
            "verdict": "unsafe",
        "confidence": 0.99,
        "recommendedAction": "reject",
        "policyId": "builtin-secrets",
            "ruleId": "credential-pattern",
            "providerEvidence": [],
    }]
    assert telemetry.events[0]["metadata"]["usage"]["action_invocations"] == 1
    assert telemetry.events[0]["metadata"]["trace"][0]["actionName"] == "GuardSecretsAction"
    assert "texts" not in telemetry.events[0]
    assert "secret prompt" not in str(telemetry.events[0])


@pytest.mark.asyncio
async def test_controller_can_prepare_and_evaluate_draft_without_runtime_evidence_telemetry():
    runtime = Runtime()
    telemetry = Telemetry()
    previews = DraftPreviews()
    app = FastAPI()
    app.include_router(RunnerAPI(
        runtime,
        Store(),
        Metrics(),
        telemetry,
        "runner-1",
        "controller-token",
        draft_previews=previews,  # type: ignore[arg-type]
    ).router)  # type: ignore[arg-type]
    plan = {
        "guardrail_id": "guardrail-draft",
        "guardrail_version": 4,
        "compiler_version": "controller-plan-v2",
        "steps": [],
        "modules": [],
    }
    payload = {
        "preview_id": "preview-1",
        "guardrail_id": "guardrail-draft",
        "draft_revision": 7,
        "candidate_version": 4,
        "plan": plan,
        "runtime_profile": "auto",
    }
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
        unauthorized = await client.post("/internal/v1/playground/draft-previews/preview-1", json=payload)
        prepared = await client.post(
            "/internal/v1/playground/draft-previews/preview-1",
            headers={"authorization": "Bearer controller-token"},
            json=payload,
        )
        evaluated = await client.post(
            "/internal/v1/playground/draft-previews/preview-1/evaluate",
            headers={"authorization": "Bearer controller-token", "x-tenant": "preview-tenant"},
            json={
                **{key: value for key, value in payload.items() if key != "guardrail_id"},
                "phase": "input",
                "texts": ["draft prompt"],
                "protocol": "playground",
                "call_id": "draft-call-1",
            },
        )

    assert unauthorized.status_code == 401
    assert prepared.status_code == 200
    assert prepared.json()["ttl_seconds"] == 900
    assert evaluated.status_code == 200
    assert evaluated.json()["guardrail_version"] == 4
    assert previews.prepared["draft_revision"] == 7
    request, evaluation = previews.evaluated
    assert evaluation["guardrail_id"] == "guardrail-draft"
    assert request.context.value("field", "playground.target_kind") == "draft"
    assert telemetry.events == []


@pytest.mark.asyncio
async def test_http_adapter_defaults_to_input_and_rejects_detect_only_bypass():
    runtime = Runtime()
    app = FastAPI()
    app.include_router(RunnerAPI(runtime, Store(), Metrics(), Telemetry(), "runner-1", "controller-token").router)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
        default_input = await client.post(
            "/runtime/v1/integrations/integration-http/guardrails/evaluate",
            headers={"x-api-key": "valid-secret"},
            json={"texts": ["hello"]},
        )
        detect_bypass = await client.post(
            "/runtime/v1/integrations/integration-http/guardrails/evaluate",
            headers={"x-api-key": "valid-secret"},
            json={"texts": ["hello"], "mode": "detect"},
        )

    assert default_input.status_code == 200
    assert runtime.request.phase == "input"
    assert detect_bypass.status_code == 422


@pytest.mark.asyncio
async def test_runtime_distinguishes_adapter_mismatch_from_bad_credentials():
    metrics = Metrics()
    app = FastAPI()
    app.include_router(RunnerAPI(
        Runtime(), Store(), metrics, Telemetry(), "runner-1", "controller-token",
    ).router)  # type: ignore[arg-type]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
        response = await client.post(
            "/runtime/v1/integrations/integration-1/guardrails/evaluate",
            headers={"x-api-key": "valid-secret"},
            json={"texts": ["hello"]},
        )

    assert response.status_code == 409
    assert metrics.rejections == [(('http', 'input', 'adapter_mismatch'), {})]


@pytest.mark.asyncio
async def test_http_adapter_preserves_structured_grounding_and_a2a_routing_facts():
    runtime = Runtime()
    telemetry = Telemetry()
    app = FastAPI()
    app.include_router(RunnerAPI(runtime, Store(), Metrics(), telemetry, "runner-1", "controller-token").router)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
        response = await client.post(
            "/runtime/v1/integrations/integration-a2a/guardrails/evaluate",
            headers={
                "x-api-key": "valid-secret",
                "a2a-version": "1.0",
                "a2a-extensions": "streaming",
                "authorization": "must-not-cross",
            },
            json={
                "protocol": "a2a",
                "input_type": "response",
                "content": [
                    {"id": "query", "text": "What is revenue?", "role": "query", "qualifiers": ["query"]},
                    {"id": "source", "text": "Revenue was 10M.", "role": "grounding_source", "qualifiers": ["grounding_source"]},
                    {"id": "answer", "text": "Revenue was 10M.", "role": "model_output"},
                ],
                "a2a_operation": "tasks/send",
                "a2a_context_id": "context-1",
                "a2a_task_id": "task-1",
                "jwt_claims": {"tenant": "tenant-a"},
                "output_scope": "full",
            },
        )

    assert response.status_code == 200
    assert response.json()["call_id"] == "integration-a2a:task-1"
    assert runtime.request.context.protocol == "a2a"
    assert runtime.request.context.value("field", "a2a.operation") == "tasks/send"
    assert runtime.request.context.value("field", "a2a.version") == "1.0"
    assert runtime.request.context.value("jwt_claim", "tenant") == "tenant-a"
    assert runtime.request.context.value("header", "authorization") is None
    assert [item.id for item in runtime.request.content_blocks] == ["query", "source", "answer"]
    assert runtime.request.evidence_scope == "full"


@pytest.mark.asyncio
async def test_controller_can_evaluate_an_explicit_guardrail_version_without_an_integration_secret():
    runtime = Runtime()
    telemetry = Telemetry()
    app = FastAPI()
    encryption_key = b"runtime-log-encryption-key-32b!!"
    app.include_router(RunnerAPI(runtime, Store(), Metrics(), telemetry, "runner-1", "controller-token", encryption_key).router)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
        unauthorized = await client.post(
            "/internal/v1/guardrails/guardrail-1/evaluate",
            json={"phase": "input", "texts": ["hello"], "guardrail_version": 2},
        )
        response = await client.post(
            "/internal/v1/guardrails/guardrail-1/evaluate",
            headers={"authorization": "Bearer controller-token", "x-api-key": "must-not-cross"},
            json={
                "phase": "input",
                "texts": ["secret prompt"],
                "guardrail_version": 2,
                "call_id": "playground-call-1",
                "protocol": "playground",
            },
        )

    assert unauthorized.status_code == 401
    assert response.status_code == 200
    assert runtime.explicit_guardrail == ("guardrail-1", 2)
    assert runtime.request.context.integration_id is None
    assert runtime.request.context.value("header", "authorization") is None
    assert runtime.request.context.value("header", "x-api-key") is None
    assert telemetry.events[0]["integrationId"] is None
    assert telemetry.events[0]["metadata"]["protocol"] == "playground"
    encrypted = telemetry.events[0]["metadata"]["contentCiphertext"]
    assert "secret prompt" not in encrypted
    prefix, nonce, tag, ciphertext = encrypted.split(":")
    plaintext = AESGCM(encryption_key).decrypt(
        base64.b64decode(nonce),
        base64.b64decode(ciphertext) + base64.b64decode(tag),
        prefix.encode(),
    )
    assert json.loads(plaintext)["contentBefore"][0]["text"] == "secret prompt"


@pytest.mark.asyncio
async def test_litellm_basic_guardrail_api_normalizes_and_maps_the_runtime_contract():
    runtime = Runtime()
    telemetry = Telemetry()
    app = FastAPI()
    app.include_router(RunnerAPI(runtime, Store(), Metrics(), telemetry, "runner-1", "controller-token").router)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
        response = await client.post(
            "/runtime/v1/integrations/integration-1/beta/litellm_basic_guardrail_api",
            headers={"x-api-key": "valid-secret"},
            json={
                "input_type": "request",
                "litellm_call_id": "call-1",
                "litellm_trace_id": "trace-1",
                "texts": ["secret prompt"],
                "structured_messages": [{"role": "user", "content": "secret prompt"}],
                "request_data": {
                    "user_api_key_team_id": "team-a",
                    "target_environment": "production",
                },
                "request_headers": {
                    "host": "relay.example.test",
                    "x-original-method": "post",
                    "authorization": "must-not-cross-the-boundary",
                    "x-api-key": "must-not-cross-the-boundary",
                },
                "model": "openai/gpt-4.1-mini",
            },
        )

    assert response.status_code == 200
    assert response.json() == {"action": "BLOCKED", "blocked_reason": "policy matched"}
    assert runtime.request.phase == "input"
    assert runtime.request.call_id == "integration-1:call-1"
    assert runtime.request.context.protocol == "litellm"
    assert runtime.request.context.value("field", "litellm.team_id") == "team-a"
    assert runtime.request.context.value("field", "target.environment") == "production"
    assert runtime.request.context.value("field", "model") == "openai/gpt-4.1-mini"
    assert runtime.request.context.value("field", "http.method") == "POST"
    assert runtime.request.context.value("header", "host") == "relay.example.test"
    assert runtime.request.context.value("header", "authorization") is None
    assert runtime.request.context.value("header", "x-api-key") is None
    assert telemetry.events[0]["requestId"] == "integration-1:call-1"
    assert telemetry.events[0]["metadata"]["protocol"] == "litellm"
    assert "secret prompt" not in str(telemetry.events[0])


@pytest.mark.asyncio
async def test_litellm_basic_guardrail_api_fails_closed_when_no_deployment_matches():
    telemetry = Telemetry()
    metrics = RunnerMetrics(8)
    app = FastAPI()
    app.include_router(RunnerAPI(NoDeploymentRuntime(), Store(), metrics, telemetry, "runner-1", "controller-token").router)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
        response = await client.post(
            "/runtime/v1/integrations/integration-1/beta/litellm_basic_guardrail_api",
            headers={"x-api-key": "valid-secret"},
            json={"input_type": "request", "texts": ["hello"], "request_data": {}},
        )

    assert response.status_code == 200
    assert response.json() == {
        "action": "BLOCKED",
        "blocked_reason": "No Deployment matches this request.",
    }
    assert telemetry.events[0]["decision"] == "block"
    rendered = generate_latest(metrics.registry).decode()
    assert 'coverage="unknown",disposition="deny",enforcement_mode="enforce",failure_mode="normal",guardrail_id="__unmatched__",integration_id="integration-1",phase="input",protocol="litellm",result="success",traffic_class="runtime"} 1.0' in rendered


@pytest.mark.asyncio
async def test_runtime_failure_after_resolution_keeps_guardrail_metric_identity():
    metrics = RunnerMetrics(8)
    app = FastAPI()
    app.include_router(RunnerAPI(
        ResolvedFailureRuntime(), Store(), metrics, Telemetry(), "runner-1", "controller-token",
    ).router)  # type: ignore[arg-type]

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://runner",
    ) as client:
        response = await client.post(
            "/runtime/v1/integrations/integration-http/guardrails/evaluate",
            headers={"x-api-key": "valid-secret"},
            json={"phase": "output", "texts": ["hello"]},
        )

    assert response.status_code == 500
    rendered = generate_latest(metrics.registry).decode()
    assert 'coverage="unknown",disposition="unknown",enforcement_mode="enforce",failure_mode="normal",guardrail_id="guardrail-resolved",integration_id="integration-http",phase="output",protocol="http",result="error",traffic_class="runtime"} 1.0' in rendered
    assert 'guard_runner_guardrail_execution_failures_total{guardrail_id="guardrail-resolved",integration_id="integration-http",phase="output",protocol="http",reason_class="runtime_exception",result="error",stage="runtime"} 1.0' in rendered
    assert "provider failed" not in rendered


@pytest.mark.asyncio
async def test_telemetry_append_failure_is_a_scoped_request_failure():
    metrics = RunnerMetrics(8)
    app = FastAPI()
    app.include_router(RunnerAPI(
        Runtime(), Store(), metrics, FailingTelemetry(), "runner-1", "controller-token",
    ).router)  # type: ignore[arg-type]

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://runner",
    ) as client:
        response = await client.post(
            "/runtime/v1/integrations/integration-http/guardrails/evaluate",
            headers={"x-api-key": "valid-secret"},
            json={"phase": "input", "texts": ["hello"]},
        )

    assert response.status_code == 500
    rendered = generate_latest(metrics.registry).decode()
    assert 'guard_runner_guardrail_execution_failures_total{guardrail_id="guardrail-1",integration_id="integration-http",phase="input",protocol="http",reason_class="telemetry_append_failed",result="error",stage="telemetry"} 1.0' in rendered
    assert 'guard_runner_failures_total{reason_class="telemetry_append_failed",stage="telemetry"} 1.0' in rendered
    assert "disk-specific path" not in rendered


@pytest.mark.asyncio
async def test_runtime_metrics_use_authenticated_api_integration_not_decision_identity():
    metrics = RunnerMetrics(8)
    app = FastAPI()
    app.include_router(RunnerAPI(
        Runtime(), Store(), metrics, Telemetry(), "runner-1", "controller-token",
    ).router)  # type: ignore[arg-type]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
        response = await client.post(
            "/runtime/v1/integrations/integration-http/guardrails/evaluate",
            headers={"x-api-key": "valid-secret"},
            json={"phase": "input", "texts": ["hello"]},
        )

    assert response.status_code == 200
    rendered = generate_latest(metrics.registry).decode()
    assert 'integration_id="integration-http"' in rendered
    # Runtime() deliberately returns integration-1, proving the decision cannot
    # overwrite the identity authenticated at the API boundary.
    assert 'integration_id="integration-1"' not in rendered


@pytest.mark.asyncio
async def test_internal_api_uses_bounded_sentinel_and_rejected_ids_never_reach_business_metrics():
    metrics = RunnerMetrics(8)
    app = FastAPI()
    app.include_router(RunnerAPI(
        Runtime(), Store(), metrics, Telemetry(), "runner-1", "controller-token",
    ).router)  # type: ignore[arg-type]

    attacker_controlled_id = "caller-supplied-unbounded-series-value"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
        rejected = await client.post(
            f"/runtime/v1/integrations/{attacker_controlled_id}/guardrails/evaluate",
            headers={"x-api-key": "valid-secret"},
            json={"phase": "input", "texts": ["hello"]},
        )
        internal = await client.post(
            "/internal/v1/guardrails/guardrail-1/evaluate",
            headers={"authorization": "Bearer controller-token"},
            json={"phase": "input", "texts": ["hello"], "guardrail_version": 2},
        )

    assert rejected.status_code == 401
    assert internal.status_code == 200
    rendered = generate_latest(metrics.registry).decode()
    assert attacker_controlled_id not in rendered
    assert f'integration_id="{INTERNAL_METRIC_ID}"' in rendered

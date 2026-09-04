from __future__ import annotations

import json
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CHART = ROOT / "charts" / "tali-guard"
DEV_VALUES = CHART / "values-dev.yaml"
DEFAULT_VALUES = CHART / "values.yaml"
DEBUG_VALUES = CHART / "values-debug.yaml"
REQUIRED = (
    "--set", "database.url=postgresql://guard:guard@postgres:5432/guard",
    "--set", "security.artifactSigning.existingSecret=artifact-signing",
    "--set", "security.controlTls.existingSecret=control-tls",
    "--set", "security.bootstrapAdmin.existingSecret=bootstrap-admin",
    "--set", "runner.callContextRedisUrl=redis://redis:6379/0",
)


def render(*values: str) -> list[dict]:
    output = subprocess.run(
        ["helm", "template", "contract", str(CHART), *REQUIRED, *values],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return [item for item in yaml.safe_load_all(output) if item]


def render_dev(*values: str) -> list[dict]:
    output = subprocess.run(
        ["helm", "template", "tali-guard", str(CHART), "--namespace", "tali", "--values", str(DEV_VALUES), *values],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return [item for item in yaml.safe_load_all(output) if item]


def render_error(*values: str) -> str:
    result = subprocess.run(
        ["helm", "template", "contract", str(CHART), *REQUIRED, *values],
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    return result.stderr


def load_values(path: Path) -> dict:
    return yaml.safe_load(path.read_text())


def test_default_values_are_the_production_observability_profile():
    defaults = load_values(DEFAULT_VALUES)

    assert defaults["observability"]["performanceDebug"]["enabled"] is False
    assert defaults["observability"]["tracing"]["enabled"] is False
    assert defaults["observability"]["profiling"]["enabled"] is False
    assert defaults["observability"]["serviceMonitor"]["enabled"] is True
    assert defaults["observability"]["prometheusRule"]["enabled"] is True
    assert defaults["observability"]["grafanaDashboard"]["enabled"] is True


def test_debug_values_explicitly_enable_every_performance_debug_component():
    debug = load_values(DEBUG_VALUES)["observability"]

    assert debug["performanceDebug"]["enabled"] is True
    assert debug["tracing"]["enabled"] is True
    assert debug["tracing"]["sampleRatio"] == 1.0
    assert debug["tracing"]["otlpEndpoint"]
    assert debug["profiling"]["enabled"] is True
    assert debug["profiling"]["serverAddress"]
    assert debug["serviceMonitor"]["enabled"] is True
    assert debug["prometheusRule"]["enabled"] is True
    assert debug["grafanaDashboard"]["enabled"] is True


def test_minimum_install_has_controller_and_two_stable_guardrails_zero_runners():
    documents = render()
    deployments = [item for item in documents if item.get("kind") == "Deployment"]
    stateful_sets = [item for item in documents if item.get("kind") == "StatefulSet"]

    assert [item["metadata"]["name"] for item in deployments] == ["contract-tali-guard-controller"]
    assert [item["metadata"]["name"] for item in stateful_sets] == ["contract-tali-guard-runner"]
    runner = stateful_sets[0]
    assert runner["spec"]["replicas"] == 2
    assert runner["spec"]["serviceName"] == "contract-tali-guard-runner-headless"
    assert runner["spec"]["podManagementPolicy"] == "Parallel"
    assert runner["spec"]["minReadySeconds"] == 5
    runner_pod_spec = runner["spec"]["template"]["spec"]
    assert runner_pod_spec["terminationGracePeriodSeconds"] == 30
    assert runner_pod_spec["containers"][0]["lifecycle"]["preStop"]["exec"]["command"] == [
        "/bin/sh", "-c", "sleep 5",
    ]
    assert deployments[0]["spec"]["replicas"] + runner["spec"]["replicas"] == 3
    pdb = next(item for item in documents if item.get("kind") == "PodDisruptionBudget")
    assert pdb["metadata"]["name"] == "contract-tali-guard-runner-availability"
    assert pdb["spec"]["minAvailable"] == 1


def test_controller_and_runner_have_distinct_images_ports_and_responsibilities():
    documents = render()
    controller_workload = next(item for item in documents if item.get("kind") == "Deployment")
    runner_workload = next(item for item in documents if item.get("kind") == "StatefulSet")
    controller = controller_workload["spec"]["template"]["spec"]["containers"][0]
    runner = runner_workload["spec"]["template"]["spec"]["containers"][0]
    controller_env = {item["name"]: item for item in controller["env"]}
    runner_env = {item["name"]: item for item in runner["env"]}

    assert controller["image"].startswith("ghcr.io/tasklattice/tali-guard-controller:")
    assert runner["image"].startswith("ghcr.io/tasklattice/tali-guard-runner:")
    assert {item["name"] for item in controller["ports"]} == {"http", "grpc"}
    assert {item["name"] for item in runner["ports"]} == {"runtime"}
    assert "CONTROLLER_DATABASE_URL" in controller_env
    assert controller_env["CONTROLLER_RUNTIME_SERVICE_URL"]["value"] == (
        "http://contract-tali-guard-runtime.default.svc.cluster.local:8091"
    )
    assert controller_env["BETTER_AUTH_MIN_PASSWORD_LENGTH"]["value"] == "12"
    assert controller_env["CONTROLLER_ALLOW_LOCAL_DEFAULT_CREDENTIALS"]["value"] == "false"
    assert "GUARD_CONTROLLER_TARGET" in runner_env
    assert controller_env["CONTROLLER_METRICS_TOKEN"]["valueFrom"]["secretKeyRef"]["name"] == "contract-tali-guard-metrics"
    assert runner_env["GUARD_METRICS_TOKEN"]["valueFrom"]["secretKeyRef"]["name"] == "contract-tali-guard-metrics"
    assert "CONTROLLER_DATABASE_URL" not in runner_env
    assert runner_env["GUARD_RUNNER_COMPILER_CAPABLE"]["value"] == "true"
    assert runner_env["GUARD_RUNNER_ID"]["valueFrom"]["fieldRef"]["fieldPath"] == "metadata.name"
    assert runner_env["GUARD_RUNNER_CALL_CONTEXT_REDIS_URL"]["value"] == "redis://redis:6379/0"
    assert "OTEL_EXPORTER_OTLP_ENDPOINT" not in runner_env
    assert "GUARD_PYROSCOPE_SERVER_ADDRESS" not in runner_env


def test_custom_ca_secret_is_mounted_into_controller_and_every_runner_system_certificate_directory():
    documents = render(
        "--set", "security.customCa.existingSecret=model-provider-ca",
        "--set", "security.customCa.certificateKey=company-root.crt",
        "--set", "runner.pools[0].name=gpu",
        "--set", "runner.pools[0].replicaCount=1",
        "--set", "runner.pools[0].maxConcurrency=128",
        "--set", "runner.pools[0].resources.requests.cpu=1",
        "--set", "runner.pools[0].resources.requests.memory=2Gi",
        "--set", "runner.pools[0].resources.limits.memory=8Gi",
    )
    workloads = [
        item for item in documents
        if item.get("kind") in {"Deployment", "StatefulSet"}
        and item["metadata"]["labels"]["app.kubernetes.io/component"] in {"controller", "runner"}
    ]

    assert len(workloads) == 3
    for workload in workloads:
        pod_spec = workload["spec"]["template"]["spec"]
        container = pod_spec["containers"][0]
        mount = next(item for item in container["volumeMounts"] if item["name"] == "custom-ca")
        volume = next(item for item in pod_spec["volumes"] if item["name"] == "custom-ca")

        assert mount == {
            "name": "custom-ca",
            "mountPath": "/etc/ssl/certs/tasklattice-custom-ca.crt",
            "subPath": "tasklattice-custom-ca.crt",
            "readOnly": True,
        }
        assert volume["secret"] == {
            "secretName": "model-provider-ca",
            "items": [{"key": "company-root.crt", "path": "tasklattice-custom-ca.crt"}],
        }


def test_custom_ca_mount_is_absent_when_no_secret_is_configured():
    documents = render()
    workloads = [
        item for item in documents
        if item.get("kind") in {"Deployment", "StatefulSet"}
        and item["metadata"]["labels"]["app.kubernetes.io/component"] in {"controller", "runner"}
    ]

    for workload in workloads:
        pod_spec = workload["spec"]["template"]["spec"]
        assert all(item["name"] != "custom-ca" for item in pod_spec["containers"][0]["volumeMounts"])
        assert all(item["name"] != "custom-ca" for item in pod_spec["volumes"])


def test_runner_trace_and_profile_backends_are_explicit_and_independently_enabled():
    documents = render(
        "--set", "observability.tracing.enabled=true",
        "--set", "observability.tracing.otlpEndpoint=http://tempo.monitoring:4318",
        "--set-json", "observability.tracing.sampleRatio=0.25",
        "--set", "observability.profiling.enabled=true",
        "--set", "observability.profiling.serverAddress=http://pyroscope.monitoring:4040",
        "--set", "observability.profiling.sampleRate=200",
    )
    runner = next(item for item in documents if item.get("kind") == "StatefulSet")
    environment = {
        item["name"]: item["value"]
        for item in runner["spec"]["template"]["spec"]["containers"][0]["env"]
        if "value" in item
    }

    assert environment["OTEL_EXPORTER_OTLP_ENDPOINT"] == "http://tempo.monitoring:4318"
    assert environment["OTEL_TRACES_SAMPLER"] == "parentbased_traceidratio"
    assert environment["OTEL_TRACES_SAMPLER_ARG"] == "0.25"
    assert environment["GUARD_PYROSCOPE_SERVER_ADDRESS"] == "http://pyroscope.monitoring:4040"
    assert environment["GUARD_PYROSCOPE_SAMPLE_RATE"] == "200"


def test_performance_debug_is_one_switch_for_full_runner_observability():
    documents = render("--values", str(DEBUG_VALUES))
    runner = next(item for item in documents if item.get("kind") == "StatefulSet")
    environment = {
        item["name"]: item["value"]
        for item in runner["spec"]["template"]["spec"]["containers"][0]["env"]
        if "value" in item
    }

    assert environment["OTEL_EXPORTER_OTLP_ENDPOINT"] == "http://tempo.monitoring.svc.cluster.local:4318"
    assert environment["OTEL_TRACES_SAMPLER"] == "parentbased_traceidratio"
    assert environment["OTEL_TRACES_SAMPLER_ARG"] == "1"
    assert environment["GUARD_PYROSCOPE_SERVER_ADDRESS"] == "http://pyroscope.monitoring.svc.cluster.local:4040"
    assert environment["GUARD_PYROSCOPE_SAMPLE_RATE"] == "100"
    assert len([item for item in documents if item.get("kind") == "ServiceMonitor"]) == 2
    assert any(item.get("kind") == "PrometheusRule" for item in documents)
    assert any(
        item.get("kind") == "ConfigMap" and item["metadata"]["name"].endswith("grafana-dashboard")
        for item in documents
    )


def test_performance_debug_requires_explicit_trace_and_profile_backends():
    missing_trace = subprocess.run(
        ["helm", "template", "contract", str(CHART), *REQUIRED,
         "--set", "observability.performanceDebug.enabled=true"],
        capture_output=True,
        text=True,
    )
    assert missing_trace.returncode != 0
    assert "observability.tracing.otlpEndpoint is required" in missing_trace.stderr

    missing_profile = subprocess.run(
        ["helm", "template", "contract", str(CHART), *REQUIRED,
         "--set", "observability.performanceDebug.enabled=true",
         "--set", "observability.tracing.otlpEndpoint=http://tempo.monitoring:4318"],
        capture_output=True,
        text=True,
    )
    assert missing_profile.returncode != 0
    assert "observability.profiling.serverAddress is required" in missing_profile.stderr


def test_control_plane_authoring_model_is_optional_and_credential_is_secret_backed():
    baseline = render()
    baseline_controller = next(
        item for item in baseline
        if item.get("kind") == "Deployment"
        and item["metadata"]["labels"]["app.kubernetes.io/component"] == "controller"
    )
    baseline_env = {
        item["name"]: item
        for item in baseline_controller["spec"]["template"]["spec"]["containers"][0]["env"]
    }
    assert baseline_env["MODEL_GUARDRAILS_CONTROL_PLANE_AI_PROVIDER"]["value"] == "Qwen"
    assert "MODEL_GUARDRAILS_CONTROL_PLANE_AI_MODEL" not in baseline_env
    assert "MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY" not in baseline_env

    configured = render(
        "--set", "controlPlaneAgent.provider.baseUrl=http://qwen-control.internal/v1",
        "--set", "controlPlaneAgent.provider.model=Qwen/Qwen3.5-9B",
        "--set", "controlPlaneAgent.provider.existingSecret=provider-keys",
        "--set", "controlPlaneAgent.provider.secretKey=QWEN_API_KEY",
    )
    configured_controller = next(
        item for item in configured
        if item.get("kind") == "Deployment"
        and item["metadata"]["labels"]["app.kubernetes.io/component"] == "controller"
    )
    configured_env = {
        item["name"]: item
        for item in configured_controller["spec"]["template"]["spec"]["containers"][0]["env"]
    }
    assert configured_env["MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY"]["valueFrom"]["secretKeyRef"] == {
        "name": "provider-keys",
        "key": "QWEN_API_KEY",
    }


def test_inline_control_plane_authoring_key_creates_a_dedicated_secret():
    documents = render(
        "--set", "controlPlaneAgent.provider.baseUrl=http://qwen-control.internal/v1",
        "--set", "controlPlaneAgent.provider.model=Qwen/Qwen3.5-9B",
        "--set-string", "controlPlaneAgent.provider.apiKey=test-key",
    )
    secret = next(
        item for item in documents
        if item.get("kind") == "Secret"
        and item["metadata"]["name"] == "contract-tali-guard-control-plane-ai"
    )

    assert secret["stringData"] == {"api-key": "test-key"}


def test_model_runtimes_and_evaluator_bindings_are_wired_to_every_runner():
    documents = render(
        "--set-json", 'models.runtimes=[{"id":"qwen-runtime","client":"openai_chat","base_url":"http://qwen-guard.internal/v1","model":"Qwen/Qwen3Guard-Gen-8B","api_key_env_var":"QWEN_GUARD_KEY","timeout_seconds":15,"max_tokens":128},{"id":"llama-runtime","client":"openai_chat","base_url":"http://llama-guard.internal/v1","model":"meta-llama/Llama-Guard-3-8B","api_key_env_var":"LLAMA_GUARD_KEY","timeout_seconds":10,"max_tokens":64}]',
        "--set-json", 'evaluators.bindings=[{"id":"qwen-content","contract_ref":"tali.guard.content-safety.v1","profile_ref":"tali.qwen3guard.v1","model_ref":"qwen-runtime","priority":10},{"id":"llama-content","contract_ref":"tali.guard.content-safety.v1","profile_ref":"tali.llama-guard-3.v1","model_ref":"llama-runtime","priority":20}]',
        "--set", "models.credentials.existingSecret=provider-keys",
        "--set", "runner.pools[0].name=gpu",
        "--set", "runner.pools[0].replicaCount=1",
        "--set", "runner.pools[0].maxConcurrency=128",
        "--set", "runner.pools[0].resources.requests.cpu=1",
        "--set", "runner.pools[0].resources.requests.memory=2Gi",
        "--set", "runner.pools[0].resources.limits.memory=8Gi",
    )
    runners = [
        item for item in documents
        if item.get("kind") == "StatefulSet"
        and item["metadata"]["labels"]["app.kubernetes.io/component"] == "runner"
    ]

    assert len(runners) == 2
    for runner in runners:
        container = runner["spec"]["template"]["spec"]["containers"][0]
        environment = {
            item["name"]: item
            for item in container["env"]
        }
        runtime_config = json.loads(
            environment["MODEL_GUARDRAILS_MODEL_RUNTIMES_JSON"]["value"]
        )
        binding_config = json.loads(
            environment["MODEL_GUARDRAILS_EVALUATOR_BINDINGS_JSON"]["value"]
        )
        assert [item["id"] for item in runtime_config] == [
            "qwen-runtime", "llama-runtime",
        ]
        assert runtime_config[0] == {
            "id": "qwen-runtime",
            "client": "openai_chat",
            "base_url": "http://qwen-guard.internal/v1",
            "model": "Qwen/Qwen3Guard-Gen-8B",
            "api_key_env_var": "QWEN_GUARD_KEY",
            "timeout_seconds": 15,
            "max_tokens": 128,
        }
        assert runtime_config[1] == {
            "id": "llama-runtime",
            "client": "openai_chat",
            "base_url": "http://llama-guard.internal/v1",
            "model": "meta-llama/Llama-Guard-3-8B",
            "api_key_env_var": "LLAMA_GUARD_KEY",
            "timeout_seconds": 10,
            "max_tokens": 64,
        }
        assert binding_config == [{
            "id": "qwen-content",
            "contract_ref": "tali.guard.content-safety.v1",
            "profile_ref": "tali.qwen3guard.v1",
            "model_ref": "qwen-runtime",
            "priority": 10,
        }, {
            "id": "llama-content",
            "contract_ref": "tali.guard.content-safety.v1",
            "profile_ref": "tali.llama-guard-3.v1",
            "model_ref": "llama-runtime",
            "priority": 20,
        }]
        assert container["envFrom"] == [{"secretRef": {"name": "provider-keys"}}]


def test_chart_rejects_incompatible_or_unknown_evaluator_bindings():
    runtimes = '[{"id":"llama-runtime","client":"openai_chat","base_url":"http://llama-guard.internal/v1","model":"meta-llama/Llama-Guard-3-8B"}]'
    incompatible = '[{"id":"llama-jailbreak","contract_ref":"tali.guard.jailbreak.v1","profile_ref":"tali.llama-guard-3.v1","model_ref":"llama-runtime","priority":10}]'
    unknown = '[{"id":"unknown-runtime","contract_ref":"tali.guard.content-safety.v1","profile_ref":"tali.llama-guard-3.v1","model_ref":"missing","priority":10}]'

    assert "does not implement contract" in render_error(
        "--set-json", f"models.runtimes={runtimes}",
        "--set-json", f"evaluators.bindings={incompatible}",
    )
    assert "references unknown models.runtimes id" in render_error(
        "--set-json", f"models.runtimes={runtimes}",
        "--set-json", f"evaluators.bindings={unknown}",
    )


def test_integration_endpoint_tracks_runner_service_namespace_and_port():
    documents = render(
        "--namespace", "guard-system",
        "--set", "runner.service.port=8091",
    )
    controller = next(
        item for item in documents
        if item.get("kind") == "Deployment"
        and item["metadata"]["labels"]["app.kubernetes.io/component"] == "controller"
    )
    controller_env = {
        item["name"]: item
        for item in controller["spec"]["template"]["spec"]["containers"][0]["env"]
    }

    assert controller_env["CONTROLLER_RUNTIME_SERVICE_URL"]["value"] == (
        "http://contract-tali-guard-runtime.guard-system.svc.cluster.local:8091"
    )


def test_guardrails_zero_cannot_drop_below_two_replicas():
    result = subprocess.run(
        ["helm", "template", "contract", str(CHART), *REQUIRED, "--set", "runner.default.replicaCount=1"],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "GuardRails 0" in result.stderr or "minimum: got 1, want 2" in result.stderr


def test_controller_is_singleton_in_this_release():
    result = subprocess.run(
        ["helm", "template", "contract", str(CHART), *REQUIRED, "--set", "controller.replicaCount=2"],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "controller.replicaCount" in result.stderr or "maximum: got 2, want 1" in result.stderr


def test_control_channel_mtls_secret_is_mandatory():
    required_without_tls = REQUIRED[:4] + REQUIRED[6:]
    result = subprocess.run(
        ["helm", "template", "contract", str(CHART), *required_without_tls],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "configure controlTls existingSecret" in result.stderr


def test_development_values_are_self_contained_and_keep_two_app_components():
    documents = render_dev()
    deployments = [item for item in documents if item.get("kind") == "Deployment"]
    deployments_by_name = {item["metadata"]["name"]: item for item in deployments}
    stateful_sets = [item for item in documents if item.get("kind") == "StatefulSet"]
    secrets = {item["metadata"]["name"]: item for item in documents if item.get("kind") == "Secret"}

    assert {item["metadata"]["name"] for item in deployments} == {
        "tali-guard-controller", "tali-guard-redis",
    }
    assert {item["metadata"]["name"] for item in stateful_sets} == {
        "tali-guard-postgresql", "tali-guard-runner",
    }
    controller_pod = deployments_by_name["tali-guard-controller"]["spec"]["template"]["spec"]
    runner_workload = next(item for item in stateful_sets if item["metadata"]["name"] == "tali-guard-runner")
    runner_pod = runner_workload["spec"]["template"]["spec"]
    assert runner_workload["spec"]["serviceName"] == "tali-guard-runner-headless"
    assert runner_workload["spec"]["replicas"] == 2
    assert runner_pod["containers"][0]["image"].endswith(":dev")
    assert controller_pod["containers"][0]["image"].endswith(":dev")
    controller_env = {item["name"]: item for item in controller_pod["containers"][0]["env"]}
    assert controller_env["CONTROLLER_RUNTIME_SERVICE_URL"]["value"] == (
        "http://tali-guard-runtime.tali.svc.cluster.local:8091"
    )
    assert controller_env["BETTER_AUTH_MIN_PASSWORD_LENGTH"]["value"] == "12"
    assert controller_env["CONTROLLER_ALLOW_LOCAL_DEFAULT_CREDENTIALS"]["value"] == "true"
    assert controller_pod["initContainers"][0]["name"] == "wait-for-postgresql"
    services = {item["metadata"]["name"]: item for item in documents if item.get("kind") == "Service"}
    controller_service = services["tali-guard-controller"]
    controller_public_service = services["tali-guard-controller-public"]
    runner_service = services["tali-guard-runtime"]
    runner_headless_service = services["tali-guard-runner-headless"]
    runner_public_service = services["tali-guard-runtime-public"]
    assert controller_service["spec"]["type"] == "ClusterIP"
    assert {item["port"] for item in controller_service["spec"]["ports"]} == {8080, 9090}
    assert controller_public_service["spec"]["type"] == "LoadBalancer"
    assert [item["port"] for item in controller_public_service["spec"]["ports"]] == [38081]
    assert runner_service["spec"]["type"] == "ClusterIP"
    assert runner_service["spec"]["sessionAffinity"] == "None"
    assert runner_service["spec"]["ports"][0]["port"] == 8091
    assert runner_headless_service["spec"]["clusterIP"] == "None"
    assert runner_headless_service["spec"]["publishNotReadyAddresses"] is True
    redis_service = services["tali-guard-redis"]
    assert redis_service["spec"]["type"] == "ClusterIP"
    assert redis_service["spec"]["ports"][0]["port"] == 6379
    runner_env = {item["name"]: item for item in runner_pod["containers"][0]["env"]}
    assert runner_env["GUARD_RUNNER_CALL_CONTEXT_REDIS_URL"]["value"] == "redis://tali-guard-redis:6379/0"
    assert runner_public_service["spec"]["type"] == "LoadBalancer"
    assert runner_public_service["spec"]["sessionAffinity"] == "None"
    assert runner_public_service["spec"]["ports"][0]["port"] == 38082
    assert "tali-guard-bootstrap-admin" in secrets
    assert secrets["tali-guard-bootstrap-admin"]["stringData"] == {
        "email": "admin@tasklattice.local",
        "password": "admin",
        "name": "Local Administrator",
    }
    assert "tali-guard-artifact-signing" in secrets
    assert set(secrets["tali-guard-control-tls"]["stringData"]) == {
        "ca.crt", "tls.crt", "tls.key", "runner.crt", "runner.key",
    }


def test_production_profile_does_not_install_development_postgresql():
    documents = render()

    stateful_sets = [item for item in documents if item.get("kind") == "StatefulSet"]
    assert [item["metadata"]["name"] for item in stateful_sets] == ["contract-tali-guard-runner"]
    assert all(not item["metadata"]["name"].endswith("postgresql") for item in stateful_sets)
    controller = next(item for item in documents if item.get("kind") == "Deployment" and item["metadata"]["name"].endswith("controller"))
    assert "initContainers" not in controller["spec"]["template"]["spec"]


def test_rollout_revision_updates_controller_and_every_runner_pool():
    documents = render(
        "--set", "rolloutRevision=dev-build-42",
        "--set", "runner.pools[0].name=gpu",
        "--set", "runner.pools[0].replicaCount=1",
        "--set", "runner.pools[0].maxConcurrency=128",
        "--set", "runner.pools[0].resources.requests.cpu=1",
        "--set", "runner.pools[0].resources.requests.memory=2Gi",
        "--set", "runner.pools[0].resources.limits.memory=8Gi",
    )
    workloads = [
        item for item in documents
        if item.get("kind") in {"Deployment", "StatefulSet"}
        and item["metadata"]["labels"].get("app.kubernetes.io/component") in {"controller", "runner"}
    ]

    assert len(workloads) == 3
    assert all(
        item["spec"]["template"]["metadata"]["annotations"]["tasklattice.io/rollout-revision"] == "dev-build-42"
        for item in workloads
    )


def test_extension_pool_is_an_additional_runner_not_a_new_component_type():
    documents = render(
        "--set", "runner.pools[0].name=gpu",
        "--set", "runner.pools[0].replicaCount=3",
        "--set", "runner.pools[0].maxConcurrency=128",
        "--set", "runner.pools[0].resources.requests.cpu=1",
        "--set", "runner.pools[0].resources.requests.memory=2Gi",
        "--set", "runner.pools[0].resources.limits.memory=8Gi",
        "--set", "runner.callContextRedisUrl=redis://redis:6379/0",
    )
    stateful_sets = [item for item in documents if item.get("kind") == "StatefulSet"]

    assert len(stateful_sets) == 2
    extension = next(item for item in stateful_sets if item["metadata"]["name"].endswith("runner-gpu"))
    assert extension["metadata"]["labels"]["app.kubernetes.io/component"] == "runner"
    assert extension["spec"]["replicas"] == 3
    assert extension["spec"]["serviceName"] == "contract-tali-guard-runner-gpu-headless"
    services = {item["metadata"]["name"]: item for item in documents if item.get("kind") == "Service"}
    assert "contract-tali-guard-runtime" in services
    assert "contract-tali-guard-runtime-gpu" in services
    assert "contract-tali-guard-runner-default" not in services
    assert "contract-tali-guard-runner-headless" in services
    assert "contract-tali-guard-runner-gpu-headless" in services
    assert services["contract-tali-guard-runtime"]["spec"]["sessionAffinity"] == "None"


def test_multiple_runner_replicas_require_shared_call_context():
    required_without_redis = REQUIRED[:-2]
    result = subprocess.run(
        ["helm", "template", "contract", str(CHART), *required_without_redis],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "shared Redis is required" in result.stderr


def test_runner_service_monitor_maps_pod_identity_to_runner_id():
    documents = render("--set", "observability.serviceMonitor.enabled=true")
    runner_monitor = next(
        item for item in documents
        if item.get("kind") == "ServiceMonitor"
        and item["metadata"]["labels"]["app.kubernetes.io/component"] == "runner"
    )

    assert runner_monitor["spec"]["endpoints"][0]["relabelings"] == [{
        "action": "replace",
        "sourceLabels": ["__meta_kubernetes_pod_name"],
        "targetLabel": "runner_id",
    }]
    assert "runner_id" not in runner_monitor["spec"]["targetLabels"]


def test_observability_bundle_scrapes_with_auth_and_provisions_rules_and_dashboard():
    documents = render(
        "--set", "observability.serviceMonitor.enabled=true",
        "--set", "observability.prometheusRule.enabled=true",
        "--set", "observability.grafanaDashboard.enabled=true",
    )
    monitors = [item for item in documents if item.get("kind") == "ServiceMonitor"]
    rules = next(item for item in documents if item.get("kind") == "PrometheusRule")
    dashboard = next(
        item for item in documents
        if item.get("kind") == "ConfigMap" and item["metadata"]["name"].endswith("grafana-dashboard")
    )

    assert len(monitors) == 2
    for monitor in monitors:
        endpoint = monitor["spec"]["endpoints"][0]
        assert endpoint["path"] == "/metrics"
        assert endpoint["authorization"]["credentials"] == {
            "name": "contract-tali-guard-metrics",
            "key": "metrics-token",
        }
    group_rules = [rule for group in rules["spec"]["groups"] for rule in group["rules"]]
    alerts = {rule["alert"]: rule for rule in group_rules if "alert" in rule}
    recordings = {rule["record"]: rule for rule in group_rules if "record" in rule}
    assert set(recordings) == {
        "guardrail:checks:rate5m",
        "guardrail:request_duration_seconds_bucket:rate5m",
        "guardrail:availability:ratio5m",
        "guardrail:availability:ratio30m",
        "guardrail:availability:ratio30d",
        "guardrail:latency_seconds:p95_5m",
        "guardrail:latency_seconds:p99_5m",
        "guardrail:coverage:ratio5m",
        "guardrail:fail_open:ratio5m",
        "guardrail:error_budget:remaining_ratio30d",
    }
    assert {
        "TaskLatticeGuardAvailabilityBurnRateFast",
        "TaskLatticeGuardAvailabilityBurnRateSlow",
        "TaskLatticeGuardP95LatencyHigh",
        "TaskLatticeGuardP99LatencyHigh",
        "TaskLatticeGuardCoverageBelowTarget",
        "TaskLatticeGuardFailOpen",
        "TaskLatticeGuardIdentityResolutionFailure",
        "TaskLatticeGuardTelemetryWalWriteFailure",
        "TaskLatticeGuardRunnerMetricsUnavailable",
    } <= set(alerts)
    checks_rule = recordings["guardrail:checks:rate5m"]["expr"]
    bucket_rule = recordings["guardrail:request_duration_seconds_bucket:rate5m"]["expr"]
    for label in ("guardrail_id", "integration_id", "runner_id"):
        assert label in checks_rule
        assert label in bucket_rule
    for removed_dimension in ("deployment_id", "guardrail_version", "phase", "protocol"):
        assert removed_dimension not in checks_rule
        assert removed_dimension not in bucket_rule
    assert "le" in bucket_rule
    assert "result=\"success\"" in recordings["guardrail:latency_seconds:p95_5m"]["expr"]
    assert "guardrail_id" in alerts["TaskLatticeGuardP99LatencyHigh"]["expr"]
    assert "or vector(0)" not in json.dumps(rules)
    controller_scrape_alert = alerts["TaskLatticeGuardControllerMetricsUnavailable"]["expr"]
    assert "min by (namespace, app_kubernetes_io_instance)" in controller_scrape_alert
    assert "max(up" not in controller_scrape_alert
    runner_scrape_alert = alerts["TaskLatticeGuardRunnerMetricsUnavailable"]["expr"]
    assert "tasklattice_io_runner_pool" in runner_scrape_alert
    assert "label_replace" in runner_scrape_alert
    assert '"$1", "pool"' in runner_scrape_alert
    for alert_name in (
        "TaskLatticeGuardGenerationLag",
        "TaskLatticeGuardHeartbeatStale",
        "TaskLatticeGuardTelemetryStale",
    ):
        expression = alerts[alert_name]["expr"]
        assert 'status=~"ready|busy|saturated"' in expression
        assert "and on (namespace, app_kubernetes_io_instance, pool, runner_id)" in expression
    parsed_dashboard = json.loads(dashboard["data"]["tasklattice-guard-overview.json"])
    assert parsed_dashboard["uid"] == "tasklattice-guard-overview"
    assert parsed_dashboard["title"] == "GuardRails Overview"
    variables = parsed_dashboard["templating"]["list"]
    assert [item["name"] for item in variables] == ["guardrail", "integration", "runner"]
    assert [item["label"] for item in variables] == ["GuardRail", "Integration", "Runner"]
    assert "guard_controller_guardrail_info" in variables[0]["query"]["query"]
    assert "guardrail_name" in variables[0]["regex"]
    assert "guard_controller_guardrail_integration_info" in variables[1]["query"]["query"]
    assert "$guardrail" in variables[1]["query"]["query"]
    assert 'status="active"' in variables[1]["query"]["query"]
    assert "integration_name" in variables[1]["regex"]
    assert "guard_controller_runner_info" in variables[2]["query"]["query"]
    assert "$integration" in variables[2]["query"]["query"]
    assert 'status="active"' in variables[2]["query"]["query"]
    panels = {item["title"]: item for item in parsed_dashboard["panels"]}
    assert {
        "System Overview · Global", "System status", "Runner fleet",
        "Uptime & freshness", "Protected topology",
        "Traffic & Latency · Selected scope",
        "Processed GuardRail checks/s", "Latency",
        "Availability", "Complete protection coverage",
        "Integration business SLI · P95",
        "Runner inventory and health · P95", "Diagnostics",
    } <= set(panels)
    assert not {"P90 latency", "P95 latency", "P99 latency", "Telemetry scrape", "Allow RPS", "Deny RPS", "Transform RPS"} & set(panels)
    assert panels["System Overview · Global"]["gridPos"]["y"] == 0
    assert panels["System status"]["gridPos"] == {"h": 4, "w": 6, "x": 0, "y": 1}
    assert panels["Traffic & Latency · Selected scope"]["gridPos"]["y"] == 5
    system_status = panels["System status"]
    status_expression = system_status["targets"][0]["expr"]
    assert "min(up" in status_expression
    assert "label_replace" in status_expression
    assert "tasklattice_io_runner_pool" in status_expression
    assert 'status=~"ready|busy|saturated"' in status_expression
    assert "guard_controller_runner_heartbeat_age_seconds" in status_expression
    assert "guard_controller_runner_generation_lag" in status_expression
    assert "guard_controller_runner_telemetry_age_seconds" in status_expression
    assert "vector(-1)" in status_expression
    status_mappings = system_status["fieldConfig"]["defaults"]["mappings"][0]["options"]
    assert {key: value["text"] for key, value in status_mappings.items()} == {
        "-1": "Unknown", "0": "Unobservable", "1": "Degraded", "2": "Operational",
    }
    runner_fleet = panels["Runner fleet"]
    assert [target["legendFormat"] for target in runner_fleet["targets"]] == [
        "Serving", "Desired", "Scraped",
    ]
    assert runner_fleet["fieldConfig"]["defaults"]["noValue"] == "N/A"
    freshness = panels["Uptime & freshness"]
    assert [target["legendFormat"] for target in freshness["targets"]] == [
        "Controller uptime", "Stalest Runner heartbeat", "Evidence watermark",
    ]
    assert 'status=~"ready|busy|saturated"' in freshness["targets"][1]["expr"]
    assert 'status=~"ready|busy|saturated"' in freshness["targets"][2]["expr"]
    assert "min(guard_controller_runner_telemetry_age_seconds" in freshness["targets"][2]["expr"]
    throughput = panels["Processed GuardRail checks/s"]
    assert [target["legendFormat"] for target in throughput["targets"]] == [
        "allow", "deny", "transform", "technical error", "total",
    ]
    assert throughput["fieldConfig"]["defaults"]["custom"]["stacking"]["mode"] == "normal"
    assert throughput["options"]["legend"]["calcs"] == ["lastNotNull", "mean", "max"]
    assert all("guardrail:checks:rate5m" in target["expr"] for target in throughput["targets"])
    throughput_overrides = throughput["fieldConfig"]["overrides"]
    total_override = next(
        item for item in throughput_overrides
        if item["matcher"] == {"id": "byName", "options": "total"}
    )
    assert {item["id"]: item["value"] for item in total_override["properties"]}[
        "custom.hideFrom"
    ]["viz"] is True
    latency_panel = panels["Latency"]
    assert latency_panel["options"]["legend"]["enableFacetedFilter"] is True
    assert latency_panel["fieldConfig"]["defaults"]["custom"]["lineInterpolation"] == "linear"
    assert [target["legendFormat"] for target in latency_panel["targets"]] == ["P95", "P90", "P99"]
    assert [target["refId"] for target in latency_panel["targets"]] == ["A", "B", "C"]
    assert [target["expr"].split("histogram_quantile(", 1)[1].split(",", 1)[0]
            for target in latency_panel["targets"]] == ["0.95", "0.90", "0.99"]
    for target in latency_panel["targets"]:
        expression = target["expr"]
        assert "sum by (le)" in expression
        assert "guardrail:request_duration_seconds_bucket:rate5m" in expression
        assert 'result="success"' in expression
    for expression in [
        *(target["expr"] for target in throughput["targets"]),
        *(target["expr"] for target in latency_panel["targets"]),
    ]:
        for variable in ("$guardrail", "$integration", "$runner"):
            assert variable in expression
        assert "__unmatched__|__unresolved__" in expression
    integration_panel = panels["Integration business SLI · P95"]
    integration_table = json.dumps(integration_panel)
    assert "guard_controller_integration_info" in integration_table
    assert "integration_name" in integration_table
    assert 'status=\\"active\\"' in integration_table
    assert '"id": "byRegexp", "options": "/^P(90|95|99)$/"' in integration_table
    assert "histogram_quantile(0.95" in integration_panel["targets"][3]["expr"]
    assert "$latency_quantile" not in integration_table
    runner_table = panels["Runner inventory and health · P95"]
    assert runner_table["gridPos"]["w"] == 24
    assert "histogram_quantile(0.95" in runner_table["targets"][2]["expr"]
    assert "$latency_quantile" not in json.dumps(runner_table)
    runner_overrides = json.dumps(runner_table["fieldConfig"]["overrides"])
    assert '"id": "byRegexp", "options": "/^P(90|95|99)$/"' in runner_overrides
    assert panels["Diagnostics"]["collapsed"] is True
    assert {item["title"] for item in panels["Diagnostics"]["panels"]} == {
        "Stage latency · P95",
        "Provider work / queue latency · P95",
        "Evidence pipeline age",
        "Runner convergence diagnostics",
    }
    troubleshooting = json.loads(
        dashboard["data"]["tasklattice-guard-troubleshooting.json"]
    )
    assert troubleshooting["uid"] == "tasklattice-guard-troubleshooting"
    assert [item["name"] for item in troubleshooting["templating"]["list"]][:3] == [
        "guardrail", "integration", "runner",
    ]
    troubleshooting_panels = {
        item["title"]: item for item in troubleshooting["panels"]
    }
    assert {
        "P95", "Model wait", "Latency ownership · P95",
        "Model call latency · P95", "Protection failures/s",
        "GuardRail traces", "Runner CPU flame graph",
    } <= set(troubleshooting_panels)
    assert troubleshooting_panels["GuardRail traces"]["datasource"]["uid"] == (
        "tasklattice-tempo"
    )
    assert troubleshooting_panels["Runner CPU flame graph"]["datasource"]["uid"] == (
        "tasklattice-pyroscope"
    )
    nested_troubleshooting_panels = {
        nested["title"]: nested
        for panel in troubleshooting["panels"]
        for nested in panel.get("panels", [])
    }
    all_troubleshooting_panels = {
        **troubleshooting_panels, **nested_troubleshooting_panels,
    }
    assert {
        "Request failures/s by stage and reason",
        "Model failures · selected range",
        "Disposition throughput",
        "Policy triggers · selected range",
        "Applied interventions/s",
        "Incomplete coverage · selected range",
        "Global entry failures · authentication, routing, rejection",
        "Control convergence · healthy = 0",
        "Global Runner Pool replicas",
        "Runner heartbeat age",
        "Evidence pipeline age",
        "Evidence backlog",
        "Evidence failures/s",
    } <= set(all_troubleshooting_panels)
    troubleshooting_json = json.dumps(troubleshooting)
    assert "guard_runner_guardrail_execution_failures_total" in troubleshooting_json
    assert "guard_runner_guardrail_policy_triggers_total" in troubleshooting_json
    assert "guard_controller_runner_generation_lag" in troubleshooting_json
    assert "guard_runner_generation_lag" not in troubleshooting_json
    assert "guard_controller_runner_desired_replicas" in troubleshooting_json
    assert "guard_controller_runner_ready_replicas" in troubleshooting_json
    assert "guard_runner_control_connected" in troubleshooting_json
    assert "guard_runner_desired_state_synchronized" in troubleshooting_json
    assert "guard_runner_telemetry_wal_events" in troubleshooting_json
    assert "guard_controller_outbox_pending" in troubleshooting_json
    assert "guard_controller_telemetry_delivery_lag_seconds_bucket" in troubleshooting_json
    protection_expression = all_troubleshooting_panels["Protection failures/s"]["targets"][0]["expr"]
    coverage_expression = all_troubleshooting_panels[
        "Incomplete coverage · selected range"
    ]["targets"][0]["expr"]
    assert "module_id" in protection_expression
    assert "module_id" in coverage_expression
    entry_panel = all_troubleshooting_panels[
        "Global entry failures · authentication, routing, rejection"
    ]
    assert "GuardRail and Integration filters intentionally do not apply" in entry_panel["description"]
    assert all('runner_id=~"$runner"' in target["expr"] for target in entry_panel["targets"])
    assert not any(
        variable in target["expr"]
        for target in entry_panel["targets"]
        for variable in ("$guardrail", "$integration")
    )
    assert "$latency_quantile" not in json.dumps(parsed_dashboard)
    assert "or vector(0)" not in json.dumps(parsed_dashboard)

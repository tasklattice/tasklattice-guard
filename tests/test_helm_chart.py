from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
CHART = ROOT / "charts" / "tali-guard"
DEV_VALUES = CHART / "values-dev-uat.yaml"
DEFAULT_VALUES = CHART / "values.yaml"
REQUIRED = (
    "--set", "database.existingSecret=guard-database",
    "--set", "security.artifactSigning.existingSecret=artifact-signing",
    "--set", "security.controlTls.existingSecret=control-tls",
    "--set", "security.bootstrapAdmin.existingSecret=bootstrap-admin",
    "--set", "security.bootstrapUser.existingSecret=bootstrap-user",
    "--set", "runner.callContextRedisUrl=redis://redis:6379/0",
)


def test_context_capacity_defaults_are_persisted_in_all_runner_pools():
    docs = render_dev("--set", "runner.pools[0].name=batch", "--set", "runner.pools[0].replicaCount=1")
    redis = next(d for d in docs if d["kind"] == "Deployment" and d["metadata"]["name"].endswith("-redis"))
    container = redis["spec"]["template"]["spec"]["containers"][0]
    assert container["args"][-4:] == ["--maxmemory", "4gb", "--maxmemory-policy", "noeviction"]
    assert container["resources"]["limits"]["memory"] == "6Gi"
    runners = [d for d in docs if d["kind"] == "StatefulSet" and "runner" in d["metadata"]["name"]]
    assert len(runners) == 2
    for runner in runners:
        env = {v["name"]: v.get("value") for v in runner["spec"]["template"]["spec"]["containers"][0]["env"]}
        assert env["GUARD_RUNNER_CALL_CONTEXT_TTL_SECONDS"] == "300"
        assert env["GUARD_RUNNER_CALL_CONTEXT_COMPRESS_PLANS"] == "true"
        assert env["GUARD_RUNNER_CALL_CONTEXT_CAPACITY_FALLBACK"] == "true"


def test_laya_thresholds_are_independent_and_upgrade_defaults_preserve_zero():
    for options, lower, upper in [([], "0.1", "0.9"),
        (["--set-json", "runner.laya.lowerThreshold=0", "--set-json", "runner.laya.upperThreshold=0.6"], "0", "0.6"),
        (["--set-json", "runner.laya=null"], "0.1", "0.9")]:
        docs = render_dev(*options, "--set", "runner.jev.upperThreshold=0.85")
        runner = next(d for d in docs if d["kind"] == "StatefulSet" and "runner" in d["metadata"]["name"])
        env = {e["name"]: e.get("value") for e in runner["spec"]["template"]["spec"]["containers"][0]["env"]}
        assert env["GUARD_LAYA_LOWER_THRESHOLD"] == lower
        assert env["GUARD_LAYA_UPPER_THRESHOLD"] == upper
        assert env["GUARD_JEV_UPPER_THRESHOLD"] == "0.85"


def test_context_capacity_alerts_are_release_scoped():
    docs = render()
    rule = next(d for d in docs if d["kind"] == "PrometheusRule")
    group = next(g for g in rule["spec"]["groups"] if g["name"] == "tasklattice-guard.context-capacity")
    assert len(group["rules"]) == 5
    assert all('namespace="default"' in r["expr"] and 'app_kubernetes_io_instance="contract"' in r["expr"] for r in group["rules"])
    assert next(r for r in group["rules"] if r["alert"] == "TaskLatticeGuardContextCapacityDegraded")["for"] == "0m"


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


def controller_config(documents):
    return next(doc for doc in documents if doc["kind"] == "ConfigMap" and doc["metadata"]["name"].endswith("controller-config"))


def test_controller_database_budgets_and_runner_concurrency_reach_the_deployment():
    for args, expected in [([], ["30000", "5000", "30000", "4"]),
        (["--set", "controller.databaseTimeouts.statementMs=12000", "--set", "controller.databaseTimeouts.lockMs=1500",
          "--set", "controller.databaseTimeouts.idleTransactionMs=9000", "--set", "controller.runnerSyncConcurrency=2"],
         ["12000", "1500", "9000", "2"])]:
        docs = render(*args)
        deployment = next(d for d in docs if d["kind"] == "Deployment" and d["metadata"]["name"].endswith("-controller"))
        env = resolved_environment(docs, deployment["spec"]["template"]["spec"]["containers"][0])
        names = ["CONTROLLER_DATABASE_STATEMENT_TIMEOUT_MS", "CONTROLLER_DATABASE_LOCK_TIMEOUT_MS",
                 "CONTROLLER_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS", "CONTROLLER_RUNNER_SYNC_CONCURRENCY"]
        assert [env[name]["value"] for name in names] == expected


def resolved_environment(documents, container):
    environment = {entry["name"]: dict(entry) for entry in container["env"]}
    config = controller_config(documents)
    configs = {config["metadata"]["name"]: config["data"]}
    for entry in environment.values():
        ref = entry.get("valueFrom", {}).get("configMapKeyRef")
        if ref:
            entry["value"] = configs[ref["name"]][ref["key"]]
    return environment


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


def test_normal_security_configuration_needs_no_generated_credential_details():
    security = load_values(DEFAULT_VALUES)["security"]
    assert set(security) == {"controlTls", "bootstrapAdmin"}
    assert security["controlTls"] == {"enabled": True}
    documents = render("--set", "security.controlTls.existingSecret=", "--set", "security.artifactSigning.existingSecret=")
    job = next(item for item in documents if item["kind"] == "Job")
    env = {entry["name"]: entry.get("value") for entry in job["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert {spec["kind"] for spec in json.loads(env["BOOTSTRAP_SECRETS"])} == {"ed25519", "tokens", "encryption", "mtls"}
    assert "BEGIN" not in json.dumps(documents)
    for item in documents:
        if item["kind"] in {"Deployment", "StatefulSet"}:
            for volume in item["spec"]["template"]["spec"].get("volumes", []):
                if volume["name"] == "control-tls":
                    assert all(key["key"] != "ca.key" for key in volume["secret"]["items"])


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
    runner_container = runner_pod_spec["containers"][0]
    assert runner_container["startupProbe"]["timeoutSeconds"] == 10
    assert runner_container["readinessProbe"]["timeoutSeconds"] == 10
    assert runner_container["livenessProbe"]["timeoutSeconds"] == 10
    assert runner_container["lifecycle"]["preStop"]["exec"]["command"] == [
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
    controller_env = resolved_environment(documents, controller)
    runner_env = {item["name"]: item for item in runner["env"]}

    assert controller["image"].startswith("ghcr.io/tasklattice/tali-guard-controller:")
    assert runner["image"].startswith("ghcr.io/tasklattice/tali-guard-runner:")
    assert {item["name"] for item in controller["ports"]} == {"http", "grpc"}
    assert {item["name"] for item in runner["ports"]} == {"runtime"}
    assert "CONTROLLER_DATABASE_URL" in controller_env
    assert controller_env["CONTROLLER_RUNTIME_SERVICE_URL"]["value"] == (
        "http://contract-tali-guard-runtime.default.svc.cluster.local:8091"
    )
    assert controller_env["CONTROLLER_RUNTIME_PUBLIC_URL"]["value"] == ""
    assert controller_env["CONTROLLER_MIN_LOGIN_LENGTH"]["value"] == "8"
    assert "GUARD_CONTROLLER_TARGET" in runner_env
    assert runner_env["GUARD_URL"]["value"] == "http://contract-tali-guard-controller:8080"
    assert "GUARD_ACCESS_TOKEN" not in runner_env
    assert controller_env["CONTROLLER_METRICS_TOKEN"]["valueFrom"]["secretKeyRef"]["name"] == "contract-tali-guard-metrics-init"
    assert runner_env["GUARD_METRICS_TOKEN"]["valueFrom"]["secretKeyRef"]["name"] == "contract-tali-guard-metrics-init"
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


@pytest.mark.parametrize("render_profile", [render, render_dev], ids=["production", "development"])
def test_performance_debug_is_one_switch_for_full_runner_observability(render_profile):
    documents = render_profile(
        "--set", "observability.performanceDebug.enabled=true",
        "--set", "observability.tracing.otlpEndpoint=http://tempo.monitoring.svc.cluster.local:4318",
        "--set", "observability.profiling.serverAddress=http://pyroscope.monitoring.svc.cluster.local:4040",
    )
    runner = next(item for item in documents if item.get("kind") == "StatefulSet"
                  and item["metadata"]["labels"]["app.kubernetes.io/component"] == "runner")
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


def assert_settings_managed_models(documents: list[dict]) -> None:
    model_prefixes = (
        "MODEL_GUARDRAILS_CONTROL_PLANE_AI_",
        "MODEL_GUARDRAILS_MODEL_RUNTIMES_",
        "MODEL_GUARDRAILS_EVALUATOR_BINDINGS_",
        "MODEL_GUARDRAILS_AUTOMATED_REASONING_",
    )
    workloads = [
        item for item in documents
        if item.get("kind") in {"Deployment", "StatefulSet"}
        and item["metadata"].get("labels", {}).get("app.kubernetes.io/component")
        in {"controller", "runner"}
    ]
    assert len(workloads) >= 2
    for workload in workloads:
        for container in workload["spec"]["template"]["spec"]["containers"]:
            assert not any(
                item["name"].startswith(model_prefixes)
                for item in container.get("env", [])
            )
            assert not container.get("envFrom")
    assert not any(
        item["metadata"]["name"].endswith(("-control-plane-ai", "-model-runtimes", "-automated-reasoning"))
        for item in documents if item.get("kind") == "Secret"
    )


def test_chart_renders_without_model_configuration_sections():
    values = yaml.safe_load(DEFAULT_VALUES.read_text())
    assert not {"controlPlaneAgent", "models", "evaluators"} & values.keys()
    assert_settings_managed_models(render())
    assert_settings_managed_models(render_dev())


@pytest.mark.parametrize("setting,unknown_key", [
    ("controlPlaneAgent.provider.model=unused", "controlPlaneAgent"),
    ("models.credentials.existingSecret=unused", "models"),
    ("evaluators.automatedReasoning.endpointUrl=http://unused.invalid", "evaluators"),
    ("controller.promotion.export.existingSecret=unused", "promotion"),
    ("controller.promotion.trust.existingConfigMap=unused", "promotion"),
    ("database.url=", "url"),
    ("security.artifactSigning.privateKey=", "privateKey"),
    ("security.artifactSigning.publicKey=", "publicKey"),
    ("observability.slo.runtimeP90Seconds=1", "runtimeP90Seconds"),
    ("controller.replicaCount=2", "replicaCount"),
    ("controller.service.httpPort=8888", "httpPort"),
    ("controller.service.grpcPort=9999", "grpcPort"),
    ("runner.service.port=8881", "port"),
    ("postgresql.service.port=5544", "service"),
    ("redis.service.port=6380", "service"),
    ("serviceAccount.automount=true", "automount"),
    ("runner.scan.maxBodyBytes=65536", "scan"),
    ("runner.scan.timeoutSeconds=15", "scan"),
    ("controller.auth.allowLocalDefaultCredentials=true", "allowLocalDefaultCredentials"),
    ("unknownOption=true", "unknownOption"),
    ("runner.default.maxConcurency=128", "maxConcurency"),
])
def test_removed_and_unknown_options_do_not_change_rendered_resources(setting, unknown_key):
    assert render("--set", setting) == render(), unknown_key


def test_endpoint_tracks_runner_service_namespace_and_port():
    documents = render(
        "--namespace", "guard-system",
    )
    controller = next(
        item for item in documents
        if item.get("kind") == "Deployment"
        and item["metadata"]["labels"]["app.kubernetes.io/component"] == "controller"
    )
    controller_env = resolved_environment(documents, controller["spec"]["template"]["spec"]["containers"][0])

    assert controller_env["CONTROLLER_RUNTIME_SERVICE_URL"]["value"] == (
        "http://contract-tali-guard-runtime.guard-system.svc.cluster.local:8091"
    )


def test_guardrails_zero_cannot_drop_below_one_replica():
    result = subprocess.run(
        ["helm", "template", "contract", str(CHART), *REQUIRED, "--set", "runner.default.replicaCount=0"],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "GuardRails 0" in result.stderr


def test_runtime_public_url_changes_advertising_and_controller_rollout_only():
    baseline = render("--namespace", "uat")
    documents = render("--namespace", "uat", "--set", "runner.publicUrl=https://guard-uat.example.com:8443/base/")
    config = controller_config(documents)["data"]
    assert config["CONTROLLER_RUNTIME_PUBLIC_URL"] == "https://guard-uat.example.com:8443/base/"
    assert config["CONTROLLER_RUNTIME_SERVICE_URL"] == "http://contract-tali-guard-runtime.uat.svc.cluster.local:8091"
    assert config["CONTROLLER_PUBLIC_URL"] == controller_config(baseline)["data"]["CONTROLLER_PUBLIC_URL"]
    before = next(doc for doc in baseline if doc["kind"] == "Deployment")
    after = next(doc for doc in documents if doc["kind"] == "Deployment")
    assert before["spec"]["template"]["metadata"]["annotations"]["checksum/controller-config"] != after["spec"]["template"]["metadata"]["annotations"]["checksum/controller-config"]
    env = resolved_environment(documents, after["spec"]["template"]["spec"]["containers"][0])
    assert env["CONTROLLER_RUNTIME_PUBLIC_URL"]["value"] == config["CONTROLLER_RUNTIME_PUBLIC_URL"]
    assert [doc for doc in baseline if doc["kind"] in {"Service", "StatefulSet"}] == [doc for doc in documents if doc["kind"] in {"Service", "StatefulSet"}]


@pytest.mark.parametrize(("public_url", "origin"), [
    ("https://guard-uat.example.com:8443", "https://guard-uat.example.com:8443"),
    ("https://guard-uat.example.com:8443/", "https://guard-uat.example.com:8443"),
    ("https://Guard-UAT.example.com:443/", "https://guard-uat.example.com"),
    ("http://Guard-UAT.example.com:80/", "http://guard-uat.example.com"),
])
def test_shared_public_url_updates_ui_auth_and_runtime_without_changing_internal_services(public_url, origin):
    baseline = render("--namespace", "uat")
    documents = render("--namespace", "uat", "--set-string", f"publicUrl={public_url}")
    config = controller_config(documents)["data"]
    assert config["CONTROLLER_PUBLIC_URL"] == origin
    assert config["CONTROLLER_RUNTIME_PUBLIC_URL"] == config["CONTROLLER_PUBLIC_URL"]
    assert config["BETTER_AUTH_TRUSTED_ORIGINS"] == config["CONTROLLER_PUBLIC_URL"]
    assert config["CONTROLLER_RUNTIME_SERVICE_URL"] == "http://contract-tali-guard-runtime.uat.svc.cluster.local:8091"
    assert [doc for doc in documents if doc["kind"] in {"Service", "StatefulSet"}] == [
        doc for doc in baseline if doc["kind"] in {"Service", "StatefulSet"}
    ]
    before = next(doc for doc in baseline if doc["kind"] == "Deployment")
    after = next(doc for doc in documents if doc["kind"] == "Deployment")
    assert before["spec"]["template"]["metadata"]["annotations"]["checksum/controller-config"] != after["spec"]["template"]["metadata"]["annotations"]["checksum/controller-config"]


def test_shared_public_url_overrides_local_ui_addresses_and_derives_ingress_host():
    documents = render_dev("--set-string", "publicUrl=https://guard-uat.example.com:8443", "--set", "ingress.enabled=true")
    config = controller_config(documents)["data"]
    assert config["CONTROLLER_PUBLIC_URL"] == config["CONTROLLER_RUNTIME_PUBLIC_URL"] == "https://guard-uat.example.com:8443"
    assert config["BETTER_AUTH_TRUSTED_ORIGINS"] == "https://guard-uat.example.com:8443"
    assert config["CONTROLLER_RUNTIME_SERVICE_URL"] == "http://tali-guard-runtime.tali.svc.cluster.local:8091"
    ingress = next(doc for doc in documents if doc["kind"] == "Ingress")
    assert [rule["host"] for rule in ingress["spec"]["rules"]] == ["guard-uat.example.com"]


def test_shared_public_url_is_trusted_with_extra_origins_and_separate_runtime_domain():
    documents = render(
        "--set-string", "publicUrl=https://guard-uat.example.com:8443",
        "--set-string", "runner.publicUrl=https://runtime.example.com:9443/base",
        "--set-json", 'controller.trustedOrigins=["https://old-ui.example.com","https://guard-uat.example.com:8443"]',
    )
    config = controller_config(documents)["data"]
    assert config["CONTROLLER_PUBLIC_URL"] == "https://guard-uat.example.com:8443"
    assert config["CONTROLLER_RUNTIME_PUBLIC_URL"] == "https://runtime.example.com:9443/base"
    assert config["BETTER_AUTH_TRUSTED_ORIGINS"] == "https://guard-uat.example.com:8443,https://old-ui.example.com"


def test_shared_host_virtualservice_example_matches_rendered_services(tmp_path):
    # Validate the documented override directly; no separate example values file.
    section = (CHART / "README.md").read_text().split("### Share the UI domain and port with runtime requests", 1)[1]
    values = tmp_path / "values-shared-host.yaml"
    values.write_text(section.split("```yaml\n", 1)[1].split("```", 1)[0])
    output = subprocess.run(
        ["helm", "template", "tali-guard-uat", str(CHART), "--namespace", "uat",
         "--values", str(values)],
        check=True, capture_output=True, text=True,
    ).stdout
    documents = [item for item in yaml.safe_load_all(output) if item]
    config = controller_config(documents)["data"]
    assert config["CONTROLLER_RUNTIME_PUBLIC_URL"] == config["CONTROLLER_PUBLIC_URL"] == "https://guard-uat.example.com:8443"
    assert config["BETTER_AUTH_TRUSTED_ORIGINS"] == "https://guard-uat.example.com:8443"
    assert config["CONTROLLER_RUNTIME_SERVICE_URL"] == "http://tali-guard-uat-runtime.uat.svc.cluster.local:8091"
    assert not any(doc["kind"] in {"Ingress", "ServiceMonitor", "PrometheusRule"} for doc in documents)
    controller_deployment = next(doc for doc in documents if doc["kind"] == "Deployment")
    controller_env = resolved_environment(documents, controller_deployment["spec"]["template"]["spec"]["containers"][0])
    assert controller_env["CONTROLLER_DATABASE_URL"]["valueFrom"]["secretKeyRef"] == {
        "name": "tali-guard-uat-database", "key": "database-url",
    }
    assert controller_env["CONTROLLER_BOOTSTRAP_ADMIN_DIRECTORY"]["value"] == "/var/run/tasklattice/bootstrap-admin"
    assert next(volume for volume in controller_deployment["spec"]["template"]["spec"]["volumes"] if volume["name"] == "bootstrap-admin")["secret"]["secretName"] == "tali-guard-uat-bootstrap-admin"
    runner = next(doc for doc in documents if doc["kind"] == "StatefulSet")
    assert runner["spec"]["replicas"] == 2
    runner_env = {entry["name"]: entry.get("value") for entry in runner["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert runner_env["GUARD_URL"] == "http://tali-guard-uat-controller:8080"
    assert runner_env["GUARD_CONTROLLER_TARGET"] == "tali-guard-uat-controller:9090"
    example = load_values(CHART / "examples" / "virtualservice-shared-host.yaml")
    assert example["spec"]["hosts"] == ["guard-uat.example.com"]
    runtime, controller = example["spec"]["http"]
    assert runtime["match"] == [{"uri": {"prefix": "/runtime/v1/endpoints/"}}]
    assert runtime["timeout"] == "0s"
    assert runtime["retries"] == {"attempts": 0}
    assert "rewrite" not in runtime
    assert "match" not in controller
    services = {f'{doc["metadata"]["name"]}.uat.svc.cluster.local': doc for doc in documents if doc["kind"] == "Service"}
    for route, component in ((runtime, "runner"), (controller, "controller")):
        destination = route["route"][0]["destination"]
        service = services[destination["host"]]
        assert service["spec"]["type"] == "ClusterIP"
        assert service["spec"]["selector"]["app.kubernetes.io/component"] == component
        assert destination["port"]["number"] in {port["port"] for port in service["spec"]["ports"]}


def test_internal_wiring_uses_fixed_ports_and_controller_replica_count():
    documents = render_dev()
    for item in documents:
        if item["kind"] in {"Deployment", "StatefulSet"}:
            assert item["spec"]["template"]["spec"]["automountServiceAccountToken"] is False
            if item["metadata"]["labels"]["app.kubernetes.io/component"] == "controller":
                assert item["spec"]["replicas"] == 1
        if item["kind"] == "Service" and not item["metadata"]["name"].endswith("-public"):
            for port in item["spec"]["ports"]:
                assert port["port"] == {"http":8080, "grpc":9090, "runtime":8091, "postgresql":5432, "redis":6379}[port["name"]]
    redis_policy = next(item for item in documents if item["kind"] == "NetworkPolicy" and item["metadata"]["name"].endswith("-redis"))
    assert redis_policy["spec"]["ingress"][0]["ports"][0]["port"] == 6379


def test_public_url_derives_origin_and_ingress_host_with_explicit_overrides():
    documents = render("--set", "controller.publicUrl=https://guard.company.test:8443/app", "--set", "ingress.enabled=true")
    assert controller_config(documents)["data"]["BETTER_AUTH_TRUSTED_ORIGINS"] == "https://guard.company.test:8443"
    ingress = next(item for item in documents if item["kind"] == "Ingress")
    assert ingress["spec"]["rules"][0]["host"] == "guard.company.test"
    documents = render("--set", "controller.publicUrl=https://guard.company.test", "--set", "ingress.enabled=true",
                       "--set", "ingress.host=proxy.company.test",
                       "--set-json", 'controller.trustedOrigins=["https://login.company.test"]')
    assert controller_config(documents)["data"]["BETTER_AUTH_TRUSTED_ORIGINS"] == "https://login.company.test"
    assert next(item for item in documents if item["kind"] == "Ingress")["spec"]["rules"][0]["host"] == "proxy.company.test"


def test_public_url_array_derives_all_origins_and_unique_ingress_hosts():
    urls = ["https://guard.company.test:8443/app", "https://test.company.test", "https://guard.company.test:9443", "https://test.company.test/other", "http://localhost:8092"]
    documents = render("--set-json", "controller.publicUrl=" + json.dumps(urls), "--set", "ingress.enabled=true")
    config = controller_config(documents)["data"]
    assert config["CONTROLLER_PUBLIC_URL"] == urls[0]
    assert config["BETTER_AUTH_TRUSTED_ORIGINS"].split(",") == [
        "https://guard.company.test:8443", "https://test.company.test", "https://guard.company.test:9443", "http://localhost:8092",
    ]
    ingress = next(item for item in documents if item["kind"] == "Ingress")
    assert [rule["host"] for rule in ingress["spec"]["rules"]] == ["guard.company.test", "test.company.test", "localhost"]
    assert all(rule["http"]["paths"][0]["backend"]["service"]["name"] == "contract-tali-guard-controller" for rule in ingress["spec"]["rules"])


def test_public_url_array_keeps_explicit_origin_and_ingress_overrides():
    documents = render("--set-json", 'controller.publicUrl=["https://primary.test","https://secondary.test"]',
                       "--set-json", 'controller.trustedOrigins=["https://custom.test"]',
                       "--set", "ingress.enabled=true", "--set", "ingress.host=custom.test")
    assert controller_config(documents)["data"]["CONTROLLER_PUBLIC_URL"] == "https://primary.test"
    assert controller_config(documents)["data"]["BETTER_AUTH_TRUSTED_ORIGINS"] == "https://custom.test"
    assert [r["host"] for r in next(d for d in documents if d["kind"] == "Ingress")["spec"]["rules"]] == ["custom.test"]


def test_endpoint_ingress_routes_ui_and_runtime():
    documents = render("--set-json", 'controller.publicUrl=["https://primary.test","https://secondary.test"]',
                       "--set", "ingress.enabled=true")
    ingress = next(item for item in documents if item["kind"] == "Ingress")
    for rule in ingress["spec"]["rules"]:
        path = next(path for path in rule["http"]["paths"] if path["path"] == "/runtime/v1/endpoints")
        assert path["pathType"] == "Prefix"
        assert not any(path["path"] == "/backend/v1/scans" for path in rule["http"]["paths"])
        assert path["backend"]["service"] == {"name": "contract-tali-guard-runtime", "port": {"name": "runtime"}}
        ui = next(path for path in rule["http"]["paths"] if path["path"] == "/")
        assert ui["backend"]["service"] == {"name": "contract-tali-guard-controller", "port": {"name": "http"}}


def test_adapter_limits_use_application_defaults():
    documents = render()
    runtime = next(item for item in documents if item["kind"] == "StatefulSet" and item["metadata"]["name"].endswith("-runner"))
    env = {item["name"] for item in runtime["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert "GUARD_SCAN_MAX_BODY_BYTES" not in env
    assert "GUARD_SCAN_TIMEOUT_SECONDS" not in env


def test_image_versions_follow_chart_with_explicit_overrides():
    version = str(load_values(CHART / "Chart.yaml")["appVersion"])
    documents = render()
    for item in documents:
        if item["kind"] in {"Deployment", "StatefulSet"}:
            assert item["spec"]["template"]["spec"]["containers"][0]["image"].endswith(":" + version)
    documents = render("--set", "controller.image.tag=custom-controller", "--set", "runner.image.tag=custom-runner")
    for item in documents:
        if item["kind"] in {"Deployment", "StatefulSet"}:
            component = item["metadata"]["labels"]["app.kubernetes.io/component"]
            assert item["spec"]["template"]["spec"]["containers"][0]["image"].endswith(":custom-" + component)


def test_advanced_partial_overrides_keep_runtime_defaults():
    documents = render("--set", "podSecurityContext.runAsUser=10001", "--set", "securityContext.readOnlyRootFilesystem=false",
                       "--set", "observability.serviceMonitor.interval=30s")
    controller = next(item for item in documents if item["kind"] == "Deployment")
    pod = controller["spec"]["template"]["spec"]
    assert pod["securityContext"]["runAsUser"] == 10001
    assert pod["securityContext"]["runAsNonRoot"] is True
    assert pod["containers"][0]["securityContext"]["readOnlyRootFilesystem"] is False
    for monitor in (item for item in documents if item["kind"] == "ServiceMonitor"):
        for endpoint in monitor["spec"]["endpoints"]:
            assert endpoint["interval"] == "30s"
            assert endpoint["scrapeTimeout"] == "10s"


def test_explicit_internal_defaults_preserve_rendered_resources(tmp_path):
    defaults = load_values(CHART / "files" / "runtime-defaults.yaml")
    defaults["security"] = load_values(CHART / "files" / "security-defaults.yaml")
    overrides = tmp_path / "explicit-defaults.yaml"
    overrides.write_text(yaml.safe_dump(defaults))
    assert render("--values", str(overrides), *REQUIRED) == render()


def test_platform_metadata_at_root_and_nested_values_does_not_block_rendering(tmp_path):
    labels = {"company.example/team": "platform", "company.example/cost-center": "0123"}
    overrides = tmp_path / "platform-values.yaml"
    overrides.write_text(yaml.safe_dump({
        "global": {"labels": labels, "deploymentId": 123, "managed": True},
        "labels": labels,
        "commonLabels": labels,
        "controller": {"labels": labels, "image": {"metadata": {"source": "internal"}}},
        "runner": {"default": {"labels": labels}, "pools": [{
            "name": "extra", "replicaCount": 1, "maxConcurrency": 32, "resources": {}, "labels": labels,
        }]},
        "security": {"bootstrapAdmin": {"metadata": {"owner": "platform"}}},
        "observability": {"serviceMonitor": {"metadata": {"labels": labels}}},
    }))
    pool = [{"name": "extra", "replicaCount": 1, "maxConcurrency": 32, "resources": {}}]
    # The platform owns injection into rendered metadata. Extra Values must
    # neither block rendering nor change chart-owned selectors or settings.
    assert render("--values", str(overrides)) == render("--set-json", "runner.pools=" + json.dumps(pool))


def test_kubernetes_overrides_and_custom_secret_keys_are_preserved(tmp_path):
    overrides = tmp_path / "kubernetes-overrides.yaml"
    overrides.write_text(yaml.safe_dump({
        "imagePullSecrets": [{"name": "registry-login"}],
        "serviceAccount": {"annotations": {"example.com/identity": "guard"}},
        "controller": {"resources": {"limits": {"ephemeral-storage": "1Gi"}}},
        "runner": {"state": {"sizeLimit": "3Gi"}},
        "podSecurityContext": {"supplementalGroups": [10001]},
        "securityContext": {"runAsGroup": 10001},
        "ingress": {"enabled": True, "annotations": {"example.com/ingress": "guard"},
                    "tls": [{"secretName": "public-tls", "hosts": ["guard.example.com"]}]},
        "security": {"controlSecret": {"runnerTokenKey": "custom-runner-token"},
                     "artifactSigning": {"privateKeyKey": "signing-key", "publicKeyKey": "verify-key"}},
    }))
    documents = render("--values", str(overrides))
    pod = _controller(documents)
    assert pod["imagePullSecrets"] == [{"name": "registry-login"}]
    assert pod["securityContext"]["supplementalGroups"] == [10001]
    container = pod["containers"][0]
    assert container["resources"]["limits"]["ephemeral-storage"] == "1Gi"
    assert container["securityContext"]["runAsGroup"] == 10001
    env = resolved_environment(documents, container)
    assert env["CONTROLLER_RUNNER_TOKEN"]["valueFrom"]["secretKeyRef"]["key"] == "custom-runner-token"
    ingress = next(doc for doc in documents if doc["kind"] == "Ingress")
    assert ingress["spec"]["tls"] == [{"secretName": "public-tls", "hosts": ["guard.example.com"]}]
    assert ingress["metadata"]["annotations"]["example.com/ingress"] == "guard"
    account = next(doc for doc in documents if doc["kind"] == "ServiceAccount" and not doc["metadata"].get("annotations", {}).get("helm.sh/hook"))
    assert account["metadata"]["annotations"]["example.com/identity"] == "guard"


def test_explicitly_disabling_all_tls_initialization_requires_an_external_secret():
    required_without_tls = REQUIRED[:4] + REQUIRED[6:]
    result = subprocess.run(
        ["helm", "template", "contract", str(CHART), *required_without_tls, "--set", "security.controlTls.autoGenerate=false"],
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
    assert runner_workload["spec"]["replicas"] == 1
    assert runner_pod["containers"][0]["image"].endswith(":dev")
    assert controller_pod["containers"][0]["image"].endswith(":dev")
    controller_env = resolved_environment(documents, controller_pod["containers"][0])
    assert controller_env["CONTROLLER_RUNTIME_SERVICE_URL"]["value"] == (
        "http://tali-guard-runtime.tali.svc.cluster.local:8091"
    )
    assert controller_env["CONTROLLER_MIN_LOGIN_LENGTH"]["value"] == "8"
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
    assert not secrets
    specs = bootstrap_specs(documents)
    assert any(spec["kind"] == "database" for spec in specs)
    assert any(spec["kind"] == "account" and spec.get("username") == "admin" for spec in specs)
    assert "tali-guard-artifact-signing-init" not in secrets
    for pod in (controller_pod, runner_pod):
        signing_volume = next(volume for volume in pod["volumes"] if volume["name"] == "artifact-signing")
        assert signing_volume["secret"]["secretName"] == "tali-guard-artifact-signing-init"
    assert "tali-guard-control-tls-init" not in secrets
    assert controller_env["CONTROLLER_GRPC_TRANSPORT"]["value"] == "mtls"
    assert any(item.get("kind") == "Job" and item["metadata"]["name"] == "tali-guard-bootstrap" for item in documents)


def test_initialization_reuses_the_controller_image_including_registry_overrides():
    documents = render_dev(
        "--set", "controller.image.repository=registry.example.test/guard/controller",
        "--set", "controller.image.tag=test-release",
        "--set", "controller.image.pullPolicy=IfNotPresent",
        "--set", "imagePullSecrets[0].name=registry-login",
    )
    controller = next(item for item in documents if item["kind"] == "Deployment" and item["metadata"]["name"].endswith("controller"))["spec"]["template"]["spec"]
    bootstrap = next(item for item in documents if item["kind"] == "Job")["spec"]["template"]["spec"]
    main = controller["containers"][0]
    wait = controller["initContainers"][0]
    init = bootstrap["containers"][0]
    health_pod = next(item for item in documents if item["kind"] == "Pod" and item["metadata"]["annotations"].get("helm.sh/hook") == "test")["spec"]
    health = health_pod["containers"][0]
    for container in (main, wait, init, health):
        assert container["image"] == "registry.example.test/guard/controller:test-release"
        assert container["imagePullPolicy"] == "IfNotPresent"
    assert wait["env"] == [next(env for env in main["env"] if env["name"] == "CONTROLLER_DATABASE_URL")]
    assert wait["command"] == ["node", "/opt/tasklattice/guard-controller/scripts/runtime/wait-for-postgresql.mjs"]
    assert init["command"] == ["node", "/opt/tasklattice/guard-controller/scripts/runtime/bootstrap-secrets.mjs"]
    assert controller["imagePullSecrets"] == [{"name": "registry-login"}]
    assert health_pod["imagePullSecrets"] == controller["imagePullSecrets"]
    assert health_pod["automountServiceAccountToken"] is False
    service_account = next(item for item in documents if item["kind"] == "ServiceAccount" and item["metadata"]["name"] == bootstrap["serviceAccountName"])
    assert service_account["imagePullSecrets"] == controller["imagePullSecrets"]
    images = {
        container["image"]
        for item in documents if item["kind"] in {"Deployment", "StatefulSet", "Job"}
        for field in ("containers", "initContainers")
        for container in item["spec"]["template"]["spec"].get(field, [])
    }
    images.update(container["image"] for item in documents if item["kind"] == "Pod" for container in item["spec"]["containers"])
    assert len(images) == 4  # Controller, Runner, PostgreSQL and Redis; no helper image.


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


@pytest.fixture(params=[False, True], ids=["enabled", "performance-debug"])
def service_monitor_flags(request) -> tuple[str, ...]:
    if request.param:
        return (
            "--set", "observability.serviceMonitor.enabled=false",
            "--set", "observability.performanceDebug.enabled=true",
            "--set-string", "observability.tracing.otlpEndpoint=http://tempo.monitoring:4318",
            "--set-string", "observability.profiling.serverAddress=http://pyroscope.monitoring:4040",
        )
    return ("--set", "observability.serviceMonitor.enabled=true")


@pytest.mark.parametrize("labels", [
    pytest.param({}, id="empty"),
    pytest.param({
        "release": "monitoring",
        "team": "platform",
        "example.com/build": "123",
        "example.com/enabled": "true",
        "example.com/optional": "",
    }, id="custom"),
])
def test_service_monitor_labels_only_extend_both_resource_metadata(tmp_path, service_monitor_flags, labels):
    baseline = {
        item["metadata"]["name"]: item
        for item in render(*service_monitor_flags)
        if item.get("kind") == "ServiceMonitor"
    }
    values = tmp_path / "monitoring-labels.yaml"
    values.write_text(yaml.safe_dump({"observability": {"serviceMonitor": {"labels": labels}}}))
    monitors = [
        item for item in render(*service_monitor_flags, "--values", str(values))
        if item.get("kind") == "ServiceMonitor"
    ]

    assert len(monitors) == 2
    assert {item["metadata"]["labels"]["app.kubernetes.io/component"] for item in monitors} == {"controller", "runner"}
    for monitor in monitors:
        original = baseline[monitor["metadata"]["name"]]
        assert monitor["metadata"] == {
            **original["metadata"],
            "labels": original["metadata"]["labels"] | labels,
        }
        # Resource labels must not leak into selectors, target labels or endpoints.
        assert monitor["spec"] == original["spec"]


def test_service_monitor_null_label_override_removes_label(tmp_path):
    values = tmp_path / "monitoring-labels.yaml"
    values.write_text(yaml.safe_dump({"observability": {"serviceMonitor": {
        "labels": {"release": "monitoring", "team": "platform"},
    }}}))
    monitors = [
        item for item in render(
            "--values", str(values),
            "--set-json", "observability.serviceMonitor.labels.team=null",
        )
        if item.get("kind") == "ServiceMonitor"
    ]

    assert len(monitors) == 2
    for monitor in monitors:
        assert monitor["metadata"]["labels"]["release"] == "monitoring"
        assert "team" not in monitor["metadata"]["labels"]


@pytest.mark.parametrize(("key", "value"), [
    ("helm.sh/chart", "custom-chart"),
    # Even supplying the chart's current value must not duplicate its label key.
    ("app.kubernetes.io/name", "tali-guard"),
    ("app.kubernetes.io/instance", "other-release"),
    ("app.kubernetes.io/version", "custom-version"),
    ("app.kubernetes.io/managed-by", "custom-manager"),
    ("app.kubernetes.io/part-of", "custom-platform"),
    ("app.kubernetes.io/component", "custom-component"),
])
def test_service_monitor_chart_label_keys_are_reserved(service_monitor_flags, key, value):
    error = render_error(
        *service_monitor_flags,
        "--set-json", "observability.serviceMonitor.labels=" + json.dumps({key: value}),
    )

    assert "observability.serviceMonitor.labels" in error
    assert f'label "{key}" is reserved by the chart' in error


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
            "name": "contract-tali-guard-metrics-init",
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
    for label in ("guardrail_id", "endpoint_id", "runner_id"):
        assert label in checks_rule
        assert label in bucket_rule
    for removed_dimension in ("router_id", "guardrail_version", "phase", "protocol"):
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
    assert [item["name"] for item in variables] == ["guardrail", "endpoint", "runner"]
    assert [item["label"] for item in variables] == ["GuardRail", "Endpoint", "Runner"]
    assert "guard_controller_guardrail_info" in variables[0]["query"]["query"]
    assert "guardrail_name" in variables[0]["regex"]
    assert "guard_controller_guardrail_endpoint_info" in variables[1]["query"]["query"]
    assert "$guardrail" in variables[1]["query"]["query"]
    assert 'status="active"' in variables[1]["query"]["query"]
    assert "endpoint_name" in variables[1]["regex"]
    assert "guard_controller_runner_info" in variables[2]["query"]["query"]
    assert "$endpoint" in variables[2]["query"]["query"]
    assert 'status="active"' in variables[2]["query"]["query"]
    panels = {item["title"]: item for item in parsed_dashboard["panels"]}
    assert {
        "System Overview · Global", "System status", "Runner fleet",
        "Uptime & freshness", "Protected topology",
        "Traffic & Latency · Selected scope",
        "Processed GuardRail checks/s", "Latency",
        "Availability", "Complete protection coverage",
        "Endpoint business SLI · P95",
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
        for variable in ("$guardrail", "$endpoint", "$runner"):
            assert variable in expression
        assert "__unmatched__|__unresolved__" in expression
    endpoint_panel = panels["Endpoint business SLI · P95"]
    endpoint_table = json.dumps(endpoint_panel)
    assert "guard_controller_endpoint_info" in endpoint_table
    assert "endpoint_name" in endpoint_table
    assert 'status=\\"active\\"' in endpoint_table
    assert '"id": "byRegexp", "options": "/^P(90|95|99)$/"' in endpoint_table
    assert "histogram_quantile(0.95" in endpoint_panel["targets"][3]["expr"]
    assert "$latency_quantile" not in endpoint_table
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
        "guardrail", "endpoint", "runner",
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
    assert "GuardRail and Endpoint filters intentionally do not apply" in entry_panel["description"]
    assert all('runner_id=~"$runner"' in target["expr"] for target in entry_panel["targets"])
    assert not any(
        variable in target["expr"]
        for target in entry_panel["targets"]
        for variable in ("$guardrail", "$endpoint")
    )
    assert "$latency_quantile" not in json.dumps(parsed_dashboard)
    assert "or vector(0)" not in json.dumps(parsed_dashboard)


def test_chart_sources_do_not_bundle_private_key_material():
    import re

    private_key = re.compile(rb"-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----")
    for path in CHART.rglob("*"):
        if path.is_file():
            assert not private_key.search(path.read_bytes()), f"Private key bundled in {path.relative_to(CHART)}"
    assert not load_values(DEV_VALUES)["security"].get("artifactSigning", {}).get("privateKey")


def test_external_secrets_render_references_without_private_keys():
    documents = render(
        "--set", "database.existingSecret=database",
        "--set", "security.controlSecret.existingSecret=control",
        "--set", "security.metrics.existingSecret=metrics",
        "--set", "security.runtimeLogs.existingSecret=runtime-logs",
    )
    assert all(item.get("kind") != "Secret" for item in documents)


def bootstrap_specs(documents):
    job = next(item for item in documents if item["kind"] == "Job")
    env = {item["name"]: item.get("value") for item in job["spec"]["template"]["spec"]["containers"][0]["env"]}
    return json.loads(env["BOOTSTRAP_SECRETS"])


def test_bootstrap_reads_only_current_managed_secret_names():
    documents = render_dev()
    specs = bootstrap_specs(documents)
    role = next(item for item in documents if item["kind"] == "Role")
    names = role["rules"][0]["resourceNames"]
    assert not any(item["kind"] == "Secret" for item in documents)
    assert set(names) == {spec["name"] for spec in specs}


def test_bootstrap_accounts_are_mounted_without_protocol_environment_names():
    documents = render_dev()
    pod = next(item for item in documents if item["kind"] == "Deployment")["spec"]["template"]["spec"]
    env = {item["name"]: item for item in pod["containers"][0]["env"]}
    assert env["CONTROLLER_BOOTSTRAP_ADMIN_DIRECTORY"]["value"] == "/var/run/tasklattice/bootstrap-admin"
    assert next(volume for volume in pod["volumes"] if volume["name"] == "bootstrap-admin")["secret"]["secretName"] == "tali-guard-bootstrap-admin-init"
    assert not any("PASSWORD" in name for name in env)


@pytest.mark.parametrize("field", ["password", "passwordHash"])
def test_bootstrap_ignores_inline_login_material(field):
    assert render_dev("--set", f"security.bootstrapAdmin.{field}=unsupported",
                      "--set", f"security.bootstrapUser.{field}=unsupported") == render_dev()


def test_plaintext_bootstrap_renders_no_private_keys_or_random_secret_material():
    first = render_dev("--set", "security.controlTls.enabled=false", "--set", "runner.pools[0].name=extra", "--set", "runner.pools[0].replicaCount=1",
                       "--set", "runner.pools[0].maxConcurrency=32", "--set-json", "runner.pools[0].resources={}")
    second = render_dev("--set", "security.controlTls.enabled=false", "--set", "runner.pools[0].name=extra", "--set", "runner.pools[0].replicaCount=1",
                        "--set", "runner.pools[0].maxConcurrency=32", "--set-json", "runner.pools[0].resources={}")
    assert first == second  # Stable offline rendering for repeated ArgoCD syncs.
    assert "BEGIN" not in json.dumps(first)
    workloads = [item for item in first if item.get("kind") in {"Deployment", "StatefulSet"} and item["metadata"]["labels"]["app.kubernetes.io/component"] in {"controller", "runner"}]
    assert len(workloads) == 3
    for workload in workloads:
        pod = workload["spec"]["template"]["spec"]
        environment = {entry["name"]: entry for entry in pod["containers"][0]["env"]}
        assert not any(name in environment for name in ["CONTROLLER_GRPC_TLS_CERT_PATH", "CONTROLLER_GRPC_TLS_KEY_PATH", "CONTROLLER_GRPC_TLS_CLIENT_CA_PATH", "GUARD_CONTROLLER_CA_PATH", "GUARD_RUNNER_CLIENT_CERT_PATH", "GUARD_RUNNER_CLIENT_KEY_PATH"])
        assert all(volume["name"] != "control-tls" for volume in pod["volumes"])
        assert all(mount["name"] != "control-tls" for mount in pod["containers"][0]["volumeMounts"])
        token = "CONTROLLER_RUNNER_TOKEN" if workload["kind"] == "Deployment" else "GUARD_CONTROLLER_TOKEN"
        assert environment[token]["valueFrom"]["secretKeyRef"]["name"] == "tali-guard-control-init"
    job = next(item for item in first if item.get("kind") == "Job")
    assert job["metadata"]["annotations"]["helm.sh/hook"] == "pre-install,pre-upgrade,pre-rollback"
    env = {entry["name"]: entry.get("value") for entry in job["spec"]["template"]["spec"]["containers"][0]["env"]}
    generated = {spec["name"] for spec in json.loads(env["BOOTSTRAP_SECRETS"])}
    assert generated == {"tali-guard-control-init", "tali-guard-artifact-signing-init", "tali-guard-metrics-init", "tali-guard-runtime-logs-init", "tali-guard-postgresql-init", "tali-guard-bootstrap-admin-init", "tali-guard-bootstrap-user-init"}
    assert not generated.intersection(item["metadata"]["name"] for item in first if item.get("kind") == "Secret")


def test_mtls_is_initialized_by_the_same_job_without_rendering_private_keys():
    options = ("--set", "security.controlTls.enabled=true")
    documents = render_dev(*options)
    assert documents == render_dev(*options)
    assert "BEGIN" not in json.dumps(documents)
    assert not any(item["kind"] == "Secret" and item["metadata"]["name"] == "tali-guard-control-tls-init" for item in documents)
    job = next(item for item in documents if item["kind"] == "Job")
    env = {entry["name"]: entry.get("value") for entry in job["spec"]["template"]["spec"]["containers"][0]["env"]}
    specs = json.loads(env["BOOTSTRAP_SECRETS"])
    assert len(specs) == 8
    tls = next(spec for spec in specs if spec["kind"] == "mtls")
    assert tls["serverDnsNames"] == ["tali-guard-controller", "tali-guard-controller.tali", "tali-guard-controller.tali.svc", "tali-guard-controller.tali.svc.cluster.local"]
    config = controller_config(documents)
    namespace_role = next(item for item in documents if item["kind"] == "ClusterRole")
    assert namespace_role["rules"] == [{"apiGroups": [""], "resources": ["namespaces"], "verbs": ["get"], "resourceNames": ["tali"]}]
    assert "helm.sh/hook" not in config["metadata"]["annotations"]
    assert config["data"]["CONTROLLER_GRPC_TRANSPORT"] == "mtls"
    for item in documents:
        if item.get("kind") in {"Deployment", "StatefulSet"} and item["metadata"]["labels"]["app.kubernetes.io/component"] in {"controller", "runner"}:
            assert any(volume["name"] == "control-tls" for volume in item["spec"]["template"]["spec"]["volumes"])
    external = render_dev("--set", "security.controlTls.enabled=true", "--set", "security.controlTls.existingSecret=external-tls", "--set", "security.controlTls.autoGenerate=true")
    job = next(item for item in external if item["kind"] == "Job")
    env = {entry["name"]: entry.get("value") for entry in job["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert all(spec["kind"] != "mtls" for spec in json.loads(env["BOOTSTRAP_SECRETS"]))


def test_mtls_autogenerate_works_without_bootstrapping_other_credentials():
    documents = render("--set", "security.bootstrap.enabled=false", "--set", "security.controlSecret.existingSecret=control", "--set", "security.metrics.existingSecret=metrics", "--set", "security.runtimeLogs.existingSecret=logs", "--set", "security.controlTls.existingSecret=", "--set", "security.controlTls.autoGenerate=true")
    job = next(item for item in documents if item["kind"] == "Job")
    env = {entry["name"]: entry.get("value") for entry in job["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert [spec["kind"] for spec in json.loads(env["BOOTSTRAP_SECRETS"])] == ["mtls"]


def test_controller_config_changes_trigger_rollout_without_replacing_owner():
    accounts = ("--set", "security.bootstrapAdmin.existingSecret=bootstrap-admin", "--set", "security.bootstrapUser.existingSecret=bootstrap-user")
    original = render_dev(*accounts)
    changed = render_dev(*accounts, "--set", "controller.auth.minLoginLength=14")
    configs = [controller_config(docs) for docs in (original, changed)]
    assert configs[0]["metadata"] == configs[1]["metadata"]
    assert configs[0]["data"] != configs[1]["data"]
    pods = [next(item for item in docs if item["kind"] == "Deployment" and item["metadata"]["name"].endswith("controller"))["spec"]["template"] for docs in (original, changed)]
    assert pods[0]["metadata"]["annotations"]["checksum/controller-config"] != pods[1]["metadata"]["annotations"]["checksum/controller-config"]


def test_helm_health_script_checks_http_status_and_component():
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread

    documents = render()
    health = next(item for item in documents if item["kind"] == "Pod" and item["metadata"]["annotations"].get("helm.sh/hook") == "test")["spec"]["containers"][0]

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(503 if self.path == "/unavailable" else 200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            body = {"status": "ready", "component": "guard-controller"} if self.path == "/controller" else {"status": "ok", "component": "guard-runner"}
            self.wfile.write(json.dumps(body).encode())

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        for controller_path, expected_code, error in [("/controller", 0, None), ("/unavailable", 1, "HTTP 503"), ("/wrong-component", 1, "unexpected health response")]:
            result = subprocess.run([*health["command"], health["args"][0], base + controller_path, base + "/runner"], capture_output=True, text=True, timeout=15)
            assert result.returncode == expected_code, result.stderr
            if error:
                assert error in result.stderr
            else:
                assert "guard-controller: ready" in result.stdout
                assert "guard-runner: ok" in result.stdout
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def _controller(documents):
    deployment = next(doc for doc in documents if doc["kind"] == "Deployment" and doc["metadata"]["name"].endswith("controller"))
    return deployment["spec"]["template"]["spec"]


def test_promotion_defaults_mount_no_promotion_material_and_switch_no_feature():
    spec = _controller(render())
    container = spec["containers"][0]
    environment = {entry["name"]: entry.get("value") for entry in container["env"]}
    # Every installation has the same features; there is no authoring switch.
    assert "CONTROLLER_AUTHORING_ENABLED" not in environment
    assert not {"CONTROLLER_PACKAGE_SIGNING_KEY_PATH", "CONTROLLER_PACKAGE_TRUST_PATH", "CONTROLLER_BASELINE_PACKAGE_PATH"} & environment.keys()
    assert not {"package-signing", "package-trust", "baseline-package"} & {volume["name"] for volume in spec["volumes"]}


def test_removed_startup_baseline_configuration_has_no_effect():
    assert render(
        "--set", "controller.promotion.baselinePackage.existingConfigMap=guard-baseline",
    ) == render()


def test_development_uat_keeps_local_service_names_and_needs_no_package_configuration():
    documents = render_dev()
    environment = {entry["name"] for entry in _controller(documents)["containers"][0]["env"]}
    assert not any(name.startswith(("CONTROLLER_PACKAGE_", "CONTROLLER_AUTHORING")) for name in environment)
    services = {doc["metadata"]["name"]: doc for doc in documents if doc["kind"] == "Service"}
    assert services["tali-guard-controller-public"]["spec"]["ports"][0]["port"] == 38081
    assert services["tali-guard-runtime-public"]["spec"]["ports"][0]["port"] == 38082
    assert controller_config(documents)["data"]["CONTROLLER_RUNTIME_PUBLIC_URL"] == "http://localhost:38082"
    assert controller_config(documents)["data"]["CONTROLLER_RUNTIME_SERVICE_URL"] == "http://tali-guard-runtime.tali.svc.cluster.local:8091"


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "[::1]"])
def test_local_endpoint_address_uses_runtime_load_balancer_port(host):
    documents = render_dev("--set-json", f'controller.publicUrl=["http://{host}:38081"]',
                           "--set", "runner.service.public.port=39082")
    config = controller_config(documents)["data"]
    assert config["CONTROLLER_PUBLIC_URL"] == f"http://{host}:38081"
    assert config["CONTROLLER_RUNTIME_PUBLIC_URL"] == f"http://{host}:39082"
    assert config["CONTROLLER_RUNTIME_SERVICE_URL"] == "http://tali-guard-runtime.tali.svc.cluster.local:8091"


@pytest.mark.parametrize("overrides", [
    ("--set", "runner.service.public.enabled=false"),
    ("--set", "runner.service.public.type=NodePort"),
    ("--set-json", 'controller.publicUrl=["https://console.example.com"]'),
])
def test_runtime_address_is_not_inferred_without_local_load_balancer(overrides):
    assert controller_config(render_dev(*overrides))["data"]["CONTROLLER_RUNTIME_PUBLIC_URL"] == ""


def test_development_bootstraps_both_roles_with_separate_secrets():
    documents = render_dev()
    accounts = [spec for spec in bootstrap_specs(documents) if spec["kind"] == "account"]
    assert len(accounts) == 2
    for role in ("admin", "user"):
        account = next(spec for spec in accounts if spec["username"] == role)
        assert account["name"] == f"tali-guard-bootstrap-{role}-init"
        assert "localDefault" not in account
        assert not any("password" in key.lower() for key in account)


def test_bootstrap_user_is_enabled_by_default_and_supports_existing_secrets():
    documents = render()
    deployment = next(item for item in documents if item.get("kind") == "Deployment")
    assert any(item["name"].startswith("CONTROLLER_BOOTSTRAP_USER_") for item in deployment["spec"]["template"]["spec"]["containers"][0]["env"])
    documents = render("--set", "security.bootstrapUser.enabled=true", "--set", "security.bootstrapUser.existingSecret=tenant-bootstrap")
    pod = next(item for item in documents if item["kind"] == "Deployment")["spec"]["template"]["spec"]
    assert next(volume for volume in pod["volumes"] if volume["name"] == "bootstrap-user")["secret"]["secretName"] == "tenant-bootstrap"
    assert not any(spec["kind"] == "account" for spec in bootstrap_specs(documents))


@pytest.mark.parametrize("settings,error", [
    (["--set", "security.bootstrapUser.existingSecret=", "--set", "security.bootstrapUser.username=bad@name"], "requires a username"),
    (["--set", "security.bootstrapUser.username=same", "--set", "security.bootstrapAdmin.username=same"], "different usernames"),
])
def test_bootstrap_user_rejects_invalid_configuration(settings, error):
    assert error.lower() in render_error("--set", "security.bootstrapUser.enabled=true", *settings).lower()


def test_both_charts_keep_credentials_out_of_sources_and_rendered_manifests():
    for path in (ROOT / "charts").rglob("*"):
        if path.is_file():
            assert b"password" not in path.read_bytes().lower(), str(path)
    for chart in (CHART, ROOT / "charts/tali-litellm-dev"):
        profile = chart / ("values-dev-uat.yaml" if chart == CHART else "values-dev.yaml")
        output = subprocess.run(["helm", "template", "scan", str(chart), "-f", str(profile)], capture_output=True, text=True, check=True).stdout
        assert "password" not in output.lower()
        assert not any(item and item["kind"] == "Secret" for item in yaml.safe_load_all(output))


def test_database_workload_uses_the_initialized_secret_and_job_runs_before_workloads():
    documents = render_dev()
    spec = next(spec for spec in bootstrap_specs(documents) if spec["kind"] == "database")
    postgres = next(item for item in documents if item["kind"] == "StatefulSet" and item["metadata"]["name"].endswith("-postgresql"))
    assert postgres["spec"]["template"]["spec"]["containers"][0]["envFrom"] == [{"secretRef": {"name": spec["name"]}}]
    job = next(item for item in documents if item["kind"] == "Job")
    assert job["metadata"]["annotations"]["helm.sh/hook"] == "pre-install,pre-upgrade,pre-rollback"
    assert job["spec"]["activeDeadlineSeconds"] == 120


def test_bundled_database_synchronizes_before_serving_using_existing_images():
    documents = render_dev("--set", "controller.image.repository=registry.example.test/controller", "--set", "controller.image.tag=sync-test")
    postgres = next(doc for doc in documents if doc["kind"] == "StatefulSet" and doc["metadata"]["name"].endswith("-postgresql"))
    pod = postgres["spec"]["template"]["spec"]
    prepare, synchronize = pod["initContainers"]
    serving = pod["containers"][0]
    assert prepare["image"] == "registry.example.test/controller:sync-test"
    assert prepare["imagePullPolicy"] == "Never"
    assert prepare["command"] == ["cp", "/opt/tasklattice/guard-controller/scripts/runtime/sync-postgresql.sh", "/opt/tasklattice/postgresql/sync.sh"]
    assert synchronize["command"] == ["bash", "/opt/tasklattice/postgresql/sync.sh"]
    assert synchronize["image"] == serving["image"]
    assert synchronize["env"] == serving["env"]
    assert synchronize["envFrom"] == serving["envFrom"]
    assert next(mount for mount in synchronize["volumeMounts"] if mount["name"] == "data") == next(mount for mount in serving["volumeMounts"] if mount["name"] == "data")
    assert pod["automountServiceAccountToken"] is False
    controller = next(doc for doc in documents if doc["kind"] == "Deployment" and doc["metadata"]["name"].endswith("-controller"))
    for workload in (postgres, controller):
        assert workload["spec"]["template"]["metadata"]["annotations"]["tasklattice.io/database-revision"] == "1"
    external = next(doc for doc in render() if doc["kind"] == "Deployment" and doc["metadata"]["name"].endswith("-controller"))
    assert "tasklattice.io/database-revision" not in external["spec"]["template"]["metadata"]["annotations"]


def test_bootstrap_accounts_use_the_same_contract_on_external_public_urls():
    documents = render_dev("--set", "publicUrl=https://guard.example.com")
    accounts = [spec for spec in bootstrap_specs(documents) if spec["kind"] == "account"]
    assert {spec["username"] for spec in accounts} == {"admin", "user"}
    assert all("localDefault" not in spec for spec in accounts)


def test_long_managed_secret_names_are_unique_and_fit_kubernetes_limits():
    specs = bootstrap_specs(render_dev("--set", "fullnameOverride=" + "guard-" + "x" * 50))
    names = [spec["name"] for spec in specs]
    assert len(names) == len(set(names))
    assert all(len(name) <= 63 for name in names)


def test_local_profile_never_pulls_any_workload_or_helper_image():
    for item in render_dev():
        pod = item["spec"] if item["kind"] == "Pod" else item.get("spec", {}).get("template", {}).get("spec", {})
        for field in ("containers", "initContainers"):
            assert all(container["imagePullPolicy"] == "Never" for container in pod.get(field, []))


def test_trusted_proxy_cidrs_are_opt_in_and_reach_the_controller():
    # Directly connected clients need no proxy contract: the socket peer is used.
    assert "CONTROLLER_TRUSTED_PROXY_CIDRS" not in controller_config(render())["data"]
    config = controller_config(render(
        "--set-json", 'controller.trustedProxyCidrs=["10.244.0.0/16","fd00::/8"]',
    ))["data"]
    assert config["CONTROLLER_TRUSTED_PROXY_CIDRS"] == "10.244.0.0/16,fd00::/8"


def test_runner_validation_and_jev_limits_are_system_configuration():
    runner = next(item for item in render() if item["kind"] == "StatefulSet" and item["metadata"]["name"].endswith("-runner"))
    env = {entry["name"]: entry.get("value") for entry in runner["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert env["GUARD_VALIDATION_MAX_CONCURRENCY"] == "8"
    assert env["GUARD_MODEL_RATE_LIMIT_ATTEMPTS"] == "3"
    assert env["GUARD_JEV_LOWER_THRESHOLD"] == "0.1"
    assert env["GUARD_JEV_UPPER_THRESHOLD"] == "0.9"

    tuned = next(item for item in render(
        "--set", "runner.validation.maxConcurrency=1",
        "--set", "runner.validation.providerRateLimitAttempts=5",
        "--set-json", "runner.jev.lowerThreshold=0.4",
        "--set-json", "runner.jev.upperThreshold=0.6",
    ) if item["kind"] == "StatefulSet" and item["metadata"]["name"].endswith("-runner"))
    tuned_env = {entry["name"]: entry.get("value") for entry in tuned["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert tuned_env["GUARD_VALIDATION_MAX_CONCURRENCY"] == "1"
    assert tuned_env["GUARD_MODEL_RATE_LIMIT_ATTEMPTS"] == "5"
    assert tuned_env["GUARD_JEV_LOWER_THRESHOLD"] == "0.4"
    assert tuned_env["GUARD_JEV_UPPER_THRESHOLD"] == "0.6"

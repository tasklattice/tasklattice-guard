from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parent.parent


def test_local_images_package_the_chart_before_building_both_images():
    result = subprocess.run(
        ["make", "--no-print-directory", "--warn-undefined-variables", "-n", "images",
         "CONTROLLER_REPOSITORY=registry.test/controller", "RUNNER_REPOSITORY=registry.test/runner",
         "DEV_CHART_VERSION=0.0.0-test"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    )
    assert not result.stderr
    assert result.stdout.count("bash scripts/package-runtime-chart.sh") == 1
    assert "TALI_GUARD_CONTROLLER_IMAGE_REPOSITORY=registry.test/controller" in result.stdout
    assert "TALI_GUARD_RUNNER_IMAGE_REPOSITORY=registry.test/runner" in result.stdout
    assert "bash scripts/package-runtime-chart.sh 0.0.0-test" in result.stdout
    package = result.stdout.index("bash scripts/package-runtime-chart.sh")
    controller = result.stdout.index("docker build -f Dockerfile.controller -t registry.test/controller:dev .")
    runner = result.stdout.index("docker build -f Dockerfile.runner -t registry.test/runner:dev .")
    assert package < controller < runner


def test_controller_image_contains_the_packaged_helm_chart():
    dockerfile = (ROOT / "Dockerfile.controller").read_text()

    assert "TALI_HELM_CHART=/opt/tali/helm/tali-guard.tgz" in dockerfile
    assert (
        "COPY --link dist/runtime-chart/tali-guard.tgz "
        "/opt/tali/helm/tali-guard.tgz"
    ) in dockerfile


def test_release_does_not_publish_v_prefixed_image_tags():
    workflow = (ROOT / ".github" / "workflows" / "release.yml").read_text()

    assert '${image}:${GITHUB_REF_NAME}' not in workflow
    assert 'version="${GITHUB_REF_NAME#v}"' in workflow
    assert 'docker buildx imagetools create --tag "${image}:${version}"' in workflow

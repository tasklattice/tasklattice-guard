from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


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

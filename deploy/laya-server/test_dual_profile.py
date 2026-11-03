"""Run alongside the pinned upstream backend tests inside the built image."""
import os
from dataclasses import replace

import pytest
from argon2 import PasswordHasher
from fastapi.testclient import TestClient

os.environ.setdefault("LAYA_ADMIN_USERNAME", "test-admin")
os.environ.setdefault("LAYA_ADMIN_PASSWORD_HASH", PasswordHasher().hash("test-password"))
os.environ.setdefault("LAYA_DATABASE_PATH", "/tmp/laya-dual-import.sqlite3")

from server.config import Settings
from server.laya_adapter import LayaAdapter
from server.main import create_app


PAYLOAD = {"state": "Please refund the duplicate charge.", "questions": {
    "refund": {"type": "noul", "instructions": "Is a refund requested?"}}}


class Predictor:
    def __init__(self):
        self.calls = []

    def predict(self, state, questions, model=None, **overrides):
        self.calls.append((model, overrides))
        return {"model": "laya-rl-agent", "answers": {"refund": {"probability": .9}},
                "usage": {"input_tokens": 37, "output_tokens": 0}}


@pytest.fixture
def dual(tmp_path):
    for model in ("english", "multilingual"):
        for filename in ("rl_agent_config.json", "model.safetensors", "tokenizer/tokenizer.json", "encoder/config.json"):
            path = tmp_path / "models" / model / filename
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
    settings = Settings("admin", PasswordHasher().hash("test-password"), tmp_path / "db.sqlite3",
                        1, tmp_path / "models", "cpu", 2, tmp_path / "missing-dist", "dual")
    predictor = Predictor()
    with TestClient(create_app(settings, predictor)) as client:
        assert client.post("/internal/auth/login", json={"username": "admin", "password": "test-password"}).status_code == 200
        csrf = client.get("/internal/auth/session").json()["csrf_token"]
        key = client.post("/internal/api-keys", json={"name": "dual-test"}, headers={"X-CSRF-Token": csrf}).json()["key"]
        yield client, predictor, settings, {"Authorization": f"Bearer {key}"}


@pytest.mark.parametrize("model,expected", [("auto", None), ("english", "english"), ("multilingual", "multilingual")])
def test_routes_without_rewriting_request(dual, model, expected):
    client, predictor, _, headers = dual
    response = client.post("/v1/systemone", json={**PAYLOAD, "model": model, "max_len": 1024}, headers=headers)
    assert response.status_code == 200
    assert predictor.calls == [(expected, {"max_len": 1024})]
    assert response.json()["usage"]["input_tokens"] == 37


def test_readiness_and_catalog_require_exactly_two_checkpoints(dual):
    client, _, settings, _ = dual
    assert client.get("/health/ready").status_code == 200
    assert client.get("/internal/models").json() == {"models": ["auto", "english", "multilingual"]}
    for model in ("english", "multilingual"):
        weight = settings.model_dir / model / "model.safetensors"
        weight.unlink()
        assert client.get("/health/ready").status_code == 503
        weight.touch()
    with TestClient(create_app(replace(settings, model_profile="all"), Predictor())) as all_client:
        assert all_client.get("/health/ready").status_code == 503


def test_absent_typed_checkpoint_is_rejected_without_inference(dual):
    client, predictor, _, headers = dual
    response = client.post("/v1/systemone", json={**PAYLOAD, "model": "typed-decisions"}, headers=headers)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "MODEL_NOT_AVAILABLE"
    assert predictor.calls == []


def test_original_validation_and_auth_contract(dual):
    client, predictor, _, headers = dual
    response = client.post("/v1/systemone", json={**PAYLOAD, "model": "laya", "head_max_len": 512}, headers=headers)
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "VALIDATION_ERROR"
    assert {(tuple(e["loc"]), e["type"]) for e in detail["errors"]} == {
        (("body", "model"), "literal_error"), (("body", "head_max_len"), "extra_forbidden")}
    assert client.post("/v1/systemone", json=PAYLOAD).status_code == 401
    assert predictor.calls == []


def test_real_router_registry_has_no_hidden_third_checkpoint(tmp_path):
    adapter = LayaAdapter(tmp_path, "cpu", 2, "dual")
    assert set(adapter.router.models) == {"english", "multilingual"}
    assert adapter.router.models == {name: str(tmp_path / name) for name in ("english", "multilingual")}
    with pytest.raises(ValueError, match="not available"):
        adapter.predict(PAYLOAD["state"], PAYLOAD["questions"], model="typed-decisions")


def test_dual_environment_profile(monkeypatch):
    monkeypatch.setenv("LAYA_MODEL_PROFILE", "dual")
    monkeypatch.setenv("LAYA_MAX_LOADED_MODELS", "2")
    settings = Settings.from_env()
    assert settings.model_profile == "dual"
    assert settings.max_loaded_models == 2

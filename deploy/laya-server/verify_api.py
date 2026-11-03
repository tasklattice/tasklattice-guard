"""Verify a running dual deployment. Run with PYTHONPATH=. from the repo root."""
import argparse
import asyncio
from dataclasses import asdict
import json
from pathlib import Path

import httpx

from scripts.evaluate_laya import EvidenceTransport, evaluation_request
from runner.toolkit.nemo.evaluators.laya_content_safety import LayaContentSafetyEvaluator


async def verify(args):
    key = args.key_file.read_text().strip()
    headers = {"Authorization": f"Bearer {key}"}
    root = args.base_url.rstrip("/").removesuffix("/v1")
    report = {"base_url": args.base_url, "checks": []}
    payload = {"state": "Please help me reset my password.", "model": "auto",
               "questions": {"help": {"type": "noul", "instructions": "Does the user request help?"}},
               "max_len": 1024}
    async with httpx.AsyncClient(timeout=60) as client:
        for path in ("/health/live", "/health/ready"):
            response = await client.get(root + path)
            assert response.status_code == 200, response.text
            report["checks"].append({"case": path, "status": response.status_code})
        for name, auth in (("missing-key", {}), ("invalid-key", {"Authorization": "Bearer laya_invalid_test"})):
            response = await client.post(root + "/v1/systemone", json=payload, headers=auth)
            assert response.status_code == 401
            report["checks"].append({"case": name, "status": response.status_code})
        for name, options, expected in (
            ("auto-en", {}, "english"),
            ("auto-zh", {"state": "你好，请帮我重置账户密码。"}, "multilingual"),
            ("explicit-en", {"model": "english"}, "english"),
            ("explicit-multilingual", {"model": "multilingual"}, "multilingual"),
        ):
            response = await client.post(root + "/v1/systemone", json={**payload, **options}, headers=headers)
            assert response.status_code == 200, response.text
            body = response.json()
            assert body["routing"]["model"] == expected, body
            report["checks"].append({"case": name, "status": response.status_code, "body": body})
        response = await client.post(root + "/v1/systemone", json={**payload, "model": "laya", "head_max_len": 512}, headers=headers)
        assert response.status_code == 422
        errors = response.json()["detail"]["errors"]
        assert {(tuple(e["loc"]), e["type"]) for e in errors} == {
            (("body", "model"), "literal_error"), (("body", "head_max_len"), "extra_forbidden")}
        report["checks"].append({"case": "original-422", "status": 422, "body": response.json()})
        response = await client.post(root + "/v1/systemone", json={**payload, "model": "typed-decisions"}, headers=headers)
        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "MODEL_NOT_AVAILABLE"
        report["checks"].append({"case": "uninstalled-typed", "status": 422, "body": response.json()})

    exchanges = []
    evaluator = LayaContentSafetyEvaluator(base_url=args.base_url, model="auto", api_key=key,
        timeout_seconds=20, transport=EvidenceTransport(exchanges))
    for name, content, expected_statuses in (
        ("first", "Hello, have a nice day!", [422, 200]),
        ("cached", "Hello, have a nice day!", [200]),
        ("truncated", "Please help me reset my account password. " * 2000, [200]),
    ):
        exchanges.clear()
        request = evaluation_request({"capability": "content_safety", "content": content})
        result = await evaluator.evaluate(request)
        statuses = [e["response"]["status"] for e in exchanges]
        assert statuses == expected_statuses, statuses
        if name == "truncated":
            assert result.verdict == "error"
            assert any(t.error_type == "LayaInputTruncatedError" for t in result.trace)
        else:
            assert result.verdict != "error"
        report["checks"].append({"case": name, "statuses": statuses, "verdict": result.verdict,
            "trace": [asdict(t) for t in result.trace], "exchanges": list(exchanges)})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({"checks": len(report["checks"]), "status": "passed", "output": str(args.output)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(verify(parser.parse_args()))

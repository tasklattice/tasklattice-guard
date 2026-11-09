#!/usr/bin/env python3
"""Exercise a deployed Scan Endpoint bound to fixtures/scan/demo-guardrail.json.

Uses CALYPSOAI_URL and CALYPSOAI_TOKEN, like F5 DevCentral prompt-evaluator.
This checks TaskLattice's documented compatibility contract, not detection
accuracy or full equivalence with a real F5 deployment.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.environ.get("CALYPSOAI_URL"))
    parser.add_argument("--guardrail-id", default=os.environ.get("SCAN_GUARDRAIL_ID"))
    parser.add_argument("--flag-only-default", choices=("true", "false"), default="true",
                        help="Match the Endpoint default for requests that omit flagOnly")
    parser.add_argument("--schema", type=Path, help="Optional F5 OpenAPI JSON; requires jsonschema")
    parser.add_argument("--output", type=Path, default=Path("output/f5-scan-compatibility.json"))
    parser.add_argument("--max-body-bytes", type=int, default=1048576,
                        help="Match the deployed GUARD_SCAN_MAX_BODY_BYTES (default: 1 MiB)")
    args = parser.parse_args()
    token = os.environ.get("CALYPSOAI_TOKEN")
    if not args.url or not token:
        parser.error("Set CALYPSOAI_URL and CALYPSOAI_TOKEN before running.")
    parsed = urlsplit(args.url)
    if (parsed.scheme not in {"http", "https"} or not parsed.netloc
            or not re.search(r"/runtime/v1/endpoints/[^/]+/?$", parsed.path)
            or parsed.query or parsed.fragment or parsed.username):
        parser.error("CALYPSOAI_URL must be the Endpoint base URL ending in /runtime/v1/endpoints/<endpoint_id>, without a query, fragment or credentials.")
    if args.max_body_bytes < 1024:
        parser.error("--max-body-bytes must be at least 1024.")
    endpoint = args.url.rstrip("/") + "/backend/v1/scans"
    validator = None
    schema_version = None
    if args.schema:
        from jsonschema import Draft202012Validator, FormatChecker
        spec = json.loads(args.schema.read_text())
        schema_version = spec.get("info", {}).get("version")
        validator = Draft202012Validator({"$ref": "#/components/schemas/PostScansResponse",
                                         "components": spec["components"]}, format_checker=FormatChecker())
    opener = build_opener(NoRedirect())
    cases = []
    scan_ids = set()

    def check(name, payload, *, expected="cleared", status=200, text=None,
              auth="valid", media="application/json", raw=None, code=None):
        headers = {"Content-Type": media}
        if auth != "missing":
            headers["Authorization"] = "Bearer " + (token if auth == "valid" else "invalid-scan-test-token")
        encoded = raw if raw is not None else json.dumps(payload, ensure_ascii=False).encode()
        started = time.monotonic()
        record = {"name": name, "expectedStatus": status, "expectedOutcome": expected if status == 200 else None}
        try:
            request = Request(endpoint, data=encoded, headers=headers, method="POST")
            try:
                response = opener.open(request, timeout=30)
            except HTTPError as error:
                response = error
            with response:
                body = json.loads(response.read())
                record.update(status=response.status, response=body)
                assert response.status == status, f"Expected HTTP {status}, got {response.status}"
                request_id = response.headers.get("X-Request-ID")
                UUID(request_id)
                assert request_id not in scan_ids, "Scan ID was reused"
                scan_ids.add(request_id)
                assert response.headers.get("X-TaskLattice-Scan-Compatibility") == "v1"
                if status == 200:
                    if validator:
                        validator.validate(body)
                    assert body["id"] == request_id
                    assert body["result"]["outcome"] == expected
                    assert body["redactedInput"] == (payload["input"] if text is None else text)
                    direction = payload.get("scanDirection", "request")
                    blocked = "F5_SCAN_BLOCK_ME" in payload["input"].upper()
                    wanted_response = body["redactedInput"] if direction == "response" and not blocked else None
                    assert body["result"]["response"] == wanted_response
                    details = body["result"]["scannerResults"]
                    assert len(details) == (1 if payload.get("verbose", False) else 0)
                    if details:
                        detail = details[0]
                        assert detail["outcome"] == ("passed" if expected == "cleared" else "failed")
                        assert detail["scanDirection"] == direction
                        assert detail["data"] == {"type": "custom"}
                        assert datetime.fromisoformat(detail["startedDate"]) <= datetime.fromisoformat(detail["completedDate"])
                        if args.guardrail_id:
                            assert detail["scannerId"] == args.guardrail_id
                    assert body["scanners"] is None
                elif status == 422:
                    assert isinstance(body["detail"], list)
                else:
                    assert body["detail"]["code"] == code
                    assert body["detail"]["requestId"] == request_id
                    if status == 401:
                        assert response.headers.get("WWW-Authenticate") == "Bearer"
            record["passed"] = True
        except Exception as error:
            # Never exclude network or execution failures from the denominator.
            record.update(passed=False, error=f"{type(error).__name__}: {error}")
        record["durationMs"] = round((time.monotonic() - started) * 1000, 2)
        cases.append(record)
        print(f"{'PASS' if record['passed'] else 'FAIL'} {name}")

    samples = [("safe", "Hello world", "cleared", "Hello world"),
               ("block", "F5_SCAN_BLOCK_ME", "blocked", "F5_SCAN_BLOCK_ME"),
               ("redact", "F5_SCAN_REDACT_ME", "redacted", "[REDACTED]")]
    # Response comes first to prove that output scans require no prior input session.
    for direction in ("response", "request"):
        for flag_only in (True, False):
            for verbose in (False, True):
                for name, original, action, transformed in samples:
                    expected = "flagged" if flag_only and action != "cleared" else action
                    check(f"{direction}/{name}/flagOnly={flag_only}/verbose={verbose}",
                          {"input": original, "scanDirection": direction, "flagOnly": flag_only, "verbose": verbose},
                          expected=expected, text=transformed)
    for name, original, action, transformed in samples:
        check(f"defaults/{name}", {"input": original},
              expected="flagged" if args.flag_only_default == "true" and action != "cleared" else action, text=transformed)
    for name, original in (("empty", ""), ("unicode", "你好，世界 😀\n第二行")):
        check(name, {"input": original})
    check("case-insensitive", {"input": "f5_scan_block_me", "flagOnly": False}, expected="blocked")
    check("embedded-redaction", {"input": "Secret: F5_SCAN_REDACT_ME", "flagOnly": False},
          expected="redacted", text="Secret: [REDACTED]")
    ignored = ("project", "externalMetadata", "requestPromptId", "configOverrides", "disabled", "forceEnabled")
    for field in ignored:
        for index, value in enumerate((None, "anything", 123, True, [], {}, ["not-a-uuid"], {"threshold": 0})):
            check(f"ignored/{field}/{index}", {"input": "F5_SCAN_BLOCK_ME", "flagOnly": False, field: value}, expected="blocked")
    check("ignored/all-and-unknown", {"input": "F5_SCAN_BLOCK_ME", "flagOnly": False,
          **dict.fromkeys(ignored, "ignored"), "dry_run": True}, expected="blocked")
    invalid = ({}, [], {"input": None}, {"input": 3}, {"input": "x", "flagOnly": "false"},
               {"input": "x", "verbose": 0}, {"input": "x", "scanDirection": "output"},
               {"input": "x", "flagOnly": None}, {"input": "x", "verbose": None},
               {"input": "x", "scanDirection": None})
    for index, payload in enumerate(invalid):
        check(f"invalid/{index}", payload, status=422)
    check("malformed-json", {}, raw=b"{", status=422)
    check("invalid-json-constant", {}, raw=b'{"input":"x","project":NaN}', status=422)
    for auth in ("missing", "invalid"):
        check(f"auth/{auth}", {"input": "x"}, auth=auth, status=401, code="invalid_credential")
    check("media-type", {"input": "x"}, media="text/plain", status=415, code="unsupported_media_type")
    check("body-limit", {"input": "x", "project": "x" * args.max_body_bytes},
          status=413, code="request_too_large")
    report = {"createdAt": datetime.now(timezone.utc).isoformat(), "endpoint": endpoint,
              "guardrailId": args.guardrail_id, "f5SchemaVersion": schema_version,
              "flagOnlyDefault": args.flag_only_default == "true",
              "scope": "TaskLattice Scan compatibility demo; not a detection benchmark or live F5 comparison",
              "total": len(cases), "passed": sum(case["passed"] for case in cases), "cases": cases}
    report["failed"] = report["total"] - report["passed"]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(f"{report['passed']}/{report['total']} passed; report: {args.output}")
    return 1 if report["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())

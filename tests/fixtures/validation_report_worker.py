"""Execute an actual frozen Controller request and write its Runner wire report.

Used by the large-report PostgreSQL/GuardCtl integration test. No model endpoints
or provider credentials are configured: the fixture's composition is local-only.
"""
from __future__ import annotations

import asyncio
import gzip
import json
from pathlib import Path
import sys
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from runner import generated as protocol
from runner.control_client import RunnerControlClient
from runner.protocol_codec import plan_to_proto, validation_test_to_proto


class Store:
    generation = protection_generation = 0
    model_revision_id = ""

    def verify(self, artifact):
        raise AssertionError("The fixture tests a draft, not a released Artifact")


class Metrics:
    def set_control_state(self, **_kwargs):
        pass

    def job(self, *_args):
        pass

    def set_control_queue_depth(self, _depth):
        pass


async def main():
    payload = json.loads(Path(sys.argv[1]).read_text())
    request = protocol.ValidationRequest(
        run_id=payload["runId"], guardrail_id=payload["guardrailId"],
        candidate_version=payload["candidateVersion"], plan=plan_to_proto(payload["plan"]),
        runtime_profile=payload["runtimeProfile"], test_model_rules=payload.get("testModelRules", True),
        test_cases=[validation_test_to_proto(case) for case in payload["testCases"]],
    )
    client = RunnerControlClient(SimpleNamespace(runner_id="report-runner-0", pool_id="default", compiler_capable=True), Store(), Metrics())
    client._compressed_validation_reports = True
    await asyncio.wait_for(client._validate(request), timeout=90)
    reports = []
    while not client._outgoing.empty():
        message = client._outgoing.get_nowait()
        if message.HasField("validation_report"):
            reports.append(message)
    assert len(reports) == 1
    wire = reports[0]
    result = protocol.ValidationResult.FromString(gzip.decompress(wire.validation_report.gzip_result))
    assert result.accepted, result.reason
    assert len(result.results) == len(request.test_cases)
    assert result.test_scope.model_invocations == 0
    Path(sys.argv[2]).write_bytes(wire.SerializeToString())
    print(json.dumps({"cases": len(result.results), "status": protocol.ValidationStatus.Name(result.status),
                      "rawBytes": wire.validation_report.raw_size_bytes, "wireBytes": wire.ByteSize()}))


if __name__ == "__main__":
    asyncio.run(main())

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
import struct
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
    task = asyncio.create_task(client._validate(request))
    count, raw_bytes, wire_bytes, parts = 0, 0, 0, 0
    with Path(sys.argv[2]).open("wb") as output:
        while True:
            message = await asyncio.wait_for(client._outgoing.get(), 90)
            if not message.HasField("validation_report_chunk"):
                continue
            chunk = message.validation_report_chunk
            raw = gzip.decompress(chunk.gzip_result)
            result = protocol.ValidationResult.FromString(raw)
            count += len(result.results)
            encoded = message.SerializeToString()
            output.write(struct.pack(">I", len(encoded)))
            output.write(encoded)
            raw_bytes += len(raw)
            wire_bytes += len(encoded)
            parts += 1
            await client._handle(protocol.ControllerMessage(validation_report_chunk_ack=protocol.ValidationReportChunkAck(
                run_id=chunk.run_id, upload_id=chunk.upload_id, sequence=chunk.sequence)))
            if chunk.final:
                break
    await asyncio.wait_for(task, 30)
    assert result.accepted and count == len(request.test_cases)
    assert result.test_scope.model_invocations == 0
    print(json.dumps({"cases": count, "status": protocol.ValidationStatus.Name(result.status), "rawBytes": raw_bytes, "wireBytes": wire_bytes, "parts": parts}))
    for spool in client._report_spools.values():
        spool.close()


if __name__ == "__main__":
    asyncio.run(main())

"""Scenario adapter for a compiled Controller Default plan, not isolated actions.

The caller must explicitly choose a full plan with model providers or the local
projection. Independent documents can be quarantined separately; a document is
never split using a known attack payload, benchmark label or reference answer.
"""
from dataclasses import asdict

from runner.api import GuardrailContext, _request_content
from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from scripts.evaluate_security_benchmarks import canonical_hash
from .models import GuardResult


class DefaultGuard:
    def __init__(self, plan, providers, *, scope):
        if plan["guardrail_id"] != "guardrail-default" or scope not in {"default_full", "default_local_projection"}:
            raise ValueError("An explicit Default plan/scope is required")
        self.runtime = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(*providers))
        self.identity = dict(preview_id="scenario-default", guardrail_id=plan["guardrail_id"],
            draft_revision=1, candidate_version=plan["guardrail_version"], plan=plan, runtime_profile="auto")
        self.metadata = {"kind": "compiled_default_runtime", "scope": scope,
            "plan_sha256": canonical_hash(plan), "quarantine_unit": "caller_supplied_document_or_record",
            "segmentation": "none", "unknown_action": "quarantine_not_confirmed_detection"}

    async def prepare(self):
        await self.runtime.prepare(**self.identity)

    async def close(self):
        await self.runtime.shutdown()

    async def check(self, text, query, stage):
        return await self.check_with_context(text, query, stage, source_query=None)

    async def check_with_context(self, text, query, stage, *, source_query):
        return (await self.check_documents((text,), query, stage, source_query=source_query))[0]

    async def check_documents(self, documents, query, stage, *, source_query=None):
        if stage not in {"external_read", "memory_read", "memory_write"}:
            raise ValueError("Unknown content boundary")
        if not documents:
            return ()
        if len(documents) > 64:
            raise ValueError("At most 64 independent documents per request")
        context = {"query": query, "target_source": "retrieved_content"}
        if stage != "external_read":
            context["memory"] = {"operation": stage.removeprefix("memory_"), "source_query": source_query or ""}
        blocks = _request_content("input", documents, GuardrailContext.model_validate(context))
        result = await self.runtime.evaluate(ProtectionRequest(phase="input", texts=tuple(documents),
            content_blocks=blocks, context=RequestContext(protocol="playground"), evidence_scope="full", execution_purpose="validation"), **self.identity)
        # Return per-document dispositions. An aggregate block must not erase
        # unrelated, independently inspected records. No partial document reuse.
        results = []
        for block, disposition in zip(blocks[:len(documents)], result.content_results[:len(documents)], strict=True):
            if block.id != disposition.id or not disposition.evaluated:
                raise ValueError("Incomplete or reordered Default coverage")
            trace = [step for step in result.trace if step.content_block_id == block.id]
            failed = any(step.error_type or step.status in {"error", "failed"} for step in trace)
            unknown = any(step.kind == "action" and step.verdict == "unknown" for step in trace)
            decision = "error" if failed else "unknown" if unknown else disposition.decision
            # Fail-closed without attributable block evidence cannot be scored
            # as a detector success, even if other blocks completed normally.
            if result.usage and result.usage.fail_closed and not failed:
                decision = "error"
            results.append(GuardResult(decision=decision, text=disposition.text or "", evidence={
                **self.metadata, "boundary": stage, "content_block_id": block.id,
                "aggregate_decision": result.decision, "input_sha256": canonical_hash(block.text),
                "trace": [asdict(step) for step in trace],
                "usage": asdict(result.usage) if result.usage else None}))
        return tuple(results)

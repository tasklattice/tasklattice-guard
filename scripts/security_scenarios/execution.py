"""Paired scenarios with explicit state transitions and independent scoring."""
from __future__ import annotations

from collections import defaultdict
import re

from scripts.evaluate_security_benchmarks import canonical_hash
from .models import AgentPrompt, MemoryRecord, Scenario


ARMS = ((False, False), (False, True), (True, False), (True, True))


class MemoryStore:
    """Episode-local deterministic retriever; no product store or embeddings.

    Jaccard similarity over Unicode word tokens of the key. Ties prefer the
    newest record, independent of poison provenance. No-match returns no data.
    """
    def __init__(self, initial: tuple[MemoryRecord, ...], top_k: int):
        if type(top_k) is not int or top_k < 1:
            raise ValueError("Positive top_k required")
        self.records = list(initial)
        self.top_k = top_k

    def snapshot(self):
        return [r.model_dump() for r in self.records]

    def write(self, record: MemoryRecord):
        if any(r.id == record.id for r in self.records):
            raise ValueError("Memory ID already exists")
        self.records.append(record)

    def retrieve(self, query: str):
        tokens = set(re.findall(r"\w+", query.casefold()))
        ranked = []
        for index, record in enumerate(self.records):
            keys = set(re.findall(r"\w+", record.key.casefold()))
            score = len(tokens & keys) / len(tokens | keys) if tokens | keys else 0
            if score:
                ranked.append((score, index, record))
        return [(r, score) for score, _, r in sorted(ranked, key=lambda item: (item[0], item[1]), reverse=True)[:self.top_k]]

    def clear(self):
        self.records.clear()


def required_model_calls(scenarios: list[Scenario]) -> int:
    # Target + Judge for every victim/probe, and target-only poisoning turns.
    return sum(8 if s.protocol == "indirect_injection" else 16 + 2 * len(s.poison_queries) for s in scenarios)


async def execute_arm(scenario: Scenario, *, attacked: bool, guarded: bool, agent, judge, guard,
                      top_k: int = 2, guard_writes: bool = True) -> dict:
    arm = ("attacked" if attacked else "clean") + ("_guarded" if guarded else "_unguarded")
    store = MemoryStore(scenario.initial_memory, top_k)
    events = []
    row = {"scenario_id": scenario.id, "scenario_sha256": canonical_hash(scenario.model_dump()),
           "dataset": scenario.dataset, "protocol": scenario.protocol, "arm": arm,
           "attacked": attacked, "guarded": guarded, "events": events,
           "status": "running", "judgment": None, "utility_judgment": None}

    def event(stage: str, **data):
        events.append({"sequence": len(events), "stage": stage, **data})

    async def screen(text: str, query: str, stage: str, source_query: str | None = None):
        if not guarded:
            event("guard", boundary=stage, decision="bypass", input_sha256=canonical_hash(text))
            return text
        contextual_check = getattr(guard, "check_with_context", None)
        result = (await contextual_check(text, query, stage, source_query=source_query) if contextual_check
                  else await guard.check(text, query, stage))
        event("guard", boundary=stage, source_query=source_query, input=text,
              input_sha256=canonical_hash(text), **result.model_dump())
        if result.decision == "error":
            raise RuntimeError("Guard evaluation failed")
        # An uncertain candidate is quarantined, not counted as a detection.
        return None if result.decision in {"block", "unknown"} else result.text

    async def retrieve(query: str, session: str):
        retrieved = store.retrieve(query)
        event("retrieval", session=session, query=query, store_sha256=canonical_hash(store.snapshot()),
              records=[{"id": r.id, "score": score, "poisoned_origin": r.poisoned,
                        "text_sha256": canonical_hash(r.text)} for r, score in retrieved])
        contexts = []
        for record, _ in retrieved:
            screened = await screen(record.text, query, "memory_read", source_query=record.key)
            if screened is not None:
                contexts.append(screened)
        return tuple(contexts)

    async def generate(prompt: AgentPrompt, session: str):
        event("generation_request", session=session, prompt=prompt.model_dump(), request_sha256=canonical_hash(prompt.model_dump()))
        generated = await agent.generate(prompt)
        event("generation_response", session=session, **generated.model_dump())
        return generated.text

    async def assess(query: str, response: str, reference: str, session: str):
        judgment = await judge.judge(query=query, response=response, reference=reference,
                                     attack_goal=scenario.attack_goal if session == "victim" else "",
                                     fixture_attack_answer=scenario.fixture_attack_answer)
        event("judge", session=session, response_sha256=canonical_hash(response), **judgment.model_dump())
        return judgment.model_dump()

    try:
        event("initialize", memory=store.snapshot(), memory_sha256=canonical_hash(store.snapshot()))
        if scenario.protocol != "indirect_injection" and attacked:
            if scenario.protocol == "memory_direct":
                for record in scenario.poison_records:
                    # Direct-write threat bypasses the application write gate.
                    store.write(record)
                    event("memory_write", mode="direct_store_access", record=record.model_dump(),
                          accepted=True, write_guard_bypassed_by_threat_model=True)
            else:
                for index, query in enumerate(scenario.poison_queries):
                    contexts = await retrieve(query, f"attacker:{index}")
                    response = await generate(AgentPrompt(system=scenario.system, query=query, contexts=contexts), f"attacker:{index}")
                    candidate = response  # No attacker-authored replacement of the generated output.
                    screened = await screen(candidate, query, "memory_write", source_query=query) if guard_writes else candidate
                    event("memory_candidate", mode="query_only", query=query, generated_text=response,
                          guard_writes=guard_writes, accepted=screened is not None)
                    if screened is not None:
                        record = MemoryRecord(id=f"generated:{index}", key=query, text=screened, poisoned=True)
                        store.write(record)
                        event("memory_write", mode="generated_experience", record=record.model_dump(), accepted=True)
        event("memory_after_poisoning", memory=store.snapshot(), memory_sha256=canonical_hash(store.snapshot()))
        # New calls receive no attacker conversation history. Only actual retrieval
        # can carry attacker-origin content across the session boundary.
        event("new_session", session="victim", history_messages=0)
        if scenario.protocol == "indirect_injection":
            external = scenario.attacked_context if attacked else scenario.clean_context
            screened = await screen(external, scenario.query, "external_read")
            contexts = () if screened is None else (screened,)
        else:
            contexts = await retrieve(scenario.query, "victim")
        response = await generate(AgentPrompt(system=scenario.system, query=scenario.query, contexts=contexts), "victim")
        row["judgment"] = await assess(scenario.query, response, scenario.reference_answer, "victim")
        if scenario.utility_query:
            event("new_session", session="utility", history_messages=0)
            contexts = await retrieve(scenario.utility_query, "utility")
            response = await generate(AgentPrompt(system=scenario.system, query=scenario.utility_query, contexts=contexts), "utility")
            row["utility_judgment"] = await assess(scenario.utility_query, response, scenario.utility_reference, "utility")
        row["status"] = "complete"
    except Exception as error:
        row["status"] = "execution_error"
        row["error_type"] = type(error).__name__  # Never serialize provider errors/credentials.
        event("execution_error", error_type=type(error).__name__)
    finally:
        store.clear()
        event("reset", remaining_records=len(store.records), memory_sha256=canonical_hash(store.snapshot()))
    return row


def summarize(scenarios: list[Scenario], rows: list[dict], *, model_quality: bool) -> dict:
    expected = {(s.id, ("attacked" if a else "clean") + ("_guarded" if g else "_unguarded")): s
                for s in scenarios for a, g in ARMS}
    seen, groups = set(), defaultdict(list)
    for row in rows:
        key = (row["scenario_id"], row["arm"])
        if key not in expected or key in seen:
            raise ValueError("Unknown or duplicate scenario arm")
        seen.add(key)
        if row["scenario_sha256"] != canonical_hash(expected[key].model_dump()):
            raise ValueError("Scenario evidence hash mismatch")
        attacked = row["arm"].startswith("attacked_")
        guarded = row["arm"].endswith("_guarded")
        if (row["attacked"] is not attacked or row["guarded"] is not guarded
                or row["protocol"] != expected[key].protocol or row["dataset"] != expected[key].dataset):
            raise ValueError("Arm identity/evidence mismatch")
        if not row["events"] or row["events"][-1].get("stage") != "reset" or row["events"][-1].get("remaining_records") != 0:
            raise ValueError("Missing memory reset evidence")
        groups[f"{expected[key].dataset}/{expected[key].protocol}/{row['arm']}"].append(row)

    def rate(values):
        known = [v for v in values if type(v) is bool]
        return {"true": sum(known), "valid": len(known), "unknown": len(values) - len(known),
                "rate": sum(known) / len(known) if known else None}

    output = {}
    for name, group in groups.items():
        valid = [r for r in group if r["status"] == "complete"]
        attacks = rate([(r["judgment"] or {}).get("attack_success") for r in valid])
        utility = rate([(r["judgment"] or {}).get("task_success") for r in valid])
        probes = rate([(r["utility_judgment"] or {}).get("task_success") for r in valid if r["protocol"] != "indirect_injection"])
        memory_rows = [r for r in valid if r["protocol"] != "indirect_injection" and r["attacked"]]
        retrieved = rate([any(record["poisoned_origin"] for e in r["events"] if e["stage"] == "retrieval"
                              and e["session"] == "victim" for record in e["records"]) for r in memory_rows])
        writes = [sum(e["stage"] == "memory_write" for e in r["events"]) for r in memory_rows]
        output[name] = {"arms": len(group), "complete": len(valid), "execution_errors": len(group) - len(valid),
            "attack_outcome": attacks, "victim_task_utility": utility, "unrelated_task_utility": probes,
            "asr": attacks["rate"] if model_quality and group[0]["attacked"] else None,
            "attack_origin_retrieval": retrieved, "committed_attack_origin_records": sum(writes),
            "write_metric_semantics": "committed_provenance_count_not_semantic_poisoning_success"}
    paired = []
    by_key = {(r["scenario_id"], r["arm"]): r for r in rows}
    for s in scenarios:
        for guarded in (False, True):
            suffix = "guarded" if guarded else "unguarded"
            clean, attacked = (by_key.get((s.id, f"{prefix}_{suffix}")) for prefix in ("clean", "attacked"))
            field = "utility_judgment" if s.protocol != "indirect_injection" else "judgment"
            a, b = ((row.get(field) or {}).get("task_success") if row and row["status"] == "complete" else None for row in (clean, attacked))
            paired.append({"scenario_id": s.id, "guarded": guarded,
                           "utility_delta_attacked_minus_clean": int(b) - int(a) if type(a) is bool and type(b) is bool else None})
    return {"planned_arms": len(expected), "completed_records": len(rows), "missing_arms": len(expected) - len(seen),
            "measurement": "model_output_semantic_judge" if model_quality else "contract_only_no_model_quality_claim",
            "groups": dict(output), "paired_utility": paired,
            "asr_denominator": "completed_and_judged_attacked_arms; errors, missing, unknown reported separately"}

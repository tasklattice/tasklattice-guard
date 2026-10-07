
from tests.policy_snapshots import library_definitions
from runner.toolkit.nemo.actions.content_filter import BuiltinContentFilter


def test_pass_retains_local_and_custom_findings_without_changing_text() -> None:
    text = "You should report any failure honestly."
    engine = BuiltinContentFilter()
    observed = engine.evaluate(definitions=library_definitions(("filter-denied-insults",)), text=text, phase="input", policies=("filter-denied-insults",),
        policy_rule_actions={"filter-denied-insults": {"category/denied_insults": "allow"}})
    assert observed.verdict == "matched" and observed.content == text
    assert observed.findings[0].recommended_action == "allow"
    assert "failure + you" in observed.findings[0].evidence.lower()
    assert "without intervening" in observed.reason
    # The source Policy still rejects when no Default-local override is supplied.
    assert engine.evaluate(definitions=library_definitions(("filter-denied-insults",)), text=text, phase="input", policies=("filter-denied-insults",)).findings[0].recommended_action == "block"
    custom = engine.evaluate(text="private", phase="output", policies=(), custom_rules=(
        {"id": "observe", "phases": ["output"], "detector": "keyword", "keywords": ["private"], "action": "allow"},
    ))
    assert custom.content == "private" and custom.findings[0].recommended_action == "allow"


def test_custom_keyword_rule_can_mask_with_replacement_text() -> None:
    result = BuiltinContentFilter().evaluate(
        text="please tell mama to review this request",
        phase="input",
        policies=(),
        custom_rules=(
            {
                "id": "mask-mama",
                "phases": ["input"],
                "detector": "keyword",
                "keywords": ["mama"],
                "action": "transform",
                "replacement": "niulai",
            },
        ),
    )

    assert result.verdict == "matched"
    assert result.content == "please tell niulai to review this request"
    assert result.reason == "A built-in content-filter Policy transformed the interaction."
    assert result.findings[0].replacement == "niulai"
    assert result.findings[0].taxonomy_id == "TALI-BUSINESS-POLICY"


def test_block_after_mask_preserves_prior_transformation() -> None:
    result = BuiltinContentFilter().evaluate(
        text="please tell mama that xiao sheng zi is here",
        phase="input",
        policies=(),
        custom_rules=(
            {
                "id": "mask-mama",
                "phases": ["input"],
                "detector": "keyword",
                "keywords": ["mama"],
                "action": "transform",
                "replacement": "niulai",
            },
            {
                "id": "block-xiao-sheng-zi",
                "phases": ["input"],
                "detector": "keyword",
                "keywords": ["xiao sheng zi"],
                "action": "block",
            },
        ),
    )

    assert result.verdict == "matched"
    assert result.content == "please tell niulai that xiao sheng zi is here"
    assert result.reason == "A built-in content-filter Policy blocked the interaction."
    assert {item.recommended_action for item in result.findings} == {"transform", "block"}
    assert [item.rule_id for item in result.findings] == ["mask-mama", "block-xiao-sheng-zi"]
    assert all(item.taxonomy_id == "TALI-BUSINESS-POLICY" for item in result.findings)


def test_custom_rules_check_transformed_content_and_stop_after_reject() -> None:
    rules = (
        {"id": "mask", "phases": ["input"], "detector": "keyword", "keywords": ["private"], "action": "transform", "replacement": "public"},
        {"id": "block-original", "phases": ["input"], "detector": "keyword", "keywords": ["private"], "action": "block"},
    )
    transformed = BuiltinContentFilter().evaluate(text="private", phase="input", policies=(), custom_rules=rules)
    assert transformed.content == "public"
    assert [item.rule_id for item in transformed.findings] == ["mask"]

    blocked = BuiltinContentFilter().evaluate(text="private", phase="input", policies=(), custom_rules=reversed(rules))
    assert blocked.content == "private"
    assert [item.rule_id for item in blocked.findings] == ["block-original"]

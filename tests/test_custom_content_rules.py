from runner.toolkit.nemo.actions.content_filter import BuiltinContentFilter


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
                "action": "redact",
                "replacement": "niulai",
            },
        ),
    )

    assert result.verdict == "unsafe"
    assert result.content == "please tell niulai to review this request"
    assert result.reason == "A built-in content-filter Policy transformed the interaction."
    assert result.findings[0].replacement == "niulai"


def test_block_rule_wins_when_mask_and_block_both_match() -> None:
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
                "action": "redact",
                "replacement": "niulai",
            },
            {
                "id": "block-xiao-sheng-zi",
                "phases": ["input"],
                "detector": "keyword",
                "keywords": ["xiao sheng zi"],
                "action": "reject",
            },
        ),
    )

    assert result.verdict == "unsafe"
    assert result.content == "please tell niulai that xiao sheng zi is here"
    assert result.reason == "A built-in content-filter Policy blocked the interaction."
    assert {item.recommended_action for item in result.findings} == {"redact", "reject"}

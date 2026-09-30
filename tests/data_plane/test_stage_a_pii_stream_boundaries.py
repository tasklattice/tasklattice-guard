"""A/ST02: fixed expected PII output across every character cut and Unicode WebSocket frames.

Signed fixtures, actual TCP Runner endpoint and local NeMo actions. No compiler,
model backend or Controller writes. This is transport correctness, not PII recall.
"""

import pytest


RELEASES = ['default-local-v1', *[f'preset-{p}-v1' for p in (
    'common-baseline', 'banking-assistant', 'securities-assistant',
    'internet-customer-support', 'singapore-financial-assistant')]]
CASES = [
    ('passport', '中文 Passport: E12345678', 'E12345678'),
    ('email', '中文 Email: alice@example.com', 'alice@example.com'),
    ('card', '中文 Card: 4111 1111 1111 1111', '4111 1111 1111 1111'),
]


@pytest.mark.parametrize('release', RELEASES)
@pytest.mark.parametrize('kind,text,sensitive', CASES)
async def test_pii_full_buffering_all_character_and_unicode_boundaries(tmp_path, release, kind, text, sensitive):
    expected = {
        'passport': '中文 Passport: [passport_china_REDACTED]' if release == 'default-local-v1' else '中文 [REDACTED]',
        'email': '中文 Email: [email_REDACTED]',
        'card': '中文 Card: [credit_card_REDACTED]',
    }[kind]
    from tests.stream_client import runner, connection, exchange, released
    async with runner(tmp_path, release) as (url, _, registry, telemetry, _):
        variants = [[text], list(text), *[[text[:cut], text[cut:]] for cut in range(1, len(text))]]
        for parts in variants:
            async with connection(url) as (socket, ready):
                assert ready["mode"] == "full_buffered" and ready["effective_release_id"]
                events = await exchange(socket, parts)
                assert released(events) == expected
                assert sensitive not in released(events)
                assert events[-1]["type"] == "completed" and events[-1]["transformed"]
                assert events[-1]["checks"] == 1
                # Every source fragment and confirmed end is consumed before any text is emitted.
                first_delta = next(i for i, e in enumerate(events) if e["type"] == "delta")
                assert all(e["type"] == "ack" for e in events[:first_delta])
                assert first_delta == len(parts) + 1
        assert registry.readiness()["ready"]

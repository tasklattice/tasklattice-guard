"""Contact disclosure rules must not reinterpret parts of source identifiers."""

import pytest

from runner.toolkit.nemo.actions.content_filter import BuiltinContentFilter
from runner.toolkit.policy_library import policy


CONTACT = "local-contact-data"
NETWORK = "local-network-addresses"


def evaluate(text, phase="input", definitions=None, enabled=None):
    definitions = definitions or {CONTACT: policy(CONTACT)}
    return BuiltinContentFilter().evaluate(
        definitions=definitions, policies=tuple(definitions), text=text,
        phase=phase, enabled_rules=enabled,
    )


@pytest.mark.parametrize("phase", ["input", "output"])
@pytest.mark.parametrize("text", [
    "commit dd144c377bc888388099e029a0e1505a66392bb1",
    "sha256: abc23456789def0123456789abcdef0123456789abcdef",
    "build_923456789_suffix",
    "id abc2345-6789xyz",
    "id abc92345-6789xyz",
    "https://example.org/commit/ab23456789cd",
])
def test_contact_rules_preserve_source_identifiers(text, phase):
    result = evaluate(text, phase)
    assert result.verdict == "not_matched"
    assert result.content == text


@pytest.mark.parametrize("phase", ["input", "output"])
@pytest.mark.parametrize("text,expected", [
    ("Phone: (11) 2345-6789", "Phone: [br_phone_landline_REDACTED]"),
    ("Phone: 2345-6789", "Phone: [br_phone_landline_REDACTED]"),
    ("Phone: (11) 92345-6789", "Phone: [br_phone_mobile_REDACTED]"),
    ("Phone: +55 (11) 92345-6789", "Phone: [br_phone_mobile_REDACTED]"),
    ("Email: alex@example.com", "Email: [email_REDACTED]"),
])
def test_contact_rules_still_redact_complete_contacts(text, expected, phase):
    result = evaluate(text, phase)
    assert result.verdict == "matched"
    assert result.content == expected


@pytest.mark.parametrize("phase", ["input", "output"])
def test_pii_profile_excludes_generic_urls_without_exempting_email_or_ip(phase):
    definitions = {CONTACT: policy(CONTACT), NETWORK: policy(NETWORK)}
    enabled = {NETWORK: ("pattern/ipv4", "pattern/ipv6")}
    link = "Read https://example.org/docs"
    assert evaluate(link, phase, definitions, enabled).content == link
    result = evaluate(link + " Email: alex@example.com Host: 192.168.1.10", phase, definitions, enabled)
    assert result.verdict == "matched"
    assert link in result.content
    assert "alex@example.com" not in result.content
    assert "192.168.1.10" not in result.content
    # Broad URL disclosure remains available when explicitly selected.
    assert evaluate(link, phase, definitions).content != link


@pytest.mark.parametrize("phase", ["input", "output"])
def test_pii_profile_keeps_credential_blocking_in_urls(phase):
    definitions = {"local-credentials": policy("local-credentials"), NETWORK: policy(NETWORK)}
    result = evaluate("postgresql://reader:fixture-secret-47@database.example/db", phase,
                      definitions, {NETWORK: ("pattern/ipv4", "pattern/ipv6")})
    assert result.verdict == "matched"
    assert any(f.rule_id == "credential/url-password" and f.recommended_action == "block"
               for f in result.findings)

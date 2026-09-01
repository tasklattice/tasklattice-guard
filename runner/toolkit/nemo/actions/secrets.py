from __future__ import annotations

import re

from ...runtime.contracts import RiskFinding
from ...safety.taxonomy import taxonomy_for_evaluator
from .contracts import ActionRequest, ActionResult, action_result
from .names import ACTION_SECRETS


SECRET_PATTERN = re.compile(
    r"(?:api[-_ ]?key|access[-_ ]?token)\s*[:=]\s*[A-Za-z0-9_\-]{16,}"
    r"|(?:authorization\s*:\s*bearer|bearer)\s+[A-Za-z0-9._~+\-/]+=*"
    r"|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"
    r"|tasklattice-test-block",
    re.IGNORECASE,
)


class SecretsActionProvider:
    """Detect and redact credential-shaped content for the NeMo secrets Action."""

    name = ACTION_SECRETS
    version = "1.0.0"
    capabilities = frozenset({"secrets"})
    rails = frozenset({"input", "output"})

    async def execute(self, request: ActionRequest) -> ActionResult:
        matches = list(SECRET_PATTERN.finditer(request.content))
        if not matches:
            return action_result(
                request,
                "safe",
                request.content,
                reason="No credential pattern matched.",
            )
        return action_result(
            request,
            "unsafe",
            _redact(request.content, matches, "[SECRET_REDACTED]"),
            findings=(
                RiskFinding(
                    risk="secrets",
                    taxonomy_id=taxonomy_for_evaluator("secrets"),
                    verdict="unsafe",
                    confidence=0.99,
                    evidence="High-confidence credential pattern detected.",
                    recommended_action=request.proposed_action,
                    replacement="[SECRET_REDACTED]",
                ),
            ),
            reason="A high-confidence credential pattern was detected.",
        )


def _redact(
    content: str,
    matches: list[re.Match[str]],
    replacement: str,
) -> str:
    output = content
    for match in sorted(matches, key=lambda item: item.start(), reverse=True):
        output = output[: match.start()] + replacement + output[match.end() :]
    return output

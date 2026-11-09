"""TaskLattice policy providers exposed exclusively as NeMo Actions."""
from .content_filter import ContentFilterActionProvider
from .evaluate import EvaluationActionProvider, EvaluationRoute
from .indirect_prompt_injection import IndirectPromptInjectionActionProvider
from .memory_poisoning import MemoryPoisoningActionProvider
from .prompt_leakage import PromptLeakageActionProvider
from .prompt_security import PromptSecurityActionProvider
from .secrets import SecretsActionProvider
from .topic_rules import TopicRulesActionProvider


def local_action_providers(
    prompt_security: PromptSecurityActionProvider | None = None,
) -> tuple[
    ContentFilterActionProvider,
    SecretsActionProvider,
    TopicRulesActionProvider,
    PromptSecurityActionProvider,
    IndirectPromptInjectionActionProvider,
    MemoryPoisoningActionProvider,
    PromptLeakageActionProvider,
]:
    """Return local providers registered directly as versioned NeMo Actions."""
    return (
        ContentFilterActionProvider(),
        SecretsActionProvider(),
        TopicRulesActionProvider(),
        prompt_security or PromptSecurityActionProvider(),
        IndirectPromptInjectionActionProvider(),
        MemoryPoisoningActionProvider(),
        PromptLeakageActionProvider(),
    )


__all__ = [
    "ContentFilterActionProvider",
    "EvaluationActionProvider",
    "EvaluationRoute",
    "IndirectPromptInjectionActionProvider",
    "MemoryPoisoningActionProvider",
    "PromptSecurityActionProvider",
    "PromptLeakageActionProvider",
    "SecretsActionProvider",
    "TopicRulesActionProvider",
    "local_action_providers",
]

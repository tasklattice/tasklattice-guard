"""Keep request data out of Colang's executable log descriptions."""
from copy import deepcopy

from nemoguardrails import RailsConfig


_USER_ACTION_FLOWS = frozenset({
    "user said", "user said something", "user said something unexpected",
})


def configure_user_action_logging(config: RailsConfig) -> None:
    """Use NeMo's structured action metadata for its built-in user flows.

    NeMo 0.24 interpolates transcripts into the core user_action description,
    then parses the result as an expression. Code containing triple quotes can
    therefore fail before a single rail runs. Boolean metadata preserves the
    action event without evaluating a transcript as a log expression. The Flow
    body, transcript, return value and Policy inputs remain unchanged.

    Apply this per instance, including previously published artifacts; never
    patch global NeMo functions or modify signed sources/custom Policy metadata.
    """
    if config.colang_version != "2.x":
        return
    flows = []
    for flow in config.flows:
        if flow.name in _USER_ACTION_FLOWS:
            flow = deepcopy(flow)
            for decorator in flow.decorators:
                if decorator.name == "meta" and isinstance(
                    decorator.parameters.get("user_action"), str
                ):
                    decorator.parameters["user_action"] = True
        flows.append(flow)
    config.flows = flows

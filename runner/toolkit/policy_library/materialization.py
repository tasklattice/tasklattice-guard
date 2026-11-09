from __future__ import annotations

from ..policy_runtime.domain import PolicyTestCaseSpec


def materialize_test_content(
    case: PolicyTestCaseSpec,
    parameters: dict[str, str],
) -> str:
    return materialize_test_text(case.content, case.parameter_names, parameters)


def materialize_test_text(
    value: str,
    parameter_names: tuple[str, ...],
    parameters: dict[str, str],
) -> str:
    """Resolve reviewed Policy parameters in a Rule Test Case template."""

    rendered = value
    for name in parameter_names:
        parameter_value = parameters.get(name, "").strip()
        if "\n" in parameter_value:
            parameter_value = next(
                (
                    item.strip()
                    for item in parameter_value.splitlines()
                    if item.strip()
                ),
                "",
            )
        rendered = rendered.replace(f"{{{{{name}}}}}", parameter_value)
    return rendered.strip()

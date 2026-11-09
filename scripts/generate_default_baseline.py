"""Compile the bundled Default release offline; never calls a model or invents test evidence."""
import argparse
import json
import subprocess
from pathlib import Path

from runner import generated as protocol
from runner.protocol_codec import artifact_content, plan_to_proto
from runner.toolkit.compiler.artifact import ArtifactCompiler
from runner.toolkit.nemo.builtin_policies import prompt_catalog_yaml

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "controller/server/domain/default-baseline.json"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    plan = json.loads(subprocess.check_output(
        ["node", "--import", "tsx", "scripts/default-baseline-plan.ts"], cwd=ROOT / "controller"))
    artifact = ArtifactCompiler(builtin_prompts_yaml=prompt_catalog_yaml()).compile(protocol.CompileRequest(
        guardrail_id=plan["guardrail_id"], guardrail_version=plan["guardrail_version"],
        plan=plan_to_proto(plan), runtime_profile="auto"))
    text = json.dumps(artifact_content(artifact), indent=2, ensure_ascii=False) + "\n"
    if args.check:
        if TARGET.read_text() != text:
            raise SystemExit("Bundled Default is stale. Run python -m scripts.generate_default_baseline.")
    else:
        TARGET.write_text(text)


if __name__ == "__main__":
    main()

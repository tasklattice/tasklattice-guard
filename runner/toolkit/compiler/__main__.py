"""Compile a Protobuf-JSON CompileRequest without starting a Runner."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from google.protobuf.json_format import Parse, MessageToJson

from runner import generated as protocol
from .artifact import ArtifactCompiler
from ..nemo.builtin_policies import prompt_catalog_yaml


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--format", choices=("protobuf", "json"), default="protobuf")
    parser.add_argument("--model-type", action="append", default=[])
    parser.add_argument("--prompts", type=Path, help="Pinned prompt catalog YAML; defaults to bundled templates")
    args = parser.parse_args()
    try:
        request = Parse(args.request.read_text(encoding="utf-8"), protocol.CompileRequest())
        compiler = ArtifactCompiler(
            builtin_prompts_yaml=args.prompts.read_text(encoding="utf-8") if args.prompts else prompt_catalog_yaml(),
            model_types=tuple(args.model_type),
        )
        artifact = compiler.compile(request)
        payload = (MessageToJson(artifact, preserving_proto_field_name=True).encode()
                   if args.format == "json" else artifact.SerializeToString(deterministic=True))
        args.output.write_bytes(payload)
    except Exception as error:
        print(f"Artifact compilation failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

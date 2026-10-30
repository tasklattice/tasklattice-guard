"""Compare handwritten source LOC with a fixed Git revision (including tests).

Uses the Pygments version pinned in uv.lock. Generated sources, dependencies,
data, documents and lockfiles are excluded by the same rules on both sides.
Code LOC excludes blank lines, comment-only lines and Python docstrings;
physical and nonblank line totals are also reported for transparency.
"""

import argparse
import io
import json
from pathlib import Path
import subprocess

import pygments
from pygments.lexers import get_lexer_by_name, get_lexer_for_filename
from pygments.token import Comment, Literal


ROOT = Path(__file__).resolve().parent.parent
BASELINE = "4dc8133852df864d26394edfed402e90b481b697"
EXTENSIONS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
    ".sql", ".proto", ".css", ".scss", ".sh", ".bash", ".tpl", ".html", ".co",
}


def source_file(name):
    path = Path(name)
    if set(path.parts) & {"generated", "node_modules", "dist", "dist-server", ".venv", "vendor"}:
        return False
    if any(marker in path.name for marker in (".generated.", "_generated.", ".gen.", "_pb2", ".pb.go")):
        return False
    return (path.suffix in EXTENSIONS or path.name.startswith("Dockerfile")
            or path.name == "Makefile" or name == "bin/guardctl"
            or (path.suffix in {".yaml", ".yml"}
                and ("templates" in path.parts or name.startswith(".github/workflows/"))))


def count(name, text):
    special = ("yaml" if name.endswith(".tpl") else "bash" if name == "bin/guardctl"
               else "docker" if Path(name).name.startswith("Dockerfile") else None)
    lexer = get_lexer_by_name(special) if special else get_lexer_for_filename(name)
    code_lines, line = set(), 0
    for token, value in pygments.lex(text, lexer):
        ignored = token in Comment or token in Literal.String.Doc
        for part in value.splitlines(keepends=True):
            if not ignored and part.strip():
                code_lines.add(line)
            line += part.count("\n")
    return {"code": len(code_lines), "physical": len(text.splitlines()),
            "nonblank": sum(bool(line.strip()) for line in text.splitlines())}


def git(*args, **kwargs):
    return subprocess.check_output(["git", *args], cwd=ROOT, **kwargs)


def baseline_files(revision):
    entries = []
    for row in git("ls-tree", "-rz", revision).decode().split("\0"):
        if not row:
            continue
        metadata, name = row.split("\t", 1)
        if source_file(name):
            entries.append((name, metadata.split()[2]))
    output = io.BytesIO(git("cat-file", "--batch", input="".join(f"{oid}\n" for _, oid in entries).encode()))
    for name, _ in entries:
        size = int(output.readline().split()[2])
        yield name, output.read(size).decode()
        output.read(1)


def totals(files):
    return {key: sum(row[key] for row in files.values()) for key in ("code", "physical", "nonblank")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", default=BASELINE)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    before = {name: count(name, text) for name, text in baseline_files(args.baseline)}
    names = set(git("ls-files", "-z", "--cached", "--others", "--exclude-standard").decode().split("\0"))
    after = {name: count(name, (ROOT / name).read_text()) for name in sorted(names)
             if name and source_file(name) and (ROOT / name).is_file()}
    old, new = totals(before), totals(after)
    result = {"baseline": args.baseline, "pygments": pygments.__version__,
              "before": old, "after": new,
              "reduction_percent": {key: round(100 * (old[key] - new[key]) / old[key], 3) for key in old},
              "files": {name: {"before": before.get(name), "after": after.get(name)}
                        for name in sorted(before.keys() | after.keys())}}
    if args.output:
        args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({key: value for key, value in result.items() if key != "files"}, indent=2))


if __name__ == "__main__":
    main()

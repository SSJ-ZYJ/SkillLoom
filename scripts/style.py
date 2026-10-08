"""Check repository formatting and lint rules, or apply formatting and safe fixes."""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="Format and apply safe lint fixes")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    node = shutil.which("node")
    biome = root / "node_modules/@biomejs/biome/bin/biome"
    prettier = root / "node_modules/prettier/bin/prettier.cjs"
    if node is None or not biome.is_file() or not prettier.is_file():
        print(
            "ERROR: Install Node.js and Bun, then run bun install --frozen-lockfile in the repository root.",
            file=sys.stderr,
        )
        return 1
    try:
        import ruff  # noqa: F401 -- Require Ruff from the same Python environment.
    except ImportError:
        print("ERROR: Run python -m pip install -r requirements-dev.txt.", file=sys.stderr)
        return 1
    commands = [
        (
            "Biome",
            [
                node,
                str(biome),
                "check",
                "--error-on-warnings",
                *(["--write"] if args.write else []),
                ".",
            ],
        ),
        (
            "Ruff lint",
            [sys.executable, "-m", "ruff", "check", *(["--fix"] if args.write else []), "."],
        ),
        (
            "Ruff format",
            [sys.executable, "-m", "ruff", "format", *([] if args.write else ["--check"]), "."],
        ),
        ("Prettier", [node, str(prettier), "--write" if args.write else "--check", "."]),
    ]
    failed = False
    for label, command in commands:
        print(f"Checking: {label}", flush=True)
        result = subprocess.run(command, cwd=root)
        failed |= result.returncode != 0
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())

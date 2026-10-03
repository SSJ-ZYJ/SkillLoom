"""Run repository checks and all supported test suites from any working directory."""

from pathlib import Path
import shutil
import subprocess
import sys


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    node = shutil.which("node")
    if node is None:
        print("ERROR: Node.js is required for repository checks.", file=sys.stderr)
        return 1
    node_tests = sorted(str(path) for path in (root / "tests").rglob("*.test.mjs"))
    checks = [
        ("Repository validation", [sys.executable, str(root / "scripts/validate_repository.py")]),
        ("Python repository tests", [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"]),
        ("Node repository tests", [node, "--test", *node_tests]),
        ("Node skill tests", [node, str(root / "scripts/test-skills.mjs")]),
        ("Python skill tests", [sys.executable, str(root / "scripts/test_skills.py")]),
    ]
    if not node_tests:
        print("ERROR: Missing Node repository tests.", file=sys.stderr)
        return 1
    for label, command in checks:
        print(f"Checking: {label}", flush=True)
        result = subprocess.run(command, cwd=root)
        if result.returncode:
            print(f"FAILED: {label}", file=sys.stderr)
            return result.returncode if result.returncode > 0 else 1
    print("All offline checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

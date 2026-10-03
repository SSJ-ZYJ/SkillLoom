"""Run each registered skill's standard-library Python tests separately."""

import argparse
from pathlib import Path
import subprocess
import sys
from skill_catalog import load_catalog


RUN_UNITTEST = """import sys, unittest
suite = unittest.defaultTestLoader.discover('tests', pattern='test_*.py')
if not suite.countTestCases():
    print('ERROR: Python test files were found, but no test cases were discovered.', file=sys.stderr)
    sys.exit(1)
sys.exit(0 if unittest.TextTestRunner(verbosity=1).run(suite).wasSuccessful() else 1)
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    root = args.root.resolve()
    try:
        entries = load_catalog(root)
    except ValueError as error:
        print(f"ERROR: {error}")
        return 1
    failed = False
    tested = 0
    for entry in entries:
        skill = root / entry["path"]
        tests = skill / "tests"
        if not tests.is_dir() or not any(tests.rglob("test_*.py")):
            continue
        if any(path.is_symlink() for path in tests.rglob("*")) or tests.is_symlink():
            print(f"ERROR: {entry['path']}: test symlinks are not supported")
            failed = True
            continue
        missing_packages = set()
        for test in tests.rglob("test_*.py"):
            directory = test.parent
            while directory != tests:
                if not (directory / "__init__.py").is_file():
                    missing_packages.add(directory.relative_to(skill).as_posix())
                directory = directory.parent
        if missing_packages:
            print(f"ERROR: {entry['path']}: nested Python test directories need __init__.py: "
                  + ", ".join(sorted(missing_packages)))
            failed = True
            continue
        tested += 1
        print(f"Python tests: {entry['path']}", flush=True)
        result = subprocess.run([sys.executable, "-c", RUN_UNITTEST], cwd=skill)
        failed |= result.returncode != 0
    if not tested:
        print("No Python skill tests; skipped.")
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())

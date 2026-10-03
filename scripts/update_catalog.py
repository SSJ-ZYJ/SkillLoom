"""Refresh the README skill table from skills.json, or check for drift."""

import argparse
from pathlib import Path
from skill_catalog import load_catalog, updated_readme


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    try:
        path = args.root / "README.md"
        original = path.read_text(encoding="utf-8")
        updated = updated_readme(original, load_catalog(args.root))
        if args.check:
            if original != updated:
                print("README catalog is out of date; run python scripts/update_catalog.py")
                return 1
        else:
            path.write_text(updated, encoding="utf-8", newline="\n")
    except (OSError, ValueError) as error:
        print(f"ERROR: {error}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

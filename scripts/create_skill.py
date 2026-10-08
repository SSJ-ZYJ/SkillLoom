"""Create a skill draft, register it, and refresh the README table."""

import argparse
import json
from pathlib import Path

import yaml
from skill_catalog import NAME, RESERVED, load_catalog, updated_readme


def create_skill(root: Path, name: str, description: str, summary: str) -> Path:
    root = root.resolve()
    if not NAME.fullmatch(name) or len(name) > 64 or name in RESERVED:
        raise ValueError("name must be a non-reserved kebab-case name of at most 64 characters")
    if not description.strip() or len(description) > 1024:
        raise ValueError("description must contain 1-1024 characters")
    if not summary.strip() or len(summary) > 200 or "\n" in summary or "\r" in summary:
        raise ValueError("summary must contain 1-200 characters on one line")
    path = f"skills/{name}"
    target = root / path
    if target.exists() or target.is_symlink():
        raise ValueError(f"{name} already exists; existing files will not be overwritten")
    entries = load_catalog(root)
    entries = [*entries, {"path": path, "summary": summary}]
    catalog_path = root / "skills.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    catalog["skills"] = entries
    readme_path = root / "README.md"
    readme = updated_readme(readme_path.read_text(encoding="utf-8"), entries)
    license_bytes = (root / "LICENSE").read_bytes()
    frontmatter = yaml.safe_dump(
        {"name": name, "description": description, "metadata": {"skillloom-status": "draft"}},
        allow_unicode=True,
        sort_keys=False,
    )
    # This is an authoring draft, not a ready-to-use skill. No unused directories.
    content = f"---\n{frontmatter}---\n\n# {name}\n\n待编写：完成内容与验证后，移除 metadata 中的 skillloom-status: draft 标记再安装或发布。\n\n## 使用条件\n\n说明所需输入、宿主能力和适用范围。\n\n## 执行流程\n\n写出具体步骤；只在需要时添加 scripts 或 references。\n\n## 验证结果\n\n说明如何核对输出，以及失败时如何处理。\n"
    target.mkdir()
    (target / "SKILL.md").write_text(content, encoding="utf-8", newline="\n")
    (target / "LICENSE").write_bytes(license_bytes)
    catalog_path.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    readme_path.write_text(readme, encoding="utf-8", newline="\n")
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("name")
    parser.add_argument("--description", required=True, help="Skill trigger and scope")
    parser.add_argument("--summary", required=True, help="Short README description")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    try:
        target = create_skill(args.root, args.name, args.description, args.summary)
    except (OSError, ValueError) as error:
        print(f"ERROR: {error}")
        return 1
    print(f"Created draft: {target.name}. Finish SKILL.md before installing or publishing.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Shared skill inventory and README rendering. No platform-specific rules."""

import json
import re
from pathlib import Path

NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
START = "<!-- skills:start -->"
END = "<!-- skills:end -->"
RESERVED = {
    "scripts",
    "tests",
    "docs",
    "plugins",
    "dist",
    "coverage",
    "node_modules",
    "venv",
    "captures",
    "sessions",
    "traces",
}


def load_catalog(root: Path) -> list[dict[str, str]]:
    root = root.resolve()
    try:
        data = json.loads((root / "skills.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError("skills.json must be readable UTF-8 JSON") from error
    if (
        not isinstance(data, dict)
        or type(data.get("schema_version")) is not int
        or data["schema_version"] != 1
    ):
        raise ValueError("skills.json requires schema_version 1")
    entries = data.get("skills")
    if not isinstance(entries, list) or not entries:
        raise ValueError("skills.json requires a nonempty skills list")
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("each catalog entry must be an object")
        path = entry.get("path")
        if not isinstance(path, str) or not path.startswith("skills/"):
            raise ValueError("skill paths must be skills/<kebab-case-name>")
        name = path.removeprefix("skills/")
        if not NAME.fullmatch(name) or len(name) > 64 or name in RESERVED:
            raise ValueError("skill paths must be skills/<kebab-case-name>")
        if path in seen:
            raise ValueError(f"duplicate catalog entry: {path}")
        seen.add(path)
        summary = entry.get("summary")
        if (
            not isinstance(summary, str)
            or not summary.strip()
            or len(summary) > 200
            or "\n" in summary
            or "\r" in summary
        ):
            raise ValueError(f"{name}: summary must be one line of 1-200 characters")
        directory = root / path
        if (
            (root / "skills").is_symlink()
            or not directory.resolve().is_relative_to(root)
            or directory.is_symlink()
        ):
            raise ValueError(f"{path}: skill directory must remain inside the repository")
        if not (directory / "SKILL.md").is_file():
            raise ValueError(f"{path}: missing SKILL.md")
    misplaced = [
        path.parent.name for path in root.glob("*/SKILL.md") if not path.parent.name.startswith(".")
    ]
    if misplaced:
        raise ValueError("skills must live under skills/: " + ", ".join(sorted(misplaced)))
    discovered = {
        path.parent.relative_to(root).as_posix()
        for path in root.glob("skills/*/SKILL.md")
        if not path.parent.name.startswith(".")
    }
    missing = discovered - seen
    if missing:
        raise ValueError("unregistered skills: " + ", ".join(sorted(missing)))
    return entries


def escape_cell(value: str) -> str:
    # Summaries are plain text; escape Markdown table and link syntax.
    for character in "\\`*_{}[]<>()|":
        value = value.replace(character, "\\" + character)
    return value


def render_table(entries: list[dict[str, str]]) -> str:
    # Keep generated cells stable when the surrounding Markdown is formatted.
    lines = ["<!-- prettier-ignore -->", "| 技能 | 用途 |", "| --- | --- |"]
    for entry in entries:
        path = entry["path"]
        name = path.removeprefix("skills/")
        lines.append(f"| [{name}]({path}/SKILL.md) | {escape_cell(entry['summary'])} |")
    return "\n".join(lines)


def updated_readme(text: str, entries: list[dict[str, str]]) -> str:
    if text.count(START) != 1 or text.count(END) != 1 or text.index(END) < text.index(START):
        raise ValueError("README requires one ordered pair of skills:start/skills:end markers")
    before, rest = text.split(START)
    _, after = rest.split(END)
    return before + START + "\n\n" + render_table(entries) + "\n\n" + END + after

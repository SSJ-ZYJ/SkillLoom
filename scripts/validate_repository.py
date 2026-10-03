"""Offline publication checks; no network or browser/account operations."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlsplit

import yaml
from skill_catalog import load_catalog, updated_readme


SKIP_DIRS = {".git", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache",
             ".agents", ".codex", ".local-docs", "dist", "coverage", "captures", "sessions", "traces"}
TEXT_SUFFIXES = {".md", ".mjs", ".js", ".cjs", ".py", ".yml", ".yaml", ".txt", ".json"}


def validate_skill(path: Path) -> list[str]:
    errors = []
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return ["SKILL.md must be readable UTF-8 text"]
    match = re.match(r"\A---\n(.*?)\n---(?:\n|$)", text, re.S)
    if not match:
        return ["missing or malformed YAML frontmatter"]
    try:
        metadata = yaml.safe_load(match.group(1))
    except yaml.YAMLError:
        return ["invalid YAML frontmatter"]
    if not isinstance(metadata, dict):
        return ["frontmatter must be a mapping"]
    name = metadata.get("name")
    if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) or len(name) > 64:
        errors.append("invalid skill name")
    elif name != path.parent.name:
        errors.append("skill name must match its directory")
    description = metadata.get("description")
    if not isinstance(description, str) or not description.strip() or len(description) > 1024:
        errors.append("description must be a nonempty string of at most 1024 characters")
    if not text[match.end():].strip():
        errors.append("skill instructions must not be empty")
    if "compatibility" in metadata:
        compatibility = metadata["compatibility"]
        if not isinstance(compatibility, str) or not compatibility.strip() or len(compatibility) > 500:
            errors.append("compatibility must be a nonempty string of at most 500 characters")
    if "metadata" in metadata:
        extra = metadata["metadata"]
        if not isinstance(extra, dict):
            errors.append("metadata must be a mapping")
        elif extra.get("skillloom-status") == "draft":
            errors.append("unfinished skill draft; complete instructions and remove the draft marker before publication")
    return errors


def without_fences(text: str) -> str:
    lines = []
    fence = None
    length = 0
    for line in text.splitlines():
        marker = re.match(r"^\s*(`{3,}|~{3,})(.*)$", line)
        if marker:
            if fence is None:
                fence, length = marker[1][0], len(marker[1])
            elif marker[1][0] == fence and len(marker[1]) >= length and not marker[2].strip():
                fence = None
            continue
        if fence is None:
            lines.append(line)
    return "\n".join(lines)


def validate_links(path: Path, root: Path) -> list[str]:
    errors = []
    text = without_fences(path.read_text(encoding="utf-8"))
    for match in re.finditer(r"\]\((<[^>]+>|[^)\s]+)(?:\s+\"[^\"]*\")?\)", text):
        raw = match[1].strip("<>")
        url = urlsplit(raw)
        if url.scheme in {"https", "http", "mailto"}:
            continue
        if url.scheme or raw.startswith("//"):
            errors.append("unsupported link scheme")
            continue
        if not url.path:
            continue
        target = (root / unquote(url.path).lstrip("/")) if url.path.startswith("/") else (path.parent / unquote(url.path))
        resolved = target.resolve()
        if not resolved.is_relative_to(root.resolve()):
            errors.append("local link escapes repository")
        elif ".local-docs" in resolved.relative_to(root.resolve()).parts:
            errors.append("public documents must not link to local maintenance documentation")
        elif not resolved.exists():
            errors.append(f"missing link target: {url.path}")
    return errors


def sensitive_findings(text: str) -> list[str]:
    # Deliberately limited, deterministic checks, not a claim of comprehensive
    # secret detection. Never print matched values into CI logs.
    findings = []
    if re.search(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", text):
        findings.append("private key marker")
    if re.search(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b", text):
        findings.append("GitHub token pattern")
    if re.search(r"\b[A-Za-z]:[\\/](?:Users|SSJ)[\\/]", text):
        findings.append("personal absolute path")
    values = []
    values.extend(match[1] for match in re.finditer(r"[?&]zzud=([A-Za-z0-9._%-]+)", text))
    values.extend(match[1] for match in re.finditer(
        r"['\"](?:Pc-Authorization|Authorization|X-EDU-Signature)['\"]\s*:\s*['\"]([^'\"]+)['\"]", text, re.I))
    if any(not re.fullmatch(r"(?:FAKE|TEST|DEMO)_[A-Za-z0-9_]+", value) for value in values):
        findings.append("literal credential value (use explicit fake fixtures)")
    return findings


def is_local_install(relative: Path) -> bool:
    parts = relative.parts
    return (len(parts) >= 2 and parts[0].startswith(".") and parts[1] == "skills") \
        or parts == ("skills-lock.json",)


def publication_files(root: Path) -> list[Path]:
    using_git = (root / ".git").exists()
    if using_git:
        result = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                                cwd=root, capture_output=True, check=True)
        candidates = [root / value.decode("utf-8") for value in result.stdout.split(b"\0") if value]
    else:
        candidates = root.rglob("*")
    paths = set()
    for path in candidates:
        if not path.is_file() or (not using_git and (SKIP_DIRS.intersection(path.relative_to(root).parts)
                                                   or is_local_install(path.relative_to(root)))):
            continue
        paths.add(path)
    return sorted(paths)


def validate_repository(root: Path) -> list[str]:
    root = root.resolve()
    errors = []
    for required in ["README.md", "LICENSE", "SECURITY.md",
                     "VERSION", "skills.json", "docs/INSTALLATION.md", ".github/workflows/validate.yml"]:
        if not (root / required).is_file():
            errors.append(f"missing publication file: {required}")
    version = root / "VERSION"
    if version.is_file() and not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version.read_text(encoding="utf-8").strip()):
        errors.append("VERSION must contain a semantic version")
    skills = sorted(root.glob("*/SKILL.md"))
    try:
        entries = load_catalog(root)
        readme = (root / "README.md").read_text(encoding="utf-8")
        if readme != updated_readme(readme, entries):
            errors.append("README catalog is out of date; run python scripts/update_catalog.py")
    except (ValueError, OSError) as error:
        errors.append(f"catalog: {error}")
    if not skills:
        errors.append("no skills found")
    for skill in skills:
        errors.extend(f"{skill.relative_to(root)}: {error}" for error in validate_skill(skill))
        license_file = skill.parent / "LICENSE"
        if not license_file.is_file():
            errors.append(f"{skill.parent.name}: missing license for standalone distribution")
        elif (root / "LICENSE").is_file() and license_file.read_bytes() != (root / "LICENSE").read_bytes():
            errors.append(f"{skill.parent.name}: license differs from repository license")
    for path in publication_files(root):
        relative = path.relative_to(root)
        if SKIP_DIRS.intersection(relative.parts) or is_local_install(relative) \
                or path.suffix in {".har", ".pem", ".key", ".bak", ".log"} \
                or (path.name.startswith(".env") and path.name != ".env.example"):
            errors.append(f"{relative}: local/session artifact must not be published")
            continue
        if not path.resolve().is_relative_to(root):
            errors.append(f"{relative}: symlink leaves repository")
            continue
        if path.suffix in TEXT_SUFFIXES or path.name in {"LICENSE", "VERSION"}:
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                errors.append(f"{relative}: text must be UTF-8")
                continue
            errors.extend(f"{relative}: {finding}" for finding in sensitive_findings(text))
        if path.suffix == ".md":
            errors.extend(f"{relative}: {error}" for error in validate_links(path, root))
        if path.suffix == ".json":
            try:
                json.loads(path.read_text(encoding="utf-8"))
            except (ValueError, UnicodeDecodeError):
                errors.append(f"{relative}: invalid UTF-8/JSON")
        if path.suffix in {".yml", ".yaml"}:
            try:
                config = yaml.safe_load(path.read_text(encoding="utf-8"))
            except (yaml.YAMLError, UnicodeDecodeError):
                errors.append(f"{relative}: invalid UTF-8/YAML")
                continue
            if not isinstance(config, dict):
                errors.append(f"{relative}: YAML must be a mapping")
            elif path.parent.name == "workflows":
                triggers = config.get("on", config.get(True, {}))
                if not isinstance(triggers, dict) or not triggers:
                    errors.append(f"{relative}: missing workflow triggers")
                elif {"pull_request_target", "workflow_run"}.intersection(triggers):
                    errors.append(f"{relative}: privileged PR triggers are not allowed in validation workflows")
                if config.get("permissions") != {"contents": "read"}:
                    errors.append(f"{relative}: validation workflows require read-only contents permission")
                if not isinstance(config.get("jobs"), dict) or not config["jobs"]:
                    errors.append(f"{relative}: missing workflow jobs")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    errors = validate_repository(args.root)
    for error in errors:
        print(f"ERROR: {error}")
    if not errors:
        print("Repository validation passed (offline checks only).")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())

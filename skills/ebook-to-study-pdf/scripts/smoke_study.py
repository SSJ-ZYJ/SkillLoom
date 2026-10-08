"""Build the bundled synthetic example in both modes in a fresh output directory."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from build_study import build
from pdf_workflow import page_digest, render_pdf, sha256, split_pdf


def smoke(out: Path, timeout: int = 300) -> dict:
    import pymupdf

    out = out.resolve()
    if out.exists():
        raise ValueError("Smoke output already exists; choose a fresh directory")
    skill = Path(__file__).resolve().parent.parent
    shutil.copytree(skill / "assets/smoke", out)
    shutil.copytree(skill / "assets/latex", out / "latex")
    main = out / "latex/main.tex"
    main.write_text(
        main.read_text(encoding="utf-8").replace("{课程名称}", "{排版冒烟样例}"), encoding="utf-8"
    )
    (out / "source").mkdir()
    with pymupdf.open() as doc:
        for number in (1, 2):
            doc.new_page().insert_text((72, 72), f"Synthetic source page {number}")
        doc.set_toc([[1, "Oscillation", 1], [1, "Link delay", 2]])
        doc.save(out / "source/book.pdf")
    manifest = out / "manifest.json"
    splits = split_pdf(manifest, out / "chapters")
    if not splits["ok"]:
        raise RuntimeError("Synthetic PDF split verification failed")
    markdown = build(manifest, timeout)
    chapters = {path: sha256(path) for path in (out / "latex/chapters").glob("*.tex")}
    data = json.loads(manifest.read_text(encoding="utf-8"))
    data.update(mode="tex", output="study-tex.pdf")
    tex_manifest = out / "manifest-tex.json"
    tex_manifest.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tex = build(tex_manifest, timeout)
    if any(sha256(path) != digest for path, digest in chapters.items()):
        raise RuntimeError("TeX mode changed chapter sources")
    with pymupdf.open(markdown["output"]) as first, pymupdf.open(tex["output"]) as second:
        if len(first) != len(second) or any(
            page_digest(a, 150) != page_digest(b, 150) for a, b in zip(first, second)
        ):
            raise RuntimeError("Markdown and TeX renderings differ")
        toc = first.get_toc()
        if sum(level == 1 for level, _, _ in toc) != 2:
            raise RuntimeError("Expected two chapter bookmarks")
        links = [link for page in first for link in page.get_links()]
        if not links or any(not 0 <= link.get("page", -1) < len(first) for link in links):
            raise RuntimeError("An internal link has no valid destination")
        link_count = len(links)
    rendering = render_pdf(Path(markdown["output"]), out / "review", "all", 150)
    report = {
        "markdown": markdown,
        "tex": tex,
        "splits": splits,
        "internal_links": link_count,
        "chapter_sources_unchanged": True,
        "all_page_renderings_equal": True,
        "rendering": rendering,
        "status": "STRUCTURAL CHECKS PASSED; visual review still required",
    }
    (out / "smoke-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="Fresh project directory; existing directories are refused",
    )
    parser.add_argument("--timeout", type=int, default=300, help="Seconds per build command")
    args = parser.parse_args()
    try:
        report = smoke(args.out, args.timeout)
        print(
            json.dumps(
                {
                    "output": str(args.out.resolve()),
                    "pages": report["markdown"]["pages"],
                    "internal_links": report["internal_links"],
                    "status": report["status"],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    except (OSError, ValueError, RuntimeError, ImportError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())

"""Inspect, split, verify and render PDFs without treating OCR text as ground truth."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256") if hasattr(hashlib, "file_digest") else None
        if digest is not None:
            return digest.hexdigest()
        result = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
        return result.hexdigest()


def project_path(root: Path, value: str) -> Path:
    if not isinstance(value, str) or not value or Path(value).is_absolute():
        raise ValueError("Project output/content paths must be nonempty relative paths")
    path = (root / value).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("Project path escapes its root")
    return path


def load_manifest(path: Path) -> tuple[Path, dict]:
    path = path.resolve()
    data = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(data, dict)
        or not isinstance(data.get("chapters"), list)
        or not data["chapters"]
    ):
        raise ValueError("Manifest needs a nonempty chapters array")
    seen = set()
    previous_end = 0
    for chapter in data["chapters"]:
        if not isinstance(chapter, dict):
            raise ValueError("Chapter must be an object")
        identifier = chapter.get("id")
        if (
            not isinstance(identifier, str)
            or not re.fullmatch(r"ch[0-9]{2,}", identifier)
            or identifier in seen
        ):
            raise ValueError("Chapter IDs must be unique chNN identifiers")
        seen.add(identifier)
        if not isinstance(chapter.get("title"), str) or not chapter["title"].strip():
            raise ValueError("Chapter needs a title")
        start, end = chapter.get("start"), chapter.get("end")
        if (
            type(start) is not int
            or type(end) is not int
            or not 1 <= start <= end
            or start <= previous_end
        ):
            raise ValueError(
                "Chapter ranges must be ordered, nonoverlapping, 1-based inclusive integers"
            )
        previous_end = end
    if not isinstance(data.get("source"), str) or not data["source"]:
        raise ValueError("Manifest needs source PDF path")
    return path.parent, data


def image_coverage(rectangles, page_rect) -> float:
    """Exact rectangular union, not the sum of overlapping image areas."""
    rects = []
    for rect in rectangles:
        x0, y0 = max(rect[0], page_rect[0]), max(rect[1], page_rect[1])
        x1, y1 = min(rect[2], page_rect[2]), min(rect[3], page_rect[3])
        if x1 > x0 and y1 > y0:
            rects.append((x0, y0, x1, y1))
    edges = sorted({x for r in rects for x in (r[0], r[2])})
    area = 0.0
    for left, right in zip(edges, edges[1:]):
        intervals = sorted((r[1], r[3]) for r in rects if r[0] < right and r[2] > left)
        covered = 0.0
        end = float("-inf")
        for low, high in intervals:
            covered += max(0.0, high - max(low, end))
            end = max(end, high)
        area += (right - left) * covered
    page_area = (page_rect[2] - page_rect[0]) * (page_rect[3] - page_rect[1])
    return area / page_area if page_area else 0.0


def inspect_pdf(source: Path) -> dict:
    import pymupdf

    records = []
    with pymupdf.open(source) as doc:
        if doc.needs_pass:
            raise ValueError("Encrypted PDF needs an authorized unlocked copy")
        for index, page in enumerate(doc):
            text = page.get_text("text", sort=True)
            traces = page.get_texttrace()
            hidden = any(span.get("type") == 3 for span in traces)
            # Image coordinates are unrotated; use the matching unrotated page box.
            unrotated = page.rect * page.derotation_matrix
            coverage = image_coverage([x["bbox"] for x in page.get_image_info()], unrotated)
            chars = len("".join(text.split()))
            if hidden:
                hint = "ocr-or-hidden-text-candidate"
            elif coverage >= 0.65:
                hint = "scan-with-text-candidate" if chars else "image-scan-candidate"
            elif chars:
                hint = "native-or-converted-text-candidate"
            else:
                hint = "blank-vector-or-unextractable-candidate"
            records.append(
                {
                    "pdf_page": index + 1,
                    "page_label": page.get_label(),
                    "text_chars": chars,
                    "image_area_ratio": round(coverage, 4),
                    "hidden_text": hidden,
                    "hint": hint,
                    "text_preview": text[:600],
                    "size_pt": [round(page.rect.width, 2), round(page.rect.height, 2)],
                }
            )
        return {
            "source_sha256": sha256(source),
            "pages": len(doc),
            "metadata": doc.metadata,
            "bookmarks": doc.get_toc(),
            "page_diagnostics": records,
            "trust": "UNVERIFIED: structural hints cannot establish origin, accuracy or completeness",
        }


def chapter_toc(doc, start: int, end: int) -> list:
    entries = []
    previous = 0
    for level, title, page in doc.get_toc():
        if start <= page <= end:
            # A chapter may start inside a deeply nested global outline.
            level = min(level, previous + 1)
            entries.append([level, title, page - start + 1])
            previous = level
    return entries


def page_digest(page, dpi: int = 60) -> str:
    import pymupdf

    pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csRGB, alpha=False, annots=True)
    digest = hashlib.sha256(f"{pix.width}:{pix.height}:".encode())
    digest.update(pix.samples)
    return digest.hexdigest()


def split_pdf(manifest: Path, outdir: Path) -> dict:
    import pymupdf

    root, data = load_manifest(manifest)
    source = (root / data["source"]).resolve()
    targets = [outdir / f"{ch['id']}.pdf" for ch in data["chapters"]]
    if any(path.exists() for path in targets):
        raise ValueError("Split target exists; use a fresh directory rather than overwrite")
    with pymupdf.open(source) as doc:
        if doc.needs_pass:
            raise ValueError("Encrypted PDF needs an authorized unlocked copy")
        if data["chapters"][-1]["end"] > len(doc):
            raise ValueError("Chapter end exceeds source PDF page count")
        outdir.mkdir(parents=True, exist_ok=True)
        for ch, target in zip(data["chapters"], targets):
            with pymupdf.open() as part:
                part.insert_pdf(doc, from_page=ch["start"] - 1, to_page=ch["end"] - 1)
                part.set_metadata(
                    {
                        "title": ch["title"],
                        "subject": f"Source PDF pages {ch['start']}-{ch['end']} (1-based)",
                        "creator": "ebook-to-study-pdf",
                    }
                )
                toc = chapter_toc(doc, ch["start"], ch["end"])
                if toc:
                    part.set_toc(toc)
                part.save(target, garbage=3, deflate=True)
    return verify_splits(manifest, outdir)


def verify_splits(manifest: Path, outdir: Path) -> dict:
    import pymupdf

    root, data = load_manifest(manifest)
    source = (root / data["source"]).resolve()
    failures, results = [], []
    with pymupdf.open(source) as doc:
        if doc.needs_pass:
            raise ValueError("Encrypted PDF needs an authorized unlocked copy")
        if data["chapters"][-1]["end"] > len(doc):
            raise ValueError("Chapter end exceeds source PDF page count")
        for ch in data["chapters"]:
            target = outdir / f"{ch['id']}.pdf"
            issues = []
            if not target.is_file():
                issues.append("missing split")
            else:
                with pymupdf.open(target) as part:
                    expected = ch["end"] - ch["start"] + 1
                    if len(part) != expected:
                        issues.append(f"page count {len(part)} != {expected}")
                    for offset in range(min(len(part), expected)):
                        if page_digest(part[offset]) != page_digest(doc[ch["start"] - 1 + offset]):
                            issues.append(f"render mismatch at split page {offset + 1}")
                    if part.get_toc() != chapter_toc(doc, ch["start"], ch["end"]):
                        issues.append("chapter bookmarks differ")
            results.append(
                {"id": ch["id"], "source_pages": [ch["start"], ch["end"]], "issues": issues}
            )
            failures.extend(f"{ch['id']}: {issue}" for issue in issues)
    return {
        "ok": not failures,
        "source_sha256": sha256(source),
        "chapters": results,
        "failures": failures,
        "scope": "All split-page render hashes and bookmarks; NOT source completeness",
    }


def parse_pages(value: str, count: int) -> list[int]:
    if value == "all":
        return list(range(1, count + 1))
    pages = set()
    for group in value.split(","):
        match = re.fullmatch(r"([0-9]+)(?:-([0-9]+))?", group.strip())
        if not match:
            raise ValueError("Pages must be all or 1-based ranges such as 1,3-5")
        start, end = int(match[1]), int(match[2] or match[1])
        if not 1 <= start <= end <= count:
            raise ValueError("Page selection outside PDF or reversed")
        pages.update(range(start, end + 1))
    return sorted(pages)


def render_pdf(source: Path, outdir: Path, selection: str, dpi: int) -> dict:
    import pymupdf

    if not 30 <= dpi <= 600:
        raise ValueError("DPI must be in 30..600")
    with pymupdf.open(source) as doc:
        if doc.needs_pass:
            raise ValueError("Encrypted PDF needs an authorized unlocked copy")
        pages = parse_pages(selection, len(doc))
        outdir.mkdir(parents=True, exist_ok=True)
        images = []
        contacts = []
        sheet = None
        for position, number in enumerate(pages):
            path = outdir / f"page-{number:04}.png"
            pix = doc[number - 1].get_pixmap(dpi=dpi, colorspace=pymupdf.csRGB, alpha=False)
            pix.save(path)
            images.append(path.name)
            if position % 12 == 0:
                sheet = pymupdf.open()
                canvas = sheet.new_page(width=900, height=1320)
            slot = position % 12
            x, y = (slot % 3) * 300, (slot // 3) * 330
            canvas.insert_text((x + 10, y + 17), f"PDF page {number}", fontsize=11)
            canvas.insert_image(
                pymupdf.Rect(x + 10, y + 24, x + 290, y + 320),
                filename=str(path),
                keep_proportion=True,
            )
            if slot == 11 or position == len(pages) - 1:
                contact = outdir / f"contact-{position // 12 + 1:03}.png"
                canvas.get_pixmap().save(contact)
                contacts.append(contact.name)
                sheet.close()
        return {
            "source_sha256": sha256(source),
            "pdf_pages": len(doc),
            "rendered_pages": pages,
            "dpi": dpi,
            "images": images,
            "contact_sheets": contacts,
            "status": "RENDERED, not visually reviewed",
        }


def validate_report_path(report: Path, protected: list[Path]) -> None:
    """Reject aliases as well as planned split targets before any output is made."""
    resolved = report.resolve()
    for path in protected:
        if resolved == path.resolve() or (
            report.exists() and path.exists() and report.samefile(path)
        ):
            raise ValueError("Report path must not overwrite source PDF, manifest or split PDF")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    inspect = sub.add_parser("inspect")
    inspect.add_argument("source", type=Path)
    inspect.add_argument("--report", type=Path)
    for name in ("split", "verify"):
        command = sub.add_parser(name)
        command.add_argument("manifest", type=Path)
        command.add_argument("--out", type=Path, required=True)
        command.add_argument("--report", type=Path)
    render = sub.add_parser("render")
    render.add_argument("source", type=Path)
    render.add_argument("--out", type=Path, required=True)
    render.add_argument("--pages", default="all")
    render.add_argument("--dpi", type=int, default=150)
    render.add_argument("--report", type=Path)
    args = parser.parse_args()
    try:
        if args.report:
            if args.command in {"split", "verify"}:
                root, data = load_manifest(args.manifest)
                protected = [args.manifest, root / data["source"]]
                protected.extend(args.out / f"{ch['id']}.pdf" for ch in data["chapters"])
            else:
                protected = [args.source]
            validate_report_path(args.report, protected)
        if args.command == "inspect":
            report = inspect_pdf(args.source)
        elif args.command == "split":
            report = split_pdf(args.manifest, args.out)
        elif args.command == "verify":
            report = verify_splits(args.manifest, args.out)
        else:
            report = render_pdf(args.source, args.out, args.pages, args.dpi)
        encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        if args.report:
            validate_report_path(args.report, protected)
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(encoded, encoding="utf-8")
        print(encoded, end="")
        return 0 if report.get("ok", True) else 1
    except (OSError, ValueError, RuntimeError, ImportError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())

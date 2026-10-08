"""Behavioral boundaries: OCR ambiguity, inclusive splits, all-page integrity and safety."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from pdf_workflow import image_coverage, load_manifest, parse_pages, project_path

try:
    import pymupdf
except ImportError:
    pymupdf = None


class ManifestContract(unittest.TestCase):
    def test_rejects_overlap_reversed_zero_and_boolean_page_numbers(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            for ranges in [((1, 3), (3, 4)), ((3, 1),), ((0, 1),), ((True, 3),)]:
                with self.subTest(ranges=ranges):
                    path.write_text(
                        json.dumps(
                            {
                                "source": "book.pdf",
                                "chapters": [
                                    {
                                        "id": f"ch{i:02}",
                                        "title": "Chapter",
                                        "start": start,
                                        "end": end,
                                    }
                                    for i, (start, end) in enumerate(ranges, 1)
                                ],
                            }
                        ),
                        encoding="utf-8",
                    )
                    with self.assertRaises(ValueError):
                        load_manifest(path)

    def test_page_selection_is_one_based_inclusive_and_rejects_outside_pdf(self):
        self.assertEqual(parse_pages("1,3-5,4", 5), [1, 3, 4, 5])
        for selection in ("0", "6", "4-2", "1-6"):
            with self.subTest(selection=selection), self.assertRaises(ValueError):
                parse_pages(selection, 5)

    def test_content_paths_cannot_escape_project(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for value in ("../outside.tex", str(root / "absolute.tex")):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    project_path(root, value)

    def test_overlapping_images_do_not_inflate_scan_coverage(self):
        self.assertAlmostEqual(
            image_coverage([(0, 0, 60, 100), (40, 0, 80, 100)], (0, 0, 100, 100)), 0.8
        )
        self.assertAlmostEqual(image_coverage([(-50, -50, 200, 200)], (0, 0, 100, 100)), 1.0)


@unittest.skipUnless(pymupdf, "PyMuPDF needed for real PDF integration")
class RealPDFWorkflow(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "book.pdf"
        with pymupdf.open() as doc:
            for label in ("Front", "Alpha", "Beta", "Gamma", "Next"):
                page = doc.new_page()
                page.insert_text((72, 72), label, fontsize=22)
            doc.set_toc(
                [[1, "Front", 1], [1, "Chapter A", 2], [2, "Section", 3], [1, "Chapter B", 5]]
            )
            doc.save(self.source)
        self.manifest = self.root / "manifest.json"
        self.manifest.write_text(
            json.dumps(
                {
                    "source": "book.pdf",
                    "chapters": [
                        {"id": "ch01", "title": "Chapter A", "start": 2, "end": 4},
                        {"id": "ch02", "title": "Chapter B", "start": 5, "end": 5},
                    ],
                }
            ),
            encoding="utf-8",
        )

    def cli(self, *arguments):
        script = Path(__file__).resolve().parents[1] / "scripts/pdf_workflow.py"
        return subprocess.run(
            [sys.executable, str(script), *map(str, arguments)],
            cwd=self.root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=15,
        )

    def test_report_conflicts_are_rejected_before_work_and_existing_files_stay_unchanged(self):
        from pdf_workflow import split_pdf

        source_before, manifest_before = self.source.read_bytes(), self.manifest.read_bytes()
        cases = [("inspect", "source", False), ("render", "source", False)]
        cases += [
            (command, target, False)
            for command in ("split", "verify")
            for target in ("source", "manifest", "split")
        ]
        cases.append(("verify", "split", True))
        for number, (command, target, existing_split) in enumerate(cases):
            self.source.write_bytes(source_before)
            self.manifest.write_bytes(manifest_before)
            out = self.root / f"outputs-{number}"
            if existing_split:
                split_pdf(self.manifest, out)
            arguments = [command, self.manifest if command in {"split", "verify"} else self.source]
            if command != "inspect":
                arguments.extend(["--out", out])
            report = {"source": self.source, "manifest": self.manifest, "split": out / "ch01.pdf"}[
                target
            ]
            split_before = {path: path.read_bytes() for path in out.glob("*.pdf")}
            with self.subTest(command=command, target=target, existing_split=existing_split):
                result = self.cli(*arguments, "--report", report)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn("Report path", result.stderr)
                self.assertEqual(self.source.read_bytes(), source_before)
                self.assertEqual(self.manifest.read_bytes(), manifest_before)
                if existing_split:
                    self.assertEqual(
                        {path: path.read_bytes() for path in out.glob("*.pdf")}, split_before
                    )
                else:
                    self.assertFalse(out.exists(), "Preflight rejection must not create outputs")

    def test_report_aliases_cannot_replace_source(self):
        alias = self.root / "alias.json"
        try:
            os.link(self.source, alias)
        except OSError as error:
            self.skipTest(f"Hard links unavailable: {error}")
        before = self.source.read_bytes()
        for report in (self.root / "unused/../book.pdf", alias):
            self.source.write_bytes(before)
            with self.subTest(report=report):
                result = self.cli("inspect", self.source, "--report", report)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Report path", result.stderr)
                self.assertEqual(self.source.read_bytes(), before)

    def test_separate_report_is_written_and_source_remains_unchanged(self):
        before = self.source.read_bytes()
        report = self.root / "reports/inspect.json"
        result = self.cli("inspect", self.source, "--report", report)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(report.read_text(encoding="utf-8"))["pages"], 5)
        self.assertEqual(self.source.read_bytes(), before)

    def test_split_preserves_inclusive_boundaries_and_local_bookmarks(self):
        from pdf_workflow import split_pdf

        result = split_pdf(self.manifest, self.root / "chapters")
        self.assertTrue(result["ok"], result)
        with pymupdf.open(self.root / "chapters/ch01.pdf") as doc:
            self.assertEqual([page.get_text().strip() for page in doc], ["Alpha", "Beta", "Gamma"])
            self.assertEqual(doc.get_toc(), [[1, "Chapter A", 1], [2, "Section", 2]])
        with pymupdf.open(self.root / "chapters/ch02.pdf") as doc:
            self.assertEqual(doc[0].get_text().strip(), "Next")
            self.assertEqual(doc.get_toc(), [[1, "Chapter B", 1]])

    def test_verifier_detects_corrupted_middle_page_not_just_endpoints(self):
        from pdf_workflow import split_pdf, verify_splits

        out = self.root / "chapters"
        split_pdf(self.manifest, out)
        target = out / "ch01.pdf"
        with pymupdf.open(target) as doc:
            doc[1].insert_text((72, 180), "CORRUPTED", fontsize=24)
            doc.save(self.root / "changed.pdf")
        (self.root / "changed.pdf").replace(target)
        result = verify_splits(self.manifest, out)
        self.assertFalse(result["ok"])
        self.assertIn("ch01: render mismatch at split page 2", result["failures"])

    def test_split_collision_leaves_existing_file_untouched(self):
        from pdf_workflow import split_pdf

        out = self.root / "chapters"
        split_pdf(self.manifest, out)
        before = (out / "ch01.pdf").read_bytes()
        with self.assertRaises(ValueError):
            split_pdf(self.manifest, out)
        self.assertEqual((out / "ch01.pdf").read_bytes(), before)

    def test_scan_with_invisible_ocr_is_not_treated_as_trusted_native_text(self):
        from pdf_workflow import inspect_pdf

        with pymupdf.open() as raster:
            page = raster.new_page(width=300, height=400)
            page.insert_text((25, 60), "Scanned original", fontsize=20)
            image = page.get_pixmap().tobytes("png")
        path = self.root / "kinds.pdf"
        with pymupdf.open() as doc:
            native = doc.new_page(width=300, height=400)
            native.insert_text((25, 60), "Visible vector text", fontsize=20)
            scan = doc.new_page(width=300, height=400)
            scan.insert_image(scan.rect, stream=image)
            ocr = doc.new_page(width=300, height=400)
            ocr.insert_image(ocr.rect, stream=image)
            ocr.insert_text((25, 60), "Incorrect OCR text", fontsize=20, render_mode=3)
            doc.save(path)
        result = inspect_pdf(path)
        pages = result["page_diagnostics"]
        self.assertEqual(pages[0]["hint"], "native-or-converted-text-candidate")
        self.assertEqual(pages[1]["hint"], "image-scan-candidate")
        self.assertEqual(pages[2]["hint"], "ocr-or-hidden-text-candidate")
        self.assertTrue(pages[2]["hidden_text"])
        self.assertIn("UNVERIFIED", result["trust"])


if __name__ == "__main__":
    unittest.main()

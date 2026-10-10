"""Delivery guarantees with controlled tool outputs; no TeX installation required."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import build_study

try:
    import pymupdf
except ImportError:
    pymupdf = None


@unittest.skipUnless(pymupdf, "PyMuPDF needed for build delivery checks")
class BuildDelivery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "latex/chapters").mkdir(parents=True)
        (self.root / "notes").mkdir()
        (self.root / "latex/main.tex").write_text("Template fixture", encoding="utf-8")
        (self.root / "latex/learning-blocks.lua").write_text("Filter fixture", encoding="utf-8")
        self.chapter = self.root / "latex/chapters/ch01.tex"
        self.chapter.write_text("User TeX source", encoding="utf-8")
        (self.root / "notes/ch01.md").write_text("# Markdown source", encoding="utf-8")
        self.output = self.root / "study.pdf"
        self.old_pdf = b"Existing delivery must survive failed builds"
        self.output.write_bytes(self.old_pdf)
        self.manifest = self.root / "manifest.json"
        self.data = {
            "source": "book.pdf",
            "mode": "markdown",
            "output": "study.pdf",
            "chapters": [
                {
                    "id": "ch01",
                    "title": "Chapter",
                    "start": 1,
                    "end": 1,
                    "note": "notes/ch01.md",
                    "tex": "latex/chapters/ch01.tex",
                }
            ],
        }
        self.save_manifest()
        self.commands = []
        self.failure = None
        self.warning = ""
        self.produce_pdf = True
        self.embedded = True
        self.a4 = True
        for patcher in (
            patch("build_study.shutil.which", side_effect=lambda name: name),
            patch("build_study.run_tool", side_effect=self.tool),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def save_manifest(self):
        self.manifest.write_text(json.dumps(self.data), encoding="utf-8")

    def tool(self, arguments, root, log, timeout):
        self.assertEqual(root, self.root.resolve())
        self.commands.append(arguments)
        log.write_text("Controlled tool log", encoding="utf-8")
        if arguments[0] == self.failure:
            raise RuntimeError(f"{self.failure} failed; inspect {log}")
        if arguments[0] == "pandoc":
            target = next(
                arg.removeprefix("--output=") for arg in arguments if arg.startswith("--output=")
            )
            Path(target).write_text("Generated chapter", encoding="utf-8")
        else:
            (log.parent / "study.log").write_text(self.warning, encoding="utf-8")
            if self.produce_pdf:
                with pymupdf.open() as doc:
                    page = doc.new_page(width=595.3 if self.a4 else 400, height=841.9)
                    if self.embedded:
                        page.insert_font(fontname="review", fontbuffer=pymupdf.Font("cjk").buffer)
                        page.insert_text((72, 72), "Fresh delivery", fontname="review")
                    else:
                        page.insert_text((72, 72), "Unembedded base font")
                    doc.save(log.parent / "study.pdf")

    def test_tool_failures_preserve_old_pdf_and_diagnostic_logs(self):
        for tool in ("pandoc", "latexmk"):
            with self.subTest(tool=tool):
                self.failure = tool
                with self.assertRaisesRegex(RuntimeError, f"{tool} failed"):
                    build_study.build(self.manifest)
                self.assertEqual(self.output.read_bytes(), self.old_pdf)
                self.assertTrue(any((self.root / "tmp/pdfs").glob(f"build-*/{tool}*.log")))

    def test_tex_mode_preserves_chapter_and_does_not_run_pandoc(self):
        self.data["mode"] = "tex"
        del self.data["chapters"][0]["note"]
        self.save_manifest()
        before = self.chapter.read_bytes()
        result = build_study.build(self.manifest)
        self.assertEqual(self.chapter.read_bytes(), before)
        self.assertEqual([args[0] for args in self.commands], ["latexmk"])
        self.assertEqual(result["mode"], "tex")
        self.assertNotEqual(self.output.read_bytes(), self.old_pdf)
        self.assertTrue(all(font["embedded"] for font in result["fonts"]))

    def test_quality_warnings_block_delivery(self):
        for warning in (
            "Missing character: There is no X",
            "Overfull \\hbox (2pt too wide)",
            "LaTeX Warning: Reference `missing' undefined",
            "destination with the same identifier",
        ):
            with self.subTest(warning=warning):
                self.warning = warning
                with self.assertRaisesRegex(RuntimeError, "quality blockers"):
                    build_study.build(self.manifest)
                self.assertEqual(self.output.read_bytes(), self.old_pdf)

    def test_missing_fresh_pdf_does_not_deliver_old_pdf(self):
        self.produce_pdf = False
        with self.assertRaisesRegex(RuntimeError, "No newly built PDF"):
            build_study.build(self.manifest)
        self.assertEqual(self.output.read_bytes(), self.old_pdf)

    def test_non_a4_and_unembedded_fonts_block_delivery(self):
        for a4, embedded, message in ((False, True, "A4"), (True, False, "Unembedded fonts")):
            with self.subTest(a4=a4, embedded=embedded):
                self.a4, self.embedded = a4, embedded
                with self.assertRaisesRegex(RuntimeError, message):
                    build_study.build(self.manifest)
                self.assertEqual(self.output.read_bytes(), self.old_pdf)

    def test_markdown_build_replaces_pdf_only_after_validation(self):
        result = build_study.build(self.manifest)
        self.assertEqual(self.chapter.read_text(encoding="utf-8"), "Generated chapter")
        self.assertEqual([args[0] for args in self.commands], ["pandoc", "latexmk"])
        self.assertTrue(
            (self.root / "latex/chapters.tex").read_text().startswith(build_study.INDEX_MARKER)
        )
        self.assertEqual(result["pages"], 1)
        self.assertNotEqual(self.output.read_bytes(), self.old_pdf)

    def test_noncanonical_manifest_path_builds_in_project_directory(self):
        self.root = self.root / ".." / self.root.name
        result = build_study.build(self.root / "manifest.json")
        self.assertEqual(result["pages"], 1)
        self.assertNotEqual(self.output.read_bytes(), self.old_pdf)


class ToolFailures(unittest.TestCase):
    def test_nonzero_command_preserves_log_and_reports_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = root / "tool.log"
            with self.assertRaisesRegex(RuntimeError, "exited 7"):
                build_study.run_tool(
                    [sys.executable, "-c", "print('diagnostic'); raise SystemExit(7)"], root, log, 5
                )
            self.assertIn("diagnostic", log.read_text())

    def test_timeout_preserves_log_and_reports_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = root / "tool.log"
            with self.assertRaisesRegex(RuntimeError, "timed out"):
                build_study.run_tool(
                    [
                        sys.executable,
                        "-c",
                        "import time; print('started', flush=True); time.sleep(30)",
                    ],
                    root,
                    log,
                    1,
                )
            self.assertIn("started", log.read_text())


if __name__ == "__main__":
    unittest.main()

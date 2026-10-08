import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from create_skill import create_skill
from skill_catalog import load_catalog, updated_readme
from validate_repository import validate_skill


class SkillCatalogTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "LICENSE").write_text("Fixture license\n", encoding="utf-8")
        self.add_skill("first")
        self.entries = [{"path": "skills/first", "summary": "First fixture"}]
        self.save_catalog()
        (self.root / "README.md").write_text(
            updated_readme(
                "Before\n<!-- skills:start -->\n<!-- skills:end -->\nAfter\n", self.entries
            ),
            encoding="utf-8",
        )

    def add_skill(self, name):
        directory = self.root / "skills" / name
        directory.mkdir(parents=True)
        (directory / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: Fixture\n---\n", encoding="utf-8"
        )
        return directory

    def save_catalog(self):
        (self.root / "skills.json").write_text(
            json.dumps({"schema_version": 1, "skills": self.entries}), encoding="utf-8"
        )

    def run_python_tests(self):
        return subprocess.run(
            [sys.executable, str(SCRIPTS / "test_skills.py"), "--root", str(self.root)],
            capture_output=True,
            text=True,
        )

    def test_second_skill_is_registered_and_documented_without_touching_first(self):
        original = (self.root / "skills/first/SKILL.md").read_bytes()
        created = create_skill(self.root, "second", "Use for fixture tasks.", "Second fixture")
        self.assertEqual(
            [entry["path"] for entry in load_catalog(self.root)], ["skills/first", "skills/second"]
        )
        self.assertEqual(created, self.root / "skills/second")
        self.assertFalse((self.root / "second").exists())
        self.assertEqual((created / "LICENSE").read_bytes(), (self.root / "LICENSE").read_bytes())
        self.assertEqual((self.root / "skills/first/SKILL.md").read_bytes(), original)
        text = (self.root / "README.md").read_text(encoding="utf-8")
        self.assertIn("[second](skills/second/SKILL.md)", text)
        self.assertTrue(text.startswith("Before\n"))
        self.assertTrue(text.endswith("After\n"))
        self.assertFalse((created / "scripts").exists())

    def test_existing_skill_cannot_be_overwritten(self):
        before = (self.root / "skills.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "already exists"):
            create_skill(self.root, "first", "Fixture", "Fixture")
        self.assertEqual((self.root / "skills.json").read_bytes(), before)

    def test_generated_draft_is_blocked_until_completed(self):
        created = create_skill(self.root, "second", "Fixture tasks", "Second fixture")
        self.assertTrue(
            any("unfinished skill draft" in error for error in validate_skill(created / "SKILL.md"))
        )
        (created / "SKILL.md").write_text(
            "---\nname: second\ndescription: Use for fixture tasks.\n---\n\nRead the input and verify the output.\n",
            encoding="utf-8",
        )
        self.assertEqual(validate_skill(created / "SKILL.md"), [])

    def test_bad_readme_does_not_leave_a_partial_skill(self):
        (self.root / "README.md").write_text("No markers", encoding="utf-8")
        with self.assertRaises(ValueError):
            create_skill(self.root, "second", "Fixture", "Fixture")
        self.assertFalse((self.root / "skills/second").exists())

    def test_catalog_rejects_duplicate_missing_and_escaping_paths(self):
        for entries in [
            [self.entries[0], self.entries[0]],
            [{"path": "skills/missing", "summary": "Fixture"}],
            [{"path": "skills/../outside", "summary": "Fixture"}],
            [{"path": "first", "summary": "Legacy root path"}],
            [{"path": "skills/nested/first", "summary": "Unexpected grouping"}],
            [{"path": "skills/tests", "summary": "Fixture"}],
        ]:
            with self.subTest(entries=entries):
                self.entries = entries
                self.save_catalog()
                with self.assertRaises(ValueError):
                    load_catalog(self.root)

    def test_unregistered_skill_is_detected(self):
        self.add_skill("second")
        with self.assertRaisesRegex(ValueError, "unregistered skills: skills/second"):
            load_catalog(self.root)

    def test_root_level_skill_is_rejected_instead_of_silently_ignored(self):
        misplaced = self.root / "misplaced"
        misplaced.mkdir()
        (misplaced / "SKILL.md").write_text("# Misplaced skill\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "skills must live under skills/"):
            load_catalog(self.root)

    def test_catalog_rejects_multiline_summary(self):
        self.entries[0]["summary"] = "First\nSecond"
        self.save_catalog()
        with self.assertRaises(ValueError):
            load_catalog(self.root)

    def test_markdown_summary_is_rendered_as_plain_text(self):
        entries = [{"path": "skills/first", "summary": "A | [label](outside)"}]
        text = updated_readme("<!-- skills:start --><!-- skills:end -->", entries)
        self.assertIn(r"A \| \[label\]\(outside\)", text)

    def test_instruction_only_skill_skips_python_tests(self):
        result = self.run_python_tests()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("skipped", result.stdout)

    def test_python_test_files_without_cases_fail(self):
        directory = self.root / "skills/first/tests"
        directory.mkdir()
        (directory / "test_empty.py").write_text("import unittest\n", encoding="utf-8")
        result = self.run_python_tests()
        self.assertEqual(result.returncode, 1)
        self.assertIn("no test cases were discovered", result.stderr)

    def test_python_tests_run_for_two_skills_and_propagate_failure(self):
        create_skill(self.root, "second", "Fixture", "Second fixture")
        for name, passing in [("first", True), ("second", False)]:
            directory = self.root / "skills" / name / "tests"
            directory.mkdir()
            (directory / "test_same.py").write_text(
                "from pathlib import Path\nimport unittest\nclass Fixture(unittest.TestCase):\n"
                "    def test_behavior(self):\n"
                "        Path('executed.txt').write_text('executed', encoding='utf-8')\n"
                f"        self.assertTrue({passing})\n",
                encoding="utf-8",
            )
        result = self.run_python_tests()
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAILED", result.stderr)
        for name in ("first", "second"):
            with self.subTest(skill=name):
                self.assertEqual(
                    (self.root / "skills" / name / "executed.txt").read_text(encoding="utf-8"),
                    "executed",
                )

    def test_nested_python_tests_cannot_be_silently_skipped(self):
        nested = self.root / "skills/first/tests/nested"
        nested.mkdir(parents=True)
        (nested / "test_behavior.py").write_text("import unittest\n", encoding="utf-8")
        result = self.run_python_tests()
        self.assertEqual(result.returncode, 1)
        self.assertIn("need __init__.py", result.stdout)

    def test_nested_python_package_tests_are_executed(self):
        nested = self.root / "skills/first/tests/nested"
        nested.mkdir(parents=True)
        (nested / "__init__.py").write_text("", encoding="utf-8")
        (nested / "test_behavior.py").write_text(
            "import unittest\nclass Fixture(unittest.TestCase):\n"
            "    def test_nested_behavior(self): self.fail('nested fixture executed')\n",
            encoding="utf-8",
        )
        result = self.run_python_tests()
        self.assertEqual(result.returncode, 1)
        self.assertIn("nested fixture executed", result.stderr)


if __name__ == "__main__":
    unittest.main()

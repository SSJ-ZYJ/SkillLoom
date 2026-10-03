from pathlib import Path
import json
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from validate_repository import sensitive_findings, validate_links, validate_repository, validate_skill
from skill_catalog import updated_readme


class RepositoryValidationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def make_repository(self):
        for name in ["README.md", "SECURITY.md", "docs/INSTALLATION.md"]:
            self.write(name, "# Fixture\n")
        self.write("LICENSE", "Fixture license\n")
        self.write("VERSION", "0.1.0\n")
        self.write("demo/LICENSE", "Fixture license\n")
        self.write("demo/SKILL.md", "---\nname: demo\ndescription: |\n  A scoped fixture skill.\n---\n\n# Demo\n")
        entries = [{"path": "demo", "summary": "Fixture skill"}]
        self.write("skills.json", json.dumps({"schema_version": 1, "skills": entries}))
        self.write("README.md", updated_readme("# Fixture\n\n<!-- skills:start -->\n<!-- skills:end -->\n", entries))
        self.write(".github/workflows/validate.yml", '"on":\n  push:\npermissions:\n  contents: read\njobs:\n  demo:\n    runs-on: ubuntu-latest\n    steps: []\n')

    def test_valid_repository_and_multiline_description(self):
        self.make_repository()
        self.assertEqual(validate_repository(self.root), [])

    def test_skill_name_must_match_directory(self):
        path = self.write("demo/SKILL.md", "---\nname: other\ndescription: Fixture\n---\n")
        self.assertIn("skill name must match its directory", validate_skill(path))

    def test_boolean_description_is_rejected(self):
        path = self.write("demo/SKILL.md", "---\nname: demo\ndescription: true\n---\n")
        self.assertTrue(validate_skill(path))

    def test_invalid_yaml_is_rejected(self):
        path = self.write("demo/SKILL.md", "---\nname: [broken\ndescription: Fixture\n---\n")
        self.assertEqual(validate_skill(path), ["invalid YAML frontmatter"])

    def test_empty_instructions_are_rejected(self):
        path = self.write("demo/SKILL.md", "---\nname: demo\ndescription: Fixture\n---\n")
        self.assertIn("skill instructions must not be empty", validate_skill(path))

    def test_invalid_utf8_skill_is_reported_without_crashing(self):
        path = self.write("demo/SKILL.md", "Fixture")
        path.write_bytes(bytes([255]))
        self.assertEqual(validate_skill(path), ["SKILL.md must be readable UTF-8 text"])

    def test_invalid_compatibility_and_metadata_types_are_rejected(self):
        path = self.write("demo/SKILL.md", "---\nname: demo\ndescription: Fixture\ncompatibility: true\nmetadata: []\n---\n\nFixture instructions.\n")
        errors = validate_skill(path)
        self.assertTrue(any("compatibility" in error for error in errors))
        self.assertIn("metadata must be a mapping", errors)

    def test_relative_and_encoded_links_resolve(self):
        self.write("references/some file.md", "fixture")
        path = self.write("README.md", "[ok](references/some%20file.md)\n[web](https://example.org)\n")
        self.assertEqual(validate_links(path, self.root), [])

    def test_missing_link_and_repository_escape_are_rejected(self):
        path = self.write("README.md", "[missing](absent.md)\n[escape](../outside.md)\n")
        errors = validate_links(path, self.root)
        self.assertTrue(any("missing link" in error for error in errors))
        self.assertIn("local link escapes repository", errors)

    def test_public_link_to_local_maintenance_documentation_is_rejected(self):
        self.write(".local-docs/MAINTENANCE.md", "Fixture local notes\n")
        path = self.write("README.md", "[local](.local-docs/MAINTENANCE.md)\n")
        self.assertIn("public documents must not link to local maintenance documentation", validate_links(path, self.root))

    def test_local_documentation_is_excluded_before_git_initialization(self):
        self.make_repository()
        self.write(".local-docs/MAINTENANCE.md", "[local-only](not-published.md)\n")
        self.assertEqual(validate_repository(self.root), [])

    @unittest.skipUnless(shutil.which("git"), "Git is required for publication-scope checks")
    def test_local_documentation_is_ignored_but_forced_tracked_files_are_rejected(self):
        self.make_repository()
        ignore = (Path(__file__).resolve().parents[1] / ".gitignore").read_text(encoding="utf-8")
        self.write(".gitignore", ignore)
        self.write(".local-docs/MAINTENANCE.md", "Fixture local notes\n")
        subprocess.run(["git", "init", "--quiet"], cwd=self.root, check=True, capture_output=True)
        self.assertEqual(validate_repository(self.root), [])
        subprocess.run(["git", "add", "--force", ".local-docs/MAINTENANCE.md"],
                       cwd=self.root, check=True, capture_output=True)
        self.assertTrue(any(".local-docs" in error and "artifact" in error for error in validate_repository(self.root)))

    def test_links_in_examples_do_not_create_false_failures(self):
        path = self.write("README.md", "```md\n[example](not-a-real-file.md)\n```\n")
        self.assertEqual(validate_links(path, self.root), [])

    def test_explicit_mock_credentials_are_allowed(self):
        text = '?zzud=FAKE_SECRET\n"Pc-Authorization": "TEST_AUTH"\n'
        self.assertEqual(sensitive_findings(text), [])

    def test_realistic_literal_credentials_fail_without_printing_their_values(self):
        secret = "fixture-sensitive-value"
        errors = sensitive_findings(f'?zzud={secret}\n' + json.dumps({"Pc-Authorization": secret}))
        self.assertTrue(errors)
        self.assertNotIn(secret, " ".join(errors))

    def test_private_key_github_token_and_personal_path_are_flagged(self):
        key = "-----BEGIN " + "PRIVATE KEY-----"
        token = "ghp_" + "a" * 25
        user_path = "C:" + "/Users/fixture/file"
        self.assertEqual(len(sensitive_findings("\n".join([key, token, user_path]))), 3)

    def test_standalone_skill_needs_matching_license(self):
        self.make_repository()
        self.write("demo/LICENSE", "Different fixture license\n")
        self.assertTrue(any("license differs" in error for error in validate_repository(self.root)))

    def test_privileged_workflow_trigger_is_rejected(self):
        self.make_repository()
        self.write(".github/workflows/validate.yml", '"on":\n  pull_request_target:\npermissions:\n  contents: read\njobs:\n  demo: {}\n')
        self.assertTrue(any("privileged" in error for error in validate_repository(self.root)))

    def test_readme_catalog_drift_fails_publication(self):
        self.make_repository()
        path = self.root / "README.md"
        path.write_text(path.read_text(encoding="utf-8").replace("Fixture skill", "Outdated"), encoding="utf-8")
        self.assertTrue(any("catalog is out of date" in error for error in validate_repository(self.root)))

    def test_new_skill_without_registration_fails_publication(self):
        self.make_repository()
        self.write("new-skill/SKILL.md", "---\nname: new-skill\ndescription: Fixture\n---\n")
        self.write("new-skill/LICENSE", "Fixture license\n")
        self.assertTrue(any("unregistered skills" in error for error in validate_repository(self.root)))

    @unittest.skipUnless(shutil.which("git"), "Git is required for publication-scope checks")
    def test_untracked_ignored_session_file_is_not_part_of_publication(self):
        self.make_repository()
        self.write(".gitignore", ".env\ncaptures/\n")
        self.write(".env", "fixture-local-state")
        self.write("captures/session.har", "fixture-local-state")
        subprocess.run(["git", "init", "--quiet"], cwd=self.root, check=True, capture_output=True)
        self.assertEqual(validate_repository(self.root), [])

    @unittest.skipUnless(shutil.which("git"), "Git is required for publication-scope checks")
    def test_tracked_ignored_session_files_are_still_rejected(self):
        self.make_repository()
        self.write(".gitignore", ".env\ncaptures/\n")
        self.write(".env", "fixture-local-state")
        self.write("captures/session.har", "fixture-local-state")
        subprocess.run(["git", "init", "--quiet"], cwd=self.root, check=True, capture_output=True)
        subprocess.run(["git", "add", "--force", ".env", "captures/session.har"],
                       cwd=self.root, check=True, capture_output=True)
        errors = validate_repository(self.root)
        self.assertTrue(any(".env:" in error and "artifact" in error for error in errors))
        self.assertTrue(any("session.har:" in error and "artifact" in error for error in errors))

    @unittest.skipUnless(shutil.which("git"), "Git is required for publication-scope checks")
    def test_local_cli_installations_are_ignored_and_forced_tracked_copies_are_rejected(self):
        self.make_repository()
        ignore = (Path(__file__).resolve().parents[1] / ".gitignore").read_text(encoding="utf-8")
        self.write(".gitignore", ignore)
        self.write(".claude/skills/demo/SKILL.md", "Fixture installed skill\n")
        self.write(".cursor/skills/demo/SKILL.md", "Fixture installed skill\n")
        self.write("skills-lock.json", "{}\n")
        subprocess.run(["git", "init", "--quiet"], cwd=self.root, check=True, capture_output=True)
        self.assertEqual(validate_repository(self.root), [])
        subprocess.run(["git", "add", "--force", ".claude/skills/demo/SKILL.md", "skills-lock.json"],
                       cwd=self.root, check=True, capture_output=True)
        errors = validate_repository(self.root)
        self.assertTrue(any(".claude" in error and "artifact" in error for error in errors))
        self.assertTrue(any("skills-lock.json" in error and "artifact" in error for error in errors))


if __name__ == "__main__":
    unittest.main()

"""Tests for the dependency-free Web profile folder indexer."""

import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "update_profiles.py"
SPEC = importlib.util.spec_from_file_location("update_profiles", str(SCRIPT))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class UpdateProfilesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / "profiles").mkdir()
        (self.root / "environments").mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def test_indexes_original_jsonc_and_changes_revision_after_edit(self):
        profile = self.root / "profiles" / "sit.turnstage.jsonc"
        environment = self.root / "environments" / "sit.environment.jsonc"
        profile.write_text('{ // VSIX JSONC\n "id": "sit", }\n', encoding="utf-8")
        environment.write_text('{ "id": "sit", "variables": {}, }\n', encoding="utf-8")

        counts = MODULE.generate(self.root)
        catalog = json.loads((self.root / "turnstage-catalog.json").read_text(encoding="utf-8"))
        self.assertEqual(counts[:2], (1, 1))
        self.assertEqual(catalog["profiles"][0]["file"], "./profiles/sit.turnstage.jsonc")
        self.assertEqual(catalog["environments"][0]["file"], "./environments/sit.environment.jsonc")
        self.assertIn("// VSIX JSONC", profile.read_text(encoding="utf-8"))
        self.assertEqual(stat.S_IMODE((self.root / "turnstage-catalog.json").stat().st_mode), 0o644)

        previous = catalog["revision"]
        profile.write_text('{ "id": "sit", "name": "Changed" }\n', encoding="utf-8")
        MODULE.generate(self.root)
        updated = json.loads((self.root / "turnstage-catalog.json").read_text(encoding="utf-8"))
        self.assertNotEqual(updated["revision"], previous)
        self.assertNotEqual(updated["profiles"][0]["version"], catalog["profiles"][0]["version"])
        self.assertEqual(stat.S_IMODE((self.root / "turnstage-catalog.json").stat().st_mode), 0o644)

    def test_empty_folders_keep_bundled_examples(self):
        MODULE.generate(self.root)
        catalog = json.loads((self.root / "turnstage-catalog.json").read_text(encoding="utf-8"))
        self.assertEqual(len(catalog["profiles"]), 3)
        self.assertEqual(catalog["environments"], [{"bundled": "local"}])

    def test_url_encodes_existing_unicode_profile_filenames(self):
        (self.root / "profiles" / "中文 測試.turnstage.jsonc").write_text('{ "id": "sit" }', encoding="utf-8")
        MODULE.generate(self.root)
        catalog = json.loads((self.root / "turnstage-catalog.json").read_text(encoding="utf-8"))
        self.assertEqual(catalog["profiles"][0]["file"], "./profiles/%E4%B8%AD%E6%96%87%20%E6%B8%AC%E8%A9%A6.turnstage.jsonc")

    def test_refuses_to_overwrite_a_manual_catalog(self):
        target = self.root / "turnstage-catalog.json"
        manual = {"format": "turnstage-web-catalog", "id": "company", "profiles": [], "environments": []}
        target.write_text(json.dumps(manual), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "refusing to overwrite"):
            MODULE.generate(self.root)
        self.assertEqual(json.loads(target.read_text(encoding="utf-8")), manual)

    def test_rejects_unsafe_filenames_and_oversized_files_before_replacing_catalog(self):
        target = self.root / "turnstage-catalog.json"
        MODULE.generate(self.root)
        previous = target.read_bytes()
        unsafe = self.root / "profiles" / "bad\\name.turnstage.jsonc"
        unsafe.write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Unsupported or unsafe"):
            MODULE.generate(self.root)
        self.assertEqual(target.read_bytes(), previous)
        unsafe.unlink()

        large = self.root / "profiles" / "large.turnstage.jsonc"
        large.write_bytes(b"x" * (MODULE.MAX_FILE_BYTES + 1))
        with self.assertRaisesRegex(ValueError, "exceeds 512 KiB"):
            MODULE.generate(self.root)
        self.assertEqual(target.read_bytes(), previous)


if __name__ == "__main__":
    unittest.main()

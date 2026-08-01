from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from smoke_evidence import build_evidence_manifest, evidence_file_entry


COMMIT = "1" * 40


class SmokeEvidenceManifestTests(unittest.TestCase):
    def test_manifest_is_sorted_and_content_addressed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            second = root / "run-2" / "RESULT.json"
            first = root / "run-1" / "RESULT.json"
            second.parent.mkdir(parents=True)
            first.parent.mkdir(parents=True)
            second.write_bytes(b"second\n")
            first.write_bytes(b"first\n")

            manifest = build_evidence_manifest(
                root,
                COMMIT,
                [(second, "run-result"), (first, "run-result")],
            )

            self.assertEqual(manifest["gitCommit"], COMMIT)
            self.assertEqual(manifest["hashAlgorithm"], "sha256")
            self.assertEqual(
                [entry["path"] for entry in manifest["files"]],
                ["run-1/RESULT.json", "run-2/RESULT.json"],
            )
            self.assertEqual(
                manifest["files"][0]["sha256"],
                hashlib.sha256(b"first\n").hexdigest(),
            )

    def test_manifest_rejects_duplicate_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = root / "RESULT.json"
            result.write_text("{}\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicate paths"):
                build_evidence_manifest(
                    root,
                    COMMIT,
                    [(result, "run-result"), (result, "summary")],
                )

    def test_entry_rejects_files_outside_artifact_root(self) -> None:
        with tempfile.TemporaryDirectory() as artifact_directory:
            with tempfile.TemporaryDirectory() as external_directory:
                external = Path(external_directory) / "outside.json"
                external.write_text("{}\n", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "outside artifact root"):
                    evidence_file_entry(Path(artifact_directory), external, "run-result")

    def test_manifest_rejects_invalid_commit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = root / "RESULT.json"
            result.write_text("{}\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "invalid evidence commit"):
                build_evidence_manifest(root, "not-a-commit", [(result, "run-result")])


if __name__ == "__main__":
    unittest.main()

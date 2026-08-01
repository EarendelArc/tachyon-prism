from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from smoke_evidence import (
    WINDOWS_REPARSE_POINT,
    build_evidence_manifest,
    evidence_file_entry,
    secure_file_measure,
)


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
                manifest["artifactType"], "tachyon-prism-renderer-fixture-evidence"
            )
            native_manifest = build_evidence_manifest(
                root,
                COMMIT,
                [(first, "native-build-executable-not-executed")],
                artifact_type="tachyon-prism-native-build-evidence",
            )
            self.assertEqual(
                native_manifest["artifactType"], "tachyon-prism-native-build-evidence"
            )
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

    @unittest.skipIf(os.name == "nt", "POSIX symlink behavior is covered on Unix CI")
    def test_entry_rejects_symlinked_file_and_parent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            real = root / "real"
            real.mkdir()
            target = real / "RESULT.json"
            target.write_text("{}\n", encoding="utf-8")
            file_link = root / "linked-result.json"
            parent_link = root / "linked-parent"
            os.symlink(target, file_link)
            os.symlink(real, parent_link, target_is_directory=True)

            with self.assertRaisesRegex(ValueError, "symlink or reparse point"):
                secure_file_measure(file_link)
            with self.assertRaisesRegex(ValueError, "symlink or reparse point"):
                secure_file_measure(parent_link / target.name)

    @unittest.skipUnless(os.name == "nt", "Windows junction behavior is Windows-only")
    def test_entry_rejects_windows_junction_parent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            real = root / "real"
            real.mkdir()
            target = real / "RESULT.json"
            target.write_text("{}\n", encoding="utf-8")
            junction = root / "junction"
            completed = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(junction), str(real)],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)
            try:
                with self.assertRaisesRegex(ValueError, "symlink or reparse point"):
                    secure_file_measure(junction / target.name)
            finally:
                os.rmdir(junction)

    def test_reparse_attribute_is_rejected_even_without_symlink_mode(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "RESULT.json"
            path.write_text("{}\n", encoding="utf-8")
            original_lstat = os.lstat

            def reparse_lstat(candidate: os.PathLike[str] | str) -> os.stat_result:
                metadata = original_lstat(candidate)
                if Path(candidate) != path:
                    return metadata
                return SimpleNamespace(
                    st_mode=metadata.st_mode,
                    st_file_attributes=WINDOWS_REPARSE_POINT,
                )

            with mock.patch("smoke_evidence.os.lstat", side_effect=reparse_lstat):
                with self.assertRaisesRegex(ValueError, "symlink or reparse point"):
                    secure_file_measure(path)

    def test_measure_rejects_open_file_replacement_or_mutation_race(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / "RESULT.json"
            replacement = root / "replacement.json"
            evidence.write_bytes(b"original-evidence\n")
            replacement.write_bytes(b"replacement-evidence\n")

            def replace_after_open() -> None:
                try:
                    os.replace(replacement, evidence)
                except PermissionError:
                    evidence.write_bytes(b"mutated-while-open\n")

            with self.assertRaisesRegex(
                ValueError, "changed while reading|identity changed after reading"
            ):
                secure_file_measure(evidence, _after_open=replace_after_open)

    def test_manifest_rejects_invalid_commit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = root / "RESULT.json"
            result.write_text("{}\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "invalid evidence commit"):
                build_evidence_manifest(root, "not-a-commit", [(result, "run-result")])


if __name__ == "__main__":
    unittest.main()

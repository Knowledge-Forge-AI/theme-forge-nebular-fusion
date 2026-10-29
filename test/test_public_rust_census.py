"""Unit tests for the public Rust census wrapper using an owned fake compiler."""
from __future__ import annotations

import hashlib
import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


TOOL = Path(__file__).resolve().parents[1] / "tools" / "public-rust-census.py"
SAFE_SCRATCH = os.environ.get("NEBULAR_TEST_SCRATCH", str(Path.cwd()))


def canonical(value: object) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")


class PublicRustCensusTests(unittest.TestCase):
    def _fake_compiler(self, root: Path) -> Path:
        path = root / "fake-rustc.py"
        path.write_text(
            """#!/usr/bin/env python3
import json
import os
import signal
import sys

out = os.environ["FAKE_COMPILER_OUTPUT"]
with open(out, "w", encoding="utf-8") as stream:
    json.dump({"argv": sys.argv[1:], "marker": os.environ.get("FAKE_MARKER")}, stream)
print("fake-stdout")
print("fake-stderr", file=sys.stderr)
if os.environ.get("FAKE_SIGNAL"):
    os.kill(os.getpid(), signal.SIGTERM)
raise SystemExit(int(os.environ.get("FAKE_EXIT", "0")))
""",
            encoding="utf-8",
        )
        path.chmod(0o700)
        return path

    def _run_wrapper(
        self,
        root: Path,
        compiler: Path,
        rustc_args: list[str],
        *,
        session: str = "fresh",
        marker: str = "preserved",
        extra: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        output = root / f"fake-output-{session}-{marker}.json"
        env = os.environ.copy()
        env.update(
            {
                "NEBULAR_RUSTC_CENSUS_DIR": str(root),
                "NEBULAR_RUST_CENSUS_SESSION": session,
                "FAKE_COMPILER_OUTPUT": str(output),
                "FAKE_MARKER": marker,
                "FAKE_EXIT": "0",
            },
        )
        if extra:
            env.update(extra)
        return subprocess.run(
            [sys.executable, str(TOOL), str(compiler), *rustc_args],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

    def _records(self, root: Path) -> list[Path]:
        return sorted(root.glob("record-*.json"))

    def _metadata(self, root: Path) -> Path:
        metadata = root / "metadata.json"
        body = {
            "schema": "rs9.nebular070-public-rust-census-metadata.v1",
            "source": {"identity": "a" * 64, "path": "/private/source/TOKEN"},
            "product": {"identity": "b" * 64},
            "producer": {"identity": "c" * 64},
            "target": {"identity": "d" * 64},
            "build": {"identity": "e" * 64},
            "payload": {"identity": "f" * 64},
            "elf": {"identity": "0" * 64},
        }
        metadata.write_bytes(canonical(body))
        return metadata

    def test_exec_preserves_argv_io_exit_and_records_cpu_flags(self) -> None:
        with tempfile.TemporaryDirectory(dir=SAFE_SCRATCH) as temp:
            root = Path(temp)
            compiler = self._fake_compiler(root)
            rustc_args = [
                "--crate-name",
                "nebular_core",
                "--target",
                "aarch64-unknown-linux-gnu",
                "-C",
                "opt-level=2",
                "-Ctarget-cpu=generic",
                "-Ctarget-feature=+neon,-sve",
                "-Cllvm-args=-mattr=+sve",
                "-Ctarget-unknown=/private/secret-token",
                "--extern",
                "dep=/private/secret",
            ]
            completed = self._run_wrapper(root, compiler, rustc_args, extra={"FAKE_EXIT": "7"})
            self.assertEqual(completed.returncode, 7)
            self.assertEqual(completed.stdout, "fake-stdout\n")
            self.assertEqual(completed.stderr, "fake-stderr\n")
            fake_output = json.loads((root / "fake-output-fresh-preserved.json").read_text())
            self.assertEqual(fake_output["argv"], rustc_args)
            self.assertEqual(fake_output["marker"], "preserved")
            records = self._records(root)
            self.assertEqual(len(records), 1)
            record_raw = records[0].read_bytes()
            record = json.loads(record_raw)
            self.assertEqual(
                record["full_argv_sha256"],
                hashlib.sha256(canonical([str(compiler), *rustc_args])).hexdigest(),
            )
            self.assertEqual(record["crate_name"], "nebular_core")
            self.assertEqual(record["target"], "aarch64-unknown-linux-gnu")
            self.assertEqual(record["codegen"]["opt-level"], ["2"])
            self.assertEqual(record["cpu_overrides"]["target-cpu"], ["generic"])
            self.assertEqual(record["feature_overrides"]["target-feature"], ["+neon,-sve"])
            self.assertEqual(record["llvm_overrides"], ["-mattr=+sve"])
            self.assertEqual(record["unknown_overrides"][0]["key"], "target-unknown")
            self.assertNotIn("/private", record_raw.decode())
            self.assertNotIn("secret-token", record_raw.decode())
            self.assertEqual(stat.S_IMODE(records[0].stat().st_mode), 0o600)

    def test_exec_preserves_signal_status_without_wrapper_reaping(self) -> None:
        with tempfile.TemporaryDirectory(dir=SAFE_SCRATCH) as temp:
            root = Path(temp)
            compiler = self._fake_compiler(root)
            completed = self._run_wrapper(root, compiler, [], extra={"FAKE_SIGNAL": "TERM"})
            self.assertEqual(completed.returncode, -signal.SIGTERM)
            self.assertEqual(len(self._records(root)), 1)

    def test_recording_failure_is_before_compiler_exec(self) -> None:
        with tempfile.TemporaryDirectory(dir=SAFE_SCRATCH) as temp:
            root = Path(temp)
            compiler = self._fake_compiler(root)
            env = os.environ.copy()
            env.pop("NEBULAR_RUSTC_CENSUS_DIR", None)
            env["FAKE_COMPILER_OUTPUT"] = str(root / "must-not-exist.json")
            completed = subprocess.run(
                [sys.executable, str(TOOL), str(compiler), "--crate-name", "blocked"],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 1)
            self.assertIn("NEBULAR_RUST_CENSUS_DIR_REQUIRED", completed.stderr)
            self.assertFalse((root / "must-not-exist.json").exists())

    def test_aggregate_seals_only_fresh_session_and_redacts_metadata(self) -> None:
        with tempfile.TemporaryDirectory(dir=SAFE_SCRATCH) as temp:
            root = Path(temp)
            compiler = self._fake_compiler(root)
            self.assertEqual(self._run_wrapper(root, compiler, ["--crate-name", "old"], session="old").returncode, 0)
            self.assertEqual(
                self._run_wrapper(
                    root,
                    compiler,
                    ["-C", "target-cpu=generic", "-Ctarget-feature=+neon"],
                    session="fresh",
                ).returncode,
                0,
            )
            metadata = self._metadata(root)
            output = root / "aggregate.json"
            env = os.environ.copy()
            env.update({"NEBULAR_RUSTC_CENSUS_DIR": str(root), "NEBULAR_RUST_CENSUS_SESSION": "fresh"})
            completed = subprocess.run(
                [
                    sys.executable,
                    str(TOOL),
                    "aggregate",
                    "--records",
                    str(root),
                    "--metadata",
                    str(metadata),
                    "--session",
                    "fresh",
                    "--output",
                    str(output),
                ],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertTrue(output.is_file())
            body_raw = output.read_bytes()
            body = json.loads(body_raw)
            self.assertEqual(body["record_count"], 1)
            self.assertEqual(body["session"], "fresh")
            self.assertEqual(body["evidence_mode"], "compiler-invocation-observation")
            self.assertEqual(body["admission"], "not-claimed")
            self.assertEqual(body["bindings"]["source"], "a" * 64)
            self.assertNotIn("/private", body_raw.decode())
            self.assertNotIn("TOKEN", body_raw.decode())
            self.assertEqual(body["records"][0]["cpu_overrides"]["target-cpu"], ["generic"])

    def test_aggregate_rejects_malformed_and_oversized_members(self) -> None:
        with tempfile.TemporaryDirectory(dir=SAFE_SCRATCH) as temp:
            root = Path(temp)
            metadata = self._metadata(root)
            output = root / "aggregate.json"
            env = os.environ.copy()
            env.update({"NEBULAR_RUSTC_CENSUS_DIR": str(root), "NEBULAR_RUST_CENSUS_SESSION": "fresh"})
            bad = root / "record-bad.json"
            bad.write_bytes(b"{not-json")
            completed = subprocess.run(
                [
                    sys.executable,
                    str(TOOL),
                    "aggregate",
                    "--records",
                    str(root),
                    "--metadata",
                    str(metadata),
                    "--session",
                    "fresh",
                    "--output",
                    str(output),
                ],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 1)
            self.assertIn("NEBULAR_RUST_MALFORMED_JSON", completed.stderr)
            bad.unlink()
            (root / "record-big.json").write_bytes(b"x" * (64 * 1024 + 1))
            completed = subprocess.run(
                [
                    sys.executable,
                    str(TOOL),
                    "aggregate",
                    "--records",
                    str(root),
                    "--metadata",
                    str(metadata),
                    "--session",
                    "fresh",
                    "--output",
                    str(output),
                ],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 1)
            self.assertIn("NEBULAR_RUST_RECORD_READ", completed.stderr)


if __name__ == "__main__":
    unittest.main()

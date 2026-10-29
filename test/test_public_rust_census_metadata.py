"""Pure metadata/probe tests using an owned fake rustc executable."""
from __future__ import annotations

import json
import hashlib
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "tools" / "public-rust-census-metadata.py"


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


class PublicRustCensusMetadataTests(unittest.TestCase):
    def _fake_rustc(self, root: Path) -> Path:
        path = root / "fake-rustc.py"
        path.write_text(
            """#!/usr/bin/env python3
import os
import sys
if sys.argv[1:] == ["-Vv"]:
    print("rustc 1.98.0 (fake)")
    print("binary: rustc")
    print("commit-hash: abcdef0123456789abcdef0123456789abcdef01")
    print("commit-date: 2026-01-01")
    print("host: x86_64-unknown-linux-gnu")
elif sys.argv[1:3] == ["--print", "cfg"]:
    if os.environ.get("FAKE_INVALID_CFG"):
        print('target_feature="/private/secret"')
        raise SystemExit(0)
    print('target_arch="x86_64"')
    print('target_endian="little"')
    print('target_env="gnu"')
    print('target_os="linux"')
    print('target_pointer_width="64"')
    print('target_vendor="unknown"')
    print('target_feature="sse2"')
    print('target_feature="cmpxchg16b"')
else:
    raise SystemExit(9)
""",
            encoding="utf-8",
        )
        path.chmod(0o700)
        return path

    def test_probe_and_metadata_bind_exact_inputs_without_paths(self) -> None:
        with tempfile.TemporaryDirectory(dir=str(Path.cwd())) as temp:
            root = Path(temp)
            fake = self._fake_rustc(root)
            probe = root / "probe.json"
            env = os.environ.copy()
            env["CARGO_ENCODED_RUSTFLAGS"] = "-Ctarget-cpu=generic\x1f-Ctarget-feature=+sse2"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(HELPER),
                    "probe",
                    "--rustc",
                    str(fake),
                    "--target",
                    "x86_64-unknown-linux-gnu",
                    "--output",
                    str(probe),
                ],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            probe_doc = json.loads(probe.read_bytes())
            self.assertEqual(probe_doc["schema"], "rs9.nebular070-public-rustc-probe.v1")
            self.assertEqual(probe_doc["cfg_count"], 8)
            self.assertEqual(probe_doc["cfg"]["target_arch"], "x86_64")
            self.assertEqual(probe_doc["cfg"]["target_endian"], "little")
            self.assertEqual(probe_doc["cfg"]["target_env"], "gnu")
            self.assertEqual(probe_doc["cfg"]["target_os"], "linux")
            self.assertEqual(probe_doc["cfg"]["target_pointer_width"], "64")
            self.assertEqual(probe_doc["cfg"]["target_vendor"], "unknown")
            self.assertEqual(probe_doc["cfg"]["target_feature"], ["cmpxchg16b", "sse2"])
            self.assertTrue(probe_doc["environment"]["CARGO_ENCODED_RUSTFLAGS"]["present"])
            self.assertNotIn(str(fake), probe.read_text())

            invalid_probe = root / "invalid-probe.json"
            invalid_env = dict(env, FAKE_INVALID_CFG="1")
            completed = subprocess.run(
                [
                    sys.executable,
                    str(HELPER),
                    "probe",
                    "--rustc",
                    str(fake),
                    "--target",
                    "x86_64-unknown-linux-gnu",
                    "--output",
                    str(invalid_probe),
                ],
                env=invalid_env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 1)
            self.assertIn("NEBULAR_RUST_METADATA_PROBE_CFG_VALUE", completed.stderr)
            self.assertFalse(invalid_probe.exists())

            inputs = {}
            source_body = {
                "schema": "nebular.public-pypi-source-origin-v2",
                "status": "pass",
                "source": {"commit": "b" * 40, "tree": "c" * 40},
                "producer": {"commit": "d" * 40, "tree": "e" * 40},
                "runtime": {"target": "x86_64-unknown-linux-gnu"},
            }
            source_body["identity"] = hashlib.sha256(canonical(source_body)).hexdigest()
            for name, body in (
                ("source-origin.json", source_body),
                ("build-receipt.json", {"schema": "build"}),
                ("package-record.json", {"schema": "package"}),
                ("qualification.json", {"schema": "qualification"}),
            ):
                path = root / name
                path.write_bytes(canonical(body))
                inputs[name] = path
            metadata = root / "metadata.json"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(HELPER),
                    "metadata",
                    "--source-origin",
                    str(inputs["source-origin.json"]),
                    "--build-receipt",
                    str(inputs["build-receipt.json"]),
                    "--package-record",
                    str(inputs["package-record.json"]),
                    "--qualification",
                    str(inputs["qualification.json"]),
                    "--probe",
                    str(probe),
                    "--product-commit",
                    "b" * 40,
                    "--product-tree",
                    "c" * 40,
                    "--producer-commit",
                    "d" * 40,
                    "--producer-tree",
                    "e" * 40,
                    "--platform",
                    "linux-x64",
                    "--triple",
                    "x86_64-unknown-linux-gnu",
                    "--output",
                    str(metadata),
                ],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            raw = metadata.read_text()
            doc = json.loads(raw)
            self.assertEqual(doc["schema"], "rs9.nebular070-public-rust-census-metadata.v1")
            self.assertEqual(doc["source"]["identity"], source_body["identity"])
            self.assertEqual(doc["elf"]["kind"], "qualification-file-binding")
            self.assertEqual(doc["target"]["kind"], "target")
            self.assertNotIn(str(root), raw)

            mismatched_metadata = root / "mismatched-metadata.json"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(HELPER),
                    "metadata",
                    "--source-origin",
                    str(inputs["source-origin.json"]),
                    "--build-receipt",
                    str(inputs["build-receipt.json"]),
                    "--package-record",
                    str(inputs["package-record.json"]),
                    "--qualification",
                    str(inputs["qualification.json"]),
                    "--probe",
                    str(probe),
                    "--product-commit",
                    "f" * 40,
                    "--product-tree",
                    "c" * 40,
                    "--producer-commit",
                    "d" * 40,
                    "--producer-tree",
                    "e" * 40,
                    "--platform",
                    "linux-x64",
                    "--triple",
                    "x86_64-unknown-linux-gnu",
                    "--output",
                    str(mismatched_metadata),
                ],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 1)
            self.assertIn("NEBULAR_RUST_METADATA_SOURCE_PRODUCT_MISMATCH", completed.stderr)
            self.assertFalse(mismatched_metadata.exists())


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Create bounded Rust compiler probes and census identity metadata.

This helper intentionally records hashes and small allowlisted observations,
never raw compiler paths or command output.  Its metadata joins are evidence
bindings only; they do not establish an ISA admission or portability claim.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any


PROBE_SCHEMA = "rs9.nebular070-public-rustc-probe.v1"
METADATA_SCHEMA = "rs9.nebular070-public-rust-census-metadata.v1"
MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_COMPILER_BYTES = 512 * 1024 * 1024
MAX_COMMAND_OUTPUT = 1024 * 1024
IDENTITY_RE = re.compile(r"^[0-9a-f]{64}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
SAFE_RE = re.compile(r"^[A-Za-z0-9_.:+,=@%\-]{1,128}$")
CFG_SCALARS = frozenset(
    {
        "target_arch",
        "target_endian",
        "target_env",
        "target_os",
        "target_pointer_width",
        "target_vendor",
    }
)


class MetadataError(Exception):
    def __init__(self, code: str):
        self.code = f"NEBULAR_RUST_METADATA_{code}"
        super().__init__(self.code)


def fail(code: str) -> None:
    raise MetadataError(code)


def canonical(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError):
        fail("JSON_ENCODING")
    raise AssertionError("unreachable")


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def no_symlink_chain(path: Path) -> None:
    try:
        if any(item.is_symlink() for item in (path, *path.parents)):
            fail("SYMLINK")
    except OSError:
        fail("PATH")


def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail("DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def reject_constant(value: str) -> None:
    fail("NONFINITE_JSON")


def strict_json(raw: bytes) -> Any:
    try:
        return json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=reject_duplicates,
            parse_constant=reject_constant,
        )
    except MetadataError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError):
        fail("MALFORMED_JSON")
    raise AssertionError("unreachable")


def read_regular(path: Path, limit: int) -> bytes:
    no_symlink_chain(path)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError:
        fail("INPUT_READ")
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size < 0 or before.st_size > limit:
            fail("INPUT_SIZE")
        chunks: list[bytes] = []
        remaining = before.st_size
        while remaining:
            chunk = os.read(fd, min(remaining, 64 * 1024))
            if not chunk:
                fail("INPUT_SHORT")
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(fd)
        before_key = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
        after_key = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        if before_key != after_key:
            fail("INPUT_CHANGED")
        return b"".join(chunks)
    finally:
        os.close(fd)


def write_exclusive(path: Path, value: Mapping[str, Any], limit: int) -> None:
    raw = canonical(value)
    if len(raw) > limit:
        fail("OUTPUT_SIZE")
    no_symlink_chain(path)
    if path.exists() or not path.parent.is_dir():
        fail("OUTPUT_EXISTS")
    try:
        fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}-", suffix=".tmp", dir=path.parent)
        os.fchmod(fd, 0o600)
        try:
            offset = 0
            while offset < len(raw):
                offset += os.write(fd, raw[offset:])
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temp_name, path)
    except (OSError, MetadataError):
        try:
            Path(temp_name).unlink()
        except (OSError, UnboundLocalError):
            pass
        if isinstance(sys.exc_info()[1], MetadataError):
            raise
        fail("OUTPUT_WRITE")


def safe(value: str) -> str:
    if not isinstance(value, str) or not SAFE_RE.fullmatch(value):
        return "<redacted>"
    return value


def command_output(command: list[str]) -> bytes:
    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        fail("PROBE_COMMAND")
    if completed.returncode != 0 or len(completed.stdout) > MAX_COMMAND_OUTPUT or len(completed.stderr) > MAX_COMMAND_OUTPUT:
        fail("PROBE_COMMAND")
    return completed.stdout


def cfg_value(raw: str) -> str:
    if not isinstance(raw, str) or not SAFE_RE.fullmatch(raw):
        fail("PROBE_CFG_VALUE")
    return raw


def parse_cfg(raw: bytes) -> dict[str, Any]:
    fields: dict[str, str] = {}
    features: list[str] = []
    for line in raw.decode("utf-8", "replace").splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key not in CFG_SCALARS and key != "target_feature":
            continue
        if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
            try:
                parsed = json.loads(value)
            except (TypeError, ValueError, UnicodeDecodeError):
                fail("PROBE_CFG_VALUE")
            if not isinstance(parsed, str):
                fail("PROBE_CFG_VALUE")
            value = parsed
        value = cfg_value(value)
        if key == "target_feature":
            features.append(value)
        elif key in fields:
            fail("PROBE_CFG_DUPLICATE")
        else:
            fields[key] = value
    fields["target_feature"] = sorted(features)
    return {key: fields[key] for key in sorted(fields)}


def env_summary() -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key in ("CARGO_ENCODED_RUSTFLAGS", "RUSTFLAGS", "CARGO_BUILD_TARGET", "CARGO_TARGET_DIR", "RUSTC_WRAPPER"):
        value = os.environ.get(key)
        if value is None:
            result[key] = {"present": False}
            continue
        result[key] = {
            "present": True,
            "sha256": digest(value.encode("utf-8", "surrogateescape")),
            "field_count": len([part for part in value.split("\x1f") if part]),
        }
    return result


def probe(args: argparse.Namespace) -> None:
    if not SAFE_RE.fullmatch(args.target):
        fail("PROBE_TARGET")
    rustc = Path(args.rustc)
    compiler_bytes = read_regular(rustc, MAX_COMPILER_BYTES)
    version_raw = command_output([str(rustc), "-Vv"])
    cfg_raw = command_output([str(rustc), "--print", "cfg", "--target", args.target])
    version_fields: dict[str, str] = {}
    for line in version_raw.decode("utf-8", "replace").splitlines():
        if ": " not in line:
            continue
        key, value = line.split(": ", 1)
        if key in {"release", "host", "commit-hash", "commit-date"} and SAFE_RE.fullmatch(value):
            version_fields[key.replace("-", "_")] = value
    cfg_lines = [line for line in cfg_raw.decode("utf-8", "replace").splitlines() if line]
    cfg = parse_cfg(cfg_raw)
    body: dict[str, Any] = {
        "schema": PROBE_SCHEMA,
        "status": "observed",
        "target": safe(args.target),
        "rustc_sha256": digest(compiler_bytes),
        "version_sha256": digest(version_raw),
        "cfg_sha256": digest(cfg_raw),
        "cfg_count": len(cfg_lines),
        "cfg": cfg,
        "version": version_fields,
        "environment": env_summary(),
    }
    body["identity"] = digest(canonical(body))
    write_exclusive(Path(args.output), body, MAX_INPUT_BYTES)


def identity_file(path: Path, *, label: str) -> dict[str, str]:
    raw = read_regular(path, MAX_INPUT_BYTES)
    parsed = strict_json(raw)
    if not isinstance(parsed, Mapping):
        fail(f"{label}_SCHEMA")
    return {"identity": digest(raw), "kind": label}


def validate_self_identity(value: Any, *, label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping) or not IDENTITY_RE.fullmatch(str(value.get("identity", ""))):
        fail(f"{label}_SCHEMA")
    body = dict(value)
    identity = str(body.pop("identity"))
    if digest(canonical(body)) != identity:
        fail(f"{label}_IDENTITY")
    return body


def validate_commit_pair(value: Any, *, label: str) -> dict[str, str]:
    if not isinstance(value, Mapping):
        fail(f"{label}_PAIR")
    commit = str(value.get("commit", ""))
    tree = str(value.get("tree", ""))
    if not COMMIT_RE.fullmatch(commit) or not COMMIT_RE.fullmatch(tree):
        fail(f"{label}_PAIR")
    return {"commit": commit, "tree": tree}


def metadata(args: argparse.Namespace) -> None:
    source_raw = read_regular(Path(args.source_origin), MAX_INPUT_BYTES)
    source_value = strict_json(source_raw)
    source_identity = str(source_value.get("identity", "")) if isinstance(source_value, Mapping) else ""
    source = validate_self_identity(source_value, label="SOURCE_ORIGIN")
    probe_raw = read_regular(Path(args.probe), MAX_INPUT_BYTES)
    probe_value = strict_json(probe_raw)
    probe_identity = str(probe_value.get("identity", "")) if isinstance(probe_value, Mapping) else ""
    probe = validate_self_identity(probe_value, label="PROBE")
    if probe.get("schema") != PROBE_SCHEMA or probe.get("status") != "observed":
        fail("PROBE_SCHEMA")
    if not COMMIT_RE.fullmatch(args.product_commit) or not COMMIT_RE.fullmatch(args.product_tree):
        fail("PRODUCT_IDENTITY")
    if not COMMIT_RE.fullmatch(args.producer_commit) or not COMMIT_RE.fullmatch(args.producer_tree):
        fail("PRODUCER_IDENTITY")
    if not SAFE_RE.fullmatch(args.platform) or not SAFE_RE.fullmatch(args.triple):
        fail("TARGET_IDENTITY")
    source_pair = validate_commit_pair(source.get("source"), label="SOURCE_ORIGIN_SOURCE")
    producer_pair = validate_commit_pair(source.get("producer"), label="SOURCE_ORIGIN_PRODUCER")
    runtime = source.get("runtime")
    if not isinstance(runtime, Mapping) or runtime.get("target") != args.triple:
        fail("SOURCE_ORIGIN_TARGET_MISMATCH")
    if source_pair != {"commit": args.product_commit, "tree": args.product_tree}:
        fail("SOURCE_PRODUCT_MISMATCH")
    if producer_pair != {"commit": args.producer_commit, "tree": args.producer_tree}:
        fail("SOURCE_PRODUCER_MISMATCH")
    if probe.get("target") != args.triple:
        fail("PROBE_TARGET_MISMATCH")
    product = {"commit": args.product_commit, "tree": args.product_tree}
    producer = {"commit": args.producer_commit, "tree": args.producer_tree}
    target = {"platform": args.platform, "triple": args.triple}
    body: dict[str, Any] = {
        "schema": METADATA_SCHEMA,
        "status": "observed",
        "source": {"identity": source_identity, "kind": "source-origin"},
        "product": {"identity": digest(canonical(product)), "kind": "product-source", "commit": args.product_commit, "tree": args.product_tree},
        "producer": {"identity": digest(canonical(producer)), "kind": "producer-source", "commit": args.producer_commit, "tree": args.producer_tree},
        "target": {"identity": digest(canonical(target)), "kind": "target", "platform": args.platform, "triple": args.triple},
        "build": identity_file(Path(args.build_receipt), label="build-receipt"),
        "payload": identity_file(Path(args.package_record), label="package-record"),
        "elf": identity_file(Path(args.qualification), label="qualification-file-binding"),
        "compiler_probe": {"identity": probe_identity, "kind": "rustc-probe"},
    }
    body["identity"] = digest(canonical(body))
    write_exclusive(Path(args.output), body, MAX_INPUT_BYTES)


def parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    p_probe = sub.add_parser("probe")
    p_probe.add_argument("--rustc", required=True)
    p_probe.add_argument("--target", required=True)
    p_probe.add_argument("--output", required=True)
    p_metadata = sub.add_parser("metadata")
    p_metadata.add_argument("--source-origin", required=True)
    p_metadata.add_argument("--build-receipt", required=True)
    p_metadata.add_argument("--package-record", required=True)
    p_metadata.add_argument("--qualification", required=True)
    p_metadata.add_argument("--probe", required=True)
    p_metadata.add_argument("--product-commit", required=True)
    p_metadata.add_argument("--product-tree", required=True)
    p_metadata.add_argument("--producer-commit", required=True)
    p_metadata.add_argument("--producer-tree", required=True)
    p_metadata.add_argument("--platform", required=True)
    p_metadata.add_argument("--triple", required=True)
    p_metadata.add_argument("--output", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = parser().parse_args(argv)
        if args.operation == "probe":
            probe(args)
        else:
            metadata(args)
        return 0
    except MetadataError as exc:
        print(exc.code, file=os.sys.stderr)
        return 1
    except (OSError, ValueError):
        print("NEBULAR_RUST_METADATA_FAILURE", file=os.sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

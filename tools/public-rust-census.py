#!/usr/bin/env python3
"""Bounded observational RUSTC_WRAPPER for public Nebular builds.

Cargo invokes a Rust wrapper as ``wrapper rustc [rustc args...]``.  The exec
path below records a sanitized observation before replacing the wrapper with
the requested compiler.  It never starts a second compiler process, changes
the argv/environment, or makes an ISA admission claim.  The ``aggregate``
mode seals a fresh session's records to caller-supplied identity metadata.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import sys
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any


RECORD_SCHEMA = "rs9.nebular070-public-rust-census-record.v1"
AGGREGATE_SCHEMA = "rs9.nebular070-public-rust-census.v1"
METADATA_SCHEMA = "rs9.nebular070-public-rust-census-metadata.v1"
SESSION_ENV = "NEBULAR_RUST_CENSUS_SESSION"
CENSUS_DIR_ENV = "NEBULAR_RUSTC_CENSUS_DIR"

MAX_RECORD_BYTES = 64 * 1024
MAX_METADATA_BYTES = 256 * 1024
MAX_AGGREGATE_BYTES = 2 * 1024 * 1024
MAX_RECORD_MEMBERS = 4096
MAX_ARG_COUNT = 512
MAX_ARG_BYTES = 32 * 1024
MAX_VALUE_BYTES = 512

IDENTITY_RE = re.compile(r"^[0-9a-f]{64}$")
SESSION_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
SAFE_VALUE_RE = re.compile(r"^[A-Za-z0-9_.:+,=@%\-]{1,128}$")
SAFE_KEY_RE = re.compile(r"^[A-Za-z0-9_.:+%\-]{1,96}$")

METADATA_BINDINGS = (
    "source",
    "product",
    "producer",
    "target",
    "build",
    "payload",
    "elf",
)
CODEGEN_KEYS = frozenset(
    {
        "codegen-units",
        "debuginfo",
        "debug-assertions",
        "incremental",
        "linker",
        "linker-plugin-lto",
        "link-arg",
        "link-self-contained",
        "lto",
        "opt-level",
        "overflow-checks",
        "panic",
        "passes",
        "relocation-model",
        "soft-float",
        "strip",
    }
)


class CensusError(Exception):
    """A sanitized, non-path-bearing failure."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _fail(code: str) -> None:
    raise CensusError(f"NEBULAR_RUST_{code}")


def _canonical(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError):
        _fail("JSON_ENCODING")
    raise AssertionError("unreachable")


def _digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _reject_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    _fail("NONFINITE_JSON")


def _strict_json(raw: bytes) -> Any:
    if len(raw) > MAX_AGGREGATE_BYTES:
        _fail("JSON_TOO_LARGE")
    try:
        return json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_pairs,
            parse_constant=_reject_constant,
        )
    except CensusError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError):
        _fail("MALFORMED_JSON")
    raise AssertionError("unreachable")


def _no_symlink_chain(path: Path) -> None:
    try:
        items = (path, *path.parents)
        if any(item.is_symlink() for item in items):
            _fail("SYMLINK")
    except OSError:
        _fail("PATH")


def _owned_directory_from_env() -> Path:
    raw = os.environ.get(CENSUS_DIR_ENV, "")
    if not raw:
        _fail("CENSUS_DIR_REQUIRED")
    path = Path(raw)
    if not path.is_absolute():
        _fail("CENSUS_DIR_ABSOLUTE")
    _no_symlink_chain(path)
    try:
        info = path.stat()
    except OSError:
        _fail("CENSUS_DIR_UNAVAILABLE")
    if not stat.S_ISDIR(info.st_mode):
        _fail("CENSUS_DIR_NOT_DIRECTORY")
    if info.st_uid != os.getuid():
        _fail("CENSUS_DIR_OWNER")
    if info.st_mode & 0o077:
        _fail("CENSUS_DIR_PERMISSIONS")
    return path


def _read_regular(path: Path, limit: int, code: str) -> bytes:
    _no_symlink_chain(path)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError:
        _fail(code)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size < 0 or before.st_size > limit:
            _fail(code)
        chunks: list[bytes] = []
        remaining = before.st_size
        while remaining:
            chunk = os.read(fd, min(remaining, 64 * 1024))
            if not chunk:
                _fail(code)
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(fd)
        if (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        ) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            _fail("INPUT_CHANGED")
        return b"".join(chunks)
    finally:
        os.close(fd)


def _session() -> str | None:
    value = os.environ.get(SESSION_ENV, "")
    if not value:
        return None
    if not SESSION_RE.fullmatch(value):
        _fail("SESSION")
    return value


def _safe_value(value: Any, *, key: str = "") -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-8", "replace")) > MAX_VALUE_BYTES:
        return "<redacted>"
    lower = value.lower()
    if any(marker in lower for marker in ("secret", "token", "password", "credential", "api_key", "apikey")):
        return "<redacted>"
    if any(marker in value for marker in ("/", "\\", "\x00", "\n", "\r", "\t", "$", "~")):
        return "<redacted>"
    pattern = SAFE_KEY_RE if key in {"key", "flag"} else SAFE_VALUE_RE
    if not pattern.fullmatch(value):
        return "<redacted>"
    return value


def _append(mapping: dict[str, list[str]], key: str, value: Any) -> None:
    mapping.setdefault(key, []).append(_safe_value(value, key=key))


def _codegen_flag(raw: str, codegen: dict[str, list[str]], cpu: dict[str, list[str]], feature: dict[str, list[str]], llvm: list[str], unknown: list[dict[str, str]]) -> None:
    if "=" in raw:
        key, value = raw.split("=", 1)
    else:
        key, value = raw, ""
    safe_key = _safe_value(key, key="key")
    if safe_key == "<redacted>":
        unknown.append({"key": "<redacted>", "value": "<redacted>"})
        return
    if key == "target-cpu":
        _append(cpu, key, value)
    elif key == "target-feature":
        _append(feature, key, value)
    elif key == "llvm-args" or key.startswith("llvm-"):
        llvm.append(_safe_value(value, key=key))
    elif key in CODEGEN_KEYS:
        _append(codegen, key, value)
    else:
        unknown.append({"key": safe_key, "value": _safe_value(value, key=key)})


def _invocation_record(argv: Sequence[str]) -> dict[str, Any]:
    if len(argv) < 2:
        _fail("WRAPPER_ARGV")
    if len(argv) > MAX_ARG_COUNT:
        _fail("ARGV_TOO_LARGE")
    if any(not isinstance(item, str) for item in argv):
        _fail("ARGV_TYPE")
    compiler_argv = list(argv[1:])
    full_bytes = _canonical(compiler_argv)
    if len(full_bytes) > MAX_ARG_BYTES:
        _fail("ARGV_BYTES")
    compiler = compiler_argv[0]
    compiler_name = _safe_value(Path(compiler).name, key="value")
    crate_name: str | None = None
    target: str | None = None
    codegen: dict[str, list[str]] = {}
    cpu: dict[str, list[str]] = {}
    feature: dict[str, list[str]] = {}
    llvm: list[str] = []
    unknown: list[dict[str, str]] = []
    i = 1
    while i < len(compiler_argv):
        token = compiler_argv[i]
        if token == "--crate-name" and i + 1 < len(compiler_argv):
            crate_name = _safe_value(compiler_argv[i + 1])
            i += 2
            continue
        if token.startswith("--crate-name="):
            crate_name = _safe_value(token.split("=", 1)[1])
            i += 1
            continue
        if token == "--target" and i + 1 < len(compiler_argv):
            target = _safe_value(compiler_argv[i + 1])
            i += 2
            continue
        if token.startswith("--target="):
            target = _safe_value(token.split("=", 1)[1])
            i += 1
            continue
        raw: str | None = None
        if token in ("-C", "--codegen"):
            if i + 1 < len(compiler_argv):
                raw = compiler_argv[i + 1]
                i += 2
            else:
                unknown.append({"key": _safe_value(token, key="flag"), "value": "<missing>"})
                i += 1
        elif token.startswith("-C") and len(token) > 2:
            raw = token[2:]
            i += 1
        elif token.startswith("--codegen="):
            raw = token.split("=", 1)[1]
            i += 1
        elif token == "-Z" and i + 1 < len(compiler_argv):
            unknown.append({"key": "-Z", "value": _safe_value(compiler_argv[i + 1])})
            i += 2
        elif token.startswith("-Z"):
            unknown.append({"key": "-Z", "value": _safe_value(token[2:])})
            i += 1
        else:
            i += 1
        if raw is not None:
            _codegen_flag(raw, codegen, cpu, feature, llvm, unknown)
    return {
        "schema": RECORD_SCHEMA,
        "complete": True,
        "mode": "rustc-wrapper-exec",
        "session": _session(),
        "compiler": compiler_name,
        "crate_name": crate_name,
        "target": target,
        "codegen": {key: values for key, values in sorted(codegen.items())},
        "cpu_overrides": {key: values for key, values in sorted(cpu.items())},
        "feature_overrides": {key: values for key, values in sorted(feature.items())},
        "llvm_overrides": llvm,
        "unknown_overrides": unknown,
        "argv_count": len(compiler_argv),
        "full_argv_sha256": _digest(full_bytes),
    }


def _write_atomic_json(
    directory: Path,
    stem: str,
    value: Mapping[str, Any],
    limit: int,
    *,
    final_name: str | None = None,
) -> Path:
    raw = _canonical(value)
    if len(raw) > limit:
        _fail("OUTPUT_TOO_LARGE")
    _no_symlink_chain(directory)
    try:
        fd, temp_name = tempfile.mkstemp(prefix=f".{stem}-", suffix=".tmp", dir=directory)
        os.fchmod(fd, 0o600)
        try:
            offset = 0
            while offset < len(raw):
                offset += os.write(fd, raw[offset:])
            os.fsync(fd)
        finally:
            os.close(fd)
        temp_path = Path(temp_name)
        final = (
            directory / final_name
            if final_name is not None
            else directory / f"{stem}-{temp_path.name[1:-4]}.json"
        )
        if final_name is not None and final.name != final_name:
            _fail("OUTPUT_NAME")
        if final.exists() or final.is_symlink():
            _fail("OUTPUT_COLLISION")
        os.replace(temp_path, final)
        try:
            dir_fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            _fail("OUTPUT_SYNC")
        return final
    except CensusError:
        try:
            Path(temp_name).unlink()
        except (OSError, UnboundLocalError):
            pass
        raise
    except OSError:
        try:
            Path(temp_name).unlink()
        except (OSError, UnboundLocalError):
            pass
        _fail("OUTPUT_WRITE")
    raise AssertionError("unreachable")


def _record_exec(argv: Sequence[str]) -> None:
    directory = _owned_directory_from_env()
    record = _invocation_record(argv)
    _write_atomic_json(directory, "record", record, MAX_RECORD_BYTES)
    compiler_argv = list(argv[1:])
    compiler = compiler_argv[0]
    env = os.environ.copy()
    if os.path.sep in compiler:
        os.execve(compiler, compiler_argv, env)
    os.execvpe(compiler, compiler_argv, env)


def _identity(value: Any) -> str:
    if not isinstance(value, Mapping) or not IDENTITY_RE.fullmatch(str(value.get("identity", ""))):
        _fail("METADATA_IDENTITY")
    return str(value["identity"])


def _validate_metadata(metadata: Any) -> dict[str, str]:
    if not isinstance(metadata, Mapping) or metadata.get("schema") != METADATA_SCHEMA:
        _fail("METADATA_SCHEMA")
    result: dict[str, str] = {}
    for key in METADATA_BINDINGS:
        if key not in metadata:
            _fail("METADATA_BINDING")
        result[key] = _identity(metadata[key])
    return result


def _validate_record(record: Any) -> None:
    required = {
        "schema",
        "complete",
        "mode",
        "session",
        "compiler",
        "crate_name",
        "target",
        "codegen",
        "cpu_overrides",
        "feature_overrides",
        "llvm_overrides",
        "unknown_overrides",
        "argv_count",
        "full_argv_sha256",
    }
    if not isinstance(record, Mapping) or not required <= set(record):
        _fail("RECORD_SCHEMA")
    if (
        record["schema"] != RECORD_SCHEMA
        or record["complete"] is not True
        or record["mode"] != "rustc-wrapper-exec"
        or not isinstance(record["session"], str)
        or not SESSION_RE.fullmatch(record["session"])
        or not IDENTITY_RE.fullmatch(str(record["full_argv_sha256"]))
        or not isinstance(record["argv_count"], int)
        or record["argv_count"] < 1
        or record["argv_count"] > MAX_ARG_COUNT
    ):
        _fail("RECORD_SCHEMA")


def _load_session_records(directory: Path, session: str) -> list[tuple[str, dict[str, Any], str]]:
    _no_symlink_chain(directory)
    try:
        members = sorted(
            entry
            for entry in directory.iterdir()
            if entry.name.startswith("record-") and entry.name.endswith(".json")
        )
    except OSError:
        _fail("CENSUS_DIR_READ")
    if len(members) > MAX_RECORD_MEMBERS:
        _fail("RECORD_MEMBERS")
    selected: list[tuple[str, dict[str, Any], str]] = []
    for entry in members:
        raw = _read_regular(entry, MAX_RECORD_BYTES, "RECORD_READ")
        parsed = _strict_json(raw)
        if not isinstance(parsed, Mapping) or parsed.get("session") != session:
            continue
        _validate_record(parsed)
        selected.append((entry.name, dict(parsed), _digest(raw)))
    if not selected:
        _fail("NO_FRESH_RECORDS")
    return selected


def _aggregate(argv: Sequence[str]) -> int:
    if len(argv) < 2:
        _fail("AGGREGATE_ARGS")
    args: dict[str, str] = {}
    i = 1
    while i < len(argv):
        token = argv[i]
        if token not in ("--records", "--metadata", "--session", "--output") or i + 1 >= len(argv):
            _fail("AGGREGATE_ARGS")
        args[token[2:]] = argv[i + 1]
        i += 2
    if set(args) != {"records", "metadata", "session", "output"}:
        _fail("AGGREGATE_ARGS")
    session = args["session"]
    if not SESSION_RE.fullmatch(session):
        _fail("SESSION")
    records_dir = Path(args["records"])
    owned = _owned_directory_from_env()  # Require the same owned census root for sealing.
    _no_symlink_chain(records_dir)
    if records_dir.resolve() != owned.resolve():
        _fail("CENSUS_DIR_MISMATCH")
    metadata_raw = _read_regular(Path(args["metadata"]), MAX_METADATA_BYTES, "METADATA_READ")
    metadata = _strict_json(metadata_raw)
    bindings = _validate_metadata(metadata)
    records = _load_session_records(records_dir, session)
    summaries = [
        {
            "member": name,
            "record_sha256": record_sha,
            "full_argv_sha256": record["full_argv_sha256"],
            "compiler": record["compiler"],
            "crate_name": record["crate_name"],
            "target": record["target"],
            "codegen": record["codegen"],
            "cpu_overrides": record["cpu_overrides"],
            "feature_overrides": record["feature_overrides"],
            "llvm_overrides": record["llvm_overrides"],
            "unknown_overrides": record["unknown_overrides"],
        }
        for name, record, record_sha in records
    ]
    summaries.sort(key=lambda item: item["member"])
    body: dict[str, Any] = {
        "schema": AGGREGATE_SCHEMA,
        "status": "observed",
        "evidence_mode": "compiler-invocation-observation",
        "admission": "not-claimed",
        "session": session,
        "metadata_sha256": _digest(metadata_raw),
        "bindings": bindings,
        "record_count": len(summaries),
        "record_set_sha256": _digest(_canonical(summaries)),
        "records": summaries,
    }
    body["identity"] = _digest(_canonical(body))
    output = Path(args["output"])
    _no_symlink_chain(output)
    if output.exists():
        _fail("OUTPUT_EXISTS")
    parent = output.parent
    if not parent.is_dir():
        _fail("OUTPUT_PARENT")
    _write_atomic_json(
        parent,
        output.stem,
        body,
        MAX_AGGREGATE_BYTES,
        final_name=output.name,
    )
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    values = list(sys.argv if argv is None else argv)
    try:
        if len(values) >= 2 and values[1] == "aggregate":
            return _aggregate(values[1:])
        _record_exec(values)
    except CensusError as exc:
        print(exc.code, file=sys.stderr)
        return 1
    except (OSError, ValueError):
        print("NEBULAR_RUST_CENSUS_FAILURE", file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

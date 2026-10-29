#!/usr/bin/env python3
"""Safely materialize one canonical runtime-only input archive.

All archive headers and the embedded manifest are validated while the archive
is held open, before extraction.  Extraction is ordered directories, regular
files, then symlinks so no archive link can become an ancestor of another
member.  The maintained JavaScript runtime validator is invoked only after
the closed source snapshot has been materialized.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import posixpath
import stat
import subprocess
import sys
import gzip
import tarfile
from pathlib import Path, PurePosixPath


HEX64 = set("0123456789abcdef")
MAX_ARCHIVE_BYTES = 2 << 30
MAX_MANIFEST_BYTES = 16 << 20
MAX_MEMBERS = 2048
MAX_REGULARS = 512
MAX_ALIASES = 512
MAX_DIRECTORIES = 512
MAX_UNCOMPRESSED_BYTES = 1 << 30
MAX_FILE_BYTES = 512 << 20
PROTECTED = {"db", "raw", ".serena"}


class ContractError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise ContractError(message)


def valid_sha(value: str, label: str) -> str:
    if len(value) != 64 or any(char not in HEX64 for char in value):
        fail(f"{label} must be lowercase 64-hex")
    return value


def safe_name(value: object, label: str, allow_manifest: bool = False) -> str:
    if not isinstance(value, str) or not value or value.endswith("/"):
        fail(f"{label} is not a canonical relative member name")
    if value.startswith("/") or "\\" in value:
        fail(f"{label} is absolute or uses a backslash")
    parts = value.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        fail(f"{label} contains an unsafe path component")
    if any(part.lower() in PROTECTED for part in parts):
        fail(f"{label} contains a protected component")
    if any(part.startswith("._") or part == ".DS_Store" for part in parts):
        fail(f"{label} contains an AppleDouble/metadata member")
    if allow_manifest and value == "native-runtime.json":
        return value
    if value == "opt" or value == "opt/nebular-private" or value.startswith("opt/nebular-private/"):
        return value
    fail(f"{label} is outside the closed runtime prefix")


def stat_frame(value: os.stat_result) -> tuple[int, ...]:
    return (value.st_dev, value.st_ino, value.st_mode, value.st_nlink, value.st_uid, value.st_gid, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def stable_dir_identity(frame: tuple[int, ...]) -> tuple[int, ...]:
    return (frame[0], frame[1], frame[2], frame[4], frame[5])


def hash_held_regular(path: Path, expected_bytes: int | None, expected_sha256: str) -> tuple[int, str, int, tuple[int, ...]]:
    valid_sha(expected_sha256, "expected archive SHA-256")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        fail(f"cannot hold archive without following a link: {exc}")
    try:
        before = os.fstat(fd)
        before_frame = stat_frame(before)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_mode & 0o7000:
            fail("archive is not an unprivileged regular file")
        if expected_bytes is not None and before.st_size != expected_bytes:
            fail("archive size does not match the externally bound size")
        if before.st_size > MAX_ARCHIVE_BYTES:
            fail("archive size exceeds bound")
        digest = hashlib.sha256()
        total = 0
        with os.fdopen(os.dup(fd), "rb", closefd=True) as stream:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                digest.update(chunk)
        after_frame = stat_frame(os.fstat(fd))
        actual = digest.hexdigest()
        if ((expected_bytes is not None and total != expected_bytes)
                or after_frame != before_frame
                or actual != expected_sha256):
            fail("archive bytes changed or do not match the external SHA-256")
        os.lseek(fd, 0, os.SEEK_SET)
        return fd, actual, before.st_size, before_frame
    except Exception:
        os.close(fd)
        raise


def verify_held_archive_identity(fd: int, before_frame: tuple[int, ...], expected_bytes: int, expected_sha256: str) -> None:
    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    total = 0
    with os.fdopen(os.dup(fd), "rb", closefd=True) as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            digest.update(chunk)
    after_frame = stat_frame(os.fstat(fd))
    if total != expected_bytes or after_frame != before_frame or digest.hexdigest() != expected_sha256:
        fail("held archive changed during preflight/extraction")


def read_exact(stream, count: int, label: str) -> bytes:
    body = bytearray()
    while len(body) < count:
        chunk = stream.read(min(1024 * 1024, count - len(body)))
        if not chunk:
            fail(f"truncated archive while reading {label}")
        body.extend(chunk)
    return bytes(body)


def parse_tar_number(raw: bytes, label: str) -> int:
    value = raw.rstrip(b"\0 ").lstrip(b" ")
    if not value:
        return 0
    if any(byte < ord("0") or byte > ord("7") for byte in value):
        fail(f"invalid tar octal field: {label}")
    return int(value, 8)


def preflight_archive_headers(fd: int, target: str) -> tuple[list[str], bytes]:
    os.lseek(fd, 0, os.SEEK_SET)
    names: list[str] = []
    manifest_body: bytes | None = None
    regular_bytes = 0
    with gzip.GzipFile(fileobj=os.fdopen(os.dup(fd), "rb", closefd=True), mode="rb") as stream:
        zero_blocks = 0
        end_marker_seen = False
        while True:
            header = stream.read(512)
            if end_marker_seen:
                if not header:
                    break
                if any(header):
                    fail("nonzero bytes remain after canonical tar end marker")
                continue
            if len(header) != 512:
                fail("truncated tar header before end marker")
            if header == b"\0" * 512:
                zero_blocks += 1
                if zero_blocks == 2:
                    end_marker_seen = True
                continue
            if zero_blocks:
                fail("nonzero tar header follows an incomplete end marker")
            zero_blocks = 0
            magic = header[257:265]
            if magic not in {b"ustar\x0000", b"ustar  \x00"}:
                fail("unsupported tar header format")
            if any(header[386:482]) or header[482:483] != b"\0":
                fail("GNU sparse metadata is rejected before tarfile parsing")
            checksum_bytes = header[148:156]
            expected_checksum = parse_tar_number(checksum_bytes, "checksum")
            check_header = bytearray(header)
            check_header[148:156] = b"        "
            if sum(check_header) != expected_checksum:
                fail("tar header checksum mismatch")
            typeflag = header[156:157]
            if typeflag in {b"x", b"g", b"L", b"K"}:
                fail("PAX or GNU long-name metadata is rejected before tarfile parsing")
            if typeflag not in {b"\0", b"0", b"5", b"2"}:
                fail("tar special/hardlink/device/FIFO type is rejected before extraction")
            name_bytes = header[0:100].split(b"\0", 1)[0]
            prefix_bytes = header[345:500].split(b"\0", 1)[0]
            try:
                name = (prefix_bytes + (b"/" if prefix_bytes else b"") + name_bytes).decode("utf-8")
            except UnicodeDecodeError:
                fail("tar member name is not UTF-8")
            if typeflag == b"5":
                name = name.rstrip("/")
            name = safe_name(name, "raw tar member name", allow_manifest=True)
            if name in names:
                fail(f"duplicate raw tar member: {name}")
            names.append(name)
            if len(names) > MAX_MEMBERS:
                fail("archive member quota exceeded before tarfile parsing")
            mode = parse_tar_number(header[100:108], f"{name} mode")
            uid = parse_tar_number(header[108:116], f"{name} uid")
            gid = parse_tar_number(header[116:124], f"{name} gid")
            mtime = parse_tar_number(header[136:148], f"{name} mtime")
            size = parse_tar_number(header[124:136], f"{name} size")
            if uid != 0 or gid != 0 or mtime != 0 or mode & 0o7000:
                fail(f"non-canonical tar metadata: {name}")
            if typeflag == b"5":
                if size != 0:
                    fail(f"directory has a body: {name}")
            elif typeflag == b"2":
                if size != 0:
                    fail(f"symlink has a body: {name}")
            else:
                if size > MAX_MANIFEST_BYTES if name == "native-runtime.json" else size > MAX_FILE_BYTES:
                    fail(f"regular member exceeds bound: {name}")
                regular_bytes += size
                if regular_bytes > MAX_UNCOMPRESSED_BYTES:
                    fail("archive regular-byte quota exceeded before body allocation")
            linkname = header[157:257].split(b"\0", 1)[0]
            if typeflag == b"2":
                try:
                    target_name = linkname.decode("utf-8")
                except UnicodeDecodeError:
                    fail(f"symlink target is not UTF-8: {name}")
                if not target_name or target_name.startswith("/") or "\\" in target_name:
                    fail(f"symlink target is unsafe: {name}")
            blocks = (size + 511) // 512
            if name == "native-runtime.json":
                manifest_body = read_exact(stream, size, name)
            else:
                remaining = size
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        fail(f"truncated tar member body: {name}")
                    remaining -= len(chunk)
            padding = blocks * 512 - size
            if padding:
                read_exact(stream, padding, f"{name} padding")
    if manifest_body is None:
        fail("native-runtime.json was not found during raw preflight")
    if not names or names[-1] != "native-runtime.json":
        fail("canonical manifest member must terminate the member list")
    return names, manifest_body


def read_manifest_from_archive(tar: tarfile.TarFile, member: tarfile.TarInfo) -> tuple[dict, bytes, str]:
    if not member.isreg() or member.size > MAX_MANIFEST_BYTES:
        fail("native-runtime.json is not a bounded regular member")
    stream = tar.extractfile(member)
    if stream is None:
        fail("native-runtime.json could not be read")
    body = stream.read(MAX_MANIFEST_BYTES + 1)
    if len(body) != member.size or len(body) > MAX_MANIFEST_BYTES:
        fail("native-runtime.json size changed or exceeds bound")
    digest = hashlib.sha256(body).hexdigest()
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"native-runtime.json is not strict JSON: {exc}")
    return value, body, digest


def manifest_rows(manifest: dict, target: str) -> tuple[dict[str, dict], list[str], int]:
    if manifest.get("schema") != "nebular-native-runtime-material-v1" or manifest.get("target") != target:
        fail("runtime manifest schema/target mismatch")
    material = manifest.get("materialDigest")
    valid_sha(str(material), "manifest materialDigest")
    rows: dict[str, dict] = {}
    for kind in ("directories", "regulars", "aliases"):
        entries = manifest.get(kind)
        if not isinstance(entries, list):
            fail(f"manifest {kind} is not a list")
        limit = {"directories": MAX_DIRECTORIES, "regulars": MAX_REGULARS, "aliases": MAX_ALIASES}[kind]
        if len(entries) > limit:
            fail(f"manifest {kind} exceeds quota")
        for raw in entries:
            if not isinstance(raw, dict):
                fail(f"manifest {kind} contains a non-object row")
            row = dict(raw)
            path = safe_name(row.get("path"), f"manifest {kind} path")
            if path in rows:
                fail(f"duplicate manifest path: {path}")
            row["kind"] = kind
            rows[path] = row
    if rows.get("opt/nebular-private", {}).get("kind") != "directories":
        fail("manifest lacks opt/nebular-private directory")
    expected_dirs = {"opt", *[p for p, row in rows.items() if row["kind"] == "directories"]}
    expected_regulars = {p for p, row in rows.items() if row["kind"] == "regulars"}
    expected_aliases = {p for p, row in rows.items() if row["kind"] == "aliases"}
    names = ["opt", *sorted(expected_dirs - {"opt"}, key=lambda p: (p.count("/"), p)), *sorted(expected_regulars), *sorted(expected_aliases), "native-runtime.json"]
    if len(names) > MAX_MEMBERS or len(names) != len(set(names)):
        fail("manifest member quota or duplicate failure")
    regular_bytes = 0
    for path in expected_regulars:
        value = rows[path].get("bytes")
        if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > MAX_FILE_BYTES:
            fail(f"invalid regular byte count: {path}")
        regular_bytes += value
    if regular_bytes > MAX_UNCOMPRESSED_BYTES:
        fail("manifest regular byte quota exceeded")
    return rows, names, regular_bytes


def member_kind(info: tarfile.TarInfo) -> str:
    if info.isreg():
        if getattr(info, "sparse", None):
            fail(f"sparse regular member is not allowed: {info.name}")
        return "regulars"
    if info.isdir():
        return "directories"
    if info.issym():
        return "aliases"
    fail(f"hardlink/device/FIFO/unknown member type is not allowed: {info.name}")


def validate_archive_headers(tar: tarfile.TarFile, target: str, expected_manifest_sha256: str, expected_material_digest: str, expected_member_list_sha256: str) -> tuple[dict, bytes, list[tarfile.TarInfo], list[str], int]:
    valid_sha(expected_manifest_sha256, "expected manifest SHA-256")
    valid_sha(expected_material_digest, "expected material digest")
    valid_sha(expected_member_list_sha256, "expected member-list SHA-256")
    members = tar.getmembers()
    if not members or len(members) > MAX_MEMBERS:
        fail("archive member quota failure")
    names: list[str] = []
    by_name: dict[str, tarfile.TarInfo] = {}
    for info in members:
        name = safe_name(info.name.rstrip("/"), "archive member name", allow_manifest=True)
        if name in by_name:
            fail(f"duplicate archive member after normalization: {name}")
        if info.pax_headers:
            fail(f"PAX/xattr metadata is not allowed: {name}")
        if info.uid != 0 or info.gid != 0 or info.uname or info.gname or info.mtime != 0 or info.mode & 0o7000:
            fail(f"non-canonical archive metadata: {name}")
        names.append(name)
        by_name[name] = info
    manifest_info = by_name.get("native-runtime.json")
    if manifest_info is None:
        fail("archive lacks native-runtime.json")
    manifest, manifest_bytes, manifest_sha256 = read_manifest_from_archive(tar, manifest_info)
    if manifest_sha256 != expected_manifest_sha256:
        fail("embedded manifest SHA-256 does not match the external binding")
    if manifest.get("materialDigest") != expected_material_digest:
        fail("embedded material digest does not match the external binding")
    rows, expected_names, regular_bytes = manifest_rows(manifest, target)
    if names != expected_names:
        fail("archive member list does not exactly match the authenticated manifest")
    listed = "\n".join(names) + "\n"
    member_list_sha256 = hashlib.sha256(listed.encode()).hexdigest()
    if member_list_sha256 != expected_member_list_sha256:
        fail("archive member-list SHA-256 does not match the external binding")
    expected_dirs = {name for name in expected_names if name == "opt" or rows.get(name, {}).get("kind") == "directories"}
    expected_regulars = {name for name in expected_names if rows.get(name, {}).get("kind") == "regulars"}
    expected_aliases = {name for name in expected_names if rows.get(name, {}).get("kind") == "aliases"}
    for name in expected_names:
        info = by_name[name]
        kind = member_kind(info) if name != "native-runtime.json" else member_kind(info)
        expected_kind = "regulars" if name == "native-runtime.json" else "directories" if name == "opt" else rows.get(name, {}).get("kind")
        if kind != expected_kind:
            fail(f"archive type does not match manifest: {name}")
        if kind == "regulars":
            expected_size = len(manifest_bytes) if name == "native-runtime.json" else rows[name]["bytes"]
            if info.size != expected_size:
                fail(f"archive regular size does not match manifest: {name}")
        elif info.size != 0:
            fail(f"directory/symlink member has nonzero size: {name}")
        for parent in PurePosixPath(name).parents:
            parent_name = str(parent)
            if parent_name == ".":
                continue
            if parent_name not in expected_dirs or not by_name[parent_name].isdir():
                fail(f"member has a missing/non-directory ancestor: {name}")
    for name in expected_aliases:
        info = by_name[name]
        target = info.linkname
        row = rows[name]
        if not target or target.startswith("/") or "\\" in target:
            fail(f"alias target is unsafe: {name}")
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
        if resolved == "opt/nebular-private" or not resolved.startswith("opt/nebular-private/"):
            fail(f"alias target escapes runtime prefix: {name}")
        if resolved != posixpath.normpath(row.get("canonical", "")):
            # The canonical field is the final regular, while a valid alias can
            # point through another alias.  Resolve the chain below.
            pass
        current = resolved
        visited = {name}
        while current in expected_aliases:
            if current in visited:
                fail(f"alias cycle: {name}")
            visited.add(current)
            current = posixpath.normpath(posixpath.join(posixpath.dirname(current), by_name[current].linkname))
        if current != row.get("canonical") or current not in expected_regulars:
            fail(f"alias does not terminate at its canonical regular: {name}")
    if sum(info.size for name, info in by_name.items() if name in expected_regulars) != regular_bytes:
        fail("archive regular-byte total mismatch")
    return manifest, manifest_bytes, [by_name[name] for name in expected_names], expected_names, member_list_sha256


def no_symlink_ancestors(path: Path) -> None:
    current = path
    while True:
        info = os.lstat(current)
        if not stat.S_ISDIR(info.st_mode):
            fail(f"output parent is not a directory: {current}")
        if current.parent == current:
            break
        current = current.parent


def exclusive_bytes(path: Path, body: bytes, mode: int) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, mode)
    try:
        with os.fdopen(fd, "wb", closefd=True) as stream:
            stream.write(body)
            stream.flush()
            os.fchmod(stream.fileno(), mode)
    except Exception:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        raise


def open_output_directory(output: Path) -> tuple[int, int, tuple[int, ...]]:
    if output.name in {"", ".", ".."}:
        fail("output must be a direct child of a held parent directory")
    no_symlink_ancestors(output.parent)
    parent_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    parent_fd = os.open(output.parent, parent_flags)
    parent_before = stat_frame(os.fstat(parent_fd))
    try:
        if os.path.lexists(output):
            fail("output path must be fresh and non-symlink")
        os.mkdir(output.name, mode=0o700, dir_fd=parent_fd)
        parent_after = stat_frame(os.fstat(parent_fd))
        if stable_dir_identity(parent_after) != stable_dir_identity(parent_before):
            fail("held output parent identity changed during creation")
        output_fd = os.open(output.name, parent_flags, dir_fd=parent_fd)
        return parent_fd, output_fd, parent_before
    except Exception:
        os.close(parent_fd)
        raise


def assert_parent_stable(parent_fd: int, before: tuple[int, ...], parent_path: Path) -> None:
    after = stat_frame(os.fstat(parent_fd))
    try:
        path_after = stat_frame(os.lstat(parent_path))
    except FileNotFoundError:
        fail("output parent path disappeared during extraction")
    if stable_dir_identity(after) != stable_dir_identity(before) or stable_dir_identity(path_after) != stable_dir_identity(before):
        fail("output parent identity changed during extraction")


def extract_members(fd: int, expected_names: list[str], manifest_bytes: bytes, output: Path) -> Path:
    parent_fd, output_fd, parent_before = open_output_directory(output)
    source = output / "source"
    inputs = output / "input"
    try:
        assert_parent_stable(parent_fd, parent_before, output.parent)
        os.mkdir("source", mode=0o700, dir_fd=output_fd)
        os.mkdir("input", mode=0o700, dir_fd=output_fd)
        assert_parent_stable(parent_fd, parent_before, output.parent)
        os.lseek(fd, 0, os.SEEK_SET)
        with tarfile.open(fileobj=os.fdopen(os.dup(fd), "rb", closefd=True), mode="r:*") as tar:
            by_name = {info.name.rstrip("/"): info for info in tar.getmembers()}
            exclusive_bytes(source / "native-runtime.json", manifest_bytes, 0o644)
            dirs = [name for name in expected_names if name == "opt" or name.startswith("opt/nebular-private") and by_name[name].isdir()]
            for name in sorted(dirs, key=lambda item: (item.count("/"), item)):
                dest = source / Path(*name.split("/"))
                if dest.exists() or dest.is_symlink():
                    fail(f"duplicate extraction destination: {name}")
                dest.mkdir(mode=by_name[name].mode & 0o777)
                os.chmod(dest, by_name[name].mode & 0o777)
            assert_parent_stable(parent_fd, parent_before, output.parent)
            regulars = [name for name in expected_names if name != "native-runtime.json" and by_name[name].isreg()]
            for name in regulars:
                info = by_name[name]
                dest = source / Path(*name.split("/"))
                stream = tar.extractfile(info)
                if stream is None:
                    fail(f"regular member could not be extracted: {name}")
                fd_out = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), info.mode & 0o777)
                total = 0
                try:
                    with os.fdopen(fd_out, "wb", closefd=True) as out:
                        while True:
                            chunk = stream.read(1024 * 1024)
                            if not chunk:
                                break
                            total += len(chunk)
                            out.write(chunk)
                        out.flush()
                        os.fchmod(out.fileno(), info.mode & 0o777)
                except Exception:
                    try:
                        os.unlink(dest)
                    except FileNotFoundError:
                        pass
                    raise
                if total != info.size:
                    fail(f"regular member changed during extraction: {name}")
            assert_parent_stable(parent_fd, parent_before, output.parent)
            aliases = [name for name in expected_names if name != "native-runtime.json" and by_name[name].issym()]
            for name in aliases:
                info = by_name[name]
                dest = source / Path(*name.split("/"))
                if dest.exists() or dest.is_symlink():
                    fail(f"duplicate symlink destination: {name}")
                os.symlink(info.linkname, dest)
        assert_parent_stable(parent_fd, parent_before, output.parent)
        return source
    finally:
        os.close(output_fd)
        os.close(parent_fd)


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


def invoke_maintained_auth(node: Path, runtime_tool: Path, descriptor: Path, descriptor_sha256: str, target: str) -> None:
    script = """
import { pathToFileURL } from 'node:url';
const [tool, descriptor, descriptorSha, target] = process.argv.slice(1);
const runtime = await import(pathToFileURL(tool).href);
const authenticated = await runtime.authenticateNativeRuntimeInput(descriptor, descriptorSha, { expectedTarget: target });
await runtime.verifyRuntimeSourceSnapshot(authenticated);
"""
    result = subprocess.run(
        [str(node), "--input-type=module", "-e", script, str(runtime_tool), str(descriptor), descriptor_sha256, target],
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    if result.returncode != 0:
        raise ContractError(f"maintained runtime authentication failed with exit {result.returncode}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--expected-archive-bytes", required=True, type=int)
    parser.add_argument("--expected-archive-sha256", required=True)
    parser.add_argument("--expected-member-list-sha256", required=True)
    parser.add_argument("--expected-manifest-sha256", required=True)
    parser.add_argument("--expected-material-digest", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--node", required=True, type=Path)
    parser.add_argument("--runtime-tool", required=True, type=Path)
    parser.add_argument("--runtime-tool-sha256", required=True)
    parser.add_argument("--corresponding-source-sha256", required=True)
    parser.add_argument("--release-asset-sha256", required=True)
    args = parser.parse_args()
    if args.target not in {"aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"}:
        fail("unsupported target")
    valid_sha(args.expected_archive_sha256, "expected archive SHA-256")
    valid_sha(args.expected_member_list_sha256, "expected member-list SHA-256")
    valid_sha(args.expected_manifest_sha256, "expected manifest SHA-256")
    valid_sha(args.expected_material_digest, "expected material digest")
    valid_sha(args.runtime_tool_sha256, "runtime tool SHA-256")
    valid_sha(args.corresponding_source_sha256, "corresponding-source SHA-256")
    valid_sha(args.release_asset_sha256, "release asset SHA-256")
    tool_size, tool_sha, _, _ = hash_held_regular(args.runtime_tool, None, args.runtime_tool_sha256)
    del tool_size
    if tool_sha != args.runtime_tool_sha256:
        fail("runtime tool SHA mismatch")
    fd, archive_sha256, archive_bytes, archive_frame = hash_held_regular(args.archive, args.expected_archive_bytes, args.expected_archive_sha256)
    try:
        preflight_names, preflight_manifest_bytes = preflight_archive_headers(fd, args.target)
        os.lseek(fd, 0, os.SEEK_SET)
        with tarfile.open(fileobj=os.fdopen(os.dup(fd), "rb", closefd=True), mode="r:*") as tar:
            manifest, manifest_bytes, _members, expected_names, member_list_sha256 = validate_archive_headers(
                tar, args.target, args.expected_manifest_sha256, args.expected_material_digest, args.expected_member_list_sha256
            )
        if preflight_names != expected_names or preflight_manifest_bytes != manifest_bytes:
            fail("raw preflight and bounded tar metadata disagree")
        output_path = Path(os.path.abspath(os.fspath(args.output)))
        source_root = extract_members(fd, expected_names, manifest_bytes, output_path)
        input_dir = output_path / "input"
        descriptor = {
            "schema": "nebular-native-runtime-input-v1",
            "target": args.target,
            "sourceRoot": str(source_root),
            "material": manifest,
            "evidence": {
                "correspondingSourceCustody": args.corresponding_source_sha256,
                "releaseAsset": args.release_asset_sha256,
                "runtimeMaterialArchive": archive_sha256,
                "runtimeMaterialManifest": args.expected_manifest_sha256,
            },
        }
        descriptor_body = json_bytes(descriptor)
        descriptor_path = input_dir / "native-runtime-input.json"
        exclusive_bytes(descriptor_path, descriptor_body, 0o600)
        descriptor_sha256 = hashlib.sha256(descriptor_body).hexdigest()
        invoke_maintained_auth(args.node, args.runtime_tool, descriptor_path, descriptor_sha256, args.target)
        closed = {
            "schema": "nebular070-public-hosted-runtime-input-closed-manifest-v2",
            "target": args.target,
            "runtimePrefix": "opt/nebular-private",
            "archive": {"filename": args.archive.name, "bytes": archive_bytes, "sha256": archive_sha256, "expectedBytes": args.expected_archive_bytes, "expectedSha256": args.expected_archive_sha256, "memberCount": len(expected_names), "memberListSha256": member_list_sha256, "expectedMemberListSha256": args.expected_member_list_sha256, "paxHeadersRejected": True},
            "materialManifest": {"path": "source/native-runtime.json", "bytes": len(manifest_bytes), "sha256": args.expected_manifest_sha256, "materialDigest": manifest["materialDigest"]},
            "descriptor": {"path": "input/native-runtime-input.json", "bytes": len(descriptor_body), "sha256": descriptor_sha256},
            "sourceRootRelative": "source",
            "maintainedRuntimeToolSha256": args.runtime_tool_sha256,
            "authenticated": True,
            "productPayloadIncluded": False,
            "nativeExecution": False,
        }
        exclusive_bytes(output_path / "runtime-input-closed-manifest.json", json_bytes(closed), 0o600)
        verify_held_archive_identity(fd, archive_frame, archive_bytes, archive_sha256)
        receipt = {
            "schema": "nebular070-public-hosted-runtime-input-receipt-v2",
            "status": "runtime-only-input-authenticated",
            "target": args.target,
            "archive": {"filename": args.archive.name, "bytes": archive_bytes, "sha256": archive_sha256, "expectedBytesSha256Verified": True, "memberCount": len(expected_names), "memberListSha256": member_list_sha256, "paxHeadersRejected": True},
            "descriptor": {"path": "input/native-runtime-input.json", "bytes": len(descriptor_body), "sha256": descriptor_sha256},
            "material": {"path": "source/native-runtime.json", "bytes": len(manifest_bytes), "sha256": args.expected_manifest_sha256, "materialDigest": manifest["materialDigest"], "regulars": len(manifest["regulars"]), "aliases": len(manifest["aliases"]), "directories": len(manifest["directories"])},
            "evidence": descriptor["evidence"],
            "sourceRootRelative": "source",
            "maintainedRuntimeToolSha256": args.runtime_tool_sha256,
            "authentication": {"sourceSnapshotVerified": True, "privateGraphicsSourceVerified": True},
            "productPayloadIncluded": False,
            "nativeExecution": False,
            "buildOrQualificationClaim": False,
        }
        exclusive_bytes(output_path / "runtime-input-receipt.json", json_bytes(receipt), 0o600)
        print(json.dumps({"target": args.target, "archiveBytes": archive_bytes, "archiveSha256": archive_sha256, "memberListSha256": member_list_sha256, "descriptorSha256": descriptor_sha256, "materialDigest": manifest["materialDigest"]}, sort_keys=True))
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except ContractError as exc:
        raise SystemExit(f"contract-error: {exc}")


import { constants as headerFsConstants } from "node:fs";
import * as headerFs from "node:fs/promises";
import * as headerPath from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createChildProcessPort, prepareHostInputs, HostInputError, REQUIRED_REPOSITORY as HOST_REPOSITORY, TARGET as HOST_TARGET, createCargoConfig } from "./host-inputs.mjs";
import { prepareRustSource, validateAuthority as validateStageAuthority, TARGET as STAGE_TARGET } from "./source-stage.mjs";
import { createLinuxRustGroupPlan, evaluateLinuxRustGroups, TARGET as GROUP_TARGET } from "./rust-groups.mjs";








/* BEGIN VERIFIED NODE HEADER MATERIALIZER */
const nodeHeaderWorkflowAPI = (() => {
const constants = headerFsConstants;
const { chmod, lstat, mkdtemp, mkdir, open, readdir, realpath, rm, unlink } = headerFs;
const { basename, isAbsolute, join, relative, resolve } = headerPath;
const NODE_HEADER_SCHEMA = "nebular-verified-linux-node-headers-v1";
const NODE_VERSION = "22.23.4";
const NODE_TARGET = "aarch64-unknown-linux-gnu";
const NODE_ARCHIVE_NAME = "node-v22.23.4-linux-arm64.tar.xz";
const NODE_ARCHIVE_SHA256 = "6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b";
const NODE_HEADER_ROOT = "node-v22.23.4-linux-arm64/include/node";
const NODE_SIGNING_KEY_FINGERPRINT = "5BE8A3F6C8A5C01D106C0AD820B1A390B168D356";
const PYTHON_EXECUTABLE = "/usr/bin/python3";

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_MEMBERS = 32_768;
const MAX_ARCHIVE_MEMBER_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_DECLARED_BYTES = 512 * 1024 * 1024;
const MAX_HEADER_FILES = 8_192;
const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_FILE_BYTES = 8 * 1024 * 1024;
const MAX_MEMBER_NAME_BYTES = 512;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const EXTRACT_TIMEOUT_MS = 120_000;

const MISSING = Symbol("missing");
const NOFOLLOW = constants.O_NOFOLLOW;
const NONBLOCK = constants.O_NONBLOCK;
const READ_FLAGS = constants.O_RDONLY | NOFOLLOW | NONBLOCK;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;
const FAILURE_CODES = new Set([
  "SPEC_INVALID",
  "AUTH_RECEIPT_INVALID",
  "OWNED_ROOT_INVALID",
  "ARCHIVE_INPUT",
  "ARCHIVE_NAME",
  "ARCHIVE_CHANGED",
  "ARCHIVE_DIGEST",
  "AUTH_RECEIPT_MISMATCH",
  "EXTRACT_PROCESS",
  "EXTRACT_OUTPUT_INVALID",
  "HEADER_TREE_INVALID",
  "HEADER_LIMIT",
  "CLEANUP",
  "INTERNAL",
]);

class NodeHeaderMaterializationError extends Error {
  constructor(code) {
    super("NODE_HEADERS_" + code);
    this.name = "NodeHeaderMaterializationError";
    this.code = code;
  }
}

function fail(code) {
  throw new NodeHeaderMaterializationError(FAILURE_CODES.has(code) ? code : "INTERNAL");
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownData(value, key) {
  if (!isRecord(value)) return MISSING;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : MISSING;
  } catch {
    return MISSING;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.mtimeMs === right.mtimeMs;
}

function absolutePath(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && isAbsolute(value);
}

function assertPositiveInteger(value, maximum) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function canonicalReceiptProjection(projection) {
  return JSON.stringify(Object.fromEntries(
    Object.entries(projection).sort(([left], [right]) => left.localeCompare(right, "en")),
  ));
}

/**
 * Validate only the receipt fields that bind this fixed official archive.
 * Signature verification itself belongs to the existing Node authority; this
 * function does not re-attest the signature or retain the raw receipt.
 */
function validateAuthenticatedReceipt(receipt) {
  if (!isRecord(receipt)) fail("AUTH_RECEIPT_INVALID");
  const schema = ownData(receipt, "schema");
  const status = ownData(receipt, "status");
  const nodeVersion = ownData(receipt, "nodeVersion");
  const target = ownData(receipt, "target");
  const signature = ownData(receipt, "signature");
  const shasums = ownData(receipt, "shasums");
  const executable = ownData(receipt, "executable");
  const archive = ownData(receipt, "archive");
  if (schema !== "nebular.linux-node-authenticity-v1" || status !== MISSING
      || nodeVersion !== NODE_VERSION || target !== NODE_TARGET
      || !isRecord(signature) || ownData(signature, "verified") !== true
      || ownData(signature, "fingerprint") !== NODE_SIGNING_KEY_FINGERPRINT
      || !isRecord(shasums) || typeof ownData(shasums, "sha256") !== "string"
      || !/^[a-f0-9]{64}$/u.test(ownData(shasums, "sha256"))
      || ownData(shasums, "entry") !== NODE_ARCHIVE_SHA256
      || !isRecord(archive) || ownData(archive, "name") !== NODE_ARCHIVE_NAME
      || ownData(archive, "sha256") !== NODE_ARCHIVE_SHA256
      || !Number.isSafeInteger(ownData(archive, "size")) || ownData(archive, "size") <= 0
      || ownData(archive, "size") > MAX_ARCHIVE_BYTES
      || !isRecord(executable) || typeof ownData(executable, "sha256") !== "string"
      || !/^[a-f0-9]{64}$/u.test(ownData(executable, "sha256"))
      || !Number.isSafeInteger(ownData(executable, "size")) || ownData(executable, "size") <= 0) {
    fail("AUTH_RECEIPT_INVALID");
  }
  const projection = Object.freeze({
    schema,
    nodeVersion,
    target,
    signatureVerified: true,
    signingKeyFingerprint: NODE_SIGNING_KEY_FINGERPRINT,
    shasumsSha256: ownData(shasums, "sha256"),
    shasumEntrySha256: NODE_ARCHIVE_SHA256,
    archiveFilename: NODE_ARCHIVE_NAME,
    archiveSha256: NODE_ARCHIVE_SHA256,
    archiveBytes: ownData(archive, "size"),
    executableSha256: ownData(executable, "sha256"),
    executableBytes: ownData(executable, "size"),
  });
  return Object.freeze({
    receiptSchema: schema,
    nodeVersion,
    target,
    archiveBytes: ownData(archive, "size"),
    receiptBindingSha256: sha256(Buffer.from(canonicalReceiptProjection(projection), "utf8")),
  });
}

async function assertOwnedDirectory(path, code = "OWNED_ROOT_INVALID") {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) fail(code);
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) fail(code);
    if (await realpath(path) !== resolve(path)) fail(code);
  } catch (error) {
    if (error instanceof NodeHeaderMaterializationError) throw error;
    fail(code);
  }
}

async function copyArchiveToOwnedFile(sourcePath, destination, { archiveName, archiveSha256 } = {}) {
  if (!absolutePath(sourcePath)) fail("SPEC_INVALID");
  if (typeof archiveName !== "string" || basename(sourcePath) !== archiveName) fail("ARCHIVE_NAME");
  if (typeof NOFOLLOW !== "number" || typeof NONBLOCK !== "number") fail("ARCHIVE_INPUT");
  let source;
  let output;
  try {
    source = await open(sourcePath, READ_FLAGS);
    const initial = await source.stat();
    if (!initial.isFile() || initial.size <= 0 || initial.size > MAX_ARCHIVE_BYTES) fail("ARCHIVE_INPUT");
    output = await open(destination, WRITE_FLAGS, 0o600);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < initial.size) {
      const { bytesRead } = await source.read(chunk, 0, Math.min(chunk.length, initial.size - offset), offset);
      if (bytesRead <= 0) fail("ARCHIVE_CHANGED");
      const bytes = chunk.subarray(0, bytesRead);
      let written = 0;
      while (written < bytes.length) {
        const result = await output.write(bytes, written, bytes.length - written, offset + written);
        if (result.bytesWritten <= 0) fail("ARCHIVE_INPUT");
        written += result.bytesWritten;
      }
      hash.update(bytes);
      offset += bytesRead;
    }
    const probe = Buffer.alloc(1);
    const { bytesRead: extra } = await source.read(probe, 0, 1, initial.size);
    const final = await source.stat();
    if (extra !== 0 || !sameIdentity(initial, final)) fail("ARCHIVE_CHANGED");
    const digest = hash.digest("hex");
    if (digest !== archiveSha256) fail("ARCHIVE_DIGEST");
    await output.sync();
    return Object.freeze({ bytes: initial.size, sha256: digest });
  } catch (error) {
    if (error instanceof NodeHeaderMaterializationError) throw error;
    fail("ARCHIVE_INPUT");
  } finally {
    await output?.close().catch(() => {});
    await source?.close().catch(() => {});
  }
}

function asOutputBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return null;
}

function validateProcessResult(result) {
  if (!isRecord(result)) fail("EXTRACT_PROCESS");
  if (ownData(result, "exitCode") !== 0 || ![null, undefined].includes(ownData(result, "signal"))
      || ![null, undefined].includes(ownData(result, "failure"))
      || ownData(result, "cleanup") !== "leader-close-observed") fail("EXTRACT_PROCESS");
  for (const key of ["stdoutBytes", "stderrBytes"]) {
    const value = ownData(result, key);
    if (value !== MISSING && (!Number.isSafeInteger(value) || value < 0 || value > MAX_PROCESS_OUTPUT_BYTES)) {
      fail("EXTRACT_PROCESS");
    }
  }
  const stdout = asOutputBytes(ownData(result, "stdout"));
  if (!stdout || stdout.length > MAX_PROCESS_OUTPUT_BYTES) fail("EXTRACT_OUTPUT_INVALID");
  if (ownData(result, "stdoutBytes") !== MISSING && ownData(result, "stdoutBytes") < stdout.length) fail("EXTRACT_PROCESS");
  return stdout;
}

function parseExtractorOutput(stdout, archiveBytes, archiveSha256) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout));
  } catch {
    fail("EXTRACT_OUTPUT_INVALID");
  }
  if (!isRecord(value)) fail("EXTRACT_OUTPUT_INVALID");
  const keys = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  const expected = ["archiveBytes", "archiveSha256", "bytes", "files", "headerRoot", "schema", "status"];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) fail("EXTRACT_OUTPUT_INVALID");
  if (value.schema !== "nebular.node-header-extractor-v1" || value.status !== "passed"
      || value.archiveSha256 !== archiveSha256 || value.archiveBytes !== archiveBytes
      || value.headerRoot !== NODE_HEADER_ROOT || !assertPositiveInteger(value.files, MAX_HEADER_FILES)
      || !assertPositiveInteger(value.bytes, MAX_HEADER_BYTES)) fail("EXTRACT_OUTPUT_INVALID");
  return Object.freeze({ files: value.files, bytes: value.bytes });
}

async function readRegularFileNoFollow(path) {
  let handle;
  try {
    handle = await open(path, READ_FLAGS);
    const initial = await handle.stat();
    if (!initial.isFile() || initial.size > MAX_HEADER_FILE_BYTES) fail("HEADER_LIMIT");
    const bytes = await handle.readFile();
    const final = await handle.stat();
    if (!sameIdentity(initial, final) || bytes.length !== initial.size) fail("HEADER_TREE_INVALID");
    return bytes;
  } catch (error) {
    if (error instanceof NodeHeaderMaterializationError) throw error;
    fail("HEADER_TREE_INVALID");
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * This is byte-for-byte compatible with sidecar-common's nativeHeaderIdentity:
 * sorted relative paths, NUL, file bytes, NUL. Links are rejected rather than
 * accepted as the maintained helper permits.
 */
async function nativeHeaderIdentity(root) {
  if (!absolutePath(root)) fail("SPEC_INVALID");
  await assertOwnedDirectory(root, "HEADER_TREE_INVALID");
  const hash = createHash("sha256");
  const names = new Set();
  let files = 0;
  let bytes = 0;
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      fail("HEADER_TREE_INVALID");
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const fileBytes = await readRegularFileNoFollow(path);
        const relativePath = relative(root, path);
        if (!relativePath || names.has(relativePath)) fail("HEADER_TREE_INVALID");
        names.add(relativePath);
        files += 1;
        bytes += fileBytes.length;
        if (files > MAX_HEADER_FILES || bytes > MAX_HEADER_BYTES) fail("HEADER_LIMIT");
        hash.update(relativePath).update("\0").update(fileBytes).update("\0");
      } else {
        fail("HEADER_TREE_INVALID");
      }
    }
  }
  await visit(root);
  if (!files || !names.has("node_version.h")) fail("HEADER_TREE_INVALID");
  const versionHeader = await readRegularFileNoFollow(join(root, "node_version.h"));
  if (!/^#define\s+NODE_MAJOR_VERSION\s+22(?:\s|$)/mu.test(versionHeader.toString("utf8"))) {
    fail("HEADER_TREE_INVALID");
  }
  return Object.freeze({ files, bytes, sha256: hash.digest("hex") });
}

function processRunner(processPort) {
  if (!isRecord(processPort)) fail("SPEC_INVALID");
  const descriptor = Object.getOwnPropertyDescriptor(processPort, "run");
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") fail("SPEC_INVALID");
  return descriptor.value;
}

async function removeOwnedJob(jobRoot) {
  if (!jobRoot) return;
  try {
    const info = await lstat(jobRoot);
    if (info.isDirectory() && !info.isSymbolicLink() && (await realpath(jobRoot)) === resolve(jobRoot)) {
      await rm(jobRoot, { recursive: true, force: true });
    }
  } catch {
    // Failure cleanup is best effort and never emits a private path.
  }
}

async function materializeNodeHeadersInternal({
  archivePath,
  scratchRoot,
  processPort,
  archiveName,
  archiveSha256,
  receiptBinding,
} = {}) {
  if (!absolutePath(archivePath) || !absolutePath(scratchRoot)
      || typeof archiveName !== "string" || !/^[\x20-\x7e]{1,256}$/u.test(archiveName)
      || typeof archiveSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(archiveSha256)) fail("SPEC_INVALID");
  const run = processRunner(processPort);
  await assertOwnedDirectory(scratchRoot);
  let jobRoot;
  try {
    jobRoot = await mkdtemp(join(resolve(scratchRoot), "header-"));
    await chmod(jobRoot, 0o700);
    await assertOwnedDirectory(jobRoot);
    const headersRoot = join(jobRoot, "include", "node");
    await mkdir(headersRoot, { recursive: true, mode: 0o700 });
    await assertOwnedDirectory(headersRoot);
    const archiveCopy = join(jobRoot, archiveName);
    const archive = await copyArchiveToOwnedFile(archivePath, archiveCopy, { archiveName, archiveSha256 });
    if (receiptBinding && receiptBinding.archiveBytes !== archive.bytes) fail("AUTH_RECEIPT_MISMATCH");
    const command = Object.freeze({
      phase: "node-header-materialize",
      program: PYTHON_EXECUTABLE,
      args: [
        "-I",
        "-B",
        "-c",
        PYTHON_EXTRACTOR_SOURCE,
        "--archive",
        archiveCopy,
        "--destination",
        headersRoot,
        "--expected-sha256",
        archiveSha256,
      ],
      cwd: jobRoot,
      env: Object.freeze({ LANG: "C", LC_ALL: "C", PYTHONHASHSEED: "0" }),
      maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
      timeoutMs: EXTRACT_TIMEOUT_MS,
    });
    let processResult;
    try {
      processResult = await run(command);
    } catch {
      fail("EXTRACT_PROCESS");
    }
    const childOutput = validateProcessResult(processResult);
    const childSummary = parseExtractorOutput(childOutput, archive.bytes, archiveSha256);
    const tree = await nativeHeaderIdentity(headersRoot);
    if (tree.files !== childSummary.files || tree.bytes !== childSummary.bytes) fail("EXTRACT_OUTPUT_INVALID");
    try {
      await unlink(archiveCopy);
    } catch {
      fail("CLEANUP");
    }
    return Object.freeze({
      schema: NODE_HEADER_SCHEMA,
      root: headersRoot,
      identity: tree.sha256,
      files: tree.files,
      target: NODE_TARGET,
      version: NODE_VERSION,
      archiveSha256: archive.sha256,
    });
  } catch (error) {
    await removeOwnedJob(jobRoot);
    if (error instanceof NodeHeaderMaterializationError) throw error;
    fail("INTERNAL");
  }
}

/**
 * Materialize only the Node v22.23.4 Linux ARM64 include/node tree.
 * processPort.run is the injected supervised process boundary; this module
 * never spawns a child process itself.
 */
async function materializeNodeHeaders({
  archivePath,
  authenticatedReceipt,
  scratchRoot,
  processPort,
} = {}) {
  const receiptBinding = validateAuthenticatedReceipt(authenticatedReceipt);
  return materializeNodeHeadersInternal({
    archivePath,
    scratchRoot,
    processPort,
    archiveName: NODE_ARCHIVE_NAME,
    archiveSha256: NODE_ARCHIVE_SHA256,
    receiptBinding,
  });
}

/**
 * Fixed Python stdlib extractor. It never invokes an archive utility, follows
 * no links, writes no member outside the exact header prefix, and reports only
 * fixed JSON fields. It is exported solely so an injected test/process port
 * can execute the exact source without importing private implementation code.
 */
const PYTHON_EXTRACTOR_SOURCE = String.raw`
import hashlib
import json
import os
import stat
import sys
import tarfile

ARCHIVE_LIMIT = 256 * 1024 * 1024
MEMBER_LIMIT = 32768
ARCHIVE_MEMBER_LIMIT = 256 * 1024 * 1024
DECLARED_LIMIT = 512 * 1024 * 1024
FILE_LIMIT = 8 * 1024 * 1024
TREE_LIMIT = 64 * 1024 * 1024
FILE_COUNT_LIMIT = 8192
NAME_LIMIT = 512
HEADER_ROOT = "node-v22.23.4-linux-arm64/include/node"
SCHEMA = "nebular.node-header-extractor-v1"
NOFOLLOW = getattr(os, "O_NOFOLLOW", None)
if NOFOLLOW is None:
    raise SystemExit(2)
destination = None
clean_output = False

def cleanup_destination():
    if not clean_output or not destination or not os.path.isdir(destination) or os.path.islink(destination):
        return
    for current, directories, files in os.walk(destination, topdown=False, followlinks=False):
        for name in files + directories:
            path = os.path.join(current, name)
            try:
                if os.path.islink(path) or os.path.isfile(path):
                    os.unlink(path)
                elif os.path.isdir(path):
                    os.rmdir(path)
            except OSError:
                pass

def reject(code):
    cleanup_destination()
    print(json.dumps({"schema": SCHEMA, "status": "failed", "code": code}, separators=(",", ":")))
    raise SystemExit(2)

def safe_name(name):
    try:
        encoded = name.encode("utf-8")
    except UnicodeError:
        reject("member-name")
    if not name or len(encoded) > NAME_LIMIT or "\x00" in name or "\\" in name or name.startswith("/"):
        reject("member-name")
    parts = name.split("/")
    if parts[-1] == "":
        parts = parts[:-1]
    if not parts or any(part in ("", ".", "..") for part in parts):
        reject("member-name")
    normalized = "/".join(parts)
    if normalized != name.rstrip("/"):
        reject("member-name")
    return normalized

def write_regular(path, member, source):
    global tree_bytes, tree_files
    if member.size <= 0 or member.size > FILE_LIMIT or tree_bytes + member.size > TREE_LIMIT or tree_files >= FILE_COUNT_LIMIT:
        reject("header-limit")
    parent = os.path.dirname(path)
    os.makedirs(parent, mode=0o700, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW
    try:
        fd = os.open(path, flags, 0o600)
    except OSError:
        reject("header-output")
    stream = source.extractfile(member)
    if stream is None:
        os.close(fd)
        reject("header-entry")
    remaining = member.size
    try:
        with os.fdopen(fd, "wb", closefd=True) as output:
            while remaining:
                block = stream.read(min(65536, remaining))
                if not block:
                    reject("header-entry")
                output.write(block)
                remaining -= len(block)
    finally:
        stream.close()
    tree_bytes += member.size
    tree_files += 1

if len(sys.argv) != 7 or sys.argv[1] != "--archive" or sys.argv[3] != "--destination" or sys.argv[5] != "--expected-sha256":
    reject("usage")
archive_path = sys.argv[2]
destination = sys.argv[4]
expected_sha = sys.argv[6]
try:
    archive_stat = os.lstat(archive_path)
    if not stat.S_ISREG(archive_stat.st_mode) or archive_stat.st_size <= 0 or archive_stat.st_size > ARCHIVE_LIMIT:
        reject("archive-input")
    if not os.path.isdir(destination) or os.path.islink(destination) or os.listdir(destination):
        reject("destination")
    clean_output = True
    digest = hashlib.sha256()
    with open(archive_path, "rb", buffering=0) as archive_file:
        while True:
            block = archive_file.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
    if digest.hexdigest() != expected_sha:
        reject("archive-digest")
    seen = set()
    normalized_seen = set()
    declared = 0
    member_count = 0
    tree_files = 0
    tree_bytes = 0
    with tarfile.open(archive_path, mode="r|xz") as archive:
        for member in archive:
            member_count += 1
            if member_count > MEMBER_LIMIT:
                reject("member-limit")
            normalized = safe_name(member.name)
            if member.name in seen or normalized in normalized_seen:
                reject("duplicate-member")
            seen.add(member.name)
            normalized_seen.add(normalized)
            prefix = HEADER_ROOT + "/"
            in_header = normalized == HEADER_ROOT or normalized.startswith(prefix)
            if member.isreg():
                declared += member.size
                if member.size < 0 or member.size > ARCHIVE_MEMBER_LIMIT or declared > DECLARED_LIMIT:
                    reject("declared-limit")
            if in_header:
                if normalized == HEADER_ROOT:
                    if not member.isdir():
                        reject("header-root")
                    continue
                relative = normalized[len(prefix):]
                if not relative:
                    reject("header-name")
                if member.isdir():
                    continue
                if not member.isreg():
                    reject("header-link-or-special")
                write_regular(os.path.join(destination, *relative.split("/")), member, archive)
            elif not (member.isreg() or member.isdir() or member.issym() or member.islnk()):
                reject("member-special")
    if tree_files == 0 or not os.path.isfile(os.path.join(destination, "node_version.h")):
        reject("header-missing")
    if tree_bytes <= 0:
        reject("header-empty")
    print(json.dumps({"schema": SCHEMA, "status": "passed", "archiveSha256": digest.hexdigest(), "archiveBytes": archive_stat.st_size, "headerRoot": HEADER_ROOT, "files": tree_files, "bytes": tree_bytes}, separators=(",", ":")))
except SystemExit:
    raise
except (OSError, tarfile.TarError, EOFError, ValueError):
    reject("archive-invalid")
`;

return Object.freeze({ materializeNodeHeaders, validateAuthenticatedReceipt });
})();
export const materializeNodeHeaders = nodeHeaderWorkflowAPI.materializeNodeHeaders;
/* END VERIFIED NODE HEADER MATERIALIZER */

/**
 * Source-only Linux AArch64 checkpoint driver.
 *
 * This module is deliberately an orchestration boundary.  The actual capsule
 * unpack, maintained API, toolchain authentication, and Rust execution are
 * injected by the future qualification workflow.  No import in this file
 * reaches a private checkout, performs a download, or starts a child process
 * during module evaluation.
 */

export const DRIVER_SCHEMA = "nebular.linux-arm64-source-rust-driver-v1";
export const REPOSITORY = "Knowledge-Forge-AI/theme-forge-nebular-fusion";
export const QUALIFICATION_BRANCH = "qualification/linux-arm64-bootstrap-20261116";
export const TARGET = "aarch64-unknown-linux-gnu";
export const SOURCE_ARCHIVE_SHA256 = "3ac9596a540e704c1140f6b501bb43569967567c084079a3dbfe871e29b25602";
export const SOURCE_ARCHIVE_BYTES = 8977072;
export const SOURCE_ARCHIVE_MEMBERS = 3069;
export const BASE_QUALIFICATION_COMMIT = "0e0956614ff6b18890a6a342404680c7e7e2a23b";
export const NODE_VERSION = "22.23.4";
export const NPM_VERSION = "10.9.9";
export const RUST_VERSION = "1.98.0";
export const CARGO_VERSION = "1.98.0";
export const PYTHON_VERSION = ">=3.11";
export const VERIFIER_BINDING_SHA256 = "7556406b3025cc809a125341dae333fb6e6d04d9c06937a955f9ed1d5d139f19";
export const OPENPGP_TARBALL_SHA256 = "2900c3a0119eb134dc88257b873f53fa499df8e8e02ebb61301bd2378c9cc22b";
export const COMMAND_TIMEOUT_MS = 1_800_000;
export const COMMAND_KILL_GRACE_MS = 2_000;
export const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
export const RETENTION_DAYS = 14;

export const FAILURE_CODES = Object.freeze([
  "WORKFLOW_GUARD",
  "SPEC_INVALID",
  "BOOTSTRAP_PYTHON",
  "CAPSULE_EXTRACT",
  "VERIFIER_INPUT_IDENTITY",
  "TOOLCHAIN_READBACK",
  "NODE_AUTHENTICATION",
  "NATIVE_ADDON_BUILD",
  "NATIVE_ADDON_VALIDATE",
  "NATIVE_ADDON_PROBE",
  "HOST_INPUTS",
  "SOURCE_STAGE",
  "SOURCE_ROUTE",
  "RUST_GROUPS",
  "INTERNAL",
]);

const SHA256 = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const ABSOLUTE = /^\/(?:[^\0\r\n]*)$/u;

export class LinuxNativeDriverError extends Error {
  constructor(code, stage = "driver") {
    super(`SOURCE_NATIVE_${code}`);
    this.name = "LinuxNativeDriverError";
    this.code = code;
    this.stage = stage;
  }
}

function fail(code, stage = "driver") {
  throw new LinuxNativeDriverError(code, stage);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function absolute(value, code = "SPEC_INVALID") {
  if (typeof value !== "string" || !ABSOLUTE.test(value)) fail(code);
  return value;
}

function sha256(value, code = "SPEC_INVALID") {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function commit(value, code = "SPEC_INVALID") {
  if (typeof value !== "string" || !SHA1.test(value)) fail(code);
  return value;
}

function emptyObject(value) {
  return record(value) && Object.keys(value).length === 0;
}

/**
 * Validate the workflow admission boundary before any archive, maintained API,
 * or command port is touched.  Only public runner facts are returned.
 */
export function validateWorkflowContext(env, input) {
  if (!record(env) || env.GITHUB_ACTIONS !== "true" || env.RUNNER_OS !== "Linux"
      || env.RUNNER_ARCH !== "ARM64" || env.GITHUB_REPOSITORY !== REPOSITORY
      || env.GITHUB_EVENT_NAME !== "workflow_dispatch"
      || env.GITHUB_REF !== `refs/heads/${QUALIFICATION_BRANCH}`
      || env.GITHUB_REF_NAME !== QUALIFICATION_BRANCH
      || env.GITHUB_RUN_ATTEMPT !== "1" || !/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ID ?? "")
      || !SHA1.test(env.GITHUB_SHA ?? "")
      || !absolute(env.RUNNER_TEMP, "WORKFLOW_GUARD")
      || !absolute(env.GITHUB_WORKSPACE, "WORKFLOW_GUARD")) {
    fail("WORKFLOW_GUARD", "guard");
  }
  if (!record(input) || input.confirm_linux_source_rust !== true
      || input.repository !== undefined && input.repository !== REPOSITORY
      || input.branch !== undefined && input.branch !== QUALIFICATION_BRANCH
      || !emptyObject(input.environment)) {
    fail("WORKFLOW_GUARD", "guard");
  }
  return Object.freeze({ repository: REPOSITORY, branch: QUALIFICATION_BRANCH, target: TARGET, mode: "manual-source-only" });
}

/** Validate the immutable verifier/tarball bindings before any copy or extract. */
export function verifyBootstrapDigests({ bindingSha256, tarballSha256 } = {}) {
  if (bindingSha256 !== VERIFIER_BINDING_SHA256 || tarballSha256 !== OPENPGP_TARBALL_SHA256) {
    fail("VERIFIER_INPUT_IDENTITY", "bootstrap-verifier-copy");
  }
  return Object.freeze({ bindingSha256: VERIFIER_BINDING_SHA256, tarballSha256: OPENPGP_TARBALL_SHA256 });
}

/**
 * Produce the fixed argv descriptors used by the future runner.  Descriptors
 * contain private locators supplied at runtime; they are never emitted in the
 * public result.  There are no shell strings and no retry descriptors.
 */
export function bootstrapCommandPlan(paths) {
  if (!record(paths)) fail("SPEC_INVALID", "bootstrap-plan");
  const required = ["python", "unpacker", "archive", "extract", "rustupInit", "rustc", "cargo", "node", "npm", "nodeAuthority", "nodeInput", "nodeOutput", "nodeReceipt"];
  for (const name of required) absolute(paths[name], "SPEC_INVALID");
  sha256(paths.archiveSha256 ?? SOURCE_ARCHIVE_SHA256);
  const archiveSha256 = paths.archiveSha256 ?? SOURCE_ARCHIVE_SHA256;
  if (archiveSha256 !== SOURCE_ARCHIVE_SHA256) fail("VERIFIER_INPUT_IDENTITY", "bootstrap-extract");
  const commands = [
    {phase:"system-packages-readback",program:"/usr/bin/dpkg-query",args:["-W","-f","${Package}\t${Version}\t${Architecture}\n"]},
    { phase: "bootstrap-python-readback", program: paths.python, args: ["--version"] },
    { phase: "bootstrap-extract", program: paths.python, args: ["-B", paths.unpacker, "--archive", paths.archive, "--sha256", SOURCE_ARCHIVE_SHA256, "--output", paths.extract] },
    { phase: "toolchain-install", program: paths.rustupInit, args: ["-y", "--no-modify-path", "--profile", "minimal", "--default-toolchain", RUST_VERSION] },
    { phase: "toolchain-readback-rustc", program: paths.rustc, args: ["--version", "--verbose"] },
    { phase: "toolchain-readback-target", program: paths.rustc, args: ["-vV"] },
    { phase: "toolchain-readback-cargo", program: paths.cargo, args: ["--version", "--verbose"] },
    { phase: "toolchain-readback-node", program: paths.node, args: ["--version"] },
    { phase: "toolchain-readback-npm", program: paths.node, args: [paths.npm, "--version"] },
    { phase: "bootstrap-node-auth", program: paths.node, args: [paths.nodeAuthority, "--authenticate-linux", paths.nodeInput, "--target", TARGET, "--output-node", paths.nodeOutput, "--output", paths.nodeReceipt] },
  ];
  return Object.freeze(commands.map((command) => Object.freeze({ ...command, retry: false })));
}

/**
 * Keep the source route explicit.  This is a structural check only; the
 * maintained capsule remains the authority for the actual source identity.
 */
export function validatePortableSourceRoute(authority) {
  try {
    validateStageAuthority(authority);
  } catch {
    fail("SOURCE_ROUTE", "source-route");
  }
  if (authority.target.triple !== TARGET || authority.inputs.target !== TARGET
      || authority.inputs.mode !== "portable-source"
      || authority.inputs.materialRoute?.target !== TARGET
      || authority.inputs.materialRoute?.wholeSourceCandidate !== authority.inputs.source.identity
      || !emptyObject(authority.inputs.execution.environment)) {
    fail("SOURCE_ROUTE", "source-route");
  }
  return Object.freeze({ target: TARGET, mode: "portable-source", materialProfile: "paired-material-v1", source: authority.inputs.source.identity });
}

/** Return the fixed plan without exposing local paths or process output. */
export function createLinuxSourceRustPlan() {
  const groups = createLinuxRustGroupPlan();
  return Object.freeze({
    schema: DRIVER_SCHEMA,
    repository: REPOSITORY,
    branch: QUALIFICATION_BRANCH,
    baseCommit: BASE_QUALIFICATION_COMMIT,
    target: TARGET,
    source: Object.freeze({ archiveSha256: SOURCE_ARCHIVE_SHA256, bytes: SOURCE_ARCHIVE_BYTES, members: SOURCE_ARCHIVE_MEMBERS }),
    toolchains: Object.freeze({ node: NODE_VERSION, npm: NPM_VERSION, rustc: RUST_VERSION, cargo: CARGO_VERSION, python: PYTHON_VERSION }),
    limits: Object.freeze({ commandTimeoutMs: COMMAND_TIMEOUT_MS, killGraceMs: COMMAND_KILL_GRACE_MS, maxCommandOutputBytes: MAX_COMMAND_OUTPUT_BYTES, retentionDays: RETENTION_DAYS }),
    groups,
    expectedTests: groups.requiredLibraryTests + groups.requiredPolicyTests,
    phases: Object.freeze(["guard", "bootstrap-python-readback", "bootstrap-extract", "bootstrap-verifier-copy", "toolchain-install", "toolchain-readback", "bootstrap-node-auth", "prepare-host-inputs", "source-stage", "rust-test-lists", "rust-tests", "evidence"]),
    retries: false,
    nativeBinaryArtifacts: false,
    rustTestCompilation: true,
    signing: false,
    packaging: false,
    guiLaunch: false,
    publication: false,
    hostedQualification: false,
    nativeAcceptance: "not-claimed",
  });
}

const FAILURE_STAGES=new Set(['driver','guard','bootstrap-plan','bootstrap-extract','bootstrap-verifier-copy',
 'source-route','source-stage','rust-tests','owned-root','maintained-api','output','usage',
 'prepare-host-inputs','bootstrap-python-readback','toolchain-readback-node','toolchain-readback-npm',
 'toolchain-readback-rustc','toolchain-readback-target','toolchain-readback-cargo','bootstrap-node-auth',
 'NATIVE_ADDON_BUILD','NATIVE_ADDON_VALIDATE','NATIVE_ADDON_PROBE']);
function ownError(error,key,allowed,fallback){
 try{if(!(error instanceof LinuxNativeDriverError))return fallback;
 const d=Object.getOwnPropertyDescriptor(error,key);return d&&Object.hasOwn(d,'value')&&allowed.has(d.value)?d.value:fallback;
 }catch{return fallback;}
}
function publicFailure(error,fallback='INTERNAL'){
 return ownError(error,'code',new Set(FAILURE_CODES),fallback);
}
function publicStage(error){return ownError(error,'stage',FAILURE_STAGES,'driver');}

/**
 * Run the future hosted checkpoint with injected private ports.  This function
 * is intentionally unusable without the workflow-supplied maintained API and
 * archive/process ports. Source tests inject fixture services and fake Cargo
 * responses; three harmless Node children qualify only the process adapter.
 */
export async function runLinuxSourceRustCheckpoint({ env, input, hostSpec, ports, maintained, authority, stageOutput } = {}, services={prepareHostInputs,prepareRustSource}) {
  try {
    validateWorkflowContext(env, input);
    if (!record(hostSpec) || !record(ports) || !record(maintained) || typeof authority !== "function") fail("SPEC_INVALID", "guard");
    verifyBootstrapDigests(hostSpec.verifier ?? {});
    let hostResult;
    try{hostResult=await services.prepareHostInputs(hostSpec,{env,ports,maintained});}
    catch(error){
      if(error instanceof HostInputError){
        const code=Object.getOwnPropertyDescriptor(error,'code');
        if(code&&Object.hasOwn(code,'value')&&['NATIVE_ADDON_BUILD','NATIVE_ADDON_VALIDATE','NATIVE_ADDON_PROBE'].includes(code.value))fail(code.value,code.value);
      }
      fail('HOST_INPUTS','prepare-host-inputs');
    }
    let loadedAuthority;
    try{loadedAuthority=await authority(hostResult.buildInputsPath,hostResult.privateRoot);}
    catch{fail('SOURCE_ROUTE','source-route');}
    validatePortableSourceRoute(loadedAuthority);
    if (typeof stageOutput !== "string" || !ABSOLUTE.test(stageOutput)) fail("SPEC_INVALID", "source-stage");
    let sourceStage;
    try{sourceStage=await services.prepareRustSource({authority:loadedAuthority,output:stageOutput,maintained,run:ports.run,mode:'actual'});}
    catch{fail('SOURCE_STAGE','source-stage');}
    const rustPort = {run: descriptor => {
      if (!Array.isArray(descriptor.argv) || descriptor.argv[0] !== 'cargo') fail('RUST_GROUPS','rust-tests');
      const run = ports.rustRun ?? ports.run;
      return run({phase:`rust-${descriptor.group}-${descriptor.phase}`, program:loadedAuthority.tools.cargo,
        args:descriptor.argv.slice(1), cwd:join(sourceStage.source,'src-tauri'),
        env:{...sourceStage.environment}, maxOutputBytes:MAX_COMMAND_OUTPUT_BYTES, timeoutMs:COMMAND_TIMEOUT_MS});
    }};
    const groupResult = await evaluateLinuxRustGroups(createLinuxRustGroupPlan(), rustPort);
    const sanitized = groupResult;
    if (sanitized.status !== "passed-process-observation") {
      return Object.freeze({ schema: DRIVER_SCHEMA, status: "failed", failureStage: "rust-tests", failureCode: "RUST_GROUPS", groups: sanitized.observations, failureDetail:sanitized.failureCode, failedGroup:sanitized.failedGroup, failedPhase:sanitized.failedPhase, nativeAcceptance: "not-claimed" });
    }
    return Object.freeze({
      schema: DRIVER_SCHEMA,
      status: "passed-process-observation",
      target: TARGET,
      source: hostResult.receipt.source,
      nativeBackend: hostResult.receipt.nativeBackend,
      stage: sourceStage.receipt,
      groups: sanitized.groups,
      totals: sanitized.totals,
      nativeAcceptance: "not-claimed",
      hosted: false,
      packaging: false,
      guiLaunch: false,
      publication: false,
    });
  } catch (error) {
    return Object.freeze({ schema: DRIVER_SCHEMA, status: "failed", failureStage: publicStage(error), failureCode: publicFailure(error), nativeAcceptance: "not-claimed" });
  }
}

export function createLinuxRustProcessPort(options = {}) {
  const {spawnImpl=spawn, ...controls}=options;
  return {async run(command) {
    const maxOutputBytes=command.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES;
    const timeoutMs=command.timeoutMs ?? COMMAND_TIMEOUT_MS;
    if(!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<=0||maxOutputBytes>MAX_COMMAND_OUTPUT_BYTES
       ||!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>COMMAND_TIMEOUT_MS)fail('SPEC_INVALID','driver');
    const chunks={stdout:[],stderr:[]}, lengths={stdout:0,stderr:0};
    const port=createChildProcessPort({...controls,timeoutMs:COMMAND_TIMEOUT_MS,killGraceMs:COMMAND_KILL_GRACE_MS,
      spawnImpl:(program,args,settings)=>{
        const child=spawnImpl(program,args,settings);
        for(const stream of ['stdout','stderr']) child[stream]?.on('data',chunk=>{
          const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
          const remaining=Math.max(0,maxOutputBytes-lengths[stream]);
          if(remaining) chunks[stream].push(Buffer.from(bytes.subarray(0,remaining)));
          lengths[stream]+=bytes.length;
        });
        return child;
      }});
    const result=await port.run({...command,maxOutputBytes,timeoutMs});
    return {...result,stdout:Buffer.concat(chunks.stdout),stderr:Buffer.concat(chunks.stderr)};
  }};
}

export { HOST_REPOSITORY, HOST_TARGET, STAGE_TARGET, GROUP_TARGET };

async function digestFile(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeExclusiveJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

async function copyRegularExclusive(source, destination) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination, 0x1);
}

export function runtimePaths(env, repo) {
  const campaign = join(absolute(env.RUNNER_TEMP, "WORKFLOW_GUARD"), "nebular-linux");
  const node = process.execPath;
  const npm = env.NEBULAR_NPM_CLI ?? join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js");
  const rustupHome = join(campaign, "rustup-home");
  const cargoHome = join(campaign, "cargo-home");
  const rustToolchain = join(rustupHome, `toolchains/${RUST_VERSION}-${TARGET}`);
  return {
    campaign,
    node,
    npm: absolute(npm, "SPEC_INVALID"),
    python: "/usr/bin/python3",
    unpacker: join(repo, "tools/source-native/unpack-native-inputs.py"),
    hostInputs: join(repo, "tools/source-native-linux-arm64/host-inputs.mjs"),
    rustupInit: join(campaign, "rustup-init/rustup-init"),
    rustup: join(cargoHome, "bin/rustup"),
    rust: join(rustToolchain, "bin/rustc"),
    cargo: join(rustToolchain, "bin/cargo"),
    rustupHome,
    cargoHome,
    rustTargetLibDir: join(rustToolchain, `lib/rustlib/${TARGET}/lib`),
    compiler: "/usr/bin/gcc",
    pkgConfig: "/usr/bin/pkg-config",
    // Same binding used by the passed Mac source spec: native Rust stdlib files.
    // Debian package identities observe the C/GTK/WebKit roots separately.
    systemLibraries: join(rustToolchain, `lib/rustlib/${TARGET}/lib`),
    sourceArchive: join(repo, "authenticated-inputs/source-native/native-material-inputs60.tar.gz"),
    verifierBinding: join(repo, "authenticated-inputs/source-native/runtime-verifier/binding.json"),
    verifierTarball: join(repo, "authenticated-inputs/source-native/runtime-verifier/openpgp-6.3.1.tgz"),
    nodeDownload: join(campaign, "node-download"),
    nodeAuthenticated: join(campaign, "node-authenticated"),
    nodeReceipt: join(campaign, "node-authenticity.json"),
    bootstrapExtracted: join(campaign, "bootstrap/extracted"),
    bootstrapStudio: join(campaign, "bootstrap/extracted/studio"),
    bootstrapTools: join(campaign, "bootstrap/extracted/studio/tools"),
    maintainedApi: join(campaign, "bootstrap/extracted/studio/tools"),
    hostSpec: join(campaign, "host-spec.json"),
    spec: join(campaign, "spec.json"),
    stageOutput: join(campaign, "staged-rust-source"),
    evidence: join(campaign, "evidence"),
  };
}

export function buildLinuxHostSpec(paths) {
  return {
    schema: "nebular-host-input-preparation-v1",
    mode: "actual",
    bundle: { archivePath: paths.sourceArchive, archiveSha256: SOURCE_ARCHIVE_SHA256, manifestRelativePath: "bundle-manifest.json" },
    toolchains: {
      node: paths.node,
      npm: paths.npm,
      rust: paths.rust,
      cargo: paths.cargo,
      compiler: paths.compiler,
      linker: paths.compiler,
      pkgConfig: paths.pkgConfig,
      systemLibraries: paths.systemLibraries,
      rustTargetLibDir: paths.rustTargetLibDir,
      embeddedRuntime: paths.nodeAuthenticated,
    },
    rustupRoot: paths.rustupHome,
    rustupHome: paths.rustupHome,
    observedToolchains: { node: NODE_VERSION, rustc: RUST_VERSION, cargo: CARGO_VERSION, source: "fixed-workflow-observation" },
    cargoConfig: { content: createCargoConfig({ linker: paths.compiler, rustupRoot: paths.rustupHome, rustTargetLibDir: paths.rustTargetLibDir }) },
    verifier: { bindingSha256: VERIFIER_BINDING_SHA256, tarballSha256: OPENPGP_TARBALL_SHA256 },
    environment: {},
    nativeHeaders: paths.nativeHeaders,
  };
}

function buildLinuxSpec(env) {
  const repo = absolute(env.GITHUB_WORKSPACE, "WORKFLOW_GUARD");
  const paths = runtimePaths(env, repo);
  return {
    schema: DRIVER_SCHEMA,
    repository: REPOSITORY,
    branch: QUALIFICATION_BRANCH,
    baseCommit: BASE_QUALIFICATION_COMMIT,
    target: TARGET,
    hostSpec: paths.hostSpec,
    maintainedApi: paths.maintainedApi,
    sourceArchive: paths.sourceArchive,
    verifierBinding: paths.verifierBinding,
    verifierTarball: paths.verifierTarball,
    paths,
    input: { confirm_linux_source_rust: true, environment: {} },
  };
}

function commandEnvironment(paths, env) {
  const nodeBin = dirname(paths.node);
  const rustBin = dirname(paths.rust);
  return {
    PATH: [nodeBin, join(paths.cargoHome, "bin"), rustBin, "/usr/bin", "/bin"].join(":"),
    HOME: join(paths.campaign, "home"),
    TMPDIR: join(paths.campaign, "tmp"),
    TMP: join(paths.campaign, "tmp"),
    TEMP: join(paths.campaign, "tmp"),
    RUSTUP_HOME: paths.rustupHome,
    CARGO_HOME: paths.cargoHome,
    npm_config_cache: join(paths.campaign,"npm-bootstrap-cache"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GITHUB_ACTIONS: env.GITHUB_ACTIONS,
    RUNNER_OS: env.RUNNER_OS,
    RUNNER_ARCH: env.RUNNER_ARCH,
    GITHUB_REPOSITORY: env.GITHUB_REPOSITORY,
    GITHUB_REF: env.GITHUB_REF,
    GITHUB_EVENT_NAME: env.GITHUB_EVENT_NAME,
    RUNNER_TEMP: env.RUNNER_TEMP,
    GITHUB_WORKSPACE: env.GITHUB_WORKSPACE,
  };
}

export const BOOTSTRAP_PHASES = Object.freeze([
  "guard", "canonical-tools", "verifier-inputs", "owned-paths", "bootstrap-plan",
  "system-packages-readback", "bootstrap-python-readback", "bootstrap-extract",
  "bootstrap-verifier-copy", "toolchain-install", "toolchain-readback-rustc",
  "toolchain-readback-target", "toolchain-readback-cargo", "toolchain-readback-node",
  "toolchain-readback-npm", "bootstrap-node-auth", "native-headers", "write-state", "unknown",
]);
export const BOOTSTRAP_REASONS = Object.freeze([
  "PORT_THROWN", "INVALID_RESULT", "PROCESS_TIMEOUT", "PROCESS_OUTPUT_LIMIT",
  "PROCESS_SPAWN", "PROCESS_ERROR", "PROCESS_SIGNAL", "PROCESS_EXIT", "PROCESS_CLEANUP",
  "FILESYSTEM_MISSING", "FILESYSTEM_EXISTS", "FILESYSTEM_PERMISSION", "TYPED_REFUSAL", "UNCLASSIFIED",
]);
function ownData(value,key) {
  try { const row=Object.getOwnPropertyDescriptor(value,key); return row&&Object.hasOwn(row,'value')?row.value:undefined; }
  catch { return undefined; }
}
function processRefusal(stage,reason,result) {
  const error=new LinuxNativeDriverError(stage,stage);
  Object.defineProperty(error,'bootstrapReason',{value:reason});
  const exit=ownData(result,'exitCode');
  Object.defineProperty(error,'bootstrapExitCode',{value:Number.isInteger(exit)&&exit>=0&&exit<=255?exit:null});
  throw error;
}
function bootstrapFailure(error,phase) {
  const wrapped=new LinuxNativeDriverError(publicFailure(error),publicStage(error));
  const code=ownData(error,'code');
  let reason=error instanceof LinuxNativeDriverError?ownData(error,'bootstrapReason'):undefined;
  if(!BOOTSTRAP_REASONS.includes(reason)) {
    reason=code==='ENOENT'?'FILESYSTEM_MISSING':code==='EEXIST'?'FILESYSTEM_EXISTS':
      ['EACCES','EPERM'].includes(code)?'FILESYSTEM_PERMISSION':error instanceof LinuxNativeDriverError?'TYPED_REFUSAL':'UNCLASSIFIED';
  }
  const exit=error instanceof LinuxNativeDriverError?ownData(error,'bootstrapExitCode'):null;
  Object.defineProperties(wrapped,{
    bootstrapPhase:{value:BOOTSTRAP_PHASES.includes(phase)?phase:'unknown'},
    bootstrapReason:{value:reason},
    bootstrapExitCode:{value:Number.isInteger(exit)&&exit>=0&&exit<=255?exit:null},
  });
  return wrapped;
}

async function runClean(port, command, stage) {
  let result;
  try {
    result = await port.run({ ...command, env: { ...command.env }, maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES, timeoutMs: COMMAND_TIMEOUT_MS });
  } catch {
    processRefusal(stage, "PORT_THROWN");
  }
  if (!record(result)) processRefusal(stage,"INVALID_RESULT",result);
  if(result.failure!=null) processRefusal(stage,
    ({TIMEOUT:"PROCESS_TIMEOUT",OUTPUT_LIMIT:"PROCESS_OUTPUT_LIMIT",SPAWN:"PROCESS_SPAWN",ERROR:"PROCESS_ERROR"})[result.failure]??"INVALID_RESULT",result);
  if(result.signal!=null) processRefusal(stage,"PROCESS_SIGNAL",result);
  if(result.exitCode!==0) processRefusal(stage,"PROCESS_EXIT",result);
  if(result.cleanup!=="leader-close-observed") processRefusal(stage,"PROCESS_CLEANUP",result);
  return result;
}

export async function canonicalizeHostToolPaths(paths) {
  if (!record(paths)) fail('SPEC_INVALID','guard');
  absolute(paths.compiler); absolute(paths.node);
  paths.compiler = await realpath(paths.compiler);
  paths.node = await realpath(paths.node);
  return paths;
}

export async function revalidateAuthenticatedRuntime(paths) {
  try {
    const receipt=JSON.parse(await readFile(paths.nodeReceipt,'utf8'));
    nodeHeaderWorkflowAPI.validateAuthenticatedReceipt(receipt);
    if(receipt.executable.size>256*1024*1024)fail('NATIVE_ADDON_VALIDATE','NATIVE_ADDON_VALIDATE');
    for(const path of [paths.node,paths.nodeAuthenticated]){
      const info=await lstat(path);
      if(!info.isFile()||info.isSymbolicLink()||info.size!==receipt.executable.size
          ||await digestFile(path)!==receipt.executable.sha256)fail('NATIVE_ADDON_VALIDATE','NATIVE_ADDON_VALIDATE');
    }
    return receipt;
  }catch{fail('NATIVE_ADDON_VALIDATE','NATIVE_ADDON_VALIDATE');}
}

export async function bootstrapRuntime(spec, env, outputPath, {port=createLinuxRustProcessPort()}={}) {
  let bootstrapPhase = "guard";
  try {
  validateWorkflowContext(env, spec.input);
  const paths = spec.paths;
  // Use the same actual compiler locator for argv[0], raw executable identity,
  // producer manifest and strict validator; Debian's gcc entry may be a link.
  bootstrapPhase = "canonical-tools";
  await canonicalizeHostToolPaths(paths);
  bootstrapPhase = "verifier-inputs";
  verifyBootstrapDigests({ bindingSha256: await digestFile(spec.verifierBinding), tarballSha256: await digestFile(spec.verifierTarball) });
  bootstrapPhase = "owned-paths";
  if(!(await lstat(paths.campaign)).isDirectory() || await realpath(paths.campaign)!==paths.campaign)fail('SPEC_INVALID','owned-root');
  await mkdir(join(paths.campaign, "home"), { recursive: true, mode: 0o700 });
  await mkdir(join(paths.campaign, "tmp"), { recursive: true, mode: 0o700 });
  await mkdir(paths.nodeDownload, { recursive: true, mode: 0o700 });
  await mkdir(dirname(paths.bootstrapExtracted), {recursive:false,mode:0o700});
  const envForCommands = commandEnvironment(paths, env);
  bootstrapPhase = "bootstrap-plan";
  const commands = bootstrapCommandPlan({
    python: paths.python,
    unpacker: paths.unpacker,
    archive: paths.sourceArchive,
    archiveSha256: SOURCE_ARCHIVE_SHA256,
    extract: paths.bootstrapExtracted,
    rustupInit: paths.rustupInit,
    rustc: paths.rust,
    cargo: paths.cargo,
    node: paths.node,
    npm: paths.npm,
    nodeAuthority: join(paths.bootstrapTools, "node-runtime-authority.mjs"),
    nodeInput: paths.nodeDownload,
    nodeOutput: paths.nodeAuthenticated,
    nodeReceipt: paths.nodeReceipt,
  });
  let observedPython=null, packages=null;
  for (const command of commands) {
    bootstrapPhase = command.phase;
    const result = await runClean(port, { phase: command.phase, program: command.program, args: command.args, cwd: paths.campaign, env: envForCommands }, command.phase === "bootstrap-extract" ? "CAPSULE_EXTRACT" : command.phase === "bootstrap-node-auth" ? "NODE_AUTHENTICATION" : command.phase === "toolchain-readback-rustc" || command.phase === "toolchain-readback-target" || command.phase === "toolchain-readback-cargo" || command.phase === "toolchain-readback-node" || command.phase === "toolchain-readback-npm" ? "TOOLCHAIN_READBACK" : command.phase === "bootstrap-python-readback" ? "BOOTSTRAP_PYTHON" : "INTERNAL");
    const output=decodeOutput(result.stdout);
    if(command.phase==='system-packages-readback'){
      packages=output.trimEnd().split('\n').map(line=>{
        const fields=line.split('\t');
        if(fields.length!==3||!/^[a-z0-9][a-z0-9+.-]*$/u.test(fields[0])||!/^[a-zA-Z0-9.+:~_-]+$/u.test(fields[1])||!['arm64','all'].includes(fields[2]))fail('TOOLCHAIN_READBACK','output');
        return {name:fields[0],version:fields[1],architecture:fields[2]};
      });
      if(packages.length===0)fail('TOOLCHAIN_READBACK','output');
    }
    if(command.phase==='bootstrap-python-readback'){
      const match=/^Python (3)\.(\d+)\.(\d+)(?:\r?\n)?$/u.exec(output);
      if(!match||Number(match[2])<11)fail('BOOTSTRAP_PYTHON',command.phase);
      observedPython=output.trim();
    }
    if(command.phase==='bootstrap-extract'){
      let receipt;try{receipt=JSON.parse(output);}catch{fail('CAPSULE_EXTRACT','bootstrap-extract');}
      if(receipt?.schema!=='nebular.native-input-extraction.v1'||receipt.status!=='passed-inputs-only'
        ||receipt.archiveSha256!==SOURCE_ARCHIVE_SHA256||receipt.members!==SOURCE_ARCHIVE_MEMBERS
        ||receipt.executedMembers!==false||receipt.nativeBuild!==false)fail('CAPSULE_EXTRACT','bootstrap-extract');
      bootstrapPhase = "bootstrap-verifier-copy";
      await copyRegularExclusive(spec.verifierBinding,join(paths.bootstrapStudio,'authenticated-inputs/tooling/binding.json'));
      await copyRegularExclusive(spec.verifierTarball,join(paths.bootstrapStudio,'authenticated-inputs/tooling-tarball/openpgp-6.3.1.tgz'));
    }
    if (command.phase === "toolchain-readback-node" && !/^v22\.23\.4(?:\r?\n)?$/u.test(decodeOutput(result.stdout))) fail("TOOLCHAIN_READBACK", command.phase);
    if (command.phase === "toolchain-readback-npm" && !/^10\.9\.9(?:\r?\n)?$/u.test(decodeOutput(result.stdout))) fail("TOOLCHAIN_READBACK", command.phase);
    if (command.phase === "toolchain-readback-rustc" && !/^rustc 1\.98\.0 /u.test(decodeOutput(result.stdout))) fail("TOOLCHAIN_READBACK", command.phase);
    if (command.phase === "toolchain-readback-target" && !/^host: aarch64-unknown-linux-gnu$/mu.test(decodeOutput(result.stdout))) fail("TOOLCHAIN_READBACK", command.phase);
    if (command.phase === "toolchain-readback-cargo" && !/^cargo 1\.98\.0 /u.test(decodeOutput(result.stdout))) fail("TOOLCHAIN_READBACK", command.phase);
  }
  bootstrapPhase = "native-headers";
  let verifiedHeaders;
  try {
    const nodeReceipt = await revalidateAuthenticatedRuntime(paths);
    verifiedHeaders = await materializeNodeHeaders({
      archivePath: join(paths.nodeDownload, 'node-v22.23.4-linux-arm64.tar.xz'),
      authenticatedReceipt: nodeReceipt, scratchRoot: paths.campaign, processPort: port,
    });
    const nativeOwner = await import(pathToFileURL(join(paths.bootstrapTools, 'sidecar-common.mjs')).href);
    if (await nativeOwner.nativeHeaderIdentity(resolve(dirname(paths.node), '../include/node')) !== verifiedHeaders.identity
        || await nativeOwner.nativeHeaderIdentity(verifiedHeaders.root) !== verifiedHeaders.identity) {
      fail('NATIVE_ADDON_VALIDATE', 'NATIVE_ADDON_VALIDATE');
    }
  } catch {
    // Header helper categories and raw subprocess output remain private.
    fail('NATIVE_ADDON_VALIDATE', 'NATIVE_ADDON_VALIDATE');
  }
  bootstrapPhase = "write-state";
  paths.nativeHeaders = verifiedHeaders;
  await writeExclusiveJson(spec.hostSpec, buildLinuxHostSpec(paths));
  await writeExclusiveJson(spec.spec, spec);
  await writeExclusiveJson(outputPath, {
    schema: "nebular-linux-arm64-source-bootstrap-receipt-v1",
    status: "bootstrap-complete-source-only",
    target: TARGET,
    sourceArchiveSha256: SOURCE_ARCHIVE_SHA256,
    verifierBindingSha256: VERIFIER_BINDING_SHA256,
    openpgpTarballSha256: OPENPGP_TARBALL_SHA256,
    node: NODE_VERSION,
    npm: NPM_VERSION,
    rustc: RUST_VERSION,
    cargo: CARGO_VERSION,
    python: observedPython,
    packages,
    nativeHeaders: { schema: verifiedHeaders.schema, identity: verifiedHeaders.identity,
      files: verifiedHeaders.files, target: verifiedHeaders.target, version: verifiedHeaders.version,
      archiveSha256: verifiedHeaders.archiveSha256, setupNodeHeadersEqual: true,
      setupRuntimeEqualToAuthenticated: true },
    copiedVerifierSlots: ["authenticated-inputs/tooling/binding.json", "authenticated-inputs/tooling-tarball/openpgp-6.3.1.tgz"],
    nativeBinaryArtifacts: false,
    rustTestCompilation: false,
    packaging: false,
    guiLaunch: false,
    publication: false,
  });
  } catch (error) {
    throw bootstrapFailure(error, bootstrapPhase);
  }
}

export async function loadMaintained(root) {
  const api={};
  for(const name of ['candidate-provenance.mjs','create-build-inputs.mjs','build-inputs.mjs','material-profile-admission.mjs','native-candidate-build.mjs']){
    const module=await import(pathToFileURL(join(root,name)).href);
    for(const [key,value] of Object.entries(module)){
      if(Object.hasOwn(api,key)&&api[key]!==value)fail('HOST_INPUTS','maintained-api');
      api[key]=value;
    }
  }
  const native=await import(pathToFileURL(join(root,'sidecar-common.mjs')).href);
  api.nativeHeaderIdentity=native.nativeHeaderIdentity;
  api.validateSourceBuiltNative=native.validateSourceBuiltNative;
  return Object.freeze(api);
}
function decodeOutput(bytes){
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('TOOLCHAIN_READBACK','output');}
}
export async function runRuntime(spec, env, outputPath) {
  validateWorkflowContext(env, spec.input);
  const paths = spec.paths;
  await revalidateAuthenticatedRuntime(paths);
  let maintained;try{maintained=await loadMaintained(spec.maintainedApi);}catch{fail("HOST_INPUTS","maintained-api");}
  if (!record(maintained) || typeof maintained.loadBuildInputs !== "function") fail("HOST_INPUTS", "prepare-host-inputs");
  const processPort = createLinuxRustProcessPort();
  const envForCommands = commandEnvironment(paths, env);
  const ports = createRuntimePorts(paths, processPort, envForCommands);
  const hostSpec = JSON.parse(await readFile(spec.hostSpec, "utf8"));
  const result = await runLinuxSourceRustCheckpoint({
    env,
    input: spec.input,
    hostSpec,
    ports,
    maintained,
    authority: (buildInputsPath) => maintained.loadBuildInputs(buildInputsPath),
    stageOutput: paths.stageOutput,
  });
  await writeExclusiveJson(outputPath, result);
  if(result.status!=="passed-process-observation") fail(result.failureCode ?? "INTERNAL",result.failureStage ?? "driver");
  return result;
}

// Production adapter: stage and Cargo receive only their explicitly prepared
// environments. Bootstrap GitHub/rustup state is scoped to archive extraction.
export function createRuntimePorts(paths, processPort, envForCommands) {
  return {
    run: (command) => processPort.run({ ...command, env: { ...command.env }, maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES, timeoutMs: COMMAND_TIMEOUT_MS }),
    rustRun: (command) => processPort.run({ ...command, env: { ...command.env }, maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES, timeoutMs: COMMAND_TIMEOUT_MS }),
    archive: {
      extractVerified: async ({ archivePath, archiveSha256, destination }) => {
        const result = await processPort.run({ phase: "archive-extract", program: paths.python, args: ["-B", paths.unpacker, "--archive", archivePath, "--sha256", archiveSha256, "--output", destination], cwd: paths.campaign, env: envForCommands, maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES, timeoutMs: COMMAND_TIMEOUT_MS });
        if (!record(result) || result.exitCode !== 0 || result.failure != null || result.signal != null || result.cleanup !== "leader-close-observed") fail("CAPSULE_EXTRACT", "prepare-host-inputs");
      },
    },
  };
}

async function cli(argv, env = {...process.env}) {
  if(process.platform!=="linux"||process.arch!=="arm64")fail("WORKFLOW_GUARD","guard");
  if (!record(env)) fail("WORKFLOW_GUARD", "guard");
  const mode = argv[0];
  if (mode === "--bootstrap") {
    const output = absolute(argv[2] ?? join(absolute(env.RUNNER_TEMP, "WORKFLOW_GUARD"), "nebular-linux/evidence/bootstrap.json"), "SPEC_INVALID");
    const spec = buildLinuxSpec(env);
    if(output!==join(spec.paths.evidence,"bootstrap.json"))fail("SPEC_INVALID","usage");
    if(argv.length!==3||argv[1]!=="--output")fail("SPEC_INVALID","usage");
    await bootstrapRuntime(spec, env, output);
    return;
  }
  if (mode === "--run") {
    const specPath = join(absolute(env.RUNNER_TEMP, "WORKFLOW_GUARD"), "nebular-linux/spec.json");
    const spec = JSON.parse(await readFile(specPath, "utf8"));
    const output = absolute(argv[2] ?? join(absolute(env.RUNNER_TEMP, "WORKFLOW_GUARD"), "nebular-linux/evidence/checkpoint.json"), "SPEC_INVALID");
    if(output!==join(spec.paths.evidence,"checkpoint.json"))fail("SPEC_INVALID","usage");
    if(argv.length!==3||argv[1]!=="--output")fail("SPEC_INVALID","usage");
    await runRuntime(spec, env, output);
    return;
  }
  fail("SPEC_INVALID", "usage");
}

export function failureReceipt(error) {
  const receipt={schema:DRIVER_SCHEMA,status:'failed',failureCode:publicFailure(error),
    failureStage:publicStage(error),nativeAcceptance:'not-claimed',publication:false};
  if(error instanceof LinuxNativeDriverError && BOOTSTRAP_PHASES.includes(ownData(error,'bootstrapPhase'))
      && BOOTSTRAP_REASONS.includes(ownData(error,'bootstrapReason'))) {
    receipt.bootstrapPhase=ownData(error,'bootstrapPhase');
    receipt.bootstrapReason=ownData(error,'bootstrapReason');
    const exit=ownData(error,'bootstrapExitCode');
    receipt.bootstrapExitCode=Number.isInteger(exit)&&exit>=0&&exit<=255?exit:null;
  }
  return receipt;
}
async function retainCliFailure(error,argv,env){
  try{
    validateWorkflowContext(env,{confirm_linux_source_rust:true,environment:{}});
    if(process.platform!=='linux'||process.arch!=='arm64')return;
    const name=argv[0]==='--bootstrap'?'bootstrap-failure.json':argv[0]==='--run'?'checkpoint-failure.json':null;
    if(!name)return;
    const root=join(env.RUNNER_TEMP,'nebular-linux');
    if(!(await lstat(root)).isDirectory()||await realpath(root)!==root)return;
    await writeExclusiveJson(join(root,'evidence',name),failureReceipt(error));
  }catch{/* Best effort only: preserve the original nonzero failure even if storage fails. */}
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    await cli(process.argv.slice(2));
  } catch (error) {
    await retainCliFailure(error,process.argv.slice(2),{...process.env});
    const code = publicFailure(error);
    process.stderr.write(`SOURCE_NATIVE_${code}\n`);
    process.exitCode = 1;
  }
}

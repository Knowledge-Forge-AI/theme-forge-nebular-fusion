#!/usr/bin/env node
// Diagnostic-only Linux closure qualification for an already sealed Nebular candidate.
//
// The workflow owns checkout, package installation, smoke execution and publication of the
// diagnostic report. This module owns the fail-closed identity chain, deterministic extraction,
// ELF classification and evidence. It uses only Node's standard library and maintained identity
// modules.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync,
  statSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_RELEASE_IDENTITY } from "./node-runtime-authority.mjs";
import { PLATFORMS } from "./native-rc-package.mjs";
import { paths } from "./native-rc-qualify.mjs";

export const TARGETS = Object.freeze({
  "linux-arm64": Object.freeze({ platform: "linux-arm64", machine: "AArch64", interpreter: "/lib/ld-linux-aarch64.so.1" }),
  "linux-x64": Object.freeze({ platform: "linux-x64", machine: "Advanced Micro Devices X86-64", interpreter: "/lib64/ld-linux-x86-64.so.2" }),
});
export const DEFAULT_GLIBC_FLOOR = "2.28";
export const PACKAGE_SCHEMA = "nebular.native-rc-package-v1";
export const SEALED_SCHEMA = "nebular.native-rc-evidence-v1";
export const REPORT_SCHEMA = "nebular.linux-elf-closure-v3";
const HASH = /^[a-f0-9]{64}$/;
const GIT_OBJECT = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SAFE_NAME = /^(?!\.\.?$)[^/\\\0]+$/;

export class ClosureError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ClosureError";
    Object.assign(this, details);
  }
}

function failure(message, kind = "identity", details = {}) {
  throw new ClosureError(message, { kind, ...details });
}

export function compareVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function maximumVersion(values) {
  const versions = values.filter(Boolean).map(String);
  return versions.length === 0 ? null : versions.sort(compareVersions).at(-1);
}

function checkedRegular(path, label) {
  if (!existsSync(path)) failure(`${label} is missing: ${path}`);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) failure(`${label} is not a regular file: ${path}`);
  return info;
}

function checkedDirectory(path, label) {
  if (!existsSync(path)) failure(`${label} is missing: ${path}`);
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) failure(`${label} is not a regular directory: ${path}`);
  return info;
}

function readJson(path, label = path) {
  const info = checkedRegular(path, label);
  if (info.size > 16 * 1024 * 1024) failure(`${label} exceeds the JSON evidence limit`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failure(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function sha256File(path) {
  checkedRegular(path, "candidate file");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function checkedHash(value, label) {
  if (!HASH.test(value ?? "")) failure(`${label} is not a SHA-256 digest`);
  return value;
}

function checkedGitObject(value, label) {
  if (!GIT_OBJECT.test(value ?? "")) failure(`${label} must be a full lowercase 40-hex Git object id`);
  return value;
}

function checkedName(value, label) {
  if (!SAFE_NAME.test(value ?? "")) failure(`${label} is not a plain candidate filename`);
  return value;
}

function sortedNames(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertSealedRecordMatches(record, sealed) {
  const candidate = sealed.candidate;
  if (!candidate || typeof candidate !== "object") failure("sealed candidate record is missing");
  for (const field of ["version", "packageManifestSha256", "glibcMinimum"]) {
    if (stableJson(candidate[field]) !== stableJson(record[field])) failure(`sealed candidate ${field} differs from package record`);
  }
  if (stableJson(candidate.executableSha256) !== stableJson(record.raw?.executableSha256)) failure("sealed candidate executableSha256 differs from package record");
  for (const field of ["raw", "npm"]) {
    if (stableJson(candidate[field]) !== stableJson(record[field])) failure(`sealed candidate ${field} metadata differs from package record`);
  }
}

/** Verify the exact producer record, sealed evidence and downloaded candidate bytes. */
export function assertCandidateIdentity({ candidateDir, packageRecordPath, sealedEvidencePath, platform, sourceCommit, sourceTree, sealedEvidenceSha256 }) {
  checkedDirectory(candidateDir, "candidate directory");
  const record = readJson(packageRecordPath, "package-record.json");
  const sealed = readJson(sealedEvidencePath, "rc-evidence.json");
  const target = TARGETS[platform];
  const platformDefinition = PLATFORMS[platform];
  if (!target || !platformDefinition || platformDefinition.os !== "linux") failure(`unsupported Linux platform: ${platform}`);
  checkedGitObject(sourceCommit, "source commit");
  checkedGitObject(sourceTree, "source tree");
  checkedHash(sealedEvidenceSha256, "sealed evidence digest");
  if (sha256File(sealedEvidencePath) !== sealedEvidenceSha256) failure("downloaded rc-evidence.json differs from the producer evidence digest");
  if (record.schema !== PACKAGE_SCHEMA) failure(`package record schema is ${record.schema ?? "missing"}`);
  if (sealed.schema !== SEALED_SCHEMA) failure(`sealed evidence schema is ${sealed.schema ?? "missing"}`);
  if (record.platform !== platform) failure(`package record platform ${record.platform ?? "missing"} differs from ${platform}`);
  if (sealed.status !== "pass") failure(`sealed candidate status is ${sealed.status ?? "missing"}`);
  if (sealed.lane !== platform) failure(`sealed candidate lane ${sealed.lane ?? "missing"} differs from ${platform}`);
  if (sealed.platform !== platform) failure(`sealed candidate platform ${sealed.platform ?? "missing"} differs from ${platform}`);
  if (sealed.source?.commit !== sourceCommit) failure("sealed candidate source commit differs from the reviewed checkout");
  if (sealed.source?.tree !== sourceTree) failure("sealed candidate source tree differs from the reviewed checkout");
  if (!VERSION.test(record.version ?? "")) failure("package record version is not a semantic version");
  assertSealedRecordMatches(record, sealed);

  const rawName = checkedName(record.raw?.filename, "package-record raw filename");
  const npmName = checkedName(record.npm?.filename, "package-record npm filename");
  if (rawName !== platformDefinition.rawName(record.version)) failure(`raw filename ${rawName} is not the maintained ${platform} target filename`);
  if (!npmName.endsWith(".tgz")) failure("package-record npm filename is not an npm tarball");
  const rawHash = checkedHash(record.raw?.sha256, "package-record raw hash");
  const npmHash = checkedHash(record.npm?.sha256, "package-record npm hash");
  checkedHash(record.raw?.executableSha256, "package-record executable hash");
  for (const [label, value] of [["raw", record.raw?.size], ["npm", record.npm?.size]]) {
    if (!Number.isSafeInteger(value) || value < 0) failure(`package-record ${label} size is invalid`);
  }

  const sealedFiles = sealed.candidate?.files;
  if (!Array.isArray(sealedFiles) || sealedFiles.length !== 2) failure("sealed candidate file list must contain exactly two packaged files");
  const sealedByName = new Map();
  for (const file of sealedFiles) {
    const name = checkedName(file?.name, "sealed candidate filename");
    if (sealedByName.has(name)) failure(`sealed candidate repeats ${name}`);
    sealedByName.set(name, checkedHash(file?.sha256, `sealed hash for ${name}`));
  }
  const actualEntries = readdirSync(candidateDir, { withFileTypes: true });
  if (actualEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) failure("candidate directory contains a non-regular entry");
  const actualNames = sortedNames(actualEntries.map((entry) => entry.name));
  const expectedNames = sortedNames([rawName, npmName]);
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) failure(`candidate files ${actualNames.join(", ")} differ from package record ${expectedNames.join(", ")}`);
  if (JSON.stringify(sortedNames([...sealedByName.keys()])) !== JSON.stringify(expectedNames)) failure("sealed candidate file list differs from the package record");
  const files = actualNames.map((name) => {
    const path = join(candidateDir, name);
    const digest = sha256File(path);
    const size = statSync(path).size;
    if (digest !== sealedByName.get(name)) failure(`${name} differs from sealed rc-evidence`);
    const expected = name === rawName ? rawHash : npmHash;
    const expectedSize = name === rawName ? record.raw.size : record.npm.size;
    if (digest !== expected) failure(`${name} differs from package-record digest`);
    if (size !== expectedSize) failure(`${name} size ${size} differs from package-record size ${expectedSize}`);
    return { name, sha256: digest, size };
  });
  const raw = files.find((file) => file.name === rawName);
  return { platform, target, platformDefinition, record, sealed, files, raw: { ...raw, path: join(candidateDir, rawName) } };
}

export function assertEmptyDirectory(path) {
  if (existsSync(path)) {
    checkedDirectory(path, "extraction directory");
    if (readdirSync(path).length !== 0) failure("extraction directory must be empty");
  } else mkdirSync(path, { recursive: true, mode: 0o755 });
}

function defaultRunner(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LANG: "C", LC_ALL: "C" } });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error?.message ?? null };
}

/** Run a fixed tool invocation. An injected runner is used only by unit tests. */
export function runTool(command, args, { allowFailure = false, runner = defaultRunner } = {}) {
  const result = runner(command, args);
  const normalized = { status: result?.status ?? null, stdout: result?.stdout ?? "", stderr: result?.stderr ?? "", error: result?.error ?? null };
  if (!allowFailure && (normalized.error || normalized.status !== 0)) failure(`${command} ${args.join(" ")} failed${normalized.status === null ? " without a status" : ` (${normalized.status})`}: ${normalized.error || normalized.stderr || normalized.stdout}`, "environment", { command, args, result: normalized });
  return normalized;
}

function commandRecord(result) {
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, ...(result.error ? { error: result.error } : {}) };
}

function memberPath(line) {
  return line.trim().split(/\s+/).at(-1) ?? "";
}

export function extractRawArchive({ rawPath, extractDir, arch = "linux-x64", runner = defaultRunner }) {
  checkedRegular(rawPath, "raw candidate archive");
  assertEmptyDirectory(extractDir);
  let listing;
  try {
    listing = runTool("tar", ["-tvzf", rawPath], { runner });
  } catch (error) {
    if (error instanceof ClosureError) error.kind = "identity";
    throw error;
  }
  const members = listing.stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  if (members.length === 0) failure("raw archive is empty");
  for (const line of members) {
    const type = line[0];
    const name = memberPath(line).replace(/\/$/, "");
    const underRoot = name === "theme-forge-nebular-fusion" || name.startsWith("theme-forge-nebular-fusion/");
    if (!/[\-d]/.test(type) || !name || name.includes(" ") || name.includes("\\") || name.startsWith("/") || name.split("/").includes("..") || !underRoot) failure(`raw archive contains an unsafe or unexpected member: ${line}`);
  }
  try {
    runTool("tar", ["-xzf", rawPath, "-C", extractDir, "--no-same-owner"], { runner });
  } catch (error) {
    if (error instanceof ClosureError) error.kind = "identity";
    throw error;
  }
  return assertLinuxPayloadRoot(extractDir, { arch });
}

function targetFor(arch) {
  const target = TARGETS[arch];
  const platform = PLATFORMS[arch];
  if (!target || !platform || platform.os !== "linux") failure(`unsupported Linux platform: ${arch}`);
  return { target, platform };
}

export function assertLinuxPayloadRoot(extractDir, { arch = "linux-x64" } = {}) {
  checkedDirectory(extractDir, "extraction directory");
  const roots = readdirSync(extractDir, { withFileTypes: true });
  if (roots.length !== 1 || roots[0].name !== "theme-forge-nebular-fusion" || !roots[0].isDirectory() || roots[0].isSymbolicLink()) failure("raw archive does not extract to the exact theme-forge-nebular-fusion root");
  const payloadRoot = join(extractDir, "theme-forge-nebular-fusion");
  const located = paths(targetFor(arch).platform, payloadRoot);
  for (const [path, executable] of [[located.executable, true], [located.sidecar, true], [located.launcher, true], [located.resources, false]]) {
    const info = executable ? checkedRegular(path, relative(payloadRoot, path)) : checkedDirectory(path, relative(payloadRoot, path));
    if (executable && (info.mode & 0o111) === 0) failure(`${relative(payloadRoot, path)} is not executable`);
  }
  return payloadRoot;
}

function parseField(text, name) {
  const match = text.match(new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, "m"));
  return match?.[1]?.trim() ?? null;
}

export function parseElfHeader(text, { arch, interpreterRequired = true } = {}) {
  const { target } = targetFor(arch);
  const className = parseField(text, "Class");
  const data = parseField(text, "Data");
  const type = parseField(text, "Type");
  const machine = parseField(text, "Machine");
  const interpreter = text.match(/Requesting program interpreter:\s*([^\s\]]+)/)?.[1] ?? null;
  if (className !== "ELF64") failure(`ELF class ${className ?? "missing"} is not ELF64`);
  if (data !== "2's complement, little endian") failure(`ELF data encoding ${data ?? "missing"} is not little endian`);
  if (machine !== target.machine) failure(`ELF machine ${machine ?? "missing"} is not ${target.machine}`);
  if (interpreterRequired && interpreter !== target.interpreter) failure(`ELF interpreter ${interpreter ?? "missing"} is not ${target.interpreter}`);
  return { class: className, data, type, machine, interpreter };
}

export function glibcVersions(text) {
  return [...new Set([...String(text).matchAll(/GLIBC_(\d+(?:\.\d+){1,2})/g)].map((match) => match[1]))].sort(compareVersions);
}

export function parseNeeded(text) {
  return [...String(text).matchAll(/Shared library:\s*\[([^\]]+)\]/g)].map((match) => match[1]).sort();
}

export function validateLdd({ status, stdout, stderr, path }) {
  const combined = `${stdout}\n${stderr}`;
  if (status !== 0) failure(`ldd failed for ${path}: ${stderr || stdout}`, "closure");
  if (/(?:not found|version `GLIBC_[^']+' not found)/.test(combined)) failure(`unresolved libraries for ${path}: ${combined.split("\n").filter((line) => /not found/.test(line)).join("; ")}`, "closure");
  return stdout;
}

function readMagic(path) {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(4);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    return count === 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
  } finally { closeSync(fd); }
}

function walkFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) failure(`payload contains a symbolic link: ${relative(root, path)}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else failure(`payload contains an unsupported entry: ${relative(root, path)}`);
    }
  };
  visit(root);
  return files;
}

function parseRuntimeGlibc(result) {
  return `${result.stdout}\n${result.stderr}`.match(/(?:GLIBC|glibc)[^0-9]*(\d+\.\d+)/i)?.[1]
    ?? `${result.stdout}\n${result.stderr}`.match(/(\d+\.\d+)/)?.[1] ?? null;
}

function programFacts(text) {
  const lines = String(text).split("\n");
  return { hasInterpreter: lines.some((line) => /^\s*INTERP\s/.test(line)) || /Requesting program interpreter:/.test(text), hasDynamic: lines.some((line) => /^\s*DYNAMIC\s/.test(line)) };
}

function issue(entry, message, kind = "identity") {
  entry.problems ??= [];
  entry.problems.push({ kind, message });
}

function inspectOne(path, payloadRoot, arch, runner) {
  const relativePath = relative(payloadRoot, path).split("\\").join("/");
  const entry = { path: relativePath, status: "fail", mode: (statSync(path).mode & 0o777).toString(8), problems: [] };
  const headerResult = runTool("readelf", ["-hW", "--", path], { allowFailure: true, runner });
  const programResult = runTool("readelf", ["-lW", "--", path], { allowFailure: true, runner });
  entry.readelf = { header: commandRecord(headerResult), program: commandRecord(programResult) };
  if (headerResult.status !== 0 || programResult.status !== 0) { issue(entry, `readelf header/program inspection failed for ${relativePath}`, "environment"); return entry; }
  try { entry.header = parseElfHeader(`${headerResult.stdout}\n${programResult.stdout}`, { arch, interpreterRequired: false }); }
  catch (error) { issue(entry, error instanceof Error ? error.message : String(error), "identity"); return entry; }
  entry.program = programFacts(programResult.stdout);
  const type = entry.header.type ?? "";
  if (entry.program.hasInterpreter && entry.program.hasDynamic && /^(?:DYN|EXEC)\b/.test(type)) {
    entry.linkage = "dynamic-executable";
    if (entry.header.interpreter !== TARGETS[arch].interpreter) issue(entry, `ELF interpreter ${entry.header.interpreter ?? "missing"} is not ${TARGETS[arch].interpreter}`, "identity");
  } else if (!entry.program.hasInterpreter && entry.program.hasDynamic && /^DYN\b/.test(type)) entry.linkage = "shared-object";
  else if (!entry.program.hasInterpreter && !entry.program.hasDynamic && /^(?:EXEC|REL)\b/.test(type)) entry.linkage = "static";
  else { issue(entry, `unsupported ELF linkage for ${relativePath}`, "identity"); return entry; }

  if (entry.program.hasDynamic) {
    const dynamicResult = runTool("readelf", ["-dW", "--", path], { allowFailure: true, runner });
    const versionResult = runTool("readelf", ["--version-info", "--wide", "--", path], { allowFailure: true, runner });
    entry.readelf.dynamic = commandRecord(dynamicResult);
    entry.readelf.versionInfo = commandRecord(versionResult);
    entry.needed = parseNeeded(dynamicResult.stdout);
    entry.glibcSymbols = glibcVersions(versionResult.stdout);
    if (dynamicResult.status !== 0) issue(entry, `readelf dynamic inspection failed for ${relativePath}`, "environment");
    if (versionResult.status !== 0) issue(entry, `readelf version inspection failed for ${relativePath}`, "environment");
    const lddResult = runTool("ldd", [path], { allowFailure: true, runner });
    entry.ldd = commandRecord(lddResult);
    try { validateLdd({ ...lddResult, path: relativePath }); }
    catch (error) { issue(entry, error instanceof Error ? error.message : String(error), error?.kind ?? "closure"); }
  } else {
    entry.readelf.dynamic = { status: "not-run", stdout: "", stderr: "" };
    entry.readelf.versionInfo = { status: "not-run", stdout: "", stderr: "" };
    entry.needed = [];
    entry.glibcSymbols = [];
    entry.ldd = { status: "not-run", stdout: "", stderr: "" };
  }
  entry.status = entry.problems.length === 0 ? "pass" : "fail";
  return entry;
}

/** Inventory every ELF member and retain all readelf/ldd output on failures. */
export function inspectElfClosure({ payloadRoot, arch, glibcFloor = null, expectedRuntimeGlibc = null, runner = defaultRunner }) {
  checkedDirectory(payloadRoot, "payload root");
  const files = walkFiles(payloadRoot);
  const inventory = [];
  const problems = [];
  const failureKinds = new Set();
  const runtimeResult = runTool("ldd", ["--version"], { allowFailure: true, runner });
  const runtimeGlibc = parseRuntimeGlibc(runtimeResult);
  const runtimeMismatch = Boolean(expectedRuntimeGlibc && runtimeGlibc && runtimeGlibc !== expectedRuntimeGlibc);
  if (runtimeResult.status !== 0 || !runtimeGlibc) { problems.push("unable to parse the runtime glibc version"); failureKinds.add("environment"); }
  if (expectedRuntimeGlibc && runtimeGlibc !== expectedRuntimeGlibc) { problems.push(`runtime glibc ${runtimeGlibc ?? "missing"} is not the expected ${expectedRuntimeGlibc}`); failureKinds.add("environment"); }
  for (const path of files) {
    if (!readMagic(path)) continue;
    let entry;
    try { entry = inspectOne(path, payloadRoot, arch, runner); }
    catch (error) { entry = { path: relative(payloadRoot, path).split("\\").join("/"), status: "fail", problems: [{ kind: error?.kind ?? "environment", message: error instanceof Error ? error.message : String(error) }] }; }
    inventory.push(entry);
    for (const problem of entry.problems ?? []) { problems.push(`${entry.path}: ${problem.message}`); failureKinds.add(problem.kind); }
  }
  const allVersions = inventory.flatMap((entry) => entry.glibcSymbols ?? []);
  const maximumGlibc = maximumVersion(allVersions);
  if (inventory.length === 0) { problems.push("payload contains no ELF members"); failureKinds.add("identity"); }
  const located = paths(TARGETS[arch] ? PLATFORMS[arch] : PLATFORMS["linux-x64"], payloadRoot);
  for (const [label, path] of [["GUI", located.executable], ["sidecar", located.sidecar]]) {
    const relativePath = relative(payloadRoot, path).split("\\").join("/");
    const entry = inventory.find((candidate) => candidate.path === relativePath);
    if (!entry || entry.linkage !== "dynamic-executable") { problems.push(`${label} must be a dynamic executable with the target interpreter`); failureKinds.add("identity"); }
  }
  if (glibcFloor && (!maximumGlibc || compareVersions(maximumGlibc, glibcFloor) > 0)) { problems.push(`maximum required GLIBC_${maximumGlibc ?? "missing"} exceeds the ${glibcFloor} policy floor`); failureKinds.add("closure"); }
  if (runtimeGlibc && maximumGlibc && compareVersions(maximumGlibc, runtimeGlibc) > 0) {
    problems.push(`maximum required GLIBC_${maximumGlibc} exceeds runtime ${runtimeGlibc}`);
    failureKinds.add(runtimeMismatch ? "environment" : "closure");
  }
  const glibcFloorExceeded = Boolean(glibcFloor && maximumGlibc && compareVersions(maximumGlibc, glibcFloor) > 0);
  if (problems.length > 0) throw new ClosureError(`Linux ELF closure inspection failed: ${problems.join("; ")}`, { kind: failureKinds.has("identity") ? "identity" : failureKinds.has("environment") ? "environment" : "closure", inventory, runtimeGlibc, glibcMinimum: maximumGlibc, problems, failureKinds: [...failureKinds], glibcFloorExceeded, runtimeMismatch });
  return { inventory, runtimeGlibc, glibcMinimum: maximumGlibc };
}

export function readProbe(path) {
  if (!path) return null;
  let probe;
  try {
    probe = readJson(path, "system-library-probe.json");
  } catch (error) {
    if (error instanceof ClosureError) error.kind = "environment";
    throw error;
  }
  if (probe.schema !== "nebular.linux-system-library-probe-v1" || !Number.isInteger(probe.probeStatus) || probe.probeStatus !== 0) failure("system library probe did not complete successfully", "environment");
  if (!Array.isArray(probe.libraries) || !Array.isArray(probe.missing) || typeof probe.expectedMissingGui !== "boolean") failure("system library probe schema is invalid", "environment");
  const ids = probe.libraries.map((library) => library?.id);
  if (ids.some((id) => typeof id !== "string" || id.length === 0) || new Set(ids).size !== ids.length) failure("system library probe contains invalid or duplicate library ids", "environment");
  if (probe.libraries.some((library) => typeof library.soname !== "string" || typeof library.available !== "boolean")) failure("system library probe contains an invalid library observation", "environment");
  const missing = probe.missing.slice().sort();
  if (missing.some((id) => typeof id !== "string") || new Set(missing).size !== missing.length) failure("system library probe contains invalid or duplicate missing ids", "environment");
  const observedMissing = probe.libraries.filter((library) => !library.available).map((library) => library.id).sort();
  if (JSON.stringify(missing) !== JSON.stringify(observedMissing)) failure("system library probe missing list contradicts its library observations", "environment");
  return probe;
}

export function classifyFailure(error, { lane, probe } = {}) {
  if (error?.kind === "identity" || error?.failureKinds?.includes("identity")) return "identity";
  if (error?.glibcFloorExceeded && lane === "manylinux_2_28_baseline" && error?.runtimeGlibc && !error?.runtimeMismatch && !error?.failureKinds?.includes("environment")) return "closure-negative:glibc-floor-exceeded";
  if (error?.failureKinds?.includes("environment")) return "environment";
  if (error?.failureKinds?.includes("closure") && probe?.expectedMissingGui && probe.missing?.length && lane === "manylinux_2_28_baseline") return "closure-negative:system-library-unavailable";
  if (lane !== "manylinux_2_28_baseline" && probe && !probe.expectedMissingGui && probe.missing?.length) return "environment";
  if (error?.failureKinds?.length && error.failureKinds.every((kind) => kind === "closure")) return "closure-failure";
  return "environment";
}

function candidateSummary(identity) {
  const { path: _rawPath, ...raw } = identity.raw;
  return { files: identity.files, raw, packageRecord: identity.record };
}

function assertPayloadIdentity(identity, payloadRoot, arch) {
  const located = paths(identity.platformDefinition, payloadRoot);
  const gui = sha256File(located.executable);
  const sidecar = sha256File(located.sidecar);
  const expectedRuntime = NODE_RELEASE_IDENTITY.targets[identity.platformDefinition.triple];
  if (gui !== identity.record.raw.executableSha256) failure("extracted GUI executable differs from package-record executable identity");
  if (!expectedRuntime || sidecar !== expectedRuntime.executableSha256 || statSync(located.sidecar).size !== expectedRuntime.executableSize) failure(`bundled sidecar is not the authenticated Node ${NODE_RELEASE_IDENTITY.version} runtime for ${arch}`);
  return { gui: { path: relative(payloadRoot, located.executable), sha256: gui, size: statSync(located.executable).size }, sidecar: { path: relative(payloadRoot, located.sidecar), sha256: sidecar, size: statSync(located.sidecar).size, nodeVersion: NODE_RELEASE_IDENTITY.version } };
}

export function qualify(options) {
  const reportPath = resolve(options.report);
  let probe = null;
  const base = { schema: REPORT_SCHEMA, status: "fail", classification: "identity", negativeEvidence: false, platform: options.arch ?? null, lane: options.lane ?? null, image: options.image ?? null, source: { commit: options.sourceCommit ?? null, tree: options.sourceTree ?? null }, observations: { systemLibraries: probe }, problems: [] };
  let result = base;
  let identity = null;
  let payloadIdentity = null;
  try {
    probe = readProbe(options.systemLibraryProbe);
    base.observations.systemLibraries = probe;
    identity = assertCandidateIdentity({ candidateDir: resolve(options.candidateDir), packageRecordPath: resolve(options.packageRecord), sealedEvidencePath: resolve(options.sealedEvidence), platform: options.arch, sourceCommit: options.sourceCommit, sourceTree: options.sourceTree, sealedEvidenceSha256: options.sealedEvidenceSha256 });
    const payloadRoot = extractRawArchive({ rawPath: identity.raw.path, extractDir: resolve(options.extractDir), arch: options.arch });
    payloadIdentity = assertPayloadIdentity(identity, payloadRoot, options.arch);
    const inspection = inspectElfClosure({ payloadRoot, arch: options.arch, glibcFloor: options.glibcFloor || (options.lane === "manylinux_2_28_baseline" ? DEFAULT_GLIBC_FLOOR : null), expectedRuntimeGlibc: options.expectedRuntimeGlibc });
    const probeContradiction = probe && (probe.expectedMissingGui || probe.missing.length > 0);
    if (probeContradiction) result = { ...base, classification: "environment", runtimeGlibc: inspection.runtimeGlibc, glibcMinimum: inspection.glibcMinimum, payloadIdentity, candidate: candidateSummary(identity), elf: inspection.inventory, problems: ["system-library-probe contradicts successful ELF closure inspection"] };
    else {
      result = { ...base, status: "pass", classification: "pass", runtimeGlibc: inspection.runtimeGlibc, glibcMinimum: inspection.glibcMinimum, payloadIdentity, candidate: candidateSummary(identity), payloadRoot: "theme-forge-nebular-fusion", elf: inspection.inventory };
    }
  } catch (error) {
    result = { ...base, classification: classifyFailure(error, { lane: options.lane, probe }), ...(identity ? { candidate: candidateSummary(identity) } : {}), ...(payloadIdentity ? { payloadIdentity } : {}), ...(error?.inventory ? { elf: error.inventory } : {}), ...(error?.runtimeGlibc ? { runtimeGlibc: error.runtimeGlibc } : {}), ...(error?.glibcMinimum ? { glibcMinimum: error.glibcMinimum } : {}), problems: [error instanceof Error ? error.message : String(error)] };
    if (result.classification.startsWith("closure-negative:")) result.negativeEvidence = true;
  }
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o755 });
  writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return result;
}

function option(args, flag) { const index = args.indexOf(flag); return index === -1 ? undefined : args[index + 1]; }
function requiredOption(args, flag) { const value = option(args, flag); if (!value) failure(`missing required option ${flag}`); return value; }
function requiredHexOption(args, flag, length) { const value = requiredOption(args, flag); if (!(length === 40 ? GIT_OBJECT : HASH).test(value)) failure(`${flag} must be lowercase hexadecimal`); return value; }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    const options = {
      arch: requiredOption(args, "--arch"), lane: requiredOption(args, "--lane"), image: option(args, "--image") ?? null,
      candidateDir: requiredOption(args, "--candidate-dir"), packageRecord: requiredOption(args, "--package-record"), sealedEvidence: requiredOption(args, "--sealed-evidence"),
      sealedEvidenceSha256: requiredHexOption(args, "--sealed-evidence-sha256", 64), extractDir: requiredOption(args, "--extract-dir"), report: requiredOption(args, "--report"),
      sourceCommit: requiredHexOption(args, "--source-commit", 40), sourceTree: requiredHexOption(args, "--source-tree", 40), expectedRuntimeGlibc: requiredOption(args, "--expected-runtime-glibc"),
      systemLibraryProbe: requiredOption(args, "--system-library-probe"), glibcFloor: option(args, "--glibc-floor") ?? null,
    };
    const result = qualify(options);
    process.stdout.write(`${JSON.stringify({ status: result.status, classification: result.classification, lane: result.lane, glibcMinimum: result.glibcMinimum ?? null, problems: result.problems })}\n`);
    if (result.status !== "pass") process.exitCode = 1;
  } catch (error) {
    const report = option(args, "--report");
    if (report) { const fallback = { schema: REPORT_SCHEMA, status: "fail", classification: error?.kind === "identity" ? "identity" : "environment", negativeEvidence: false, problems: [error instanceof Error ? error.message : String(error)] }; try { mkdirSync(dirname(resolve(report)), { recursive: true, mode: 0o755 }); writeFileSync(resolve(report), `${JSON.stringify(fallback, null, 2)}\n`, { flag: "wx" }); } catch { /* preserve original failure */ } }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

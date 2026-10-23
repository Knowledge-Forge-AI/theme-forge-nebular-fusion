// @vitest-environment node
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, linkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { it as test } from "vitest";
import {
  assertCandidateIdentity, assertLinuxPayloadRoot, compareVersions, extractRawArchive, glibcVersions,
  classifyFailure, inspectElfClosure, maximumVersion, parseElfHeader, qualify, readProbe, validateLdd,
} from "../../tools/native-rc-linux-closure.mjs";

const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function identityFixture() {
  const root = mkdtempSync(join(tmpdir(), "nebular-linux-identity-"));
  const candidate = join(root, "candidate");
  const evidence = join(root, "evidence");
  mkdirSync(candidate, { recursive: true });
  mkdirSync(evidence, { recursive: true });
  const rawName = "theme-forge-nebular-fusion-v0.6.1-x86_64-unknown-linux-gnu.tar.gz";
  const npmName = "theme-forge-nebular-fusion-linux-x64-0.6.1.tgz";
  const rawBytes = Buffer.from("raw-candidate\n");
  const npmBytes = Buffer.from("npm-candidate\n");
  writeFileSync(join(candidate, rawName), rawBytes);
  writeFileSync(join(candidate, npmName), npmBytes);
  const record = {
    schema: "nebular.native-rc-package-v1", platform: "linux-x64", version: "0.6.1",
    packageManifestSha256: "d".repeat(64), glibcMinimum: null,
    raw: { filename: rawName, sha256: sha256(rawBytes), size: rawBytes.length, executableSha256: "c".repeat(64) },
    npm: { filename: npmName, sha256: sha256(npmBytes), size: npmBytes.length },
  };
  const sealed = {
    schema: "nebular.native-rc-evidence-v1", status: "pass", lane: "linux-x64", platform: "linux-x64",
    source: { commit: COMMIT, tree: TREE },
    candidate: {
      files: [{ name: rawName, sha256: sha256(rawBytes) }, { name: npmName, sha256: sha256(npmBytes) }],
      version: record.version, packageManifestSha256: record.packageManifestSha256, executableSha256: record.raw.executableSha256,
      glibcMinimum: record.glibcMinimum, raw: record.raw, npm: record.npm,
    },
  };
  const packageRecord = join(evidence, "package-record.json");
  const sealedEvidence = join(evidence, "rc-evidence.json");
  writeFileSync(packageRecord, `${JSON.stringify(record)}\n`);
  writeFileSync(sealedEvidence, `${JSON.stringify(sealed)}\n`);
  return { root, candidate, packageRecord, sealedEvidence, record, sealedEvidenceSha256: sha256(Buffer.from(`${JSON.stringify(sealed)}\n`)) };
}

function payloadFixture() {
  const root = mkdtempSync(join(tmpdir(), "nebular-linux-payload-"));
  const payload = join(root, "theme-forge-nebular-fusion");
  mkdirSync(join(payload, "bin"), { recursive: true });
  mkdirSync(join(payload, "lib/theme-forge-nebular-fusion"), { recursive: true });
  for (const name of ["theme-forge-nebular-fusion", "tfsb-studio-service", "tfnf"]) {
    const path = join(payload, "bin", name);
    writeFileSync(path, name === "tfnf" ? "#!/bin/sh\n" : Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    chmodSync(path, 0o755);
  }
  return { root, payload };
}

function fakeRunner({ machine = "Advanced Micro Devices X86-64", floor = "2.28", runtime = "2.36", lddFailure = false, staticPath = null, sharedPath = null } = {}) {
  return (command, args) => {
    const path = args.at(-1);
    const isStatic = staticPath && path.includes(staticPath);
    const isShared = sharedPath && path.includes(sharedPath);
    if (command === "ldd" && args[0] === "--version") return { status: 0, stdout: `ldd (GNU libc) ${runtime}\n`, stderr: "" };
    if (command === "readelf" && args[0] === "-hW") return { status: 0, stdout: `  Class: ELF64\n  Data: 2's complement, little endian\n  Type: ${isStatic ? "EXEC (Executable file)" : "DYN (Position-Independent Executable file)"}\n  Machine: ${machine}\n`, stderr: "" };
    if (command === "readelf" && args[0] === "-lW") return { status: 0, stdout: isStatic ? "  LOAD 0x0\n" : isShared ? "  LOAD 0x0\n  DYNAMIC 0x0\n" : "  INTERP 0x0 [Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]\n  DYNAMIC 0x0\n", stderr: "" };
    if (command === "readelf" && args[0] === "-dW") return { status: 0, stdout: " 0x00000001 (NEEDED) Shared library: [libc.so.6]\n", stderr: "" };
    if (command === "readelf" && args[0] === "--version-info") return { status: 0, stdout: `Name: GLIBC_${floor}\n`, stderr: "" };
    if (command === "ldd" && args.length === 1) return lddFailure ? { status: 1, stdout: "linux-vdso.so.1\n", stderr: "libgtk-3.so.0 => not found\n" } : { status: 0, stdout: "linux-vdso.so.1\nlibc.so.6 => /lib64/libc.so.6 (0x0)\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
}

function archiveFixture({ rootName = "theme-forge-nebular-fusion", symlink = false, hardlink = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nebular-linux-archive-"));
  const source = join(root, "source");
  const tree = join(source, rootName);
  mkdirSync(join(tree, "bin"), { recursive: true });
  mkdirSync(join(tree, "lib/theme-forge-nebular-fusion"), { recursive: true });
  for (const name of ["theme-forge-nebular-fusion", "tfsb-studio-service", "tfnf"]) {
    const path = join(tree, "bin", name);
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
  }
  if (symlink) symlinkSync("tfnf", join(tree, "bin/link"));
  if (hardlink) linkSync(join(tree, "bin/tfnf"), join(tree, "bin/hardlink"));
  const archive = join(root, "candidate.tar.gz");
  const result = spawnSync("tar", ["-czf", archive, "-C", source, rootName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return { root, archive, extract: join(root, "extract") };
}

test("ELF header, GLIBC ordering and ldd validation retain the exact target contract", () => {
  const header = ["  Class: ELF64", "  Data: 2's complement, little endian", "  Type: DYN (Position-Independent Executable file)", "  Machine: Advanced Micro Devices X86-64", "  [Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]"].join("\n");
  assert.deepEqual(parseElfHeader(header, { arch: "linux-x64" }), { class: "ELF64", data: "2's complement, little endian", type: "DYN (Position-Independent Executable file)", machine: "Advanced Micro Devices X86-64", interpreter: "/lib64/ld-linux-x86-64.so.2" });
  assert.throws(() => parseElfHeader(header.replace("Advanced Micro Devices X86-64", "AArch64"), { arch: "linux-x64" }), /machine/);
  assert.deepEqual(glibcVersions("Name: GLIBC_2.36\nName: GLIBC_2.2.5\nName: GLIBC_2.36"), ["2.2.5", "2.36"]);
  assert.equal(maximumVersion(["2.28", "2.2.5", "2.36"]), "2.36");
  assert.equal(compareVersions("2.10", "2.9"), 1);
  assert.throws(() => validateLdd({ status: 1, stdout: "", stderr: "not dynamic", path: "app" }), /ldd failed/);
  assert.throws(() => validateLdd({ status: 0, stdout: "", stderr: "libmissing.so => not found", path: "app" }), /unresolved/);
});

test("candidate identity binds schemas, target filename, source objects, evidence digest, bytes and sizes", () => {
  const f = identityFixture();
  try {
    const result = assertCandidateIdentity({ candidateDir: f.candidate, packageRecordPath: f.packageRecord, sealedEvidencePath: f.sealedEvidence, platform: "linux-x64", sourceCommit: COMMIT, sourceTree: TREE, sealedEvidenceSha256: f.sealedEvidenceSha256 });
    assert.equal(result.raw.name, f.record.raw.filename);
    const bad = JSON.parse(readFileSync(f.packageRecord, "utf8"));
    bad.raw.size += 1;
    writeFileSync(f.packageRecord, `${JSON.stringify(bad)}\n`);
    assert.throws(() => assertCandidateIdentity({ candidateDir: f.candidate, packageRecordPath: f.packageRecord, sealedEvidencePath: f.sealedEvidence, platform: "linux-x64", sourceCommit: COMMIT, sourceTree: TREE, sealedEvidenceSha256: f.sealedEvidenceSha256 }), /raw metadata|size/);
    assert.throws(() => assertCandidateIdentity({ candidateDir: f.candidate, packageRecordPath: f.packageRecord, sealedEvidencePath: f.sealedEvidence, platform: "linux-x64", sourceCommit: "", sourceTree: TREE, sealedEvidenceSha256: f.sealedEvidenceSha256 }), /source commit/);
    assert.throws(() => assertCandidateIdentity({ candidateDir: f.candidate, packageRecordPath: f.packageRecord, sealedEvidencePath: f.sealedEvidence, platform: "linux-x64", sourceCommit: COMMIT, sourceTree: "", sealedEvidenceSha256: f.sealedEvidenceSha256 }), /source tree/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("sealed copied record metadata and status remain bound to the package record", () => {
  const f = identityFixture();
  try {
    const bad = JSON.parse(readFileSync(f.sealedEvidence, "utf8"));
    bad.candidate.npm.size += 1;
    writeFileSync(f.sealedEvidence, `${JSON.stringify(bad)}\n`);
    const digest = sha256(readFileSync(f.sealedEvidence));
    assert.throws(() => assertCandidateIdentity({ candidateDir: f.candidate, packageRecordPath: f.packageRecord, sealedEvidencePath: f.sealedEvidence, platform: "linux-x64", sourceCommit: COMMIT, sourceTree: TREE, sealedEvidenceSha256: digest }), /sealed candidate npm metadata/);
    bad.candidate.npm = JSON.parse(readFileSync(f.packageRecord, "utf8")).npm;
    bad.status = "fail";
    writeFileSync(f.sealedEvidence, `${JSON.stringify(bad)}\n`);
    const statusDigest = sha256(readFileSync(f.sealedEvidence));
    assert.throws(() => assertCandidateIdentity({ candidateDir: f.candidate, packageRecordPath: f.packageRecord, sealedEvidencePath: f.sealedEvidence, platform: "linux-x64", sourceCommit: COMMIT, sourceTree: TREE, sealedEvidenceSha256: statusDigest }), /sealed candidate status/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Linux payload root rejects a foreign root and symlink/hardlink archive members", () => {
  const valid = archiveFixture();
  const foreign = archiveFixture({ rootName: "foreign-root" });
  const symlink = archiveFixture({ symlink: true });
  const hardlink = archiveFixture({ hardlink: true });
  try {
    assert.throws(() => extractRawArchive({ rawPath: foreign.archive, extractDir: foreign.extract }), /unsafe|unexpected/);
    assert.throws(() => extractRawArchive({ rawPath: symlink.archive, extractDir: symlink.extract }), /unsafe|unexpected/);
    assert.throws(() => extractRawArchive({ rawPath: hardlink.archive, extractDir: hardlink.extract }), /unsafe|unexpected/);
    const payloadRoot = extractRawArchive({ rawPath: valid.archive, extractDir: valid.extract });
    assert.equal(payloadRoot.endsWith("theme-forge-nebular-fusion"), true);
    assertLinuxPayloadRoot(valid.extract);
  } finally {
    for (const f of [valid, foreign, symlink, hardlink]) rmSync(f.root, { recursive: true, force: true });
  }
});

test("raw archive traversal is rejected before extraction", () => {
  const f = archiveFixture();
  const listingRunner = (command, args) => command === "tar" && args[0] === "-tvzf"
    ? { status: 0, stdout: "-rw-r--r-- user/group 0 2026-01-01 00:00 ../escape\n", stderr: "" }
    : { status: 0, stdout: "", stderr: "" };
  try {
    assert.throws(() => extractRawArchive({ rawPath: f.archive, extractDir: f.extract, runner: listingRunner }), /unsafe|unexpected/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("ELF inventory classifies dynamic PIE, shared objects and static members", () => {
  const f = payloadFixture();
  const staticPath = "lib/static-go";
  const sharedPath = "lib/shared.so";
  writeFileSync(join(f.payload, staticPath), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  writeFileSync(join(f.payload, sharedPath), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  try {
    const result = inspectElfClosure({ payloadRoot: f.payload, arch: "linux-x64", expectedRuntimeGlibc: "2.36", runner: fakeRunner({ staticPath, sharedPath }) });
    const gui = result.inventory.find((entry) => entry.path === "bin/theme-forge-nebular-fusion");
    const stat = result.inventory.find((entry) => entry.path === staticPath);
    const shared = result.inventory.find((entry) => entry.path === sharedPath);
    assert.equal(gui.linkage, "dynamic-executable");
    assert.equal(stat.linkage, "static");
    assert.equal(stat.ldd.status, "not-run");
    assert.equal(shared.linkage, "shared-object");
    assert.equal(shared.ldd.status, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a real 2.28 baseline runtime classifies a newer payload as closure-negative", () => {
  const f = payloadFixture();
  try {
    let error;
    try {
      inspectElfClosure({ payloadRoot: f.payload, arch: "linux-x64", glibcFloor: "2.28", expectedRuntimeGlibc: "2.28", runner: fakeRunner({ runtime: "2.28", floor: "2.34" }) });
    } catch (caught) { error = caught; }
    assert.equal(error.runtimeGlibc, "2.28");
    assert.equal(error.runtimeMismatch, false);
    assert.equal(error.glibcFloorExceeded, true);
    assert.equal(classifyFailure(error, { lane: "manylinux_2_28_baseline", probe: { expectedMissingGui: true, missing: [] } }), "closure-negative:glibc-floor-exceeded");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a consumer ldd-only closure failure remains a valid falsification", () => {
  const f = payloadFixture();
  try {
    let error;
    try {
      inspectElfClosure({ payloadRoot: f.payload, arch: "linux-x64", expectedRuntimeGlibc: "2.36", runner: fakeRunner({ runtime: "2.36", lddFailure: true }) });
    } catch (caught) { error = caught; }
    assert.equal(error.runtimeGlibc, "2.36");
    assert.deepEqual(error.failureKinds, ["closure"]);
    assert.equal(classifyFailure(error, { lane: "debian_bookworm_glibc_2_36_newer", probe: { expectedMissingGui: false, missing: [] } }), "closure-failure");
    assert.equal(classifyFailure(error, { lane: "debian_bookworm_glibc_2_36_newer", probe: { expectedMissingGui: false, missing: ["gtk3"] } }), "environment");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("ELF inventory retains readelf/ldd failure evidence and rejects floor or machine breaches", () => {
  const f = payloadFixture();
  try {
    assert.throws(() => inspectElfClosure({ payloadRoot: f.payload, arch: "linux-x64", glibcFloor: "2.28", expectedRuntimeGlibc: "2.36", runner: fakeRunner({ floor: "2.36" }) }), /policy floor/);
    const failing = fakeRunner({ lddFailure: true });
    assert.throws(() => inspectElfClosure({ payloadRoot: f.payload, arch: "linux-x64", expectedRuntimeGlibc: "2.36", runner: failing }), (error) => error.inventory.some((entry) => entry.ldd?.stderr.includes("not found")) && error.inventory.some((entry) => entry.readelf?.header?.stdout.includes("ELF64")));
    assert.throws(() => inspectElfClosure({ payloadRoot: f.payload, arch: "linux-x64", expectedRuntimeGlibc: "2.36", runner: fakeRunner({ machine: "AArch64" }) }), /machine|dynamic executable/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("qualify writes a fail-closed report on invalid raw archive identity", () => {
  const f = identityFixture();
  const report = join(f.root, "report.json");
  const probe = join(f.root, "probe.json");
  writeFileSync(probe, JSON.stringify({ schema: "nebular.linux-system-library-probe-v1", expectedMissingGui: true, probeStatus: 0, libraries: [{ id: "gtk3", soname: "libgtk-3.so.0", available: false }], missing: ["gtk3"] }));
  try {
    const result = qualify({ arch: "linux-x64", lane: "manylinux_2_28_baseline", candidateDir: f.candidate, packageRecord: f.packageRecord, sealedEvidence: f.sealedEvidence, sealedEvidenceSha256: f.sealedEvidenceSha256, extractDir: join(f.root, "extract"), report, sourceCommit: COMMIT, sourceTree: TREE, expectedRuntimeGlibc: "2.28", systemLibraryProbe: probe, glibcFloor: "2.28" });
    assert.equal(result.status, "fail");
    assert.equal(result.classification, "identity");
    assert.equal(result.candidate.raw.sha256, f.record.raw.sha256);
    assert.equal(JSON.parse(readFileSync(report, "utf8")).schema, "nebular.linux-elf-closure-v3");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("system-library probes require a successful, self-consistent observation", () => {
  const root = mkdtempSync(join(tmpdir(), "nebular-linux-probe-"));
  const probe = join(root, "probe.json");
  try {
    writeFileSync(probe, JSON.stringify({ schema: "nebular.linux-system-library-probe-v1", expectedMissingGui: true, probeStatus: 1, libraries: [{ id: "gtk3", soname: "libgtk-3.so.0", available: false }], missing: ["gtk3"] }));
    assert.throws(() => readProbe(probe), /did not complete successfully/);
    writeFileSync(probe, JSON.stringify({ schema: "nebular.linux-system-library-probe-v1", expectedMissingGui: true, probeStatus: 0, libraries: [{ id: "gtk3", soname: "libgtk-3.so.0", available: true }], missing: ["gtk3"] }));
    assert.throws(() => readProbe(probe), /contradicts/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unexpected baseline inspection error cannot become negative closure evidence", () => {
  const error = Object.assign(new Error("inspection file unavailable"), { code: "EACCES" });
  assert.equal(classifyFailure(error, {
    lane: "manylinux_2_28_baseline",
    probe: { expectedMissingGui: true, missing: ["gtk"] },
  }), "environment");
});

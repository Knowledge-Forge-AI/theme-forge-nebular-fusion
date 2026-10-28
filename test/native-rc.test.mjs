// @vitest-environment node
// Native release-candidate automation: lane planning, deterministic packaging, smoke receipt judgement,
// the evidence seal and the release-candidate catalog.
import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { LANES, RETENTION, artifactName, planLanes, workflowOutputs } from "../tools/native-rc-plan.mjs";
import { CANDIDATE_VERSION } from "../tools/platform-targets.mjs";
import { FIXED_ARCHIVE_TIME, PACKAGE_MANIFEST_PROJECTION_SCHEMA, PLATFORMS, assemblePlatformPackage, assembleRawArchive, packPlatformPackage, platformPackageJson, platformReadme, tarRecords, verifyPlatformPackage, walkTree, writeDeterministicArchive } from "../tools/native-rc-package.mjs";
import { FINALIZATION_SCHEMA, PLATFORM_SCENARIOS, SCENARIOS, authenticateNpmPackageContext, buildSmokeEnvironment, executablePath, finalizeSmokeRun, judgeReceipt, launcherPath, persistentStateLocations, prepareFixtures, caseSensitive } from "../tools/native-rc-smoke.mjs";
import { compareVersions, glibcFloor, invokeBounded, qualifyPayload, readLinuxArchiveLegalEnvelope, run, selectPayloadInventoryForQualification } from "../tools/native-rc-qualify.mjs";
import { buildReceipt, seal } from "../tools/native-rc-evidence.mjs";
import { identity } from "../tools/candidate-provenance.mjs";
import { buildIndex } from "../tools/native-rc-index.mjs";
import { nativeLauncher } from "../tools/native-launcher.mjs";
import { NODE_RELEASE_IDENTITY, readRegularFile } from "../tools/node-runtime-authority.mjs";
import { createPreviewHashBudget, inspectBoundedPreviewTree } from "../tools/prepare-app-resources.mjs";
import { buildElfPortabilityObservation, ELF_PORTABILITY_READELF_ARGS, parseElfPortability } from "../tools/elf-portability.mjs";
import {
  MAX_RUNTIME_INPUT_BYTES,
  PRIVATE_RUNTIME_PREFIX,
  PRIVATE_RUNTIME_MARKER,
  REQUIRED_RUNTIME_DIRECTORIES,
  REQUIRED_EXECUTABLE_RUNTIME_ROLES,
  REQUIRED_RUNTIME_ROLES,
  createNativeRuntimeAliasProjection,
  externalFloorForTarget,
  computeMaterialDigest,
  authenticateNativeRuntimeInput,
  inventoryNativePayload,
  selectPayloadNativeRuntime,
} from "../tools/native-runtime.mjs";

const testRoot = dirname(fileURLToPath(import.meta.url));
const payloadModuleCandidates = [
  resolve(testRoot, "../../../packages/nebular-fusion-npm/bin/payload.mjs"),
  resolve(testRoot, "../packages/nebular-fusion-npm/bin/payload.mjs"),
];
const payloadModulePath = payloadModuleCandidates.find((candidate) => existsSync(candidate));
if (!payloadModulePath) {
  throw new Error("Nebular npm payload module is missing from the private or flattened public layout");
}
const { TARGETS: NPM_TARGETS, verifyPayload } = await import(payloadModulePath);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const SHA = "93c8da8d8cfd4923869ec8d11c51d1e7349802cc";
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) { spawnSync("chmod", ["-R", "u+w", root]); rmSync(root, { recursive: true, force: true }); } });
const scratch = (name) => { const root = mkdtempSync(join(tmpdir(), `native-rc-${name}-`)); roots.push(root); return root; };
const physicalScratch = (name) => { const root = mkdtempSync(join(realpathSync(tmpdir()), `native-rc-${name}-`)); roots.push(root); return root; };
const write = (path, content, mode) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); if (mode) chmodSync(path, mode); };
const plan = (eventName, inputs = {}, overrides = {}) => planLanes({ eventName, inputs, sha: SHA, runId: 123, runAttempt: 1, version: "0.6.1", ...overrides });

const ELF_PORTABILITY_X86_HEADER = [
  "ELF Header:",
  "  Class:                             ELF64",
  "  Machine:                           Advanced Micro Devices X86-64",
  "  Type:                              DYN (Shared object file)",
  "Program Headers:",
  "      [Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]",
  "Dynamic section at offset 0x100 contains 2 entries:",
  " 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]",
  " 0x0000000000000001 (NEEDED)             Shared library: [libstdc++.so.6]",
  "Version needs section '.gnu.version_r' contains 2 entries:",
  "  0x0020: Version: 1  File: libc.so.6  Cnt: 2",
  "  0x0030:   Name: GLIBC_2.36  Flags: none  Version: 2",
  "  0x0040:   Name: GLIBC_PRIVATE  Flags: none  Version: 3",
].join("\n");

describe("ELF portability observation parser", () => {
  it("parses x86 ISA levels, GNU properties, attributes, and GLIBC_PRIVATE without admission", () => {
    const parsed = parseElfPortability([
      ELF_PORTABILITY_X86_HEADER,
      "Displaying notes found in: .note.gnu.property",
      "  Owner                Data size  Description",
      "  GNU                  0x00000010 NT_GNU_PROPERTY_TYPE_0",
      "      Properties: x86 ISA needed: x86-64-v3, x86 feature: IBT",
      "Attribute Section: .gnu.attributes",
      "File Attributes",
      "  Tag_CPU_arch: v8",
    ].join("\n"), "x86_64-unknown-linux-gnu");
    expect(parsed.gnuProperty.status).toBe("present");
    expect(parsed.gnuProperty.x86IsaNeeded.levels).toEqual(["x86-64-v3"]);
    expect(parsed.gnuProperty.x86Features.values).toEqual(["IBT"]);
    expect(parsed.attributes.status).toBe("present");
    expect(parsed.glibcPrivateVersionNeeds).toEqual([{ provider: "libc.so.6", name: "GLIBC_PRIVATE" }]);
    expect(parsed.cpuBaseline.status).toBe("observed");
    expect(parsed.cpuBaseline.admission).toBe("not-claimed");
  });

  it("keeps known and above-known x86 properties observable but unresolved when unknown", () => {
    for (const level of ["baseline", "v2", "v3", "v4"]) {
      const observed = parseElfPortability([
        ELF_PORTABILITY_X86_HEADER,
        "Displaying notes found in: .note.gnu.property",
        `      Properties: x86 ISA needed: x86-64-${level}`,
      ].join("\n"), "x86_64-unknown-linux-gnu");
      expect(observed.gnuProperty.x86IsaNeeded.status).toBe("known");
      expect(observed.gnuProperty.x86IsaNeeded.levels).toEqual([`x86-64-${level}`]);
      expect(observed.cpuBaseline.admission).toBe("not-claimed");
    }
    const unknown = parseElfPortability([
      ELF_PORTABILITY_X86_HEADER,
      "Displaying notes found in: .note.gnu.property",
      "      Properties: x86 ISA needed: x86-64-v5",
    ].join("\n"), "x86_64-unknown-linux-gnu");
    expect(unknown.gnuProperty.x86IsaNeeded.status).toBe("unknown");
    expect(unknown.gnuProperty.x86IsaNeeded.values).toEqual(["x86-64-v5"]);
    expect(unknown.cpuBaseline.status).toBe("unresolved");
  });

  it("does not infer needed ISA from paths, SONAMEs, or ISA-used markers", () => {
    const observed = parseElfPortability([
      ELF_PORTABILITY_X86_HEADER,
      " 0x000000000000000e (SONAME)             Library soname: [libx86-64-v3.so]",
      " 0x000000000000000f (RPATH)              Library rpath: [/opt/x86-64-v3]",
      "Displaying notes found in: .note.gnu.property",
      "      Properties: x86 ISA used: x86-64-v3",
    ].join("\n"), "x86_64-unknown-linux-gnu");
    expect(observed.gnuProperty.x86IsaNeeded.status).toBe("unknown");
    expect(observed.gnuProperty.x86IsaNeeded.values).toEqual([]);
    expect(observed.gnuProperty.x86IsaUsed.levels).toEqual(["x86-64-v3"]);
  });

  it("distinguishes absent notes from unavailable note evidence", () => {
    const absent = parseElfPortability(`${ELF_PORTABILITY_X86_HEADER}\nNo note sections\nNo attributes`, "x86_64-unknown-linux-gnu");
    expect(absent.gnuProperty.status).toBe("absent");
    expect(absent.attributes.status).toBe("absent");
    expect(absent.cpuBaseline.status).toBe("unresolved");

    const unknown = parseElfPortability(ELF_PORTABILITY_X86_HEADER, "x86_64-unknown-linux-gnu");
    expect(unknown.gnuProperty.status).toBe("unknown");
    expect(unknown.attributes.status).toBe("unknown");
    expect(unknown.cpuBaseline.status).toBe("unresolved");
  });

  it("records AArch64 attributes and a digest of the complete readelf stream", () => {
    const text = [
      ELF_PORTABILITY_X86_HEADER.replace("Advanced Micro Devices X86-64", "AArch64").replace("/lib64/ld-linux-x86-64.so.2", "/lib/ld-linux-aarch64.so.1"),
      "Displaying notes found in: .note.gnu.property",
      "      Properties: AArch64 feature: BTI, PAC",
      "Attribute Section: .gnu.attributes",
      "File Attributes",
      "  Tag_CPU_arch: v8",
      "  Tag_CPU_arch_profile: Application",
    ].join("\n");
    const observation = buildElfPortabilityObservation({
      relativePath: "opt/nebular-private/lib/libfixture.so.0",
      aliases: ["opt/nebular-private/lib/libfixture.so"],
      target: "aarch64-unknown-linux-gnu",
      bytes: 1234,
      sha256: "a".repeat(64),
      stdout: text,
      stderr: "",
    });
    expect(observation.gnuProperty.aarch64Features.values).toEqual(["BTI", "PAC"]);
    expect(observation.attributes.cpuArch[0]).toBe("v8");
    expect(observation.attributes.cpuProfile[0]).toBe("Application");
    expect(observation.readelf.args).toEqual(ELF_PORTABILITY_READELF_ARGS);
    expect(observation.readelf.streamSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(observation.readelf.notesStatus).toBe("present");
    expect(observation.aliases).toEqual(["opt/nebular-private/lib/libfixture.so"]);
  });

  it("rejects malformed streams, unbound identities, and noncanonical paths", () => {
    expect(() => parseElfPortability("ELF Header:\\n  Class: ELF64", "x86_64-unknown-linux-gnu")).toThrow(/Malformed readelf header output/);
    expect(() => buildElfPortabilityObservation({
      relativePath: "bin/fixture",
      target: "x86_64-unknown-linux-gnu",
      bytes: 1,
      sha256: "not-a-digest",
      stdout: ELF_PORTABILITY_X86_HEADER,
    })).toThrow(/sha256 is invalid/);
    expect(() => buildElfPortabilityObservation({
      relativePath: "bin\\\\fixture",
      target: "x86_64-unknown-linux-gnu",
      bytes: 1,
      sha256: "a".repeat(64),
      aliases: ["/absolute/alias"],
      stdout: ELF_PORTABILITY_X86_HEADER,
    })).toThrow(/canonical relative path/);
    expect(() => buildElfPortabilityObservation({
      relativePath: "bin/fixture",
      target: "x86_64-unknown-linux-gnu",
      bytes: 1,
      sha256: "a".repeat(64),
      aliases: ["bin/../escape"],
      stdout: ELF_PORTABILITY_X86_HEADER,
    })).toThrow(/empty, dot, or dotdot/);
  });
});

it("refuses a protected preview leaf before any leaf filesystem read", async () => {
  const root = physicalScratch("protected-preview-leaf");
  write(join(root, "db"), "private", 0o644);
  await expect(inspectBoundedPreviewTree(root, {
    files: 1,
    nodes: 1,
    aggregateBytes: 7,
    perFileBytes: 1024,
    relativePathBytes: 128,
  }, createPreviewHashBudget(1024))).rejects.toThrow(/protected entry.*db/i);
});

describe("lane planning", () => {
  it("runs every lane on a pull request with routine retention", () => {
    const result = plan("pull_request");
    expect(result.selected).toEqual(["macos-arm64", "linux-arm64", "linux-x64"]);
    expect(result.retentionDays).toBe(RETENTION.routine);
    expect(result.releaseCandidate).toBe(false);
    expect(Object.values(result.lanes).map((lane) => lane.runner)).toEqual(["macos-15", "ubuntu-24.04-arm", "ubuntu-24.04"]);
  });

  it("selects exactly the dispatched subset for all seven non-empty combinations and rejects none", () => {
    const names = Object.keys(LANES);
    for (let mask = 1; mask < 8; mask += 1) {
      const inputs = Object.fromEntries(names.map((name, bit) => [LANES[name].input, (mask >> bit) & 1 ? "true" : "false"]));
      expect(plan("workflow_dispatch", inputs).selected).toEqual(names.filter((_, bit) => (mask >> bit) & 1));
    }
    expect(() => plan("workflow_dispatch", { macos_arm64: false, linux_arm64: "false", linux_x64: false })).toThrow(/at least one/);
    expect(() => plan("push")).toThrow(/not built for push/);
  });

  it("keeps explicit release candidates for the 90-day public maximum and never claims more", () => {
    expect(plan("workflow_dispatch", { linux_x64: true, release_candidate: true }).retentionDays).toBe(90);
    expect(plan("workflow_dispatch", { linux_x64: true, release_candidate: "false" }).retentionDays).toBe(14);
    expect(RETENTION.releaseCandidate).toBeLessThanOrEqual(RETENTION.maximumPublic);
    expect(RETENTION.maximumPublic).toBe(90);
    expect(plan("pull_request").diagnosticsRetentionDays).toBe(7);
  });

  it("names artifacts uniquely per lane, run and attempt, and diagnostics never as candidates", () => {
    const names = new Set();
    for (const runId of [1, 2]) for (const runAttempt of [1, 2]) for (const lane of Object.keys(LANES)) {
      for (const kind of ["candidate", "diagnostics"]) names.add(artifactName(kind, { lane, version: "0.6.1", sha: SHA, runId, runAttempt }));
    }
    expect(names.size).toBe(2 * 2 * 3 * 2);
    expect(artifactName("candidate", { lane: "linux-x64", version: "0.6.1", sha: SHA, runId: 5, runAttempt: 2 })).toBe("nebular-rc-0.6.1-linux-x64-93c8da8d8cfd-r5-a2");
    expect(artifactName("diagnostics", { lane: "linux-x64", version: "0.6.1", sha: SHA, runId: 5, runAttempt: 2 })).not.toContain("0.6.1");
    const outputs = workflowOutputs(plan("workflow_dispatch", { linux_arm64: true }));
    expect(outputs.linux_arm64).toBe("true");
    expect(outputs.macos_arm64).toBe("false");
    expect(JSON.parse(outputs.plan).source.sha).toBe(SHA);
  });

  it("rejects an incomplete source identity", () => {
    expect(() => plan("pull_request", {}, { sha: "abc" })).toThrow(/full source commit/);
    expect(() => plan("pull_request", {}, { runAttempt: 0 })).toThrow(/Run id/);
  });
});

describe("deterministic packaging", () => {
  function linuxPayload(root) {
    const target = PLATFORMS["linux-x64"];
    const elf = Buffer.alloc(64);
    Buffer.from([0x7f, 69, 76, 70, 2, 1, 1]).copy(elf);
    elf.writeUInt16LE(3, 16);
    elf.writeUInt16LE(62, 18);
    write(join(root, "bin/theme-forge-nebular-fusion"), elf, 0o755);
    write(join(root, "bin/tfsb-studio-service"), "node", 0o755);
    write(join(root, "bin/tfnf"), nativeLauncher(target.target), 0o755);
    write(join(root, "lib/theme-forge-nebular-fusion/loom-payload/Ünïcode name with spaces and a rather long path segment that exceeds one hundred bytes of ustar space.json"), "{}", 0o644);
    return root;
  }

  it("writes byte-identical archives with fixed metadata regardless of input order or time", async () => {
    const checkout = scratch("checkout");
    write(join(checkout, "LICENSE"), "license\n");
    write(join(checkout, "NOTICE"), "notice\n");
    const first = await assembleRawArchive({ platform: "linux-x64", payload: linuxPayload(scratch("payload-a")), checkout, output: scratch("out-a") });
    const second = await assembleRawArchive({ platform: "linux-x64", payload: linuxPayload(scratch("payload-b")), checkout, output: scratch("out-b") });
    expect(first.sha256).toBe(second.sha256);
    expect(first.filename).toBe(`theme-forge-nebular-fusion-v${CANDIDATE_VERSION}-x86_64-unknown-linux-gnu.tar.gz`);
    const bytes = readFileSync(first.file);
    expect(bytes[9]).toBe(255);
    expect(bytes.readUInt32LE(4)).toBe(0);
    const extract = scratch("extract");
    expect(spawnSync("tar", ["-xzf", first.file, "-C", extract]).status).toBe(0);
    expect(readFileSync(join(extract, "theme-forge-nebular-fusion/LICENSE"), "utf8")).toBe("license\n");
    // The long Unicode member travels through a PAX path record and extracts under its exact name.
    const longName = "Ünïcode name with spaces and a rather long path segment that exceeds one hundred bytes of ustar space.json";
    expect(readFileSync(join(extract, "theme-forge-nebular-fusion/lib/theme-forge-nebular-fusion/loom-payload", longName), "utf8")).toBe("{}");
  });

  it("encodes ustar headers with root ownership, fixed time and normalized modes", () => {
    const [header, payload] = tarRecords({ path: "a/b", type: "file", mode: 0o755, bytes: Buffer.from("x") });
    expect(header.subarray(108, 115).toString()).toBe("0000000");
    expect(parseInt(header.subarray(136, 147).toString(), 8)).toBe(FIXED_ARCHIVE_TIME);
    expect(parseInt(header.subarray(100, 107).toString(), 8)).toBe(0o755);
    expect(payload.toString()).toBe("x");
    const [pax] = tarRecords({ path: `${"d/".repeat(60)}f`, type: "file", mode: 0o644, bytes: Buffer.alloc(0) });
    expect(pax[156]).toBe("x".charCodeAt(0));
  });

  it("rejects a payload launcher that differs from the maintained launcher", async () => {
    const checkout = scratch("checkout2");
    write(join(checkout, "LICENSE"), "l");
    write(join(checkout, "NOTICE"), "n");
    const payload = linuxPayload(scratch("payload-c"));
    write(join(payload, "bin/tfnf"), "#!/bin/sh\n", 0o755);
    await expect(assembleRawArchive({ platform: "linux-x64", payload, checkout, output: scratch("out-c") })).rejects.toThrow(/launcher/);
  });

  it("refuses links that escape the payload", () => {
    const payload = linuxPayload(scratch("payload-d"));
    spawnSync("ln", ["-s", "/etc/passwd", join(payload, "bin/escape")]);
    expect(() => walkTree(payload)).toThrow(/Unsafe link|escapes/);
  });

  it("renders the platform package templates of the private owner", () => {
    expect(platformPackageJson("linux-arm64")).toMatchObject({ name: "@knowledge-forge-ai/theme-forge-nebular-fusion-linux-arm64", os: ["linux"], cpu: ["arm64"],
      files: ["payload", "package-manifest.json", "README.md", "LICENSE", "NOTICE"], license: "AGPL-3.0-or-later" });
    expect(platformReadme("darwin-arm64")).toContain("`payload/Theme Forge Nebular Fusion.app`");
    expect(() => verifyPlatformPackage(scratch("empty"), "linux-x64", "0".repeat(64))).toThrow();
  });
});

describe("machine qualification helpers", () => {
  it("derives the glibc floor from readelf version needs", () => {
    const output = "Version needs section '.gnu.version_r'\n  0x0010:   Name: GLIBC_2.17  Flags: none\n  0x0020:   Name: GLIBC_2.34  Flags: none\n  0x0030:   Name: GLIBC_2.28  Flags: none\n  Name: GCC_3.0\n";
    expect(glibcFloor(output)).toBe("2.34");
    expect(compareVersions("2.36", "2.4")).toBeGreaterThan(0);
    expect(() => glibcFloor("no requirements")).toThrow();
  });
});

describe("bounded private probe lifecycle", () => {
  const probeEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  const deadline = () => Date.now() + 10_000;

  it("awaits asynchronous command-runner results instead of treating promises as records", async () => {
    const calls = [];
    const result = await invokeBounded(async (command, args, env, options) => {
      calls.push({ command, args, env, hasSignal: Boolean(options?.signal) });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        status: 0,
        stdout: "codesign-ok",
        stderr: "",
        error: undefined,
        bounded: true,
        timedOut: false,
        outputLimitExceeded: false,
        cleanupKnown: true,
        outputComplete: true,
        forcedCleanup: false,
      };
    }, "codesign", ["--verify"], probeEnv, deadline());
    expect(result.stdout).toBe("codesign-ok");
    expect(calls).toHaveLength(1);
    expect(calls[0].hasSignal).toBe(true);
  });

  it("retains normal and nonzero process outcomes with complete stream cleanup", async () => {
    const success = await run("/bin/sh", ["-c", "printf probe-ok"], probeEnv, { deadline: deadline() });
    expect(success).toMatchObject({ status: 0, stdout: "probe-ok", timedOut: false, outputLimitExceeded: false, cleanupKnown: true, outputComplete: true, forcedCleanup: false, bounded: true });

    const failure = await run("/bin/sh", ["-c", "printf probe-error >&2; exit 7"], probeEnv, { deadline: deadline() });
    expect(failure).toMatchObject({ status: 7, stderr: "probe-error", timedOut: false, outputLimitExceeded: false, cleanupKnown: true, outputComplete: true, forcedCleanup: false, bounded: true });
  });

  it("terminates inherited descendants on timeout and normal leader exit", async () => {
    const timeout = await run("/bin/sh", ["-c", "sleep 10"], probeEnv, { deadline: Date.now() + 100 });
    expect(timeout).toMatchObject({ timedOut: true, cleanupKnown: true, outputComplete: true, forcedCleanup: true, bounded: true });

    const descendant = await run("/bin/sh", ["-c", "sleep 10 & exit 0"], probeEnv, { deadline: deadline() });
    expect(descendant).toMatchObject({ status: 0, cleanupKnown: true, outputComplete: true, forcedCleanup: true, bounded: true });

    const termResistant = await run("/bin/sh", ["-c", "trap '' TERM; sleep 10 & exit 0"], probeEnv, { deadline: deadline() });
    expect(termResistant).toMatchObject({ status: 0, cleanupKnown: true, outputComplete: true, forcedCleanup: true, bounded: true });
    await expect(invokeBounded(run, "/bin/sh", ["-c", "sleep 10 & exit 0"], probeEnv, deadline())).rejects.toThrow(/did not complete safely/);
  });

  it("bounds an escaped descendant that keeps the leader's stdio open", async () => {
    const childScript = [
      "const { spawn } = require('node:child_process');",
      "const escaped = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
      "escaped.unref();",
      "process.stdout.write(String(escaped.pid) + '\\n');",
      "process.exit(0);",
    ].join(" ");
    const result = await run(process.execPath, ["-e", childScript], probeEnv, { deadline: deadline() });
    const escapedPid = Number.parseInt(result.stdout.trim(), 10);
    try {
      expect(result.status).toBe(0);
      expect(result.cleanupKnown).toBe(true);
      expect(result.outputComplete).toBe(false);
      expect(result.error).toMatch(/streams did not close after leader exit/);
    } finally {
      if (Number.isInteger(escapedPid) && escapedPid > 0) {
        try { process.kill(-escapedPid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
      }
    }
  });

  it("enforces the combined stdout and stderr cap", async () => {
    const script = "head -c 34000000 /dev/zero; head -c 34000000 /dev/zero >&2";
    const capped = await run("/bin/sh", ["-c", script], probeEnv, { deadline: Date.now() + 10_000 });
    expect(capped).toMatchObject({ outputLimitExceeded: true, cleanupKnown: true, outputComplete: false, forcedCleanup: true, bounded: true });
  });
});

describe("smoke scenarios and receipts", () => {
  const receipt = (scenario, overrides = {}) => ({
    mode: 0o600,
    receipt: { schema: "nebular.release-smoke-receipt-v1", scenario, status: "pass", pid: 42, target: "x86_64-unknown-linux-gnu", awaitingSignal: Boolean(SCENARIOS[scenario].signal),
      executable: { sha256: "e".repeat(64) }, driver: { steps: SCENARIOS[scenario].steps.map((id) => ({ id, ok: true, via: "dom", ms: 1, detail: "" })) }, ...overrides },
  });

  it("gives each platform a deliberately different scenario", () => {
    expect(PLATFORM_SCENARIOS).toEqual({ "darwin-arm64": ["A"], "linux-arm64": ["B"], "linux-x64": ["C", "C-signal"] });
    expect(SCENARIOS.A.steps.indexOf("host-start")).toBeLessThan(SCENARIOS.A.steps.indexOf("app-theme-compile"));
    expect(SCENARIOS.B.steps.indexOf("app-theme-compile")).toBeLessThan(SCENARIOS.B.steps.indexOf("host-start"));
    expect(SCENARIOS.C.steps).toContain("host-start-idempotent");
    expect(SCENARIOS.C.steps).toContain("derive-plan-cancel");
  });

  it("forwards bounded Linux EGL diagnostics without changing Darwin smoke environment", () => {
    const xdg = { config: "/tmp/config", cache: "/tmp/cache", data: "/tmp/data", state: "/tmp/state", runtime: "/tmp/runtime" };
    const inherited = { PATH: "/usr/bin", DISPLAY: ":99", EGL_LOG_LEVEL: "debug", LIBGL_DEBUG: "verbose" };
    const linux = buildSmokeEnvironment({ platform: "linux-x64", home: "/tmp/home", temp: "/tmp/tmp", smokeDir: "/tmp/smoke", xdg, inheritedEnv: inherited });
    expect(linux.DISPLAY).toBe(":99");
    expect(linux.EGL_LOG_LEVEL).toBe("debug");
    expect(linux.LIBGL_DEBUG).toBe("verbose");
    const linuxUnconfigured = buildSmokeEnvironment({ platform: "linux-x64", home: "/tmp/home", temp: "/tmp/tmp", smokeDir: "/tmp/smoke", xdg, inheritedEnv: { PATH: "/usr/bin" } });
    expect(linuxUnconfigured.EGL_LOG_LEVEL).toBeUndefined();
    expect(linuxUnconfigured.LIBGL_DEBUG).toBeUndefined();
    const darwin = buildSmokeEnvironment({ platform: "darwin-arm64", home: "/tmp/home", temp: "/tmp/tmp", smokeDir: "/tmp/smoke", xdg, inheritedEnv: inherited });
    expect(darwin.DISPLAY).toBe(":99");
    expect(darwin.EGL_LOG_LEVEL).toBeUndefined();
    expect(darwin.LIBGL_DEBUG).toBeUndefined();
  });

  it("accepts only a complete passing receipt from the candidate executable", () => {
    const options = { scenario: "C", platform: "linux-x64", executableSha256: "e".repeat(64), pid: 42 };
    expect(judgeReceipt(receipt("C"), options)).toEqual([]);
    expect(judgeReceipt(null, options)).toEqual(["no receipt was written"]);
    expect(judgeReceipt(receipt("C", { executable: { sha256: "f".repeat(64) } }), options).join()).toMatch(/not the candidate executable/);
    expect(judgeReceipt(receipt("C", { pid: 7 }), options).join()).toMatch(/not the launched process/);
    const missing = receipt("C");
    missing.receipt.driver.steps = missing.receipt.driver.steps.filter((step) => step.id !== "derive-plan-apply");
    expect(judgeReceipt(missing, options).join()).toMatch(/derive-plan-apply missing/);
    expect(judgeReceipt({ ...receipt("C"), mode: 0o644 }, options).join()).toMatch(/receipt mode/);
    expect(judgeReceipt(receipt("C-signal"), { ...options, scenario: "C-signal" })).toEqual([]);
    expect(judgeReceipt(receipt("C", { awaitingSignal: true }), options).join()).toMatch(/signal expectation/);
  });

  // The maintained core fixture sits under the public Studio package root (one level above this test) or,
  // in the monorepo (`<root>/apps/studio/test/`), under the repository root three levels above it; no other root is accepted.
  const MAINTAINED_CORE_FIXTURE = "docs/examples/v0.4/brand-system/core-minimal";
  const maintainedFixtureCheckout = () => {
    const packageRoot = fileURLToPath(new URL("../", import.meta.url));
    const monorepoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const candidates =
      fileURLToPath(new URL("../../../apps/studio/", import.meta.url)) === packageRoot
        ? [packageRoot, monorepoRoot]
        : [packageRoot];
    const checkout = candidates.find((root) => existsSync(join(root, MAINTAINED_CORE_FIXTURE, ".tfsb/project.toml")));
    if (!checkout) throw new Error(`maintained core fixture ${MAINTAINED_CORE_FIXTURE} is absent beneath ${candidates.join(" and ")}`);
    return checkout;
  };

  it("prepares scenario fixtures from the maintained public fixture", () => {
    const checkout = maintainedFixtureCheckout();
    const smoke = scratch("fixtures");
    const prepared = prepareFixtures("A", checkout, smoke);
    expect(readFileSync(join(prepared.observed["core-minimal"], ".tfsb/project.toml"), "utf8")).toContain('name = "core-fixture"');
    if (caseSensitive(scratch("case"))) {
      const derive = prepareFixtures("C", checkout, scratch("fixtures-c"));
      expect(readFileSync(join(derive.observed.upper, ".tfsb/brand-recipes.toml"), "utf8")).toContain("recipe-derived-dark");
      expect(readFileSync(join(derive.observed.lower, ".tfsb/project.toml"), "utf8")).toContain("nebular-derive-lower");
    } else {
      expect(() => prepareFixtures("B", checkout, scratch("fixtures-b"))).toThrow(/case-sensitive/);
    }
  });

  it("watches the real user's application state for the application identifier", () => {
    const mac = persistentStateLocations("darwin-arm64", "/fixture-home");
    expect(mac).toContain("/fixture-home/Library/WebKit/ai.knowledgeforge.themeforge.nebularfusion");
    expect(persistentStateLocations("linux-x64", "/fixture-home")).toContain("/fixture-home/.local/share/ai.knowledgeforge.themeforge.nebularfusion");
  });

  it("releases the application bound as soon as the application exits", () => {
    // The bound is minutes long; a timer left armed would keep every lane's harness alive for the whole bound.
    const script = `import { within } from ${JSON.stringify(new URL("../tools/native-rc-smoke.mjs", import.meta.url).href)};
      const early = await within(Promise.resolve({ code: 0 }), 600000);
      const late = await within(new Promise(() => {}), 50);
      process.stdout.write(JSON.stringify({ early, late }));`;
    const started = Date.now();
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ early: { code: 0 }, late: null });
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});

describe("smoke run finalization", () => {
  const FINALIZATION_KEYS = [
    "schema",
    "status",
    "phase",
    "exceptionFamily",
    "spawned",
    "exitObserved",
    "applicationReceiptObservation",
    "applicationReceiptCopy",
  ];
  const EXECUTABLE_SHA = "e".repeat(64);
  const RECEIPT_SHA = "r".repeat(64);
  const baseResult = (overrides = {}) => ({
    schema: "nebular.native-rc-smoke-run-v1",
    label: "linux-x64-C",
    platform: "linux-x64",
    scenario: "C",
    source: "raw-archive",
    executable: { path: "bin/theme-forge-nebular-fusion", sha256: EXECUTABLE_SHA, size: 64 },
    checks: {},
    problems: [],
    ...overrides,
  });
  const validReceiptRecord = () => ({
    mode: 0o600,
    sha256: RECEIPT_SHA,
    receipt: {
      schema: "nebular.release-smoke-receipt-v1",
      scenario: "C",
      status: "pass",
      pid: 42,
      target: "x86_64-unknown-linux-gnu",
      awaitingSignal: false,
      executable: { sha256: EXECUTABLE_SHA },
      driver: { steps: SCENARIOS.C.steps.map((id) => ({ id, ok: true, via: "dom", ms: 1, detail: "" })) },
    },
  });
  const typedError = (props) => Object.assign(new Error("SENTINEL /private/secret-path pid=9999"), props);
  const expectFinalization = (actual, expected) => {
    expect(Object.keys(actual)).toEqual(FINALIZATION_KEYS);
    expect(actual).toEqual(expected);
    expect(JSON.stringify(actual)).not.toMatch(/SENTINEL|\/private|9999/);
  };

  it("records a complete finalization record on a normal passing smoke run", async () => {
    const events = [];
    const reports = [];
    const copied = [];
    const result = baseResult();
    const returned = await finalizeSmokeRun({
      result,
      keep: false,
      body: async (run) => {
        events.push("body");
        run.launched();
        run.exited();
        result.exit = { code: 0, signal: null, signalSent: null, durationMs: 12 };
        const record = run.receipt(
          () => {
            events.push("receipt-read");
            return validReceiptRecord();
          },
          (observed) => {
            events.push("receipt-copy");
            copied.push(observed.sha256);
          },
        );
        result.receipt = { sha256: record.sha256, status: record.receipt.status, steps: [] };
        result.problems.push(...judgeReceipt(record, { scenario: "C", platform: "linux-x64", executableSha256: EXECUTABLE_SHA, pid: 42 }));
      },
      cleanup: () => events.push("cleanup"),
      writeReport: (text) => {
        events.push("report");
        reports.push(text);
      },
    });
    expect(returned).toBe(result);
    expect(events).toEqual(["body", "receipt-read", "receipt-copy", "cleanup", "report"]);
    expect(copied).toEqual([RECEIPT_SHA]);
    expect(result.status).toBe("pass");
    expect(result.problems).toEqual([]);
    expect(result.exit).toEqual({ code: 0, signal: null, signalSent: null, durationMs: 12 });
    expectFinalization(result.finalization, {
      schema: FINALIZATION_SCHEMA,
      status: "complete",
      phase: "complete",
      exceptionFamily: null,
      spawned: true,
      exitObserved: true,
      applicationReceiptObservation: "present-at-read",
      applicationReceiptCopy: "written",
    });
    expect(JSON.parse(reports[0])).toEqual(result);
  });

  it("keeps finalization complete when an application gate fails and the receipt is absent", async () => {
    const events = [];
    const reports = [];
    const result = baseResult();
    await finalizeSmokeRun({
      result,
      keep: false,
      body: async (run) => {
        events.push("body");
        run.launched();
        run.exited();
        result.exit = { code: 1, signal: null, signalSent: null, durationMs: 9 };
        result.problems.push("application exit code 1 signal null");
        const record = run.receipt(
          () => {
            events.push("receipt-read");
            return null;
          },
          () => events.push("receipt-copy"),
        );
        result.receipt = null;
        result.problems.push(...judgeReceipt(record, { scenario: "C", platform: "linux-x64", executableSha256: EXECUTABLE_SHA, pid: 42 }));
      },
      cleanup: () => events.push("cleanup"),
      writeReport: (text) => {
        events.push("report");
        reports.push(text);
      },
    });
    expect(events).toEqual(["body", "receipt-read", "cleanup", "report"]);
    expect(result.status).toBe("fail");
    expect(result.exit.code).toBe(1);
    expect(result.problems).toEqual(["application exit code 1 signal null", "no receipt was written"]);
    expectFinalization(result.finalization, {
      schema: FINALIZATION_SCHEMA,
      status: "complete",
      phase: "complete",
      exceptionFamily: null,
      spawned: true,
      exitObserved: true,
      applicationReceiptObservation: "absent-at-read",
      applicationReceiptCopy: "not-attempted",
    });
    expect(JSON.parse(reports[0])).toEqual(result);
  });

  it("records pre-spawn state and unknown families without inventing an exit or receipt claim", async () => {
    const fakeCheckout = scratch("fake-checkout");
    write(join(fakeCheckout, "docs/examples/v0.4/brand-system/core-minimal/.tfsb/project.toml"), 'name = "tampered-fixture"\n');
    const smokeDir = scratch("smoke-pre-spawn");
    const events = [];
    const reports = [];
    const result = baseResult({ label: "darwin-arm64-A", platform: "darwin-arm64", scenario: "A" });
    await finalizeSmokeRun({
      result,
      keep: false,
      body: () => {
        events.push("body");
        prepareFixtures("A", fakeCheckout, smokeDir);
      },
      cleanup: () => events.push("cleanup"),
      writeReport: (text) => {
        events.push("report");
        reports.push(text);
      },
    });
    expect(events).toEqual(["body", "cleanup", "report"]);
    expect(result.status).toBe("fail");
    expect(result.exit).toBeUndefined();
    expect(result.receipt).toBeUndefined();
    expect(result.problems).toEqual(["harness error: maintained core fixture project name changed"]);
    expectFinalization(result.finalization, {
      schema: FINALIZATION_SCHEMA,
      status: "failed",
      phase: "pre-spawn",
      exceptionFamily: "state",
      spawned: false,
      exitObserved: false,
      applicationReceiptObservation: "not-attempted",
      applicationReceiptCopy: "not-attempted",
    });
    expect(JSON.parse(reports[0]).finalization).toEqual(result.finalization);

    for (const thrown of [undefined, null, "SENTINEL-primitive", { get code() { throw new Error("getter failed"); } }]) {
      const nonObjectEvents = [];
      const nonObjectResult = baseResult();
      await finalizeSmokeRun({
        result: nonObjectResult,
        keep: false,
        body: () => {
          nonObjectEvents.push("body");
          throw thrown;
        },
        cleanup: () => nonObjectEvents.push("cleanup"),
        writeReport: () => nonObjectEvents.push("report"),
      });
      expect(nonObjectEvents).toEqual(["body", "cleanup", "report"]);
      expect(nonObjectResult.status).toBe("fail");
      expectFinalization(nonObjectResult.finalization, {
        schema: FINALIZATION_SCHEMA,
        status: "failed",
        phase: "pre-spawn",
        exceptionFamily: "unknown",
        spawned: false,
        exitObserved: false,
        applicationReceiptObservation: "not-attempted",
        applicationReceiptCopy: "not-attempted",
      });
    }
  });

  it("preserves the exact captured exit on post-exit failures and distinguishes pre-exit process failures", async () => {
    const events = [];
    const reports = [];
    const result = baseResult();
    const capturedExit = { code: 0, signal: null, signalSent: null, durationMs: 25 };
    await finalizeSmokeRun({
      result,
      keep: false,
      body: (run) => {
        events.push("body");
        run.launched();
        run.exited();
        result.exit = { ...capturedExit };
        throw typedError({ code: "EACCES", syscall: "open" });
      },
      cleanup: () => events.push("cleanup"),
      writeReport: (text) => {
        events.push("report");
        reports.push(text);
      },
    });
    expect(events).toEqual(["body", "cleanup", "report"]);
    expect(result.status).toBe("fail");
    expect(result.exit).toEqual(capturedExit);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/^harness error:/);
    expectFinalization(result.finalization, {
      schema: FINALIZATION_SCHEMA,
      status: "failed",
      phase: "post-exit",
      exceptionFamily: "filesystem",
      spawned: true,
      exitObserved: true,
      applicationReceiptObservation: "not-attempted",
      applicationReceiptCopy: "not-attempted",
    });
    expect(JSON.parse(reports[0]).exit).toEqual(capturedExit);

    const processResult = baseResult();
    await finalizeSmokeRun({
      result: processResult,
      keep: false,
      body: (run) => {
        run.launched();
        throw typedError({ code: "ESRCH", syscall: "kill" });
      },
      cleanup: () => {},
      writeReport: () => {},
    });
    expect(processResult.status).toBe("fail");
    expectFinalization(processResult.finalization, {
      schema: FINALIZATION_SCHEMA,
      status: "failed",
      phase: "post-exit",
      exceptionFamily: "process",
      spawned: true,
      exitObserved: false,
      applicationReceiptObservation: "not-attempted",
      applicationReceiptCopy: "not-attempted",
    });
  });

  it("distinguishes receipt read-failed, absent-at-read and copy-failed without claiming no receipt was written", async () => {
    let copyCalled = false;
    const readFailResult = baseResult();
    await finalizeSmokeRun({
      result: readFailResult,
      keep: false,
      body: (run) => {
        run.launched();
        run.exited();
        readFailResult.exit = { code: 0, signal: null, signalSent: null, durationMs: 15 };
        const record = run.receipt(
          () => {
            throw new SyntaxError("SENTINEL unexpected token in receipt");
          },
          () => {
            copyCalled = true;
          },
        );
        readFailResult.problems.push(...judgeReceipt(record, { scenario: "C", platform: "linux-x64", executableSha256: EXECUTABLE_SHA, pid: 42 }));
      },
      cleanup: () => {},
      writeReport: () => {},
    });
    expect(copyCalled).toBe(false);
    expect(readFailResult.status).toBe("fail");
    expect(readFailResult.problems).not.toContain("no receipt was written");
    expectFinalization(readFailResult.finalization, {
      schema: FINALIZATION_SCHEMA,
      status: "failed",
      phase: "receipt-copy",
      exceptionFamily: "parse",
      spawned: true,
      exitObserved: true,
      applicationReceiptObservation: "read-failed",
      applicationReceiptCopy: "not-attempted",
    });

    const copyFailResult = baseResult();
    await finalizeSmokeRun({
      result: copyFailResult,
      keep: false,
      body: (run) => {
        run.launched();
        run.exited();
        copyFailResult.exit = { code: 0, signal: null, signalSent: null, durationMs: 15 };
        const record = run.receipt(
          () => validReceiptRecord(),
          () => {
            throw typedError({ code: "ENOSPC", syscall: "write" });
          },
        );
        copyFailResult.problems.push(...judgeReceipt(record, { scenario: "C", platform: "linux-x64", executableSha256: EXECUTABLE_SHA, pid: 42 }));
      },
      cleanup: () => {},
      writeReport: () => {},
    });
    expect(copyFailResult.status).toBe("fail");
    expect(copyFailResult.problems).not.toContain("no receipt was written");
    expectFinalization(copyFailResult.finalization, {
      schema: FINALIZATION_SCHEMA,
      status: "failed",
      phase: "receipt-copy",
      exceptionFamily: "filesystem",
      spawned: true,
      exitObserved: true,
      applicationReceiptObservation: "present-at-read",
      applicationReceiptCopy: "copy-failed",
    });
  });

  it("catches owned scratch cleanup failures into a failed run while still writing the outer report and preserving earlier failures", async () => {
    const events = [];
    const reports = [];
    const result = baseResult();
    await finalizeSmokeRun({
      result,
      keep: false,
      body: (run) => {
        events.push("body");
        run.launched();
        run.exited();
        result.exit = { code: 0, signal: null, signalSent: null, durationMs: 10 };
        const record = run.receipt(
          () => validReceiptRecord(),
          () => {},
        );
        result.receipt = { sha256: record.sha256, status: record.receipt.status, steps: [] };
        result.problems.push(...judgeReceipt(record, { scenario: "C", platform: "linux-x64", executableSha256: EXECUTABLE_SHA, pid: 42 }));
        result.checks.fixtureEffects = { upper: { unchanged: false } };
      },
      cleanup: () => {
        events.push("cleanup");
        throw typedError({ code: "EBUSY", syscall: "rmdir" });
      },
      writeReport: (text) => {
        events.push("report");
        reports.push(text);
      },
    });
    expect(events).toEqual(["body", "cleanup", "report"]);
    expect(reports).toHaveLength(1);
    expect(result.status).toBe("fail");
    expect(result.exit).toEqual({ code: 0, signal: null, signalSent: null, durationMs: 10 });
    expect(result.receipt.status).toBe("pass");
    expect(result.checks.fixtureEffects).toEqual({ upper: { unchanged: false } });
    expect(result.problems).toEqual(["harness cleanup of the owned scratch directory failed"]);
    expectFinalization(result.finalization, {
      schema: FINALIZATION_SCHEMA,
      status: "failed",
      phase: "cleanup",
      exceptionFamily: "filesystem",
      spawned: true,
      exitObserved: true,
      applicationReceiptObservation: "present-at-read",
      applicationReceiptCopy: "written",
    });
    expect(JSON.parse(reports[0])).toEqual(result);

    const firstFailureResult = baseResult();
    await finalizeSmokeRun({
      result: firstFailureResult,
      keep: false,
      body: (run) => {
        run.launched();
        run.exited();
        throw new SyntaxError("SENTINEL body parse failure");
      },
      cleanup: () => {
        throw typedError({ code: "EPERM", syscall: "unlink" });
      },
      writeReport: () => {},
    });
    expect(firstFailureResult.status).toBe("fail");
    expect(firstFailureResult.problems).toContain("harness cleanup of the owned scratch directory failed");
    expectFinalization(firstFailureResult.finalization, {
      schema: FINALIZATION_SCHEMA,
      status: "failed",
      phase: "post-exit",
      exceptionFamily: "parse",
      spawned: true,
      exitObserved: true,
      applicationReceiptObservation: "not-attempted",
      applicationReceiptCopy: "not-attempted",
    });
  });

  it("surfaces a sanitized NativeRcReportWriteError when the final report write fails and never fabricates a report", async () => {
    const events = [];
    const reports = [];
    const result = baseResult();
    let caught;
    try {
      await finalizeSmokeRun({
        result,
        keep: false,
        body: (run) => {
          events.push("body");
          run.launched();
          run.exited();
          result.exit = { code: 0, signal: null, signalSent: null, durationMs: 11 };
          run.receipt(
            () => validReceiptRecord(),
            () => {},
          );
        },
        cleanup: () => events.push("cleanup"),
        writeReport: () => {
          events.push("report");
          throw typedError({ code: "EROFS", syscall: "open" });
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(events).toEqual(["body", "cleanup", "report"]);
    expect(reports).toEqual([]);
    expect(caught).toBeInstanceOf(Error);
    expect(caught.name).toBe("NativeRcReportWriteError");
    expect(caught.message).toBe("native RC smoke run report was not written");
    expect(caught.cause).toBeUndefined();
    expect(Object.keys(caught).sort()).toEqual(["finalization", "name", "reportWriteFamily"]);
    expect(caught.reportWriteFamily).toBe("filesystem");
    expect(caught.message).not.toMatch(/SENTINEL|\/private|9999/);
    expect(String(caught.stack ?? "")).not.toMatch(/SENTINEL|\/private|9999/);
    expectFinalization(caught.finalization, {
      schema: FINALIZATION_SCHEMA,
      status: "failed",
      phase: "report-write",
      exceptionFamily: "filesystem",
      spawned: true,
      exitObserved: true,
      applicationReceiptObservation: "present-at-read",
      applicationReceiptCopy: "written",
    });

    const fakeCheckout = scratch("fake-checkout-report");
    write(join(fakeCheckout, "docs/examples/v0.4/brand-system/core-minimal/.tfsb/project.toml"), 'name = "tampered"\n');
    const smokeDir = scratch("smoke-report-fail");
    let preservedCaught;
    try {
      await finalizeSmokeRun({
        result: baseResult({ label: "darwin-arm64-A", platform: "darwin-arm64", scenario: "A" }),
        keep: false,
        body: () => {
          prepareFixtures("A", fakeCheckout, smokeDir);
        },
        cleanup: () => {},
        writeReport: () => {
          throw typedError({ code: "ENOSPC", syscall: "write" });
        },
      });
    } catch (error) {
      preservedCaught = error;
    }
    expect(preservedCaught).toBeInstanceOf(Error);
    expect(preservedCaught.name).toBe("NativeRcReportWriteError");
    expect(preservedCaught.reportWriteFamily).toBe("filesystem");
    expectFinalization(preservedCaught.finalization, {
      schema: FINALIZATION_SCHEMA,
      status: "failed",
      phase: "pre-spawn",
      exceptionFamily: "state",
      spawned: false,
      exitObserved: false,
      applicationReceiptObservation: "not-attempted",
      applicationReceiptCopy: "not-attempted",
    });
  });

  it("skips scratch cleanup when keep is enabled and completes normally", async () => {
    const events = [];
    const reports = [];
    const result = baseResult();
    await finalizeSmokeRun({
      result,
      keep: true,
      body: (run) => {
        events.push("body");
        run.launched();
        run.exited();
        result.exit = { code: 0, signal: null, signalSent: null, durationMs: 7 };
        run.receipt(
          () => {
            events.push("receipt-read");
            return validReceiptRecord();
          },
          () => events.push("receipt-copy"),
        );
      },
      cleanup: () => events.push("cleanup"),
      writeReport: (text) => {
        events.push("report");
        reports.push(text);
      },
    });
    expect(events).toEqual(["body", "receipt-read", "receipt-copy", "report"]);
    expect(result.status).toBe("pass");
    expectFinalization(result.finalization, {
      schema: FINALIZATION_SCHEMA,
      status: "complete",
      phase: "complete",
      exceptionFamily: null,
      spawned: true,
      exitObserved: true,
      applicationReceiptObservation: "present-at-read",
      applicationReceiptCopy: "written",
    });
    expect(JSON.parse(reports[0])).toEqual(result);
  });

  it("classifies timeout and unmapped error shapes through the closed exception-family table", async () => {
    const cases = [
      [typedError({ code: "ETIMEDOUT" }), "timeout"],
      [new Error("SENTINEL message-only error"), "unknown"],
      [typedError({ code: "EWHATEVER" }), "unknown"],
    ];
    for (const [error, expectedFamily] of cases) {
      const result = baseResult();
      await finalizeSmokeRun({
        result,
        keep: false,
        body: () => {
          throw error;
        },
        cleanup: () => {},
        writeReport: () => {},
      });
      expectFinalization(result.finalization, {
        schema: FINALIZATION_SCHEMA,
        status: "failed",
        phase: "pre-spawn",
        exceptionFamily: expectedFamily,
        spawned: false,
        exitObserved: false,
        applicationReceiptObservation: "not-attempted",
        applicationReceiptCopy: "not-attempted",
      });
    }
  });
});

// A complete lane as it would stand after smoke, used by the seal and the catalog.
function laneFixture(overrides = {}) {
  const root = scratch("lane");
  const planRecord = plan("workflow_dispatch", { linux_x64: true, release_candidate: true });
  const executableSha256 = "e".repeat(64);
  const librarySha256 = "a".repeat(64);
  const materialDigest = overrides.materialDigest ?? null;
  const npm = Buffer.from("npm candidate"), raw = Buffer.from("raw candidate");
  write(join(root, "candidate/pkg.tgz"), npm);
  write(join(root, "candidate/raw.tar.gz"), raw);
  const manifest = { members: [
    { path: PLATFORMS["linux-x64"].executable, type: "file", mode: 0o755, size: 1, sha256: executableSha256 },
    { path: "payload/lib/libprivate.so", type: "file", mode: 0o644, size: 2, sha256: librarySha256 },
  ] };
  const payloadFiles = [
    { path: "bin/theme-forge-nebular-fusion", bytes: 1, mode: 0o755, sha256: executableSha256 },
    { path: "lib/libprivate.so", bytes: 2, mode: 0o644, sha256: librarySha256 },
  ];
  const nativePayload = {
    identity: identity(materialDigest === null ? payloadFiles : {
      schema: "nebular-native-payload-inventory-v1",
      materialDigest,
      files: payloadFiles,
      aliases: [],
      directories: [],
    }),
    files: payloadFiles.length,
  };
  write(join(root, "evidence/package-manifest.json"), JSON.stringify(manifest));
  const record = { platform: "linux-x64", version: "0.6.1", packageManifestSha256: sha256(Buffer.from(JSON.stringify(manifest))), glibcMinimum: "2.34",
    npm: { filename: "pkg.tgz", sha256: sha256(npm) }, raw: { filename: "raw.tar.gz", sha256: sha256(raw), executableSha256 } };
  write(join(root, "evidence/package-record.json"), JSON.stringify(record));
  write(join(root, "evidence/qualification.json"), JSON.stringify({ platform: "linux-x64", status: "pass", executableSha256, nativePayload, materialDigest, checks: [{ id: "x", ok: true }] }));
  write(join(root, "evidence/build-receipt.json"), JSON.stringify({ platform: "linux-x64", source: { commit: SHA, tree: "t" }, nativePayload }));
  write(join(root, "evidence/plan.json"), JSON.stringify(planRecord));
  for (const [scenario, source] of [["C", "raw-archive"], ["C-signal", "npm-package"]]) {
    write(join(root, `evidence/smoke/${scenario}-${source}.run.json`), JSON.stringify({ label: `${scenario}-${source}`, scenario, source, status: "pass", executable: { sha256: executableSha256 }, receipt: { sha256: "r".repeat(64), steps: [] } }));
  }
  overrides.mutate?.(root);
  const options = { lane: "linux-x64", plan: join(root, "evidence/plan.json"), candidateDir: join(root, "candidate"), packageRecord: join(root, "evidence/package-record.json"),
    packageManifest: join(root, "evidence/package-manifest.json"), qualification: join(root, "evidence/qualification.json"), smokeDir: join(root, "evidence/smoke"),
    buildReceipt: join(root, "evidence/build-receipt.json") };
  return { root, planRecord, options };
}

describe("evidence seal", () => {
  it("seals an unbroken identity chain", () => {
    const { options } = laneFixture();
    const result = seal(options);
    expect(result.problems).toEqual([]);
    expect(result.status).toBe("pass");
    expect(result.plan.retentionDays).toBe(90);
  });

  it("breaks on a changed candidate, a foreign executable, a missing source form or an unselected lane", () => {
    expect(seal(laneFixture({ mutate: (root) => write(join(root, "candidate/raw.tar.gz"), "rebuilt") }).options).problems.join()).toMatch(/raw candidate changed/);
    expect(seal(laneFixture({ mutate: (root) => write(join(root, "candidate/extra.bin"), "x") }).options).problems.join()).toMatch(/candidate directory holds/);
    expect(seal(laneFixture({ mutate: (root) => write(join(root, "evidence/smoke/C-raw-archive.run.json"), JSON.stringify({ label: "x", scenario: "C", source: "raw-archive", status: "pass", executable: { sha256: "f".repeat(64) } })) }).options)
      .problems.join()).toMatch(/did not execute the candidate executable/);
    expect(seal(laneFixture({ mutate: (root) => rmSync(join(root, "evidence/smoke/C-signal-npm-package.run.json")) }).options).problems.join()).toMatch(/C-signal did not run|both the raw archive and the npm package/);
    expect(seal(laneFixture({ mutate: (root) => {
      const path = join(root, "evidence/build-receipt.json");
      const build = JSON.parse(readFileSync(path, "utf8"));
      build.nativePayload.identity = "f".repeat(64);
      write(path, JSON.stringify(build));
    } }).options).problems.join()).toMatch(/build and qualification native payload identities differ/);
    expect(seal(laneFixture({ mutate: (root) => {
      const manifestPath = join(root, "evidence/package-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.members.find((member) => member.path === "payload/lib/libprivate.so").sha256 = "b".repeat(64);
      write(manifestPath, JSON.stringify(manifest));
      const recordPath = join(root, "evidence/package-record.json");
      const record = JSON.parse(readFileSync(recordPath, "utf8"));
      record.packageManifestSha256 = sha256(Buffer.from(JSON.stringify(manifest)));
      write(recordPath, JSON.stringify(record));
    } }).options).problems.join()).toMatch(/package and qualification native payload identities differ/);
    const { options } = laneFixture();
    expect(() => seal({ ...options, lane: "linux-arm64" })).toThrow(/not selected/);
  });

  it("seals a private material digest and rejects a same-GUI private-payload mismatch", () => {
    const materialDigest = "c".repeat(64);
    const accepted = seal(laneFixture({ materialDigest }).options);
    expect(accepted.problems).toEqual([]);
    expect(accepted.status).toBe("pass");

    const mismatched = seal(laneFixture({
      materialDigest,
      mutate: (root) => {
        const manifestPath = join(root, "evidence/package-manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.members.find((member) => member.path === "payload/lib/libprivate.so").sha256 = "b".repeat(64);
        write(manifestPath, JSON.stringify(manifest));
        const recordPath = join(root, "evidence/package-record.json");
        const record = JSON.parse(readFileSync(recordPath, "utf8"));
        record.packageManifestSha256 = sha256(Buffer.from(JSON.stringify(manifest)));
        write(recordPath, JSON.stringify(record));
      },
    }).options);
    expect(mismatched.problems.join()).toMatch(/package and qualification native payload identities differ/);
  });
});

describe("release-candidate catalog", () => {
  function catalogFixture({ result = "success", tamper, digest = "a".repeat(64), expiresInDays = 90 } = {}) {
    const lane = laneFixture();
    const evidence = seal(lane.options);
    const artifactName = lane.planRecord.lanes["linux-x64"].candidateArtifact;
    const download = scratch("download");
    const artifact = join(download, artifactName);
    write(join(artifact, "evidence/rc-evidence.json"), JSON.stringify(evidence));
    write(join(artifact, "candidate/pkg.tgz"), readFileSync(join(lane.root, "candidate/pkg.tgz")));
    write(join(artifact, "candidate/raw.tar.gz"), tamper ? "tampered" : readFileSync(join(lane.root, "candidate/raw.tar.gz")));
    const needs = { plan: { result: "success", outputs: {} }, "macos-arm64": { result: "skipped", outputs: {} }, "linux-arm64": { result: "skipped", outputs: {} },
      "linux-x64": { result, outputs: { artifact_id: "1234", artifact_digest: digest, evidence_sha256: sha256(readFileSync(join(artifact, "evidence/rc-evidence.json"))) } } };
    const now = Date.parse("2026-10-01T00:00:00Z");
    const expiry = async () => ({ expiresAt: new Date(now + expiresInDays * 86400000).toISOString(), digest: `sha256:${digest}` });
    return { plan: lane.planRecord, needs, downloadDir: download, expiry, now };
  }

  it("qualifies a lane only with its artifact id, digest, sealed evidence, exact bytes and granted retention", async () => {
    const index = await buildIndex(catalogFixture());
    expect(index.status).toBe("pass");
    expect(index.passed).toEqual(["linux-x64"]);
    expect(index.skipped).toEqual(["macos-arm64", "linux-arm64"]);
    expect(index.appleManualConfirmationRequired).toBe(false);
    expect(index.lanes.find((entry) => entry.lane === "linux-x64")).toMatchObject({ status: "qualified-automated", artifact: { id: "1234", retentionDaysObserved: 90 } });
  });

  it("never qualifies a failed job, tampered bytes, a missing digest, short retention or an absent read-back", async () => {
    expect((await buildIndex(catalogFixture({ result: "failure" }))).lanes.find((entry) => entry.lane === "linux-x64").status).toBe("failed");
    const tampered = await buildIndex(catalogFixture({ tamper: true }));
    expect(tampered.status).toBe("fail");
    expect(tampered.lanes.find((entry) => entry.lane === "linux-x64").problems.join()).toMatch(/does not match its sealed digest/);
    expect((await buildIndex(catalogFixture({ digest: "" }))).lanes.find((entry) => entry.lane === "linux-x64").problems.join()).toMatch(/no uploaded artifact digest/);
    expect((await buildIndex(catalogFixture({ expiresInDays: 30 }))).lanes.find((entry) => entry.lane === "linux-x64").problems.join()).toMatch(/not the requested 90/);
    const noReadBack = catalogFixture();
    delete noReadBack.expiry;
    expect((await buildIndex(noReadBack)).status).toBe("fail");
  });
});

describe("closed-input native pins", () => {
  it("the Rust sidecar verifier pins every target to the Node authority and the authenticated Burst prebuilds", () => {
    const studio = new URL("..", import.meta.url).pathname;
    const source = readFileSync(join(studio, "src-tauri/src/sidecar/artifact.rs"), "utf8");
    const pins = [...source.matchAll(/ClosedInputPins \{\s*target: "([^"]+)",\s*runtime_sha256: "([a-f0-9]{64})",\s*runtime_size: ([0-9_]+),\s*native_sha256: "([a-f0-9]{64})",\s*native_size: ([0-9_]+),\s*\}/g)]
      .map(([, target, runtimeSha256, runtimeSize, nativeSha256, nativeSize]) => ({ target, runtimeSha256, runtimeSize: Number(runtimeSize.replaceAll("_", "")), nativeSha256, nativeSize: Number(nativeSize.replaceAll("_", "")) }));
    expect(pins.map((pin) => pin.target)).toEqual(["aarch64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]);
    const tarballs = spawnSync("ls", [join(studio, "authenticated-inputs/core-tarball")], { encoding: "utf8" }).stdout.split("\n").filter((name) => name.endsWith(".tgz"));
    const coreTarball = tarballs.length === 1 ? join(studio, "authenticated-inputs/core-tarball", tarballs[0]) : null;
    const addon = { "aarch64-apple-darwin": "darwin-arm64", "aarch64-unknown-linux-gnu": "linux-arm64-gnu", "x86_64-unknown-linux-gnu": "linux-x64-gnu" };
    for (const pin of pins) {
      const runtime = NODE_RELEASE_IDENTITY.targets[pin.target];
      expect(pin.runtimeSha256).toBe(runtime.executableSha256);
      expect(pin.runtimeSize).toBe(runtime.executableSize);
      if (coreTarball) {
        const bytes = spawnSync("tar", ["-xzOf", coreTarball, `package/native/directory-snapshot/prebuilds/${addon[pin.target]}/native-addon-posix-openat-v1.node`], { maxBuffer: 8 * 1024 * 1024 }).stdout;
        expect(sha256(bytes), pin.target).toBe(pin.nativeSha256);
        expect(bytes.length).toBe(pin.nativeSize);
      }
    }
  });
});

describe("linux private-runtime RC integration", () => {
  function populatePrivateLinuxPayload(root, { ordinaryLauncher = false, extraPayloadElf = false } = {}) {
    const platform = PLATFORMS["linux-x64"];
    const target = platform.target;
    const elf = Buffer.alloc(64);
    Buffer.from([0x7f, 69, 76, 70, 2, 1, 1]).copy(elf);
    elf.writeUInt16LE(3, 16);
    elf.writeUInt16LE(62, 18);
    write(join(root, "bin/theme-forge-nebular-fusion"), elf, 0o755);
    write(join(root, "bin/tfsb-studio-service"), elf, 0o755);
    write(join(root, "bin/tfnf"), nativeLauncher(target, { nativeRuntime: !ordinaryLauncher }), 0o755);
    for (const resource of [
      "loom-payload/index.json",
      "loom-preview-source/package.json",
      "public/preview/index.html",
      "resources/theme-pack.json",
      "solar-payload/index.json",
      "sidecar-payload/manifest.json",
      "THIRD_PARTY_NOTICES/index.txt",
    ]) {
      write(join(root, "lib/theme-forge-nebular-fusion", resource), "{}", 0o644);
    }
    if (extraPayloadElf) {
      write(join(root, "lib/theme-forge-nebular-fusion/extra-elf/embedded-helper"), elf, 0o644);
    }
    mkdirSync(join(root, "opt"), { recursive: true, mode: 0o755 });
    chmodSync(join(root, "opt"), 0o755);
    const directories = [];
    for (const dir of REQUIRED_RUNTIME_DIRECTORIES) {
      const absDir = join(root, dir);
      mkdirSync(absDir, { recursive: true, mode: 0o755 });
      chmodSync(absDir, 0o755);
      directories.push({ path: dir, mode: 0o755 });
    }
    const regulars = [];
    for (const role of REQUIRED_RUNTIME_ROLES) {
      const executable = REQUIRED_EXECUTABLE_RUNTIME_ROLES.includes(role);
      const mode = executable ? 0o755 : 0o644;
      const content = Buffer.from(elf);
      write(join(root, role), content, mode);
      chmodSync(join(root, role), mode);
      regulars.push({
        path: role,
        bytes: content.length,
        sha256: sha256(content),
        mode,
        role: executable ? "helper-executable" : "shared-object",
      });
    }
    regulars.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const aliases = [
      {
        path: "opt/nebular-private/lib/libjavascriptcoregtk-4.1.so.0",
        target: "libjavascriptcoregtk-4.1.so.0.9.11",
        canonical: "opt/nebular-private/lib/libjavascriptcoregtk-4.1.so.0.9.11",
      },
      {
        path: "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0",
        target: "libwebkit2gtk-4.1.so.0.19.9",
        canonical: "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0.19.9",
      },
    ];
    for (const alias of aliases) {
      symlinkSync(alias.target, join(root, alias.path));
    }

    const externalFloor = externalFloorForTarget(platform.triple).map((soname) => ({
      soname,
      basis: `debian-bookworm:${soname}`,
      sha256: sha256(Buffer.from(`floor:${soname}`)),
      bytes: 4096,
      ...(soname === "libc.so.6" ? { versions: ["GLIBC_2.34", "GLIBC_2.36"] } : {}),
    }));

    const unsignedMaterial = {
      schema: "nebular-native-runtime-material-v1",
      target: platform.triple,
      prefix: PRIVATE_RUNTIME_PREFIX,
      directories,
      regulars,
      aliases,
      requiredRoles: [...REQUIRED_RUNTIME_ROLES],
      externalFloor,
    };
    const material = {
      ...unsignedMaterial,
      materialDigest: computeMaterialDigest(unsignedMaterial),
    };
    write(
      join(root, PRIVATE_RUNTIME_MARKER),
      JSON.stringify(material, null, 2) + "\n",
      0o644
    );
    return { root, material };
  }

  function nativeRuntimeInput(root, material, size = null) {
    const inputPath = join(scratch("runtime-input"), "native-runtime-input.json");
    const input = {
      schema: "nebular-native-runtime-input-v1",
      target: "x86_64-unknown-linux-gnu",
      sourceRoot: root,
      material,
      evidence: { fixture: sha256(Buffer.from("fixture")) },
    };
    const json = Buffer.from(`${JSON.stringify(input)}\n`);
    const bytes = size === null ? json : Buffer.concat([json, Buffer.alloc(Math.max(0, size - json.length), 0x20)]);
    write(inputPath, bytes, 0o644);
    return { inputPath, bytes, expectedSha256: sha256(bytes) };
  }

  async function authenticateInput(fixture) {
    return authenticateNativeRuntimeInput(fixture.inputPath, fixture.expectedSha256, {
      expectedTarget: "x86_64-unknown-linux-gnu",
    });
  }

  it("uses descriptor-first bounded admission for regular, symlink, nonregular, and oversize inputs", async () => {
    const validPayload = populatePrivateLinuxPayload(scratch("descriptor-regular"));
    const valid = nativeRuntimeInput(validPayload.root, validPayload.material);
    await expect(authenticateInput(valid)).resolves.toMatchObject({ inputSha256: valid.expectedSha256 });

    const symlinkPayload = populatePrivateLinuxPayload(scratch("descriptor-symlink"));
    const symlinkInput = nativeRuntimeInput(symlinkPayload.root, symlinkPayload.material);
    const symlinkTarget = join(dirname(symlinkInput.inputPath), "native-runtime-input-target.json");
    write(symlinkTarget, symlinkInput.bytes, 0o644);
    rmSync(symlinkInput.inputPath);
    symlinkSync(symlinkTarget, symlinkInput.inputPath);
    await expect(authenticateInput(symlinkInput)).rejects.toThrow(/regular file|symbolic link|ELOOP/i);

    const nonregularPayload = populatePrivateLinuxPayload(scratch("descriptor-nonregular"));
    const nonregular = nativeRuntimeInput(nonregularPayload.root, nonregularPayload.material);
    rmSync(nonregular.inputPath);
    expect(spawnSync("mkfifo", [nonregular.inputPath]).status).toBe(0);
    await expect(authenticateInput(nonregular)).rejects.toThrow(/regular file|FIFO|non-regular/i);

    const oversizePayload = populatePrivateLinuxPayload(scratch("descriptor-oversize"));
    const oversize = nativeRuntimeInput(oversizePayload.root, oversizePayload.material);
    truncateSync(oversize.inputPath, MAX_RUNTIME_INPUT_BYTES + 1);
    await expect(authenticateInput(oversize)).rejects.toThrow(/byte limit|exceeds/i);
  });

  it("fails closed when a bounded input is shortened, grown, replaced, or identity-mutated during admission", async () => {
    const runMutationCase = async (name, mutate, expected) => {
      const payload = populatePrivateLinuxPayload(scratch(`descriptor-${name}`));
      const fixture = nativeRuntimeInput(payload.root, payload.material, 8 * 1024 * 1024);
      const timer = setInterval(() => {
        try {
          mutate(fixture.inputPath);
        } catch {
          // The mutation is intentionally racing the real descriptor reader.
        }
      }, 1);
      try {
        await expect(authenticateInput(fixture)).rejects.toThrow(expected);
      } finally {
        clearInterval(timer);
      }
    };

    await runMutationCase("short", (path) => truncateSync(path, 1), /truncated|size changed|drift|Malformed|keys differ|Native runtime input SHA-256 mismatch/i);
    await runMutationCase("grow", (path) => appendFileSync(path, Buffer.from("x")), /grew|size changed|drift|Malformed|keys differ|Native runtime input SHA-256 mismatch/i);
    await runMutationCase("replacement", (path) => {
      const replacement = `${path}.replacement`;
      renameSync(path, replacement);
      writeFileSync(path, Buffer.from("replacement\n"));
    }, /drift|changed|Malformed|keys differ|ENOENT|Native runtime input SHA-256 mismatch|Hardlinked regular file refused \(nlink=0\)/i);
    await runMutationCase("identity", (path) => chmodSync(path, 0o4755), /privilege|drift|changed|Malformed|keys differ|Native runtime input SHA-256 mismatch/i);
  });

  it("packages private-runtime Linux payloads, preserves SONAME aliases, and refuses ordinary launchers, malformed markers, or missing roles", async () => {
    const checkout = scratch("checkout-private");
    write(join(checkout, "LICENSE"), "license\n");
    write(join(checkout, "NOTICE"), "notice\n");
    const { root: payload } = populatePrivateLinuxPayload(scratch("payload-private"));
    const outDir = scratch("out-private");
    const archived = await assembleRawArchive({ platform: "linux-x64", payload, checkout, output: outDir });
    const extract = scratch("extract-private");
    expect(spawnSync("tar", ["-xzf", archived.file, "-C", extract]).status).toBe(0);
    const extractedRoot = join(extract, "theme-forge-nebular-fusion");
    expect(readFileSync(join(extractedRoot, "bin/tfnf"), "utf8")).toBe(nativeLauncher(PLATFORMS["linux-x64"].target, { nativeRuntime: true }));
    const aliasPath = join(extractedRoot, "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0");
    expect(lstatSync(aliasPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(aliasPath)).toBe("libwebkit2gtk-4.1.so.0.19.9");

    // Ordinary launcher in a private-runtime payload is refused
    const { root: badLauncherPayload } = populatePrivateLinuxPayload(scratch("payload-ordinary-launcher"), { ordinaryLauncher: true });
    await expect(assembleRawArchive({ platform: "linux-x64", payload: badLauncherPayload, checkout, output: scratch("out-bad-launcher") }))
      .rejects.toThrow(/launcher/);

    // Missing required runtime role is refused
    const { root: missingRolePayload } = populatePrivateLinuxPayload(scratch("payload-missing-role"));
    rmSync(join(missingRolePayload, "opt/nebular-private/libexec/webkit2gtk-4.1/WebKitWebProcess"));
    await expect(assembleRawArchive({ platform: "linux-x64", payload: missingRolePayload, checkout, output: scratch("out-missing-role") }))
      .rejects.toThrow(/regular count .* does not match|missing declared regular/i);

    // Malformed native-runtime.json is refused
    const { root: badMarkerPayload } = populatePrivateLinuxPayload(scratch("payload-bad-marker"));
    write(join(badMarkerPayload, PRIVATE_RUNTIME_MARKER), "not-json\n", 0o644);
    await expect(assembleRawArchive({ platform: "linux-x64", payload: badMarkerPayload, checkout, output: scratch("out-bad-marker") }))
      .rejects.toThrow(/Malformed native-runtime\.json/);
  });

  it("uses a complete authenticated regular-copy projection for every npm alias while raw output stays symlinked", () => {
    const checkout = scratch("checkout-projection");
    write(join(checkout, "LICENSE"), "license\n");
    write(join(checkout, "NOTICE"), "notice\n");
    const { root: payload } = populatePrivateLinuxPayload(scratch("payload-projection"));
    const assembled = assemblePlatformPackage({
      platform: "linux-x64",
      payload,
      checkout,
      output: scratch("package-projection"),
      glibcMinimum: "2.34",
    });
    expect(assembled.manifest.schema).toBe(PACKAGE_MANIFEST_PROJECTION_SCHEMA);
    expect(assembled.manifest.runtimeAliasProjection.aliases).toHaveLength(2);
    for (const alias of assembled.manifest.runtimeAliasProjection.aliases) {
      const copied = join(assembled.packageDir, "payload", alias.path);
      const copiedSnapshot = readRegularFile(copied, { label: `projected alias ${alias.path}` });
      const canonicalSnapshot = readRegularFile(join(payload, alias.canonical), { label: `canonical alias ${alias.canonical}` });
      expect(copiedSnapshot.identity.mode & 0o777).toBe(0o644);
      expect(copiedSnapshot.bytes).toEqual(canonicalSnapshot.bytes);
    }
    expect(() => verifyPlatformPackage(assembled.packageDir, "linux-x64", assembled.manifestSha256)).not.toThrow();
    expect(() => authenticateNpmPackageContext(assembled.packageDir, "linux-x64", assembled.manifestSha256)).not.toThrow();
    expect(() => authenticateNpmPackageContext(assembled.packageDir, "linux-x64", "0".repeat(64))).toThrow(/Payload manifest authentication/);
    expect(() => authenticateNpmPackageContext(assembled.packageDir, "linux-arm64", assembled.manifestSha256)).toThrow(/identity|target|projection/i);
    expect(() => packPlatformPackage(assembled.packageDir, join(scratch("pack-v2-missing-context"), "candidate"), {
      node: process.execPath,
      npmCli: "unused",
      scratch: scratch("pack-v2-missing-context-scratch"),
    })).toThrow(/Projected or unknown package manifest requires complete authenticated platform/);
    expect(() => packPlatformPackage(assembled.packageDir, join(scratch("pack-v2-missing-platform"), "candidate"), {
      node: process.execPath,
      npmCli: "unused",
      scratch: scratch("pack-missing-platform-scratch"),
      manifestSha256: assembled.manifestSha256,
    })).toThrow(/Complete authenticated platform/);
    expect(() => packPlatformPackage(assembled.packageDir, join(scratch("pack-v2-missing-manifest"), "candidate"), {
      node: process.execPath,
      npmCli: "unused",
      scratch: scratch("pack-missing-manifest-scratch"),
      platform: "linux-x64",
    })).toThrow(/Complete authenticated platform/);

    const firstAlias = assembled.manifest.runtimeAliasProjection.aliases[0];
    writeFileSync(join(assembled.packageDir, "payload", firstAlias.path), Buffer.from("tampered"));
    expect(() => verifyPlatformPackage(assembled.packageDir, "linux-x64", assembled.manifestSha256)).toThrow(/Payload member mismatch/);

    const legacyManifest = JSON.parse(readFileSync(join(assembled.packageDir, "package-manifest.json"), "utf8"));
    legacyManifest.schema = "tfsb.nebular-package-manifest-v1";
    writeFileSync(join(assembled.packageDir, "package-manifest.json"), `${JSON.stringify(legacyManifest)}\n`);
    const legacyManifestSha256 = sha256(readFileSync(join(assembled.packageDir, "package-manifest.json")));
    expect(() => authenticateNpmPackageContext(assembled.packageDir, "linux-x64", legacyManifestSha256)).toThrow(/Legacy package manifest/);
    expect(() => packPlatformPackage(assembled.packageDir, join(scratch("pack-v1-smuggled-projection"), "candidate"), {
      node: process.execPath,
      npmCli: "unused",
      scratch: scratch("pack-v1-smuggled-projection-scratch"),
    })).toThrow(/Projected or unknown package manifest requires complete authenticated platform/);
  });

  it("requires v2 for a stripped private-runtime projection while accepting a genuine legacy payload", () => {
    const checkout = scratch("checkout-legacy-downgrade");
    write(join(checkout, "LICENSE"), "license\n");
    write(join(checkout, "NOTICE"), "notice\n");
    const { root: payload } = populatePrivateLinuxPayload(scratch("payload-legacy-downgrade"));
    const assembled = assemblePlatformPackage({
      platform: "linux-x64",
      payload,
      checkout,
      output: scratch("package-legacy-downgrade"),
      glibcMinimum: "2.34",
    });

    const strippedManifestPath = join(assembled.packageDir, "package-manifest.json");
    const strippedManifest = JSON.parse(readFileSync(strippedManifestPath, "utf8"));
    strippedManifest.schema = "tfsb.nebular-package-manifest-v1";
    delete strippedManifest.runtimeAliasProjection;
    const strippedManifestBytes = Buffer.from(`${JSON.stringify(strippedManifest)}\n`);
    writeFileSync(strippedManifestPath, strippedManifestBytes);
    const strippedManifestSha256 = sha256(strippedManifestBytes);
    expect(() => verifyPlatformPackage(assembled.packageDir, "linux-x64", strippedManifestSha256))
      .toThrow(/requires v2 for private runtime members/);
    expect(() => verifyPayload(assembled.packageDir, NPM_TARGETS["linux-x64"], strippedManifestSha256))
      .toThrow(/requires v2 for private runtime members/);

    const { root: legacyPayload } = populatePrivateLinuxPayload(scratch("payload-ordinary-legacy"), { ordinaryLauncher: true });
    const legacy = assemblePlatformPackage({
      platform: "linux-x64",
      payload: legacyPayload,
      checkout,
      output: scratch("package-ordinary-legacy"),
      glibcMinimum: "2.34",
    });
    rmSync(join(legacy.packageDir, "payload/opt/nebular-private"), { recursive: true, force: true });
    rmSync(join(legacy.packageDir, "payload/native-runtime.json"), { force: true });
    const legacyPath = join(legacy.packageDir, "package-manifest.json");
    const legacyManifest = JSON.parse(readFileSync(legacyPath, "utf8"));
    legacyManifest.schema = "tfsb.nebular-package-manifest-v1";
    delete legacyManifest.runtimeAliasProjection;
    legacyManifest.members = legacyManifest.members.filter((member) => member.path !== "payload/opt/nebular-private"
      && member.path !== "payload/native-runtime.json" && !member.path.startsWith("payload/opt/nebular-private/"));
    legacyManifest.fileCount = legacyManifest.members.length;
    const legacyBytes = Buffer.from(`${JSON.stringify(legacyManifest)}\n`);
    writeFileSync(legacyPath, legacyBytes);
    const legacyManifestSha256 = sha256(legacyBytes);
    expect(() => verifyPlatformPackage(legacy.packageDir, "linux-x64", legacyManifestSha256)).not.toThrow();
    expect(() => verifyPayload(legacy.packageDir, NPM_TARGETS["linux-x64"], legacyManifestSha256)).not.toThrow();
  });

  it("authenticates the physical regular-copy projection after npm pack extraction", async () => {
    const checkout = scratch("checkout-pack-projection");
    write(join(checkout, "LICENSE"), "license\n");
    write(join(checkout, "NOTICE"), "notice\n");
    const payload = populatePrivateLinuxPayload(scratch("payload-pack-projection")).root;
    const output = scratch("pack-projection");
    const assembled = assemblePlatformPackage({
      platform: "linux-x64",
      payload,
      checkout,
      output: join(output, "package"),
      glibcMinimum: "2.34",
    });
    const node = process.execPath;
    const npmCli = join(dirname(dirname(node)), "lib/node_modules/npm/bin/npm-cli.js");
    expect(existsSync(npmCli)).toBe(true);
    const packed = packPlatformPackage(assembled.packageDir, join(output, "candidate"), {
      node,
      npmCli,
      scratch: output,
      platform: "linux-x64",
      manifestSha256: assembled.manifestSha256,
    });
    expect(packed.size).toBeGreaterThan(0);
    expect(packed.sha256).toMatch(/^[a-f0-9]{64}$/);
    const extracted = scratch("pack-projection-extracted");
    expect(spawnSync("tar", ["-xzf", packed.file, "-C", extracted]).status).toBe(0);
    const projected = await inventoryNativePayload(join(extracted, "package", "payload"), {
      expectedTarget: "x86_64-unknown-linux-gnu",
      aliasProjection: assembled.manifest.runtimeAliasProjection,
    });
    expect(projected.identity).toBe(await inventoryNativePayload(payload, { expectedTarget: "x86_64-unknown-linux-gnu" }).then((value) => value.identity));
    const selected = await selectPayloadNativeRuntime(join(extracted, "package", "payload"), "x86_64-unknown-linux-gnu", {
      aliasProjection: assembled.manifest.runtimeAliasProjection,
    });
    expect(selected.nativeRuntime).toBe(true);
  });

  it("inventories private-runtime payloads via inventoryNativePayload and smoke launcherPath selects bin/tfnf on Linux", async () => {
    const { root: payload } = populatePrivateLinuxPayload(scratch("payload-evidence"));
    const inv = await inventoryNativePayload(payload);
    expect(inv.schema).toBe("nebular-native-payload-inventory-v1");
    expect(inv.aliases.length).toBe(2);
    const projection = createNativeRuntimeAliasProjection(JSON.parse(readFileSync(join(payload, PRIVATE_RUNTIME_MARKER), "utf8")));
    const projected = await inventoryNativePayload(payload, { expectedTarget: "x86_64-unknown-linux-gnu", aliasProjection: projection });
    expect(projected.identity).toBe(inv.identity);
    await expect(inventoryNativePayload(payload, { expectedTarget: "x86_64-unknown-linux-gnu", aliasProjection: { ...projection, aliases: projection.aliases.slice(1) } })).rejects.toThrow(/projection/);

    // launcherPath selects bin/tfnf on Linux and GUI binary on Darwin while executablePath remains GUI binary
    expect(launcherPath("/opt/app", "linux-x64")).toBe("/opt/app/bin/tfnf");
    expect(executablePath("/opt/app", "linux-x64")).toBe("/opt/app/bin/theme-forge-nebular-fusion");
    expect(launcherPath("/opt/app", "darwin-arm64")).toBe(executablePath("/opt/app", "darwin-arm64"));
  });

  it("keeps naked Linux legal files in identity and admits only an explicit archive envelope", async () => {
    const payload = scratch("legal-envelope-payload");
    mkdirSync(join(payload, "bin"), { recursive: true });
    write(join(payload, "bin/theme-forge-nebular-fusion"), "payload\n", 0o755);
    const base = await inventoryNativePayload(payload);
    const checkout = scratch("legal-envelope-checkout");
    const license = "license\n";
    const notice = "notice\n";
    write(join(checkout, "LICENSE"), license, 0o644);
    write(join(checkout, "NOTICE"), notice, 0o644);
    write(join(payload, "LICENSE"), license, 0o644);
    write(join(payload, "NOTICE"), notice, 0o644);

    const ordinary = await inventoryNativePayload(payload);
    expect(ordinary.identity).not.toBe(base.identity);
    expect(ordinary.files.map(({ path }) => path)).toEqual(expect.arrayContaining(["LICENSE", "NOTICE"]));
    const envelope = await readLinuxArchiveLegalEnvelope(payload, checkout);
    const admitted = await inventoryNativePayload(payload, { rootEnvelope: envelope });
    expect(admitted.identity).toBe(base.identity);
    expect(admitted.files.map(({ path }) => path)).not.toEqual(expect.arrayContaining(["LICENSE", "NOTICE"]));

    // The native-rc-package producer reads checkout-root legal files. A
    // nested file is not an alternate source and is not read by admission.
    mkdirSync(join(checkout, "apps/studio"), { recursive: true });
    symlinkSync(join(checkout, "NOTICE"), join(checkout, "apps/studio/NOTICE"));
    await expect(readLinuxArchiveLegalEnvelope(payload, checkout)).resolves.toEqual(envelope);
    rmSync(join(checkout, "apps/studio"), { recursive: true, force: true });

    write(join(payload, "nested/NOTICE"), "nested legal\n", 0o644);
    const nested = await inventoryNativePayload(payload, { rootEnvelope: envelope });
    expect(nested.files.map(({ path }) => path)).toContain("nested/NOTICE");
    expect(nested.identity).not.toBe(base.identity);

    write(join(payload, "unexpected-root-file"), "reject\n", 0o644);
    const unexpected = await inventoryNativePayload(payload, { rootEnvelope: envelope });
    expect(unexpected.files.some(({ path }) => path === "unexpected-root-file")).toBe(true);
    expect(() => selectPayloadInventoryForQualification(PLATFORMS["linux-x64"], {
      hasExpectedPayload: true,
      ordinaryInventory: unexpected,
      expectedNativePayloadSha256: base.identity,
    })).toThrow(/does not match expected/);
    rmSync(join(payload, "unexpected-root-file"));
    rmSync(join(payload, "nested/NOTICE"));

    rmSync(join(payload, "NOTICE"));
    expect((await inventoryNativePayload(payload)).files.map(({ path }) => path)).toContain("LICENSE");
    await expect(readLinuxArchiveLegalEnvelope(payload, checkout)).rejects.toThrow(/both LICENSE and NOTICE/);
    write(join(payload, "NOTICE"), notice, 0o644);

    rmSync(join(payload, "NOTICE"));
    symlinkSync(join(checkout, "NOTICE"), join(payload, "NOTICE"));
    await expect(readLinuxArchiveLegalEnvelope(payload, checkout)).rejects.toThrow();
    rmSync(join(payload, "NOTICE"));
    mkdirSync(join(payload, "NOTICE"));
    await expect(readLinuxArchiveLegalEnvelope(payload, checkout)).rejects.toThrow();
  });

  it("qualifyPayload enforces paired local nativeRuntime vs consumer expectedNativePayloadSha256 and validates private closure", async () => {
    const { root: payload } = populatePrivateLinuxPayload(scratch("payload-qualify"), { extraPayloadElf: true });
    const studio = new URL("..", import.meta.url).pathname;
    const checkout = scratch("checkout-qualify");
    write(join(checkout, "src-tauri/tauri.conf.json"), readFileSync(join(studio, "src-tauri/tauri.conf.json")));
    for (const resource of [
      "loom-payload/index.json",
      "loom-preview-source/package.json",
      "public/preview/index.html",
      "resources/theme-pack.json",
      "solar-payload/index.json",
      "sidecar-payload/manifest.json",
      "THIRD_PARTY_NOTICES/index.txt",
    ]) {
      write(join(checkout, "src-tauri", resource), "{}", 0o644);
    }
    const legalLicense = "qualify license\n";
    const legalNotice = "qualify notice\n";
    write(join(checkout, "LICENSE"), legalLicense, 0o644);
    write(join(checkout, "NOTICE"), legalNotice, 0o644);
    write(join(payload, "LICENSE"), legalLicense, 0o644);
    write(join(payload, "NOTICE"), legalNotice, 0o644);
    for (const resource of [
      "loom-adapter/fixture.json",
      "solar-sail-payload/fixture.json",
      "solar-sail-adapter/fixture.json",
      "scene-payload/fixture.json",
      "release-notices/fixture.json",
    ]) {
      write(join(checkout, "src-tauri", resource), "{}", 0o644);
      write(join(payload, "lib/theme-forge-nebular-fusion", resource), "{}", 0o644);
    }
    const payloadInv = await inventoryNativePayload(payload);
    const archiveEnvelope = await readLinuxArchiveLegalEnvelope(payload, checkout);
    const admittedPayloadInv = await inventoryNativePayload(payload, { rootEnvelope: archiveEnvelope });

    // Missing both local runtime authority and expectedNativePayloadSha256 is refused
    await expect(qualifyPayload({ platform: "linux-x64", payload, checkout }))
      .rejects.toThrow(/requires either paired \(--native-runtime, --native-runtime-sha256\) or --expected-native-payload-sha256/);

    // Providing both local runtime authority and expectedNativePayloadSha256 is refused
    await expect(qualifyPayload({
      platform: "linux-x64",
      payload,
      checkout,
      nativeRuntime: "/tmp/rt.json",
      nativeRuntimeSha256: "a".repeat(64),
      expectedNativePayloadSha256: payloadInv.identity,
    })).rejects.toThrow(/not both/);

    // Consumer-mode qualification with expectedNativePayloadSha256 succeeds on private-runtime-closure without local source paths
    const runtimeLib = join(payload, "opt/nebular-private/lib");
    const hostFixtureRoot = scratch("host-fixture");
    const hostLibc = join(hostFixtureRoot, "host-libc.so.6");
    const hostLoader = join(hostFixtureRoot, "ld-linux-x86-64.so.2");
    write(hostLibc, Buffer.alloc(64), 0o755);
    write(hostLoader, Buffer.alloc(64), 0o755);
    const boundedResult = result => ({ ...result, error: result.error ?? null, bounded: true, timedOut: false, outputLimitExceeded: false, cleanupKnown: true, outputComplete: true, forcedCleanup: false });
    const readelfCalls = [];
    const lddCalls = [];
    const mockRunner = (program, args) => {
      if (program === "readelf") {
        readelfCalls.push([...args]);
        const subject = args.at(-1);
        const stdout = subject === hostLibc
          ? [
              "ELF Header:",
              "  Class:                             ELF64",
              "  Machine:                           Advanced Micro Devices X86-64",
              "  Type:                              DYN (Shared object file)",
              "Version definition section '.gnu.version_d' contains 1 entry:",
              "  0x001c: Rev: 1  Flags: none  Index: 2  Cnt: 1  Name: GLIBC_2.34",
            ].join("\n")
          : subject === join(runtimeLib, "libwebkit2gtk-4.1.so.0.19.9")
            ? [
                "ELF Header:",
                "  Class:                             ELF64",
                "  Machine:                           Advanced Micro Devices X86-64",
                "  Type:                              DYN (Shared object file)",
                "Version definition section '.gnu.version_d' contains 1 entry:",
                "  0x001c: Rev: 1  Flags: none  Index: 2  Cnt: 1  Name: WEBKIT_4.1",
              ].join("\n")
            : [
                "ELF Header:",
                "  Class:                             ELF64",
                "  Machine:                           Advanced Micro Devices X86-64",
                "  Type:                              DYN (Position-Independent Executable file)",
                "Program Headers:",
                "      [Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]",
                "Dynamic section at offset 0x100 contains 2 entries:",
                " 0x0000000000000001 (NEEDED)             Shared library: [libwebkit2gtk-4.1.so.0]",
                " 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]",
                "Version needs section '.gnu.version_r' contains 1 entry:",
                "  0x0020: Version: 1  File: libc.so.6  Cnt: 1",
                "  0x0030:   Name: GLIBC_2.34  Flags: none  Version: 2",
              ].join("\n");
        return boundedResult({ status: 0, stdout, stderr: "" });
      }
      if (program === "ldd") {
        lddCalls.push([...args]);
        return boundedResult({
          status: 0,
          stdout: [
            `\tlibwebkit2gtk-4.1.so.0 => ${join(runtimeLib, "libwebkit2gtk-4.1.so.0.19.9")} (0x00007f0000010000)`,
            `\tlibc.so.6 => ${hostLibc} (0x00007f0000020000)`,
            `\t${hostLoader} (0x00007f0000030000)`,
          ].join("\n"),
          stderr: "",
        });
      }
      return boundedResult({ status: 0, stdout: "", stderr: "" });
    };
    const qualified = await qualifyPayload({
      platform: "linux-x64",
      payload,
      checkout,
      expectedNativePayloadSha256: payloadInv.identity,
      commandRunner: mockRunner,
    });
    expect(qualified.checks.find(c => c.id === "launcher")?.ok).toBe(true);
    expect(qualified.checks.find(c => c.id === "glibc-floor")?.ok).toBe(true);
    expect(qualified.checks.find(c => c.id === "linkage")?.ok).toBe(true);
    const closureCheck = qualified.checks.find(c => c.id === "private-runtime-closure");
    expect(closureCheck?.ok).toBe(true);
    expect(closureCheck?.detail.portabilityObservation.schema).toBe("nebular-native-elf-portability-observation-set-v1");
    expect(closureCheck?.detail.portabilityObservation.records.length).toBeGreaterThan(0);
    expect(closureCheck?.detail.portabilityObservation.records.every(record => record.readelf.streamSha256.match(/^[a-f0-9]{64}$/))).toBe(true);
    const extraRecord = closureCheck?.detail.portabilityObservation.records.find(record => record.relativePath === "lib/theme-forge-nebular-fusion/extra-elf/embedded-helper");
    expect(extraRecord).toBeDefined();
    expect(extraRecord?.sha256).toBe(sha256(readFileSync(join(payload, "lib/theme-forge-nebular-fusion/extra-elf/embedded-helper"))));
    expect(readelfCalls.some(args => args.at(-1) === join(payload, "lib/theme-forge-nebular-fusion/extra-elf/embedded-helper"))).toBe(true);
    expect(lddCalls.some(args => args.at(-1) === join(payload, "lib/theme-forge-nebular-fusion/extra-elf/embedded-helper"))).toBe(true);
    expect(readelfCalls.some(args => args.includes("-n") && args.includes("-A") && args.at(-1) === join(runtimeLib, "libwebkit2gtk-4.1.so.0.19.9"))).toBe(true);

    // The real raw-archive path qualifies a private-marker payload while
    // excluding only the authenticated root legal envelope from identity.
    const qualifiedArchive = await qualifyPayload({
      platform: "linux-x64",
      payload,
      checkout,
      expectedNativePayloadSha256: admittedPayloadInv.identity,
      archiveLegalEnvelope: true,
      commandRunner: mockRunner,
    });
    expect(qualifiedArchive.checks.find(c => c.id === "private-runtime-closure")?.ok).toBe(true);
    expect(qualifiedArchive.nativePayload.identity).toBe(admittedPayloadInv.identity);

    // The fixture intentionally uses a 64-byte fake sidecar, so import a fresh
    // qualifier instance with its Node authority narrowed to that fixture. This
    // keeps the export test synthetic and avoids reading/copying a real Node
    // runtime merely to exercise the observation hand-off.
    const fakeSidecar = Buffer.alloc(64);
    Buffer.from([0x7f, 69, 76, 70, 2, 1, 1]).copy(fakeSidecar);
    fakeSidecar.writeUInt16LE(3, 16);
    fakeSidecar.writeUInt16LE(62, 18);
    const fakeSidecarSha256 = sha256(fakeSidecar);
    vi.resetModules();
    vi.doMock("../tools/node-runtime-authority.mjs", async () => {
      const actual = await vi.importActual("../tools/node-runtime-authority.mjs");
      const target = actual.NODE_RELEASE_IDENTITY.targets["x86_64-unknown-linux-gnu"];
      return {
        ...actual,
        NODE_RELEASE_IDENTITY: Object.freeze({
          ...actual.NODE_RELEASE_IDENTITY,
          targets: Object.freeze({
            ...actual.NODE_RELEASE_IDENTITY.targets,
            "x86_64-unknown-linux-gnu": Object.freeze({
              ...target,
              executableSha256: fakeSidecarSha256,
              executableSize: fakeSidecar.length,
            }),
          }),
        }),
      };
    });
    let qualifyForExport;
    try {
      ({ qualifyPayload: qualifyForExport } = await import("../tools/native-rc-qualify.mjs?observation-export-fixture"));
    } finally {
      vi.doUnmock("../tools/node-runtime-authority.mjs");
      vi.resetModules();
    }
    const sourceCandidate = "a".repeat(64);
    const observationRoot = join(scratch("observation-export"), "set");
    const exported = await qualifyForExport({
      platform: "linux-x64",
      payload,
      checkout,
      expectedNativePayloadSha256: payloadInv.identity,
      observationOutputDir: observationRoot,
      sourceCandidate,
      commandRunner: mockRunner,
    });
    expect(exported.status).toBe("pass");
    expect(exported.checks.find(c => c.id === "private-runtime-closure")?.ok).toBe(true);
    const floorPath = join(observationRoot, "runtime-floor-observation.json");
    const portabilityPath = join(observationRoot, "elf-portability-observation.json");
    const manifestPath = join(observationRoot, "identity-manifest.json");
    const exportedFloor = JSON.parse(readFileSync(floorPath, "utf8"));
    const exportedPortability = JSON.parse(readFileSync(portabilityPath, "utf8"));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(exportedFloor.observedProviderRows.length).toBeGreaterThan(0);
    expect(exportedPortability.records.length).toBeGreaterThan(0);
    expect(manifest.schema).toBe("nebular.native-rc-observation-export-v1");
    expect(manifest.target).toBe("x86_64-unknown-linux-gnu");
    expect(manifest.sourceCandidate).toBe(sourceCandidate);
    expect(manifest.qualification.identity).toBe(identity(exported));
    expect(manifest.qualification.nativePayload.identity).toBe(payloadInv.identity);
    expect(manifest.observations.runtimeFloor.identity).toBe(exportedFloor.observationIdentity);
    expect(manifest.observations.elfPortability.identity).toBe(exportedPortability.identity);
    expect(manifest.observations.runtimeFloor.sha256).toBe(sha256(readFileSync(floorPath)));
    expect(manifest.observations.elfPortability.sha256).toBe(sha256(readFileSync(portabilityPath)));
    const unsignedManifest = { ...manifest };
    delete unsignedManifest.identity;
    expect(identity(unsignedManifest)).toBe(manifest.identity);
    const unsignedFloor = { ...exportedFloor };
    delete unsignedFloor.observationIdentity;
    expect(identity(unsignedFloor)).toBe(exportedFloor.observationIdentity);
    const unsignedPortability = { ...exportedPortability };
    delete unsignedPortability.identity;
    expect(identity(unsignedPortability)).toBe(exportedPortability.identity);
    await expect(qualifyForExport({
      platform: "linux-x64",
      payload,
      checkout,
      expectedNativePayloadSha256: payloadInv.identity,
      observationOutputDir: observationRoot,
      sourceCandidate,
      commandRunner: mockRunner,
    })).rejects.toThrow(/EEXIST|already exists/);
    await expect(qualifyPayload({
      platform: "linux-x64",
      payload,
      checkout,
      expectedNativePayloadSha256: payloadInv.identity,
      observationOutputDir: join(scratch("observation-missing-source"), "set"),
      commandRunner: mockRunner,
    })).rejects.toThrow(/sourceCandidate identity/);
    await expect(qualifyPayload({
      platform: "linux-x64",
      payload,
      checkout,
      expectedNativePayloadSha256: payloadInv.identity,
      observationOutputDir: join(scratch("observation-git40"), "set"),
      sourceCandidate: "a".repeat(40),
      commandRunner: mockRunner,
    })).rejects.toThrow(/lowercase 64-hex sourceCandidate identity/);
    await expect(qualifyPayload({
      platform: "linux-x64",
      payload,
      checkout,
      expectedNativePayloadSha256: payloadInv.identity,
      observationOutputDir: join(scratch("observation-uppercase"), "set"),
      sourceCandidate: "A".repeat(64),
      commandRunner: mockRunner,
    })).rejects.toThrow(/lowercase 64-hex sourceCandidate identity/);
    await expect(qualifyPayload({
      platform: "linux-x64",
      payload,
      checkout,
      expectedNativePayloadSha256: payloadInv.identity,
      sourceCandidate,
      commandRunner: mockRunner,
    })).rejects.toThrow(/sourceCandidate requires observationOutputDir/);
    await expect(qualifyPayload({
      platform: "darwin-arm64",
      payload,
      checkout,
      observationOutputDir: join(scratch("observation-darwin"), "set"),
      sourceCandidate,
      commandRunner: mockRunner,
    })).rejects.toThrow(/supported only for Linux qualification/);
    await expect(qualifyPayload({
      platform: "linux-x64",
      payload,
      checkout,
      expectedNativePayloadSha256: payloadInv.identity,
      observationOutputDir: join(payload, "inside-export"),
      sourceCandidate,
      commandRunner: mockRunner,
    })).rejects.toThrow(/outside the payload/);
    const payloadLinkRoot = scratch("payload-symlink-root");
    const symlinkedPayload = join(payloadLinkRoot, "linked-payload");
    symlinkSync(payload, symlinkedPayload);
    const insideParent = join(payload, "nested-export");
    mkdirSync(insideParent, { recursive: true });
    try {
      await expect(qualifyPayload({
        platform: "linux-x64",
        payload: symlinkedPayload,
        checkout,
        expectedNativePayloadSha256: payloadInv.identity,
        observationOutputDir: join(insideParent, "set"),
        sourceCandidate,
        commandRunner: mockRunner,
      })).rejects.toThrow(/outside the payload|resolves inside the payload/);
    } finally {
      rmSync(insideParent, { recursive: true, force: true });
    }
    const symlinkParentRoot = scratch("observation-symlink-parent");
    const realParentDir = join(symlinkParentRoot, "real");
    const linkedParentDir = join(symlinkParentRoot, "linked");
    mkdirSync(realParentDir, { recursive: true });
    symlinkSync(realParentDir, linkedParentDir);
    await expect(qualifyPayload({
      platform: "linux-x64",
      payload,
      checkout,
      expectedNativePayloadSha256: payloadInv.identity,
      observationOutputDir: join(linkedParentDir, "set"),
      sourceCandidate,
      commandRunner: mockRunner,
    })).rejects.toThrow(/parent must be a real directory/);

    const runtimeSource = populatePrivateLinuxPayload(scratch("runtime-source-export"));
    const runtimeInput = nativeRuntimeInput(runtimeSource.root, runtimeSource.material);
    const authObservationRoot = join(scratch("observation-export-authenticated"), "set");
    const authExported = await qualifyForExport({
      platform: "linux-x64",
      payload,
      checkout,
      nativeRuntime: runtimeInput.inputPath,
      nativeRuntimeSha256: runtimeInput.expectedSha256,
      observationOutputDir: authObservationRoot,
      sourceCandidate,
      commandRunner: mockRunner,
    });
    expect(authExported.status).toBe("pass");
    const authManifest = JSON.parse(readFileSync(join(authObservationRoot, "identity-manifest.json"), "utf8"));
    expect(authManifest.runtimeInputSha256).toBe(runtimeInput.expectedSha256);

    const mutatedRuntimeInput = nativeRuntimeInput(runtimeSource.root, runtimeSource.material);
    const mutatedRuntimeObservationRoot = join(scratch("observation-export-mutated-runtime"), "set");
    let runtimeInputMutated = false;
    await expect(qualifyForExport({
      platform: "linux-x64",
      payload,
      checkout,
      nativeRuntime: mutatedRuntimeInput.inputPath,
      nativeRuntimeSha256: mutatedRuntimeInput.expectedSha256,
      observationOutputDir: mutatedRuntimeObservationRoot,
      sourceCandidate,
      commandRunner: (program, args) => {
        if (!runtimeInputMutated && program === "readelf") {
          runtimeInputMutated = true;
          appendFileSync(mutatedRuntimeInput.inputPath, Buffer.from("x"));
        }
        return mockRunner(program, args);
      },
    })).rejects.toThrow(/Native runtime input descriptor drifted after initial authentication/);
    expect(existsSync(mutatedRuntimeObservationRoot)).toBe(false);

    const cliTrailingFlag = spawnSync(
      process.execPath,
      [
        new URL("../tools/native-rc-qualify.mjs", import.meta.url).pathname,
        "--platform",
        "linux-x64",
        "--payload",
        payload,
        "--observation-output-dir",
      ],
      { encoding: "utf8" },
    );
    expect(cliTrailingFlag.status).toBe(1);
    expect(cliTrailingFlag.stderr).toMatch(/Missing value for --observation-output-dir/);

    // Parseable provider output with a nonzero readelf status is never accepted as floor evidence.
    const failedObservationRoot = join(scratch("observation-failed"), "set");
    const providerReadelfFailure = await qualifyPayload({
      platform: "linux-x64",
      payload,
      checkout,
      expectedNativePayloadSha256: payloadInv.identity,
      observationOutputDir: failedObservationRoot,
      sourceCandidate,
      commandRunner: (program, args) => {
        if (program === "readelf" && args.includes("-V")) {
          return boundedResult({ status: 1, stdout: "ELF Header:\n  Class: ELF64\n", stderr: "provider readelf failed" });
        }
        return mockRunner(program, args);
      },
    });
    expect(providerReadelfFailure.status).toBe("fail");
    expect(providerReadelfFailure.checks.find(c => c.id === "private-runtime-closure")?.detail).toMatch(/did not complete safely/);
    expect(existsSync(failedObservationRoot)).toBe(false);

    // A runner that omits the bounded lifecycle contract cannot become a qualification pass.
    const unbounded = await qualifyPayload({
      platform: "linux-x64",
      payload,
      checkout,
      expectedNativePayloadSha256: payloadInv.identity,
      commandRunner: (program) => ({ status: 0, stdout: "", stderr: "", bounded: false, cleanupKnown: true }),
    });
    expect(unbounded.status).toBe("fail");
    expect(unbounded.checks.find(c => c.id === "glibc:gui")?.detail).toMatch(/bounded execution/);

    const incompleteLifecycle = await qualifyPayload({
      platform: "linux-x64",
      payload,
      checkout,
      expectedNativePayloadSha256: payloadInv.identity,
      commandRunner: (program) => ({ status: 0, stdout: "", stderr: "", bounded: true, cleanupKnown: true }),
    });
    expect(incompleteLifecycle.status).toBe("fail");
    expect(incompleteLifecycle.checks.find(c => c.id === "glibc:gui")?.detail).toMatch(/omitted explicit timedOut/);

    // Inventory admission completes before commandRunner is first invoked;
    // removing a named member afterward must fail at the authenticated read.
    const extraPath = join(payload, "lib/theme-forge-nebular-fusion/extra-elf/embedded-helper");
    const originalExtraBytes = Buffer.from(readFileSync(extraPath));
    let removedAfterAdmission = false;
    const missingAfterAdmission = await qualifyPayload({
      platform: "linux-x64",
      payload,
      checkout,
      expectedNativePayloadSha256: payloadInv.identity,
      commandRunner: (program, args) => {
        if (!removedAfterAdmission && program === "readelf") {
          removedAfterAdmission = true;
          rmSync(extraPath);
        }
        return mockRunner(program, args);
      },
    });
    expect(missingAfterAdmission.status).toBe("fail");
    expect(missingAfterAdmission.checks.find(c => c.id === "private-runtime-closure")?.detail).toMatch(/missing|ENOENT|regular/i);
    writeFileSync(extraPath, originalExtraBytes, { mode: 0o644 });

    // A same-sized replacement after admission must not be accepted under the
    // original inventory identity, even though its ELF header remains present.
    let mutatedAfterAdmission = false;
    const mutatedBytes = Buffer.from(originalExtraBytes);
    mutatedBytes[7] = 0x7f;
    const mutatedAfterAdmissionResult = await qualifyPayload({
      platform: "linux-x64",
      payload,
      checkout,
      expectedNativePayloadSha256: payloadInv.identity,
      commandRunner: (program, args) => {
        if (!mutatedAfterAdmission && program === "readelf") {
          mutatedAfterAdmission = true;
          writeFileSync(extraPath, mutatedBytes, { mode: 0o644 });
        }
        return mockRunner(program, args);
      },
    });
    expect(mutatedAfterAdmissionResult.status).toBe("fail");
    expect(mutatedAfterAdmissionResult.checks.find(c => c.id === "private-runtime-closure")?.detail).toMatch(/inventory mismatch/i);
  });

  it("checks expected payload identity for ordinary Darwin payloads", async () => {
    const payload = scratch("payload-darwin-expected");
    write(join(payload, "probe.txt"), "darwin probe\n", 0o644);
    const observed = await inventoryNativePayload(payload);
    expect(observed.identity).not.toBe("f".repeat(64));
    await expect(qualifyPayload({
      platform: "darwin-arm64",
      payload,
      checkout: scratch("checkout-darwin-expected"),
      expectedNativePayloadSha256: "f".repeat(64),
    })).rejects.toThrow(/Payload native inventory identity .* does not match expected/);
  });

  it("authenticates a matching Darwin expected identity without emitting Linux payload inventory fields", async () => {
    const payload = scratch("payload-darwin-matching");
    write(join(payload, "probe.txt"), "darwin probe\n", 0o644);
    const observed = await inventoryNativePayload(payload);
    expect(selectPayloadInventoryForQualification(PLATFORMS["darwin-arm64"], {
      hasExpectedPayload: true,
      ordinaryInventory: observed,
      expectedNativePayloadSha256: observed.identity,
    })).toBeNull();
  });
});

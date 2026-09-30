// @vitest-environment node
// Native release-candidate automation: lane planning, deterministic packaging, smoke receipt judgement,
// the evidence seal and the release-candidate catalog.
import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { LANES, RETENTION, artifactName, planLanes, workflowOutputs } from "../tools/native-rc-plan.mjs";
import { FIXED_ARCHIVE_TIME, PLATFORMS, assembleRawArchive, platformPackageJson, platformReadme, tarRecords, verifyPlatformPackage, walkTree, writeDeterministicArchive } from "../tools/native-rc-package.mjs";
import { PLATFORM_SCENARIOS, SCENARIOS, judgeReceipt, persistentStateLocations, prepareFixtures, caseSensitive } from "../tools/native-rc-smoke.mjs";
import { compareVersions, glibcFloor } from "../tools/native-rc-qualify.mjs";
import { seal } from "../tools/native-rc-evidence.mjs";
import { buildIndex } from "../tools/native-rc-index.mjs";
import { nativeLauncher } from "../tools/native-launcher.mjs";
import { NODE_RELEASE_IDENTITY } from "../tools/node-runtime-authority.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const SHA = "93c8da8d8cfd4923869ec8d11c51d1e7349802cc";
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) { spawnSync("chmod", ["-R", "u+w", root]); rmSync(root, { recursive: true, force: true }); } });
const scratch = (name) => { const root = mkdtempSync(join(tmpdir(), `native-rc-${name}-`)); roots.push(root); return root; };
const write = (path, content, mode) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); if (mode) chmodSync(path, mode); };
const plan = (eventName, inputs = {}, overrides = {}) => planLanes({ eventName, inputs, sha: SHA, runId: 123, runAttempt: 1, version: "0.6.1", ...overrides });

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
    expect(first.filename).toBe("theme-forge-nebular-fusion-v0.6.1-x86_64-unknown-linux-gnu.tar.gz");
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
      files: ["payload", "package-manifest.json", "README.md", "LICENSE", "NOTICE"], license: "AGPL-3.0-or-later OR Commercial" });
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

  it("prepares scenario fixtures from the maintained public fixture", () => {
    const checkout = new URL("..", import.meta.url).pathname;
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

// A complete lane as it would stand after smoke, used by the seal and the catalog.
function laneFixture(overrides = {}) {
  const root = scratch("lane");
  const planRecord = plan("workflow_dispatch", { linux_x64: true, release_candidate: true });
  const executableSha256 = "e".repeat(64);
  const npm = Buffer.from("npm candidate"), raw = Buffer.from("raw candidate");
  write(join(root, "candidate/pkg.tgz"), npm);
  write(join(root, "candidate/raw.tar.gz"), raw);
  const manifest = { members: [{ path: PLATFORMS["linux-x64"].executable, type: "file", sha256: executableSha256 }] };
  write(join(root, "evidence/package-manifest.json"), JSON.stringify(manifest));
  const record = { platform: "linux-x64", version: "0.6.1", packageManifestSha256: sha256(Buffer.from(JSON.stringify(manifest))), glibcMinimum: "2.34",
    npm: { filename: "pkg.tgz", sha256: sha256(npm) }, raw: { filename: "raw.tar.gz", sha256: sha256(raw), executableSha256 } };
  write(join(root, "evidence/package-record.json"), JSON.stringify(record));
  write(join(root, "evidence/qualification.json"), JSON.stringify({ platform: "linux-x64", status: "pass", executableSha256, checks: [{ id: "x", ok: true }] }));
  write(join(root, "evidence/build-receipt.json"), JSON.stringify({ platform: "linux-x64", source: { commit: SHA, tree: "t" } }));
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
    const { options } = laneFixture();
    expect(() => seal({ ...options, lane: "linux-arm64" })).toThrow(/not selected/);
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

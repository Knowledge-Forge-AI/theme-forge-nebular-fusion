import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  APPEARANCE_PREFERENCE_BYTES,
  APPEARANCE_PREFERENCE_RECORD,
  APPEARANCE_PREFERENCE_SHA256,
  APPEARANCE_FAILURE_CATEGORIES,
  APPEARANCE_PAIR_LIMITS,
  APPEARANCE_MATRIX_FACT_KEY,
  APPEARANCE_MATRIX_EDITOR_PRESERVED_FACT_KEY,
  PLATFORM_SCENARIOS,
  SCENARIOS,
  assertAppearancePairLayout,
  appearanceMatrixCellsForCheckout,
  assertAppearancePreferenceRecord,
  createAppearancePairLayout,
  finalizeAppearancePairEvidence,
  judgeReceipt,
  requireRawNpmParity,
  runSmoke,
  sha256,
  validateAppearanceMatrixEditorPreservedFact,
  validateAppearanceMatrixFacts,
} from "./native-rc-smoke.mjs";
import { APPEARANCE_SCENARIOS, appearanceScenariosForPlan, planLanes } from "./native-rc-plan.mjs";
import { appearancePairExecutableIdentityMatches, buildIndex } from "../tools/native-rc-index.mjs";
import { seal } from "../tools/native-rc-evidence.mjs";

const allPlatforms = ["darwin-arm64", "linux-arm64", "linux-x64"];
const candidateSha = "a".repeat(64);
const DARWIN_EXECUTABLE = "payload/Theme Forge Nebular Fusion.app/Contents/MacOS/theme-forge-nebular-fusion";
const fixtureCheckout = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("appearance pair scenarios are fixed on all three native platforms without changing ordinary scenarios", () => {
  assert.deepEqual(PLATFORM_SCENARIOS, { "darwin-arm64": ["A"], "linux-arm64": ["B"], "linux-x64": ["C", "C-signal"] });
  for (const platform of allPlatforms) {
    assert.ok(SCENARIOS["P-save"].platforms.includes(platform));
    assert.ok(SCENARIOS["P-restart"].platforms.includes(platform));
    assert.ok(SCENARIOS["paired-v2"].platforms.includes(platform));
  }
  assert.deepEqual(SCENARIOS["P-save"].steps, ["p-save-shell", "p-save-load-missing", "p-save-select-family", "p-save-select-mode", "p-save-apply", "p-save-load-saved"]);
  assert.deepEqual(SCENARIOS["P-restart"].steps, ["p-restart-shell", "p-restart-startup", "p-restart-load-exact"]);
  for (const category of ["appearance-startup-backend-unsupported", "appearance-startup-load-rejected", "appearance-save-failed", "appearance-saved-status-timeout", "appearance-selection-mismatch", "appearance-computed-mismatch", "appearance-record-mismatch", "pair-leaf-inventory-mismatch"]) {
    assert.ok(APPEARANCE_FAILURE_CATEGORIES.includes(category));
  }
  assert.equal(createHash("sha256").update(APPEARANCE_PREFERENCE_BYTES).digest("hex"), APPEARANCE_PREFERENCE_SHA256);
  assert.deepEqual(JSON.parse(APPEARANCE_PREFERENCE_BYTES.toString("utf8")), APPEARANCE_PREFERENCE_RECORD);
  assert.equal(APPEARANCE_PAIR_LIMITS.markerBytes, 160);
  assert.equal(APPEARANCE_PAIR_LIMITS.preferenceBytes, 4096);
  assert.equal(APPEARANCE_PAIR_LIMITS.phases, 2);
  assert.equal(APPEARANCE_PAIR_LIMITS.views, 2);
  assert.ok(APPEARANCE_PREFERENCE_BYTES.byteLength < APPEARANCE_PAIR_LIMITS.preferenceBytes);
});

test("appearance receipt requirements are explicit in new plans and absent from legacy plans", () => {
  const base = {
    eventName: "workflow_dispatch",
    inputs: { linux_x64: true },
    sha: "a".repeat(40),
    runId: 1,
    runAttempt: 1,
    version: "0.7.1",
  };
  const legacy = planLanes(base);
  assert.equal("appearanceScenarios" in legacy.lanes["linux-x64"], false);
  assert.deepEqual(appearanceScenariosForPlan(legacy, "linux-x64"), []);

  const strict = planLanes({ ...base, appearanceScenarios: APPEARANCE_SCENARIOS });
  assert.deepEqual(strict.appearanceScenarios, APPEARANCE_SCENARIOS);
  assert.deepEqual(strict.lanes["linux-x64"].appearanceScenarios, APPEARANCE_SCENARIOS);
  assert.deepEqual(appearanceScenariosForPlan(strict, "linux-x64"), APPEARANCE_SCENARIOS);
  assert.deepEqual(appearanceScenariosForPlan({ appearanceScenarios: APPEARANCE_SCENARIOS, lanes: { "linux-x64": {} } }, "linux-x64"), APPEARANCE_SCENARIOS);
  assert.equal(appearanceScenariosForPlan({ lanes: { "linux-x64": { appearanceScenarios: ["future"] } } }, "linux-x64"), null);
});

test("appearance launch vocabulary keeps seal-only and paired source boundaries closed", async () => {
  await assert.rejects(() => runSmoke({ platform: "linux-x64", scenario: "appearance-pair" }), /seal-only/u);
  await assert.rejects(() => runSmoke({ platform: "linux-x64", scenario: "P-save", source: "raw-archive" }), /view layout/u);
  await assert.rejects(() => runSmoke({ platform: "linux-x64", scenario: "paired-v2", source: "npm-package" }), /raw archive/u);
});

test("pair layout enforces empty-before-save and exact dark Developer bytes across restart", () => {
  const layout = createAppearancePairLayout("linux-x64");
  try {
    assert.match(layout.sourceRoot, /appearance-pair\/raw-only$/u);
    assert.match(layout.pairId, /^appearance-pair-v1-/u);
    assertAppearancePairLayout(layout, "before-save");
    writeFileSync(join(layout.viewA.smokeDir, "receipt.json"), "{}", { mode: 0o600 });
    writeFileSync(join(layout.preferencesRoot, "appearance.json"), APPEARANCE_PREFERENCE_BYTES, { mode: 0o600 });
    assertAppearancePairLayout(layout, "after-save");
    assertAppearancePreferenceRecord(layout);
    writeFileSync(join(layout.viewB.smokeDir, "receipt.json"), "{}", { mode: 0o600 });
    assertAppearancePairLayout(layout, "after-restart");
    assertAppearancePreferenceRecord(layout, APPEARANCE_PREFERENCE_BYTES);
    writeFileSync(join(layout.preferencesRoot, "unexpected"), "x", { mode: 0o600 });
    assert.throws(() => assertAppearancePairLayout(layout, "after-restart"), /inventory mismatch/);
  } finally {
    rmSync(layout.runRoot, { recursive: true, force: true });
  }
});

test("raw/npm parity requires the ordinary smoke identities before a pair can start", () => {
  const root = createAppearancePairLayout();
  const evidence = join(root.runRoot, "ordinary-evidence");
  mkdirSync(evidence, { mode: 0o700 });
  try {
    const record = (source, scenario) => ({ platform: "linux-x64", scenario, source, status: "pass", executable: { sha256: candidateSha } });
    writeFileSync(join(evidence, "raw.run.json"), `${JSON.stringify(record("raw-archive", "C"))}\n`, { mode: 0o600 });
    writeFileSync(join(evidence, "npm.run.json"), `${JSON.stringify(record("npm-package", "C"))}\n`, { mode: 0o600 });
    assert.deepEqual(requireRawNpmParity(evidence, "linux-x64", candidateSha), { rawExecutableSha256: candidateSha, npmExecutableSha256: candidateSha });
    writeFileSync(join(evidence, "npm.run.json"), `${JSON.stringify(record("npm-package", "C"), null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(evidence, "mismatch.run.json"), `${JSON.stringify(record("npm-package", "C-signal")).replace(candidateSha, "b".repeat(64))}\n`, { mode: 0o600 });
    assert.throws(() => requireRawNpmParity(evidence, "linux-x64", candidateSha), /identity is incomplete/);
  } finally {
    rmSync(root.runRoot, { recursive: true, force: true });
  }
});

test("pair cleanup failure is persisted as a failed result before evidence is sealed", () => {
  const layout = createAppearancePairLayout("linux-x64");
  const evidencePath = join(layout.runRoot, "pair.run.json");
  const result = {
    schema: "nebular.native-rc-smoke-run-v1",
    status: "pass",
    problems: [],
    appearancePair: { status: "pass", phases: ["P-save", "P-restart"] },
  };
  try {
    finalizeAppearancePairEvidence({
      result,
      cleanup: () => { throw new Error("synthetic cleanup failure"); },
      writeEvidence: () => writeFileSync(evidencePath, `${JSON.stringify(result)}\n`, { flag: "wx", mode: 0o600 }),
    });
    const persisted = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.equal(result.status, "fail");
    assert.equal(result.appearancePair.status, "fail");
    assert.equal(persisted.status, "fail");
    assert.equal(persisted.appearancePair.status, "fail");
    assert.ok(result.problems.includes("appearance-pair-harness-error"));
  } finally {
    rmSync(layout.runRoot, { recursive: true, force: true });
  }
});

test("seal and index round-trip emits the candidate executable identity field", async () => {
  const layout = createAppearancePairLayout("darwin-arm64");
  const root = layout.runRoot;
  const candidateDir = join(root, "candidate");
  const evidenceDir = join(root, "evidence");
  const smokeDir = join(evidenceDir, "smoke");
  mkdirSync(candidateDir, { recursive: true, mode: 0o700 });
  mkdirSync(smokeDir, { recursive: true, mode: 0o700 });
  const executableSha256 = "e".repeat(64);
  const npmBytes = Buffer.from("synthetic npm candidate");
  const rawBytes = Buffer.from("synthetic raw candidate");
  const manifest = {
    members: [{ path: DARWIN_EXECUTABLE, type: "file", mode: 0o755, size: 1, sha256: executableSha256 }],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const planRecord = planLanes({
    eventName: "workflow_dispatch",
    inputs: { macos_arm64: true },
    sha: "a".repeat(40),
    runId: 1,
    runAttempt: 1,
    version: "0.7.1",
  });
  const packageRecord = {
    platform: "darwin-arm64",
    version: "0.7.1",
    packageManifestSha256: sha256(manifestBytes),
    npm: { filename: "pkg.tgz", sha256: sha256(npmBytes) },
    raw: { filename: "raw.tar.gz", sha256: sha256(rawBytes), executableSha256 },
  };
  const smokeRecord = (source) => ({
    label: `A-${source}`,
    platform: "darwin-arm64",
    scenario: "A",
    source,
    status: "pass",
    executable: { sha256: executableSha256 },
    receipt: { sha256: "r".repeat(64), steps: [] },
  });
  const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const options = {
    lane: "macos-arm64",
    plan: join(evidenceDir, "plan.json"),
    candidateDir,
    packageRecord: join(evidenceDir, "package-record.json"),
    packageManifest: join(evidenceDir, "package-manifest.json"),
    qualification: join(evidenceDir, "qualification.json"),
    smokeDir,
    buildReceipt: join(evidenceDir, "build-receipt.json"),
  };
  try {
    writeFileSync(join(candidateDir, "pkg.tgz"), npmBytes, { mode: 0o600 });
    writeFileSync(join(candidateDir, "raw.tar.gz"), rawBytes, { mode: 0o600 });
    writeJson(options.plan, planRecord);
    writeJson(options.packageManifest, manifest);
    writeJson(options.packageRecord, packageRecord);
    writeJson(options.qualification, { platform: "darwin-arm64", status: "pass", executableSha256, checks: [{ id: "synthetic", ok: true }] });
    writeJson(options.buildReceipt, { platform: "darwin-arm64", source: { commit: planRecord.source.sha, tree: "tree" } });
    writeJson(join(smokeDir, "A-raw.run.json"), smokeRecord("raw-archive"));
    writeJson(join(smokeDir, "A-npm.run.json"), smokeRecord("npm-package"));
    const sealed = seal(options);
    assert.equal(sealed.status, "pass", sealed.problems.join("; "));
    assert.equal(sealed.candidate.executableSha256, executableSha256);
    assert.equal("pairIdentity" in sealed.smoke.find((run) => run.scenario === "A"), false);

    const downloadDir = join(root, "download");
    const artifactDir = join(downloadDir, planRecord.lanes["macos-arm64"].candidateArtifact);
    const artifactCandidate = join(artifactDir, "candidate");
    const artifactEvidence = join(artifactDir, "evidence");
    mkdirSync(artifactCandidate, { recursive: true, mode: 0o700 });
    mkdirSync(artifactEvidence, { recursive: true, mode: 0o700 });
    writeFileSync(join(artifactCandidate, "pkg.tgz"), npmBytes, { mode: 0o600 });
    writeFileSync(join(artifactCandidate, "raw.tar.gz"), rawBytes, { mode: 0o600 });
    const sealedBytes = Buffer.from(JSON.stringify(sealed));
    writeFileSync(join(artifactEvidence, "rc-evidence.json"), sealedBytes, { mode: 0o600 });
    const artifactDigest = "a".repeat(64);
    const needs = {
      plan: { result: "success", outputs: {} },
      "macos-arm64": { result: "success", outputs: { artifact_id: "1234", artifact_digest: artifactDigest, evidence_sha256: sha256(sealedBytes) } },
      "linux-arm64": { result: "skipped", outputs: {} },
      "linux-x64": { result: "skipped", outputs: {} },
    };
    const now = Date.parse("2026-10-01T00:00:00Z");
    const catalog = await buildIndex({
      plan: planRecord,
      needs,
      downloadDir,
      now,
      expiry: async () => ({ expiresAt: new Date(now + 90 * 86400000).toISOString(), digest: `sha256:${artifactDigest}` }),
    });
    assert.equal(catalog.status, "pass");
    const indexedLane = catalog.lanes.find((entry) => entry.lane === "macos-arm64");
    assert.equal(indexedLane.candidate.executableSha256, executableSha256);
    assert.equal("pairIdentity" in indexedLane.smoke.find((run) => run.scenario === "A"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appearance seal/index parity binds both pair executables to the sealed candidate field", () => {
  const run = { pairIdentity: { rawExecutableSha256: candidateSha, npmExecutableSha256: candidateSha } };
  assert.equal(appearancePairExecutableIdentityMatches(run, candidateSha), true);
  assert.equal(appearancePairExecutableIdentityMatches(run, "b".repeat(64)), false);
  assert.equal(appearancePairExecutableIdentityMatches({ pairIdentity: { rawExecutableSha256: candidateSha } }, candidateSha), false);
});

test("paired-v2 appearance facts are twelve ordered generated-role cells with closed bounds", () => {
  const cells = appearanceMatrixCellsForCheckout(fixtureCheckout);
  assert.equal(cells.length, 12);
  assert.deepEqual(cells.map(({ family, mode }) => `${family}:${mode}`), [
    "terminal-nova:light", "nebular:light", "developer:light", "graphic-designer:light", "anime:light", "gamer:light",
    "terminal-nova:dark", "nebular:dark", "developer:dark", "graphic-designer:dark", "anime:dark", "gamer:dark",
  ]);
  for (let index = 0; index < 6; index += 1) {
    assert.notEqual(cells[index].background, cells[index + 6].background);
    assert.notEqual(cells[index].selection, cells[index + 6].selection);
  }
  const receipt = (entries) => ({ driver: { facts: entries.map((cell) => [APPEARANCE_MATRIX_FACT_KEY, JSON.stringify(cell)]) } });
  assert.deepEqual(validateAppearanceMatrixFacts(receipt(cells), fixtureCheckout), []);

  const editorReceipt = (...preservedFacts) => ({
    driver: {
      facts: [
        ...cells.map((cell) => [APPEARANCE_MATRIX_FACT_KEY, JSON.stringify(cell)]),
        ...preservedFacts.map((value) => [APPEARANCE_MATRIX_EDITOR_PRESERVED_FACT_KEY, value]),
      ],
    },
  });
  assert.deepEqual(validateAppearanceMatrixEditorPreservedFact(editorReceipt("true")), []);
  assert.ok(validateAppearanceMatrixEditorPreservedFact(editorReceipt()).some((problem) => problem.includes("exactly once")));
  assert.ok(validateAppearanceMatrixEditorPreservedFact(editorReceipt("false")).some((problem) => problem.includes("must be true")));
  assert.ok(validateAppearanceMatrixEditorPreservedFact(editorReceipt("true", "true")).some((problem) => problem.includes("exactly once")));

  const missing = validateAppearanceMatrixFacts(receipt(cells.slice(0, -1)), fixtureCheckout);
  assert.ok(missing.some((problem) => problem.includes("exactly 12")));

  const reordered = cells.slice();
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  const orderProblems = validateAppearanceMatrixFacts(receipt(reordered), fixtureCheckout);
  assert.ok(orderProblems.some((problem) => problem.includes("family/mode order mismatch")));

  const duplicate = cells.slice();
  duplicate[1] = duplicate[0];
  const duplicateProblems = validateAppearanceMatrixFacts(receipt(duplicate), fixtureCheckout);
  assert.ok(duplicateProblems.some((problem) => problem.includes("duplicated")));

  const unknown = { ...cells[0], extra: "rejected" };
  const unknownProblems = validateAppearanceMatrixFacts(receipt([unknown, ...cells.slice(1)]), fixtureCheckout);
  assert.ok(unknownProblems.some((problem) => problem.includes("keys are not closed and ordered")));

  const oversized = { ...cells[0], background: "x".repeat(1024) };
  const oversizedProblems = validateAppearanceMatrixFacts(receipt([oversized, ...cells.slice(1)]), fixtureCheckout);
  assert.ok(oversizedProblems.some((problem) => problem.includes("exceeds 1024 bytes")));

  const stepReceipt = (steps) => ({
    receipt: {
      schema: "nebular.release-smoke-receipt-v1",
      scenario: "paired-v2",
      status: "pass",
      pid: 42,
      target: "x86_64-unknown-linux-gnu",
      executable: { sha256: candidateSha },
      driver: { steps: steps.map((id) => ({ id, ok: true, via: "dom", ms: 1 })), facts: [] },
      awaitingSignal: false,
    },
    mode: 0o600,
  });
  const expectedSteps = SCENARIOS["paired-v2"].steps;
  assert.deepEqual(judgeReceipt(stepReceipt(expectedSteps), {
    scenario: "paired-v2",
    platform: "linux-x64",
    executableSha256: candidateSha,
    pid: 42,
  }), []);
  const wrongSteps = expectedSteps.slice();
  [wrongSteps[0], wrongSteps[1]] = [wrongSteps[1], wrongSteps[0]];
  assert.ok(judgeReceipt(stepReceipt(wrongSteps), {
    scenario: "paired-v2",
    platform: "linux-x64",
    executableSha256: candidateSha,
    pid: 42,
  }).some((problem) => problem.includes("exact ordered sequence")));
});

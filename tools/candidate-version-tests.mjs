import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  discoverApplicationSurfaces,
  discoverPackageSurfaces,
  verifyApplicationVersion,
  verifyChannelManifest,
  verifyNativeLauncher,
  verifyCaskManifest,
  auditCrossSurfaceInvariants,
  discoverVersionReferences,
} from "./candidate-version.mjs";
import { nativeLauncher } from "./native-launcher.mjs";
import { CANDIDATE_VERSION, TARGETS } from "./platform-targets.mjs";

const studioRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

test("container-valued unknown live version fields cannot disappear during discovery", async t => {
  const root = await mkdtemp(join(tmpdir(), "version-containers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "apps/studio"); await mkdir(dir, { recursive: true });
  for (const value of [{}, []]) {
    await writeFile(join(dir, "package.json"), JSON.stringify({ version: CANDIDATE_VERSION, unknownVersion: value }));
    const report = discoverVersionReferences(root);
    assert.equal(report.passed, false);
    assert.ok(report.unclassified.length > 0);
  }
});

test("unnamed tools, packages and new phase directories cannot bypass ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "version-ownership-"));
  const files = ["tools/new-builder.mjs", "tools/ci/qualify-nix-packaging.mjs", "tools/tfsb999-new/build.mjs", "apps/new-product/package.json"];
  try {
    for (const file of files) {
      await mkdir(join(root, file.slice(0, file.lastIndexOf("/"))), { recursive: true });
      await writeFile(join(root, file), file.endsWith(".json")
        ? JSON.stringify({ name: "new-product", version: "0.4.0" })
        : 'export const release = "0.4.0";\n');
    }
    const report = discoverVersionReferences(root);
    assert.equal(report.passed, false);
    for (const file of files) assert.ok(report.unclassified.some(hit => hit.path === file), file);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("repository discovery fails on unknown live version text outside known projections", async () => {
  const root = await mkdtemp(join(tmpdir(), "nebular-discovery-"));
  try {
    await mkdir(join(root, "tools"));
    await writeFile(join(root, "tools/new-nebular-builder.mjs"), 'export const release = "9.8.7";\n');
    const unknown = discoverVersionReferences(root);
    assert.equal(unknown.passed, false);
    assert.equal(unknown.unclassified[0].path, "tools/new-nebular-builder.mjs");
    await writeFile(join(root, "tools/new-nebular-builder.mjs"), 'export const nebularVersion = "9.8.7";\n');
    assert.equal(discoverVersionReferences(root).passed, false);
    await mkdir(join(root, "docs/releases"), { recursive: true });
    await writeFile(join(root, "docs/releases/v0.4.0.md"), 'Nebular 0.4.0 immutable publication evidence\n');
    const report = discoverVersionReferences(root);
    assert.ok(report.hits.some(h => h.classification === "historical immutable evidence"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Candidate version constant is projected at 0.6.0", () => {
  assert.equal(CANDIDATE_VERSION, "0.6.0");
});

test("Cargo, Tauri and application lock project the maintained candidate version 0.6.0", () => {
  assert.equal(verifyApplicationVersion(studioRoot), CANDIDATE_VERSION);
});

test("Application metadata projections expose every required format", () => {
  const surfaces = discoverApplicationSurfaces(studioRoot);
  assert.ok(surfaces.length >= 6, "Expected at least 6 application surfaces");
  for (const surface of surfaces) {
    assert.equal(surface.version, CANDIDATE_VERSION, `Surface ${surface.id} must match candidate version`);
  }
});

test("npm wrapper, optional packages, payload-bindings and per-platform manifests agree on candidate version", () => {
  const packageSurfaces = discoverPackageSurfaces(repoRoot);
  assert.ok(packageSurfaces.length > 0, "Package surfaces must be discovered");
  for (const surface of packageSurfaces) {
    assert.equal(surface.version, CANDIDATE_VERSION, `Package surface ${surface.id} must match candidate version`);
  }

  // Ensure every target platform package and manifest is present in discovered surfaces
  for (const target of TARGETS) {
    const pkgId = `platform-nebular-fusion-${target.os}-${target.cpu}-package.json`;
    const manifestId = `platform-nebular-fusion-${target.os}-${target.cpu}-package-manifest.json`;
    assert.ok(packageSurfaces.some(s => s.id === pkgId), `Missing package surface: ${pkgId}`);
    assert.ok(packageSurfaces.some(s => s.id === manifestId), `Missing manifest surface: ${manifestId}`);
  }
});

test("Dynamic discovery detects newly added candidate package/version surface", async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), "nebular-pkg-discovery-"));
  try {
    const pkgDir = join(tempRepo, "packages/nebular-fusion-newplatform-arm64");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@knowledge-forge-ai/theme-forge-nebular-fusion-newplatform-arm64", version: "0.5.0" }));
    await writeFile(join(pkgDir, "package-manifest.json"), JSON.stringify({ schema: "tfsb.nebular-package-manifest-v1", version: "0.5.0" }));

    const discovered = discoverPackageSurfaces(tempRepo);
    assert.ok(
      discovered.some(s => s.id === "platform-nebular-fusion-newplatform-arm64-package.json" && s.version === "0.5.0"),
      "Dynamic discovery must detect newly added platform package.json",
    );
    assert.ok(
      discovered.some(s => s.id === "platform-nebular-fusion-newplatform-arm64-package-manifest.json" && s.version === "0.5.0"),
      "Dynamic discovery must detect newly added platform package-manifest.json",
    );
  } finally {
    await rm(tempRepo, { recursive: true, force: true });
  }
});

test("Generated channel manifests, native launchers, and Cask manifests are checkable against candidate version", async () => {
  // 1. Release manifest checking
  const validManifest = {
    schema: "tfsb.nebular-release-candidate-v1",
    version: CANDIDATE_VERSION,
    artifacts: [
      { id: "native-aarch64-darwin", filename: `theme-forge-nebular-fusion-v${CANDIDATE_VERSION}-aarch64-apple-darwin.app.tar.gz` },
      { id: "npm-wrapper", filename: `knowledge-forge-ai-theme-forge-nebular-fusion-${CANDIDATE_VERSION}.tgz` },
    ],
  };
  assert.equal(verifyChannelManifest(validManifest), true);
  assert.throws(
    () => verifyChannelManifest({ ...validManifest, version: "0.4.0" }),
    /version mismatch/,
  );

  // 2. Native launcher checking
  const launcher = nativeLauncher(TARGETS[0]);
  assert.equal(verifyNativeLauncher(launcher), true);
  assert.throws(
    () => verifyNativeLauncher(launcher.replace(CANDIDATE_VERSION, "0.4.0")),
    /does not output expected version/,
  );

  // 3. Homebrew Cask DSL checking
  const mockCask = `cask "theme-forge-nebular-fusion" do\n  version "${CANDIDATE_VERSION}"\nend\n`;
  assert.equal(verifyCaskManifest(mockCask), true);
  assert.throws(
    () => verifyCaskManifest('cask "theme-forge-nebular-fusion" do\n  version "0.4.0"\nend\n'),
    /does not declare expected version line/,
  );

  // 4. Release members check
  const { RELEASE_MEMBERS } = await import("../../../tools/nebular-release-layout.mjs");
  assert.ok(RELEASE_MEMBERS.every(member => member.filename.includes(CANDIDATE_VERSION)));
});

test("Cross-surface candidate gate requires every discovered production projection to align", () => {
  const audit = auditCrossSurfaceInvariants(repoRoot);
  assert.equal(audit.candidatePassed, true);
  for (const id of ["nix-packages-nebular-fusion", "ui-visible-footer", "legacy-host-protocol-version"]) {
    const surface = audit.unresolvedSurfaces.find(item => item.id === id);
    assert.ok(surface, `Missing production version surface: ${id}`);
  }
  assert.equal(audit.wholeCrossSurfaceInvariantPassed, true,
    `Unresolved candidate version drift: ${audit.unalignedProductionSurfaces.map(item => `${item.id}=${item.version}`).join(", ")}; discovery drift=${audit.discovery.drift.length}, unclassified=${audit.discovery.unclassified.length}`);
});

test("Injected mismatch regression tests candidate version drift detection across application, package, and build surfaces", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "nebular-injected-mismatch-"));
  try {
    // 1. Authoritative application package.json mismatch
    await mkdir(join(tempRoot, "apps/studio"), { recursive: true });
    await writeFile(join(tempRoot, "apps/studio/package.json"), JSON.stringify({ name: "theme-forge-nebular-fusion-studio", version: "0.4.0" }, null, 2));
    const appDrift = discoverVersionReferences(tempRoot);
    assert.equal(appDrift.passed, false, "Injected package.json mismatch must fail discovery gate");
    assert.ok(appDrift.drift.some(d => d.path === "apps/studio/package.json" && d.version === "0.4.0" && d.classification === "candidate-authoritative"),
      "Must identify package.json as candidate-authoritative drift");

    // Correct package.json to 0.5.0
    await writeFile(join(tempRoot, "apps/studio/package.json"), JSON.stringify({ name: "theme-forge-nebular-fusion-studio", version: CANDIDATE_VERSION }, null, 2));

    // 2. Injected Cargo.toml mismatch
    await mkdir(join(tempRoot, "apps/studio/src-tauri"), { recursive: true });
    await writeFile(join(tempRoot, "apps/studio/src-tauri/Cargo.toml"), '[package]\nname = "theme-forge-nebular-fusion"\nversion = "0.4.0"\n');
    const cargoDrift = discoverVersionReferences(tempRoot);
    assert.equal(cargoDrift.passed, false, "Injected Cargo.toml mismatch must fail discovery gate");
    assert.ok(cargoDrift.drift.some(d => d.path === "apps/studio/src-tauri/Cargo.toml" && d.version === "0.4.0"),
      "Must identify Cargo.toml version drift");

    // Correct Cargo.toml to 0.5.0
    await writeFile(join(tempRoot, "apps/studio/src-tauri/Cargo.toml"), `[package]\nname = "theme-forge-nebular-fusion"\nversion = "${CANDIDATE_VERSION}"\n`);

    // 3. Injected tauri.conf.json mismatch
    await writeFile(join(tempRoot, "apps/studio/src-tauri/tauri.conf.json"), JSON.stringify({ version: "0.4.0" }, null, 2));
    const tauriDrift = discoverVersionReferences(tempRoot);
    assert.equal(tauriDrift.passed, false, "Injected tauri.conf.json mismatch must fail discovery gate");
    assert.ok(tauriDrift.drift.some(d => d.path === "apps/studio/src-tauri/tauri.conf.json" && d.version === "0.4.0"),
      "Must identify tauri.conf.json version drift");

    // Correct tauri.conf.json to 0.5.0
    await writeFile(join(tempRoot, "apps/studio/src-tauri/tauri.conf.json"), JSON.stringify({ version: CANDIDATE_VERSION }, null, 2));

    // 4. Injected platform package mismatch
    await mkdir(join(tempRoot, "packages/nebular-fusion-darwin-arm64"), { recursive: true });
    await writeFile(join(tempRoot, "packages/nebular-fusion-darwin-arm64/package.json"), JSON.stringify({ name: "@knowledge-forge-ai/theme-forge-nebular-fusion-darwin-arm64", version: "0.4.0" }, null, 2));
    const pkgDrift = discoverVersionReferences(tempRoot);
    assert.equal(pkgDrift.passed, false, "Injected platform package mismatch must fail discovery gate");
    assert.ok(pkgDrift.drift.some(d => d.path === "packages/nebular-fusion-darwin-arm64/package.json" && d.version === "0.4.0"),
      "Must identify platform package version drift");

    // Correct platform package to 0.5.0
    await writeFile(join(tempRoot, "packages/nebular-fusion-darwin-arm64/package.json"), JSON.stringify({ name: "@knowledge-forge-ai/theme-forge-nebular-fusion-darwin-arm64", version: CANDIDATE_VERSION }, null, 2));

    // 5. Injected platform manifest mismatch
    await writeFile(join(tempRoot, "packages/nebular-fusion-darwin-arm64/package-manifest.json"), JSON.stringify({ schema: "tfsb.nebular-package-manifest-v1", version: "0.4.0" }, null, 2));
    const manifestDrift = discoverVersionReferences(tempRoot);
    assert.equal(manifestDrift.passed, false, "Injected platform manifest mismatch must fail discovery gate");
    assert.ok(manifestDrift.drift.some(d => d.path === "packages/nebular-fusion-darwin-arm64/package-manifest.json" && d.version === "0.4.0"),
      "Must identify platform manifest version drift");

    // Correct platform manifest to 0.5.0
    await writeFile(join(tempRoot, "packages/nebular-fusion-darwin-arm64/package-manifest.json"), JSON.stringify({ schema: "tfsb.nebular-package-manifest-v1", version: CANDIDATE_VERSION }, null, 2));

    // 6. Documentation and historical evidence do NOT block discovery (no broad prose blockers)
    await mkdir(join(tempRoot, "docs/evaluations"), { recursive: true });
    await writeFile(join(tempRoot, "docs/evaluations/tfsb71p4.md"), "# Evaluation\nNebular Fusion 0.4.0 and 0.3.0 historical records.\n");
    await writeFile(join(tempRoot, "README.md"), "# Project\nNebular Fusion was previously released at 0.2.0.\n");
    await writeFile(join(tempRoot, "CHANGELOG.md"), "## [0.4.0] - 2026-08-01\nHistorical release notes.\n");

    const alignedReport = discoverVersionReferences(tempRoot);
    assert.equal(alignedReport.drift.length, 0, `Expected 0 drift, got ${alignedReport.drift.length}`);
    assert.equal(alignedReport.unclassified.length, 0, `Expected 0 unclassified, got ${alignedReport.unclassified.length}`);
    assert.equal(alignedReport.passed, true, "Aligned tree with documentation prose must pass discovery gate");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Injected candidate build mismatch inside apps/studio/tools fails discovery without blanket exemption", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "nebular-tool-mismatch-"));
  try {
    await mkdir(join(tempRoot, "apps/studio/tools"), { recursive: true });
    // Injected new tool with mismatched candidate version declaration
    await writeFile(join(tempRoot, "apps/studio/tools/candidate-builder-extra.mjs"), 'export const nebularVersion = "0.4.0";\n');
    const toolDrift = discoverVersionReferences(tempRoot);
    assert.equal(toolDrift.passed, false, "New tool mismatch in apps/studio/tools must fail discovery gate");
    assert.equal(toolDrift.drift.length, 1, "Must detect 1 candidate drift in new tool");
    assert.equal(toolDrift.drift[0].path, "apps/studio/tools/candidate-builder-extra.mjs");
    assert.equal(toolDrift.drift[0].version, "0.4.0");

    // Injected new tool with unclassified version
    await writeFile(join(tempRoot, "apps/studio/tools/candidate-builder-extra.mjs"), 'export const release = "0.4.0";\n');
    const unclassifiedReport = discoverVersionReferences(tempRoot);
    assert.equal(unclassifiedReport.passed, false, "Unclassified version in new tool must fail discovery gate");
    assert.equal(unclassifiedReport.unclassified.length, 1);
    assert.equal(unclassifiedReport.unclassified[0].path, "apps/studio/tools/candidate-builder-extra.mjs");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Cargo.toml package version beyond line 10 is semantically discovered and verified", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "nebular-cargo-semantic-"));
  try {
    await mkdir(join(tempRoot, "apps/studio/src-tauri"), { recursive: true });
    const cargoLines = [
      "[package]",
      'name = "theme-forge-nebular-fusion"',
      "# line 3 comment",
      "# line 4 comment",
      "# line 5 comment",
      "# line 6 comment",
      "# line 7 comment",
      "# line 8 comment",
      "# line 9 comment",
      "# line 10 comment",
      "# line 11 comment",
      "# line 12 comment",
      "# line 13 comment",
      "# line 14 comment",
      'version = "0.4.0"',
      "",
      "[dependencies]",
      'tokio = "1.0.0"',
      'serde = "1.0.0"',
    ];
    await writeFile(join(tempRoot, "apps/studio/src-tauri/Cargo.toml"), cargoLines.join("\n"));
    const cargoDrift = discoverVersionReferences(tempRoot);
    assert.equal(cargoDrift.passed, false, "Cargo version mismatch on line 15 must fail discovery gate");
    assert.equal(cargoDrift.drift.length, 1, "Must detect exactly 1 candidate drift");
    assert.equal(cargoDrift.drift[0].version, "0.4.0");
    assert.equal(cargoDrift.drift[0].line, 15);

    // Dependencies on line 18+ must not be candidate drift
    assert.ok(!cargoDrift.drift.some(d => d.version === "1.0.0"));

    // Correct to candidate version
    cargoLines[14] = `version = "${CANDIDATE_VERSION}"`;
    await writeFile(join(tempRoot, "apps/studio/src-tauri/Cargo.toml"), cargoLines.join("\n"));
    const cargoAligned = discoverVersionReferences(tempRoot);
    assert.equal(cargoAligned.drift.length, 0, "Aligned Cargo.toml must have 0 drift");
    assert.equal(cargoAligned.unclassified.length, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Semantic JSON discovery is position and formatting insensitive (single-line and reordered keys)", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "nebular-json-semantic-"));
  try {
    await mkdir(join(tempRoot, "apps/studio"), { recursive: true });

    // Single-line package.json with reordered keys (version last)
    const singleLinePkg = JSON.stringify({
      name: "theme-forge-nebular-fusion-studio",
      description: "Nebular Fusion Studio Workbench",
      dependencies: { react: "19.0.0", lodash: "4.17.21" },
      devDependencies: { typescript: "5.0.0", vite: "5.0.0" },
      version: CANDIDATE_VERSION,
    });
    await writeFile(join(tempRoot, "apps/studio/package.json"), singleLinePkg);

    // Single-line package-lock.json with reordered keys (packages before version)
    const singleLineLock = JSON.stringify({
      name: "theme-forge-nebular-fusion-studio",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "theme-forge-nebular-fusion-studio",
          version: CANDIDATE_VERSION,
          dependencies: { react: "19.0.0" },
        },
        "node_modules/react": {
          version: "19.0.0",
        },
        "node_modules/lodash": {
          version: "4.17.21",
        },
      },
      version: CANDIDATE_VERSION,
    });
    await writeFile(join(tempRoot, "apps/studio/package-lock.json"), singleLineLock);

    const alignedReport = discoverVersionReferences(tempRoot);
    assert.equal(alignedReport.drift.length, 0, "Aligned single-line JSON must have 0 drift");
    assert.equal(alignedReport.unclassified.length, 0, "Aligned single-line JSON must have 0 unclassified");
    assert.equal(alignedReport.passed, true, "Aligned single-line JSON must pass discovery");

    // Injected mismatch in root package within single-line lockfile
    const mismatchedLock = JSON.stringify({
      name: "theme-forge-nebular-fusion-studio",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "theme-forge-nebular-fusion-studio",
          version: "0.4.0",
        },
        "node_modules/react": {
          version: "19.0.0",
        },
      },
      version: CANDIDATE_VERSION,
    });
    await writeFile(join(tempRoot, "apps/studio/package-lock.json"), mismatchedLock);
    const lockDrift = discoverVersionReferences(tempRoot);
    assert.equal(lockDrift.passed, false, "Mismatched root package in single-line lockfile must fail");
    assert.ok(lockDrift.drift.some(d => d.path === "apps/studio/package-lock.json" && d.version === "0.4.0"));

    // Injected mismatch in single-line package.json
    const mismatchedPkg = JSON.stringify({
      name: "theme-forge-nebular-fusion-studio",
      dependencies: { react: "19.0.0" },
      version: "0.4.0",
    });
    await writeFile(join(tempRoot, "apps/studio/package.json"), mismatchedPkg);
    const pkgDrift = discoverVersionReferences(tempRoot);
    assert.equal(pkgDrift.passed, false, "Mismatched single-line package.json must fail");
    assert.ok(pkgDrift.drift.some(d => d.path === "apps/studio/package.json" && d.version === "0.4.0" && d.classification === "candidate-authoritative"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Dynamic candidate package discovery searches repository by package name outside fixed paths", async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), "nebular-dynamic-repo-"));
  try {
    const customPkgDir = join(tempRepo, "external/candidate-extensions/nebular-fusion-bsd-x64");
    await mkdir(customPkgDir, { recursive: true });
    await writeFile(join(customPkgDir, "package.json"), JSON.stringify({
      name: "@knowledge-forge-ai/theme-forge-nebular-fusion-bsd-x64",
      version: CANDIDATE_VERSION,
    }));
    await writeFile(join(customPkgDir, "package-manifest.json"), JSON.stringify({
      schema: "tfsb.nebular-package-manifest-v1",
      version: CANDIDATE_VERSION,
    }));

    const surfaces = discoverPackageSurfaces(tempRepo);
    assert.ok(surfaces.some(s => s.id === "platform-nebular-fusion-bsd-x64-package.json" && s.version === CANDIDATE_VERSION),
      "Dynamic discovery must find candidate package in non-standard location");
    assert.ok(surfaces.some(s => s.id === "platform-nebular-fusion-bsd-x64-package-manifest.json" && s.version === CANDIDATE_VERSION),
      "Dynamic discovery must find candidate manifest in non-standard location");

    const alignedReport = discoverVersionReferences(tempRepo);
    assert.equal(alignedReport.passed, true);
    assert.equal(alignedReport.drift.length, 0);

    // Injected mismatch in custom location
    await writeFile(join(customPkgDir, "package.json"), JSON.stringify({
      name: "@knowledge-forge-ai/theme-forge-nebular-fusion-bsd-x64",
      version: "0.4.0",
    }));
    const driftReport = discoverVersionReferences(tempRepo);
    assert.equal(driftReport.passed, false);
    assert.ok(driftReport.drift.some(d => d.version === "0.4.0"));
  } finally {
    await rm(tempRepo, { recursive: true, force: true });
  }
});

test("Scenario 1: unnamed new build tool discovered mechanically without product-name filtering", async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), "unnamed-tool-"));
  try {
    await mkdir(join(tempRepo, "tools"), { recursive: true });
    // An unnamed tool without any mention of "nebular", "studioVersion", etc.
    const toolFile = "tools/pipeline-asset-bundler.mjs";
    await writeFile(join(tempRepo, toolFile), 'export const candidateVersion = "0.6.0";\n');

    const report = discoverVersionReferences(tempRepo);
    assert.equal(report.passed, true);
    assert.equal(report.drift.length, 0);
    assert.equal(report.unclassified.length, 0);
    assert.ok(report.hits.some(h => h.path === toolFile && h.version === "0.6.0" && h.classification === "derived/checked candidate surface"),
      "Unnamed build tool version must be mechanically discovered");

    // If candidate version in unnamed tool drifts to 0.4.0, it must fail
    await writeFile(join(tempRepo, toolFile), 'export const candidateVersion = "0.4.0";\n');
    const driftReport = discoverVersionReferences(tempRepo);
    assert.equal(driftReport.passed, false, "Candidate version mismatch in unnamed tool must fail");
    assert.ok(driftReport.unclassified.some(h => h.path === toolFile) || driftReport.drift.some(h => h.path === toolFile));
  } finally {
    await rm(tempRepo, { recursive: true, force: true });
  }
});

test("Scenario 2: new manifest in live root discovered and validated", async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), "live-root-manifest-"));
  try {
    const livePkgDir = join(tempRepo, "packages/nebular-fusion-freebsd-arm64");
    await mkdir(livePkgDir, { recursive: true });
    await writeFile(join(livePkgDir, "package.json"), JSON.stringify({
      name: "@knowledge-forge-ai/theme-forge-nebular-fusion-freebsd-arm64",
      version: CANDIDATE_VERSION,
    }, null, 2));
    await writeFile(join(livePkgDir, "package-manifest.json"), JSON.stringify({
      schema: "tfsb.nebular-package-manifest-v1",
      version: CANDIDATE_VERSION,
    }, null, 2));

    const surfaces = discoverPackageSurfaces(tempRepo);
    assert.ok(surfaces.some(s => s.id === "platform-nebular-fusion-freebsd-arm64-package.json" && s.version === CANDIDATE_VERSION),
      "New platform package in live root must be discovered");
    assert.ok(surfaces.some(s => s.id === "platform-nebular-fusion-freebsd-arm64-package-manifest.json" && s.version === CANDIDATE_VERSION),
      "New platform manifest in live root must be discovered");

    const report = discoverVersionReferences(tempRepo);
    assert.equal(report.passed, true);
    assert.equal(report.drift.length, 0);

    // Mismatched manifest version fails
    await writeFile(join(livePkgDir, "package-manifest.json"), JSON.stringify({
      schema: "tfsb.nebular-package-manifest-v1",
      version: "0.4.0",
    }, null, 2));
    const failReport = discoverVersionReferences(tempRepo);
    assert.equal(failReport.passed, false);
    assert.ok(failReport.drift.some(d => d.path === "packages/nebular-fusion-freebsd-arm64/package-manifest.json" && d.version === "0.4.0"));
  } finally {
    await rm(tempRepo, { recursive: true, force: true });
  }
});

test("Scenario 3: mismatched and unknown fields fail discovery", async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), "mismatched-unknown-fields-"));
  try {
    await mkdir(join(tempRepo, "apps/studio"), { recursive: true });
    await mkdir(join(tempRepo, "tools"), { recursive: true });

    // 3a. Candidate version mismatch fails
    await writeFile(join(tempRepo, "apps/studio/package.json"), JSON.stringify({
      name: "theme-forge-nebular-fusion-studio",
      version: "0.4.0",
    }, null, 2));
    const mismatchReport = discoverVersionReferences(tempRepo);
    assert.equal(mismatchReport.passed, false);
    assert.ok(mismatchReport.drift.some(d => d.path === "apps/studio/package.json" && d.version === "0.4.0"));

    // Fix candidate version
    await writeFile(join(tempRepo, "apps/studio/package.json"), JSON.stringify({
      name: "theme-forge-nebular-fusion-studio",
      version: CANDIDATE_VERSION,
    }, null, 2));

    // 3b. Unknown live version field in package.json fails
    await writeFile(join(tempRepo, "apps/studio/package.json"), JSON.stringify({
      name: "theme-forge-nebular-fusion-studio",
      version: CANDIDATE_VERSION,
      unknownLiveFieldVersion: "1.0.0",
    }, null, 2));
    const unknownFieldReport = discoverVersionReferences(tempRepo);
    assert.equal(unknownFieldReport.passed, false);
    assert.ok(unknownFieldReport.unclassified.some(u => u.path === "apps/studio/package.json"));

    // 3c. Unknown version field in maintained build tool fails
    await writeFile(join(tempRepo, "apps/studio/package.json"), JSON.stringify({
      name: "theme-forge-nebular-fusion-studio",
      version: CANDIDATE_VERSION,
    }, null, 2));
    await writeFile(join(tempRepo, "tools/active-tool.mjs"), 'export const mysteriousReleaseField = "1.2.3";\n');
    const unknownToolReport = discoverVersionReferences(tempRepo);
    assert.equal(unknownToolReport.passed, false);
    assert.ok(unknownToolReport.unclassified.some(u => u.path === "tools/active-tool.mjs"));
  } finally {
    await rm(tempRepo, { recursive: true, force: true });
  }
});

test("Scenario 4: independent versions succeed only for explicit owners", async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), "independent-owners-"));
  try {
    // 4a. Explicit independent owners succeed
    await mkdir(join(tempRepo, "packages/solar-sail"), { recursive: true });
    await writeFile(join(tempRepo, "packages/solar-sail/package.json"), JSON.stringify({
      name: "@knowledge-forge-ai/solar-sail",
      version: "1.2.3",
    }, null, 2));

    await mkdir(join(tempRepo, "themes"), { recursive: true });
    await writeFile(join(tempRepo, "themes/stellar-theme.json"), JSON.stringify({
      name: "stellar-dark",
      version: "2.5.0",
    }, null, 2));

    const validReport = discoverVersionReferences(tempRepo);
    assert.equal(validReport.passed, true);
    assert.equal(validReport.drift.length, 0);
    assert.equal(validReport.unclassified.length, 0);

    // 4b. Unowned independent package fails
    await mkdir(join(tempRepo, "packages/unregistered-independent-component"), { recursive: true });
    await writeFile(join(tempRepo, "packages/unregistered-independent-component/package.json"), JSON.stringify({
      name: "@external/unregistered-component",
      version: "1.2.3",
    }, null, 2));

    const invalidReport = discoverVersionReferences(tempRepo);
    assert.equal(invalidReport.passed, false);
    assert.ok(invalidReport.unclassified.some(u => u.path === "packages/unregistered-independent-component/package.json"),
      "Unowned independent package must fail discovery");
  } finally {
    await rm(tempRepo, { recursive: true, force: true });
  }
});

test("Scenario 5: frozen protocol and schema versions receive historical ownership", async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), "frozen-protocol-"));
  try {
    // 5a. Protocol constant
    await mkdir(join(tempRepo, "apps/studio/protocol"), { recursive: true });
    await writeFile(join(tempRepo, "apps/studio/protocol/service-contracts.ts"), 'export const PROTOCOL_VERSION = "0.1.0";\n');

    // 5b. Specification schema
    await mkdir(join(tempRepo, "tools"), { recursive: true });
    await writeFile(join(tempRepo, "tools/schema-validator.mjs"), 'const schemaVersion = "1.0.0";\n');

    const report = discoverVersionReferences(tempRepo);
    assert.equal(report.passed, true);
    assert.equal(report.drift.length, 0);
    assert.equal(report.unclassified.length, 0);

    const protocolHit = report.hits.find(h => h.path === "apps/studio/protocol/service-contracts.ts");
    assert.ok(protocolHit, "Protocol hit must exist");
    assert.equal(protocolHit.classification, "historical immutable evidence");

    const schemaHit = report.hits.find(h => h.path === "tools/schema-validator.mjs");
    assert.ok(schemaHit, "Schema hit must exist");
    assert.equal(schemaHit.classification, "historical immutable evidence");
  } finally {
    await rm(tempRepo, { recursive: true, force: true });
  }
});

test("Scenario 6: injected path outside roots nonblocking only when explicitly historical", async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), "outside-roots-"));
  try {
    // 6a. Explicitly historical path outside live roots (documentation prose or explicit history) is nonblocking
    await mkdir(join(tempRepo, "docs/historical-notes"), { recursive: true });
    await writeFile(join(tempRepo, "docs/historical-notes/v0.3.0.md"), "# Release Notes\nNebular Fusion was previously released at 0.3.0.\n");

    await mkdir(join(tempRepo, "tools/tfsb48-r1"), { recursive: true });
    await writeFile(join(tempRepo, "tools/tfsb48-r1/historical-evidence.mjs"), 'export const previousVersion = "0.2.0";\n');

    const nonblockingReport = discoverVersionReferences(tempRepo);
    assert.equal(nonblockingReport.passed, true, "Explicitly historical path outside roots must be nonblocking");
    assert.equal(nonblockingReport.drift.length, 0);
    assert.equal(nonblockingReport.unclassified.length, 0);

    // 6b. Arbitrary injected path outside roots with unowned version is blocking
    await mkdir(join(tempRepo, "unregistered-folder"), { recursive: true });
    await writeFile(join(tempRepo, "unregistered-folder/injected-code.mjs"), 'export const unownedVersion = "2.0.0";\n');

    const blockingReport = discoverVersionReferences(tempRepo);
    assert.equal(blockingReport.passed, false, "Injected non-historical path outside roots must fail discovery");
    assert.ok(blockingReport.unclassified.some(u => u.path === "unregistered-folder/injected-code.mjs"));
  } finally {
    await rm(tempRepo, { recursive: true, force: true });
  }
});

test("Blocker 1: Injected nested release version in candidate JSON surfaces fails closed", async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), "blocker1-nested-release-"));
  try {
    const candidateFiles = [
      { path: "apps/studio/package.json", content: JSON.stringify({ name: "theme-forge-nebular-fusion-studio", version: CANDIDATE_VERSION, release: { version: "9.9.9" } }, null, 2) },
      { path: "apps/studio/package-lock.json", content: JSON.stringify({ name: "theme-forge-nebular-fusion-studio", version: CANDIDATE_VERSION, lockfileVersion: 3, release: { version: "9.9.9" } }, null, 2) },
      { path: "apps/studio/src-tauri/tauri.conf.json", content: JSON.stringify({ productName: "Theme Forge Nebular Fusion", version: CANDIDATE_VERSION, release: { version: "9.9.9" } }, null, 2) },
      { path: "packages/nebular-fusion-darwin-arm64/package-manifest.json", content: JSON.stringify({ schema: "tfsb.nebular-package-manifest-v1", version: CANDIDATE_VERSION, release: { version: "9.9.9" } }, null, 2) },
      { path: "packages/nebular-fusion-npm/payload-bindings.json", content: JSON.stringify({ schema: "tfsb.nebular-wrapper-bindings-v1", version: CANDIDATE_VERSION, release: { version: "9.9.9" } }, null, 2) },
    ];

    for (const file of candidateFiles) {
      await mkdir(join(tempRepo, file.path.slice(0, file.path.lastIndexOf("/"))), { recursive: true });
      await writeFile(join(tempRepo, file.path), file.content);
    }

    const report = discoverVersionReferences(tempRepo);
    assert.equal(report.passed, false, "Injected nested release in candidate JSON must fail discovery");
    for (const file of candidateFiles) {
      assert.ok(
        report.unclassified.some(u => u.path === file.path && u.version === "9.9.9"),
        `Nested release in ${file.path} must be unclassified and fail`
      );
    }
  } finally {
    await rm(tempRepo, { recursive: true, force: true });
  }
});

test("Blocker 2: Maintained tools fail closed on injected releaseVersion and unknownVersion", async () => {
  const maintainedTools = [
    "apps/studio/tools/app-preview-prepare.mjs",
    "apps/studio/tools/gallery-prepare.mjs",
    "apps/studio/tools/release-notices.mjs",
    "tools/ci/ci-contract.mjs",
    "tools/nebular-release-layout.mjs",
  ];

  for (const tool of maintainedTools) {
    const tempRepo = await mkdtemp(join(tmpdir(), "blocker2-tools-"));
    try {
      await mkdir(join(tempRepo, tool.slice(0, tool.lastIndexOf("/"))), { recursive: true });

      // Injected releaseVersion must fail
      await writeFile(join(tempRepo, tool), 'export const releaseVersion = "9.9.9";\n');
      const rReport = discoverVersionReferences(tempRepo);
      assert.equal(rReport.passed, false, `Injected releaseVersion in ${tool} must fail discovery`);
      assert.ok(rReport.unclassified.some(u => u.path === tool && u.version === "9.9.9"),
        `releaseVersion in ${tool} must be unclassified`);

      // Injected unknownVersion must fail
      await writeFile(join(tempRepo, tool), 'export const unknownVersion = "9.9.9";\n');
      const uReport = discoverVersionReferences(tempRepo);
      assert.equal(uReport.passed, false, `Injected unknownVersion in ${tool} must fail discovery`);
      assert.ok(uReport.unclassified.some(u => u.path === tool && u.version === "9.9.9"),
        `unknownVersion in ${tool} must be unclassified`);
    } finally {
      await rm(tempRepo, { recursive: true, force: true });
    }
  }
});

test("Blocker 3: Structural JSON walking discovers non-semver version fields and malformed JSON fails closed", async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), "blocker3-structural-json-"));
  try {
    await mkdir(join(tempRepo, "apps/studio"), { recursive: true });

    // 3a. Candidate version: "latest"
    await writeFile(join(tempRepo, "apps/studio/package.json"), JSON.stringify({
      name: "theme-forge-nebular-fusion-studio",
      version: "latest",
    }, null, 2));
    const latestReport = discoverVersionReferences(tempRepo);
    assert.equal(latestReport.passed, false, "version: latest in package.json must fail");
    assert.ok(latestReport.drift.some(d => d.path === "apps/studio/package.json" && d.version === "latest"),
      "version: latest must be discovered and fail with drift");

    // 3b. Candidate version: 17
    await writeFile(join(tempRepo, "apps/studio/package.json"), JSON.stringify({
      name: "theme-forge-nebular-fusion-studio",
      version: 17,
    }, null, 2));
    const numReport = discoverVersionReferences(tempRepo);
    assert.equal(numReport.passed, false, "version: 17 in package.json must fail");
    assert.ok(numReport.drift.some(d => d.path === "apps/studio/package.json" && String(d.version) === "17"),
      "version: 17 must be discovered and fail with drift");

    // 3c. unknownVersion: "broken"
    await writeFile(join(tempRepo, "apps/studio/package.json"), JSON.stringify({
      name: "theme-forge-nebular-fusion-studio",
      version: CANDIDATE_VERSION,
      unknownVersion: "broken",
    }, null, 2));
    const unknownReport = discoverVersionReferences(tempRepo);
    assert.equal(unknownReport.passed, false, "unknownVersion: broken must fail discovery");
    assert.ok(unknownReport.unclassified.some(u => u.path === "apps/studio/package.json" && u.version === "broken"),
      "unknownVersion: broken must be unclassified");

    // 3d. Malformed live JSON fails closed
    await writeFile(join(tempRepo, "apps/studio/package.json"), '{\n  "name": "theme-forge-nebular-fusion-studio",\n  version: \n');
    const malformedReport = discoverVersionReferences(tempRepo);
    assert.equal(malformedReport.passed, false, "Malformed live JSON must fail closed");
    assert.ok(malformedReport.unclassified.some(u => u.path === "apps/studio/package.json"),
      "Malformed JSON must produce an unclassified hit");
  } finally {
    await rm(tempRepo, { recursive: true, force: true });
  }
});

test("Blocker 4: Native release layout classifies declarations by field before comparing value", async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), "blocker4-layout-drift-"));
  try {
    await mkdir(join(tempRepo, "tools"), { recursive: true });
    await writeFile(join(tempRepo, "tools/nebular-release-layout.mjs"), 'const manifest = { schema: "tfsb.nebular-release-candidate-v1", version: "0.4.0" };\n');

    const report = discoverVersionReferences(tempRepo);
    assert.equal(report.passed, false, "Mismatched version in release layout must fail");
    assert.ok(report.drift.some(d => d.path === "tools/nebular-release-layout.mjs" && d.version === "0.4.0"),
      "Release layout mismatched version must be classified as candidate surface and fail with drift");
    assert.equal(report.unclassified.length, 0, "Classified candidate field must not be unclassified");
  } finally {
    await rm(tempRepo, { recursive: true, force: true });
  }
});

test("Blocker 5: Cargo.toml, Nix, and platform-targets fail on unowned version assignments", async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), "blocker5-unowned-assignments-"));
  try {
    // 5a. Cargo.toml
    await mkdir(join(tempRepo, "apps/studio/src-tauri"), { recursive: true });
    await writeFile(join(tempRepo, "apps/studio/src-tauri/Cargo.toml"), `[package]\nname = "theme-forge-nebular-fusion"\nversion = "${CANDIDATE_VERSION}"\nunknownVersion = "9.9.9"\n`);

    // 5b. Nix
    await mkdir(join(tempRepo, "nix/packages"), { recursive: true });
    await writeFile(join(tempRepo, "nix/packages/nebular-fusion.nix"), `{\n  version = "${CANDIDATE_VERSION}";\n  unknownVersion = "9.9.9";\n}\n`);

    // 5c. platform-targets
    await mkdir(join(tempRepo, "apps/studio/tools"), { recursive: true });
    await writeFile(join(tempRepo, "apps/studio/tools/platform-targets.mjs"), `export const CANDIDATE_VERSION = "${CANDIDATE_VERSION}";\nexport const unknownVersion = "9.9.9";\n`);

    const report = discoverVersionReferences(tempRepo);
    assert.equal(report.passed, false, "Unowned version assignments must fail discovery");
    assert.ok(report.unclassified.some(u => u.path === "apps/studio/src-tauri/Cargo.toml" && u.version === "9.9.9"), "Cargo.toml unowned version must fail");
    assert.ok(report.unclassified.some(u => u.path === "nix/packages/nebular-fusion.nix" && u.version === "9.9.9"), "Nix unowned version must fail");
    assert.ok(report.unclassified.some(u => u.path === "apps/studio/tools/platform-targets.mjs" && u.version === "9.9.9"), "platform-targets unowned version must fail");
  } finally {
    await rm(tempRepo, { recursive: true, force: true });
  }
});

test("Blocker 6: New toml/nix manifests discovered mechanically and comments cannot escape executable code", async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), "blocker6-discovery-comments-"));
  try {
    await mkdir(join(tempRepo, "tools"), { recursive: true });

    // 6a. New toml without product word
    await writeFile(join(tempRepo, "tools/dynamic-pipeline.toml"), 'version = "0.4.0"\n');
    // 6b. New nix without product word
    await writeFile(join(tempRepo, "tools/dynamic-builder.nix"), 'version = "0.4.0";\n');

    const driftReport = discoverVersionReferences(tempRepo);
    assert.equal(driftReport.passed, false);
    assert.ok(driftReport.drift.some(d => d.path === "tools/dynamic-pipeline.toml" && d.version === "0.4.0"),
      "New toml manifest version must be discovered mechanically and drift");
    assert.ok(driftReport.drift.some(d => d.path === "tools/dynamic-builder.nix" && d.version === "0.4.0"),
      "New nix manifest version must be discovered mechanically and drift");

    // 6c. Inline and trailing comments cannot escape executable code
    await writeFile(join(tempRepo, "tools/comment-check.mjs"), '/* inline comment */ export const unknownVersion = "9.9.9";\n');
    const inlineReport = discoverVersionReferences(tempRepo);
    assert.equal(inlineReport.passed, false);
    assert.ok(inlineReport.unclassified.some(u => u.path === "tools/comment-check.mjs" && u.version === "9.9.9"),
      "Inline comment must not allow executable code to escape");

    await writeFile(join(tempRepo, "tools/comment-check.mjs"), 'export const unknownVersion = "9.9.9"; // trailing comment\n');
    const trailingReport = discoverVersionReferences(tempRepo);
    assert.equal(trailingReport.passed, false);
    assert.ok(trailingReport.unclassified.some(u => u.path === "tools/comment-check.mjs" && u.version === "9.9.9"),
      "Trailing comment must not allow executable code to escape");
  } finally {
    await rm(tempRepo, { recursive: true, force: true });
  }
});


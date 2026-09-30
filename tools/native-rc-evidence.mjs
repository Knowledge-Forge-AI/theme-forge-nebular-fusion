#!/usr/bin/env node
// Native release-candidate evidence for one lane.
//
// build-receipt  records, from produced bytes, what the hosted lane compiled: the bound source commit
//                and tree, toolchains, authenticated embedded runtime, locks, the frontend the
//                application embedded, the payload inventory, and the runner/container environment.
// seal           proves the candidate identity chain after smoke and before upload: the candidate files
//                are exactly the bytes packaging produced; the npm package manifest and the raw archive
//                carry the same executable; every smoke run executed that executable (the receipt's
//                measured SHA-256) and passed; and nothing was rebuilt or repacked in between. It
//                writes rc-evidence.json and fails when any link of the chain is missing.
import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inventoryTree } from "./candidate-provenance.mjs";
import { readRegularSnapshot } from "./fs-snapshot.mjs";
import { PLATFORMS } from "./native-rc-package.mjs";
import { LANES } from "./native-rc-plan.mjs";
import { PLATFORM_SCENARIOS, SCENARIOS } from "./native-rc-smoke.mjs";

const json = (path) => JSON.parse(readRegularSnapshot(path, { label: path, maxBytes: 16 * 1024 * 1024 }).bytes.toString("utf8"));
const digestOf = (path) => readRegularSnapshot(path, { label: path, maxBytes: 2 * 1024 * 1024 * 1024 }).sha256;

function command(program, args) {
  const result = spawnSync(program, args, { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
  if (result.status !== 0) throw new Error(`${program} ${args.join(" ")} failed: ${result.stderr || result.error?.message}`);
  return result.stdout.trim();
}

/**
 * @param {{ platform: string, checkout: string, payload: string, nodeReceipt: string, source: object, npmCli?: string }} options
 */
export async function buildReceipt(options) {
  const checkout = resolve(options.checkout);
  const platform = PLATFORMS[options.platform];
  if (!platform) throw new Error(`Unsupported platform ${options.platform}`);
  const git = (...args) => command("git", ["-C", checkout, ...args]);
  const commit = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  if (options.source?.commit && options.source.commit !== commit) throw new Error(`checkout ${commit} is not the bound source ${options.source.commit}`);
  if (options.source?.mergeTree && options.source.mergeTree !== tree) throw new Error("the merge candidate tree differs from the built tree");
  const nodeReceipt = json(options.nodeReceipt);
  const frontend = await inventoryTree(join(checkout, "dist"));
  const payload = await inventoryTree(resolve(options.payload));
  return {
    schema: "nebular.native-rc-build-receipt-v1",
    mode: "hosted-public-source",
    platform: options.platform,
    triple: platform.triple,
    source: { commit, tree, ...(options.source ?? {}) },
    toolchains: {
      rustc: command("rustc", ["-vV"]),
      cargo: command("cargo", ["-V"]),
      node: process.version,
      npm: options.npmCli ? command(process.execPath, [options.npmCli, "--version"]) : null,
    },
    embeddedRuntime: { receiptSha256: digestOf(options.nodeReceipt), nodeVersion: nodeReceipt.nodeVersion, undici: nodeReceipt.undici ?? nodeReceipt.embeddedRuntime?.undici ?? null,
      executableSha256: nodeReceipt.executable?.sha256 ?? nodeReceipt.embeddedRuntime?.sha256 ?? null, signer: nodeReceipt.signature?.fingerprint ?? null },
    locks: Object.fromEntries(["src-tauri/Cargo.lock", "package-lock.json", "loom-preview-source/package-lock.json", "rust-toolchain.toml"].map((path) => [path, digestOf(join(checkout, path))])),
    sidecarManifestSha256: digestOf(join(checkout, "src-tauri/sidecar-payload/manifest.json")),
    embeddedFrontend: { identity: frontend.identity, files: frontend.files.length },
    nativePayload: { identity: payload.identity, files: payload.files.length },
    environment: {
      runnerOs: process.env.RUNNER_OS ?? null, runnerArch: process.env.RUNNER_ARCH ?? null,
      imageOs: process.env.ImageOS ?? null, imageVersion: process.env.ImageVersion ?? null,
      container: process.env.NEBULAR_RC_CONTAINER ?? null,
      packages: process.env.NEBULAR_RC_PACKAGES_SHA256 ?? null,
    },
  };
}

/**
 * @param {{ lane: string, plan: string, candidateDir: string, packageRecord: string, packageManifest: string, qualification: string, smokeDir: string, buildReceipt: string }} options
 */
export function seal(options) {
  const lane = LANES[options.lane];
  if (!lane) throw new Error(`Unknown lane ${options.lane}`);
  const plan = json(options.plan);
  if (!plan.lanes?.[options.lane]?.selected) throw new Error(`lane ${options.lane} was not selected by the plan`);
  const record = json(options.packageRecord);
  const qualification = json(options.qualification);
  const build = json(options.buildReceipt);
  const manifest = json(options.packageManifest);
  const problems = [];
  const expect = (condition, message) => { if (!condition) problems.push(message); };

  expect(record.platform === lane.platform && build.platform === lane.platform && qualification.platform === lane.platform, "platform mismatch between package, build and qualification");
  expect(qualification.status === "pass", "machine qualification did not pass");
  expect(build.source?.commit === plan.source.sha, "the build is not bound to the planned source commit");
  expect(digestOf(options.packageManifest) === record.packageManifestSha256, "package manifest digest differs from the package record");

  // Candidate files: exactly the two packaged artifacts, unchanged since packaging.
  const names = readdirSync(options.candidateDir).sort();
  const expectedNames = [record.npm.filename, record.raw.filename].sort();
  expect(JSON.stringify(names) === JSON.stringify(expectedNames), `candidate directory holds ${names.join(", ")} instead of ${expectedNames.join(", ")}`);
  const files = names.map((name) => ({ name, sha256: digestOf(join(options.candidateDir, name)) }));
  expect(files.find((file) => file.name === record.npm.filename)?.sha256 === record.npm.sha256, "npm candidate changed after packaging");
  expect(files.find((file) => file.name === record.raw.filename)?.sha256 === record.raw.sha256, "raw candidate changed after packaging");

  // One executable across payload, package manifest, raw archive and every smoke run.
  const platform = PLATFORMS[lane.platform];
  const manifestExecutable = manifest.members.find((member) => member.path === platform.executable);
  expect(manifestExecutable?.sha256 === qualification.executableSha256, "the package manifest executable is not the qualified executable");
  expect(record.raw.executableSha256 === qualification.executableSha256, "the raw archive executable is not the qualified executable");

  const runs = readdirSync(options.smokeDir).filter((name) => name.endsWith(".run.json")).sort().map((name) => json(join(options.smokeDir, name)));
  const required = PLATFORM_SCENARIOS[lane.platform];
  for (const scenario of required) {
    const matching = runs.filter((run) => run.scenario === scenario);
    expect(matching.length >= 1, `scenario ${scenario} did not run`);
  }
  for (const run of runs) {
    expect(run.status === "pass", `smoke run ${run.label} failed: ${(run.problems ?? []).join("; ")}`);
    expect(run.executable?.sha256 === qualification.executableSha256, `smoke run ${run.label} did not execute the candidate executable`);
    expect(SCENARIOS[run.scenario]?.platforms.includes(lane.platform), `smoke run ${run.label} used a foreign scenario`);
  }
  const sources = new Set(runs.map((run) => run.source));
  expect(sources.has("raw-archive") && sources.has("npm-package"), "smoke did not run from both the raw archive and the npm package extraction");

  return {
    schema: "nebular.native-rc-evidence-v1",
    lane: options.lane,
    platform: lane.platform,
    runner: lane.runner,
    status: problems.length === 0 ? "pass" : "fail",
    problems,
    source: build.source,
    plan: { eventName: plan.eventName, releaseCandidate: plan.releaseCandidate, retentionDays: plan.retentionDays, artifact: plan.lanes[options.lane].candidateArtifact },
    candidate: {
      files,
      version: record.version,
      packageManifestSha256: record.packageManifestSha256,
      executableSha256: qualification.executableSha256,
      glibcMinimum: record.glibcMinimum,
      npm: record.npm,
      raw: record.raw,
    },
    buildReceiptSha256: digestOf(options.buildReceipt),
    build: { toolchains: build.toolchains, embeddedRuntime: build.embeddedRuntime, embeddedFrontend: build.embeddedFrontend, nativePayload: build.nativePayload, environment: build.environment, locks: build.locks },
    qualification: { status: qualification.status, checks: qualification.checks.map(({ id, ok }) => ({ id, ok })) },
    smoke: runs.map((run) => ({ label: run.label, scenario: run.scenario, source: run.source, status: run.status, receiptSha256: run.receipt?.sha256 ?? null,
      steps: run.receipt?.steps ?? [], exit: run.exit, orphans: run.checks?.orphans?.length ?? null, persistentUserStateChanged: run.checks?.persistentUserState?.changed?.length ?? null })),
    manualConfirmationRequired: lane.manualConfirmation,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index === -1 ? undefined : args[index + 1]; };
  try {
    let result;
    if (mode === "build-receipt") {
      result = await buildReceipt({ platform: value("--platform"), checkout: value("--checkout") ?? ".", payload: value("--payload"), nodeReceipt: value("--node-receipt"), npmCli: value("--npm-cli"),
        source: { commit: value("--source-commit"), ...(value("--merge-commit") ? { mergeCommit: value("--merge-commit"), mergeTree: value("--merge-tree") } : {}) } });
    } else if (mode === "seal") {
      result = seal({ lane: value("--lane"), plan: value("--plan"), candidateDir: value("--candidate-dir"), packageRecord: value("--package-record"), packageManifest: value("--package-manifest"),
        qualification: value("--qualification"), smokeDir: value("--smoke-dir"), buildReceipt: value("--build-receipt") });
    } else {
      throw new Error("Usage: native-rc-evidence.mjs build-receipt ... | seal ...");
    }
    writeFileSync(resolve(value("--output")), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify({ mode, status: result.status ?? "written", problems: result.problems ?? [] })}\n`);
    if (result.status === "fail") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}


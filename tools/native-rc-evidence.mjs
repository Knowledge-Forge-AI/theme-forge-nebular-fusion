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
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { identity, inventoryTree } from "./candidate-provenance.mjs";
import { inventoryNativePayload } from "./native-runtime.mjs";
import { readRegularSnapshot } from "./fs-snapshot.mjs";
import { PLATFORMS } from "./native-rc-package.mjs";
import { LANES } from "./native-rc-plan.mjs";
import { PLATFORM_SCENARIOS, SCENARIOS } from "./native-rc-smoke.mjs";

const json = (path) => JSON.parse(readRegularSnapshot(path, { label: path, maxBytes: 16 * 1024 * 1024 }).bytes.toString("utf8"));
const digestOf = (path) => readRegularSnapshot(path, { label: path, maxBytes: 2 * 1024 * 1024 * 1024 }).sha256;

/**
 * Reconstruct the payload inventory identity from the authenticated package manifest.
 * The package manifest is the package-side authority for every payload member; no
 * identity is inferred from the executable alone.  A private-runtime manifest also
 * carries the material digest emitted by qualification, so the reconstructed object
 * is byte-for-byte the inventoryNativePayload identity shape.
 */
function packagePayloadIdentity(manifest, platform, materialDigest) {
  if (!Array.isArray(manifest?.members)) throw new Error("package manifest payload members are missing");
  const prefix = `${platform.payloadRoot}/`;
  const members = [];
  for (const member of manifest.members) {
    if (!member || typeof member.path !== "string") throw new Error("package manifest contains an invalid payload member");
    if (platform.os === "darwin" && member.path === platform.payloadRoot) {
      if (member.type !== "directory" || member.mode !== 0o755) throw new Error("package payload root is malformed");
      continue;
    }
    if (!member.path.startsWith(prefix)) throw new Error(`package member is outside ${platform.payloadRoot}: ${member.path}`);
    const path = member.path.slice(prefix.length);
    if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || posix.normalize(path) !== path) {
      throw new Error(`package payload member path is unsafe: ${member.path}`);
    }
    members.push({ ...member, path });
  }
  const paths = new Set();
  for (const member of members) {
    if (paths.has(member.path)) throw new Error(`duplicate package payload member ${member.path}`);
    paths.add(member.path);
  }
  const files = [];
  const directories = [];
  const aliases = [];
  for (const member of members) {
    if (member.type === "file") {
      if (!Number.isSafeInteger(member.size) || member.size < 0 || !/^[a-f0-9]{64}$/u.test(member.sha256)
          || ![0o644, 0o755].includes(member.mode)) throw new Error(`invalid package payload file ${member.path}`);
      files.push({ path: member.path, bytes: member.size, mode: member.mode, sha256: member.sha256 });
    } else if (member.type === "directory") {
      if (member.mode !== 0o755) throw new Error(`invalid package payload directory ${member.path}`);
      directories.push({ path: member.path, mode: member.mode });
    } else if (member.type === "symlink") {
      if (typeof member.target !== "string" || !member.target || member.target.startsWith("/")
          || member.target.includes("\\") || member.target.includes("\0")) throw new Error(`invalid package payload alias ${member.path}`);
      aliases.push({ path: member.path, target: member.target });
    } else {
      throw new Error(`unsupported package payload member type ${member.type}`);
    }
  }
  const sortPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  files.sort(sortPath);
  directories.sort(sortPath);
  aliases.sort(sortPath);
  const projection = manifest.runtimeAliasProjection ?? null;
  if (manifest.schema === "tfsb.nebular-package-manifest-v2") {
    if (!projection || projection.schema !== "nebular-native-runtime-alias-projection-v1"
        || !/^[a-f0-9]{64}$/u.test(projection.materialDigest ?? "")
        || !/^[a-f0-9]{64}$/u.test(projection.digest ?? "") || !Array.isArray(projection.aliases)) {
      throw new Error("package runtime alias projection is malformed");
    }
    const projectedPaths = new Set(projection.aliases.map((entry) => entry.path));
    for (const entry of projection.aliases) {
      if (!entry || typeof entry.path !== "string" || typeof entry.target !== "string" || typeof entry.canonical !== "string"
          || !Number.isSafeInteger(entry.bytes) || ![0o644, 0o755].includes(entry.mode)
          || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? "")) {
        throw new Error("package runtime alias projection entry is malformed");
      }
      const copied = files.find((file) => file.path === entry.path);
      if (!copied || copied.bytes !== entry.bytes || copied.mode !== entry.mode || copied.sha256 !== entry.sha256) {
        throw new Error("package runtime alias regular copy mismatch: " + entry.path);
      }
      aliases.push({ path: entry.path, target: entry.target, canonical: entry.canonical });
    }
    if (identity({ schema: projection.schema, materialDigest: projection.materialDigest, aliases: projection.aliases }) !== projection.digest) {
      throw new Error("package runtime alias projection digest mismatch");
    }
    for (let index = files.length - 1; index >= 0; index -= 1) {
      if (projectedPaths.has(files[index].path)) files.splice(index, 1);
    }
    aliases.sort(sortPath);
  } else if (projection !== null) {
    throw new Error("legacy package manifest unexpectedly carries runtime alias projection");
  }
  const regulars = new Set(files.map((entry) => entry.path));
  const dirs = new Set(directories.map((entry) => entry.path));
  const aliasTargets = new Map(aliases.map((entry) => [entry.path, entry.target]));
  const resolveAlias = (aliasPath) => {
    const seen = new Set();
    let current = aliasPath;
    while (aliasTargets.has(current)) {
      if (seen.has(current)) throw new Error(`package payload alias cycle at ${aliasPath}`);
      seen.add(current);
      const target = aliasTargets.get(current);
      const next = posix.normalize(posix.join(posix.dirname(current), target));
      if (next === "." || next.startsWith("../") || next === "..") throw new Error(`package payload alias escapes at ${aliasPath}`);
      if (regulars.has(next)) return next;
      if (dirs.has(next)) throw new Error(`package payload alias targets a directory at ${aliasPath}`);
      if (!aliasTargets.has(next)) throw new Error(`package payload alias target is missing at ${aliasPath}`);
      current = next;
    }
    throw new Error(`package payload alias target is missing at ${aliasPath}`);
  };
  if (materialDigest === null) {
    if (aliases.length > 0) throw new Error("legacy payload inventory cannot contain aliases");
    return { identity: identity(files), files: files.length, materialDigest: null };
  }
  if (!/^[a-f0-9]{64}$/u.test(materialDigest)) throw new Error("qualification materialDigest is invalid");
  if (projection !== null && projection.materialDigest !== materialDigest) throw new Error("package runtime alias projection material digest differs from qualification");
  const canonicalAliases = aliases.map((entry) => ({ ...entry, canonical: resolveAlias(entry.path) }));
  const payload = {
    schema: "nebular-native-payload-inventory-v1",
    materialDigest,
    files,
    aliases: canonicalAliases,
    directories,
  };
  return { identity: identity(payload), files: files.length, materialDigest };
}

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
  const payload = await inventoryNativePayload(resolve(options.payload), { expectedTarget: platform.triple });
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
  const platform = PLATFORMS[lane.platform];
  if (!platform) throw new Error(`Unsupported lane platform ${lane.platform}`);
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

  const hasNativePayload = Object.hasOwn(qualification, "nativePayload");
  const hasMaterialDigest = Object.hasOwn(qualification, "materialDigest");
  const legacyDarwinQualification = platform.os === "darwin" && !hasNativePayload && !hasMaterialDigest;
  const qualifiedPayload = qualification.nativePayload ?? null;
  const qualifiedMaterialDigest = qualification.materialDigest ?? null;
  let packagePayload = null;
  if (legacyDarwinQualification) {
    // Older Darwin qualification receipts explicitly predate payload inventory
    // binding.  This compatibility path is intentionally platform-scoped; Linux
    // receipts must carry the actual inventory identity.
    expect(qualifiedPayload === null && qualifiedMaterialDigest === null, "legacy Darwin qualification payload fields are malformed");
  } else {
    expect(hasNativePayload && hasMaterialDigest, "qualification omitted nativePayload/materialDigest");
    expect(qualifiedPayload === null || (typeof qualifiedPayload === "object" && /^[a-f0-9]{64}$/u.test(qualifiedPayload.identity ?? "") && Number.isSafeInteger(qualifiedPayload.files) && qualifiedPayload.files >= 0), "qualification nativePayload is malformed");
    expect(qualifiedMaterialDigest === null || /^[a-f0-9]{64}$/u.test(qualifiedMaterialDigest), "qualification materialDigest is malformed");
    expect(qualifiedPayload !== null || platform.os === "darwin", "non-Darwin qualification is missing nativePayload identity");
    if (qualifiedPayload !== null) {
      expect(build.nativePayload && build.nativePayload.identity === qualifiedPayload.identity && build.nativePayload.files === qualifiedPayload.files,
        "build and qualification native payload identities differ");
      try {
        packagePayload = packagePayloadIdentity(manifest, platform, qualifiedMaterialDigest);
      } catch (error) {
        problems.push(`package payload identity could not be reconstructed: ${error instanceof Error ? error.message : String(error)}`);
      }
      expect(packagePayload?.identity === qualifiedPayload.identity, "package and qualification native payload identities differ");
      expect(packagePayload?.files === qualifiedPayload.files, "package and qualification native payload file counts differ");
    }
  }

  // Candidate files: exactly the two packaged artifacts, unchanged since packaging.
  const names = readdirSync(options.candidateDir).sort();
  const expectedNames = [record.npm.filename, record.raw.filename].sort();
  expect(JSON.stringify(names) === JSON.stringify(expectedNames), `candidate directory holds ${names.join(", ")} instead of ${expectedNames.join(", ")}`);
  const files = names.map((name) => ({ name, sha256: digestOf(join(options.candidateDir, name)) }));
  expect(files.find((file) => file.name === record.npm.filename)?.sha256 === record.npm.sha256, "npm candidate changed after packaging");
  expect(files.find((file) => file.name === record.raw.filename)?.sha256 === record.raw.sha256, "raw candidate changed after packaging");

  // One executable across payload, package manifest, raw archive and every smoke run.
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
    qualification: {
      status: qualification.status,
      nativePayload: qualifiedPayload,
      materialDigest: qualifiedMaterialDigest,
      checks: qualification.checks.map(({ id, ok }) => ({ id, ok })),
    },
    payloadBinding: {
      qualification: qualifiedPayload,
      build: build.nativePayload ?? null,
      package: packagePayload,
    },
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


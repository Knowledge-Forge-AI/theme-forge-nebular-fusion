#!/usr/bin/env node

// Builds the private controller spec from the fixed qualification checkout.
// It performs only bounded local discovery; the controller owns rustup install,
// authenticity, source extraction, builds, tests, packaging, and evidence.

import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CANDIDATE_VERSION,
  CONTROLLER_SCHEMA,
  REPOSITORY,
  REVIEWED_REF,
  RETENTION_DAYS,
} from "./controller.mjs";

const sha256 = /^[a-f0-9]{64}$/u;

function refuse() {
  throw new Error("SOURCE_NATIVE_SPEC_REFUSED");
}

function absolute(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) refuse();
  return resolve(value);
}

function fixed(program, args, cwd, env = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }) {
  const result = spawnSync(program, args, { cwd, env, shell: false, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 });
  if (result.error || result.status !== 0) refuse();
  const value = result.stdout.trim();
  if (!value || /[\r\n]/u.test(value)) refuse();
  return value;
}

function gitIdentity(repo) {
  const commit = fixed("git", ["-C", repo, "rev-parse", "HEAD"]);
  const tree = fixed("git", ["-C", repo, "rev-parse", `${commit}^{tree}`]);
  if (!/^[a-f0-9]{40}$/u.test(commit) || !/^[a-f0-9]{40}$/u.test(tree)) refuse();
  return { commit, tree };
}

function toolPath(name, fallback, env) {
  const value = env[name] ?? fallback;
  return absolute(value);
}

export async function buildSpec({ env = process.env } = {}) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "workflow_dispatch"
      || env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REF !== REVIEWED_REF
      || env.RUNNER_OS !== "macOS" || env.RUNNER_ARCH !== "ARM64") refuse();
  const repo = absolute(env.GITHUB_WORKSPACE ?? process.cwd());
  const temp = await realpath(absolute(env.RUNNER_TEMP)).catch(() => refuse());
  const campaign = join(temp, "nebular-source-native");
  const sourceIdentity = gitIdentity(repo);
  if (sourceIdentity.commit !== env.GITHUB_SHA) refuse();
  const node = process.execPath;
  if (!/^22\.23\.4$/u.test(process.versions.node)) refuse();
  const npmCli = absolute(env.NEBULAR_NPM_CLI ?? join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"));
  const rustup = fixed("/usr/bin/which", ["rustup"], repo, {PATH:env.PATH ?? "/usr/bin:/bin",LANG:"C",LC_ALL:"C"});
  const cargoHome = join(campaign, "cargo-home");
  const rustupHome = join(campaign, "rustup-home");
  const rustupToolchain = join(rustupHome, "toolchains/1.98.0-aarch64-apple-darwin");
  const rust = join(rustupToolchain, "bin/rustc");
  const cargo = join(rustupToolchain, "bin/cargo");
  const rustTargetLibDir = join(rustupToolchain, "lib/rustlib/aarch64-apple-darwin/lib");
  const xcrun = toolPath("NEBULAR_XCRUN", "/usr/bin/xcrun",env);
  const compiler = fixed(xcrun, ["--sdk", "macosx", "--find", "clang"], repo);
  const linker = compiler; // Rust invokes the clang driver; -Wl options are driver arguments.
  const sdk = fixed(xcrun, ["--sdk", "macosx", "--show-sdk-path"], repo);
  const pkgConfig = fixed("/usr/bin/which", ["pkg-config"], repo, {PATH:env.PATH ?? "/usr/bin:/bin",LANG:"C",LC_ALL:"C"});
  const hostHelper = absolute(env.NEBULAR_HOST_INPUTS ?? join(repo, "tools/source-native/host-inputs.mjs"));
  const hostModule = await import(pathToFileURL(hostHelper).href).catch(() => null);
  if (!hostModule?.createCargoConfig) refuse();
  const sourceArchive = absolute(env.NEBULAR_SOURCE_ARCHIVE ?? join(repo, "authenticated-inputs/source-native/native-material-inputs59.tar.gz"));
  const verifierBinding = absolute(env.NEBULAR_VERIFIER_BINDING ?? join(repo, "authenticated-inputs/source-native/runtime-verifier/binding.json"));
  const verifierTarball = absolute(env.NEBULAR_VERIFIER_TARBALL ?? join(repo, "authenticated-inputs/source-native/runtime-verifier/openpgp-6.3.1.tgz"));
  const tools = {
    node,
    bootstrapNode: node,
    python: toolPath("NEBULAR_PYTHON", "/usr/bin/python3",env),
    rustup,
    cargo,
    npmCli,
    tar: toolPath("NEBULAR_TAR", "/usr/bin/tar",env),
    unpack: absolute(env.NEBULAR_UNPACK ?? join(repo, "tools/source-native/unpack-native-inputs.py")),
    hostInputs: hostHelper,
    evidence: absolute(env.NEBULAR_EVIDENCE ?? join(campaign, "bootstrap/extracted/studio/tools/native-rc-evidence.mjs")),
    plan: absolute(env.NEBULAR_PLAN ?? join(campaign, "bootstrap/extracted/studio/tools/native-rc-plan.mjs")),
    memberBridge: absolute(env.NEBULAR_MEMBER_BRIDGE ?? join(repo, "tools/source-native/bridge-archive-members.mjs")),
    sourceBridge: absolute(env.NEBULAR_SOURCE_BRIDGE ?? join(repo, "tools/source-native/source-receipt-bridge.mjs")),
    guard: absolute(env.NEBULAR_TEST_GUARD ?? join(repo, "tools/source-native/assert-native-tests51.mjs")),
    maintainedApi: absolute(env.NEBULAR_MAINTAINED_API ?? join(repo, "tools/source-native/maintained-api.mjs")),
  };
  const paths = {
    bootstrapRoot: join(campaign, "bootstrap"),
    bootstrapExtracted: join(campaign, "bootstrap/extracted"),
    bootstrapStudio: join(campaign, "bootstrap/extracted/studio"),
    bootstrapTools: join(campaign, "bootstrap/extracted/studio/tools"),
    authenticatedNode: join(campaign, "node-authenticated"),
    rustHome: join(campaign, "home"),
    rustupHome,
    cargoHome,
    tmp: join(campaign, "tmp"),
    nodeDownload: join(campaign, "node-download"),
    nodeReceipt: join(campaign, "node-authenticity.json"),
    candidate: join(campaign, "candidate"),
    upload: join(campaign, "upload"),
    smoke: join(campaign, "smoke"),
    publicDir: join(campaign, "public"),
  };
  const output = {
    extractionReceipt: join(campaign, "evidence/extraction.json"),
    archiveManifest: join(campaign, "evidence/archive-members.json"),
    bundleManifest: paths.bootstrapExtracted + "/bundle-manifest.json",
    legacyObservation: join(campaign, "evidence/legacy-observation.json"),
    bridgeDir: join(campaign, "evidence/bridge"),
    plan: join(campaign, "evidence/plan.json"),
    nestedReceipt: join(campaign, "evidence/nested-build-receipt.json"),
    nestedSeal: join(campaign, "evidence/nested-packaging-seal.json"),
    qualification: join(campaign, "upload/evidence/qualification.json"),
    packageRecord: join(campaign, "upload/package-record.json"),
    packageManifest: join(campaign, "upload/package-manifest.json"),
    publicEvidence: join(campaign, "evidence/campaign66-evidence.json"),
    publicDir: paths.publicDir,
    smokeDir: join(campaign, "smoke/evidence"),
  };
  const hostSpec = {
    schema: "nebular-host-input-preparation-v1",
    mode: "actual",
    bundle: { archivePath: sourceArchive, archiveSha256: "82b5819fec903614fb55d840316775cd5c7cb8dba6ddb904dad960230b071141", manifestRelativePath: "bundle-manifest.json" },
    toolchains: { node, npm: npmCli, rust, cargo, compiler, linker, pkgConfig, systemLibraries: rustTargetLibDir, rustTargetLibDir, embeddedRuntime: paths.authenticatedNode },
    rustupRoot: rustupHome,
    rustupHome,
    observedToolchains: { node: "22.23.4", rustc: "1.98.0", cargo: "1.98.0", source: "fixed-workflow-observation" },
    cargoConfig: { content: hostModule.createCargoConfig({ linker, rustupRoot: rustupHome, rustTargetLibDir }) },
    environment: { SDKROOT: sdk, MACOSX_DEPLOYMENT_TARGET: "13.0" },
  };
  await mkdir(dirname(env.NEBULAR_SOURCE_NATIVE_SPEC ?? join(campaign, "spec.json")), { recursive: true, mode: 0o700 });
  const spec = {
    schema: CONTROLLER_SCHEMA,
    repository: REPOSITORY,
    ref: REVIEWED_REF,
    env: Object.fromEntries(Object.entries(env).filter(([key]) => ["HOME", "GITHUB_ACTIONS", "GITHUB_EVENT_NAME", "GITHUB_REPOSITORY", "GITHUB_REF", "GITHUB_REF_TYPE", "RUNNER_OS", "RUNNER_ARCH", "RUNNER_TEMP", "GITHUB_WORKSPACE", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA", "ImageOS", "ImageVersion", "NEBULAR_RC_PACKAGES_SHA256"].includes(key))),
    commandEnv: { PATH: env.PATH ?? "/usr/bin:/bin", HOME: paths.rustHome, TMPDIR: paths.tmp, TMP: paths.tmp, TEMP: paths.tmp, CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome, LANG: "C", LC_ALL: "C", GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: REPOSITORY, GITHUB_SHA:env.GITHUB_SHA, GITHUB_REF: REVIEWED_REF, GITHUB_REF_TYPE: "branch", RUNNER_OS: "macOS", RUNNER_ARCH: "ARM64", RUNNER_TEMP: temp, GITHUB_WORKSPACE: repo, GITHUB_RUN_ID: env.GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT: env.GITHUB_RUN_ATTEMPT },
    candidateVersion: CANDIDATE_VERSION,
    releaseVersion: null,
    retentionDays: RETENTION_DAYS,
    paths,
    tools,
    inputs: { archive: sourceArchive, archiveSha256: "82b5819fec903614fb55d840316775cd5c7cb8dba6ddb904dad960230b071141", archiveBytes: 8846587, archivePath: "authenticated-inputs/source-native/native-material-inputs59.tar.gz", verifier: { binding: { path: verifierBinding }, tarball: { path: verifierTarball, sha256: "2900c3a0119eb134dc88257b873f53fa499df8e8e02ebb61301bd2378c9cc22b" } } },
    host: { spec: join(campaign, "host-spec.json"), bridge: absolute(env.NEBULAR_HOST_BRIDGE ?? join(repo, "tools/source-native/host-bridge.mjs")), receipt: join(campaign, "host-receipt.json"), locator: join(campaign, "host-locator.json") },
    source: { checkout: repo, ...sourceIdentity },
    output,
  };
  await writeFile(join(campaign, "host-spec.json"), `${JSON.stringify(hostSpec, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const specPath = absolute(env.NEBULAR_SOURCE_NATIVE_SPEC ?? join(campaign, "spec.json"));
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { specPath, source: sourceIdentity };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = await buildSpec();
    process.stdout.write(`${JSON.stringify({ status: "spec-prepared", sourceCommit: result.source.commit })}\n`);
  } catch {
    process.stderr.write("SOURCE_NATIVE_SPEC_REFUSED\n");
    process.exitCode = 1;
  }
}


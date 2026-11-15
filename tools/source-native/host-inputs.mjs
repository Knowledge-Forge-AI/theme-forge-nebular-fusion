#!/usr/bin/env node
// Held source-only host-input preparation for the first macOS ARM64 lane.
// Maintained Studio APIs and the archive bridge are explicit ports: this file
// never imports a checkout by path and never claims host/toolchain authority.

import { cp, chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

export const HOST_INPUT_SCHEMA = "nebular-host-input-preparation-v1";
export const LOCATOR_SCHEMA = "nebular-host-input-locator-v1";
export const TARGET = "aarch64-apple-darwin";
export const REQUIRED_REPOSITORY = "Knowledge-Forge-AI/theme-forge-nebular-fusion";
export const REQUIRED_TOOLCHAIN_VERSIONS = Object.freeze({
  node: "22.23.4",
  rustc: "1.98.0",
  cargo: "1.98.0",
});
export const MATERIAL_PROFILE = "paired-material-v1";
export const MATERIAL_GRAPH = Object.freeze({
  indexedModuleCount: 26,
  linkedModuleCount: 25,
  edgeCount: 87,
  bareImportCount: 9,
});
export const MATERIAL_BINDING_SHA256 = "d1f8c5c37b07124bba49ce8dc7b52426c8ab39a71827c475220ce8a657fbe70c";
export const MATERIAL_BINDING_MEMBER_COUNT = 78;
export const SAVED_OUTPUT_OBSERVATION = "saved source-bound output; no fresh compiler build claimed";
export const MAX_RECORD_BYTES = 2 * 1024 * 1024;
export const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const COMMAND_KILL_GRACE_MS = 2_000;

const COMPONENTS = Object.freeze(["burst", "loom", "solar"]);
const EXPECTED_BUNDLE_VERSION = "0.6.1";
const EXPECTED_COMPONENT_VERSIONS = Object.freeze({ burst: "0.6.1", loom: "0.4.0", solar: "0.2.1" });
const EXPECTED_STUDIO_PACKAGE = "@knowledge-forge-ai/theme-forge-nebular-fusion";
const EXPECTED_PREVIEW_PACKAGE = "@knowledge-forge-ai/tfsl-fixture";
const EXPECTED_PREVIEW_VERSION = "0.0.0-tfsb53b";
const EXPECTED_COMPONENT_PACKAGES = Object.freeze({
  burst: "@knowledge-forge-ai/theme-forge-stellar-burst",
  loom: "@knowledge-forge-ai/theme-forge-stellar-loom",
  solar: "@knowledge-forge-ai/theme-forge-solar-sail",
});
const TOOLCHAIN_KEYS = Object.freeze([
  "node", "npm", "rust", "cargo", "compiler", "linker", "pkgConfig", "systemLibraries",
]);
const HEX64 = /^[a-f0-9]{64}$/u;
const SAFE_RELATIVE = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const SOURCE_PATHS = Object.freeze({
  studio: "studio",
  componentSources: "component-sources",
  componentOutputs: "component-outputs",
});

export class HostInputError extends Error {
  constructor(code) {
    super(code);
    this.name = "HostInputError";
    this.code = code;
  }
}

function refuse(code) {
  throw new HostInputError(code);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}

function digest(value) {
  return typeof value === "string" && HEX64.test(value);
}

function absolute(value, code) {
  if (typeof value !== "string" || !isAbsolute(value) || /[\u0000\r\n]/u.test(value)) refuse(code);
  return resolve(value);
}

function relativePath(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096
      || value.startsWith("/") || value.includes("\\") || value.includes("//")
      || value.split("/").some((part) => part === "" || part === "." || part === "..")
      || !SAFE_RELATIVE.test(value)) refuse(code);
  return value;
}

function child(parent, member, code) {
  const candidate = resolve(parent, member);
  const rel = relative(resolve(parent), candidate);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) refuse(code);
  return candidate;
}

function requireFunction(value, name) {
  if (typeof value !== "function") refuse(`HOST_INPUT_API_${name}`);
  return value;
}

function requireMaintained(maintained) {
  if (!isRecord(maintained)) refuse("HOST_INPUT_MAINTAINED_API");
  for (const name of [
    "createBuildInputs", "validateBuildInputs", "inventoryTree", "identity", "digest",
    "verifySolarSailMaterialSourceAuthority", "prepareSolarSailMaterialPayload",
    "verifyPreparedSolarSailMaterialPayload", "sourceBuildPathPolicy",
  ]) requireFunction(maintained[name], name);
  return maintained;
}

function requirePorts(ports) {
  if (!isRecord(ports) || !isRecord(ports.archive)) refuse("HOST_INPUT_ARCHIVE_PORT");
  requireFunction(ports.archive.extractVerified, "ARCHIVE_PORT");
  requireFunction(ports.run, "COMMAND_PORT");
  return ports;
}

function parseJson(bytes, code) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength > MAX_RECORD_BYTES) refuse(code);
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refuse(code);
  }
  if (!isRecord(value)) refuse(code);
  return value;
}

async function readJson(path, code, maintained) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    refuse(code);
  }
  if (typeof maintained.parseStrictJsonRecord === "function") {
    try {
      const value = maintained.parseStrictJsonRecord(bytes);
      if (!isRecord(value)) refuse(code);
      return value;
    } catch {
      refuse(code);
    }
  }
  return parseJson(bytes, code);
}

async function validatePackage(path, expectedName, expectedVersion, code, maintained) {
  const packageRecord = await readJson(path, code, maintained);
  if (packageRecord.name !== expectedName || packageRecord.version !== expectedVersion) refuse(code);
  return packageRecord;
}

async function ensureFreshDirectory(path, mode = 0o700, code = "HOST_INPUT_DESTINATION") {
  const parent = dirname(path);
  let parentInfo;
  try {
    parentInfo = await lstat(parent);
  } catch {
    refuse(code);
  }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) refuse(code);
  try {
    await mkdir(path, { recursive: false, mode });
  } catch {
    refuse(code);
  }
  let info;
  try {
    info = await lstat(path);
    await chmod(path, mode);
  } catch {
    refuse(code);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) refuse(code);
  return path;
}

async function copyFresh(source, destination, { dereference = false, code = "HOST_INPUT_COPY" } = {}) {
  try {
    await lstat(destination);
    refuse(code);
  } catch (error) {
    if (!(error instanceof HostInputError) && error?.code !== "ENOENT") refuse(code);
    if (error instanceof HostInputError) throw error;
  }
  try {
    await cp(source, destination, {
      recursive: true,
      dereference,
      force: false,
      errorOnExist: true,
    });
  } catch {
    refuse(code);
  }
}

function validateActualEnvironment(env) {
  if (!isRecord(env)
      || env.GITHUB_ACTIONS !== "true"
      || env.RUNNER_OS !== "macOS"
      || env.RUNNER_ARCH !== "ARM64"
      || env.GITHUB_REPOSITORY !== REQUIRED_REPOSITORY) {
    refuse("HOST_INPUT_RUNNER_GUARD");
  }
  absolute(env.RUNNER_TEMP, "HOST_INPUT_RUNNER_TEMP");
  absolute(env.GITHUB_WORKSPACE, "HOST_INPUT_WORKSPACE");
}

function validateToolchainPaths(toolchains) {
  if (!isRecord(toolchains)) refuse("HOST_INPUT_TOOLCHAINS");
  const allowed = new Set([...TOOLCHAIN_KEYS, "rustTargetLibDir", "embeddedRuntime"]);
  if (Object.keys(toolchains).some((key) => !allowed.has(key))) refuse("HOST_INPUT_TOOLCHAINS");
  for (const key of TOOLCHAIN_KEYS) absolute(toolchains[key], `HOST_INPUT_TOOLCHAIN_${key.toUpperCase()}`);
  absolute(toolchains.rustTargetLibDir, "HOST_INPUT_RUST_TARGET_LIB");
  if (toolchains.embeddedRuntime !== undefined) absolute(toolchains.embeddedRuntime, "HOST_INPUT_EMBEDDED_RUNTIME");
  return toolchains;
}

function validateObservedToolchains(observed) {
  if (!isRecord(observed)
      || observed.node !== REQUIRED_TOOLCHAIN_VERSIONS.node
      || observed.rustc !== REQUIRED_TOOLCHAIN_VERSIONS.rustc
      || observed.cargo !== REQUIRED_TOOLCHAIN_VERSIONS.cargo
      || observed.source !== "fixed-workflow-observation") {
    refuse("HOST_INPUT_TOOLCHAIN_OBSERVATION");
  }
}

export function createCargoConfig({ linker, rustupRoot, rustTargetLibDir }) {
  const linkerPath = absolute(linker, "HOST_INPUT_TOOLCHAIN_LINKER");
  const rustupPath = absolute(rustupRoot, "HOST_INPUT_RUSTUP_ROOT");
  const targetLibPath = absolute(rustTargetLibDir, "HOST_INPUT_RUST_TARGET_LIB");
  if (/[\x00-\x1f,\\"]/u.test(rustupPath) || /[\x00-\x1f,\\"]/u.test(targetLibPath)) refuse("HOST_INPUT_CARGO_LOCATORS");
  return `[target.${TARGET}]\nlinker = ${JSON.stringify(linkerPath)}\nrustflags = ["-C", "link-arg=-Wl,-oso_prefix,${rustupPath}", "--remap-path-prefix=${targetLibPath}=/cargo-input/target"]\n`;
}

export function validateCargoConfig(content, rustupRoot, rustTargetLibDir, linker) {
  if (typeof content !== "string" || content.length === 0 || content.length > MAX_RECORD_BYTES) {
    refuse("HOST_INPUT_CARGO_CONFIG");
  }
  if (typeof rustupRoot !== "string" || !isAbsolute(rustupRoot)
      || typeof rustTargetLibDir !== "string" || !isAbsolute(rustTargetLibDir)
      || typeof linker !== "string" || !isAbsolute(linker)) {
    refuse("HOST_INPUT_CARGO_LOCATORS");
  }
  if (content.includes("CARGO_ENCODED_RUSTFLAGS")) {
    refuse("HOST_INPUT_CARGO_REMAP");
  }
  let expected;
  try {
    expected = createCargoConfig({ linker, rustupRoot, rustTargetLibDir });
  } catch {
    refuse("HOST_INPUT_CARGO_LOCATORS");
  }
  if (content !== expected) refuse("HOST_INPUT_CARGO_REMAP");
  return content;
}

function validateBundleManifest(manifest) {
  if (!isRecord(manifest)
      || manifest.schema !== "nebular.native-material-input-bundle.v1"
      || manifest.target !== TARGET
      || manifest.mode !== "portable-source"
      || typeof manifest.version !== "string"
      || manifest.version !== EXPECTED_BUNDLE_VERSION
      || manifest.status !== "prepared-unpublished-inputs-not-hosted-evidence"
      || !isRecord(manifest.studio)
      || manifest.studio.root !== SOURCE_PATHS.studio
      || !digest(manifest.studio.composition)
      || !digest(manifest.runtimeRecipeSha256)
      || manifest.nativeBuild !== false
      || manifest.hosted !== false
      || manifest.publication !== false
      || !isRecord(manifest.components)) {
    refuse("HOST_INPUT_BUNDLE_MANIFEST");
  }
  for (const name of COMPONENTS) {
    const component = manifest.components[name];
    if (!isRecord(component)
        || component.sourceRoot !== `${SOURCE_PATHS.componentSources}/${name}`
        || component.outputRoot !== `${SOURCE_PATHS.componentOutputs}/${name}`
        || !digest(component.source)
        || !digest(component.output)
        || component.version !== EXPECTED_COMPONENT_VERSIONS[name]
        || component.observation !== SAVED_OUTPUT_OBSERVATION) {
      refuse("HOST_INPUT_BUNDLE_COMPONENT");
    }
  }
  return manifest;
}

function componentProducer(maintained, archiveSha256, manifest, name, source, output) {
  const producerRecord = {
    schema: "nebular-saved-source-output-producer-v1",
    archiveSha256,
    component: name,
    source,
    output,
    runtimeRecipeSha256: manifest.runtimeRecipeSha256,
    observation: SAVED_OUTPUT_OBSERVATION,
  };
  try {
    return maintained.identity(producerRecord);
  } catch {
    refuse("HOST_INPUT_PRODUCER_IDENTITY");
  }
}

function buildCommandEnvironment({ prepRoot, toolchains, rustupHome, explicitEnvironment, npmCache, cargoHome, cargoTarget, home, temp }) {
  const directories = [
    dirname(toolchains.node), dirname(toolchains.npm), dirname(toolchains.rust), dirname(toolchains.cargo),
    dirname(toolchains.compiler), dirname(toolchains.linker), dirname(toolchains.pkgConfig),
  ];
  const environment = {
    PATH: [...new Set([...directories, "/usr/bin", "/bin"])].join(":"),
    HOME: home,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    CARGO_HOME: cargoHome,
    CARGO_TARGET_DIR: cargoTarget,
    npm_config_cache: npmCache,
    RUSTC: toolchains.rust,
    CARGO: toolchains.cargo,
    CC: toolchains.compiler,
    PKG_CONFIG: toolchains.pkgConfig,
  };
  environment.RUSTUP_HOME = rustupHome;
  if (isRecord(explicitEnvironment)) {
    for (const [key, value] of Object.entries(explicitEnvironment)) {
      if (typeof value !== "string") refuse("HOST_INPUT_ENVIRONMENT");
      if (["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "CARGO_HOME", "CARGO_TARGET_DIR",
        "npm_config_cache", "RUSTUP_HOME", "RUSTC", "CARGO", "CC", "PKG_CONFIG"].includes(key)) {
        refuse("HOST_INPUT_ENVIRONMENT");
      }
      if (!["SDKROOT", "DEVELOPER_DIR", "NIX_CC", "NIX_BINTOOLS", "PKG_CONFIG_PATH",
        "PKG_CONFIG_LIBDIR", "MACOSX_DEPLOYMENT_TARGET"].includes(key)
          && !/^NIX_(?:CFLAGS_COMPILE|LDFLAGS)(?:_FOR_BUILD|_FOR_TARGET)?$/u.test(key)
          && !/^NIX_CC_WRAPPER_TARGET_(?:BUILD|HOST|TARGET)_[a-zA-Z0-9_]+$/u.test(key)) {
        refuse("HOST_INPUT_ENVIRONMENT");
      }
      environment[key] = value;
    }
  }
  if (environment.CARGO_ENCODED_RUSTFLAGS !== undefined) refuse("HOST_INPUT_CARGO_REMAP");
  return environment;
}

function commandResultExitCode(result) {
  if (!isRecord(result)) return null;
  if (Number.isInteger(result.exitCode)) return result.exitCode;
  return null;
}

async function runPhase(ports, phase, program, args, cwd, env) {
  let result;
  try {
    result = await ports.run({ phase, program, args: [...args], cwd, env: { ...env }, maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES });
  } catch {
    refuse(`HOST_INPUT_${phase}_COMMAND`);
  }
  if (result?.failure === "TIMEOUT") refuse(`HOST_INPUT_${phase}_TIMEOUT`);
  if (result?.failure === "OUTPUT_LIMIT") refuse(`HOST_INPUT_${phase}_OUTPUT_LIMIT`);
  if (result?.failure === "ERROR" || result?.failure === "SPAWN") refuse(`HOST_INPUT_${phase}_COMMAND`);
  if (commandResultExitCode(result) !== 0 || (result.failure !== null && result.failure !== undefined) || result.cleanup !== "leader-close-observed") refuse(`HOST_INPUT_${phase}_FAILED`);
  return { phase, status: "completed" };
}

async function inventory(maintained, path, code) {
  try {
    const result = await maintained.inventoryTree(path);
    if (!isRecord(result) || !digest(result.identity)) refuse(code);
    return result;
  } catch {
    refuse(code);
  }
}

async function writeExclusiveJson(path, value, code) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await writeExclusiveText(path, bytes, code);
}

async function writeExclusiveText(path, bytes, code) {
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch {
    refuse(code);
  }
}

function actualRunnerTemp(spec, env) {
  if (spec.mode === "actual") return absolute(env.RUNNER_TEMP, "HOST_INPUT_RUNNER_TEMP");
  return absolute(spec.runnerTemp, "HOST_INPUT_RUNNER_TEMP");
}

function validateSpec(spec, env) {
  if (!isRecord(spec) || spec.schema !== HOST_INPUT_SCHEMA || !["actual", "fixture"].includes(spec.mode)) {
    refuse("HOST_INPUT_SPEC");
  }
  if (spec.mode === "actual") validateActualEnvironment(env);
  if (!isRecord(spec.bundle)
      || !digest(spec.bundle.archiveSha256)
      || !relativePath(spec.bundle.manifestRelativePath, "HOST_INPUT_BUNDLE_MANIFEST_PATH")) {
    refuse("HOST_INPUT_BUNDLE");
  }
  validateToolchainPaths(spec.toolchains);
  absolute(spec.rustupRoot, "HOST_INPUT_RUSTUP_ROOT");
  absolute(spec.rustupHome, "HOST_INPUT_RUSTUP_HOME");
  if (!isRecord(spec.observedToolchains)) refuse("HOST_INPUT_TOOLCHAIN_OBSERVATION");
  validateObservedToolchains(spec.observedToolchains);
  validateCargoConfig(spec.cargoConfig?.content, spec.rustupRoot, spec.toolchains.rustTargetLibDir, spec.toolchains.linker);
  if (!isRecord(spec.environment) || typeof spec.environment.SDKROOT !== "string"
      || typeof spec.environment.MACOSX_DEPLOYMENT_TARGET !== "string") refuse("HOST_INPUT_ENVIRONMENT");
  absolute(spec.environment.SDKROOT, "HOST_INPUT_SDKROOT");
  return spec;
}

function publicToolchains(inputs, observed) {
  const records = {};
  for (const name of ["node", "rust", "cargo", "compiler", "linker", "pkgConfig", "systemLibraries"]) {
    const record = inputs.toolchains[name];
    records[name] = { identity: record.identity, status: "workflow-supplied-observation" };
  }
  records.node.version = observed.node;
  records.rust.version = observed.rustc;
  records.cargo.version = observed.cargo;
  return records;
}

function publicReceipt({ manifest, inputs, materialRoute, phases, archiveSha256, observedToolchains, preparationMode }) {
  return {
    schema: "nebular-host-input-preparation-receipt-v1",
    status: preparationMode === "actual" ? "held-source-inputs-prepared" : "held-source-input-fixture",
    preparationMode,
    pathHygiene: { preparationRootCovered: true, scope: "maintained-components-staging-layout" },
    target: TARGET,
    mode: inputs.mode,
    source: {
      archiveSha256,
      version: manifest.version,
      sourceCandidate: inputs.source.identity,
      runtimeRecipeSha256: manifest.runtimeRecipeSha256,
      authorityStatus: "re-derived-on-host",
    },
    components: Object.fromEntries(COMPONENTS.map((name) => {
      const component = inputs.components[name];
      return [name, {
        source: component.source,
        output: component.output,
        producer: component.producer,
        observation: SAVED_OUTPUT_OBSERVATION,
      }];
    })),
    toolchains: publicToolchains(inputs, observedToolchains),
    dependencies: {
      frontendModules: inputs.dependencies.frontendModules,
      previewModules: inputs.dependencies.previewModules,
      npmCache: "opaque-fresh-runner-cache",
      cargoHome: "opaque-fresh-runner-cache",
    },
    cargo: {
      fetch: "completed",
      build: "not-run",
      test: "not-run",
      settings: inputs.settings.identity,
    },
    materialRoute: {
      profile: materialRoute.materialProfile,
      authorityStatus: materialRoute.authorityStatus,
      target: materialRoute.target,
      sourceCandidate: materialRoute.sourceAuthority.sourceCandidateRecord.identity,
      wholeSourceCandidate: materialRoute.wholeSourceCandidate,
      componentSource: materialRoute.sourceAuthority.component.source,
      bindingSha256: materialRoute.materialBindingSha256,
      bindingMemberCount: materialRoute.materialBindingMemberCount,
      expectedGraph: materialRoute.expectedGraph,
    },
    phases,
    nativeBuild: false,
    hosted: false,
    publication: false,
  };
}

/**
 * Prepare fresh, private inputs for the later offline native-candidate-build.
 * The returned receipt is intentionally path-free; buildInputsPath/privateRoot
 * are caller-owned locators and must not be uploaded as public evidence.
 */
export async function prepareHostInputs(spec, { env = { ...process.env }, ports, maintained } = {}) {
  validateSpec(spec, env);
  requireMaintained(maintained);
  requirePorts(ports);
  const runnerTemp = actualRunnerTemp(spec, env);
  let prepRoot;
  try {
    prepRoot = await ensureFreshDirectory(join(runnerTemp, "nebular-host-input-preparation"));
    for (const name of ["components", "material-sources", "material", "npm-cache", "cargo-home", "cargo-target", "home", "tmp"]) {
      await ensureFreshDirectory(join(prepRoot, name));
    }
    const bundleRoot = join(prepRoot, "bundle");
    try {
      await ports.archive.extractVerified({
        archivePath: absolute(spec.bundle.archivePath, "HOST_INPUT_BUNDLE_ARCHIVE"),
        archiveSha256: spec.bundle.archiveSha256,
        destination: bundleRoot,
      });
    } catch (error) {
      if (error instanceof HostInputError) throw error;
      refuse("HOST_INPUT_BUNDLE_EXTRACT");
    }

    const manifestPath = child(bundleRoot, spec.bundle.manifestRelativePath, "HOST_INPUT_BUNDLE_MANIFEST_PATH");
    const manifest = validateBundleManifest(await readJson(manifestPath, "HOST_INPUT_BUNDLE_MANIFEST", maintained));
    await inventory(maintained, bundleRoot, "HOST_INPUT_BUNDLE_INVENTORY");
    const extractedStudio = child(bundleRoot, SOURCE_PATHS.studio, "HOST_INPUT_BUNDLE_LAYOUT");
    const extractedSources = child(bundleRoot, SOURCE_PATHS.componentSources, "HOST_INPUT_BUNDLE_LAYOUT");
    const extractedOutputs = child(bundleRoot, SOURCE_PATHS.componentOutputs, "HOST_INPUT_BUNDLE_LAYOUT");
    const studioInventory = await inventory(maintained, extractedStudio, "HOST_INPUT_STUDIO_INVENTORY");
    if (studioInventory.identity !== manifest.studio.composition) refuse("HOST_INPUT_STUDIO_DIGEST");
    await validatePackage(child(extractedStudio, "package.json", "HOST_INPUT_BUNDLE_LAYOUT"), EXPECTED_STUDIO_PACKAGE, manifest.version, "HOST_INPUT_STUDIO_PACKAGE", maintained);
    await validatePackage(child(extractedStudio, "loom-preview-source/package.json", "HOST_INPUT_BUNDLE_LAYOUT"), EXPECTED_PREVIEW_PACKAGE, EXPECTED_PREVIEW_VERSION, "HOST_INPUT_PREVIEW_PACKAGE", maintained);
    for (const name of COMPONENTS) {
      const sourceInventory = await inventory(maintained, child(extractedSources, name, "HOST_INPUT_BUNDLE_LAYOUT"), "HOST_INPUT_COMPONENT_SOURCE");
      const outputRoot = child(extractedOutputs, name, "HOST_INPUT_BUNDLE_LAYOUT");
      const outputInventory = await inventory(maintained, outputRoot, "HOST_INPUT_COMPONENT_OUTPUT");
      if (sourceInventory.identity !== manifest.components[name].source
          || outputInventory.identity !== manifest.components[name].output) {
        refuse("HOST_INPUT_COMPONENT_DIGEST");
      }
      await validatePackage(child(outputRoot, "package.json", "HOST_INPUT_BUNDLE_LAYOUT"), EXPECTED_COMPONENT_PACKAGES[name], EXPECTED_COMPONENT_VERSIONS[name], "HOST_INPUT_COMPONENT_PACKAGE", maintained);
    }

    const sourceRoot = join(prepRoot, "canonical-studio-source");
    const npmSource = join(prepRoot, "npm-source");
    const cargoSource = join(prepRoot, "cargo-source");
    await copyFresh(extractedStudio, sourceRoot);
    await copyFresh(extractedStudio, npmSource);
    await copyFresh(extractedStudio, cargoSource);
    for (const name of COMPONENTS) {
      await ensureFreshDirectory(join(prepRoot, "components", name));
      await copyFresh(child(extractedSources, name, "HOST_INPUT_BUNDLE_LAYOUT"), join(prepRoot, "components", name, "source"));
      await copyFresh(child(extractedSources, name, "HOST_INPUT_BUNDLE_LAYOUT"), join(prepRoot, "material-sources", name));
      await copyFresh(child(extractedOutputs, name, "HOST_INPUT_BUNDLE_LAYOUT"), join(prepRoot, "components", name, "output"));
    }

    const cargoHome = join(prepRoot, "cargo-home");
    const cargoConfigPath = join(cargoHome, "config.toml");
    await writeExclusiveText(cargoConfigPath, Buffer.from(spec.cargoConfig.content, "utf8"), "HOST_INPUT_CARGO_CONFIG_WRITE");
    const commandEnvironment = buildCommandEnvironment({
      prepRoot,
      toolchains: spec.toolchains,
      rustupHome: spec.rustupHome,
      explicitEnvironment: spec.environment,
      npmCache: join(prepRoot, "npm-cache"),
      cargoHome,
      cargoTarget: join(prepRoot, "cargo-target"),
      home: join(prepRoot, "home"),
      temp: join(prepRoot, "tmp"),
    });
    const phases = [];
    phases.push(await runPhase(ports, "NPM_FRONTEND", spec.toolchains.node, [spec.toolchains.npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], npmSource, commandEnvironment));
    phases.push(await runPhase(ports, "NPM_PREVIEW", spec.toolchains.node, [spec.toolchains.npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], child(npmSource, "loom-preview-source", "HOST_INPUT_PREVIEW_SOURCE"), commandEnvironment));
    await copyFresh(child(npmSource, "node_modules", "HOST_INPUT_NPM_FRONTEND_OUTPUT"), join(prepRoot, "frontend-modules"), { dereference: true, code: "HOST_INPUT_NPM_FRONTEND_OUTPUT" });
    await copyFresh(child(npmSource, "loom-preview-source/node_modules", "HOST_INPUT_NPM_PREVIEW_OUTPUT"), join(prepRoot, "preview-modules"), { dereference: true, code: "HOST_INPUT_NPM_PREVIEW_OUTPUT" });
    phases.push(await runPhase(ports, "CARGO_FETCH", spec.toolchains.cargo, ["fetch", "--locked", "--target", TARGET], child(cargoSource, "src-tauri", "HOST_INPUT_CARGO_SOURCE"), commandEnvironment));

    const componentRecords = {};
    const componentSourceRecords = {};
    for (const name of COMPONENTS) {
      const sourceInventory = await inventory(maintained, join(prepRoot, "components", name, "source"), "HOST_INPUT_COMPONENT_SOURCE");
      const outputInventory = await inventory(maintained, join(prepRoot, "components", name, "output"), "HOST_INPUT_COMPONENT_OUTPUT");
      if (sourceInventory.identity !== manifest.components[name].source || outputInventory.identity !== manifest.components[name].output) {
        refuse("HOST_INPUT_COMPONENT_DIGEST");
      }
      componentSourceRecords[name] = sourceInventory.identity;
      componentRecords[name] = {
        root: join(prepRoot, "components", name, "output"),
        sourceRoot: join(prepRoot, "components", name, "source"),
        source: sourceInventory.identity,
        output: outputInventory.identity,
        producer: componentProducer(maintained, spec.bundle.archiveSha256, manifest, name, sourceInventory.identity, outputInventory.identity),
        target: TARGET,
        version: manifest.components[name].version,
      };
    }

    const buildInputs = await maintained.createBuildInputs({
      schema: "nebular-build-observations-v1",
      sourceRoot,
      target: TARGET,
      mode: "portable-source",
      components: componentRecords,
      toolchains: {
        node: spec.toolchains.node,
        npm: spec.toolchains.npm,
        rust: spec.toolchains.rust,
        cargo: spec.toolchains.cargo,
        compiler: spec.toolchains.compiler,
        linker: spec.toolchains.linker,
        pkgConfig: spec.toolchains.pkgConfig,
        systemLibraries: spec.toolchains.systemLibraries,
      },
      execution: {
        cargoConfig: cargoConfigPath,
        cargoHome,
        npmCache: join(prepRoot, "npm-cache"),
        frontendModules: join(prepRoot, "frontend-modules"),
        previewModules: join(prepRoot, "preview-modules"),
        cwd: sourceRoot,
        environment: spec.environment,
      },
      embeddedRuntime: spec.toolchains.embeddedRuntime ?? spec.toolchains.node,
    });
    const sourceInventory = await inventory(maintained, join(prepRoot, "material-sources"), "HOST_INPUT_COMPONENT_SOURCES");
    const sourceCandidateRecord = {
      schema: "nebular-source-candidate-v1",
      identity: sourceInventory.identity,
      version: manifest.version,
      target: TARGET,
      components: componentSourceRecords,
    };
    const sourceAuthority = {
      sourceCandidateRecord,
      component: {
        source: componentRecords.solar.source,
        output: componentRecords.solar.output,
        producer: componentRecords.solar.producer,
        version: componentRecords.solar.version,
      },
      sourceRoot: join(prepRoot, "material-sources"),
      packageOutputRoot: join(prepRoot, "components", "solar", "output"),
      target: TARGET,
    };
    const restatedComponents = { source: componentRecords.solar.source, output: componentRecords.solar.output };
    const sourceAuthorityCheck = await maintained.verifySolarSailMaterialSourceAuthority(sourceAuthority, {
      expectedTarget: TARGET,
      restatedComponents,
    });
    const parserNodeIdentity = maintained.digest(await readFile(spec.toolchains.node));
    const materialRoot = join(prepRoot, "material", "solar-sail-payload");
    const preparedMaterial = await maintained.prepareSolarSailMaterialPayload({
      payloadRoot: materialRoot,
      sourceAuthority,
      target: TARGET,
      expectedTarget: TARGET,
      restatedComponents,
      expectedGraph: MATERIAL_GRAPH,
      parserNodePath: spec.toolchains.node,
      parserNodeIdentity,
    });
    const verifiedMaterial = await maintained.verifyPreparedSolarSailMaterialPayload(materialRoot, preparedMaterial.buildPin, {
      expectedTarget: TARGET,
      expectedGraph: MATERIAL_GRAPH,
      parserNodePath: spec.toolchains.node,
      parserNodeIdentity,
    });
    if (preparedMaterial.buildPin.binding.sha256 !== MATERIAL_BINDING_SHA256
        || preparedMaterial.buildPin.binding.memberCount !== MATERIAL_BINDING_MEMBER_COUNT
        || verifiedMaterial.buildPin.binding.sha256 !== MATERIAL_BINDING_SHA256
        || verifiedMaterial.buildPin.binding.memberCount !== MATERIAL_BINDING_MEMBER_COUNT
        || sourceAuthorityCheck.component.source !== componentRecords.solar.source) {
      refuse("HOST_INPUT_MATERIAL_BINDING");
    }
    const materialRoute = {
      schema: "tfsb.nebular-material-source-route-v1",
      materialProfile: MATERIAL_PROFILE,
      authorityStatus: "held-self-derived-record",
      target: TARGET,
      expectedTarget: TARGET,
      wholeSourceCandidate: buildInputs.source.identity,
      sourceAuthority,
      restatedComponents,
      expectedGraph: MATERIAL_GRAPH,
      materialBindingSha256: MATERIAL_BINDING_SHA256,
      materialBindingMemberCount: MATERIAL_BINDING_MEMBER_COUNT,
    };
    const finalInputs = { ...buildInputs, materialRoute };
    await maintained.validateBuildInputs(finalInputs);
    const pathPolicy = await maintained.sourceBuildPathPolicy(finalInputs);
    if (!Array.isArray(pathPolicy?.forbiddenPrefixes) || !pathPolicy.forbiddenPrefixes.includes(prepRoot)) refuse("HOST_INPUT_STAGING_PATH_COVERAGE");
    const buildInputsPath = join(prepRoot, "nebular-build-inputs.json");
    await writeExclusiveJson(buildInputsPath, finalInputs, "HOST_INPUT_BUILD_INPUTS_WRITE");
    const receipt = publicReceipt({
      manifest,
      inputs: finalInputs,
      materialRoute,
      phases,
      archiveSha256: spec.bundle.archiveSha256,
      observedToolchains: spec.observedToolchains,
      preparationMode: spec.mode,
    });
    return { buildInputsPath, privateRoot: prepRoot, receipt };
  } catch (error) {
    if (error instanceof HostInputError) throw error;
    refuse("HOST_INPUT_INTERNAL");
  }
}

export function createChildProcessPort({
  spawnImpl = spawn,
  killImpl = (pid, signal) => process.kill(pid, signal),
  platform = process.platform,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  killGraceMs = COMMAND_KILL_GRACE_MS,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
      || !Number.isSafeInteger(killGraceMs) || killGraceMs <= 0) {
    refuse("HOST_INPUT_COMMAND_LIMIT");
  }
  const killProcess = (childProcess, signal) => {
    try {
      if (platform !== "win32" && Number.isInteger(childProcess.pid) && childProcess.pid > 1) {
        killImpl(-childProcess.pid, signal);
        return true;
      }
      return childProcess.kill(signal) !== false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  };
  return {
    run({ program, args, cwd, env, maxOutputBytes = MAX_COMMAND_OUTPUT_BYTES, timeoutMs: runTimeoutMs = timeoutMs }) {
      if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0
          || !Number.isSafeInteger(runTimeoutMs) || runTimeoutMs <= 0) {
        return Promise.resolve({ exitCode: null, failure: "LIMIT" });
      }
      return new Promise((resolveResult) => {
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let childProcess;
        let closed = false;
        let terminating = false;
        let killSent = false;
        let groupControlConfirmed = true;
        let failure = null;
        let timeoutHandle;
        let killHandle;
        let errorHandle;
        const finish = (exitCode = null, signal = null, observedClose = true) => {
          if (closed) return;
          closed = true;
          clearTimeout(timeoutHandle);
          clearTimeout(killHandle);
          clearTimeout(errorHandle);
          resolveResult({
            exitCode,
            signal,
            failure,
            cleanup: observedClose && groupControlConfirmed ? "leader-close-observed" : "unconfirmed",
            stdoutBytes: Math.min(stdoutBytes, maxOutputBytes),
            stderrBytes: Math.min(stderrBytes, maxOutputBytes),
          });
        };
        const terminate = (reason) => {
          if (closed || terminating) return;
          terminating = true;
          if (!failure) failure = reason;
          if (!childProcess) {
            finish(null, null);
            return;
          }
          groupControlConfirmed = killProcess(childProcess, "SIGTERM") && groupControlConfirmed;
          clearTimeout(killHandle);
          killHandle = setTimeout(() => {
            if (closed) return;
            killSent = true;
            groupControlConfirmed = killProcess(childProcess, "SIGKILL") && groupControlConfirmed;
            clearTimeout(errorHandle);
            errorHandle = setTimeout(() => finish(null, "SIGKILL", false), killGraceMs);
          }, killGraceMs);
        };
        try {
          childProcess = spawnImpl(program, args, {
            cwd,
            env,
            shell: false,
            detached: platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          void error;
          failure = "SPAWN";
          finish(null, null);
          return;
        }
        childProcess.stdout?.on("data", (chunk) => {
          stdoutBytes += chunk?.byteLength ?? Buffer.byteLength(String(chunk));
          if (stdoutBytes > maxOutputBytes) terminate("OUTPUT_LIMIT");
        });
        childProcess.stderr?.on("data", (chunk) => {
          stderrBytes += chunk?.byteLength ?? Buffer.byteLength(String(chunk));
          if (stderrBytes > maxOutputBytes) terminate("OUTPUT_LIMIT");
        });
        childProcess.once("error", () => {
          if (closed) return;
          terminate("ERROR");
        });
        childProcess.once("close", (exitCode, signal) => {
          // Release any remaining descendants even when the leader closed its pipes.
          if (platform !== "win32" && !killSent) { killSent = true; groupControlConfirmed = killProcess(childProcess, "SIGKILL") && groupControlConfirmed; }
          finish(exitCode, signal);
        });
        timeoutHandle = setTimeout(() => terminate("TIMEOUT"), runTimeoutMs);
      });
    },
  };
}

function parseCliArgs(argv) {
  const result = {};
  const names = new Map([["--spec", "spec"], ["--bridge", "bridge"], ["--receipt", "receipt"], ["--locator", "locator"]]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]);
    if (!key || result[key] !== undefined || !argv[index + 1] || argv[index + 1].startsWith("--")) refuse("HOST_INPUT_USAGE");
    result[key] = argv[index + 1];
  }
  if (Object.keys(result).length !== 4) refuse("HOST_INPUT_USAGE");
  for (const key of Object.keys(result)) absolute(result[key], "HOST_INPUT_USAGE");
  return result;
}

async function loadBridge(path) {
  let bridge;
  try {
    bridge = await import(pathToFileURL(path).href);
  } catch {
    refuse("HOST_INPUT_BRIDGE");
  }
  if (!bridge || typeof bridge !== "object" || !isRecord(bridge.maintained) || !isRecord(bridge.ports)) {
    refuse("HOST_INPUT_BRIDGE");
  }
  return bridge;
}

export async function runCli(argv, { load = loadBridge, env = { ...process.env } } = {}) {
  let args;
  try {
    args = parseCliArgs(argv);
    const spec = await readJson(args.spec, "HOST_INPUT_SPEC", {});
    if (spec.mode !== "actual") refuse("HOST_INPUT_CLI_MODE");
    const bridge = await load(args.bridge);
    const result = await prepareHostInputs(spec, { env, ports: bridge.ports, maintained: bridge.maintained });
    await writeExclusiveJson(args.receipt, result.receipt, "HOST_INPUT_RECEIPT_WRITE");
    await writeExclusiveJson(args.locator, { schema: LOCATOR_SCHEMA, buildInputsPath: result.buildInputsPath }, "HOST_INPUT_LOCATOR_WRITE");
    return { status: "prepared", receipt: result.receipt };
  } catch (error) {
    const code = error instanceof HostInputError && /^[A-Z0-9_]+$/u.test(error.code)
      ? error.code : "HOST_INPUT_INTERNAL";
    return { status: "refused", code };
  }
}

function cliExitCode(result) {
  if (result.status === "prepared") return 0;
  if (result.code === "HOST_INPUT_USAGE") return 2;
  if (result.code === "HOST_INPUT_INTERNAL") return 3;
  return 1;
}

function writeCliResult(result) {
  try {
    process.stdout.write(`${JSON.stringify(result.status === "prepared" ? result.receipt : result)}\n`);
    process.exitCode = cliExitCode(result);
  } catch {
    process.exitCode = 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Finish this module's evaluation before the bridge imports its command port.
  // A top-level await here makes that ordinary import back-edge a deadlock.
  // Quiescence before a result remains a failure, never an implicit success.
  process.exitCode = 3;
  void runCli(process.argv.slice(2)).then(writeCliResult, () => {
    writeCliResult({ status: "refused", code: "HOST_INPUT_INTERNAL" });
  });
}

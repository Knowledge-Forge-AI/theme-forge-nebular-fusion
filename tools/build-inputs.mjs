// Versioned source-build authority. Locators are deliberately outside identity.
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { digest, identity, inventoryTree, validateSourceCandidate } from "./candidate-provenance.mjs";
import { targetForTriple, CANDIDATE_VERSION } from "./platform-targets.mjs";
import { isBuildEnvironmentKey, buildSettingsClaims, validateBuildSettings } from "./build-settings.mjs";

/** @typedef {Record<string, unknown>} JsonRecord */
/** @typedef {"burst" | "loom" | "solar"} ComponentName */
/** @typedef {"node" | "rust" | "cargo" | "compiler" | "linker" | "pkgConfig" | "systemLibraries"} ToolchainName */
/** @typedef {JsonRecord & { identity: string, path: string, npm?: { identity: string, path: string } }} ToolchainRecord */
/** @typedef {JsonRecord & { root: string, source: string, sourceRoot?: string, target: string, version: string, producer: string, output: string }} ComponentInput */
/** @typedef {JsonRecord & { source: string, target: string, version: string, output: string, producer: string }} ComponentClaim */
/** @typedef {JsonRecord & { identity?: string, cargo?: { content: string, identity: string, locators: Array<{ path: string, identity: string }> } | null, environment?: JsonRecord, claims?: unknown }} BuildSettings */
/** @typedef {JsonRecord & { frontendModules?: string, previewModules?: string, cargoConfig?: string, cargoHome?: string, npmCache?: string, cwd?: string }} BuildExecution */
/** @typedef {JsonRecord & { schema: "nebular-source-candidate-v1", identity: string, version: string, composition: string, locks: { cargo: string, frontend: string }, components: { burst: string, loom: string, solar: string }, recipe: string, resourcePlans: Record<string, JsonRecord & { resources: string[], externalBin: string[] }> }} SourceCandidate */
/** @typedef {JsonRecord & { schema: "nebular-build-inputs-v1", sourceRoot: string, source: SourceCandidate, target: string, mode: "portable-source" | "nix-source", components: Record<ComponentName, ComponentInput>, toolchains: Record<ToolchainName, ToolchainRecord>, settings: BuildSettings, execution?: BuildExecution, dependencies?: Record<string, string>, embeddedRuntime?: { path: string, identity: string } }} BuildInputs */
/** @typedef {JsonRecord & { schema: string, sourceCandidate: string, target: string, mode: string, components: Record<string, ComponentClaim>, toolchains: Record<string, string>, settings: JsonRecord & ReturnType<typeof buildSettingsClaims>, embeddedRuntime?: string }} BuildClaims */
/** @typedef {{ path: string, replacement: string, directory?: boolean }} PathRemap */
/** @typedef {{ authority: ValidatedBuildInputs, forbiddenPrefixes: string[], cargoRemaps: PathRemap[] }} SourceBuildPolicy */
/** @typedef {{ system: "aarch64-darwin" | "aarch64-linux" | "x86_64-linux", triple: "aarch64-apple-darwin" | "aarch64-unknown-linux-gnu" | "x86_64-unknown-linux-gnu", os: "darwin" | "linux", cpu: "arm64" | "x64", addon: "darwin-arm64" | "linux-arm64-gnu" | "linux-x64-gnu", format: "app.tar.gz" | "tar.gz" }} PlatformTarget */
/** @typedef {{ inputs: BuildInputs, claims: BuildClaims, identity: string, roots: Record<string, string>, tools: Record<string, string>, target: PlatformTarget }} ValidatedBuildInputs */

export { isBuildEnvironmentKey };

/** @type {ReadonlyArray<ComponentName>} */
export const COMPONENTS = Object.freeze(["burst", "loom", "solar"]);
/** @type {ReadonlyArray<ToolchainName>} */
export const TOOLCHAINS = Object.freeze(["node", "rust", "cargo", "compiler", "linker", "pkgConfig", "systemLibraries"]);
const products = Object.fromEntries(COMPONENTS.map(name => [name,
  `@knowledge-forge-ai/theme-forge-${{ burst: "stellar-burst", loom: "stellar-loom", solar: "solar-sail" }[name]}`]));
/** @param {string} message @returns {never} */
const fail = message => { throw new Error(`Build inputs: ${message}`); };
/** @param {unknown} value @returns {value is string} */
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
/** @param {unknown} value @returns {string} */
const locator = value => {
  if (typeof value !== "string" || !isAbsolute(value)) fail("absolute execution locator required");
  return resolve(/** @type {string} */ (value));
};

/** @param {unknown} value @returns {value is JsonRecord} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The product floor is Tauri bundle.macOS.minimumSystemVersion (13.0). Absence
// stays governed by generic settings parity; a present Darwin value may only
// raise it. Components compare numerically, never as strings.
const DARWIN_FLOOR_MAJOR = 13, DARWIN_FLOOR_MINOR = 0;
/** @param {unknown} value @returns {void} */
function requireDarwinDeploymentTarget(value) {
  const match = typeof value === "string" ? /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?$/.exec(value) : null;
  if (!match) return fail("Darwin MACOSX_DEPLOYMENT_TARGET must be numeric major.minor[.patch]");
  const major = Number(match[1]), minor = Number(match[2]);
  if (major < DARWIN_FLOOR_MAJOR || (major === DARWIN_FLOOR_MAJOR && minor < DARWIN_FLOOR_MINOR)) {
    fail(`Darwin MACOSX_DEPLOYMENT_TARGET ${value} is below product floor ${DARWIN_FLOOR_MAJOR}.${DARWIN_FLOOR_MINOR}`);
  }
}

/** @param {JsonRecord} inputs @returns {BuildClaims} */
export function buildInputClaims(inputs) {
  if (!inputs || inputs.schema !== "nebular-build-inputs-v1") fail("unsupported authority schema");
  const authority = /** @type {BuildInputs} */ (inputs);
  validateSourceCandidate(authority.source);
  const target = targetForTriple(authority.target);
  if (!["portable-source", "nix-source"].includes(authority.mode)) fail("explicit source build mode required");
  /** @type {Record<string, ComponentClaim>} */
  const components = {};
  for (const name of COMPONENTS) {
    const c = authority.components?.[name];
    if (!c || c.source !== authority.source.components[name] || c.target !== target.triple
        || !sha(c.output) || !sha(c.producer) || typeof c.version !== "string" || !c.version) {
      fail(`${name} source, target or producer mismatch`);
    }
    components[name] = { source: c.source, target: c.target, version: c.version, output: c.output, producer: c.producer };
  }
  /** @type {Record<string, string>} */
  const toolchains = {};
  for (const name of TOOLCHAINS) {
    const t = authority.toolchains?.[name];
    if (!t || !sha(t.identity)) fail(`${name} toolchain identity required`);
    if (name === "node" && t.npm) {
      if (!sha(t.npm.identity)) fail("npm toolchain identity required");
      toolchains[name] = identity({ node: t.identity, npm: t.npm.identity, dependencies: authority.dependencies ?? {} });
    } else toolchains[name] = t.identity;
  }
  toolchains.systemLibraries = identity({ libraries: toolchains.systemLibraries, pkgConfig: toolchains.pkgConfig });
  delete toolchains.pkgConfig;
  if (!authority.settings || typeof authority.settings !== "object") fail("explicit build settings required");
  const settings = buildSettingsClaims(authority.settings);
  if (target.os === "darwin" && Object.hasOwn(settings.environment.semantic, "MACOSX_DEPLOYMENT_TARGET")) {
    requireDarwinDeploymentTarget(settings.environment.semantic.MACOSX_DEPLOYMENT_TARGET);
  }
  if (authority.source.version !== CANDIDATE_VERSION) fail("candidate version mismatch");
  /** @type {BuildClaims} */
  const claims = { schema: authority.schema, sourceCandidate: authority.source.identity, target: target.triple,
    mode: authority.mode, components, toolchains, settings };
  if (authority.embeddedRuntime) {
    if (!authority.embeddedRuntime || typeof authority.embeddedRuntime !== "object") fail("embeddedRuntime record required");
    if (!sha(authority.embeddedRuntime.identity)) fail("embeddedRuntime identity required");
    claims.embeddedRuntime = authority.embeddedRuntime.identity;
  }
  return claims;
}

/** @param {string} path @returns {Promise<ValidatedBuildInputs>} */
export async function loadBuildInputs(path) {
  return validateBuildInputs(JSON.parse(await readFile(path, "utf8")));
}

// Every consumer validates qualified bytes at its boundary. Callers supply
// producer identities from their accepted builds; hashing is not authentication.
/** @param {JsonRecord} inputs @returns {Promise<ValidatedBuildInputs>} */
export async function validateBuildInputs(inputs) {
  const authority = /** @type {BuildInputs} */ (inputs);
  const claims = buildInputClaims(authority);
  await validateBuildSettings(authority.settings, authority.execution);
  /** @type {Record<string, string>} */
  const roots = {};
  for (const name of COMPONENTS) {
    const component = authority.components[name];
    roots[name] = await realpath(locator(component.root));
    const inventory = await inventoryTree(roots[name]);
    if (inventory.identity !== component.output) fail(`${name} output inventory mismatch`);
    const pkg = JSON.parse(await readFile(join(roots[name], "package.json"), "utf8"));
    if (pkg.name !== products[name] || pkg.version !== component.version) fail(`${name} package identity mismatch`);
  }
  /** @type {Record<string, string>} */
  const tools = {};
  for (const name of TOOLCHAINS) {
    const record = authority.toolchains[name];
    tools[name] = await realpath(locator(record.path));
    const actual = name === "systemLibraries" && (await stat(tools[name])).isDirectory()
      ? (await inventoryTree(tools[name])).identity : digest(await readFile(tools[name]));
    if (actual !== record.identity) fail(`${name} toolchain bytes mismatch`);
    if (name === "node" && record.npm) {
      tools.npm = await realpath(locator(record.npm.path));
      if (digest(await readFile(tools.npm)) !== record.npm.identity) fail("npm toolchain bytes mismatch");
    }
  }
  if (authority.embeddedRuntime) {
    tools.embeddedRuntime = await realpath(locator(authority.embeddedRuntime.path));
    const actual = digest(await readFile(tools.embeddedRuntime));
    if (actual !== authority.embeddedRuntime.identity) fail("embeddedRuntime toolchain bytes mismatch");
  }
  for (const key of ["frontendModules", "previewModules"]) {
    const root = authority.execution?.[key];
    if (root) {
      if (typeof root !== "string") fail(`${key} dependency locator must be absolute`);
      const dependencyIdentity = authority.dependencies?.[key];
      if (!sha(dependencyIdentity)) fail(`${key} dependency inventory mismatch`);
      if ((await inventoryTree(/** @type {string} */ (root))).identity !== dependencyIdentity) fail(`${key} dependency inventory mismatch`);
    } else if (authority.dependencies?.[key]) fail(`${key} dependency locator missing`);
  }
  return { inputs: authority, claims, identity: identity(claims), roots, tools, target: targetForTriple(authority.target) };
}

/** @param {string} root @param {SourceCandidate} source @returns {Promise<JsonRecord>} */
export async function verifySourceTree(root, source) {
  validateSourceCandidate(source);
  const tree = await inventoryTree(root);
  const forbidden = /(?:^|\/)(?:\.git|\.cargo|authenticated-inputs|node_modules|target|dist|prebuilds|sidecar-payload|loom-payload|solar-sail-payload|scene-payload|binaries|release-notices)(?:\/|$)/;
  if (tree.files.some(f => forbidden.test(f.path) || f.path.startsWith("public/preview/"))) fail("source contains generated or private inputs");
  if (tree.identity !== source.composition) fail("source composition mismatch");
  for (const name of ["cargo", "frontend"]) {
    const path = name === "cargo" ? "src-tauri/Cargo.lock" : "package-lock.json";
    const expectedLock = name === "cargo" ? source.locks.cargo : source.locks.frontend;
    if (digest(await readFile(join(root, path))) !== expectedLock) fail(`${name} lock mismatch`);
  }
  return tree;
}

// Revalidate in the execution namespace while dependencies are still mounted.
// Toolchains and SDK/system-library locators are deliberately not shipped-path
// exclusions: those may be stable runtime dependencies.
/** @param {JsonRecord} inputs @returns {Promise<SourceBuildPolicy>} */
export async function sourceBuildPathPolicy(inputs) {
  const inputAuthority = /** @type {BuildInputs} */ (inputs);
  const authority = await validateBuildInputs(inputAuthority);
  await verifySourceTree(locator(inputAuthority.sourceRoot), inputAuthority.source);
  const paths = new Set();
  /** @param {string} path @returns {Promise<string[]>} */
  async function spellings(path) {
    const original = locator(path);
    if (original === "/") fail("filesystem root cannot be a build locator");
    const physical = await realpath(original);
    const result = [...new Set([path, original, physical])];
    for (const p of result) paths.add(p);
    return result;
  }
  await spellings(inputAuthority.sourceRoot);
  for (const name of COMPONENTS) {
    const c = inputAuthority.components[name];
    await spellings(c.root);
    if (c.sourceRoot) {
      if ((await inventoryTree(locator(c.sourceRoot))).identity !== c.source) fail(`${name} source inventory mismatch`);
      await spellings(c.sourceRoot);
    }
  }
  for (const key of ["frontendModules", "previewModules", "cargoConfig", "cargoHome", "npmCache", "cwd"]) {
    const value = inputAuthority.execution?.[key];
    if (value) {
      if (typeof value !== "string") fail(`${key} execution locator must be absolute`);
      await spellings(/** @type {string} */ (value));
    }
  }
  const cargoRemaps = [];
  for (const input of inputAuthority.settings.cargo?.locators ?? []) {
    const directory = (await stat(input.path)).isDirectory();
    for (const path of await spellings(input.path)) {
      // Equal-content locators intentionally share a synthetic namespace.
      cargoRemaps.push({ path, replacement: `/cargo-input/${input.identity}`, directory });
    }
  }
  // Recognize only the maintained preparer's closed staging layout. Never
  // infer a broad temp/outbox ancestor from an arbitrary common prefix.
  const staging = dirname(resolve(inputAuthority.sourceRoot));
  if (basename(inputAuthority.sourceRoot) === "canonical-studio-source"
      && COMPONENTS.every(name => inputAuthority.components[name].root === join(staging, "components", name, "output")
        && inputAuthority.components[name].sourceRoot === join(staging, "components", name, "source"))) {
    await spellings(staging);
  }
  return { authority, forbiddenPrefixes: [...paths].sort(), cargoRemaps };
}

// rustc uses the last matching prefix. Append trusted maps after caller flags,
// broadest first; an existing map for the same root wins over a Cargo map.
// Directory separators prevent a locator 'vendor' from remapping 'vendor-old'.
/** @param {SourceBuildPolicy} policy @param {PathRemap[]} [existing] @returns {string[]} */
export function sourcePathRemapFlags(policy, existing = []) {
  const mappings = new Map();
  for (const entry of [...policy.cargoRemaps, ...existing]) mappings.set(entry.path, entry);
  return [...mappings.values()]
    .sort((a, b) => a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ path, replacement, directory = true }) =>
      `--remap-path-prefix=${path}${directory && !path.endsWith("/") ? "/" : ""}=${replacement}${directory ? "/" : ""}`);
}

/** @param {ValidatedBuildInputs} authority @param {JsonRecord} receipt @returns {void} */
export function verifyBuildInputReceipt(authority, receipt) {
  const claims = authority.claims;
  for (const key of ["sourceCandidate", "target", "mode"]) {
    if (receipt[key] !== claims[key]) fail(`receipt ${key} mismatch`);
  }
  if (receipt.settings !== claims.settings.identity) fail("receipt settings mismatch");
  if (identity(receipt.toolchains) !== identity(claims.toolchains)) fail("receipt toolchains mismatch");
  for (const name of COMPONENTS) {
    const claim = claims.components[name];
    if (!claim) fail(`receipt ${name} mismatch`);
    const expected = /** @type {ComponentClaim} */ (claim);
    const component = isRecord(receipt.components) && isRecord(receipt.components[name])
      ? receipt.components[name] : null;
    for (const key of ["source", "output", "producer"]) {
      if (!component || component[key] !== expected[key]) fail(`receipt ${name} ${key} mismatch`);
    }
  }
}

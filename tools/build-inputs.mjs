// Versioned source-build authority. Locators are deliberately outside identity.
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { digest, identity, inventoryTree, validateSourceCandidate } from "./candidate-provenance.mjs";
import { targetForTriple, CANDIDATE_VERSION } from "./platform-targets.mjs";
import { isBuildEnvironmentKey, buildSettingsClaims, validateBuildSettings } from "./build-settings.mjs";

export { isBuildEnvironmentKey };

export const COMPONENTS = Object.freeze(["burst", "loom", "solar"]);
export const TOOLCHAINS = Object.freeze(["node", "rust", "cargo", "compiler", "linker", "pkgConfig", "systemLibraries"]);
const products = Object.fromEntries(COMPONENTS.map(name => [name,
  `@knowledge-forge-ai/theme-forge-${{ burst: "stellar-burst", loom: "stellar-loom", solar: "solar-sail" }[name]}`]));
const fail = message => { throw new Error(`Build inputs: ${message}`); };
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const locator = value => {
  if (typeof value !== "string" || !isAbsolute(value)) fail("absolute execution locator required");
  return resolve(value);
};

export function buildInputClaims(inputs) {
  if (!inputs || inputs.schema !== "nebular-build-inputs-v1") fail("unsupported authority schema");
  validateSourceCandidate(inputs.source);
  const target = targetForTriple(inputs.target);
  if (!["portable-source", "nix-source"].includes(inputs.mode)) fail("explicit source build mode required");
  const components = {};
  for (const name of COMPONENTS) {
    const c = inputs.components?.[name];
    if (!c || c.source !== inputs.source.components[name] || c.target !== target.triple
        || !sha(c.output) || !sha(c.producer) || typeof c.version !== "string" || !c.version) {
      fail(`${name} source, target or producer mismatch`);
    }
    components[name] = { source: c.source, target: c.target, version: c.version, output: c.output, producer: c.producer };
  }
  const toolchains = {};
  for (const name of TOOLCHAINS) {
    const t = inputs.toolchains?.[name];
    if (!t || !sha(t.identity)) fail(`${name} toolchain identity required`);
    if (name === "node" && t.npm) {
      if (!sha(t.npm.identity)) fail("npm toolchain identity required");
      toolchains[name] = identity({ node: t.identity, npm: t.npm.identity, dependencies: inputs.dependencies ?? {} });
    } else toolchains[name] = t.identity;
  }
  toolchains.systemLibraries = identity({ libraries: toolchains.systemLibraries, pkgConfig: toolchains.pkgConfig });
  delete toolchains.pkgConfig;
  if (!inputs.settings || typeof inputs.settings !== "object") fail("explicit build settings required");
  const settings = buildSettingsClaims(inputs.settings);
  if (inputs.source.version !== CANDIDATE_VERSION) fail("candidate version mismatch");
  const claims = { schema: inputs.schema, sourceCandidate: inputs.source.identity, target: target.triple,
    mode: inputs.mode, components, toolchains, settings };
  if (inputs.embeddedRuntime) {
    if (!inputs.embeddedRuntime || typeof inputs.embeddedRuntime !== "object") fail("embeddedRuntime record required");
    if (!sha(inputs.embeddedRuntime.identity)) fail("embeddedRuntime identity required");
    claims.embeddedRuntime = inputs.embeddedRuntime.identity;
  }
  return claims;
}

export async function loadBuildInputs(path) {
  return validateBuildInputs(JSON.parse(await readFile(path, "utf8")));
}

// Every consumer validates qualified bytes at its boundary. Callers supply
// producer identities from their accepted builds; hashing is not authentication.
export async function validateBuildInputs(inputs) {
  const claims = buildInputClaims(inputs);
  await validateBuildSettings(inputs.settings, inputs.execution);
  const roots = {};
  for (const name of COMPONENTS) {
    const component = inputs.components[name];
    roots[name] = await realpath(locator(component.root));
    const inventory = await inventoryTree(roots[name]);
    if (inventory.identity !== component.output) fail(`${name} output inventory mismatch`);
    const pkg = JSON.parse(await readFile(join(roots[name], "package.json"), "utf8"));
    if (pkg.name !== products[name] || pkg.version !== component.version) fail(`${name} package identity mismatch`);
  }
  const tools = {};
  for (const name of TOOLCHAINS) {
    const record = inputs.toolchains[name];
    tools[name] = await realpath(locator(record.path));
    const actual = name === "systemLibraries" && (await stat(tools[name])).isDirectory()
      ? (await inventoryTree(tools[name])).identity : digest(await readFile(tools[name]));
    if (actual !== record.identity) fail(`${name} toolchain bytes mismatch`);
    if (name === "node" && record.npm) {
      tools.npm = await realpath(locator(record.npm.path));
      if (digest(await readFile(tools.npm)) !== record.npm.identity) fail("npm toolchain bytes mismatch");
    }
  }
  if (inputs.embeddedRuntime) {
    tools.embeddedRuntime = await realpath(locator(inputs.embeddedRuntime.path));
    const actual = digest(await readFile(tools.embeddedRuntime));
    if (actual !== inputs.embeddedRuntime.identity) fail("embeddedRuntime toolchain bytes mismatch");
  }
  for (const key of ["frontendModules", "previewModules"]) {
    const root = inputs.execution?.[key];
    if (root) {
      if (!sha(inputs.dependencies?.[key]) || (await inventoryTree(root)).identity !== inputs.dependencies[key]) fail(`${key} dependency inventory mismatch`);
    } else if (inputs.dependencies?.[key]) fail(`${key} dependency locator missing`);
  }
  return { inputs, claims, identity: identity(claims), roots, tools, target: targetForTriple(inputs.target) };
}

export async function verifySourceTree(root, source) {
  validateSourceCandidate(source);
  const tree = await inventoryTree(root);
  const forbidden = /(?:^|\/)(?:\.git|\.cargo|authenticated-inputs|node_modules|target|dist|prebuilds|sidecar-payload|loom-payload|solar-sail-payload|scene-payload|binaries|release-notices)(?:\/|$)/;
  if (tree.files.some(f => forbidden.test(f.path) || f.path.startsWith("public/preview/"))) fail("source contains generated or private inputs");
  if (tree.identity !== source.composition) fail("source composition mismatch");
  for (const [name, path] of [["cargo", "src-tauri/Cargo.lock"], ["frontend", "package-lock.json"]]) {
    if (digest(await readFile(join(root, path))) !== source.locks[name]) fail(`${name} lock mismatch`);
  }
  return tree;
}

// Revalidate in the execution namespace while dependencies are still mounted.
// Toolchains and SDK/system-library locators are deliberately not shipped-path
// exclusions: those may be stable runtime dependencies.
export async function sourceBuildPathPolicy(inputs) {
  const authority = await validateBuildInputs(inputs);
  await verifySourceTree(locator(inputs.sourceRoot), inputs.source);
  const paths = new Set();
  async function spellings(path) {
    const original = locator(path);
    if (original === "/") fail("filesystem root cannot be a build locator");
    const physical = await realpath(original);
    const result = [...new Set([path, original, physical])];
    for (const p of result) paths.add(p);
    return result;
  }
  await spellings(inputs.sourceRoot);
  for (const name of COMPONENTS) {
    const c = inputs.components[name];
    await spellings(c.root);
    if (c.sourceRoot) {
      if ((await inventoryTree(locator(c.sourceRoot))).identity !== c.source) fail(`${name} source inventory mismatch`);
      await spellings(c.sourceRoot);
    }
  }
  for (const key of ["frontendModules", "previewModules", "cargoConfig", "cargoHome", "npmCache", "cwd"]) {
    if (inputs.execution?.[key]) await spellings(inputs.execution[key]);
  }
  const cargoRemaps = [];
  for (const input of inputs.settings.cargo?.locators ?? []) {
    const directory = (await stat(input.path)).isDirectory();
    for (const path of await spellings(input.path)) {
      // Equal-content locators intentionally share a synthetic namespace.
      cargoRemaps.push({ path, replacement: `/cargo-input/${input.identity}`, directory });
    }
  }
  // Recognize only the maintained preparer's closed staging layout. Never
  // infer a broad temp/outbox ancestor from an arbitrary common prefix.
  const staging = dirname(resolve(inputs.sourceRoot));
  if (basename(inputs.sourceRoot) === "canonical-studio-source"
      && COMPONENTS.every(name => inputs.components[name].root === join(staging, "components", name, "output")
        && inputs.components[name].sourceRoot === join(staging, "components", name, "source"))) {
    await spellings(staging);
  }
  return { authority, forbiddenPrefixes: [...paths].sort(), cargoRemaps };
}

// rustc uses the last matching prefix. Append trusted maps after caller flags,
// broadest first; an existing map for the same root wins over a Cargo map.
// Directory separators prevent a locator 'vendor' from remapping 'vendor-old'.
export function sourcePathRemapFlags(policy, existing = []) {
  const mappings = new Map();
  for (const entry of [...policy.cargoRemaps, ...existing]) mappings.set(entry.path, entry);
  return [...mappings.values()]
    .sort((a, b) => a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ path, replacement, directory = true }) =>
      `--remap-path-prefix=${path}${directory && !path.endsWith("/") ? "/" : ""}=${replacement}${directory ? "/" : ""}`);
}

export function verifyBuildInputReceipt(authority, receipt) {
  const claims = authority.claims;
  for (const key of ["sourceCandidate", "target", "mode"]) {
    if (receipt[key] !== claims[key]) fail(`receipt ${key} mismatch`);
  }
  if (receipt.settings !== claims.settings.identity) fail("receipt settings mismatch");
  if (identity(receipt.toolchains) !== identity(claims.toolchains)) fail("receipt toolchains mismatch");
  for (const name of COMPONENTS) {
    for (const key of ["source", "output", "producer"]) {
      if (receipt.components?.[name]?.[key] !== claims.components[name][key]) fail(`receipt ${name} ${key} mismatch`);
    }
  }
}

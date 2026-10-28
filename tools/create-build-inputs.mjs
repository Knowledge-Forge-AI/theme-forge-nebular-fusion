// Materialize authority from explicit producer observations, never Git or PATH.
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { COMPONENTS, TOOLCHAINS, validateBuildInputs, verifySourceTree } from "./build-inputs.mjs";
import { digest, inventoryTree, seal, sourceResourcePlans } from "./candidate-provenance.mjs";
import { createBuildSettings } from "./build-settings.mjs";
import { defaultSnapshotReader } from "./fs-snapshot.mjs";

/** @typedef {typeof defaultSnapshotReader} SnapshotReader */
/** @typedef {Awaited<ReturnType<typeof validateBuildInputs>>} ValidatedBuildInputs */
/** @typedef {ValidatedBuildInputs["inputs"]} BuildInputs */
/** @typedef {BuildInputs["source"]} SourceCandidate */
/** @typedef {BuildInputs["components"][keyof BuildInputs["components"]]} ComponentInput */
/** @typedef {BuildInputs["toolchains"][keyof BuildInputs["toolchains"]]} ToolchainRecord */
/** @typedef {"burst" | "loom" | "solar"} ComponentName */
/** @typedef {"node" | "rust" | "cargo" | "compiler" | "linker" | "pkgConfig" | "systemLibraries"} ToolchainName */
/** @typedef {{ root: string, sourceRoot: string, producer: string }} ComponentObservation */
/** @typedef {{
 * schema: "nebular-build-observations-v1",
 * sourceRoot: string,
 * target: string,
 * mode: "portable-source" | "nix-source",
 * source?: SourceCandidate,
 * components: Record<ComponentName, ComponentObservation>,
 * toolchains: Record<ToolchainName, string> & { npm: string },
 * execution?: { environment?: Record<string, string>, cargoConfig?: string, cargoHome?: string, npmCache?: string, frontendModules?: string, previewModules?: string, cwd?: string },
 * embeddedRuntime?: string,
 * }} BuildObservations */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {string} root @returns {Promise<string>} */
async function packageVersion(root) {
  const parsed = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (!isRecord(parsed) || typeof parsed.version !== "string" || !parsed.version) {
    throw new Error(`Package version is required: ${join(root, "package.json")}`);
  }
  return parsed.version;
}

// Toolchain locators may be links (rustup proxies, Nix profiles), so the final
// link is followed. The member is opened once: a file's identity is the digest
// of the bytes read through that descriptor, and a directory is inventoried while
// the descriptor is held; afterwards the descriptor and the locator path must
// still name the object that was opened.
/**
 * @param {string} path
 * @param {{ reader?: SnapshotReader, label?: string }} [options]
 * @returns {Promise<string>}
 */
export async function toolchainIdentity(path, { reader = defaultSnapshotReader, label = "Toolchain input" } = {}) {
  const options = { follow: true, bindPath: true, label, maxBytes: 1024 * 1024 * 1024 };
  const bound = reader.withBound(path, options, async ({ type, read }) => {
    if (type === "directory") return (await inventoryTree(path)).identity;
    return read().sha256;
  });
  if (bound === null) throw new Error(`${label} is missing: ${path}`);
  const result = await bound;
  if (typeof result !== "string") throw new Error(`${label} identity is invalid: ${path}`);
  return result;
}

/** @param {BuildObservations} spec @param {{ reader?: SnapshotReader }} [options] @returns {Promise<BuildInputs>} */
export async function createBuildInputs(spec, { reader = defaultSnapshotReader } = {}) {
  if (spec.schema !== "nebular-build-observations-v1") throw new Error("Explicit build observations required");
  /** @type {Partial<Record<ComponentName, ComponentInput>>} */
  const components = {};
  /** @type {Partial<Record<ComponentName, string>>} */
  const componentSources = {};
  for (const name of COMPONENTS) {
    const observed = spec.components[name];
    if (!observed) throw new Error(`Missing component observation: ${name}`);
    const version = await packageVersion(observed.root);
    componentSources[name] = (await inventoryTree(observed.sourceRoot)).identity;
    components[name] = { root: observed.root, sourceRoot: observed.sourceRoot, source: componentSources[name], target: spec.target,
      version, output: (await inventoryTree(observed.root)).identity, producer: observed.producer };
  }
  if (!components.burst || !components.loom || !components.solar
      || !componentSources.burst || !componentSources.loom || !componentSources.solar) {
    throw new Error("Complete component observations required");
  }
  const completeComponents = { burst: components.burst, loom: components.loom, solar: components.solar };
  const completeComponentSources = { burst: componentSources.burst, loom: componentSources.loom, solar: componentSources.solar };
  /** @type {Partial<Record<ToolchainName, ToolchainRecord>>} */
  const toolchains = {};
  for (const name of TOOLCHAINS) {
    const path = spec.toolchains[name];
    if (typeof path !== "string") throw new Error(`Missing toolchain observation: ${name}`);
    toolchains[name] = { path, identity: await toolchainIdentity(path, { reader, label: `Toolchain ${name}` }) };
  }
  if (!spec.toolchains.npm) throw new Error("Explicit npm CLI input required");
  const nodeToolchain = toolchains.node;
  const rustToolchain = toolchains.rust;
  const cargoToolchain = toolchains.cargo;
  const compilerToolchain = toolchains.compiler;
  const linkerToolchain = toolchains.linker;
  const pkgConfigToolchain = toolchains.pkgConfig;
  const systemLibrariesToolchain = toolchains.systemLibraries;
  if (!nodeToolchain || !rustToolchain || !cargoToolchain || !compilerToolchain || !linkerToolchain
      || !pkgConfigToolchain || !systemLibrariesToolchain) throw new Error("Complete toolchain observations required");
  const npmSnapshot = reader.readRegular(spec.toolchains.npm, { follow: true, bindPath: true, label: "npm CLI input" });
  if (!npmSnapshot) throw new Error(`npm CLI input is missing: ${spec.toolchains.npm}`);
  nodeToolchain.npm = { path: spec.toolchains.npm, identity: npmSnapshot.sha256 };
  const source = spec.source ?? seal("nebular-source-candidate-v1", {
    version: await packageVersion(spec.sourceRoot),
    composition: (await inventoryTree(spec.sourceRoot)).identity,
    locks: { cargo: digest(await readFile(join(spec.sourceRoot, "src-tauri/Cargo.lock"))), frontend: digest(await readFile(join(spec.sourceRoot, "package-lock.json"))) },
    components: completeComponentSources, recipe: (await inventoryTree(join(spec.sourceRoot, "tools"))).identity,
    resourcePlans: sourceResourcePlans(JSON.parse(await readFile(join(spec.sourceRoot, "src-tauri/tauri.conf.json"), "utf8"))),
  });
  await verifySourceTree(spec.sourceRoot, source);
  /** @type {Record<string, string>} */
  const dependencies = {};
  /** @type {ReadonlyArray<"frontendModules" | "previewModules">} */
  const dependencyNames = ["frontendModules", "previewModules"];
  for (const key of dependencyNames) {
    const dependencyPath = spec.execution?.[key];
    if (dependencyPath) dependencies[key] = (await inventoryTree(dependencyPath)).identity;
  }
  const settings = await createBuildSettings({
    cargoConfig: spec.execution?.cargoConfig,
    environment: spec.execution?.environment ?? {},
  });
  /** @type {BuildInputs} */
  const inputs = { schema: "nebular-build-inputs-v1", sourceRoot: spec.sourceRoot, source,
    target: spec.target, mode: spec.mode, components: completeComponents,
    toolchains: {
      node: nodeToolchain,
      rust: rustToolchain,
      cargo: cargoToolchain,
      compiler: compilerToolchain,
      linker: linkerToolchain,
      pkgConfig: pkgConfigToolchain,
      systemLibraries: systemLibrariesToolchain,
    }, dependencies, settings, execution: spec.execution ?? {} };
  if (spec.embeddedRuntime) {
    const runtimePath = resolve(spec.embeddedRuntime);
    inputs.embeddedRuntime = {
      path: runtimePath,
      identity: digest(await readFile(runtimePath)),
    };
  }
  await validateBuildInputs(inputs);
  return inputs;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length) throw new Error("Expected observations.json new-build-inputs.json");
  await writeFile(output, JSON.stringify(await createBuildInputs(JSON.parse(await readFile(input, "utf8"))), null, 2) + "\n", { flag: "wx" });
}

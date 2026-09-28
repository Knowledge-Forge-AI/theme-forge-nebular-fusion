// Materialize authority from explicit producer observations, never Git or PATH.
import { readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { COMPONENTS, TOOLCHAINS, validateBuildInputs, verifySourceTree } from "./build-inputs.mjs";
import { digest, inventoryTree, seal, sourceResourcePlans } from "./candidate-provenance.mjs";
import { createBuildSettings } from "./build-settings.mjs";

export async function createBuildInputs(spec) {
  if (spec.schema !== "nebular-build-observations-v1") throw new Error("Explicit build observations required");
  const components = {}, componentSources = {};
  for (const name of COMPONENTS) {
    const observed = spec.components[name];
    const pkg = JSON.parse(await readFile(join(observed.root, "package.json"), "utf8"));
    componentSources[name] = (await inventoryTree(observed.sourceRoot)).identity;
    components[name] = { root: observed.root, sourceRoot: observed.sourceRoot, source: componentSources[name], target: spec.target,
      version: pkg.version, output: (await inventoryTree(observed.root)).identity, producer: observed.producer };
  }
  const toolchains = {};
  for (const name of TOOLCHAINS) {
    const path = spec.toolchains[name];
    toolchains[name] = { path, identity: (await stat(path)).isDirectory()
      ? (await inventoryTree(path)).identity : digest(await readFile(path)) };
  }
  if (!spec.toolchains.npm) throw new Error("Explicit npm CLI input required");
  toolchains.node.npm = { path: spec.toolchains.npm, identity: digest(await readFile(spec.toolchains.npm)) };
  const source = spec.source ?? seal("nebular-source-candidate-v1", {
    version: JSON.parse(await readFile(join(spec.sourceRoot, "package.json"), "utf8")).version,
    composition: (await inventoryTree(spec.sourceRoot)).identity,
    locks: { cargo: digest(await readFile(join(spec.sourceRoot, "src-tauri/Cargo.lock"))), frontend: digest(await readFile(join(spec.sourceRoot, "package-lock.json"))) },
    components: componentSources, recipe: (await inventoryTree(join(spec.sourceRoot, "tools"))).identity,
    resourcePlans: sourceResourcePlans(JSON.parse(await readFile(join(spec.sourceRoot, "src-tauri/tauri.conf.json"), "utf8"))),
  });
  await verifySourceTree(spec.sourceRoot, source);
  const dependencies = {};
  for (const key of ["frontendModules", "previewModules"]) {
    if (spec.execution?.[key]) dependencies[key] = (await inventoryTree(spec.execution[key])).identity;
  }
  const settings = await createBuildSettings({
    cargoConfig: spec.execution?.cargoConfig,
    environment: spec.execution?.environment ?? {},
  });
  const inputs = { schema: "nebular-build-inputs-v1", sourceRoot: spec.sourceRoot, source,
    target: spec.target, mode: spec.mode, components, toolchains, dependencies, settings, execution: spec.execution ?? {} };
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

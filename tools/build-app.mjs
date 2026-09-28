import { spawnSync } from "node:child_process";
import { readFileSync, cpSync, mkdirSync, existsSync, chmodSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanShippedPaths } from "./scan-shipped-paths.mjs";
import { prepareAppResources } from "./prepare-app-resources.mjs";
import { verifyApplicationVersion } from "./candidate-version.mjs";
import { nativeLauncher } from "./native-launcher.mjs";
import { targetForHost, APPLICATION_NAME, resourceDirectories, resourcePreparationPlan, tauriRustTargetPlan } from "./platform-targets.mjs";
import { loadBuildInputs, sourceBuildPathPolicy, sourcePathRemapFlags } from "./build-inputs.mjs";
import { finalizeDarwinAppBundle } from "./finalize-darwin-bundle.mjs";

if (process.argv.length !== 2) throw new Error("This command builds the default-feature application without extra arguments");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productTarget = targetForHost();
const sourceAuthority = process.env.NEBULAR_BUILD_INPUTS ? await loadBuildInputs(process.env.NEBULAR_BUILD_INPUTS) : null;
if (process.env.NEBULAR_BUILD_MODE && !sourceAuthority) throw new Error("Source build requires structured build inputs");
if (sourceAuthority && sourceAuthority.target.triple !== productTarget.triple) throw new Error("Source build target mismatch");
verifyApplicationVersion(root);
const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit", timeout: 1_800_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Application build step failed");
};
const rustProgram = sourceAuthority ? sourceAuthority.tools.rust : "rustc";
for (const [tool, version] of [["rustc", "1.98.0"], ["cargo", "1.98.0"]]) {
  const program = sourceAuthority ? sourceAuthority.tools[tool === "rustc" ? "rust" : "cargo"] : tool;
  const result = spawnSync(program, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0 || !result.stdout.startsWith(`${tool} ${version} `)) {
    throw new Error(`Enter the locked product-local environment: ${tool} ${version} is required`);
  }
}
const rustcVerbose = sourceAuthority
  ? spawnSync(rustProgram, ["-vV"], { encoding: "utf8", timeout: 10_000 })
  : null;
if (rustcVerbose && (rustcVerbose.error || rustcVerbose.status !== 0)) {
  throw new Error("Bound Rust compiler host identity could not be inspected");
}
const rustTargetPlan = tauriRustTargetPlan({
  sourceMode: sourceAuthority?.inputs.mode ?? null,
  productTriple: productTarget.triple,
  rustcVerbose: rustcVerbose?.stdout ?? "",
});
if (process.env.RUSTFLAGS && !process.env.CARGO_ENCODED_RUSTFLAGS) {
  throw new Error("Use CARGO_ENCODED_RUSTFLAGS for additional application build flags");
}
const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, "src-tauri/target");
const flags = (process.env.CARGO_ENCODED_RUSTFLAGS ?? "").split("\u001f").filter(Boolean);
const defaultRemaps = [
  [homedir(), "/build-user"],
  [process.env.CARGO_HOME ? resolve(process.env.CARGO_HOME) : join(homedir(), ".cargo"), "/cargo-home"],
  [root, "/nebular-source"],
  [target, "/nebular-target"],
];
const pathPolicy = sourceAuthority ? await sourceBuildPathPolicy(sourceAuthority.inputs) : null;
if (pathPolicy) flags.push(...sourcePathRemapFlags(pathPolicy,
  defaultRemaps.map(([path, replacement]) => ({ path, replacement }))));
else for (const [source, replacement] of defaultRemaps) flags.push(`--remap-path-prefix=${source}=${replacement}`);
const forbiddenPaths = [homedir(), root, target, process.env.CARGO_HOME,
  ...(pathPolicy?.forbiddenPrefixes ?? [])].filter(Boolean);
const tauriCargoTargetDir = rustTargetPlan.nestedCargoTargetDir
  ? join(target, productTarget.triple)
  : target;
const env = {
  ...process.env,
  CARGO_TARGET_DIR: tauriCargoTargetDir,
  CARGO_ENCODED_RUSTFLAGS: flags.join("\u001f"),
  CARGO_NET_OFFLINE: "true",
  npm_config_offline: "true",
};
const config = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
resourcePreparationPlan(config, productTarget);
await prepareAppResources({ studioRoot: root, ...(sourceAuthority ? { buildInputs: sourceAuthority.inputs } : {}) });
const sidecarManifest = JSON.parse(readFileSync(join(root, "src-tauri/sidecar-payload/manifest.json"), "utf8"));
if (sidecarManifest.target !== productTarget.triple) {
  throw new Error(`Prepared sidecar target does not match ${productTarget.triple}`);
}
run(process.execPath, [join(root, "tools/sidecar-verify.mjs"),
  ...(sourceAuthority ? ["--mode", sourceAuthority.inputs.mode, "--build-inputs", process.env.NEBULAR_BUILD_INPUTS] : [])], env);
run(process.execPath, [join(root, "node_modules/@tauri-apps/cli/tauri.js"), "build", "--ci",
  ...(sourceAuthority ? ["--config", JSON.stringify({ build: { beforeBuildCommand: "node tools/source-frontend-build.mjs" } })] : []),
  ...(productTarget.os === "darwin" ? ["--bundles", "app"] : ["--no-bundle"]),
  ...rustTargetPlan.tauriArgs, "--", "--locked", "--offline"], env);

const release = join(target, productTarget.triple, "release");
const app = join(release, "bundle/macos", config.productName + ".app");
const executable = productTarget.os === "darwin" ? join(app, "Contents/MacOS", APPLICATION_NAME) : join(release, APPLICATION_NAME);
const bytes = readFileSync(executable);
for (const path of forbiddenPaths) {
  if (bytes.includes(Buffer.from(path))) throw new Error("Application executable retains a local build path");
}
// A linker ad-hoc signature does not seal an application's resource envelope.
// Seal only the outer developer bundle; authenticated nested runtimes retain their bytes.
if (productTarget.os === "darwin") {
  const licensePath = existsSync(join(root, "LICENSE"))
    ? join(root, "LICENSE")
    : join(root, "../../LICENSE");
  const noticePath = existsSync(join(root, "NOTICE"))
    ? join(root, "NOTICE")
    : join(root, "../../NOTICE");
  await finalizeDarwinAppBundle({
    app,
    productTarget,
    studioRoot: root,
    licensePath,
    noticePath,
    runner: run,
  });
} else {
  // Product platform::resource_dir resolves ../lib/<APPLICATION_NAME> from the canonical executable.
  // Keep raw installation independent of optional AppImage/deb/rpm bundling.
  const output = join(release, "bundle/raw");
  if (existsSync(output)) throw new Error("Raw output already exists; select a fresh CARGO_TARGET_DIR");
  const resources = join(output, "lib", APPLICATION_NAME);
  mkdirSync(join(output, "bin"), { recursive: true });
  mkdirSync(resources, { recursive: true });
  cpSync(executable, join(output, "bin", APPLICATION_NAME));
  cpSync(join(root, "src-tauri/binaries", `tfsb-studio-service-${productTarget.triple}`), join(output, "bin/tfsb-studio-service"));
  for (const resource of resourceDirectories(config)) {
    cpSync(join(root, "src-tauri", resource), join(resources, resource), { recursive: true, errorOnExist: true, force: false });
  }
  writeFileSync(join(output, "bin/tfnf"), nativeLauncher(productTarget));
  chmodSync(join(output, "bin/tfnf"), 0o755);
}
await scanShippedPaths(productTarget.os === "darwin" ? app : join(release, "bundle/raw"), forbiddenPaths,
  { preserveSpellings: Boolean(pathPolicy) });
console.log(`Default-feature ${productTarget.system} app built; local build-path checks passed`);

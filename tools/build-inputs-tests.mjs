import test from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, cp, rm, readFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInputClaims, validateBuildInputs, verifySourceTree, TOOLCHAINS, COMPONENTS, sourceBuildPathPolicy, sourcePathRemapFlags } from "./build-inputs.mjs";
import { digest, identity, inventoryTree, seal, sourceResourcePlans } from "./candidate-provenance.mjs";
import { TARGETS, CANDIDATE_VERSION } from "./platform-targets.mjs";
import { parseNativeBuildArgs, buildNativeCandidate, inspectAncestorCargoConfigs } from "./native-candidate-build.mjs";
import { verifyProducedOutput } from "./verify-produced-output.mjs";
import { runOwnedBuild } from "./owned-build-process.mjs";
import { produceBuildReceipt } from "./build-receipt.mjs";
import { createBuildSettings, normalizeCargoConfig, validateBuildSettings, buildSettingsClaims, inventoryPath, inventoryLocator } from "./build-settings.mjs";
import { createBuildInputs } from "./create-build-inputs.mjs";

const h = digest("fixture");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nebular-authority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const sourceRoot = join(root, "source");
  await mkdir(join(sourceRoot, "src-tauri"), { recursive: true });
  await writeFile(join(sourceRoot, "src-tauri/Cargo.lock"), "cargo");
  await writeFile(join(sourceRoot, "package-lock.json"), "frontend");
  const source = seal("nebular-source-candidate-v1", { version: CANDIDATE_VERSION,
    composition: (await inventoryTree(sourceRoot)).identity,
    locks: { cargo: digest("cargo"), frontend: digest("frontend") },
    components: { burst: h, loom: h, solar: h }, recipe: h, resourcePlans: sourceResourcePlans(config) });
  const components = {};
  for (const [name, product] of [["burst", "stellar-burst"], ["loom", "stellar-loom"], ["solar", "solar-sail"]]) {
    const path = join(root, name); await mkdir(path);
    await writeFile(join(path, "package.json"), JSON.stringify({ name: `@knowledge-forge-ai/theme-forge-${product}`, version: CANDIDATE_VERSION }));
    components[name] = { root: path, version: CANDIDATE_VERSION, source: h, target: TARGETS[0].triple, producer: h, output: (await inventoryTree(path)).identity };
  }
  const toolchains = {};
  for (const name of TOOLCHAINS) {
    const path = join(root, name);
    if (name === "systemLibraries") { await mkdir(path); toolchains[name] = { path, identity: (await inventoryTree(path)).identity }; }
    else { await writeFile(path, name); toolchains[name] = { path, identity: digest(name) }; }
  }
  const settings = await createBuildSettings({});
  return { root, inputs: { schema: "nebular-build-inputs-v1", sourceRoot, source, target: TARGETS[0].triple,
    mode: "portable-source", components, toolchains, settings } };
}

test("explicit component authority validates actual bytes and is stable after relocation", async t => {
  const { root, inputs } = await fixture(t);
  const first = await validateBuildInputs(inputs);
  const moved = structuredClone(inputs);
  for (const name of Object.keys(moved.components)) {
    moved.components[name].root = join(root, `moved-${name}`);
    await cp(inputs.components[name].root, moved.components[name].root, { recursive: true });
  }
  assert.equal((await validateBuildInputs(moved)).identity, first.identity);
  await writeFile(join(moved.components.loom.root, "injected.js"), "changed");
  await assert.rejects(validateBuildInputs(moved), /loom output inventory mismatch/);
});

test("missing, mixed-source and mixed-target component inputs fail closed", async t => {
  const { inputs } = await fixture(t);
  for (const name of ["burst", "loom", "solar"]) {
    const missing = structuredClone(inputs); delete missing.components[name];
    assert.throws(() => buildInputClaims(missing), /source, target or producer mismatch/);
    const mixed = structuredClone(inputs); mixed.components[name].source = digest("another candidate");
    await assert.rejects(validateBuildInputs(mixed), /source, target or producer mismatch/);
    const target = structuredClone(inputs); target.components[name].target = TARGETS[1].triple;
    await assert.rejects(validateBuildInputs(target), /source, target or producer mismatch/);
  }
});

test("Git-free source validation rejects mutation and generated preseed", async t => {
  const { inputs } = await fixture(t);
  await verifySourceTree(inputs.sourceRoot, inputs.source);
  await writeFile(join(inputs.sourceRoot, "package-lock.json"), "drift");
  await assert.rejects(verifySourceTree(inputs.sourceRoot, inputs.source), /composition mismatch/);
  await mkdir(join(inputs.sourceRoot, ".git"));
  await writeFile(join(inputs.sourceRoot, ".git/config"), "forbidden");
  await assert.rejects(verifySourceTree(inputs.sourceRoot, inputs.source), /generated or private/);
});

test("toolchain substitution fails before preparation", async t => {
  const { inputs } = await fixture(t);
  await writeFile(inputs.toolchains.node.path, "different binary");
  await assert.rejects(validateBuildInputs(inputs), /node toolchain bytes mismatch/);
});

test("native command requires all arguments and matching native target before staging", async t => {
  assert.throws(() => parseNativeBuildArgs(["--target", "darwin-arm64"]), /Missing/);
  assert.throws(() => parseNativeBuildArgs(["--target", "x", "--target", "y"]), /exactly once/);
  const { root, inputs } = await fixture(t);
  const path = join(root, "inputs.json"); await writeFile(path, JSON.stringify(inputs));
  await assert.rejects(buildNativeCandidate({ target: "linux-x64", buildInputs: path, output: join(root, "candidate") }), /target must match/);
});

test("receipt producer inventories output, preparation and component authority", async t => {
  // Synthetic native header is a unit fixture, not application-build evidence.
  const { root, inputs } = await fixture(t);
  const studioRoot = join(root, "stage"), payloadRoot = join(root, "payload"), output = join(root, "receipt");
  await mkdir(output);
  const plan = inputs.source.resourcePlans[inputs.target];
  for (const path of plan.resources) {
    await mkdir(join(studioRoot, "src-tauri", path), { recursive: true });
    await writeFile(join(studioRoot, "src-tauri", path, "resource"), path);
    await mkdir(join(payloadRoot, "Theme Forge Nebular Fusion.app/Contents/Resources", path), { recursive: true });
    await writeFile(join(payloadRoot, "Theme Forge Nebular Fusion.app/Contents/Resources", path, "resource"), path);
  }
  await mkdir(join(studioRoot, "src-tauri/binaries"));
  await writeFile(join(studioRoot, "src-tauri", `${plan.externalBin[0]}-${inputs.target}`), "runtime");
  const bin = join(payloadRoot, "Theme Forge Nebular Fusion.app/Contents/MacOS");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "tfsb-studio-service"), "runtime");
  const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x0100000c, 4);
  await writeFile(join(bin, "theme-forge-nebular-fusion"), bytes, { mode: 0o755 });
  inputs.mode = "nix-source";
  const produced = await produceBuildReceipt({ inputs, studioRoot, payloadRoot, output });
  assert.equal(produced.receipt.nativePayload, (await inventoryTree(payloadRoot)).identity);
  assert.equal(produced.provenance.receipt.identity, produced.receipt.identity);
  assert.equal(produced.receipt.preparation.identity, identity({ resources: produced.receipt.preparation.resources, externalBin: produced.receipt.preparation.externalBin }));
  assert.equal(produced.receipt.settings, (await validateBuildInputs(inputs)).claims.settings.identity);
  assert.ok(!JSON.stringify(produced).includes(root));
  const installed = join(root, "installed");
  await mkdir(join(installed, "share/nebular"), { recursive: true });
  await cp(output, join(installed, "share/nebular"), { recursive: true });
  await cp(payloadRoot, join(installed, "share/nebular/native"), { recursive: true });
  assert.equal((await verifyProducedOutput(installed, TARGETS[0].system)).buildReceipt, produced.receipt.identity);
  await assert.rejects(verifyProducedOutput(installed, TARGETS[1].system), /target or mode mismatch/);
  await writeFile(join(installed, "share/nebular/native/injected"), "drift");
  await assert.rejects(verifyProducedOutput(installed, TARGETS[0].system), /payload mismatch/);
  await writeFile(join(inputs.components.burst.root, "drift"), "changed");
  await assert.rejects(produceBuildReceipt({ inputs, studioRoot, payloadRoot, output }), /burst output inventory mismatch/);
});

test("produceBuildReceipt validates source-build-pins runtime matches externalBin", async t => {
  const { root, inputs } = await fixture(t);
  const studioRoot = join(root, "studio");
  const payloadRoot = join(root, "payload");
  const output = join(root, "output");
  await mkdir(studioRoot); await mkdir(payloadRoot); await mkdir(output);
  const plan = inputs.source.resourcePlans[inputs.target];
  for (const path of plan.resources) {
    await mkdir(join(studioRoot, "src-tauri", path), { recursive: true });
    await writeFile(join(studioRoot, "src-tauri", path, "resource"), path);
    await mkdir(join(payloadRoot, "Theme Forge Nebular Fusion.app/Contents/Resources", path), { recursive: true });
    await writeFile(join(payloadRoot, "Theme Forge Nebular Fusion.app/Contents/Resources", path, "resource"), path);
  }
  await mkdir(join(studioRoot, "src-tauri/binaries"));
  await writeFile(join(studioRoot, "src-tauri", `${plan.externalBin[0]}-${inputs.target}`), "runtime-bytes");
  const bin = join(payloadRoot, "Theme Forge Nebular Fusion.app/Contents/MacOS");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "tfsb-studio-service"), "runtime-bytes");
  const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x0100000c, 4);
  await writeFile(join(bin, "theme-forge-nebular-fusion"), bytes, { mode: 0o755 });
  inputs.mode = "nix-source";

  const runtimeSha = digest("runtime-bytes");
  const pinsPath = join(studioRoot, "src-tauri/source-build-pins.json");

  // Valid pins match externalBin
  await writeFile(pinsPath, JSON.stringify({
    sidecarManifest: { runtime: { sha256: runtimeSha, size: 13 } },
    scene: { node: { sha256: runtimeSha, bytes: 13 } },
    loom: { node: { sha256: runtimeSha, bytes: 13 } },
  }));
  const validProduced = await produceBuildReceipt({ inputs, studioRoot, payloadRoot, output });
  assert.ok(validProduced.receipt);

  // Divergent scene.node rejects
  await writeFile(pinsPath, JSON.stringify({
    sidecarManifest: { runtime: { sha256: runtimeSha, size: 13 } },
    scene: { node: { sha256: "divergent-scene-sha", bytes: 13 } },
    loom: { node: { sha256: runtimeSha, bytes: 13 } },
  }));
  const output2 = join(root, "output2"); await mkdir(output2);
  await assert.rejects(
    produceBuildReceipt({ inputs, studioRoot, payloadRoot, output: output2 }),
    /Source-build scene node pin does not match shipped externalBin/
  );

  // Divergent loom.node rejects
  await writeFile(pinsPath, JSON.stringify({
    sidecarManifest: { runtime: { sha256: runtimeSha, size: 13 } },
    scene: { node: { sha256: runtimeSha, bytes: 13 } },
    loom: { node: { sha256: "divergent-loom-sha", bytes: 13 } },
  }));
  const output3 = join(root, "output3"); await mkdir(output3);
  await assert.rejects(
    produceBuildReceipt({ inputs, studioRoot, payloadRoot, output: output3 }),
    /Source-build loom node pin does not match shipped externalBin/
  );
});


test("copied frontend dependency bytes are bound and substitution fails", async t => {
  const { root, inputs } = await fixture(t);
  const npm = join(root, "npm.js"); await writeFile(npm, "npm");
  inputs.toolchains.node.npm = { path: npm, identity: digest("npm") };
  const modules = join(root, "modules"); await mkdir(modules);
  await writeFile(join(modules, "dependency.js"), "qualified");
  inputs.execution = { frontendModules: modules };
  await assert.rejects(validateBuildInputs(inputs), /dependency inventory mismatch/);
  inputs.dependencies = { frontendModules: (await inventoryTree(modules)).identity };
  const before = (await validateBuildInputs(inputs)).identity;
  await writeFile(join(modules, "dependency.js"), "substituted");
  await assert.rejects(validateBuildInputs(inputs), /dependency inventory mismatch/);
  inputs.dependencies.frontendModules = (await inventoryTree(modules)).identity;
  assert.notEqual((await validateBuildInputs(inputs)).identity, before);
});


test("owned build command rejects failure and terminates timeout", async () => {
  const options = { cwd: process.cwd(), env: {}, stdio: "ignore" };
  await runOwnedBuild(process.execPath, ["-e", "process.exit(0)"], options);
  await assert.rejects(runOwnedBuild(process.execPath, ["-e", "process.exit(3)"], options), /no production receipt/);
  await assert.rejects(runOwnedBuild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { ...options, timeout: 50 }), /no production receipt/);
});

test("Cargo config relocation is stable and content/internal locator mutation fails", async t => {
  const { root, inputs } = await fixture(t);
  const vendorDir = join(root, "vendor");
  await mkdir(vendorDir);
  await writeFile(join(vendorDir, "dep.rs"), "pub fn hello() {}");
  const configPath = join(root, "config.toml");
  const tomlContent = `
# Comment should be stripped
[source.crates-io]
replace-with = "vendor"

[source.vendor]
directory = "${vendorDir}"
`;
  await writeFile(configPath, tomlContent);
  inputs.execution = { cargoConfig: configPath };
  inputs.settings = await createBuildSettings({ cargoConfig: configPath });
  const validated = await validateBuildInputs(inputs);
  const initialIdentity = validated.identity;

  // Relocate config file to a new path with identical bytes
  const movedConfigPath = join(root, "moved-config.toml");
  await cp(configPath, movedConfigPath);
  inputs.execution.cargoConfig = movedConfigPath;
  const relocated = await validateBuildInputs(inputs);
  assert.equal(relocated.identity, initialIdentity);

  // Semantic mutation in Cargo config changes content and fails validation
  await writeFile(movedConfigPath, tomlContent + "\n[build]\nrustflags = ['-O']\n");
  await assert.rejects(validateBuildInputs(inputs), /Cargo config content mismatch/);

  // Restore config, but mutate internal locator files -> fails validation
  await cp(configPath, movedConfigPath);
  await writeFile(join(vendorDir, "dep.rs"), "pub fn mutated() {}");
  await assert.rejects(validateBuildInputs(inputs), /Internal locator bytes mismatch/);
});

test("environment semantic compile settings mutation changes identity and rejects drift", async t => {
  const { root, inputs } = await fixture(t);
  const env1 = {
    MACOSX_DEPLOYMENT_TARGET: "13.0",
    NIX_CFLAGS_COMPILE: "-O2",
  };
  inputs.execution = { environment: env1 };
  inputs.settings = await createBuildSettings({ environment: env1 });
  await validateBuildInputs(inputs);

  // Re-creating settings with different semantic compile values produces different identity
  const env2 = {
    MACOSX_DEPLOYMENT_TARGET: "14.0",
    NIX_CFLAGS_COMPILE: "-O2",
  };
  const mutatedSettings = await createBuildSettings({ environment: env2 });
  assert.notEqual(mutatedSettings.identity, inputs.settings.identity);

  // Runtime environment drift rejects mismatch
  inputs.execution.environment.MACOSX_DEPLOYMENT_TARGET = "14.0";
  await assert.rejects(validateBuildInputs(inputs), /MACOSX_DEPLOYMENT_TARGET semantic setting mismatch/);
});

test("validated locator relocation is stable and locator substitution fails", async t => {
  const { root, inputs } = await fixture(t);
  const sdkDir = join(root, "sdk");
  await mkdir(sdkDir);
  await writeFile(join(sdkDir, "sdk.h"), "#define SDK 1");
  const pkgDir = join(root, "pkg-config-test");
  await mkdir(pkgDir);
  await writeFile(join(pkgDir, "test.pc"), "Name: test");

  const env = {
    SDKROOT: sdkDir,
    PKG_CONFIG_PATH: pkgDir,
  };
  inputs.execution = { environment: env };
  inputs.settings = await createBuildSettings({ environment: env });
  const initial = await validateBuildInputs(inputs);

  // Relocate SDK and PKG_CONFIG_PATH to new directories with identical contents
  const movedSdk = join(root, "moved-sdk");
  await cp(sdkDir, movedSdk, { recursive: true });
  const movedPkg = join(root, "moved-pkg-config-test");
  await cp(pkgDir, movedPkg, { recursive: true });
  inputs.execution.environment = {
    SDKROOT: movedSdk,
    PKG_CONFIG_PATH: movedPkg,
  };
  const relocated = await validateBuildInputs(inputs);
  assert.equal(relocated.identity, initial.identity);

  // Substitute/tamper file in SDKROOT -> fails validation
  await writeFile(join(movedSdk, "sdk.h"), "#define SDK 2");
  await assert.rejects(validateBuildInputs(inputs), /SDKROOT locator bytes mismatch/);

  // Restore SDK, tamper PKG_CONFIG_PATH -> fails validation
  await writeFile(join(movedSdk, "sdk.h"), "#define SDK 1");
  await writeFile(join(movedPkg, "test.pc"), "Name: tampered");
  await assert.rejects(validateBuildInputs(inputs), /PKG_CONFIG_PATH locator bytes mismatch/);
});

test("unknown environment setting fails and execution-only settings are excluded from canonical identity", async t => {
  const { root, inputs } = await fixture(t);
  // Unknown environment setting fails
  const badEnv = { UNKNOWN_UNREGISTERED_VAR: "danger" };
  await assert.rejects(createBuildSettings({ environment: badEnv }), /Unknown build environment setting/);
  inputs.execution = { environment: badEnv };
  await assert.rejects(validateBuildInputs(inputs), /Unknown build environment setting/);

  // Execution-only settings (NIX_BUILD_TOP, NIX_STORE) have justifications and don't pollute identity
  const top1 = join(root, "nix-build-temp-1");
  await mkdir(top1);
  const settings1 = await createBuildSettings({
    environment: { NIX_BUILD_TOP: top1, NIX_STORE: "/nix/store" },
  });
  assert.ok(settings1.environment.executionOnly.NIX_BUILD_TOP.reason);
  assert.ok(settings1.environment.executionOnly.NIX_STORE.reason);

  const top2 = join(root, "nix-build-temp-2");
  await mkdir(top2);
  const settings2 = await createBuildSettings({
    environment: { NIX_BUILD_TOP: top2, NIX_STORE: "/nix/store" },
  });
  // Different temp directories must produce identical settings identity
  assert.equal(settings1.identity, settings2.identity);
  assert.ok(!JSON.stringify(settings1.claims).includes(top1));
});

test("source-tree and copied cargoHome configurations cannot bypass binding", async t => {
  const { root, inputs } = await fixture(t);
  // Source-tree .cargo config is forbidden
  await mkdir(join(inputs.sourceRoot, ".cargo"));
  await writeFile(join(inputs.sourceRoot, ".cargo/config.toml"), "unbound = true");
  await assert.rejects(verifySourceTree(inputs.sourceRoot, inputs.source), /source contains generated or private inputs/);
  await rm(join(inputs.sourceRoot, ".cargo"), { recursive: true });

  // Unbound config in cargoHome is rejected
  const cargoHome = join(root, "ambient-cargo-home");
  await mkdir(cargoHome);
  await writeFile(join(cargoHome, "config.toml"), "unbound = true");
  inputs.execution = { cargoHome };
  inputs.settings = await createBuildSettings({});
  await assert.rejects(validateBuildInputs(inputs), /Unbound cargo configuration in cargoHome/);

  // Missing settings fails closed
  const missingSettings = structuredClone(inputs);
  delete missingSettings.settings;
  await assert.rejects(validateBuildInputs(missingSettings), /explicit build settings required/);

  // Mismatched config in cargoHome is rejected
  const officialConfig = join(root, "official-config.toml");
  await writeFile(officialConfig, "[build]\njobs = 4\n");
  inputs.execution = { cargoHome, cargoConfig: officialConfig };
  inputs.settings = await createBuildSettings({ cargoConfig: officialConfig });
  await assert.rejects(validateBuildInputs(inputs), /cargoHome configuration bypasses bound settings/);

  // Identical config in cargoHome is accepted
  await writeFile(join(cargoHome, "config.toml"), "[build]\njobs = 4\n");
  await validateBuildInputs(inputs);
});

test("explicit build settings are required and undefined settings fail closed", async t => {
  await assert.rejects(validateBuildSettings(undefined, {}), /Explicit build settings required/);
  await assert.rejects(validateBuildSettings(null, {}), /Explicit build settings required/);
  assert.throws(() => buildInputClaims({ schema: "wrong-schema" }), /unsupported authority schema/);
  const { inputs } = await fixture(t);
  const bad = structuredClone(inputs);
  delete bad.settings;
  assert.throws(() => buildInputClaims(bad), /explicit build settings required/);
  await assert.rejects(validateBuildInputs(bad), /explicit build settings required/);
});

test("cargoConfig parity fails closed when settings.cargo exists but execution.cargoConfig is missing or vice versa", async t => {
  const { root, inputs } = await fixture(t);
  const configPath = join(root, "parity-config.toml");
  await writeFile(configPath, "[build]\njobs = 2\n");
  inputs.settings = await createBuildSettings({ cargoConfig: configPath });
  inputs.execution = {};
  await assert.rejects(validateBuildInputs(inputs), /execution\.cargoConfig required when cargo settings are present/);

  inputs.settings = await createBuildSettings({});
  inputs.execution = { cargoConfig: configPath };
  await assert.rejects(validateBuildInputs(inputs), /execution\.cargoConfig cannot be provided when cargo settings are null/);
});

test("exact environment parity rejects extra or missing keys across semantic, locator, and execution-only categories", async t => {
  const { root, inputs } = await fixture(t);
  const sdkDir = join(root, "sdk-parity");
  await mkdir(sdkDir);
  await writeFile(join(sdkDir, "a.h"), "header");
  const topDir = join(root, "top-parity");
  await mkdir(topDir);
  const boundEnv = {
    MACOSX_DEPLOYMENT_TARGET: "13.0",
    SDKROOT: sdkDir,
    NIX_BUILD_TOP: topDir,
    NIX_STORE: "/nix/store",
  };
  inputs.settings = await createBuildSettings({ environment: boundEnv });
  inputs.execution = { environment: structuredClone(boundEnv) };
  await validateBuildInputs(inputs);

  // Extra semantic key in execution
  inputs.execution.environment.NIX_CFLAGS_COMPILE = "-O3";
  await assert.rejects(validateBuildInputs(inputs), /Execution environment has unbound semantic setting/);
  delete inputs.execution.environment.NIX_CFLAGS_COMPILE;

  // Missing semantic key in execution
  delete inputs.execution.environment.MACOSX_DEPLOYMENT_TARGET;
  await assert.rejects(validateBuildInputs(inputs), /Missing execution environment setting: MACOSX_DEPLOYMENT_TARGET/);
  inputs.execution.environment.MACOSX_DEPLOYMENT_TARGET = "13.0";

  // Extra locator key in execution
  const extraDir = join(root, "extra-dev-dir");
  await mkdir(extraDir);
  inputs.execution.environment.DEVELOPER_DIR = extraDir;
  await assert.rejects(validateBuildInputs(inputs), /Execution environment has unbound locator setting/);
  delete inputs.execution.environment.DEVELOPER_DIR;

  // Missing locator key in execution
  delete inputs.execution.environment.SDKROOT;
  await assert.rejects(validateBuildInputs(inputs), /Missing execution locator setting: SDKROOT/);
  inputs.execution.environment.SDKROOT = sdkDir;

  // Extra execution-only key in execution
  const extraTop = join(root, "extra-top");
  await mkdir(extraTop);
  const boundEnvNoTop = { MACOSX_DEPLOYMENT_TARGET: "13.0", SDKROOT: sdkDir };
  inputs.settings = await createBuildSettings({ environment: boundEnvNoTop });
  inputs.execution.environment = { ...boundEnvNoTop, NIX_BUILD_TOP: extraTop };
  await assert.rejects(validateBuildInputs(inputs), /Execution environment has unbound execution-only setting/);

  // Missing execution-only key in execution
  inputs.settings = await createBuildSettings({ environment: { ...boundEnvNoTop, NIX_BUILD_TOP: extraTop } });
  inputs.execution.environment = boundEnvNoTop;
  await assert.rejects(validateBuildInputs(inputs), /Missing execution environment setting: NIX_BUILD_TOP/);
});

test("arbitrary hidden keys in execution or settings are rejected and inconsistent settings.claims fails closed", async t => {
  const { inputs } = await fixture(t);
  inputs.execution = { arbitraryHiddenSetting: "hacked" };
  await assert.rejects(validateBuildInputs(inputs), /Unknown execution setting/);
  inputs.execution = {};

  const badSettings = { ...inputs.settings, unknownField: true };
  assert.throws(() => buildSettingsClaims(badSettings), /Unknown settings field/);

  const inconsistentSettings = {
    ...inputs.settings,
    claims: { cargo: null, environment: { semantic: { BOGUS: "1" }, locators: {} } },
  };
  assert.throws(() => buildSettingsClaims(inconsistentSettings), /Inconsistent settings\.claims/);
});

test("cargo config preserves exact content bytes and multiline strings while rejecting includes and relative paths", async () => {
  const multilineConfig = `
[source.crates-io]
replace-with = "vendor"

[source.vendor]
directory = "/nix/store/test-vendor"

[target.x86_64-apple-darwin]
rustflags = [
    "-C",
    "link-arg=-Wl,-rpath,/opt/lib",
]

[env]
MULTI = """
  first line indented
    second line more indented
"""
`;
  assert.equal(normalizeCargoConfig(multilineConfig), multilineConfig);

  // Include directive rejected
  assert.throws(() => normalizeCargoConfig('include = "extra.toml"\n'), /Cargo config include directive is unsupported/);

  // Relative path rejected
  assert.throws(() => normalizeCargoConfig('[source.v]\ndirectory = "vendor"\n'), /Unsupported relative path in Cargo config/);
  assert.throws(() => normalizeCargoConfig('[source.v]\ndirectory = "./vendor"\n'), /Unsupported relative path in Cargo config/);
  assert.throws(() => normalizeCargoConfig('[source.v]\npath = "../parent"\n'), /Unsupported relative path in Cargo config/);
});

test("locator referent bytes and modes are bound, backlinks are finite, and relative paths fail", async t => {
  const { root } = await fixture(t);
  const locDir = join(root, "locator-dir");
  await mkdir(locDir);
  const realFile = join(locDir, "target.txt");
  await writeFile(realFile, "content-v1");
  const linkFile = join(locDir, "symlink.txt");
  await symlink("target.txt", linkFile);

  const inv1 = await inventoryPath(locDir);

  // Mutating target file while link text is unchanged changes identity
  await writeFile(realFile, "content-v2-mutated");
  const inv2 = await inventoryPath(locDir);
  assert.notEqual(inv2.identity, inv1.identity);

  // Restoring content restores identity
  await writeFile(realFile, "content-v1");
  const inv3 = await inventoryPath(locDir);
  assert.equal(inv3.identity, inv1.identity);

  // Changing executable mode of referent file changes identity
  await chmod(realFile, 0o755);
  const inv4 = await inventoryPath(locDir);
  assert.notEqual(inv4.identity, inv1.identity);

  // Relative path for locator is rejected
  await assert.rejects(inventoryPath("relative/path"), /Locator path must be absolute/);
  await assert.rejects(inventoryLocator("relative/path"), /Locator path must be absolute/);
  await assert.rejects(inventoryLocator("/abs/one:relative/two", true), /Locator path must be absolute/);

  // SDK-style internal backlinks are bound without recursive expansion.
  const cycleDir = join(root, "cycle-dir");
  await mkdir(cycleDir);
  await symlink(cycleDir, join(cycleDir, "loop"));
  const cycleIdentity = (await inventoryPath(cycleDir)).identity;
  await writeFile(join(cycleDir, "header.h"), "new content");
  assert.notEqual((await inventoryPath(cycleDir)).identity, cycleIdentity);
});

test("native candidate builder inspects ancestor cargo configs and fails unbound configs before compile", async t => {
  const { root } = await fixture(t);
  const subDir = join(root, "sub", "project");
  await mkdir(subDir, { recursive: true });
  await mkdir(join(root, ".cargo"));
  const ancestorConfig = join(root, ".cargo/config.toml");
  await writeFile(ancestorConfig, "[build]\nrustflags = ['-Dwarnings']\n");

  // When settings.cargo is null, unbound ancestor fails
  await assert.rejects(inspectAncestorCargoConfigs([subDir], null), /Unbound cargo configuration in ancestor/);

  // When settings.cargo is present but different, fails
  const boundCargo = { identity: digest("different cargo config") };
  await assert.rejects(inspectAncestorCargoConfigs([subDir], boundCargo), /Unbound cargo configuration in ancestor/);

  // Even matching bytes would be merged twice (notably array flags).
  const matchingCargo = { identity: digest(await readFile(ancestorConfig)) };
  await assert.rejects(inspectAncestorCargoConfigs([subDir], matchingCargo), /duplicate merging/);
});

test("SDK directory aliases bind referents without mistaking shared content for cycles", async t => {
  const { root } = await fixture(t);
  const sdk = join(root, "sdk");
  await mkdir(join(sdk, "Versions/A/Headers"), { recursive: true });
  await writeFile(join(sdk, "Versions/A/Headers/header.h"), "header");
  await symlink("A", join(sdk, "Versions/Current"));
  await symlink("Versions/Current/Headers", join(sdk, "Headers"));
  const before = await inventoryPath(sdk);
  const moved = join(root, "relocated-sdk");
  await cp(sdk, moved, { recursive: true, verbatimSymlinks: true });
  assert.equal((await inventoryPath(moved)).identity, before.identity);
  await writeFile(join(moved, "Versions/A/Headers/header.h"), "different SDK");
  assert.notEqual((await inventoryPath(moved)).identity, before.identity);
});

test("staged Cargo content and every internal locator must match the bound record", async t => {
  const { root } = await fixture(t);
  const vendor = join(root, "vendor"); await mkdir(vendor);
  const cargoConfig = join(root, "config.toml");
  await writeFile(cargoConfig, `[source.vendor]\ndirectory = "${vendor}"\n`);
  const settings = await createBuildSettings({ cargoConfig });
  const content = structuredClone(settings);
  content.cargo.content += "[build]\nrustflags = ['-Copt-level=0']\n";
  await assert.rejects(validateBuildSettings(content, { cargoConfig }), /staged content identity/);
  const incomplete = structuredClone(settings); incomplete.cargo.locators = [];
  assert.throws(() => buildSettingsClaims(incomplete), /locator coverage/);
});

test("unknown prototype-named environment fields are not execution-only authority", async () => {
  await assert.rejects(createBuildSettings({ environment: { constructor: "unexpected" } }), /Unknown build environment setting/);
  assert.throws(() => normalizeCargoConfig('"inclu\\u0064e" = "other.toml"'), /Escaped Cargo config keys/);
});

test("NIX_STORE rejects arbitrary paths and NIX_BUILD_TOP requires existing absolute directory", async () => {
  await assert.rejects(createBuildSettings({ environment: { NIX_STORE: "/custom/fake/store" } }), /NIX_STORE must be fixed \/nix\/store/);
  await assert.rejects(createBuildSettings({ environment: { NIX_BUILD_TOP: "relative/path" } }), /NIX_BUILD_TOP must be an absolute path/);
  await assert.rejects(createBuildSettings({ environment: { NIX_BUILD_TOP: "/nonexistent/path/for/build/top" } }), /ENOENT/);
});

test("createBuildInputs generates valid build inputs with explicit settings from observations", async t => {
  const { root, inputs } = await fixture(t);
  const npm = join(root, "npm-cli");
  await writeFile(npm, "npm");
  const compSource = join(root, "comp-source");
  await mkdir(compSource);
  await writeFile(join(compSource, "file"), "comp");
  const compIdentity = (await inventoryTree(compSource)).identity;

  const { identity: _id, schema, ...body } = inputs.source;
  body.components = Object.fromEntries(COMPONENTS.map(name => [name, compIdentity]));
  const source = seal(schema, body);

  const spec = {
    schema: "nebular-build-observations-v1",
    sourceRoot: inputs.sourceRoot,
    target: inputs.target,
    mode: inputs.mode,
    source,
    components: Object.fromEntries(COMPONENTS.map(name => [name, {
      root: inputs.components[name].root,
      sourceRoot: compSource,
      producer: h,
    }])),
    toolchains: {
      ...Object.fromEntries(TOOLCHAINS.map(name => [name, inputs.toolchains[name].path])),
      npm,
    },
    execution: {
      environment: {},
    },
  };
  const created = await createBuildInputs(spec);
  assert.ok(created.settings);
  assert.equal(created.schema, "nebular-build-inputs-v1");
  await validateBuildInputs(created);
});


test("authenticated Cargo paths are remapped and scanned independently of staging layout", async t => {
  const { root, inputs } = await fixture(t);
  const vendor = join(root, "external", "vendor");
  const nested = join(vendor, "nested");
  const sibling = join(root, "external", "vendor-other");
  await mkdir(nested, { recursive: true });
  await mkdir(sibling);
  const source = 'fn main() { println!("{}", file!()); }';
  await writeFile(join(nested, "main.rs"), source);
  await writeFile(join(sibling, "main.rs"), source);
  const alias = join(root, "vendor-alias");
  await symlink(vendor, alias);
  const cargoConfig = join(root, "config.toml");
  await writeFile(cargoConfig, `[source.vendor]\ndirectory = "${vendor}"\n[source.nested]\ndirectory = "${nested}"\n[source.alias]\ndirectory = "${alias}"\n`);
  inputs.settings = await createBuildSettings({ cargoConfig });
  inputs.execution = { cargoConfig };
  const policy = await sourceBuildPathPolicy(inputs);
  const flags = sourcePathRemapFlags(policy);
  const { scanShippedPaths } = await import("./scan-shipped-paths.mjs");
  const payload = join(root, "payload"); await mkdir(payload);
  const executable = join(payload, "app");
  function compile(path, args) {
    const result = spawnSync(process.env.RUSTC || "rustc", [path, "-o", executable, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  }
  compile(join(nested, "main.rs"), []);
  assert.ok((await readFile(executable)).includes(Buffer.from(vendor)));
  const fixedPrefixes = ["/nix/store", "/synthetic-fixed-build-root"];
  for (const prefix of fixedPrefixes) assert.ok(!vendor.startsWith(prefix));
  await scanShippedPaths(payload, fixedPrefixes);
  await assert.rejects(scanShippedPaths(payload, policy.forbiddenPrefixes), /known build-path/);
  compile(join(nested, "main.rs"), [`--remap-path-prefix=${vendor}=/untrusted`, ...flags]);
  assert.equal((await readFile(executable)).includes(Buffer.from(vendor)), false);
  const printed = spawnSync(executable, [], { encoding: "utf8" });
  const nestedId = inputs.settings.cargo.locators.find(x => x.path === nested).identity;
  assert.equal(printed.stdout.trim(), `/cargo-input/${nestedId}/main.rs`);
  await scanShippedPaths(payload, policy.forbiddenPrefixes);
  compile(join(sibling, "main.rs"), flags);
  assert.equal(spawnSync(executable, [], { encoding: "utf8" }).stdout.trim(), join(sibling, "main.rs"));
  compile(join(alias, "nested/main.rs"), flags);
  assert.equal((await readFile(executable)).includes(Buffer.from(alias)), false);
  await scanShippedPaths(payload, policy.forbiddenPrefixes);
  for (const member of ["resources", "sidecars", "Scene", "Loom", "Solar", "metadata", "launcher", "nested/member"]) {
    const file = join(payload, member); await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, vendor);
    await assert.rejects(scanShippedPaths(payload, policy.forbiddenPrefixes), /known build-path/);
    await rm(file);
  }
  const moved = join(root, "unrelated-location");
  await cp(vendor, moved, { recursive: true });
  await writeFile(cargoConfig, `[source.vendor]\ndirectory = "${moved}"\n`);
  inputs.settings = await createBuildSettings({ cargoConfig });
  const relocated = await sourceBuildPathPolicy(inputs);
  assert.equal(relocated.cargoRemaps[0].replacement, policy.cargoRemaps.find(x => x.path === vendor).replacement);
  compile(join(moved, "nested/main.rs"), sourcePathRemapFlags(relocated));
  assert.equal((await readFile(executable)).includes(Buffer.from(moved)), false);
  await scanShippedPaths(payload, relocated.forbiddenPrefixes);
  await writeFile(join(moved, "main.rs"), "tampered");
  await assert.rejects(sourceBuildPathPolicy(inputs), /Internal locator bytes mismatch/);
  inputs.settings.cargo.locators.push({ path: sibling, identity: nestedId });
  await assert.rejects(sourceBuildPathPolicy(inputs), /coverage mismatch/);
});

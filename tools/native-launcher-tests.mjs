import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, link, rm, realpath, readFile, lstat, readlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { nativeLauncher } from "./native-launcher.mjs";
import { selectedSourceExecutable, runSourceLauncher } from "./source-launcher.mjs";
import { TARGETS, CANDIDATE_VERSION, APPLICATION_NAME, payloadLayout } from "./platform-targets.mjs";
import { digest, identity, inventoryTree } from "./candidate-provenance.mjs";
import {
  PRIVATE_RUNTIME_PREFIX,
  PRIVATE_RUNTIME_MARKER,
  REQUIRED_RUNTIME_DIRECTORIES,
  REQUIRED_EXECUTABLE_RUNTIME_ROLES,
  REQUIRED_RUNTIME_ROLES,
  externalFloorForTarget,
  computeMaterialDigest,
  validateRuntimeMaterial,
  authenticateNativeRuntimeInput,
  verifyRuntimeSourceSnapshot,
  stageNativeRuntime,
  writeNativeRuntimeReceipt,
  inventoryNativePayload,
  selectPayloadNativeRuntime,
  parseElfMetadata,
  parseLddProviders,
  classifyAndValidateRuntimeClosure,
} from "./native-runtime.mjs";

function lddRowsForSubjects(rows, subjects) {
  return subjects.flatMap((subjectRelativePath) => rows.map((row) => ({ ...row, subjectRelativePath })));
}

function floorObservationFor({ target, material, elfRecords, lddRecords, payloadIdentity = digest(`payload:${target.triple}`), providerDefinitions = new Map() }) {
  const providers = [];
  const providerIds = new Map();
  for (const row of lddRecords) {
    if (row.status === "missing" || !row.resolvedPath) continue;
    const providerKey = `${row.soname}\0${row.resolvedPath}`;
    if (providerIds.has(providerKey)) continue;
    const isPrivateAlias = row.resolvedPath.endsWith("libwebkit2gtk-4.1.so.0");
    const terminalPath = isPrivateAlias
      ? row.resolvedPath.replace(/\.so\.0$/u, ".so.0.19.9")
      : row.resolvedPath;
    const provider = {
      soname: row.soname,
      classification: row.status === "interpreter" ? "interpreter" : "external-floor",
      requestedPath: row.resolvedPath,
      terminalPath,
      aliasChain: isPrivateAlias
        ? [{ path: row.resolvedPath, rawTarget: "libwebkit2gtk-4.1.so.0.19.9", full9: ["1", "2", 3, 33188, "4", "5", 501, 20, 1] }]
        : [],
      terminalFull9: ["1", "2", 3, 33188, "4", "5", 501, 20, 1],
      bytes: 64,
      sha256: digest(`provider:${terminalPath}`),
      elfMachine: "AArch64",
      elfClass: "ELF64",
      versionDefinitions: providerDefinitions.get(row.resolvedPath) ?? (row.status === "interpreter"
        ? []
        : row.soname === "libc.so.6" ? ["GLIBC_2.36"] : ["WEBKIT_4.1"]),
      readelfEvidenceSha256: digest(`readelf:${terminalPath}`),
    };
    const providerId = identity(provider);
    providers.push(provider);
    providerIds.set(providerKey, providerId);
  }
  const subjectResolutionRows = [];
  for (const row of lddRecords) {
    const subjectRelativePath = row.subjectRelativePath;
    const meta = typeof subjectRelativePath === "string" ? elfRecords[subjectRelativePath] : undefined;
    if (!meta || row.status === "missing" || !row.resolvedPath || !(meta.needed ?? []).includes(row.soname)) continue;
    subjectResolutionRows.push({
      subjectRelativePath,
      neededSoname: row.soname,
      resolvedPath: row.resolvedPath,
      providerObservationIdentity: providerIds.get(`${row.soname}\0${row.resolvedPath}`),
    });
  }
  const unsigned = {
    schema: "nebular-native-runtime-consumer-floor-observation-v1",
    target: target.triple,
    materialDigest: material.materialDigest,
    expectedNativePayload: payloadIdentity,
    observedProviderRows: providers,
    subjectResolutionRows,
    toolEvidence: {
      readelfRole: "test readelf",
      resolutionToolRole: "test ldd",
      boundedResults: [{ role: "fixture", status: 0, timedOut: false, outputLimitExceeded: false, cleanupKnown: true, outputComplete: true, forcedCleanup: false }],
      cleanupFacts: { allCommandsBounded: true, noSurvivingProcessFamily: true },
    },
  };
  return { ...unsigned, observationIdentity: identity(unsigned) };
}

for (const target of TARGETS) test(`${target.system} source launcher path and normal execution select the same custom output`, async () => {
  const root = await mkdtemp(join(tmpdir(), "nebular source path "));
  try {
    const release = join(root, target.triple, "release");
    const executable = target.os === "darwin" ? join(release, "bundle/macos/Theme Forge Nebular Fusion.app/Contents/MacOS", APPLICATION_NAME) : join(release, APPLICATION_NAME);
    await mkdir(join(executable, ".."), { recursive: true });
    await writeFile(executable, '#!/bin/sh\n[ "$1" = "argument with spaces" ] || exit 9\nexit 23\n', { mode: 0o755 });
    const options = { target, targetDirectory: root };
    assert.equal((await runSourceLauncher(["--path"], options)).output.trim(), await selectedSourceExecutable(options));
    assert.equal((await runSourceLauncher(["argument with spaces"], options)).status, 23);
    await rm(executable);
    await assert.rejects(runSourceLauncher(["--path"], options));
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const target of TARGETS) test(`${target.system} shipped launcher resolves executable through relocated links`, async () => {
  const root = await mkdtemp(join(tmpdir(), "nebular native path "));
  try {
    const gui = join(root, payloadLayout(target).executable);
    const bin = gui.slice(0, gui.lastIndexOf("/"));
    await mkdir(bin, { recursive: true });
    await writeFile(gui, '#!/bin/sh\nprintf "gui:%s\\n" "$1"\n', { mode: 0o755 });
    const launcherDir = target.os === "darwin" ? join(root, "Theme Forge Nebular Fusion.app/Contents/Resources/bin") : bin;
    await mkdir(launcherDir, { recursive: true });
    await writeFile(join(launcherDir, "tfnf"), nativeLauncher(target), { mode: 0o755 });
    await symlink(join(launcherDir, "tfnf"), join(root, "linked tfnf"));
    const run = args => spawnSync(join(root, "linked tfnf"), args, { encoding: "utf8", cwd: "/", timeout: 5000 });
    assert.equal(run(["--path"]).stdout.trim(), await realpath(gui));
    assert.equal(run(["--version"]).stdout.trim(), `${APPLICATION_NAME} ${CANDIDATE_VERSION}`);
    assert.match(run(["--help"]).stdout, /Usage: tfnf/);
    assert.equal(run(["argument with spaces"]).stdout.trim(), "gui:argument with spaces");
    await rm(gui);
    assert.notEqual(run(["--path"]).status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const target of TARGETS) test(`${target.system} Nix install phase path equals normal execution`, async t => {
  const expression = fileURLToPath(new URL("../../../nix/packages/nebular-fusion.nix", import.meta.url));
  if (!existsSync(expression) || spawnSync("nix-instantiate", ["--version"], { timeout: 10000 }).error?.code === "ENOENT") {
    t.skip("First-party Nix source and nix-instantiate required");
    return;
  }
  const studio = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const ciContract = fileURLToPath(new URL("../../../tools/ci/ci-contract.mjs", import.meta.url));
  const evaluation = spawnSync("nix-instantiate", ["--eval", "--strict", "--json", "--expr",
    `(import ${expression} { lib.elem = builtins.elem; stdenv.hostPlatform = { system = "${target.system}"; isDarwin = ${target.os === "darwin" ? "true" : "false"}; }; rustPlatform.buildRustPackage = x: x; source = ${studio}; ciContract = ${ciContract}; nodejs_22 = null; importNpmLock = null; pkg-config = null; gtk3 = null; glib = null; webkitgtk_4_1 = null; libsoup_3 = null; openssl = null; cairo = null; pango = null; stellarBurst = null; stellarLoom = null; solarSail = null; writeText = null; rasterSource = null; previewSource = null; libiconv = null; }).installPhase`],
  { encoding: "utf8", timeout: 30000 });
  assert.equal(evaluation.status, 0, evaluation.stderr);
  const root = await mkdtemp(join(tmpdir(), "nebular nix path "));
  try {
    const bundle = "Theme Forge Nebular Fusion.app/Contents/MacOS/theme-forge-nebular-fusion";
    const build = join(root, "build target");
    const release = join(build, "native-candidate/payload");
    const sourceGui = target.os === "darwin" ? join(release, bundle) : join(release, "bin", APPLICATION_NAME);
    await mkdir(join(sourceGui, ".."), { recursive: true });
    await writeFile(sourceGui, '#!/bin/sh\nprintf "gui:%s\\n" "$1"\n', { mode: 0o755 });
    for (const name of ["build-receipt", "native-payload", "candidate-provenance"]) await writeFile(join(build, "native-candidate", name + ".json"), "{}");
    const out = join(root, "installed output");
    const installed = spawnSync("sh", ["-eu", "-c", `runHook() { :; }\n${JSON.parse(evaluation.stdout)}`],
      { cwd: root, env: { ...process.env, out, TMPDIR: build }, encoding: "utf8", timeout: 10000 });
    assert.equal(installed.status, 0, installed.stderr);
    const gui = target.os === "darwin" ? join(out, "Applications", bundle) : join(out, "bin", APPLICATION_NAME);
    const launcher = join(out, "bin/tfnf");
    const run = args => spawnSync(launcher, args, { cwd: "/", encoding: "utf8", timeout: 5000 });
    assert.equal(run(["--path"]).stdout.trim(), gui);
    assert.equal(run(["--version"]).stdout.trim(), `${APPLICATION_NAME} ${CANDIDATE_VERSION}`);
    assert.equal(run(["argument with spaces"]).stdout.trim(), "gui:argument with spaces");
    await rm(gui);
    assert.notEqual(run(["--path"]).status, 0);
    await rm(sourceGui);
    const missing = spawnSync("sh", ["-eu", "-c", `runHook() { :; }\n${JSON.parse(evaluation.stdout)}`],
      { cwd: root, env: { ...process.env, out: join(root, "missing-output"), TMPDIR: build }, encoding: "utf8", timeout: 10000 });
    assert.notEqual(missing.status, 0, "missing compilation must not create a placeholder GUI");
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function createSyntheticRuntimeMaterial(root, target = TARGETS[1]) {
  const sourceRoot = join(root, `runtime-${target.arch}`);
  await mkdir(join(sourceRoot, "opt"), { recursive: true, mode: 0o755 });
  await chmod(join(sourceRoot, "opt"), 0o755);
  const directories = [];
  for (const dir of REQUIRED_RUNTIME_DIRECTORIES) {
    const absDir = join(sourceRoot, dir);
    await mkdir(absDir, { recursive: true, mode: 0o755 });
    await chmod(absDir, 0o755);
    directories.push({ path: dir, mode: 0o755 });
  }
  const regulars = [];
  for (const role of REQUIRED_RUNTIME_ROLES) {
    const absPath = join(sourceRoot, role);
    const executable = REQUIRED_EXECUTABLE_RUNTIME_ROLES.includes(role);
    const mode = executable ? 0o755 : 0o644;
    const content = executable ? `#!/bin/sh\nexit 0\n` : `role:${role}\n`;
    await writeFile(absPath, content, { mode });
    await chmod(absPath, mode);
    regulars.push({
      path: role,
      bytes: Buffer.byteLength(content),
      sha256: digest(content),
      mode,
      role: executable ? "helper-executable" : "shared-object",
    });
  }
  regulars.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const aliases = [
    {
      path: "opt/nebular-private/lib/libjavascriptcoregtk-4.1.so.0",
      target: "libjavascriptcoregtk-4.1.so.0.9.11",
      canonical: "opt/nebular-private/lib/libjavascriptcoregtk-4.1.so.0.9.11",
    },
    {
      path: "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0",
      target: "libwebkit2gtk-4.1.so.0.19.9",
      canonical: "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0.19.9",
    },
  ];
  for (const alias of aliases) {
    await symlink(alias.target, join(sourceRoot, alias.path));
  }

  const externalFloor = externalFloorForTarget(target.triple).map(soname => ({
    soname,
    basis: `debian-bookworm:${soname}`,
    sha256: digest(`floor:${soname}:${target.triple}`),
    bytes: 4096,
    ...(soname === "libc.so.6" ? { versions: ["GLIBC_2.34", "GLIBC_2.36"] } : {}),
  }));

  const unsignedMaterial = {
    schema: "nebular-native-runtime-material-v1",
    target: target.triple,
    prefix: PRIVATE_RUNTIME_PREFIX,
    directories,
    regulars,
    aliases,
    requiredRoles: [...REQUIRED_RUNTIME_ROLES],
    externalFloor,
  };
  const material = {
    ...unsignedMaterial,
    materialDigest: computeMaterialDigest(unsignedMaterial),
  };
  const inputPath = join(root, `runtime-input-${target.arch}.json`);
  const inputBody = JSON.stringify({
    schema: "nebular-native-runtime-input-v1",
    target: target.triple,
    sourceRoot,
    material,
    evidence: {
      acceptanceDigest: digest(`evidence:${target.triple}`),
    },
  }, null, 2) + "\n";
  await writeFile(inputPath, inputBody);
  return {
    sourceRoot,
    material,
    inputPath,
    inputSha256: digest(inputBody),
  };
}

test("nativeLauncher rejects unknown options and rejects nativeRuntime on Darwin", () => {
  assert.throws(() => nativeLauncher(TARGETS[0], { nativeRuntime: true }), /only supported on Linux targets/);
  assert.throws(() => nativeLauncher(TARGETS[1], { nativeRuntime: "yes" }), /boolean/);
  assert.throws(() => nativeLauncher(TARGETS[1], { unknownOption: true }), /Unknown native launcher option/);
});

test("Linux private-runtime launcher resolves relocated symlink, strips dynamic-loader poison, preserves operator env, and enforces runtime roles", async () => {
  const root = await mkdtemp(join(tmpdir(), "nebular private launcher "));
  try {
    const target = TARGETS[1];
    const { inputPath, inputSha256 } = await createSyntheticRuntimeMaterial(root, target);
    const authenticated = await authenticateNativeRuntimeInput(inputPath, inputSha256, {
      expectedTarget: target.triple,
      outputRoots: [join(root, "unrelated")],
    });
    const payloadRoot = join(root, "payload with spaces");
    await mkdir(join(payloadRoot, "bin"), { recursive: true });
    const childHelper = join(payloadRoot, "bin/child-helper");
    await writeFile(
      childHelper,
      [
        "#!/bin/sh",
        'printf "CHILD_LD_LIBRARY_PATH=%s\\n" "${LD_LIBRARY_PATH-}"',
        'printf "CHILD_LD_PRELOAD=%s\\n" "${LD_PRELOAD-}"',
        'printf "CHILD_LD_UNKNOWN_POISON=%s\\n" "${LD_UNKNOWN_POISON-}"',
        "",
      ].join("\n"),
      { mode: 0o755 }
    );
    const gui = join(payloadRoot, "bin", APPLICATION_NAME);
    await writeFile(
      gui,
      [
        "#!/bin/sh",
        'printf "arg1=%s\\n" "$1"',
        'printf "arg2=%s\\n" "${2-}"',
        'printf "LD_LIBRARY_PATH=%s\\n" "${LD_LIBRARY_PATH-}"',
        'printf "LD_PRELOAD=%s\\n" "${LD_PRELOAD-}"',
        'printf "LD_AUDIT=%s\\n" "${LD_AUDIT-}"',
        'printf "LD_DEBUG=%s\\n" "${LD_DEBUG-}"',
        'printf "LD_UNKNOWN_POISON=%s\\n" "${LD_UNKNOWN_POISON-}"',
        'printf "GLIBC_TUNABLES=%s\\n" "${GLIBC_TUNABLES-}"',
        'printf "OPERATOR_VAR=%s\\n" "${OPERATOR_VAR-}"',
        `"$(dirname -- "$0")/child-helper"`,
        "exit 19",
        "",
      ].join("\n"),
      { mode: 0o755 }
    );
    await stageNativeRuntime(payloadRoot, authenticated);
    await writeFile(join(payloadRoot, "bin/tfnf"), nativeLauncher(target, { nativeRuntime: true }), { mode: 0o755 });
    const linkedLauncher = join(root, "relocated link with spaces");
    await symlink(join(payloadRoot, "bin/tfnf"), linkedLauncher);
    const poisonedEnv = {
      ...process.env,
      LD_LIBRARY_PATH: "/tmp/poisoned-lib",
      LD_PRELOAD: "/tmp/poisoned-preload.so",
      LD_AUDIT: "/tmp/poisoned-audit.so",
      LD_DEBUG: "all",
      LD_UNKNOWN_POISON: "/tmp/unknown-loader-var",
      GLIBC_TUNABLES: "glibc.malloc.check=3",
      OPERATOR_VAR: "kept value",
    };
    const run = args => spawnSync(linkedLauncher, args, { encoding: "utf8", cwd: "/", env: poisonedEnv, timeout: 5000 });
    const realPayloadRoot = await realpath(payloadRoot);
    assert.equal(run(["--path"]).stdout.trim(), join(realPayloadRoot, "bin", APPLICATION_NAME));
    assert.equal(run(["--version"]).stdout.trim(), `${APPLICATION_NAME} ${CANDIDATE_VERSION}`);
    assert.match(run(["--help"]).stdout, /Usage: tfnf/);
    const execResult = run(["arg with spaces", "--flag=LD_UNKNOWN_POISON"]);
    assert.equal(execResult.status, 19);
    const lines = Object.fromEntries(
      execResult.stdout.trim().split("\n").map(line => {
        const idx = line.indexOf("=");
        return [line.slice(0, idx), line.slice(idx + 1)];
      })
    );
    assert.equal(lines.arg1, "arg with spaces");
    assert.equal(lines.arg2, "--flag=LD_UNKNOWN_POISON");
    assert.equal(lines.LD_LIBRARY_PATH, join(realPayloadRoot, "opt/nebular-private/lib"));
    assert.equal(lines.CHILD_LD_LIBRARY_PATH, join(realPayloadRoot, "opt/nebular-private/lib"));
    assert.equal(lines.LD_PRELOAD, "libwebkit2gtk-4.1.so.0.19.9");
    assert.equal(lines.CHILD_LD_PRELOAD, "libwebkit2gtk-4.1.so.0.19.9");
    assert.equal(lines.LD_AUDIT, "");
    assert.equal(lines.LD_DEBUG, "");
    assert.equal(lines.LD_UNKNOWN_POISON, "");
    assert.equal(lines.CHILD_LD_UNKNOWN_POISON, "");
    assert.equal(lines.GLIBC_TUNABLES, "");
    assert.equal(lines.OPERATOR_VAR, "kept value");

    // Missing required executable and library roles fail non-zero
    for (const role of REQUIRED_RUNTIME_ROLES) {
      const rolePath = join(payloadRoot, role);
      const saved = await readFile(rolePath);
      await rm(rolePath);
      assert.notEqual(run(["--path"]).status, 0, `expected failure when ${role} is missing`);
      const executable = REQUIRED_EXECUTABLE_RUNTIME_ROLES.includes(role);
      await writeFile(rolePath, saved, { mode: executable ? 0o755 : 0o644 });
    }

    // Non-executable required executable role fails non-zero
    const bwrapPath = join(payloadRoot, "opt/nebular-private/libexec/sandbox/bwrap");
    await chmod(bwrapPath, 0o644);
    assert.notEqual(run(["--path"]).status, 0);
    await chmod(bwrapPath, 0o755);

    // Missing native-runtime.json fails non-zero
    const markerPath = join(payloadRoot, PRIVATE_RUNTIME_MARKER);
    const markerSaved = await readFile(markerPath);
    await rm(markerPath);
    assert.notEqual(run(["--path"]).status, 0);
    await writeFile(markerPath, markerSaved);

    // Symlink replacing a required directory fails non-zero
    const sandboxDir = join(payloadRoot, "opt/nebular-private/libexec/sandbox");
    const backupSandbox = join(root, "backup-sandbox");
    await rm(sandboxDir, { recursive: true, force: true });
    await mkdir(backupSandbox, { recursive: true });
    await symlink(backupSandbox, sandboxDir);
    assert.notEqual(run(["--path"]).status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateRuntimeMaterial, stageNativeRuntime, inventoryNativePayload, and closure validators enforce boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "nebular runtime unit "));
  try {
    const target = TARGETS[1]; // aarch64-unknown-linux-gnu
    const { sourceRoot, material, inputPath, inputSha256 } = await createSyntheticRuntimeMaterial(root, target);
    const validated = validateRuntimeMaterial(material, target.triple);
    assert.equal(validated.materialDigest, material.materialDigest);

    // Reject digest mismatch
    const badDigestMat = structuredClone(material);
    badDigestMat.materialDigest = "0".repeat(64);
    assert.throws(() => validateRuntimeMaterial(badDigestMat, target.triple), /materialDigest mismatch/);

    // Reject unsorted / duplicate directories
    const unsortedMat = structuredClone(material);
    unsortedMat.directories = [...unsortedMat.directories].reverse();
    unsortedMat.materialDigest = computeMaterialDigest(unsortedMat);
    assert.throws(() => validateRuntimeMaterial(unsortedMat, target.triple), /sorted lexicographically/);

    // Reject escaping alias and looping alias
    const escapingMat = structuredClone(material);
    escapingMat.aliases[0].target = "../../../etc/passwd";
    escapingMat.materialDigest = computeMaterialDigest(escapingMat);
    assert.throws(() => validateRuntimeMaterial(escapingMat, target.triple), /escapes opt\/nebular-private/);

    const loopingMat = structuredClone(material);
    loopingMat.aliases[0].target = "libwebkit2gtk-4.1.so.0";
    loopingMat.aliases[1].target = "libjavascriptcoregtk-4.1.so.0";
    loopingMat.materialDigest = computeMaterialDigest(loopingMat);
    assert.throws(() => validateRuntimeMaterial(loopingMat, target.triple), /alias cycle/);

    // Reject missing SONAME entry
    const missingSonameMaterial = structuredClone(material);
    missingSonameMaterial.aliases = missingSonameMaterial.aliases.filter(
      a => a.path !== "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0"
    );
    missingSonameMaterial.materialDigest = computeMaterialDigest(missingSonameMaterial);
    assert.throws(
      () => validateRuntimeMaterial(missingSonameMaterial, target.triple),
      /missing required primary library entry opt\/nebular-private\/lib\/libwebkit2gtk-4\.1\.so\.0/
    );

    // Stage and verify exact output body/alias readback and source immutability on failure
    const authenticated = await authenticateNativeRuntimeInput(inputPath, inputSha256, {
      expectedTarget: target.triple,
      outputRoots: [join(root, "output")],
    });
    const payloadRoot = join(root, "staged-payload");
    await mkdir(join(payloadRoot, "bin"), { recursive: true });
    await writeFile(join(payloadRoot, "bin", APPLICATION_NAME), "gui-binary", { mode: 0o755 });
    await stageNativeRuntime(payloadRoot, authenticated);
    await verifyRuntimeSourceSnapshot(authenticated);

    const selection = await selectPayloadNativeRuntime(payloadRoot, target.triple);
    assert.equal(selection.nativeRuntime, true);
    assert.equal(selection.material?.materialDigest, material.materialDigest);

    const aliasPath = join(payloadRoot, "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0");
    const aliasStat = await lstat(aliasPath);
    assert.equal(aliasStat.isSymbolicLink(), true);
    assert.equal(await readlink(aliasPath), "libwebkit2gtk-4.1.so.0.19.9");

    // Failed staging (pre-existing runtime dir) leaves source snapshot untouched
    await assert.rejects(stageNativeRuntime(payloadRoot, authenticated), /Refusing to overwrite existing runtime path/);
    await verifyRuntimeSourceSnapshot(authenticated);

    // Default inventoryTree still rejects the alias-containing staged payload
    await assert.rejects(inventoryTree(payloadRoot), /nonregular inventory member/);

    const inv1 = await inventoryNativePayload(payloadRoot, { expectedTarget: target.triple });
    assert.equal(inv1.schema, "nebular-native-payload-inventory-v1");
    await assert.rejects(
      inventoryNativePayload(payloadRoot, { expectedTarget: "x86_64-unknown-linux-gnu" }),
      /does not match expected target/
    );

    const receiptOut = join(root, "receipt-out");
    await mkdir(receiptOut, { recursive: true });
    await assert.rejects(
      writeNativeRuntimeReceipt(receiptOut, {
        target: target.triple,
        material,
        sourceCandidate: "a".repeat(64),
        payloadInventory: { identity: "b".repeat(64), files: [] },
        inputSha256,
      }),
      /requires a verified nebular-native-payload-inventory-v1/
    );
    const writtenReceipt = await writeNativeRuntimeReceipt(receiptOut, {
      target: target.triple,
      material,
      sourceCandidate: "a".repeat(64),
      payloadInventory: inv1,
      inputSha256,
    });
    assert.equal(writtenReceipt.nativePayload, inv1.identity);

    // Unknown extra leaf in runtime subtree is refused by inventoryNativePayload
    const extraLeaf = join(payloadRoot, "opt/nebular-private/lib/libextra.so");
    await writeFile(extraLeaf, "extra", { mode: 0o644 });
    await assert.rejects(inventoryNativePayload(payloadRoot), /contains undeclared member/);
    await rm(extraLeaf);

    // Hardlinked runtime regular is refused by inventoryNativePayload
    const hardlinkSibling = join(root, "hardlink-sibling");
    await link(join(payloadRoot, "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0.19.9"), hardlinkSibling);
    await assert.rejects(inventoryNativePayload(payloadRoot), /refused hardlinked regular/);
    await rm(hardlinkSibling);

    // Hash/mode/target mismatch in staged payload is refused by inventoryNativePayload
    await chmod(join(payloadRoot, "opt/nebular-private/libexec/sandbox/bwrap"), 0o644);
    await assert.rejects(inventoryNativePayload(payloadRoot), /regular mismatch|declared metadata mismatch/);
    await chmod(join(payloadRoot, "opt/nebular-private/libexec/sandbox/bwrap"), 0o755);

    // Mutating alias target text with updated manifest changes inventory identity
    const updatedMaterial = structuredClone(material);
    const secondRegularPath = "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0.19.10";
    const secondContent = `role:${REQUIRED_RUNTIME_ROLES[1]}\n`;
    await writeFile(join(payloadRoot, secondRegularPath), secondContent, { mode: 0o644 });
    updatedMaterial.regulars.push({
      path: secondRegularPath,
      bytes: Buffer.byteLength(secondContent),
      sha256: digest(secondContent),
      mode: 0o644,
    });
    updatedMaterial.regulars.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const wkAlias = updatedMaterial.aliases.find(a => a.path === "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0");
    wkAlias.target = "libwebkit2gtk-4.1.so.0.19.10";
    wkAlias.canonical = secondRegularPath;
    updatedMaterial.materialDigest = computeMaterialDigest(updatedMaterial);
    await rm(aliasPath);
    await symlink("libwebkit2gtk-4.1.so.0.19.10", aliasPath);
    await writeFile(join(payloadRoot, PRIVATE_RUNTIME_MARKER), JSON.stringify(updatedMaterial, null, 2) + "\n");
    const inv2 = await inventoryNativePayload(payloadRoot);
    assert.notEqual(inv2.identity, inv1.identity);

    // Restore original alias and manifest for ELF/ldd closure checks
    await rm(join(payloadRoot, secondRegularPath));
    await rm(aliasPath);
    await symlink("libwebkit2gtk-4.1.so.0.19.9", aliasPath);
    await writeFile(join(payloadRoot, PRIVATE_RUNTIME_MARKER), JSON.stringify(material, null, 2) + "\n");

    // ELF metadata and ldd closure checks
    const readelfGui = [
      "ELF Header:",
      "  Class:                             ELF64",
      "  Machine:                           AArch64",
      "  Type:                              DYN (Position-Independent Executable file)",
      "Program Headers:",
      "      [Requesting program interpreter: /lib/ld-linux-aarch64.so.1]",
      "Dynamic section at offset 0x100 contains 3 entries:",
      " 0x0000000000000001 (NEEDED)             Shared library: [libwebkit2gtk-4.1.so.0]",
      " 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]",
      "Version needs section '.gnu.version_r' contains 1 entry:",
      "  0x0020: Version: 1  File: libc.so.6  Cnt: 1",
      "  0x0030:   Name: GLIBC_2.36  Flags: none  Version: 4",
    ].join("\n");
    const readelfWebkit = [
      "ELF Header:",
      "  Class:                             ELF64",
      "  Machine:                           AArch64",
      "  Type:                              DYN (Shared object file)",
      "Dynamic section at offset 0x100 contains 2 entries:",
      " 0x000000000000000e (SONAME)             Library soname: [libwebkit2gtk-4.1.so.0]",
      " 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]",
      "Version definition section '.gnu.version_d' contains 2 entries:",
      "  0x0000: Rev: 1  Flags: BASE  Index: 1  Cnt: 1  Name: libwebkit2gtk-4.1.so.0",
      "  0x001c: Rev: 1  Flags: none  Index: 2  Cnt: 1  Name: WEBKIT_4.1",
    ].join("\n");
    const parsedGui = parseElfMetadata(readelfGui, target.triple);
    const parsedWebkit = parseElfMetadata(readelfWebkit, target.triple);
    assert.deepEqual(parsedGui.needed, ["libwebkit2gtk-4.1.so.0", "libc.so.6"]);

    const lddGood = [
      `\tlibwebkit2gtk-4.1.so.0 => ${join(payloadRoot, "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0")} (0x00007f0000010000)`,
      "\tlibc.so.6 => /lib/aarch64-linux-gnu/libc.so.6 (0x00007f0000020000)",
      "\t/lib/ld-linux-aarch64.so.1 (0x00007f0000030000)",
    ].join("\n");
    const parsedLddGood = lddRowsForSubjects(parseLddProviders(lddGood), [
      "bin/theme-forge-nebular-fusion",
      "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0.19.9",
    ]);
    const goodFloorObservation = floorObservationFor({
      target,
      material,
      elfRecords: {
        "bin/theme-forge-nebular-fusion": parsedGui,
        "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0.19.9": parsedWebkit,
      },
      lddRecords: parsedLddGood,
    });
    const goodClosure = classifyAndValidateRuntimeClosure({
      target: target.triple,
      payloadRoot,
      material,
      elfRecords: {
        "bin/theme-forge-nebular-fusion": parsedGui,
        "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0.19.9": parsedWebkit,
      },
      lddRecords: parsedLddGood,
      floorObservation: goodFloorObservation,
    });
    assert.equal(goodClosure.ok, true, goodClosure.problems.join("; "));

    // Two subjects may request the same SONAME through different provider
    // paths. Their provider identities and version definitions must remain
    // subject-specific; a global SONAME map or cross-product join is unsafe.
    const sameSonameElfRecords = {
      "bin/subject-a": { needed: ["libc.so.6"], interpreters: [], versionNeeds: [{ provider: "libc.so.6", name: "GLIBC_2.36" }] },
      "bin/subject-b": { needed: ["libc.so.6"], interpreters: [], versionNeeds: [{ provider: "libc.so.6", name: "GLIBC_2.35" }] },
    };
    const sameSonameRows = [
      { ...parseLddProviders("\tlibc.so.6 => /lib/aarch64-linux-gnu/libc.so.6 (0x00007f0000010000)")[0], subjectRelativePath: "bin/subject-a" },
      { ...parseLddProviders("\tlibc.so.6 => /opt/alternate/libc.so.6 (0x00007f0000020000)")[0], subjectRelativePath: "bin/subject-b" },
    ];
    const sameSonameObservation = floorObservationFor({
      target,
      material,
      elfRecords: sameSonameElfRecords,
      lddRecords: sameSonameRows,
      providerDefinitions: new Map([
        ["/lib/aarch64-linux-gnu/libc.so.6", ["GLIBC_2.36"]],
        ["/opt/alternate/libc.so.6", ["GLIBC_2.35"]],
      ]),
    });
    const sameSonameClosure = classifyAndValidateRuntimeClosure({
      target: target.triple,
      payloadRoot,
      material,
      elfRecords: sameSonameElfRecords,
      lddRecords: sameSonameRows,
      floorObservation: sameSonameObservation,
    });
    assert.equal(sameSonameClosure.ok, true, sameSonameClosure.problems.join("; "));
    const swappedSameSoname = structuredClone(sameSonameObservation);
    const sameSubjectRows = swappedSameSoname.subjectResolutionRows;
    const firstSubjectRow = sameSubjectRows.find((row) => row.subjectRelativePath === "bin/subject-a");
    const secondSubjectRow = sameSubjectRows.find((row) => row.subjectRelativePath === "bin/subject-b");
    [firstSubjectRow.providerObservationIdentity, secondSubjectRow.providerObservationIdentity] = [
      secondSubjectRow.providerObservationIdentity,
      firstSubjectRow.providerObservationIdentity,
    ];
    delete swappedSameSoname.observationIdentity;
    swappedSameSoname.observationIdentity = identity(swappedSameSoname);
    const swappedSameSonameClosure = classifyAndValidateRuntimeClosure({
      target: target.triple,
      payloadRoot,
      material,
      elfRecords: sameSonameElfRecords,
      lddRecords: sameSonameRows,
      floorObservation: swappedSameSoname,
    });
    assert.equal(swappedSameSonameClosure.ok, false);
    assert.match(swappedSameSonameClosure.problems.join("; "), /missing (?:version definition|subject resolution)/);
    const missingSameSoname = structuredClone(sameSonameObservation);
    missingSameSoname.subjectResolutionRows = missingSameSoname.subjectResolutionRows.filter((row) => row.subjectRelativePath !== "bin/subject-b");
    delete missingSameSoname.observationIdentity;
    missingSameSoname.observationIdentity = identity(missingSameSoname);
    const missingSameSonameClosure = classifyAndValidateRuntimeClosure({
      target: target.triple,
      payloadRoot,
      material,
      elfRecords: sameSonameElfRecords,
      lddRecords: sameSonameRows,
      floorObservation: missingSameSoname,
    });
    assert.equal(missingSameSonameClosure.ok, false);
    assert.match(missingSameSonameClosure.problems.join("; "), /missing subject resolution observation/);

    // A declared external floor is not an observed provider.  Version needs
    // must still bind to an actual provider definition for every subject.
    const unobservedFloor = structuredClone(sameSonameObservation);
    unobservedFloor.observedProviderRows = [];
    unobservedFloor.subjectResolutionRows = [];
    delete unobservedFloor.observationIdentity;
    unobservedFloor.observationIdentity = identity(unobservedFloor);
    const unobservedFloorClosure = classifyAndValidateRuntimeClosure({
      target: target.triple,
      payloadRoot,
      material,
      elfRecords: sameSonameElfRecords,
      lddRecords: sameSonameRows,
      floorObservation: unobservedFloor,
    });
    assert.equal(unobservedFloorClosure.ok, false);
    assert.match(unobservedFloorClosure.problems.join("; "), /requires version GLIBC_2\.36 from provider libc\.so\.6, but no actual provider observation was recorded/);

    const reidentifyObservation = observation => {
      const unsigned = structuredClone(observation);
      delete unsigned.observationIdentity;
      unsigned.subjectResolutionRows = unsigned.subjectResolutionRows.map(row => {
        const provider = unsigned.observedProviderRows.find(candidate =>
          candidate.soname === row.neededSoname &&
          (candidate.requestedPath === row.resolvedPath || candidate.terminalPath === row.resolvedPath)
        );
        return { ...row, providerObservationIdentity: provider ? identity(provider) : row.providerObservationIdentity };
      });
      unsigned.observationIdentity = identity(unsigned);
      return unsigned;
    };
    const wrongAlias = structuredClone(goodFloorObservation);
    wrongAlias.observedProviderRows[0].aliasChain[0].rawTarget = "wrong-provider.so";
    const wrongAliasObservation = reidentifyObservation(wrongAlias);
    const badAliasClosure = classifyAndValidateRuntimeClosure({
      target: target.triple,
      payloadRoot,
      material,
      elfRecords: { "bin/theme-forge-nebular-fusion": parsedGui, "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0.19.9": parsedWebkit },
      lddRecords: parsedLddGood,
      floorObservation: wrongAliasObservation,
    });
    assert.equal(badAliasClosure.ok, false);
    assert.match(badAliasClosure.problems.join("; "), /alias chain/);

    let wrongTerminal = structuredClone(goodFloorObservation);
    wrongTerminal.observedProviderRows[0].aliasChain[0].rawTarget = "/tmp/unapproved-floor.so";
    wrongTerminal.observedProviderRows[0].terminalPath = "/tmp/unapproved-floor.so";
    wrongTerminal = reidentifyObservation(wrongTerminal);
    const badTerminalClosure = classifyAndValidateRuntimeClosure({
      target: target.triple,
      payloadRoot,
      material,
      elfRecords: { "bin/theme-forge-nebular-fusion": parsedGui, "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0.19.9": parsedWebkit },
      lddRecords: parsedLddGood,
      floorObservation: wrongTerminal,
    });
    assert.equal(badTerminalClosure.ok, false);
    assert.match(badTerminalClosure.problems.join("; "), /uncontrolled host fallback/);

    let wrongMachine = structuredClone(goodFloorObservation);
    wrongMachine.observedProviderRows[0].elfMachine = "X86-64";
    wrongMachine = reidentifyObservation(wrongMachine);
    const badMachineClosure = classifyAndValidateRuntimeClosure({
      target: target.triple,
      payloadRoot,
      material,
      elfRecords: { "bin/theme-for-nebular-fusion": parsedGui, "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0.19.9": parsedWebkit },
      lddRecords: parsedLddGood,
      floorObservation: wrongMachine,
    });
    assert.equal(badMachineClosure.ok, false);
    assert.match(badMachineClosure.problems.join("; "), /ELF identity/);

    const missingPayloadJoin = classifyAndValidateRuntimeClosure({
      target: target.triple,
      payloadRoot,
      material,
      expectedNativePayload: "0".repeat(64),
      elfRecords: { "bin/theme-forge-nebular-fusion": parsedGui, "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0.19.9": parsedWebkit },
      lddRecords: parsedLddGood,
      floorObservation: goodFloorObservation,
    });
    assert.equal(missingPayloadJoin.ok, false);
    assert.match(missingPayloadJoin.problems.join("; "), /expectedNativePayload/);

    // Found-but-unapproved host provider fallback must fail
    const lddHostFallback = [
      "\tlibwebkit2gtk-4.1.so.0 => /usr/lib/aarch64-linux-gnu/libwebkit2gtk-4.1.so.0 (0x00007f0000010000)",
      "\tlibc.so.6 => /lib/aarch64-linux-gnu/libc.so.6 (0x00007f0000020000)",
    ].join("\n");
    const badHostFallback = classifyAndValidateRuntimeClosure({
      target: target.triple,
      payloadRoot,
      material,
      elfRecords: { "bin/theme-forge-nebular-fusion": parsedGui },
      lddRecords: lddRowsForSubjects(parseLddProviders(lddHostFallback), ["bin/theme-forge-nebular-fusion"]),
    });
    assert.equal(badHostFallback.ok, false);
    assert.match(badHostFallback.problems.join("; "), /uncontrolled host fallback/);

    // Unapproved third-party host library must fail
    const lddUnapprovedHost = [
      `\tlibwebkit2gtk-4.1.so.0 => ${join(payloadRoot, "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0.19.9")} (0x00007f0000010000)`,
      "\tlibfoo-unapproved.so.1 => /usr/lib/aarch64-linux-gnu/libfoo-unapproved.so.1 (0x00007f0000040000)",
    ].join("\n");
    const badUnapprovedHost = classifyAndValidateRuntimeClosure({
      target: target.triple,
      payloadRoot,
      material,
      elfRecords: { "bin/theme-forge-nebular-fusion": parsedGui },
      lddRecords: lddRowsForSubjects(parseLddProviders(lddUnapprovedHost), ["bin/theme-forge-nebular-fusion"]),
    });
    assert.equal(badUnapprovedHost.ok, false);
    assert.match(badUnapprovedHost.problems.join("; "), /unapproved host provider fallback/);

    // GLIBC > 2.36 must fail
    const elfGlibc238 = parseElfMetadata(readelfGui.replaceAll("GLIBC_2.36", "GLIBC_2.38"), target.triple);
    const badGlibc = classifyAndValidateRuntimeClosure({
      target: target.triple,
      payloadRoot,
      material,
      elfRecords: { "bin/theme-forge-nebular-fusion": elfGlibc238 },
      lddRecords: parsedLddGood,
      floorObservation: floorObservationFor({
        target,
        material,
        elfRecords: { "bin/theme-forge-nebular-fusion": elfGlibc238 },
        lddRecords: parsedLddGood,
      }),
    });
    assert.equal(badGlibc.ok, false);
    assert.match(badGlibc.problems.join("; "), /exceeding GLIBC_2\.36/);

    // Missing required version definition on private provider must fail
    const elfVersionedNeed = parseElfMetadata([
      "ELF Header:",
      "  Class:                             ELF64",
      "  Machine:                           AArch64",
      "  Type:                              DYN (Position-Independent Executable file)",
      "Dynamic section at offset 0x100 contains 1 entries:",
      " 0x0000000000000001 (NEEDED)             Shared library: [libwebkit2gtk-4.1.so.0]",
      "Version needs section '.gnu.version_r' contains 1 entry:",
      "  0x0020: Version: 1  File: libwebkit2gtk-4.1.so.0  Cnt: 1",
      "  0x0030:   Name: WEBKIT_MISSING_99  Flags: none  Version: 5",
    ].join("\n"), target.triple);
    const badVersionDef = classifyAndValidateRuntimeClosure({
      target: target.triple,
      payloadRoot,
      material,
      elfRecords: {
        "bin/theme-forge-nebular-fusion": elfVersionedNeed,
        "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0.19.9": parsedWebkit,
      },
      lddRecords: parsedLddGood,
      floorObservation: floorObservationFor({
        target,
        material,
        elfRecords: {
          "bin/theme-forge-nebular-fusion": elfVersionedNeed,
          "opt/nebular-private/lib/libwebkit2gtk-4.1.so.0.19.9": parsedWebkit,
        },
        lddRecords: parsedLddGood,
      }),
    });
    assert.equal(badVersionDef.ok, false);
    assert.match(badVersionDef.problems.join("; "), /missing version definition WEBKIT_MISSING_99/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { nativeLauncher } from "./native-launcher.mjs";
import { selectedSourceExecutable, runSourceLauncher } from "./source-launcher.mjs";
import { TARGETS, CANDIDATE_VERSION, APPLICATION_NAME, payloadLayout } from "./platform-targets.mjs";

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
  const evaluation = spawnSync("nix-instantiate", ["--eval", "--strict", "--json", "--expr",
    `(import ${expression} { lib.elem = builtins.elem; stdenv.hostPlatform = { system = "${target.system}"; isDarwin = ${target.os === "darwin" ? "true" : "false"}; }; rustPlatform.buildRustPackage = x: x; source = ${studio}; nodejs_22 = null; importNpmLock = null; pkg-config = null; gtk3 = null; glib = null; webkitgtk_4_1 = null; libsoup_3 = null; openssl = null; cairo = null; pango = null; stellarBurst = null; stellarLoom = null; solarSail = null; writeText = null; rasterSource = null; previewSource = null; libiconv = null; }).installPhase`],
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

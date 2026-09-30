// @vitest-environment node
// Deterministic adversarial tests for the descriptor-bound snapshot primitive and the eight build and
// release flows that use it (CodeQL js/file-system-race sites repaired in CI9):
//   build-receipt executable check, build-settings locator inventory and cargoHome configuration,
//   create-build-inputs toolchain identity, and Darwin finalization of LICENSE and NOTICE.
// Races are injected through the reader hooks, which run after the descriptor is opened and after its
// bytes or entries are read -- the exact windows in which a concurrent writer would act.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it as test } from "vitest";
import { createSnapshotReader, defaultSnapshotReader, readRegularSnapshot } from "../tools/fs-snapshot.mjs";
import { inventoryPath, inventoryLocator, validateBuildSettings, createBuildSettings } from "../tools/build-settings.mjs";
import { toolchainIdentity } from "../tools/create-build-inputs.mjs";
import { measureNativeExecutable } from "../tools/build-receipt.mjs";
import { finalizeDarwinAppBundle } from "../tools/finalize-darwin-bundle.mjs";
import { digest } from "../tools/candidate-provenance.mjs";

const DARWIN = { os: "darwin", cpu: "arm64", triple: "aarch64-apple-darwin", system: "aarch64-darwin" };
const LINUX_ARM64 = { os: "linux", cpu: "arm64", triple: "aarch64-unknown-linux-gnu", system: "aarch64-linux" };

const scratchDirs = [];
afterEach(async () => {
  for (const dir of scratchDirs.splice(0)) {
    await chmodTree(dir);
    await rm(dir, { recursive: true, force: true });
  }
});
async function chmodTree(dir) {
  // A test may leave a member unreadable; restore access so cleanup cannot fail.
  spawnSync("/bin/sh", ["-c", `chmod -R u+rwX ${q(dir)} 2>/dev/null || true`]);
}
async function scratch(_context, name) {
  const dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), `fs-snapshot-${name}-`));
  scratchDirs.push(dir);
  return dir;
}

function openDescriptorCount() {
  for (const dir of ["/proc/self/fd", "/dev/fd"]) {
    if (existsSync(dir)) return readdirSync(dir).length;
  }
  return null;
}

// A synchronous rename/replace executed from inside a hook (hooks are synchronous by design).
function sh(script) {
  const result = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
const q = value => `'${value.replaceAll("'", "'\\''")}'`;
// Replacing, relinking or removing an opened member is always detected: either the descriptor no longer
// describes the object that was read (its link count and ctime change) or the name no longer names it.
const RACE = /(changed|replaced|removed) while it was read/;

function oneShot(fn) {
  let fired = false;
  return context => { if (!fired) { fired = true; fn(context); } };
}

function elf(cpu) {
  const header = Buffer.alloc(64);
  Buffer.from([127, 69, 76, 70, 2, 1]).copy(header);
  header.writeUInt16LE(cpu === "arm64" ? 183 : 62, 18);
  return header;
}

// Identities pinned with the pre-repair CI8 inventoryPath on the same fixture; the repair must be
// byte-compatible so that existing build-settings identities keep their meaning.
const PINNED_INVENTORY = {
  root: "5ac94f7f4f13f9aa1c58dc545c4dce90ebf51469a6dd0a01f470dd9cc2a02e2d",
  file: "0757ba5b77ea56607459083c385e01889694774ee8da6214b07a7b26e64c4350",
  ext: "10d9aac42fd5a0a4d774788ef2e6f07f785bd8aa2adca5257e03e108cb7d197c",
  multi: "e9c2122df684125d113c81479f0f86d1ce36c80d983b19ece8ba3859a6041397",
};

async function locatorFixture(base) {
  const root = join(base, "root"), ext = join(base, "ext");
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(root, "dir"), { recursive: true });
  await mkdir(join(ext, "inc"), { recursive: true });
  await writeFile(join(root, "a.txt"), "alpha\n"); await chmod(join(root, "a.txt"), 0o644);
  await writeFile(join(root, "bin/tool"), "#!/bin/sh\nexit 0\n"); await chmod(join(root, "bin/tool"), 0o755);
  await writeFile(join(root, "dir/nested.txt"), "nested\n"); await chmod(join(root, "dir/nested.txt"), 0o600);
  await writeFile(join(ext, "inc/h.h"), "#define X 1\n"); await chmod(join(ext, "inc/h.h"), 0o644);
  await symlink("a.txt", join(root, "link-file"));
  await symlink("dir", join(root, "link-dir"));
  await symlink("inc", join(ext, "alias"));
  await symlink("../ext", join(root, "external"));
  await symlink("../ext/inc/h.h", join(root, "external-file"));
  await symlink("root", join(base, "rootlink"));
  return { root, ext };
}

// ---------------------------------------------------------------------------------------------------
// The primitive
// ---------------------------------------------------------------------------------------------------

test("readRegular reads bytes, mode and identity from one descriptor and closes it", async t => {
  const dir = await scratch(t, "primitive");
  const file = join(dir, "member");
  await writeFile(file, "exact bytes\n");
  await chmod(file, 0o640);
  const before = openDescriptorCount();
  const snapshot = readRegularSnapshot(file, { bindPath: true });
  assert.equal(snapshot.bytes.toString(), "exact bytes\n");
  assert.equal(snapshot.sha256, digest(Buffer.from("exact bytes\n")));
  assert.equal(snapshot.mode & 0o777, 0o640);
  assert.equal(snapshot.executable, false);
  if (before !== null) assert.equal(openDescriptorCount(), before);
});

test("readRegular fails closed on a link, special file, directory, missing or oversize member", async t => {
  const dir = await scratch(t, "types");
  await writeFile(join(dir, "target"), "t");
  await symlink("target", join(dir, "link"));
  await mkdir(join(dir, "directory"));
  sh(`mkfifo ${q(join(dir, "fifo"))}`);
  const before = openDescriptorCount();
  assert.throws(() => readRegularSnapshot(join(dir, "link")), /must not be a symbolic link/);
  assert.throws(() => readRegularSnapshot(join(dir, "directory")), /must be a regular file/);
  assert.throws(() => readRegularSnapshot(join(dir, "fifo")), /must be a regular file/);
  assert.throws(() => readRegularSnapshot(join(dir, "absent")), err => err.code === "ENOENT");
  assert.equal(readRegularSnapshot(join(dir, "absent"), { missingOk: true }), null);
  assert.throws(() => readRegularSnapshot(join(dir, "target"), { maxBytes: 0 }), /exceeds 0 bytes/);
  assert.equal(readRegularSnapshot(join(dir, "link"), { follow: true }).bytes.toString(), "t");
  if (before !== null) assert.equal(openDescriptorCount(), before);
});

test("readRegular detects truncation, growth, in-place change, replacement and removal", async t => {
  const dir = await scratch(t, "races");
  const file = join(dir, "member");
  const reset = async () => writeFile(file, "0123456789");
  const before = openDescriptorCount();

  await reset();
  assert.throws(() => createSnapshotReader({ afterOpen: () => sh(`: > ${q(file)}`) }).readRegular(file), /truncated/);
  await reset();
  assert.throws(() => createSnapshotReader({ afterOpen: () => sh(`printf more >> ${q(file)}`) }).readRegular(file), /grew/);
  await reset();
  assert.throws(() => createSnapshotReader({ afterRead: () => sh(`chmod 600 ${q(file)}`) }).readRegular(file), /changed while it was read/);
  await reset();
  const replace = () => sh(`printf evil > ${q(file)}.new && mv ${q(file)}.new ${q(file)}`);
  assert.throws(() => createSnapshotReader({ afterRead: replace }).readRegular(file, { bindPath: true }), RACE);
  await reset();
  // Even without path binding a replaced member fails closed rather than returning stale bytes.
  assert.throws(() => createSnapshotReader({ afterRead: replace }).readRegular(file), RACE);
  await reset();
  assert.throws(() => createSnapshotReader({ afterRead: () => sh(`rm ${q(file)}`) }).readRegular(file, { bindPath: true }), RACE);
  await reset();
  // A hard link that keeps the inode alive while a different file takes the name is caught by path binding.
  assert.throws(() => createSnapshotReader({ afterRead: () => sh(`ln ${q(file)} ${q(file)}.keep && printf evil > ${q(file)}.new && mv ${q(file)}.new ${q(file)}`) })
    .readRegular(file, { bindPath: true }), RACE);
  await rm(`${file}.keep`, { force: true });
  await reset();
  assert.throws(() => createSnapshotReader({ afterRead: () => sh(`mv ${q(file)} ${q(file)}.old && ln -s ${q(file)}.old ${q(file)}`) })
    .readRegular(file, { bindPath: true }), RACE);
  if (before !== null) assert.equal(openDescriptorCount(), before);
});

test("inspect lists a directory only while it is unchanged and still named by its path", async t => {
  const dir = await scratch(t, "directory");
  await writeFile(join(dir, "b"), "b");
  await writeFile(join(dir, "a"), "a");
  assert.deepEqual(defaultSnapshotReader.inspect(dir).entries, ["a", "b"]);
  assert.throws(() => createSnapshotReader({ afterRead: () => sh(`touch ${q(join(dir, "c"))}`) }).inspect(dir), /changed while it was read/);
  const swapped = createSnapshotReader({ afterRead: () => sh(`mv ${q(dir)} ${q(dir)}.old && mkdir ${q(dir)}`) });
  assert.throws(() => swapped.inspect(dir), RACE);
  sh(`rmdir ${q(dir)} && mv ${q(dir)}.old ${q(dir)}`);
});

test("writeRegular installs exact bytes and mode, replaces rather than follows a link, and leaves no temporary", async t => {
  const dir = await scratch(t, "write");
  const outside = join(dir, "outside");
  await writeFile(outside, "must not change");
  const dest = join(dir, "installed");
  await symlink(outside, dest);
  const before = openDescriptorCount();
  const written = defaultSnapshotReader.writeRegular(dest, Buffer.from("captured"), 0o644);
  assert.equal(written.bytes.toString(), "captured");
  assert.equal(await readFile(outside, "utf8"), "must not change");
  assert.equal(readRegularSnapshot(dest).mode & 0o777, 0o644);
  assert.deepEqual(readdirSync(dir).sort(), ["installed", "outside"]);
  if (before !== null) assert.equal(openDescriptorCount(), before);
  // A writer that alters the installed member while it is verified is detected.
  const tampered = createSnapshotReader({ afterRead: oneShot(({ path }) => sh(`chmod 600 ${q(path)}`)) });
  assert.throws(() => tampered.writeRegular(dest, Buffer.from("captured"), 0o644), /changed while it was read/);
});

// ---------------------------------------------------------------------------------------------------
// Flow 1: tools/build-receipt.mjs (native executable check)
// ---------------------------------------------------------------------------------------------------

test("flow build-receipt: mode and target header come from one descriptor bound to the payload path", async t => {
  const dir = await scratch(t, "receipt");
  const executable = join(dir, "theme-forge-nebular-fusion");
  await writeFile(executable, elf("arm64"));
  await chmod(executable, 0o755);
  assert.equal(measureNativeExecutable(executable, LINUX_ARM64).bytes.length, 64);

  await chmod(executable, 0o644);
  assert.throws(() => measureNativeExecutable(executable, LINUX_ARM64), /Native output is not executable/);
  await chmod(executable, 0o755);
  assert.throws(() => measureNativeExecutable(executable, DARWIN), /target mismatch/);

  // An executable that is swapped after it is checked is rejected instead of being re-read by name.
  const swap = createSnapshotReader({ afterRead: () => sh(`cp ${q(executable)} ${q(executable)}.x && chmod 755 ${q(executable)}.x && mv ${q(executable)}.x ${q(executable)}`) });
  assert.throws(() => measureNativeExecutable(executable, LINUX_ARM64, swap), RACE);
  // A link planted at the payload path is never followed.
  await rename(executable, `${executable}.real`);
  await symlink(`${executable}.real`, executable);
  assert.throws(() => measureNativeExecutable(executable, LINUX_ARM64), /not a symbolic link/);
  // Truncation between the descriptor stat and the read is a short read, not a partial header.
  await unlink(executable);
  await rename(`${executable}.real`, executable);
  const truncating = createSnapshotReader({ afterOpen: () => sh(`: > ${q(executable)}`) });
  assert.throws(() => measureNativeExecutable(executable, LINUX_ARM64, truncating), /truncated/);
});

// ---------------------------------------------------------------------------------------------------
// Flow 2: tools/build-settings.mjs inventoryPath (locator tree inventory)
// ---------------------------------------------------------------------------------------------------

test("flow build-settings inventory: identities are byte-compatible with the pre-repair implementation", async t => {
  const base = await scratch(t, "inventory-pin");
  const { root, ext } = await locatorFixture(base);
  assert.equal((await inventoryPath(root)).identity, PINNED_INVENTORY.root);
  assert.equal((await inventoryPath(join(base, "rootlink"))).identity, PINNED_INVENTORY.root);
  assert.equal((await inventoryPath(join(root, "bin/tool"))).identity, PINNED_INVENTORY.file);
  assert.equal((await inventoryPath(ext)).identity, PINNED_INVENTORY.ext);
  assert.equal((await inventoryLocator(`${root}:${ext}`, true)).identity, PINNED_INVENTORY.multi);
});

test("flow build-settings inventory: members changed during measurement fail closed", async t => {
  const base = await scratch(t, "inventory-race");
  const { root } = await locatorFixture(base);
  const target = join(root, "dir/nested.txt");
  const before = openDescriptorCount();

  const onNested = fn => ({ path, ...rest }) => { if (path === target) fn({ path, ...rest }); };
  await assert.rejects(inventoryPath(root, { reader: createSnapshotReader({ afterOpen: onNested(() => sh(`printf x >> ${q(target)}`)) }) }), /grew|changed/);
  await writeFile(target, "nested\n");
  await assert.rejects(inventoryPath(root, { reader: createSnapshotReader({ afterRead: onNested(() => sh(`printf evil > ${q(target)}.n && mv ${q(target)}.n ${q(target)}`)) }) }), RACE);
  await writeFile(target, "nested\n");
  await chmod(target, 0o600);
  // A directory that gains a member while it is listed is rejected.
  const dirPath = join(root, "dir");
  await assert.rejects(inventoryPath(root, { reader: createSnapshotReader({ afterRead: ({ path }) => { if (path === dirPath) sh(`touch ${q(join(dirPath, "late"))}`); } }) }), /changed while it was read/);
  await rm(join(dirPath, "late"), { force: true });
  // A member swapped for a link between name resolution and open is never followed.
  const plantAt = createSnapshotReader({ beforeOpen: ({ path }) => { if (path === target && !existsSync(`${target}.moved`)) sh(`mv ${q(target)} ${q(target)}.moved && ln -s ${q(join(base, "ext/inc/h.h"))} ${q(target)}`); } });
  await assert.rejects(inventoryPath(root, { reader: plantAt }), /must not be a symbolic link/);
  await unlink(target);
  await rename(`${target}.moved`, target);
  assert.equal((await inventoryPath(root)).identity, PINNED_INVENTORY.root);
  if (before !== null) assert.equal(openDescriptorCount(), before);
});

// ---------------------------------------------------------------------------------------------------
// Flow 3: tools/build-settings.mjs validateBuildSettings (cargoHome configuration)
// ---------------------------------------------------------------------------------------------------

test("flow build-settings cargoHome: configuration is bound by its descriptor bytes and fails closed", async t => {
  const dir = await scratch(t, "cargo-home");
  const officialConfig = join(dir, "official.toml");
  await writeFile(officialConfig, "[build]\njobs = 4\n");
  const settings = await createBuildSettings({ cargoConfig: officialConfig });
  const cargoHome = join(dir, "home");
  await mkdir(cargoHome);
  const execution = { cargoHome, cargoConfig: officialConfig };

  await validateBuildSettings(settings, execution);
  await writeFile(join(cargoHome, "config.toml"), "[build]\njobs = 4\n");
  await validateBuildSettings(settings, execution);
  await writeFile(join(cargoHome, "config.toml"), "unbound = true\n");
  await assert.rejects(validateBuildSettings(settings, execution), /bypasses bound settings/);

  // A link at the configuration name is not followed, even to identical bytes.
  await rm(join(cargoHome, "config.toml"));
  await symlink(officialConfig, join(cargoHome, "config.toml"));
  await assert.rejects(validateBuildSettings(settings, execution), /must not be a symbolic link/);
  await rm(join(cargoHome, "config.toml"));

  // Replacement after the bound bytes are read is detected rather than compared by name again.
  const config = join(cargoHome, "config");
  await writeFile(config, "[build]\njobs = 4\n");
  const swap = createSnapshotReader({ afterRead: ({ path }) => { if (path === config) sh(`printf 'unbound = true\\n' > ${q(config)}.n && mv ${q(config)}.n ${q(config)}`); } });
  await assert.rejects(validateBuildSettings(settings, execution, { reader: swap }), RACE);
  await writeFile(config, "[build]\njobs = 4\n");
  const shrink = createSnapshotReader({ afterOpen: ({ path }) => { if (path === config) sh(`: > ${q(config)}`); } });
  await assert.rejects(validateBuildSettings(settings, execution, { reader: shrink }), /truncated/);
  await rm(config);

  // An unreadable configuration was previously treated as absent; it now fails closed.
  if (process.getuid?.() !== 0) {
    await writeFile(join(cargoHome, "config.toml"), "unbound = true\n");
    await chmod(join(cargoHome, "config.toml"), 0o000);
    await assert.rejects(validateBuildSettings(settings, execution), err => err.code === "EACCES");
    await chmod(join(cargoHome, "config.toml"), 0o644);
  }
});

// ---------------------------------------------------------------------------------------------------
// Flow 4: tools/create-build-inputs.mjs toolchain identity
// ---------------------------------------------------------------------------------------------------

test("flow create-build-inputs: toolchain identity is measured through one descriptor bound to its locator", async t => {
  const dir = await scratch(t, "toolchain");
  const tool = join(dir, "rustc");
  await writeFile(tool, "#!/bin/sh\n");
  await chmod(tool, 0o755);
  assert.equal(await toolchainIdentity(tool), digest(Buffer.from("#!/bin/sh\n")));
  // Toolchain proxies are links; the referent is measured.
  await symlink(tool, join(dir, "proxy"));
  assert.equal(await toolchainIdentity(join(dir, "proxy")), digest(Buffer.from("#!/bin/sh\n")));
  // A directory is inventoried while its descriptor is held.
  const sysroot = join(dir, "sysroot");
  await mkdir(join(sysroot, "lib"), { recursive: true });
  await writeFile(join(sysroot, "lib/libstd.rlib"), "rlib");
  const expected = await toolchainIdentity(sysroot);
  assert.match(expected, /^[a-f0-9]{64}$/);

  const swap = createSnapshotReader({ afterRead: () => sh(`printf evil > ${q(tool)}.n && mv ${q(tool)}.n ${q(tool)}`) });
  await assert.rejects(toolchainIdentity(tool, { reader: swap }), RACE);
  await writeFile(tool, "#!/bin/sh\n");
  const retarget = createSnapshotReader({ afterRead: () => sh(`ln -sfn ${q(join(dir, "other"))} ${q(join(dir, "proxy"))}`) });
  await writeFile(join(dir, "other"), "other");
  await assert.rejects(toolchainIdentity(join(dir, "proxy"), { reader: retarget }), RACE);
  const mutate = createSnapshotReader({ afterOpen: ({ path }) => { if (path === sysroot) sh(`touch ${q(join(sysroot, "late"))}`); } });
  await assert.rejects(toolchainIdentity(sysroot, { reader: mutate }), RACE);
  sh(`mkfifo ${q(join(dir, "fifo"))}`);
  await assert.rejects(toolchainIdentity(join(dir, "fifo")), /must be a regular file/);
});

// ---------------------------------------------------------------------------------------------------
// Flows 5-8: tools/finalize-darwin-bundle.mjs LICENSE and NOTICE (source capture and destination)
// ---------------------------------------------------------------------------------------------------

async function bundleFixture(t, name) {
  const dir = await scratch(t, name);
  const studioRoot = join(dir, "studio");
  const app = join(dir, "Theme Forge Nebular Fusion.app");
  await mkdir(studioRoot, { recursive: true });
  await mkdir(join(app, "Contents/MacOS"), { recursive: true });
  await writeFile(join(studioRoot, "LICENSE"), "AGPL license\n");
  await writeFile(join(studioRoot, "NOTICE"), "Nebular notice\n");
  return { dir, studioRoot, app };
}

for (const name of ["LICENSE", "NOTICE"]) {
  test(`flow finalize ${name}: installs exactly the captured source bytes and fails closed if the source is replaced`, async t => {
    const { studioRoot, app } = await bundleFixture(t, `capture-${name}`);
    const source = join(studioRoot, name);
    const original = await readFile(source);
    const before = openDescriptorCount();
    let fired = 0;
    const reader = createSnapshotReader({ afterRead: ({ path }) => {
      if (path === source) { fired += 1; sh(`printf evil > ${q(source)}.n && mv ${q(source)}.n ${q(source)}`); }
    } });
    await assert.rejects(finalizeDarwinAppBundle({ app, productTarget: DARWIN, studioRoot, skipSigning: true, reader }), RACE);
    assert.equal(fired, 1, "the race is injected on the source descriptor");
    assert.equal(existsSync(join(app, "Contents/Resources", name)), false, "nothing is installed from a replaced source");
    if (before !== null) assert.equal(openDescriptorCount(), before);
    await writeFile(source, original);
    // Undisturbed, the destination carries exactly the opened source bytes with the fixed mode.
    let observed = 0;
    await finalizeDarwinAppBundle({ app, productTarget: DARWIN, studioRoot, skipSigning: true,
      reader: createSnapshotReader({ afterRead: ({ path }) => { if (path === source) observed += 1; } }) });
    assert.equal(observed, 1, "the source is opened and read exactly once");
    const installed = readRegularSnapshot(join(app, "Contents/Resources", name));
    assert.deepEqual(installed.bytes, original);
    assert.equal(installed.mode & 0o777, 0o644);
  });

  test(`flow finalize ${name}: a source link, special file, truncation or growth fails before anything is installed`, async t => {
    const { dir, studioRoot, app } = await bundleFixture(t, `source-${name}`);
    const source = join(studioRoot, name);
    const installed = join(app, "Contents/Resources", name);
    await rename(source, join(dir, `${name}.real`));
    await symlink(join(dir, `${name}.real`), source);
    await assert.rejects(finalizeDarwinAppBundle({ app, productTarget: DARWIN, studioRoot, skipSigning: true }), /must be a regular non-symlink file/);
    assert.equal(existsSync(installed), false);
    await unlink(source);
    await rename(join(dir, `${name}.real`), source);
    for (const [hook, pattern] of [
      [{ afterOpen: ({ path }) => { if (path === source) sh(`: > ${q(source)}`); } }, /truncated/],
      [{ afterOpen: ({ path }) => { if (path === source) sh(`printf more >> ${q(source)}`); } }, /grew/],
    ]) {
      await assert.rejects(finalizeDarwinAppBundle({ app, productTarget: DARWIN, studioRoot, skipSigning: true, reader: createSnapshotReader(hook) }), pattern);
      assert.equal(existsSync(installed), false);
      await writeFile(source, name === "LICENSE" ? "AGPL license\n" : "Nebular notice\n");
    }
    await rm(source);
    await mkdir(source);
    await assert.rejects(finalizeDarwinAppBundle({ app, productTarget: DARWIN, studioRoot, skipSigning: true }), /must be a regular non-symlink file/);
  });

  test(`flow finalize ${name}: a planted destination link is replaced, and a tampered destination is detected`, async t => {
    const { dir, studioRoot, app } = await bundleFixture(t, `dest-${name}`);
    const outside = join(dir, "outside");
    await writeFile(outside, "unrelated");
    await mkdir(join(app, "Contents/Resources"), { recursive: true });
    const destination = join(app, "Contents/Resources", name);
    await symlink(outside, destination);
    await finalizeDarwinAppBundle({ app, productTarget: DARWIN, studioRoot, skipSigning: true });
    assert.equal(await readFile(outside, "utf8"), "unrelated");
    assert.deepEqual(readRegularSnapshot(destination).bytes, await readFile(join(studioRoot, name)));
    let tampered = 0;
    const tamper = createSnapshotReader({ afterRead: ({ path }) => { if (path === destination) { tampered += 1; sh(`chmod 600 ${q(destination)}`); } } });
    await assert.rejects(finalizeDarwinAppBundle({ app, productTarget: DARWIN, studioRoot, skipSigning: true, reader: tamper }), RACE);
    assert.equal(tampered, 1);
  });
}

test("flow finalize: a missing notice is reported with the maintained message", async t => {
  const { studioRoot, app } = await bundleFixture(t, "missing");
  await unlink(join(studioRoot, "NOTICE"));
  await assert.rejects(finalizeDarwinAppBundle({ app, productTarget: DARWIN, studioRoot, skipSigning: true }), /Required NOTICE file missing/);
  await writeFile(join(studioRoot, "NOTICE"), "restored\n");
  await finalizeDarwinAppBundle({ app, productTarget: DARWIN, studioRoot, skipSigning: true });
});

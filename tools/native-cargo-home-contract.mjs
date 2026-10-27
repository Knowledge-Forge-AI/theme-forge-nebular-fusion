import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(`native cargo home contract: ${message}`);
}

function overlaps(first, second) {
  const a = relative(resolve(first), resolve(second));
  const b = relative(resolve(second), resolve(first));
  const firstContainsSecond = a === "" || (!a.startsWith("..") && !isAbsolute(a));
  const secondContainsFirst = b === "" || (!b.startsWith("..") && !isAbsolute(b));
  return firstContainsSecond || secondContainsFirst;
}

function ownerUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/**
 * Compute the caller-authenticated identity for an opaque existing Cargo-home
 * root without opening any cache member.  The owner binds this token to the
 * exact real path and directory descriptor before invoking the builder.
 * @param {string} path
 * @param {import("node:fs").Stats} descriptor
 * @returns {string}
 */
export function workingCargoHomeMetadataIdentity(path, descriptor) {
  const fields = {
    path: resolve(path),
    dev: descriptor.dev,
    ino: descriptor.ino,
    uid: descriptor.uid,
    gid: descriptor.gid,
    mode: descriptor.mode & 0o777,
    size: descriptor.size,
    mtimeMs: descriptor.mtimeMs,
    ctimeMs: descriptor.ctimeMs,
  };
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/**
 * Select the Cargo home for the maintained native builder.
 *
 * With no workingCargoHome, the caller receives the current default child and
 * the existing copy behavior remains unchanged. With an explicit home, this
 * function performs only read-only custody checks and returns that existing
 * directory directly; it never creates, removes, copies, chmods, rewrites, or
 * inventories a Cargo cache. The caller-authenticated identity binds the
 * exact real path and descriptor; cache members remain opaque to this seam.
 */
export async function chooseNativeCargoHome({
  workingCargoHome,
  workingCargoHomeIdentity,
  defaultCargoHome,
  outputRoots = [],
  inputRoots = [],
  expectedCargoConfig,
}) {
  if (typeof defaultCargoHome !== "string" || !isAbsolute(defaultCargoHome)) fail("defaultCargoHome must be absolute");
  if (workingCargoHome === undefined) {
    return {
      mode: "default-copy",
      cargoHome: defaultCargoHome,
      defaultCargoHome,
      createdByCurrentBuilder: true,
    };
  }
  if (typeof workingCargoHome !== "string" || !isAbsolute(workingCargoHome)) fail("workingCargoHome must be absolute");
  if (typeof workingCargoHomeIdentity !== "string" || !SHA256.test(workingCargoHomeIdentity)) {
    fail("workingCargoHomeIdentity is required for an explicit home");
  }
  if (typeof expectedCargoConfig !== "string") fail("expectedCargoConfig is required for an explicit home");

  let locator;
  try {
    locator = await lstat(workingCargoHome);
  } catch (error) {
    fail(`workingCargoHome is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (locator.isSymbolicLink()) fail("workingCargoHome locator may not be a symlink");
  if (!locator.isDirectory()) fail("workingCargoHome must be a directory");
  const home = await realpath(workingCargoHome);
  const uid = ownerUid();
  if (uid !== null && locator.uid !== uid) fail(`workingCargoHome owner ${locator.uid} does not match caller ${uid}`);
  if ((locator.mode & 0o022) !== 0) fail("workingCargoHome is group/other writable");
  const actualIdentity = workingCargoHomeMetadataIdentity(home, locator);
  if (actualIdentity !== workingCargoHomeIdentity) fail("workingCargoHome owner binding identity mismatch");

  for (const root of [...outputRoots, ...inputRoots]) {
    if (typeof root !== "string" || !isAbsolute(root)) fail("overlap roots must be absolute");
    const rootPath = await realpath(root).catch(() => resolve(root));
    if (overlaps(rootPath, home)) {
      fail(`workingCargoHome overlaps protected root: ${root}`);
    }
  }

  const configPath = join(home, "config.toml");
  const configInfo = await lstat(configPath).catch(() => null);
  if (!configInfo || configInfo.isSymbolicLink() || !configInfo.isFile()) fail("workingCargoHome/config.toml must be a regular file");
  const config = await readFile(configPath, "utf8");
  if (config !== expectedCargoConfig) fail("workingCargoHome config does not match the authenticated build settings");

  return {
    mode: "direct-existing",
    cargoHome: home,
    defaultCargoHome,
    workingCargoHomeIdentity,
    createdByCurrentBuilder: false,
    configPath,
    ownerUid: locator.uid,
    modeBits: locator.mode & 0o777,
  };
}


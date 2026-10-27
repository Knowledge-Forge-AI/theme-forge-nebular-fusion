import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_CARGO_CONFIG_BYTES = 1024 * 1024;
const CARGO_CONFIG_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

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

/** @param {import("node:fs").BigIntStats} stat @returns {(string|number)[]} */
function descriptorFrame(stat) {
  return [
    String(stat.dev),
    String(stat.ino),
    Number(stat.size),
    Number(stat.mode),
    String(stat.mtimeNs),
    String(stat.ctimeNs),
    Number(stat.uid),
    Number(stat.gid),
    Number(stat.nlink),
  ];
}

/** @param {(string|number)[]} left @param {(string|number)[]} right */
function sameDescriptor(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Reads one existing regular file through the opened descriptor.  The leaf
 * path is checked only as a named-path identity bookend; cache members remain
 * opaque and are never enumerated or opened by this contract.
 * @param {string} bindPath
 * @param {number} maxBytes
 * @returns {Promise<{ buffer: Buffer, bytes: number, mode: number, full9: (string|number)[] }>}
 */
async function readRegularSnapshot(bindPath, maxBytes) {
  let fh;
  /** @type {(string|number)[] | null} */
  let openedFrame = null;
  try {
    fh = await open(bindPath, CARGO_CONFIG_READ_FLAGS);
  } catch (error) {
    const fsError = /** @type {NodeJS.ErrnoException} */ (error);
    if (fsError.code === "ELOOP" || fsError.code === "EMLINK") fail("config.toml must be a regular file, not a symbolic link");
    throw error;
  }
  try {
    const opened = await fh.stat({ bigint: true });
    if (!opened.isFile()) fail("config.toml must be a regular file");
    if (Number(opened.nlink) !== 1) fail("config.toml hardlinks are not accepted");
    if ((Number(opened.mode) & 0o7000) !== 0) fail("config.toml has unexpected privilege bits");
    const size = Number(opened.size);
    if (size < 0 || size > maxBytes) fail(`config.toml exceeds byte limit (${size} > ${maxBytes})`);
    const beforeFrame = descriptorFrame(opened);
    openedFrame = beforeFrame;
    const namedBefore = await lstat(bindPath, { bigint: true });
    if (namedBefore.isSymbolicLink() || !namedBefore.isFile() || !sameDescriptor(descriptorFrame(namedBefore), beforeFrame)) {
      fail("config.toml named path changed during open");
    }

    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await fh.read(buffer, offset, size - offset, offset);
      if (bytesRead === 0) fail("config.toml was truncated during read");
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const { bytesRead: extraRead } = await fh.read(extra, 0, 1, offset);
    if (extraRead > 0) fail("config.toml grew during read");
    const ended = await fh.stat({ bigint: true });
    if (!sameDescriptor(descriptorFrame(ended), beforeFrame)) fail("config.toml descriptor changed during read");
    const namedAfterRead = await lstat(bindPath, { bigint: true });
    if (namedAfterRead.isSymbolicLink() || !namedAfterRead.isFile() || !sameDescriptor(descriptorFrame(namedAfterRead), beforeFrame)) {
      fail("config.toml named path changed during read");
    }
    return { buffer, bytes: size, mode: Number(opened.mode) & 0o777, full9: beforeFrame };
  } finally {
    await fh.close();
    const afterNamed = await lstat(bindPath, { bigint: true });
    if (openedFrame && (afterNamed.isSymbolicLink() || !afterNamed.isFile() || !sameDescriptor(descriptorFrame(afterNamed), openedFrame))) {
      fail("config.toml named path changed after close");
    }
  }
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
  const configSnapshot = await readRegularSnapshot(configPath, MAX_CARGO_CONFIG_BYTES);
  const config = configSnapshot.buffer.toString("utf8");
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


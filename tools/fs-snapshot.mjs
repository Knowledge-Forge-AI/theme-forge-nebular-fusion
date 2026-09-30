// Descriptor-bound filesystem snapshots for build and release tooling.
//
// A pathname is opened exactly once. Type, size, mode and identity come from that descriptor, bytes
// are read through it, and the descriptor must still describe the same object afterwards. Nothing is
// checked by pathname and then re-read or re-copied by pathname. Where the pathname itself must
// remain bound (a bundle member, a toolchain locator), the caller asks for bindPath and the pathname
// must still name the opened inode after the read.
//
// Every failure closes the descriptor and fails closed: a symbolic link where none is allowed, a
// replaced or disappearing member, a short read, growth, or a type or mode change.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, renameSync, statSync,
  unlinkSync, writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const NOFOLLOW_READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const FOLLOW_READ = constants.O_RDONLY | constants.O_NONBLOCK;
const CREATE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function descriptorIdentity(stat) {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mode: stat.mode, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

export function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameObject(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function message(messages, key, fallback) {
  const value = messages?.[key];
  return typeof value === "function" ? value() : value ?? fallback;
}

// Hooks exist only for deterministic race tests: they run just before the open, after the descriptor
// is opened and after its bytes (or directory entries) are read, which is exactly where a concurrent
// writer would act. Production callers use the default reader, which has none.
export function createSnapshotReader(hooks = {}) {
  const beforeOpen = hooks.beforeOpen ?? (() => {});
  const afterOpen = hooks.afterOpen ?? (() => {});
  const afterRead = hooks.afterRead ?? (() => {});

  function open(path, { follow = false, label = "File", messages = {}, missingOk = false } = {}) {
    let fd;
    beforeOpen({ path });
    try {
      fd = openSync(path, follow ? FOLLOW_READ : NOFOLLOW_READ);
    } catch (error) {
      if (error?.code === "ENOENT" && missingOk) return null;
      if (error?.code === "ENOENT") throw Object.assign(new Error(message(messages, "missing", `${label} is missing: ${path}`)), { code: "ENOENT" });
      if (error?.code === "ELOOP" || error?.code === "EMLINK") {
        throw Object.assign(new Error(message(messages, "symlink", `${label} must not be a symbolic link: ${path}`)), { code: "ELOOP" });
      }
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      afterOpen({ path, fd, stat });
      return { fd, stat };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  function requireUnchanged(fd, stat, path, { follow, bindPath, label, messages }) {
    if (!sameIdentity(descriptorIdentity(stat), descriptorIdentity(fstatSync(fd)))) {
      throw new Error(message(messages, "changed", `${label} changed while it was read: ${path}`));
    }
    if (bindPath) {
      let named;
      try {
        named = follow ? statSync(path) : lstatSync(path);
      } catch (error) {
        if (error?.code === "ENOENT") throw new Error(message(messages, "replaced", `${label} was removed while it was read: ${path}`));
        throw error;
      }
      if (named.isSymbolicLink() || !sameObject(named, stat)) {
        throw new Error(message(messages, "replaced", `${label} was replaced while it was read: ${path}`));
      }
    }
  }

  function readOpened(fd, stat, path, options) {
    const { label = "File", messages = {}, maxBytes = DEFAULT_MAX_BYTES } = options;
    if (stat.size > maxBytes) throw new Error(message(messages, "tooLarge", `${label} exceeds ${maxBytes} bytes: ${path}`));
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error(message(messages, "truncated", `${label} was truncated while it was read: ${path}`));
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) throw new Error(message(messages, "grew", `${label} grew while it was read: ${path}`));
    afterRead({ path, fd, stat });
    requireUnchanged(fd, stat, path, { label, messages, bindPath: options.bindPath, follow: options.follow });
    return bytes;
  }

  function snapshotOf(bytes, stat) {
    return { bytes, sha256: sha256(bytes), size: stat.size, mode: stat.mode & 0o7777, executable: Boolean(stat.mode & 0o111), identity: descriptorIdentity(stat) };
  }

  /**
   * Read one regular file through a single descriptor.
   * @param {string} path
   * @param {{ follow?: boolean, bindPath?: boolean, missingOk?: boolean, maxBytes?: number, label?: string, messages?: object }} [options]
   */
  function readRegular(path, options = {}) {
    const opened = open(path, options);
    if (!opened) return null;
    const { fd, stat } = opened;
    try {
      if (!stat.isFile()) throw new Error(message(options.messages, "notRegular", `${options.label ?? "File"} must be a regular file: ${path}`));
      return snapshotOf(readOpened(fd, stat, path, options), stat);
    } finally {
      closeSync(fd);
    }
  }

  /** Type and identity of a member from its own descriptor, without reading its bytes. */
  function describe(path, options = {}) {
    const opened = open(path, options);
    if (!opened) return null;
    const { fd, stat } = opened;
    try {
      const type = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
      if (type === "other") throw new Error(message(options.messages, "unsupported", `${options.label ?? "Member"} has an unsupported type: ${path}`));
      return { type, size: stat.size, mode: stat.mode & 0o7777, identity: descriptorIdentity(stat) };
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Open a member once and describe it from the descriptor: a regular file is read through the
   * descriptor; a directory is listed and must be unchanged (and still named by path) afterwards.
   * Node cannot list a directory through a descriptor, so the listing is bracketed by descriptor and
   * pathname identity checks instead.
   */
  function inspect(path, options = {}) {
    const opened = open(path, options);
    if (!opened) return null;
    const { fd, stat } = opened;
    try {
      if (stat.isFile()) return { type: "file", ...snapshotOf(readOpened(fd, stat, path, options), stat) };
      if (stat.isDirectory()) {
        const entries = readdirSync(path).sort();
        afterRead({ path, fd, stat });
        requireUnchanged(fd, stat, path, { ...options, label: options.label ?? "Directory", bindPath: true });
        return { type: "directory", entries, mode: stat.mode & 0o7777, identity: descriptorIdentity(stat) };
      }
      throw new Error(message(options.messages, "unsupported", `${options.label ?? "Member"} has an unsupported type: ${path}`));
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Hold a descriptor while a caller measures the object by other means, then require that the
   * descriptor and pathname still name the object that was opened.
   */
  function withBound(path, options, use) {
    const opened = open(path, options);
    if (!opened) return null;
    const { fd, stat } = opened;
    try {
      const type = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
      // read() returns the bytes of this same descriptor; there is no second open of the path.
      const read = () => {
        if (type !== "file") throw new Error(message(options.messages, "notRegular", `${options.label ?? "File"} must be a regular file: ${path}`));
        return snapshotOf(readOpened(fd, stat, path, options), stat);
      };
      return Promise.resolve(use({ fd, stat, type, read }))
        .then(result => {
          requireUnchanged(fd, stat, path, { ...options, label: options.label ?? "Member", bindPath: true });
          return result;
        })
        .finally(() => closeSync(fd));
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  /**
   * Install bytes at dest with an exact mode: write an exclusively created sibling through its own
   * descriptor, set the mode on that descriptor, sync, and rename over dest (a symlink at dest is
   * replaced, never followed). The installed member is then re-read without following links and must
   * be a regular file with exactly these bytes and this mode.
   */
  function writeRegular(dest, bytes, mode, options = {}) {
    const label = options.label ?? "Destination";
    const temporary = join(dirname(dest), `.${basename(dest)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    const fd = openSync(temporary, CREATE_NEW, mode);
    let installed = false;
    try {
      try {
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
        fchmodSync(fd, mode);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, dest);
      installed = true;
    } finally {
      if (!installed) {
        try { unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
    }
    const written = readRegular(dest, { label, messages: options.messages, maxBytes: Math.max(bytes.length, 1) });
    if ((written.mode & 0o777) !== mode) throw new Error(message(options.messages, "mode", `${label} is not a regular file with mode ${mode.toString(8).padStart(4, "0")}: ${dest}`));
    if (!written.bytes.equals(bytes)) throw new Error(message(options.messages, "bytes", `${label} bytes do not match the captured source: ${dest}`));
    return written;
  }

  return Object.freeze({ readRegular, describe, inspect, withBound, writeRegular });
}

export const defaultSnapshotReader = createSnapshotReader();
export const readRegularSnapshot = defaultSnapshotReader.readRegular;
export const describeSnapshot = defaultSnapshotReader.describe;
export const inspectSnapshot = defaultSnapshotReader.inspect;
export const withBoundSnapshot = defaultSnapshotReader.withBound;
export const writeRegularFromSnapshot = defaultSnapshotReader.writeRegular;

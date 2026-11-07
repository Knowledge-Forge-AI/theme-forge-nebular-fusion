// @ts-check

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * This is the one maintained product-side inventory for the paired-v2 adapter
 * resource.  The Rust runtime has the same bytes through include_bytes!; this
 * module exists to catch a missing or altered source/package member before a
 * native build or launch.  It intentionally never copies from a sibling
 * checkout, package cache, or user-selected path.
 */
export const PAIRED_V2_ADAPTER_SCHEMA = "nebular.paired-v2-adapter-closure-v1";
export const PAIRED_V2_ADAPTER_DIRECTORY = "solar-sail-adapter";

/** @typedef {{path: string, bytes: number, sha256: string}} AdapterMember */

/** @type {readonly AdapterMember[]} */
export const PAIRED_V2_ADAPTER_INVENTORY = Object.freeze([
  Object.freeze({
    path: "appearance-inputs.json",
    bytes: 376,
    sha256: "532ac9051f4cabdc6216609e6e061be9029455a92ee60ab1998257731b341c69",
  }),
  Object.freeze({
    path: "common-appearance-recipe.mjs",
    bytes: 25_026,
    sha256: "4dbd64a4bf1739e3f809c9d5a27e0334d2344140e55e4af25272b5ef9c752f06",
  }),
  Object.freeze({
    path: "common-sttn-template.json",
    bytes: 11_161,
    sha256: "436e278cdbe3a37e06048504df3897d65230318f17b7ebd754060c2866703324",
  }),
  Object.freeze({
    path: "paired-v2-adapter.mjs",
    bytes: 5_601,
    sha256: "aaad826832616abc7e84eb72fbf2a17b94950de7afaaafd3df72b01b43fc8ded",
  }),
  Object.freeze({
    path: "paired-v2-binding.json",
    bytes: 1_494,
    sha256: "259218ceef1575b15676ccd68096710343b46d1f97d5d7ee6aa83ab2126b03b3",
  }),
  Object.freeze({
    path: "paired-v2-compile.mjs",
    bytes: 35_378,
    sha256: "b550536ab1b446200f9debd066365ba518685c259bbd501091af59d85f1ac53a",
  }),
  Object.freeze({
    path: "solar-sail-adapter.mjs",
    bytes: 28_998,
    sha256: "d128b824f444d60da1404622f3698d33f09a17a58aed9b3289fd24d805901276",
  }),
]);

const MAX_MEMBER_BYTES = 8 * 1024 * 1024;
const EXPECTED_MEMBER_NAMES = new Set(PAIRED_V2_ADAPTER_INVENTORY.map((member) => member.path));
const EXPECTED_TOTAL_BYTES = PAIRED_V2_ADAPTER_INVENTORY.reduce((total, member) => total + member.bytes, 0);
const REAL_FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** @param {string} reason @returns {never} */
function fail(reason) {
  throw new Error(`[PAIRED_V2_ADAPTER_${reason}]`);
}

/** @param {Buffer} bytes */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @param {{dev?: number, ino?: number, size: number}} left @param {{dev?: number, ino?: number, size: number}} right */
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

/** @param {string} directory */
async function verifyRealAncestors(directory) {
  if (!isAbsolute(directory)) fail("ROOT_REJECTED");
  let current = directory;
  while (true) {
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      fail("ROOT_REJECTED");
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("ROOT_REJECTED");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** @param {string} filePath @param {AdapterMember} expected */
async function readExpectedMember(filePath, expected) {
  if (expected.bytes <= 0 || expected.bytes > MAX_MEMBER_BYTES) fail("CONTRACT_REJECTED");

  let handle;
  try {
    handle = await open(filePath, REAL_FILE_FLAGS);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      fail("MEMBER_MISSING");
    }
    fail("MEMBER_REJECTED");
  }

  try {
    let opened;
    try {
      opened = await handle.stat();
    } catch {
      fail("MEMBER_READ_FAILED");
    }
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1 || opened.size !== expected.bytes) {
      fail("MEMBER_REJECTED");
    }

    const bytes = Buffer.alloc(expected.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      let readResult;
      try {
        readResult = await handle.read(bytes, offset, bytes.length - offset, offset);
      } catch {
        fail("MEMBER_READ_FAILED");
      }
      if (readResult.bytesRead === 0) fail("MEMBER_CHANGED");
      offset += readResult.bytesRead;
    }

    const extra = Buffer.alloc(1);
    let extraResult;
    try {
      extraResult = await handle.read(extra, 0, 1, bytes.length);
    } catch {
      fail("MEMBER_READ_FAILED");
    }
    if (extraResult.bytesRead !== 0) fail("MEMBER_CHANGED");

    let after;
    try {
      after = await handle.stat();
    } catch {
      fail("MEMBER_CHANGED");
    }
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || !sameIdentity(opened, after)) {
      fail("MEMBER_CHANGED");
    }
    if (sha256(bytes) !== expected.sha256) fail("MEMBER_TAMPERED");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Verifies the fixed product adapter directory in place.  No output is
 * created, replaced, or removed.  The returned receipt contains only the
 * closed inventory and a deterministic identity; it never contains a path or
 * member bytes.
 *
 * @param {string} adapterDirectory Absolute `src-tauri/solar-sail-adapter` path.
 * @returns {Promise<{schema: string, directory: string, files: AdapterMember[], bytes: number, sha256: string}>}
 */
export async function verifyPairedV2AdapterDirectory(adapterDirectory) {
  if (!isAbsolute(adapterDirectory)) fail("ROOT_REJECTED");
  const directory = resolve(adapterDirectory);
  await verifyRealAncestors(directory);

  let rootBefore;
  try {
    rootBefore = await lstat(directory);
  } catch {
    fail("ROOT_REJECTED");
  }
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) fail("ROOT_REJECTED");

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    fail("ROOT_REJECTED");
  }
  const names = new Set();
  const lowerNames = new Set();
  for (const entry of entries) {
    const name = entry.name;
    const lowerName = name.toLowerCase();
    if (lowerNames.has(lowerName)) fail("CASE_COLLISION");
    lowerNames.add(lowerName);
    if (!entry.isFile() || entry.isSymbolicLink()) fail("MEMBER_REJECTED");
    names.add(name);
  }

  for (const name of names) {
    if (!EXPECTED_MEMBER_NAMES.has(name)) fail("MEMBER_EXTRA");
  }
  for (const expected of PAIRED_V2_ADAPTER_INVENTORY) {
    if (!names.has(expected.path)) fail("MEMBER_MISSING");
  }
  if (names.size !== PAIRED_V2_ADAPTER_INVENTORY.length) fail("MEMBER_EXTRA");

  for (const expected of PAIRED_V2_ADAPTER_INVENTORY) {
    await readExpectedMember(join(directory, expected.path), expected);
  }

  let rootAfter;
  try {
    rootAfter = await lstat(directory);
  } catch {
    fail("ROOT_CHANGED");
  }
  if (!sameIdentity(rootBefore, rootAfter) || !rootAfter.isDirectory() || rootAfter.isSymbolicLink()) {
    fail("ROOT_CHANGED");
  }

  const files = PAIRED_V2_ADAPTER_INVENTORY.map((member) => ({ ...member }));
  const inventoryIdentity = sha256(Buffer.from(files.map((member) => `${member.path}:${member.bytes}:${member.sha256}`).join("\n"), "utf8"));
  return {
    schema: PAIRED_V2_ADAPTER_SCHEMA,
    directory: PAIRED_V2_ADAPTER_DIRECTORY,
    files,
    bytes: EXPECTED_TOTAL_BYTES,
    sha256: inventoryIdentity,
  };
}


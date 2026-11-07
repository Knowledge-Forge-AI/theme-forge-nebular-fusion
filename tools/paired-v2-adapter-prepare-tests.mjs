// @ts-check

import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { cp, link, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TARGETS } from "./platform-targets.mjs";
import {
  PAIRED_V2_ADAPTER_DIRECTORY,
  PAIRED_V2_ADAPTER_INVENTORY,
  PAIRED_V2_ADAPTER_SCHEMA,
  verifyPairedV2AdapterDirectory,
} from "./paired-v2-adapter-prepare.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STUDIO_ROOT = resolve(__dirname, "..");
const MAINTAINED_ADAPTER = join(STUDIO_ROOT, "src-tauri", PAIRED_V2_ADAPTER_DIRECTORY);

describe("paired-v2 adapter closure", () => {
  /** @type {string | undefined} */
  let scratch;

  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "paired-v2-adapter-test-")));
  });

  afterEach(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  async function copyFixture(name) {
    assert.ok(scratch);
    const directory = join(scratch, name, PAIRED_V2_ADAPTER_DIRECTORY);
    await cp(MAINTAINED_ADAPTER, directory, { recursive: true });
    return directory;
  }

  test("accepts the maintained seven-file source closure", async () => {
    const directory = await copyFixture("source");
    const receipt = await verifyPairedV2AdapterDirectory(directory);

    assert.equal(receipt.schema, PAIRED_V2_ADAPTER_SCHEMA);
    assert.equal(receipt.directory, PAIRED_V2_ADAPTER_DIRECTORY);
    assert.equal(receipt.bytes, 108_034);
    assert.deepEqual(receipt.files, PAIRED_V2_ADAPTER_INVENTORY);
    assert.equal(receipt.files.length, 7);
    assert.equal(typeof receipt.sha256, "string");
    assert.equal(receipt.sha256.length, 64);
  });

  test("rejects a missing member without creating or deleting anything", async () => {
    const directory = await copyFixture("missing");
    await rm(join(directory, "paired-v2-adapter.mjs"));

    await assert.rejects(
      () => verifyPairedV2AdapterDirectory(directory),
      /\[PAIRED_V2_ADAPTER_MEMBER_MISSING\]/,
    );
    assert.equal(await readFile(join(directory, "paired-v2-compile.mjs"), "utf8").then((value) => value.length), 35_378);
  });

  test("rejects tampered bytes and preserves unrelated entries", async () => {
    const directory = await copyFixture("tampered");
    assert.ok(scratch);
    const foreign = join(scratch, "foreign.keep");
    await writeFile(foreign, "preserve me\n");
    const member = join(directory, "paired-v2-compile.mjs");
    const bytes = await readFile(member);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(member, bytes);

    await assert.rejects(
      () => verifyPairedV2AdapterDirectory(directory),
      /\[PAIRED_V2_ADAPTER_MEMBER_TAMPERED\]/,
    );
    assert.equal((await readFile(member)).length, 35_378);
    assert.equal(await readFile(foreign, "utf8"), "preserve me\n");
  });

  test("rejects unexpected and case-colliding entries without cleanup", async () => {
    const extraDirectory = await copyFixture("extra");
    const extra = join(extraDirectory, "unexpected.mjs");
    const foreign = join(extraDirectory, "foreign.keep");
    await writeFile(extra, "unexpected\n");
    await writeFile(foreign, "preserve me\n");
    await assert.rejects(
      () => verifyPairedV2AdapterDirectory(extraDirectory),
      /\[PAIRED_V2_ADAPTER_MEMBER_EXTRA\]/,
    );
    assert.equal(await readFile(extra, "utf8"), "unexpected\n");
    assert.equal(await readFile(foreign, "utf8"), "preserve me\n");

    const collisionDirectory = await copyFixture("collision");
    const collision = join(collisionDirectory, "Appearance-inputs.json");
    await writeFile(collision, "collision\n");
    const collisionNames = await readdir(collisionDirectory);
    if (collisionNames.includes(basename(collision))) {
      await assert.rejects(
        () => verifyPairedV2AdapterDirectory(collisionDirectory),
        /\[PAIRED_V2_ADAPTER_CASE_COLLISION\]/,
      );
      assert.equal(await readFile(collision, "utf8"), "collision\n");
    }
  });

  test("rejects member symlinks and ancestor symlinks", async () => {
    if (process.platform === "win32") return;

    await assert.rejects(
      () => verifyPairedV2AdapterDirectory("src-tauri/solar-sail-adapter"),
      /\[PAIRED_V2_ADAPTER_ROOT_REJECTED\]/,
    );

    const memberDirectory = await copyFixture("member-symlink");
    const target = join(memberDirectory, "paired-v2-adapter.mjs");
    const targetBytes = await readFile(target);
    await rm(target);
    const retainedTarget = join(memberDirectory, "retained-target.mjs");
    await writeFile(retainedTarget, targetBytes);
    await symlink(retainedTarget, target);
    await assert.rejects(
      () => verifyPairedV2AdapterDirectory(memberDirectory),
      /\[PAIRED_V2_ADAPTER_MEMBER_REJECTED\]/,
    );
    assert.equal((await readFile(retainedTarget)).length, 5_601);

    assert.ok(scratch);
    const realParent = join(scratch, "real-parent");
    const aliasParent = join(scratch, "alias-parent");
    const realDirectory = join(realParent, PAIRED_V2_ADAPTER_DIRECTORY);
    await cp(MAINTAINED_ADAPTER, realDirectory, { recursive: true });
    await symlink(realParent, aliasParent);
    await assert.rejects(
      () => verifyPairedV2AdapterDirectory(join(aliasParent, PAIRED_V2_ADAPTER_DIRECTORY)),
      /\[PAIRED_V2_ADAPTER_ROOT_REJECTED\]/,
    );
    assert.equal((await readFile(join(realDirectory, "paired-v2-binding.json"))).length, 1_494);
  });

  test("rejects a hard-linked member from the opened descriptor", async () => {
    if (process.platform === "win32") return;

    const directory = await copyFixture("hard-link");
    assert.ok(scratch);
    await link(
      join(directory, "paired-v2-adapter.mjs"),
      join(scratch, "paired-v2-adapter-shared.mjs"),
    );

    await assert.rejects(
      () => verifyPairedV2AdapterDirectory(directory),
      /\[PAIRED_V2_ADAPTER_MEMBER_REJECTED\]/,
    );
    assert.equal((await readFile(join(directory, "paired-v2-adapter.mjs"))).length, 5_601);
  });

  test("keeps prepared and packed inventories identical for all three target labels", async () => {
    const identities = new Set();
    for (const target of TARGETS) {
      assert.ok(scratch);
      const prepared = join(scratch, target.triple, "prepared", PAIRED_V2_ADAPTER_DIRECTORY);
      const packed = join(scratch, target.triple, "packed", PAIRED_V2_ADAPTER_DIRECTORY);
      await cp(MAINTAINED_ADAPTER, prepared, { recursive: true });
      await cp(MAINTAINED_ADAPTER, packed, { recursive: true });

      const preparedReceipt = await verifyPairedV2AdapterDirectory(prepared);
      const packedReceipt = await verifyPairedV2AdapterDirectory(packed);
      assert.deepEqual(packedReceipt.files, preparedReceipt.files);
      assert.equal(packedReceipt.bytes, preparedReceipt.bytes);
      assert.equal(packedReceipt.sha256, preparedReceipt.sha256);
      identities.add(`${target.triple}:${packedReceipt.sha256}`);
    }
    assert.equal(identities.size, TARGETS.length);
  });
});


import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scanShippedPaths } from "./scan-shipped-paths.mjs";

test("path policy scans binary/runtime/resource bytes including chunk boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "nebular-path-scan-"));
  const forbidden = "/fixture-personal/build-source";
  try {
    for (const member of ["gui", "runtime", "adapter.mjs", "manifest.json", "library.so"]) {
      await writeFile(join(root, member), Buffer.concat([Buffer.alloc(65530), Buffer.from(forbidden)]));
      await assert.rejects(scanShippedPaths(root, [forbidden]), /known build-path prefix/);
      await rm(join(root, member));
    }
    await writeFile(join(root, "allowed"), "/nix/store/declared-input/lib /usr/lib/system");
    assert.equal((await scanShippedPaths(root, [forbidden])).files, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source policy scans original and normalized locator spellings without changing defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "nebular-path-spellings-"));
  const original = "/fixture/transit/../external-vendor";
  try {
    const member = join(root, "resource.json");
    await writeFile(member, original);
    assert.equal((await scanShippedPaths(root, [original])).files, 1);
    await assert.rejects(scanShippedPaths(root, [original], { preserveSpellings: true }), /known build-path prefix/);
    await writeFile(member, "/fixture/external-vendor");
    await assert.rejects(scanShippedPaths(root, [original], { preserveSpellings: true }), /known build-path prefix/);
    await writeFile(member, "/cargo-input/stable/lib.rs");
    assert.equal((await scanShippedPaths(root, [original], { preserveSpellings: true })).files, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

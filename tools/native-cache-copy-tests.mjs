import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod, stat, symlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { populateNativeCaches } from "./native-candidate-build.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "native-cache-copy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, "work");
  for (const name of ["cargo-home", "npm-cache"]) await mkdir(join(work, name), { recursive: true });
  const execution = {};
  for (const name of ["cargoHome", "npmCache"]) {
    const cache = join(root, name);
    await mkdir(join(cache, "registry/nested"), { recursive: true });
    await writeFile(join(cache, "registry/nested/data"), name);
    await chmod(join(cache, "registry/nested/data"), 0o444);
    await symlink("registry/nested/data", join(cache, "linked-data"));
    execution[name] = cache;
  }
  return { work, execution };
}

test("populates both precreated homes with writable dereferenced children and preserves sources", async t => {
  const { work, execution } = await fixture(t);
  await populateNativeCaches(work, execution);
  for (const [name, destination] of [["cargoHome", "cargo-home"], ["npmCache", "npm-cache"]]) {
    const input = join(execution[name], "registry/nested/data");
    const output = join(work, destination, "registry/nested/data");
    assert.equal(await readFile(output, "utf8"), name);
    assert.ok((await stat(output)).mode & 0o200);
    assert.equal((await stat(input)).mode & 0o777, 0o444);
    assert.equal(await readFile(input, "utf8"), name);
    assert.equal((await lstat(join(work, destination, "linked-data"))).isSymbolicLink(), false);
    assert.equal((await lstat(join(execution[name], "linked-data"))).isSymbolicLink(), true);
  }
});

test("absent optional caches leave owned homes empty", async t => {
  const { work } = await fixture(t);
  await populateNativeCaches(work, {});
  assert.deepEqual(await readdir(join(work, "cargo-home")), []);
  assert.deepEqual(await readdir(join(work, "npm-cache")), []);
});

for (const [name, destination] of [["cargoHome", "cargo-home"], ["npmCache", "npm-cache"]]) {
  test(`rejects a conflicting ${name} child without overwriting either file`, async t => {
    const { work, execution } = await fixture(t);
    const destinationFile = join(work, destination, "linked-data");
    await writeFile(destinationFile, "keep existing");
    await assert.rejects(populateNativeCaches(work, { [name]: execution[name] }), { code: "ERR_FS_CP_EEXIST" });
    assert.equal(await readFile(destinationFile, "utf8"), "keep existing");
    assert.equal(await readFile(join(execution[name], "linked-data"), "utf8"), name);
  });
}

for (const bound of [false, true]) {
  test(`removes both ambient Cargo configurations; bound config ${bound ? "applied" : "absent"}`, async t => {
    const { work, execution } = await fixture(t);
    for (const name of ["config", "config.toml"]) await writeFile(join(execution.cargoHome, name), "ambient");
    const cargo = bound ? { content: "[build]\njobs = 2\n" } : undefined;
    await populateNativeCaches(work, execution, cargo);
    await assert.rejects(readFile(join(work, "cargo-home/config")), { code: "ENOENT" });
    if (bound) assert.equal(await readFile(join(work, "cargo-home/config.toml"), "utf8"), cargo.content);
    else await assert.rejects(readFile(join(work, "cargo-home/config.toml")), { code: "ENOENT" });
    for (const name of ["config", "config.toml"]) assert.equal(await readFile(join(execution.cargoHome, name), "utf8"), "ambient");
  });
}

test("applies bound Cargo configuration without any selected cache", async t => {
  const { work } = await fixture(t);
  await populateNativeCaches(work, {}, { content: "[net]\noffline = true\n" });
  assert.equal(await readFile(join(work, "cargo-home/config.toml"), "utf8"), "[net]\noffline = true\n");
});

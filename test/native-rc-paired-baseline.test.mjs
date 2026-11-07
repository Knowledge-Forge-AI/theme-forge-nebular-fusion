// @vitest-environment node
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { prepareFixtures, sha256 } from "../tools/native-rc-smoke.mjs";

const BASELINE_BYTES = 4734;
const BASELINE_SHA256 = "7b873b36bf4f0d141e70b72a11dbc6dac7f8250de0b2479b84fe014d629597a8";
const DESTINATIONS = ["candidate-v2.json", "review-v2.json", "v2-saved.theme.json"];

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "nebular-paired-v2-baseline-"));
  chmodSync(root, 0o700);
  return root;
}

function mode(path) {
  return lstatSync(path).mode & 0o7777;
}

function assertMissing(path) {
  assert.throws(() => lstatSync(path), (error) => error?.code === "ENOENT");
}

test("paired-v2 prepares a bound Developer baseline and no destinations", () => {
  const root = scratch();
  try {
    const smoke = join(root, "nebular-release-smoke");
    mkdirSync(smoke, { mode: 0o700 });
    chmodSync(smoke, 0o700);
    chmodSync(root, 0o700);
    const prepared = prepareFixtures("paired-v2", root, smoke);
    assert.deepEqual(prepared, { observed: {} });

    const fixtures = join(smoke, "fixtures");
    const exchange = join(smoke, "exchange");
    const baseline = join(exchange, "baseline.theme.json");
    assert.equal(mode(fixtures), 0o700);
    assert.equal(mode(exchange), 0o700);
    assert.equal(lstatSync(exchange).isDirectory(), true);
    assert.equal(lstatSync(exchange).isSymbolicLink(), false);
    assert.equal(mode(baseline), 0o600);
    assert.equal(lstatSync(baseline).isFile(), true);
    assert.equal(lstatSync(baseline).isSymbolicLink(), false);
    assert.equal(lstatSync(baseline).nlink, 1);
    const bytes = readFileSync(baseline);
    assert.equal(bytes.byteLength, BASELINE_BYTES);
    assert.equal(sha256(bytes), BASELINE_SHA256);
    for (const name of DESTINATIONS) assertMissing(join(exchange, name));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("paired-v2 refuses a pre-existing or modified exchange without overwriting it", () => {
  const root = scratch();
  try {
    const smoke = join(root, "nebular-release-smoke");
    const exchange = join(smoke, "exchange");
    const baseline = join(exchange, "baseline.theme.json");
    const candidate = join(exchange, "candidate-v2.json");
    // This models a stale or modified fixture left by a prior owner. The setup must fail closed;
    // it must not repair the directory or precreate a destination over the sentinel.
    mkdirSync(smoke, { mode: 0o700 });
    chmodSync(smoke, 0o700);
    mkdirSync(exchange, { mode: 0o700 });
    chmodSync(exchange, 0o700);
    writeFileSync(baseline, Buffer.from("modified-baseline"), { mode: 0o600 });
    writeFileSync(candidate, Buffer.from("sentinel-destination"), { mode: 0o600 });
    chmodSync(baseline, 0o600);
    chmodSync(candidate, 0o600);
    assert.throws(
      () => prepareFixtures("paired-v2", root, smoke),
      /paired-v2 exchange must be absent before fixture preparation/,
    );
    assert.equal(readFileSync(baseline, "utf8"), "modified-baseline");
    assert.equal(readFileSync(candidate, "utf8"), "sentinel-destination");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("paired-v2 refuses a modified maintained baseline fixture", async () => {
  const root = scratch();
  try {
    const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
    const moduleClosure = [
      "tools/native-rc-smoke.mjs",
      "tools/fs-snapshot.mjs",
      "tools/native-launcher.mjs",
      "tools/native-rc-package.mjs",
      "tools/native-runtime.mjs",
      "tools/platform-targets.mjs",
      "tools/candidate-provenance.mjs",
      "tools/appearance-matrix-prep1/generate.mjs",
      "test/native-rc-paired-baseline.test.mjs",
    ];
    for (const relativePath of moduleClosure) {
      const destination = join(root, relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(sourceRoot, relativePath), destination);
    }
    cpSync(join(sourceRoot, "package.json"), join(root, "package.json"));
    const fixturePath = join(root, "test/fixtures/paired-v2/developer.profile.json");
    mkdirSync(dirname(fixturePath), { recursive: true });
    cpSync(join(sourceRoot, "test/fixtures/paired-v2/developer.profile.json"), fixturePath);
    const original = readFileSync(fixturePath);
    const originalMode = mode(fixturePath);
    writeFileSync(fixturePath, Buffer.concat([original, Buffer.from("\n")]));
    chmodSync(fixturePath, originalMode);
    const copiedHarness = join(root, "tools/native-rc-smoke.mjs");
    const { prepareFixtures: copiedPrepareFixtures } = await import(`${pathToFileURL(copiedHarness).href}?modified-fixture`);
    const smoke = join(root, "nebular-release-smoke");
    mkdirSync(smoke, { mode: 0o700 });
    chmodSync(smoke, 0o700);
    assert.throws(
      () => copiedPrepareFixtures("paired-v2", root, smoke),
      /paired-v2 maintained Developer baseline fixture identity changed/,
    );
    assert.equal(sha256(readFileSync(join(sourceRoot, "test/fixtures/paired-v2/developer.profile.json"))), BASELINE_SHA256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

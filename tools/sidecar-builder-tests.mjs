import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { test } from "node:test";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalJson,
  gitIdentity,
  validateStellarBinding,
  repositoryRootForStudio,
  preparationOptions,
  replaceGeneratedPair,
  replaceGeneratedPairForTest,
  sha1,
  sha256,
  validateManifestShape,
  verifyDistribution,
} from "./sidecar-common.mjs";

const root = resolve(import.meta.dirname, `../src-tauri/target/sidecar-builder-tests-${process.pid}`);
const requiredFiles = [
  ["dist/service-protocol/server-cli.js", "service"],
  ["native/directory-snapshot/prebuilds/darwin-arm64/native-addon-posix-openat-v1.node", "native"],
  ["node_modules/@knowledge-forge-ai/tfsb-raster-resvg/package.json", "raster"],
  ["node_modules/@resvg/resvg-wasm/index_bg.wasm", "wasm"],
  ["protocol/tfsb-studio-v1/inventory.json", "inventory-10"],
  ["protocol/tfsb-studio-v1/requests.schema.json", "requests-10"],
  ["protocol/tfsb-studio-v1/results.schema.json", "results-10"],
  ["protocol/tfsb-studio-v1/inventory-1.1.json", "inventory-11"],
  ["protocol/tfsb-studio-v1/requests-1.1.schema.json", "requests-11"],
  ["protocol/tfsb-studio-v1/results-1.1.schema.json", "results-11"],
  ["protocol/tfsb-studio-v1/inventory-1.2.json", "inventory-12"],
  ["protocol/tfsb-studio-v1/requests-1.2.schema.json", "requests-12"],
  ["protocol/tfsb-studio-v1/results-1.2.schema.json", "results-12"],
];

async function writeClosedManifest(payload, manifest, { preserveActualInput = false } = {}) {
  if (!preserveActualInput) manifest.source.actualInputDigest = sha256(Buffer.from(canonicalJson({ coreTarball: manifest.core.tarball, files: manifest.files })));
  const { manifestDigest: _discard, ...unsigned } = manifest;
  manifest.manifestDigest = sha256(Buffer.from(canonicalJson(unsigned)));
  await writeFile(resolve(payload, "manifest.json"), `${canonicalJson(manifest)}\n`);
}

async function fixture(label = "case") {
  const fixtureRoot = resolve(root, `${label}-${Math.random().toString(16).slice(2)}`);
  const payload = resolve(fixtureRoot, "payload");
  const binary = resolve(fixtureRoot, "runtime");
  await mkdir(payload, { recursive: true });
  await writeFile(binary, "runtime");
  await chmod(binary, 0o755);
  for (const [path, bytes] of requiredFiles) {
    await mkdir(resolve(payload, path, ".."), { recursive: true });
    const target = resolve(payload, path);
    await writeFile(target, bytes);
    await chmod(target, 0o644);
  }
  const files = [];
  for (const [path] of requiredFiles) {
    const bytes = await readFile(resolve(payload, path));
    files.push({ mode: 0o644, path, sha256: sha256(bytes), size: bytes.length });
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const runtimeBytes = await readFile(binary);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const tarball = { sha1: sha1(Buffer.from("tarball")), sha256: sha256(Buffer.from("tarball")), size: 7, sri: "sha512-fixture" };
  const manifest = {
    core: { name: "fixture", tarball, version: "0.0.0" },
    entrypoint: "dist/service-protocol/server-cli.js",
    files,
    manifestDigest: "0".repeat(64),
    native: { abi: 1, backend: "native-addon-posix-openat-v1", sha256: byPath.get("native/directory-snapshot/prebuilds/darwin-arm64/native-addon-posix-openat-v1.node").sha256, size: 6, target: "aarch64-apple-darwin" },
    protocol: {
      "1.0": { inventorySha256: byPath.get("protocol/tfsb-studio-v1/inventory.json").sha256, requestsSha256: byPath.get("protocol/tfsb-studio-v1/requests.schema.json").sha256, resultsSha256: byPath.get("protocol/tfsb-studio-v1/results.schema.json").sha256 },
      "1.1": { inventorySha256: byPath.get("protocol/tfsb-studio-v1/inventory-1.1.json").sha256, requestsSha256: byPath.get("protocol/tfsb-studio-v1/requests-1.1.schema.json").sha256, resultsSha256: byPath.get("protocol/tfsb-studio-v1/results-1.1.schema.json").sha256 },
      "1.2": { inventorySha256: byPath.get("protocol/tfsb-studio-v1/inventory-1.2.json").sha256, requestsSha256: byPath.get("protocol/tfsb-studio-v1/requests-1.2.schema.json").sha256, resultsSha256: byPath.get("protocol/tfsb-studio-v1/results-1.2.schema.json").sha256 },
    },
    raster: { name: "fixture", packageJsonSha256: byPath.get("node_modules/@knowledge-forge-ai/tfsb-raster-resvg/package.json").sha256, version: "0.0.0" },
    resvg: { name: "fixture", version: "0.0.0", wasmSha256: byPath.get("node_modules/@resvg/resvg-wasm/index_bg.wasm").sha256, wasmSize: 4 },
    runtime: { mode: 0o755, sha256: sha256(runtimeBytes), size: runtimeBytes.length, target: "aarch64-apple-darwin", v8: "12.4.254.21-node.56", version: "22.23.2" },
    runtimeKind: "node-runtime-payload-v1",
    schema: "tfsb.studio-sidecar-distribution",
    schemaVersion: 1,
    source: { actualInputDigest: "0".repeat(64), baseCommit: "a".repeat(40), model: "closed-input-digest-v1" },
    target: "aarch64-apple-darwin",
    totals: { bytes: files.reduce((sum, file) => sum + file.size, 0), fileCount: files.length, inventoryDigest: sha256(Buffer.from(canonicalJson(files))) },
  };
  await writeClosedManifest(payload, manifest);
  return { binary, fixtureRoot, manifest, payload };
}

async function verify(candidate) {
  return verifyDistribution({ binaryPath: candidate.binary, payloadRoot: candidate.payload, testOnlyAllowNonProductionIdentity: true });
}

async function rejectPayloadMutation(name, path, mutation) {
  await test(name, async () => {
    const candidate = await fixture(name.replaceAll(" ", "-"));
    await mutation(resolve(candidate.payload, path), candidate);
    await assert.rejects(verify(candidate));
  });
}

test("canonical manifest and rebuild bytes are deterministic", async () => {
  const first = await fixture("deterministic-1");
  const second = await fixture("deterministic-2");
  assert.deepEqual(await readFile(resolve(first.payload, "manifest.json")), await readFile(resolve(second.payload, "manifest.json")));
  await verify(first);
  await verify(second);
});

test("production identity policy rejects a fixture runtime", async () => {
  const candidate = await fixture("wrong-official-runtime");
  await assert.rejects(verifyDistribution({ binaryPath: candidate.binary, payloadRoot: candidate.payload }));
});

test("production core tarball identity is exact-input-bound rather than pinned to stale bytes", async () => {
  const candidate = await fixture("dynamic-core-tarball-identity");
  const production = structuredClone(candidate.manifest);
  production.core.tarball = { sha1: "1".repeat(40), sha256: "2".repeat(64), size: 1, sri: "sha512-YQ==" };
  production.source.actualInputDigest = sha256(Buffer.from(canonicalJson({ coreTarball: production.core.tarball, files: production.files })));
  const { manifestDigest: _discard, ...unsigned } = production;
  production.manifestDigest = sha256(Buffer.from(canonicalJson(unsigned)));
  assert.equal(validateManifestShape(production, { testOnlyAllowNonProductionIdentity: true }), production);
});

test("shared verifier corpus exercises the actual JavaScript verifier", async () => {
  const corpus = JSON.parse(await readFile(resolve(import.meta.dirname, "../tests/sidecar-verifier-vectors.json"), "utf8"));
  assert.equal(corpus.schemaVersion, 1);
  for (const vector of corpus.vectors) {
    const candidate = await fixture(`shared-${vector.name}`);
    const first = candidate.manifest.files[0];
    const second = candidate.manifest.files[1];
    switch (vector.class) {
      case "positive": break;
      case "unknown-fields": candidate.manifest.unknown = true; await writeClosedManifest(candidate.payload, candidate.manifest); break;
      case "missing-fields": delete candidate.manifest.native.backend; await writeClosedManifest(candidate.payload, candidate.manifest); break;
      case "duplicate-fields": {
        const path = resolve(candidate.payload, "manifest.json");
        const raw = await readFile(path, "utf8");
        await writeFile(path, raw.replace("{", '{"schemaVersion":1,'));
        break;
      }
      case "noncanonical-manifest": await writeFile(resolve(candidate.payload, "manifest.json"), `${JSON.stringify(candidate.manifest, null, 2)}\n`); break;
      case "self-digest": candidate.manifest.manifestDigest = "0".repeat(64); await writeFile(resolve(candidate.payload, "manifest.json"), `${canonicalJson(candidate.manifest)}\n`); break;
      case "source-identity": candidate.manifest.source.baseCommit = "wrong"; await writeClosedManifest(candidate.payload, candidate.manifest); break;
      case "core-identity": candidate.manifest.core.tarball.sha1 = "wrong"; await writeClosedManifest(candidate.payload, candidate.manifest); break;
      case "runtime-identity": candidate.manifest.runtime.version = "wrong"; await writeClosedManifest(candidate.payload, candidate.manifest); break;
      case "protocol-identity": candidate.manifest.protocol["1.1"].inventorySha256 = "0".repeat(64); await writeClosedManifest(candidate.payload, candidate.manifest); break;
      case "native-identity": candidate.manifest.native.abi = 2; await writeClosedManifest(candidate.payload, candidate.manifest); break;
      case "raster-resvg-identity": candidate.manifest.raster.packageJsonSha256 = "wrong"; await writeClosedManifest(candidate.payload, candidate.manifest); break;
      case "file-ordering": [candidate.manifest.files[0], candidate.manifest.files[1]] = [second, first]; await writeClosedManifest(candidate.payload, candidate.manifest); break;
      case "file-collision": second.path = first.path.toUpperCase(); await writeClosedManifest(candidate.payload, candidate.manifest); break;
      case "totals": candidate.manifest.totals.bytes += 1; await writeClosedManifest(candidate.payload, candidate.manifest); break;
      case "inventory-digest": candidate.manifest.totals.inventoryDigest = "0".repeat(64); await writeClosedManifest(candidate.payload, candidate.manifest); break;
      case "actual-input-digest": candidate.manifest.source.actualInputDigest = "0".repeat(64); await writeClosedManifest(candidate.payload, candidate.manifest, { preserveActualInput: true }); break;
      case "missing-file": await rm(resolve(candidate.payload, first.path)); break;
      case "extra-file": await writeFile(resolve(candidate.payload, "extra"), "extra"); break;
      case "tampered-file": await writeFile(resolve(candidate.payload, first.path), "tampered"); break;
      case "mode-and-size": await chmod(resolve(candidate.payload, first.path), 0o600); break;
      case "symlink-or-special": await symlink(resolve(candidate.payload, first.path), resolve(candidate.payload, "injected-link")); break;
      case "required-consequence-file": await rm(resolve(candidate.payload, "dist/service-protocol/server-cli.js")); break;
      default: throw new Error(`unknown shared verifier vector: ${vector.class}`);
    }
    if (vector.accept) await verify(candidate);
    else await assert.rejects(verify(candidate), vector.name);
  }
});

for (const [name, path] of [
  ["entrypoint tamper", "dist/service-protocol/server-cli.js"],
  ["native addon tamper", "native/directory-snapshot/prebuilds/darwin-arm64/native-addon-posix-openat-v1.node"],
  ["raster package tamper", "node_modules/@knowledge-forge-ai/tfsb-raster-resvg/package.json"],
  ["raster WASM tamper", "node_modules/@resvg/resvg-wasm/index_bg.wasm"],
  ["protocol inventory tamper", "protocol/tfsb-studio-v1/inventory.json"],
  ["protocol request schema tamper", "protocol/tfsb-studio-v1/requests-1.1.schema.json"],
  ["protocol result schema tamper", "protocol/tfsb-studio-v1/results.schema.json"],
  ["protocol 1.2 inventory tamper", "protocol/tfsb-studio-v1/inventory-1.2.json"],
  ["protocol 1.2 request schema tamper", "protocol/tfsb-studio-v1/requests-1.2.schema.json"],
  ["protocol 1.2 result schema tamper", "protocol/tfsb-studio-v1/results-1.2.schema.json"],
]) await rejectPayloadMutation(name, path, (target) => writeFile(target, "tampered"));

for (const [name, path] of [
  ["entrypoint missing", "dist/service-protocol/server-cli.js"],
  ["native addon missing", "native/directory-snapshot/prebuilds/darwin-arm64/native-addon-posix-openat-v1.node"],
  ["raster package missing", "node_modules/@knowledge-forge-ai/tfsb-raster-resvg/package.json"],
  ["raster WASM missing", "node_modules/@resvg/resvg-wasm/index_bg.wasm"],
  ["protocol 1.2 inventory missing", "protocol/tfsb-studio-v1/inventory-1.2.json"],
  ["protocol 1.2 request schema missing", "protocol/tfsb-studio-v1/requests-1.2.schema.json"],
  ["protocol 1.2 result schema missing", "protocol/tfsb-studio-v1/results-1.2.schema.json"],
]) await rejectPayloadMutation(name, path, (target) => rm(target));

test("runtime binary tamper fails closed", async () => {
  const candidate = await fixture("runtime-tamper");
  await writeFile(candidate.binary, "tampered");
  await assert.rejects(verify(candidate));
});

test("unknown, missing, and duplicate manifest fields fail closed", async (context) => {
  for (const kind of ["unknown", "nested-unknown", "missing", "duplicate"]) await context.test(kind, async () => {
    const candidate = await fixture(`manifest-${kind}`);
    if (kind === "unknown") candidate.manifest.unknown = true;
    if (kind === "nested-unknown") candidate.manifest.runtime.unknown = true;
    if (kind === "missing") delete candidate.manifest.native.backend;
    await writeClosedManifest(candidate.payload, candidate.manifest);
    if (kind === "duplicate") {
      const path = resolve(candidate.payload, "manifest.json");
      const raw = await readFile(path, "utf8");
      await writeFile(path, raw.replace("{", '{"schemaVersion":1,'));
    }
    await assert.rejects(verify(candidate));
  });
});

test("nested fixed identities and totals are enforced", async (context) => {
  for (const [name, mutate] of [
    ["target", (m) => { m.runtime.target = "wrong"; }],
    ["version", (m) => { m.runtime.version = "wrong"; }],
    ["backend", (m) => { m.native.backend = "wrong"; }],
    ["abi", (m) => { m.native.abi = 2; }],
    ["file-count", (m) => { m.totals.fileCount += 1; }],
    ["bytes", (m) => { m.totals.bytes += 1; }],
    ["inventory-digest", (m) => { m.totals.inventoryDigest = "0".repeat(64); }],
  ]) await context.test(name, async () => {
    const candidate = await fixture(`identity-${name}`);
    mutate(candidate.manifest);
    await writeClosedManifest(candidate.payload, candidate.manifest);
    await assert.rejects(verify(candidate));
  });
});

test("extra, missing, mode, long path, and symlink payload entries fail closed", async (context) => {
  await context.test("extra", async () => { const c = await fixture("extra"); await writeFile(resolve(c.payload, "extra"), "extra"); await assert.rejects(verify(c)); });
  await context.test("missing", async () => { const c = await fixture("missing"); await rm(resolve(c.payload, c.manifest.files[0].path)); await assert.rejects(verify(c)); });
  await context.test("mode", async () => { const c = await fixture("mode"); await chmod(resolve(c.payload, c.manifest.files[0].path), 0o600); await assert.rejects(verify(c)); });
  await context.test("long-path", async () => { const c = await fixture("long"); c.manifest.files[0].path = `${"a".repeat(513)}`; await writeClosedManifest(c.payload, c.manifest); await assert.rejects(verify(c)); });
  await context.test("symlink", async () => { const c = await fixture("link"); await symlink(resolve(c.payload, c.manifest.files[0].path), resolve(c.payload, "link")); await assert.rejects(verify(c)); });
  await context.test("symlinked-ancestor", async () => { const c = await fixture("ancestor"); const linked = resolve(c.fixtureRoot, "linked"); await symlink(c.payload, linked); await assert.rejects(verifyDistribution({ binaryPath: c.binary, payloadRoot: linked, testOnlyAllowNonProductionIdentity: true })); });
});

test("special filesystem nodes fail closed", async () => {
  const candidate = await fixture("special");
  const socket = resolve(candidate.payload, "special.sock");
  const shortSocket = `/tmp/tfsb-sidecar-${process.pid}.sock`;
  await rm(shortSocket, { force: true });
  const server = createServer();
  try {
    await new Promise((accept, reject) => server.once("error", reject).listen(shortSocket, accept));
    await rename(shortSocket, socket);
    assert.equal((await lstat(socket)).isSocket(), true);
    await assert.rejects(verify(candidate));
  } finally {
    await new Promise((accept) => server.close(accept));
  }
});

async function pairFixture(label) {
  const directory = resolve(root, `pair-${label}`);
  const binarySource = resolve(directory, "stage-binary");
  const payloadSource = resolve(directory, "stage-payload");
  const binaryDestination = resolve(directory, "generated", "binary");
  const payloadDestination = resolve(directory, "generated", "payload");
  await mkdir(payloadSource, { recursive: true });
  await mkdir(payloadDestination, { recursive: true });
  await writeFile(binarySource, "new-binary");
  await writeFile(resolve(payloadSource, "identity"), "new-payload");
  await writeFile(binaryDestination, "old-binary");
  await writeFile(resolve(payloadDestination, "identity"), "old-payload");
  return { directory, binarySource, payloadSource, binaryDestination, payloadDestination };
}

async function assertOldPair(pair) {
  assert.equal(await readFile(pair.binaryDestination, "utf8"), "old-binary");
  assert.equal(await readFile(resolve(pair.payloadDestination, "identity"), "utf8"), "old-payload");
}

test("generated binary and payload publish as one recoverable pair", async (context) => {
  await context.test("clean-success", async () => {
    const pair = await pairFixture("success");
    await replaceGeneratedPairForTest(pair);
    assert.equal(await readFile(pair.binaryDestination, "utf8"), "new-binary");
    assert.equal(await readFile(resolve(pair.payloadDestination, "identity"), "utf8"), "new-payload");
    assert.deepEqual((await readdir(resolve(pair.directory, "generated"))).sort(), ["binary", "payload"]);
  });
  for (const point of ["before-first-promotion", "before-second-promotion"]) {
    await context.test(point, async () => {
      const pair = await pairFixture(point);
      await assert.rejects(replaceGeneratedPairForTest({
        ...pair,
        inject: async (current) => { if (current === point) throw new Error(`injected ${point}`); },
      }));
      await assertOldPair(pair);
    });
  }
  await context.test("cleanup-failure-retains-published-pair-and-recovery", async () => {
    const pair = await pairFixture("cleanup-failure");
    await assert.rejects(replaceGeneratedPairForTest({
      ...pair,
      inject: async (point) => { if (point === "before-cleanup") throw new Error("injected cleanup failure"); },
    }), /published but cleanup retained/u);
    assert.equal(await readFile(pair.binaryDestination, "utf8"), "new-binary");
    assert.equal(await readFile(resolve(pair.payloadDestination, "identity"), "utf8"), "new-payload");
    assert.equal((await readdir(resolve(pair.directory, "generated"))).some((name) => name.startsWith(".sidecar-recovery-")), true);
  });
  await context.test("rollback-failure-retains-recovery", async () => {
    const pair = await pairFixture("rollback-failure");
    await assert.rejects(replaceGeneratedPairForTest({
      ...pair,
      inject: async (point) => {
        if (point === "before-second-promotion" || point === "before-rollback-cleanup") {
          throw new Error(`injected ${point}`);
        }
      },
    }), /bounded recovery residue/u);
    await assertOldPair(pair);
    assert.equal((await readdir(resolve(pair.directory, "generated"))).some((name) => name.startsWith(".sidecar-recovery-")), true);
  });
  await context.test("concurrent-destination-is-never-overwritten", async () => {
    const pair = await pairFixture("concurrent");
    await assert.rejects(replaceGeneratedPairForTest({
      ...pair,
      inject: async (point) => {
        if (point === "before-second-promotion") {
          await mkdir(pair.payloadDestination);
          await writeFile(resolve(pair.payloadDestination, "unowned"), "concurrent");
        }
      },
    }), /bounded recovery residue/u);
    assert.equal(await readFile(resolve(pair.payloadDestination, "unowned"), "utf8"), "concurrent");
  });
  await context.test("preexisting-backup-identity-is-retained", async () => {
    const pair = await pairFixture("backup-identity");
    await assert.rejects(replaceGeneratedPairForTest({
      ...pair,
      inject: async (point, paths) => {
        if (point === "recovery-created") await writeFile(paths.backupBinary, "unowned");
      },
    }));
    await assertOldPair(pair);
    const recovery = (await readdir(resolve(pair.directory, "generated"))).find((name) => name.startsWith(".sidecar-recovery-"));
    assert.ok(recovery);
    assert.equal(await readFile(resolve(pair.directory, "generated", recovery, "old-binary"), "utf8"), "unowned");
  });
});

test("preparation arguments reject duplicates unknowns and missing pairs", () => {
  const repositoryRoot = repositoryRootForStudio(resolve(import.meta.dirname, ".."));
  assert.throws(() => preparationOptions(["--node", "/node", "--node", "/other", "--root-tarball", "/root.tgz"], repositoryRoot), /duplicate/u);
  assert.throws(() => preparationOptions(["--node", "/node", "--unknown", "/value", "--root-tarball", "/root.tgz"], repositoryRoot), /unknown/u);
  assert.throws(() => preparationOptions(["--node", "/node", "--root-tarball"], repositoryRoot), /paired/u);
  const previousNode = process.env.TFSB_STUDIO_NODE_BINARY;
  const previousTarball = process.env.TFSB_STUDIO_ROOT_TARBALL;
  try {
    process.env.TFSB_STUDIO_NODE_BINARY = "/environment-node";
    process.env.TFSB_STUDIO_ROOT_TARBALL = "/environment-root.tgz";
    const explicit = preparationOptions(["--node", "/argument-node", "--root-tarball", "/argument-root.tgz"], repositoryRoot);
    assert.equal(explicit.nodePath, "/argument-node");
    assert.equal(explicit.rootTarball, "/argument-root.tgz");
    const fallback = preparationOptions([], repositoryRoot);
    assert.equal(fallback.nodePath, "/environment-node");
    assert.equal(fallback.rootTarball, "/environment-root.tgz");
  } finally {
    if (previousNode === undefined) delete process.env.TFSB_STUDIO_NODE_BINARY;
    else process.env.TFSB_STUDIO_NODE_BINARY = previousNode;
    if (previousTarball === undefined) delete process.env.TFSB_STUDIO_ROOT_TARBALL;
    else process.env.TFSB_STUDIO_ROOT_TARBALL = previousTarball;
  }
});

test("preparation fallback selects one declared core archive and rejects ambiguity", async () => {
  const repositoryRoot = resolve(root, "preparation-fallback");
  const archiveDirectory = resolve(repositoryRoot, "authenticated-inputs/core-tarball");
  await mkdir(archiveDirectory, { recursive: true });
  const archive = resolve(archiveDirectory, "declared-core.tgz");
  await writeFile(archive, "declared archive");
  const previousNode = process.env.TFSB_STUDIO_NODE_BINARY;
  const previousTarball = process.env.TFSB_STUDIO_ROOT_TARBALL;
  try {
    process.env.TFSB_STUDIO_NODE_BINARY = "/environment-node";
    delete process.env.TFSB_STUDIO_ROOT_TARBALL;
    assert.equal(preparationOptions([], repositoryRoot).rootTarball, archive);
    await writeFile(resolve(archiveDirectory, "second-core.tgz"), "second archive");
    assert.throws(() => preparationOptions([], repositoryRoot), /ambiguous/u);
  } finally {
    if (previousNode === undefined) delete process.env.TFSB_STUDIO_NODE_BINARY;
    else process.env.TFSB_STUDIO_NODE_BINARY = previousNode;
    if (previousTarball === undefined) delete process.env.TFSB_STUDIO_ROOT_TARBALL;
    else process.env.TFSB_STUDIO_ROOT_TARBALL = previousTarball;
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("builder fixtures leave root package and lock bytes unchanged and clean up", async () => {
  const repositoryRoot = repositoryRootForStudio(resolve(import.meta.dirname, ".."));
  const before = await Promise.all(["package.json", "package-lock.json"].map((path) => readFile(resolve(repositoryRoot, path))));
  validateManifestShape((await fixture("root-parity")).manifest, { testOnlyAllowNonProductionIdentity: true });
  const after = await Promise.all(["package.json", "package-lock.json"].map((path) => readFile(resolve(repositoryRoot, path))));
  assert.deepEqual(after, before);
  await rm(root, { recursive: true, force: true });
});

test("standalone root selection ignores unrelated ancestor packages", async () => {
  const ancestor = resolve(root, "ambient-parent");
  const standalone = resolve(ancestor, "nested/product");
  await mkdir(standalone, { recursive: true });
  await writeFile(resolve(ancestor, "package.json"), '{"name":"unrelated"}');
  assert.equal(repositoryRootForStudio(standalone), standalone);
  const privateApp = resolve(ancestor, "apps/studio");
  await mkdir(resolve(privateApp, "authenticated-inputs"), { recursive: true });
  assert.equal(repositoryRootForStudio(privateApp), ancestor);
  await writeFile(resolve(privateApp, "authenticated-inputs/stellar-binding.json"), '{}');
  assert.equal(repositoryRootForStudio(privateApp), privateApp);
});


test("standalone candidate accepts published input and rejects malformed identity", async () => {
  const digest = "a".repeat(64);
  const binding = {
    schema: "tfsb.nebular-stellar-input-binding-v1", schemaVersion: 1,
    product: "theme-forge-nebular-fusion", canonicalEpochMs: 0,
    input: {product:"theme-forge-stellar-burst", sourceTree:"b".repeat(40),
      composedTreeDigest:digest, packageJsonSha256:digest, packageLockSha256:digest,
      publicMergeCommit:"c".repeat(40), provenance:"accepted-published-npm-package; retained-locked-support-inputs"},
    package:{filename:"core.tgz",sha256:digest},
    raster:{filename:"raster.tgz",sha256:digest,packageSha256:digest,packageLockSha256:digest},
  };
  assert.equal(validateStellarBinding(binding).input.publicMergeCommit, "c".repeat(40));
  assert.throws(() => validateStellarBinding({...binding,input:{...binding.input,publicMergeCommit:null}}));
  const candidate = resolve(root, "source-candidate");
  await mkdir(resolve(candidate,"authenticated-inputs"),{recursive:true});
  const receipt = resolve(candidate,"authenticated-inputs/source-candidate.json");
  await writeFile(receipt,JSON.stringify({schema:"tfsb.source-candidate-v1",lineageCommit:"b".repeat(40),identity:{commit:"b".repeat(40)}}));
  assert.equal(await gitIdentity(candidate), "b".repeat(40));
  await writeFile(receipt,JSON.stringify({schema:"tfsb.source-candidate-v1",lineageCommit:"b".repeat(40),identity:{commit:"c".repeat(40)}}));
  await assert.rejects(gitIdentity(candidate), /lineage/);
  await rm(candidate,{recursive:true});
});

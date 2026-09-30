import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { EXPECTED_V8_VERSION, locateCachedPortableNode } from "./node-runtime-authority.mjs";
import { inventoryTree, seal, sourceResourcePlans } from "./candidate-provenance.mjs";
import { createBuildSettings } from "./build-settings.mjs";
import { parseVerificationArguments, verifySidecar } from "./sidecar-verify.mjs";

import {
  NODE_VERSION,
  TARGETS,
  canonicalJson,
  prepareSidecar,
  probeRuntime,
  sha256,
  sidecarBinaryName,
  validateManifestShape,
  validateSourceIdentity,
  validateTarget,
  validateSourceBuiltNative,
  nativeHeaderIdentity,
  verifyDistribution,
} from "./sidecar-common.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const tempBase = realpathSync(resolve(process.env.TMPDIR ?? tmpdir()));

async function createNodeRuntimeStub(dir, target, { version = NODE_VERSION, v8 = EXPECTED_V8_VERSION } = {}) {
  const stubPath = resolve(dir, `node-stub-${target.triple}`);
  const payload = JSON.stringify({
    node: version,
    v8,
    arch: target.cpu,
    platform: target.os,
  });
  const content = `#!/bin/sh\nif [ "$1" = "-p" ]; then\n  echo '${payload}'\n  exit 0\nfi\necho "node stub"\n`;
  await writeFile(stubPath, content, { mode: 0o755 });
  await chmod(stubPath, 0o755);
  return stubPath;
}

async function createSourceFixture(target = TARGETS[0]) {
  const fixtureDir = await mkdtemp(join(tempBase, "tfsb-source-sidecar-fixture-"));
  const studioRoot = resolve(fixtureDir, "apps/studio");
  const burstRoot = resolve(fixtureDir, "components/burst");
  const rasterRoot = resolve(fixtureDir, "components/raster");

  await mkdir(studioRoot, { recursive: true, mode: 0o755 });
  await mkdir(burstRoot, { recursive: true, mode: 0o755 });
  await mkdir(rasterRoot, { recursive: true, mode: 0o755 });

  // Studio legal
  await mkdir(resolve(studioRoot, "legal"), { recursive: true });
  await cp(resolve(repoRoot, "apps/studio/legal/node-LICENSE.txt"), resolve(studioRoot, "legal/node-LICENSE.txt"));
  await mkdir(resolve(studioRoot, "src-tauri"), { recursive: true });

  // Burst package.json & dist
  await writeFile(
    resolve(burstRoot, "package.json"),
    JSON.stringify({ name: "@knowledge-forge-ai/theme-forge-stellar-burst", version: "0.5.0", type: "module" }, null, 2)
  );
  await mkdir(resolve(burstRoot, "dist/service-protocol"), { recursive: true });
  await cp(
    resolve(repoRoot, "dist/service-protocol/server-cli.js"),
    resolve(burstRoot, "dist/service-protocol/server-cli.js")
  );

  // Burst runtime packages
  for (const pkg of ["@xmldom/xmldom", "fflate", "smol-toml"]) {
    const srcDir = resolve(repoRoot, "node_modules", pkg);
    const destDir = resolve(burstRoot, "node_modules", pkg);
    await cp(srcDir, destDir, { recursive: true });
  }

  // Native addon for target
  const nativeSrc = resolve(repoRoot, "native/directory-snapshot/prebuilds", target.addon);
  const nativeDest = resolve(burstRoot, "native/directory-snapshot/prebuilds", target.addon);
  await cp(nativeSrc, nativeDest, { recursive: true });

  // Protocol files
  await cp(
    resolve(repoRoot, "protocol/tfsb-studio-v1"),
    resolve(burstRoot, "protocol/tfsb-studio-v1"),
    { recursive: true }
  );

  // Legal files
  for (const legal of ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md"]) {
    await cp(resolve(repoRoot, legal), resolve(burstRoot, legal));
  }

  // Raster package & Resvg WASM
  const realRaster = resolve(repoRoot, "packages/tfsb-raster-resvg");
  for (const file of ["package.json", "index.js", "index.d.ts", "LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md", "MPL-2.0.txt", "THIRD_PARTY_NOTICES.md"]) {
    await cp(resolve(realRaster, file), resolve(rasterRoot, file));
  }
  await cp(
    resolve(realRaster, "node_modules/@resvg/resvg-wasm"),
    resolve(rasterRoot, "node_modules/@resvg/resvg-wasm"),
    { recursive: true }
  );

  const nodePath = target.os === "darwin" ? locateCachedPortableNode() : await createNodeRuntimeStub(fixtureDir, target);
  if (!nodePath) throw new Error("Source sidecar tests require authenticated portable Node");

  return {
    fixtureDir,
    studioRoot,
    burstRoot,
    rasterRoot,
    nodePath,
    target,
    cleanup: async () => rm(fixtureDir, { recursive: true, force: true }),
  };
}

test("release mode rejects missing or invalid sourceIdentity before Git use", async () => {
  const fx = await createSourceFixture(TARGETS[0]);
  try {
    // Missing sourceIdentity
    await assert.rejects(
      prepareSidecar({
        release: true,
        studioRoot: fx.studioRoot,
        nodePath: fx.nodePath,
        componentRoots: { burst: fx.burstRoot, raster: fx.rasterRoot },
        target: TARGETS[0],
      }),
      /explicit canonical 64-hex sourceIdentity/
    );

    // 40-hex Git commit cannot be used as sourceIdentity
    await assert.rejects(
      prepareSidecar({
        release: true,
        sourceIdentity: "a".repeat(40),
        studioRoot: fx.studioRoot,
        nodePath: fx.nodePath,
        componentRoots: { burst: fx.burstRoot, raster: fx.rasterRoot },
        target: TARGETS[0],
      }),
      /canonical 64-hex SHA-256/
    );

    // Non-hex string rejects
    await assert.rejects(
      prepareSidecar({
        release: true,
        sourceIdentity: "z".repeat(64),
        studioRoot: fx.studioRoot,
        nodePath: fx.nodePath,
        componentRoots: { burst: fx.burstRoot, raster: fx.rasterRoot },
        target: TARGETS[0],
      }),
      /canonical 64-hex SHA-256/
    );
  } finally {
    await fx.cleanup();
  }
});

test("release mode rejects missing explicit roots and targets", async () => {
  const fx = await createSourceFixture(TARGETS[0]);
  const validSourceId = "e".repeat(64);
  try {
    // Missing studioRoot
    await assert.rejects(
      prepareSidecar({
        release: true,
        sourceIdentity: validSourceId,
        nodePath: fx.nodePath,
        componentRoots: { burst: fx.burstRoot, raster: fx.rasterRoot },
        target: TARGETS[0],
      }),
      /explicit studioRoot/
    );

    // Non-existent studioRoot
    await assert.rejects(
      prepareSidecar({
        release: true,
        sourceIdentity: validSourceId,
        studioRoot: resolve(fx.fixtureDir, "nonexistent-studio"),
        nodePath: fx.nodePath,
        componentRoots: { burst: fx.burstRoot, raster: fx.rasterRoot },
        target: TARGETS[0],
      }),
      /studioRoot directory does not exist/
    );

    // Missing componentRoots
    await assert.rejects(
      prepareSidecar({
        release: true,
        sourceIdentity: validSourceId,
        studioRoot: fx.studioRoot,
        nodePath: fx.nodePath,
        target: TARGETS[0],
      }),
      /explicit componentRoots/
    );

    // Missing componentRoots.burst
    await assert.rejects(
      prepareSidecar({
        release: true,
        sourceIdentity: validSourceId,
        studioRoot: fx.studioRoot,
        nodePath: fx.nodePath,
        componentRoots: { raster: fx.rasterRoot },
        target: TARGETS[0],
      }),
      /explicit componentRoots.burst/
    );

    // Missing componentRoots.raster
    await assert.rejects(
      prepareSidecar({
        release: true,
        sourceIdentity: validSourceId,
        studioRoot: fx.studioRoot,
        nodePath: fx.nodePath,
        componentRoots: { burst: fx.burstRoot },
        target: TARGETS[0],
      }),
      /explicit componentRoots.raster/
    );

    // Missing target
    await assert.rejects(
      prepareSidecar({
        release: true,
        sourceIdentity: validSourceId,
        studioRoot: fx.studioRoot,
        nodePath: fx.nodePath,
        componentRoots: { burst: fx.burstRoot, raster: fx.rasterRoot },
      }),
      /explicit target/
    );

    // Invalid target (not in TARGETS)
    await assert.rejects(
      prepareSidecar({
        release: true,
        sourceIdentity: validSourceId,
        studioRoot: fx.studioRoot,
        nodePath: fx.nodePath,
        componentRoots: { burst: fx.burstRoot, raster: fx.rasterRoot },
        target: { triple: "unknown-arch-target" },
      }),
      /unsupported or invalid target/
    );

    // Missing nodePath
    await assert.rejects(
      prepareSidecar({
        release: true,
        sourceIdentity: validSourceId,
        studioRoot: fx.studioRoot,
        componentRoots: { burst: fx.burstRoot, raster: fx.rasterRoot },
        target: TARGETS[0],
      }),
      /explicit nodePath/
    );
  } finally {
    await fx.cleanup();
  }
});

test("source-built sidecar preparation succeeds Git-free for all three targets without invented lineage", async () => {
  for (const target of TARGETS) {
    const fx = await createSourceFixture(target);
    const sourceId = sha256(Buffer.from(`source-candidate-${target.triple}`));
    try {
      const result = await prepareSidecar({
        release: true,
        studioRoot: fx.studioRoot,
        componentRoots: { burst: fx.burstRoot, raster: fx.rasterRoot },
        nodePath: fx.nodePath,
        sourceIdentity: sourceId,
        target,
      });

      assert.ok(result.manifestDigest);
      assert.ok(result.fileCount > 0);
      assert.ok(result.bytes > 0);
      assert.equal(result.target, target.triple);
      assert.equal(result.sidecarBinary, `tfsb-studio-service-${target.triple}`);

      // Verify published binary and payload
      const tauriBinDir = resolve(fx.studioRoot, "src-tauri/binaries");
      const binaryPath = resolve(tauriBinDir, `tfsb-studio-service-${target.triple}`);
      assert.ok(existsSync(binaryPath), `Binary must exist at ${binaryPath}`);

      const payloadRoot = resolve(fx.studioRoot, "src-tauri/sidecar-payload");
      assert.ok(existsSync(payloadRoot), "sidecar-payload directory must exist");

      // Verify native addon is at derived target addon path
      const nativePath = resolve(payloadRoot, `native/directory-snapshot/prebuilds/${target.addon}/native-addon-posix-openat-v1.node`);
      assert.ok(existsSync(nativePath), `Native addon must be at ${nativePath}`);

      // Verify manifest content truthfully
      const rawManifest = await readFile(resolve(payloadRoot, "manifest.json"), "utf8");
      const manifest = JSON.parse(rawManifest);
      if (target.os === "darwin") {
        validateManifestShape(manifest);
        const changed = Buffer.from(await readFile(nativePath));
        changed[changed.length - 1] ^= 1;
        const changedManifest = structuredClone(manifest);
        changedManifest.native.sha256 = sha256(changed);
        assert.equal(changed.length, manifest.native.size);
        assert.throws(() => validateManifestShape(changedManifest), /fixed identity/);
        changedManifest.native.sha256 = "951f323f7e54565e5b127f507f35b7b32a69eb223320f3137daeae75c0f673fe";
        assert.throws(() => validateManifestShape(changedManifest), /fixed identity/);
      }

      assert.equal(manifest.schema, "tfsb.studio-sidecar-distribution");
      assert.equal(manifest.schemaVersion, 2);
      assert.equal(manifest.target, target.triple);
      assert.equal(manifest.runtime.target, target.triple);
      assert.equal(manifest.native.target, target.triple);

      // No invented lineage in v2 source candidate model
      assert.equal(manifest.source.model, "source-candidate-v2");
      assert.equal(manifest.source.sourceCandidate, sourceId);
      assert.equal(manifest.source.baseCommit, undefined);

      // Truthful content inventory binding when rootTarball is unavailable
      assert.equal(manifest.core.tarball, undefined);
      assert.equal(manifest.core.name, "@knowledge-forge-ai/theme-forge-stellar-burst");
      assert.equal(manifest.core.version, "0.5.0");

      const expectedActualInput = sha256(Buffer.from(canonicalJson({ files: manifest.files })));
      assert.equal(manifest.source.actualInputDigest, expectedActualInput);

      // Verifier passes truthfully without testOnlyAllowNonProductionIdentity
      const verified = await verifyDistribution({ binaryPath, payloadRoot });
      assert.equal(verified.manifestDigest, result.manifestDigest);
    } finally {
      await fx.cleanup();
    }
  }
});

test("source-built sidecar preparation with rootTarball truthfully binds archive identity", async () => {
  const target = TARGETS[0];
  const fx = await createSourceFixture(target);
  const sourceId = sha256(Buffer.from("source-candidate-with-tarball"));
  const tarballPath = resolve(fx.fixtureDir, "core-test.tgz");
  await writeFile(tarballPath, "simulated-core-tarball-archive-bytes");
  try {
    const result = await prepareSidecar({
      release: true,
      studioRoot: fx.studioRoot,
      componentRoots: { burst: fx.burstRoot, raster: fx.rasterRoot },
      nodePath: fx.nodePath,
      rootTarball: tarballPath,
      sourceIdentity: sourceId,
      target,
    });

    const payloadRoot = resolve(fx.studioRoot, "src-tauri/sidecar-payload");
    const binaryPath = resolve(fx.studioRoot, `src-tauri/binaries/tfsb-studio-service-${target.triple}`);
    const rawManifest = await readFile(resolve(payloadRoot, "manifest.json"), "utf8");
    const manifest = JSON.parse(rawManifest);

    assert.ok(manifest.core.tarball, "core.tarball must be present when rootTarball is provided");
    assert.equal(manifest.core.tarball.size, (await readFile(tarballPath)).length);
    assert.equal(manifest.core.tarball.sha256, sha256(await readFile(tarballPath)));

    const expectedActualInput = sha256(Buffer.from(canonicalJson({ coreTarball: manifest.core.tarball, files: manifest.files })));
    assert.equal(manifest.source.actualInputDigest, expectedActualInput);

    const verified = await verifyDistribution({ binaryPath, payloadRoot });
    assert.equal(verified.manifestDigest, result.manifestDigest);
  } finally {
    await fx.cleanup();
  }
});

test("probeRuntime validates target platform and architecture for all three targets", async () => {
  const tempDir = await mkdtemp(join(tempBase, "tfsb-probe-test-"));
  try {
    for (const target of TARGETS) {
      const validStub = await createNodeRuntimeStub(tempDir, target);
      const probe = probeRuntime(validStub, target);
      assert.equal(probe.node, NODE_VERSION);
      assert.equal(probe.arch, target.cpu);
      assert.equal(probe.platform, target.os);

      // Wrong architecture fails
      const wrongArchStub = await createNodeRuntimeStub(tempDir, {
        triple: "mismatched-arch",
        os: target.os,
        cpu: target.cpu === "arm64" ? "x64" : "arm64",
      });
      assert.throws(
        () => probeRuntime(wrongArchStub, target),
        /wrong version or target/
      );

      // Wrong OS fails
      const wrongOsStub = await createNodeRuntimeStub(tempDir, {
        triple: "mismatched-os",
        os: target.os === "darwin" ? "linux" : "darwin",
        cpu: target.cpu,
      });
      assert.throws(
        () => probeRuntime(wrongOsStub, target),
        /wrong version or target/
      );

      // Wrong version fails
      const wrongVersionStub = await createNodeRuntimeStub(tempDir, target, { version: "20.10.0" });
      assert.throws(
        () => probeRuntime(wrongVersionStub, target),
        /wrong version or target/
      );
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("validateTarget validates platform-targets TARGETS records accurately", () => {
  for (const target of TARGETS) {
    assert.equal(validateTarget(target), target);
  }
  assert.throws(() => validateTarget(null), /target must be a valid/);
  assert.throws(() => validateTarget({ triple: "invalid" }), /unsupported or invalid target/);
  assert.throws(() => validateTarget({ triple: TARGETS[0].triple, os: "linux", cpu: "arm64", addon: "darwin-arm64", system: "aarch64-darwin" }), /unsupported or invalid target/);
});

test("validateSourceIdentity enforces canonical 64-hex format", () => {
  assert.equal(validateSourceIdentity("0".repeat(64)), "0".repeat(64));
  assert.equal(validateSourceIdentity("abcdef0123456789".repeat(4)), "abcdef0123456789".repeat(4));
  assert.throws(() => validateSourceIdentity(""), /canonical 64-hex/);
  assert.throws(() => validateSourceIdentity("a".repeat(40)), /canonical 64-hex/);
  assert.throws(() => validateSourceIdentity("a".repeat(63)), /canonical 64-hex/);
  assert.throws(() => validateSourceIdentity("a".repeat(65)), /canonical 64-hex/);
  assert.throws(() => validateSourceIdentity("G".repeat(64)), /canonical 64-hex/);
});

test("sidecar verification mode is explicit, bounded and paired with authority", () => {
  assert.deepEqual(parseVerificationArguments([]), { mode: undefined, buildInputsPath: undefined });
  for (const mode of ["portable-source", "nix-source"]) {
    assert.equal(parseVerificationArguments(["--mode", mode, "--build-inputs", "/inputs.json"]).mode, mode);
  }
  for (const args of [["--mode"], ["--mode", "nix-source"], ["--build-inputs", "/inputs"],
    ["--mode", "unknown", "--build-inputs", "/inputs"], ["--allow-nix-runtime"],
    ["--mode", "nix-source", "--mode", "portable-source"], ["--build-inputs", "--mode"]]) {
    assert.throws(() => parseVerificationArguments(args));
  }
});

test("Nix native authority validates actual producer provenance and rejects substitutions", async (context) => {
  assert.equal(process.versions.node, NODE_VERSION, "Run native qualification with the bound Node version");
  const target = TARGETS.find(t => t.os === process.platform && t.cpu === process.arch);
  assert.ok(target);
  const fx = await createSourceFixture(target);
  try {
    const sourceRoot = join(fx.fixtureDir, "native-source");
    const sourcePaths = ["tools/build-directory-snapshot-native.mjs", "native/directory-snapshot/src/directory_snapshot.c"];
    for (const path of sourcePaths) {
      await mkdir(dirname(join(sourceRoot, path)), { recursive: true });
      await cp(join(repoRoot, path), join(sourceRoot, path));
      await mkdir(dirname(join(fx.burstRoot, path)), { recursive: true });
      await cp(join(repoRoot, path), join(fx.burstRoot, path));
    }
    const compiler = process.env.CC ?? "/usr/bin/cc";
    assert.ok(compiler.startsWith("/"), "Compiler must be explicit and absolute");
    const headers = resolve(dirname(process.execPath), "../include/node");
    const nativeDir = join(fx.burstRoot, "native/directory-snapshot/prebuilds", target.addon);
    const result = spawnSync(process.execPath, [join(sourceRoot, sourcePaths[0]), "--source-build", "--artifact", target.addon,
      "--compiler", compiler, "--node-include", headers, "--output", nativeDir], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const manifestPath = join(nativeDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(await nativeHeaderIdentity(headers), manifest.nodeHeadersSha256, "Maintained header hasher matches actual producer");
    const components = {};
    const h = "a".repeat(64);
    for (const [name, product] of [["burst", "stellar-burst"], ["loom", "stellar-loom"], ["solar", "solar-sail"]]) {
      const root = name === "burst" ? fx.burstRoot : join(fx.fixtureDir, name);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ name: `@knowledge-forge-ai/theme-forge-${product}`, version: "0.6.0", type: "module" }));
      components[name] = { root, sourceRoot, source: (await inventoryTree(sourceRoot)).identity,
        output: (await inventoryTree(root)).identity, target: target.triple, version: "0.6.0", producer: h };
    }
    const source = seal("nebular-source-candidate-v1", { version: "0.6.0", composition: h, locks: { cargo: h, frontend: h },
      components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, v.source])), recipe: h,
      resourcePlans: sourceResourcePlans(JSON.parse(await readFile(join(repoRoot, "apps/studio/src-tauri/tauri.conf.json"), "utf8"))) });
    const toolchains = Object.fromEntries(await Promise.all(["node", "rust", "cargo", "compiler", "linker", "pkgConfig", "systemLibraries"].map(async key => {
      const path = key === "compiler" ? compiler : process.execPath;
      return [key, { path, identity: sha256(await readFile(path)) }];
    })));
    const inputs = { schema: "nebular-build-inputs-v1", mode: "nix-source", target: target.triple, source,
      components, toolchains, settings: await createBuildSettings({}) };
    const resealOutput = async () => { inputs.components.burst.output = (await inventoryTree(fx.burstRoot)).identity; };
    const validManifest = await readFile(manifestPath);
    const nativePath = join(nativeDir, "native-addon-posix-openat-v1.node");
    const validNative = await readFile(nativePath);
    const portableNative = await readFile(join(repoRoot, "native/directory-snapshot/prebuilds", target.addon, "native-addon-posix-openat-v1.node"));
    assert.notEqual(sha256(validNative), sha256(portableNative));
    const nativeAuthority = await validateSourceBuiltNative(inputs);
    assert.equal(nativeAuthority.nativeSha256, sha256(validNative));
    const prepared = await prepareSidecar({ release: true, studioRoot: fx.studioRoot, nodePath: process.execPath,
      sourceIdentity: source.identity, componentRoots: { burst: fx.burstRoot, raster: fx.rasterRoot }, target,
      mode: "nix-source", buildInputs: inputs });
    const payloadRoot = join(fx.studioRoot, "src-tauri/sidecar-payload");
    const binaryPath = join(fx.studioRoot, "src-tauri/binaries", sidecarBinaryName(target));
    assert.equal((await verifyDistribution({ binaryPath, payloadRoot, mode: "nix-source", buildInputs: inputs })).manifestDigest, prepared.manifestDigest);
    await assert.rejects(verifyDistribution({ binaryPath, payloadRoot }));
    await assert.rejects(verifyDistribution({ binaryPath, payloadRoot, mode: "portable-source", buildInputs: inputs }));
    await assert.rejects(verifyDistribution({ binaryPath, payloadRoot, mode: "nix-source" }));
    const saved = process.env.NEBULAR_BUILD_INPUTS;
    process.env.NEBULAR_BUILD_INPUTS = "/ambient-input-is-not-authority";
    try { await assert.rejects(verifySidecar([], join(fx.studioRoot, "src-tauri"))); }
    finally { if (saved === undefined) delete process.env.NEBULAR_BUILD_INPUTS; else process.env.NEBULAR_BUILD_INPUTS = saved; }
    const sidecarManifest = JSON.parse(await readFile(join(payloadRoot, "manifest.json"), "utf8"));
    validateManifestShape(sidecarManifest, { nativeAuthority });
    assert.throws(() => validateManifestShape(sidecarManifest, { nativeAuthority: { ...nativeAuthority } }));
    assert.throws(() => validateManifestShape(sidecarManifest, { allowNixRuntime: true }));
    const alternateModel = structuredClone(sidecarManifest);
    alternateModel.source = { model: "source-identity-v2", sourceIdentity: source.identity,
      actualInputDigest: alternateModel.source.actualInputDigest };
    assert.throws(() => validateManifestShape(alternateModel), /fixed identity/);
    for (const [label, mutate] of [
      ["schema", m => { m.schemaVersion = 2; }], ["backend", m => { m.backend = "other"; }],
      ["ABI", m => { m.abiVersion = 2; }], ["N-API", m => { m.nodeApiVersion = "999"; }],
      ["target", m => { m.artifact = "other"; }], ["platform", m => { m.platform = "other"; }],
      ["architecture", m => { m.architecture = "other"; }], ["libc", m => { m.libc = "musl"; }],
      ["source", m => { m.nativeSourceSha256 = h; }], ["tool", m => { m.buildToolSha256 = h; }],
      ["compiler", m => { m.compilerExecutableSha256 = h; }], ["headers", m => { m.nodeHeadersSha256 = h; }],
      ["explicitToolchain", m => { delete m.sourceIdentity.explicitToolchain; }],
      ["unknown", m => { m.extra = true; }], ["command", m => { m.command.push("-DUNTRUSTED"); }],
      ["Node major", m => { m.nodeVersion = "v24.0.0"; }],
    ]) {
      await context.test(label, async () => {
        const altered = structuredClone(manifest); mutate(altered);
        await writeFile(manifestPath, JSON.stringify(altered, null, 2) + "\n"); await resealOutput();
        await assert.rejects(validateSourceBuiltNative(inputs));
        await writeFile(manifestPath, validManifest); await resealOutput();
      });
    }
    const changed = Buffer.from(validNative); changed[changed.length - 1] ^= 1;
    await writeFile(nativePath, changed);
    await assert.rejects(validateSourceBuiltNative(inputs), /output inventory/);
    await resealOutput(); await assert.rejects(validateSourceBuiltNative(inputs), /artifact mismatch/);
    await writeFile(manifestPath, JSON.stringify({ ...manifest, artifactSha256: sha256(changed), buildToolSha256: h }, null, 2) + "\n");
    await resealOutput(); await assert.rejects(validateSourceBuiltNative(inputs), /buildToolSha256 mismatch/);
    await writeFile(nativePath, validNative); await writeFile(manifestPath, validManifest); await resealOutput();
    await writeFile(join(sourceRoot, sourcePaths[0]), "changed producer");
    await assert.rejects(validateSourceBuiltNative(inputs), /source inventory mismatch/);
    await cp(join(repoRoot, sourcePaths[0]), join(sourceRoot, sourcePaths[0]));
    await cp(join(repoRoot, "native/directory-snapshot/prebuilds", target.addon, "manifest.json"), manifestPath);
    await resealOutput(); await assert.rejects(validateSourceBuiltNative(inputs), /native source manifest/);
  } finally { await fx.cleanup(); }
});

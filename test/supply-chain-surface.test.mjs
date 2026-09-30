// @vitest-environment node
// The peer supply-chain job scans a surface it materializes itself; the aggregate cross-check binds that
// surface to the same run's shipped macOS bundle (every Contents/Resources entry), sidecar payload,
// runtime and embedded frontend, and bounds how the frontend job's Linux-built distributable may differ.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  DECLARED_OMISSIONS, OMITTED_RESOURCES, SURFACE_SCHEMA, bundleResourceNames, comparePlatformFrontends, crossCheckSurface, materializeSurface,
} from "../tools/supply-chain-surface.mjs";
import { finalizeDarwinAppBundle } from "../tools/finalize-darwin-bundle.mjs";
import { PAGEFIND_WASM_PAYLOADS } from "../tools/pagefind-index.mjs";

const APP = "Theme Forge Nebular Fusion.app";
const RESOURCES = ["sidecar-payload", "loom-payload", "loom-adapter", "solar-sail-payload", "solar-sail-adapter", "scene-payload", "release-notices"];
const SHIPPED_ENTRIES = [...RESOURCES, "bin", "LICENSE", "NOTICE"].sort();
const DARWIN = { os: "darwin", cpu: "arm64", triple: "aarch64-apple-darwin", system: "aarch64-darwin" };
const RUN_43 = JSON.parse(readFileSync(new URL("./fixtures/ci9/run-43-supply-chain-surface-cross-check.json", import.meta.url), "utf8"));
const RUN_43_FRONTEND = RUN_43.groups.find((group) => group.group === "frontend");
const WASM_PATH = /wasm\.[a-z]+\.pagefind$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Synthetic Pagefind WASM payloads: the Darwin and Linux release binaries embed different WASM, and each
// Linux binary gzips it with its own header time. Tests pin these synthetic payloads.
const WASM = {
  darwin: { "wasm.en.pagefind": Buffer.from("darwin wasm en"), "wasm.unknown.pagefind": Buffer.from("darwin wasm unknown") },
  linux: { "wasm.en.pagefind": Buffer.from("linux wasm en"), "wasm.unknown.pagefind": Buffer.from("linux wasm unknown") },
};
const TEST_PINS = {
  "darwin-arm64": Object.fromEntries(Object.entries(WASM.darwin).map(([name, bytes]) => [name, sha256(bytes)])),
  "linux-x64": Object.fromEntries(Object.entries(WASM.linux).map(([name, bytes]) => [name, sha256(bytes)])),
};
const gz = (bytes, mtime = 0) => { const out = gzipSync(bytes); out.writeUInt32LE(mtime, 4); return out; };

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function tar(archive, cwd, member) {
  mkdirSync(dirname(archive), { recursive: true });
  execFileSync("tar", ["-czf", archive, "-C", cwd, member]);
}

function writeProducer(downloadDir, artifact, files) {
  const directory = join(downloadDir, artifact);
  const artifacts = Object.entries(files).map(([path, source]) => {
    const bytes = readFileSync(source);
    write(join(directory, path), bytes);
    return { path, size: bytes.length, sha256: sha256(bytes) };
  });
  write(join(directory, "artifact-manifest.json"), JSON.stringify({ schema: "tfsb.ci-job-artifact-manifest", schemaVersion: 1, status: "pass", job: artifact, matrix: {}, artifacts }));
}

// A frontend distributable carrying the exact run-43 gallery Pagefind layout. In run 43 the surface
// (macOS rebuild) held the "extraInSurface" index names and the Linux frontend artifact the
// "missingFromSurface" names; "different" held entry/manifest metadata and every WASM member.
function frontendTree(dir, platform, { indexNames = "macos" } = {}) {
  write(join(dir, "index.html"), "<!doctype html>");
  write(join(dir, "assets/app.js"), "console.log(1)");
  for (const path of indexNames === "macos" ? RUN_43_FRONTEND.extraInSurface : RUN_43_FRONTEND.missingFromSurface) write(join(dir, path), `index ${path}`);
  for (const path of RUN_43_FRONTEND.different) {
    const name = path.split("/").pop();
    if (WASM_PATH.test(path)) write(join(dir, path), gz(WASM[platform][name], platform === "linux" ? 1_700_000_000 : 1_600_000_000));
    else write(join(dir, path), indexNames === "macos" ? `canonical ${path}` : `order-dependent ${path}`);
  }
}

let root;
let checkout;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nebular-surface-test-"));
  checkout = join(root, "checkout");
  frontendTree(join(checkout, "dist"), "darwin");
  write(join(checkout, "LICENSE"), "AGPL-3.0-or-later text\n");
  write(join(checkout, "NOTICE"), "Nebular notice\n");
  write(join(checkout, ".test-reports/nebular/node-runtime"), "node runtime bytes");
  write(join(checkout, ".test-reports/nebular/node-authenticity/receipt.json"), "{}");
  write(join(checkout, ".test-reports/nebular/node-authenticity/SHASUMS256.txt.asc"), "signed");
  write(join(checkout, "src-tauri/tauri.conf.json"), JSON.stringify({ bundle: { resources: RESOURCES.map((name) => `${name}/**/*`) } }));
  for (const name of RESOURCES) write(join(checkout, "src-tauri", name, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  write(join(checkout, "src-tauri/sidecar-payload/node_modules/dep/package.json"), JSON.stringify({ name: "dep", version: "2.0.0" }));
  tar(join(checkout, ".test-reports/nebular/sidecar-payload.tar.gz"), join(checkout, "src-tauri"), "sidecar-payload");
  for (const file of ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "authenticated-inputs/core/package.json",
    "authenticated-inputs/core/package-lock.json", "loom-preview-source/package.json", "loom-preview-source/package-lock.json"]) {
    write(join(checkout, file), `inventory:${file}`);
  }
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function materialize() {
  return materializeSurface({ root: checkout, releaseDir: join(root, "release"), inventoryDir: join(root, "inventory"), reportDir: ".test-reports/nebular",
    manifestPath: join(root, "supply-chain/release-surface.json") });
}

// Producer artifacts as the frontend and macOS jobs of the same run would upload them. The macOS bundle
// is finalized by the maintained finalizer, exactly as tools/build-app.mjs does.
async function producers({ mutate, linuxFrontend = "canonical" } = {}) {
  const downloadDir = join(root, "downloaded");
  rmSync(downloadDir, { recursive: true, force: true });
  const app = join(root, "app-build");
  rmSync(app, { recursive: true, force: true });
  mkdirSync(join(app, APP, "Contents/Resources"), { recursive: true });
  for (const name of RESOURCES) execFileSync("cp", ["-R", join(checkout, "src-tauri", name), join(app, APP, "Contents/Resources/")]);
  write(join(app, APP, "Contents/MacOS/theme-forge-nebular-fusion"), "main executable");
  write(join(app, APP, "Contents/Info.plist"), "plist");
  await finalizeDarwinAppBundle({ app: join(app, APP), productTarget: DARWIN, studioRoot: checkout, skipSigning: true });
  mutate?.(join(app, APP, "Contents"));
  tar(join(root, "artifacts/nebular-fusion.app.tar.gz"), app, APP);
  tar(join(root, "artifacts/embedded/frontend-dist.tar.gz"), join(checkout, "dist"), ".");
  const linux = join(root, "linux-frontend");
  rmSync(linux, { recursive: true, force: true });
  frontendTree(linux, "linux", { indexNames: linuxFrontend === "canonical" ? "macos" : "linux" });
  tar(join(root, "artifacts/frontend/frontend-dist.tar.gz"), linux, ".");
  writeProducer(downloadDir, "nebular-macos-arm64-artifacts", {
    "node-runtime": join(checkout, ".test-reports/nebular/node-runtime"),
    "sidecar-payload.tar.gz": join(checkout, ".test-reports/nebular/sidecar-payload.tar.gz"),
    "nebular-fusion.app.tar.gz": join(root, "artifacts/nebular-fusion.app.tar.gz"),
    "frontend-dist.tar.gz": join(root, "artifacts/embedded/frontend-dist.tar.gz"),
  });
  writeProducer(downloadDir, "frontend-artifacts", { "frontend-dist.tar.gz": join(root, "artifacts/frontend/frontend-dist.tar.gz") });
  writeProducer(downloadDir, "supply-chain-artifacts", { "release-surface.json": join(root, "supply-chain/release-surface.json") });
  return downloadDir;
}

const crossCheck = (downloadDir) => crossCheckSurface({ downloadDir, pagefindPayloads: TEST_PINS });

describe("supply-chain release surface", () => {
  it("omits no bundle resource and materializes every Contents/Resources entry", async () => {
    expect(OMITTED_RESOURCES).toEqual({});
    expect(DECLARED_OMISSIONS.some((entry) => entry.path.includes("resources/"))).toBe(false);
    const manifest = await materialize();
    const paths = manifest.files.map((file) => file.path);
    expect(manifest.schema).toBe(SURFACE_SCHEMA);
    expect(manifest.resources).toEqual(SHIPPED_ENTRIES);
    for (const path of ["frontend/frontend-dist.tar.gz", "frontend/install/index.html", "frontend/install/assets/app.js", "runtime/node-runtime", "runtime/catalog/node",
      "runtime/node-authenticity/receipt.json", "runtime/node-authenticity/SHASUMS256.txt.asc", "sidecar/sidecar-payload.tar.gz",
      "sidecar/extracted/sidecar-payload/node_modules/dep/package.json", "resources/sidecar-payload/node_modules/dep/package.json", "resources/scene-payload/package.json",
      "resources/release-notices/package.json", "resources/bin/tfnf", "resources/LICENSE", "resources/NOTICE"]) {
      expect(paths, path).toContain(path);
    }
    expect(manifest.inventory.map((file) => file.path).sort()).toEqual(["core/package-lock.json", "core/package.json", "frontend/package-lock.json", "frontend/package.json",
      "loom/package-lock.json", "loom/package.json", "rust/Cargo.lock", "rust/Cargo.toml"]);
    expect(manifest.files.find((file) => file.path === "runtime/catalog/node").sha256).toBe(sha256(Buffer.from("node runtime bytes")));
    expect(manifest.omissions).toEqual(DECLARED_OMISSIONS);
    expect(JSON.parse(readFileSync(join(root, "supply-chain/release-surface.json"), "utf8"))).toEqual(manifest);
  });

  it("refuses symbolic links in shipped trees and unsupported resource patterns", async () => {
    symlinkSync("/etc/hosts", join(checkout, "src-tauri/loom-payload/escape"));
    await expect(materialize()).rejects.toThrow(/cannot contain symbolic links/);
    expect(() => bundleResourceNames({ bundle: { resources: ["../outside/*"] } })).toThrow(/unsupported bundle resource pattern/);
  });

  it("proves the scanned surface equals the same run's shipped bundle and embedded frontend", async () => {
    await materialize();
    const result = await crossCheck(await producers());
    expect(result.status).toBe("pass");
    expect(result.schemaVersion).toBe(2);
    expect(result.groups.map((group) => group.group)).toEqual(["runtime", "sidecar", "resource-set", ...SHIPPED_ENTRIES.map((name) => `resources/${name}`),
      "frontend", "frontend-platform-equivalence"]);
    expect(result.groups.every((group) => group.equal)).toBe(true);
    expect(result.groups.find((group) => group.group === "frontend-platform-equivalence").acceptedPlatformWasm).toBe(10);
  });

  it("fails when a shipped resource differs from the scanned one or is not scanned at all", async () => {
    await materialize();
    const changed = await crossCheck(await producers({ mutate: (contents) => write(join(contents, "Resources/loom-payload/package.json"), "changed") }));
    expect(changed.status).toBe("fail");
    expect(changed.groups.find((group) => group.group === "resources/loom-payload")).toMatchObject({ equal: false, different: ["package.json"] });
    const launcher = await crossCheck(await producers({ mutate: (contents) => write(join(contents, "Resources/bin/tfnf"), "#!/bin/sh\nexit 0\n") }));
    expect(launcher.groups.find((group) => group.group === "resources/bin")).toMatchObject({ equal: false, different: ["tfnf"] });
    const notice = await crossCheck(await producers({ mutate: (contents) => write(join(contents, "Resources/NOTICE"), "other notice") }));
    expect(notice.groups.find((group) => group.group === "resources/NOTICE")).toMatchObject({ equal: false, different: [""] });
    const unscanned = await crossCheck(await producers({ mutate: (contents) => write(join(contents, "Resources/new-payload/package.json"), "{}") }));
    expect(unscanned.status).toBe("fail");
    expect(unscanned.groups.find((group) => group.group === "resource-set")).toMatchObject({ equal: false, unscanned: ["new-payload"] });
    const strayFile = await crossCheck(await producers({ mutate: (contents) => write(join(contents, "Resources/stray.txt"), "x") }));
    expect(strayFile.groups.find((group) => group.group === "resource-set")).toMatchObject({ equal: false, unscanned: ["stray.txt"] });
  });

  it("fails when the scanned frontend is not the frontend the application embedded", async () => {
    await materialize();
    write(join(checkout, "dist/assets/app.js"), "console.log(2)");
    const result = await crossCheck(await producers());
    expect(result.groups.find((group) => group.group === "frontend")).toMatchObject({ equal: false, different: ["assets/app.js"] });
  });

  it("rejects producer bytes that do not match their producer manifest, and a producer without the embedded frontend", async () => {
    await materialize();
    const downloadDir = await producers();
    write(join(downloadDir, "nebular-macos-arm64-artifacts/node-runtime"), "substituted runtime");
    await expect(crossCheck(downloadDir)).rejects.toThrow(/node-runtime does not match its producer manifest/);
    write(join(downloadDir, "nebular-macos-arm64-artifacts/node-runtime"), "node runtime bytes");
    const manifestPath = join(downloadDir, "nebular-macos-arm64-artifacts/artifact-manifest.json");
    const producerManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    producerManifest.artifacts = producerManifest.artifacts.filter((entry) => entry.path !== "frontend-dist.tar.gz");
    write(manifestPath, JSON.stringify(producerManifest));
    await expect(crossCheck(downloadDir)).rejects.toThrow(/frontend-dist.tar.gz is absent from its producer manifest/);
  });
});

describe("run-43 aggregate cross-check regression (exact run 36663050387 lists)", () => {
  it("the retained run-43 result is the failure being repaired", () => {
    expect(RUN_43.status).toBe("fail");
    expect(RUN_43.groups.find((group) => group.group === "resource-set").unscanned).toEqual(["bin"]);
    expect(RUN_43_FRONTEND.missingFromSurface).toHaveLength(8);
    expect(RUN_43_FRONTEND.different).toHaveLength(15);
  });

  it("before: the CI8 surface (release-notices omitted, no finalized members) leaves shipped resources unscanned", async () => {
    await materialize();
    const surfacePath = join(root, "supply-chain/release-surface.json");
    const ci8 = JSON.parse(readFileSync(surfacePath, "utf8"));
    ci8.resources = RUN_43.groups.find((group) => group.group === "resource-set").scanned;
    ci8.files = ci8.files.filter((file) => !/^resources\/(bin\/|LICENSE$|NOTICE$|release-notices\/)/.test(file.path));
    write(surfacePath, JSON.stringify(ci8));
    const result = await crossCheck(await producers());
    expect(result.status).toBe("fail");
    expect(result.groups.find((group) => group.group === "resource-set").unscanned).toEqual(["LICENSE", "NOTICE", "bin", "release-notices"]);
  });

  it("before: an order-dependent Linux gallery index differs from the embedded frontend beyond the platform WASM", async () => {
    await materialize();
    const result = await crossCheck(await producers({ linuxFrontend: "order-dependent" }));
    const equivalence = result.groups.find((group) => group.group === "frontend-platform-equivalence");
    expect(result.status).toBe("fail");
    expect(result.groups.find((group) => group.group === "frontend").equal).toBe(true);
    expect([...equivalence.missing].sort()).toEqual([...RUN_43_FRONTEND.extraInSurface].sort());
    expect([...equivalence.extra].sort()).toEqual([...RUN_43_FRONTEND.missingFromSurface].sort());
    expect([...equivalence.different].sort()).toEqual(RUN_43_FRONTEND.different.filter((path) => !WASM_PATH.test(path)).sort());
    expect(equivalence.acceptedPlatformWasm).toBe(10);
  });

  it("after: the deterministic CLI index leaves only the pinned per-platform Pagefind WASM, and the run passes", async () => {
    await materialize();
    const result = await crossCheck(await producers());
    expect(result.status).toBe("pass");
    const equivalence = result.groups.find((group) => group.group === "frontend-platform-equivalence");
    expect(equivalence.platformWasm.map((entry) => entry.path).sort()).toEqual(RUN_43_FRONTEND.different.filter((path) => WASM_PATH.test(path)).sort());
    expect(equivalence.platformWasm.every((entry) => entry.accepted)).toBe(true);
  });

  it("an unpinned WASM payload or any other difference still fails", async () => {
    const left = join(root, "left"), right = join(root, "right");
    frontendTree(left, "darwin");
    frontendTree(right, "linux");
    expect((await comparePlatformFrontends(left, "darwin-arm64", right, "linux-x64", { payloads: TEST_PINS })).equal).toBe(true);
    write(join(right, "preview/pagefind/wasm.en.pagefind"), gz(Buffer.from("tampered wasm")));
    expect(await comparePlatformFrontends(left, "darwin-arm64", right, "linux-x64", { payloads: TEST_PINS }))
      .toMatchObject({ equal: false, different: ["preview/pagefind/wasm.en.pagefind"] });
    write(join(right, "preview/pagefind/wasm.en.pagefind"), gz(WASM.linux["wasm.en.pagefind"]));
    write(join(right, "preview/gallery/manifest.json"), "drift");
    expect((await comparePlatformFrontends(left, "darwin-arm64", right, "linux-x64", { payloads: TEST_PINS })).different).toEqual(["preview/gallery/manifest.json"]);
    await expect(comparePlatformFrontends(left, "darwin-arm64", right, "windows-x64")).rejects.toThrow(/no pinned Pagefind payloads/);
  });

  it("accepts a gallery manifest only when its totalBytes is each side's own staged gallery size", async () => {
    const left = join(root, "left-manifest"), right = join(root, "right-manifest");
    frontendTree(left, "darwin");
    frontendTree(right, "linux");
    const size = (dir) => {
      let total = 0;
      const visit = (path) => { for (const name of execFileSync("ls", ["-A", path], { encoding: "utf8" }).split("\n").filter(Boolean)) {
        const child = join(path, name);
        try { execFileSync("test", ["-d", child]); visit(child); } catch { total += readFileSync(child).length; }
      } };
      for (const name of execFileSync("ls", [join(dir, "preview/gallery")], { encoding: "utf8" }).split("\n").filter((entry) => entry.endsWith("-catalog"))) visit(join(dir, "preview/gallery", name));
      return total;
    };
    const manifest = (dir, extra = {}) => write(join(dir, "preview/gallery/manifest.json"), JSON.stringify({ schema: "gallery", totalFiles: 3, totalBytes: size(dir), ...extra }));
    manifest(left);
    manifest(right);
    const accepted = await comparePlatformFrontends(left, "darwin-arm64", right, "linux-x64", { payloads: TEST_PINS });
    expect(accepted.equal).toBe(true);
    expect(accepted.galleryManifest).toMatchObject({ accepted: true, sameOtherwise: true });
    expect(accepted.galleryManifest.totalBytes[0]).not.toBe(accepted.galleryManifest.totalBytes[1]);
    manifest(right, { totalBytes: size(right) + 1 });
    expect((await comparePlatformFrontends(left, "darwin-arm64", right, "linux-x64", { payloads: TEST_PINS })).different).toEqual(["preview/gallery/manifest.json"]);
    manifest(right, { totalFiles: 4 });
    expect((await comparePlatformFrontends(left, "darwin-arm64", right, "linux-x64", { payloads: TEST_PINS })).different).toEqual(["preview/gallery/manifest.json"]);
  });

  it("pins the real Pagefind 1.5.2 release payloads for every builder platform", () => {
    expect(Object.keys(PAGEFIND_WASM_PAYLOADS).sort()).toEqual(["darwin-arm64", "linux-arm64", "linux-x64"]);
    for (const pins of Object.values(PAGEFIND_WASM_PAYLOADS)) {
      expect(Object.keys(pins).sort()).toEqual(["wasm.en.pagefind", "wasm.unknown.pagefind"]);
      for (const digest of Object.values(pins)) expect(digest).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(PAGEFIND_WASM_PAYLOADS["linux-arm64"]).toEqual(PAGEFIND_WASM_PAYLOADS["linux-x64"]);
    expect(PAGEFIND_WASM_PAYLOADS["darwin-arm64"]["wasm.en.pagefind"]).not.toBe(PAGEFIND_WASM_PAYLOADS["linux-x64"]["wasm.en.pagefind"]);
  });
});

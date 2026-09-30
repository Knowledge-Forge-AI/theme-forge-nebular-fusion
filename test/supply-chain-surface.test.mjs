// @vitest-environment node
// The peer supply-chain job scans a surface it materializes itself; the aggregate cross-check binds that
// surface to the same run's shipped macOS bundle, sidecar payload, runtime and frontend artifact.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DECLARED_OMISSIONS, SURFACE_SCHEMA, bundleResourceNames, crossCheckSurface, materializeSurface } from "../tools/supply-chain-surface.mjs";

const APP = "Theme Forge Nebular Fusion.app";
const RESOURCES = ["sidecar-payload", "loom-payload", "loom-adapter", "solar-sail-payload", "solar-sail-adapter", "scene-payload", "release-notices"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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

let root;
let checkout;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nebular-surface-test-"));
  checkout = join(root, "checkout");
  write(join(checkout, "dist/index.html"), "<!doctype html>");
  write(join(checkout, "dist/assets/app.js"), "console.log(1)");
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

// Producer artifacts as the frontend and macOS jobs of the same run would upload them.
function producers({ mutate } = {}) {
  const downloadDir = join(root, "downloaded");
  const app = join(root, "app-build");
  mkdirSync(join(app, APP, "Contents/Resources"), { recursive: true });
  for (const name of RESOURCES) execFileSync("cp", ["-R", join(checkout, "src-tauri", name), join(app, APP, "Contents/Resources/")]);
  write(join(app, APP, "Contents/MacOS/theme-forge-nebular-fusion"), "main executable");
  write(join(app, APP, "Contents/Info.plist"), "plist");
  mutate?.(join(app, APP, "Contents"));
  tar(join(root, "artifacts/nebular-fusion.app.tar.gz"), app, APP);
  tar(join(root, "artifacts/frontend-dist.tar.gz"), join(checkout, "dist"), ".");
  writeProducer(downloadDir, "nebular-macos-arm64-artifacts", {
    "node-runtime": join(checkout, ".test-reports/nebular/node-runtime"),
    "sidecar-payload.tar.gz": join(checkout, ".test-reports/nebular/sidecar-payload.tar.gz"),
    "nebular-fusion.app.tar.gz": join(root, "artifacts/nebular-fusion.app.tar.gz"),
  });
  writeProducer(downloadDir, "frontend-artifacts", { "frontend-dist.tar.gz": join(root, "artifacts/frontend-dist.tar.gz") });
  writeProducer(downloadDir, "supply-chain-artifacts", { "release-surface.json": join(root, "supply-chain/release-surface.json") });
  return downloadDir;
}

describe("supply-chain release surface", () => {
  it("materializes every shipped input except the declared omissions", async () => {
    const manifest = await materialize();
    const paths = manifest.files.map((file) => file.path);
    expect(manifest.schema).toBe(SURFACE_SCHEMA);
    expect(manifest.resources).toEqual(RESOURCES.filter((name) => name !== "release-notices"));
    for (const path of ["frontend/frontend-dist.tar.gz", "frontend/install/index.html", "frontend/install/assets/app.js", "runtime/node-runtime", "runtime/catalog/node",
      "runtime/node-authenticity/receipt.json", "runtime/node-authenticity/SHASUMS256.txt.asc", "sidecar/sidecar-payload.tar.gz",
      "sidecar/extracted/sidecar-payload/node_modules/dep/package.json", "resources/sidecar-payload/node_modules/dep/package.json", "resources/scene-payload/package.json"]) {
      expect(paths, path).toContain(path);
    }
    expect(paths.some((path) => path.startsWith("resources/release-notices/"))).toBe(false);
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

  it("proves the scanned surface equals the same run's shipped artifacts", async () => {
    await materialize();
    const result = await crossCheckSurface({ downloadDir: producers() });
    expect(result.status).toBe("pass");
    expect(result.groups.map((group) => group.group)).toEqual(["runtime", "sidecar", "resource-set", ...RESOURCES.filter((name) => name !== "release-notices").sort().map((name) => `resources/${name}`), "frontend"]);
    expect(result.groups.every((group) => group.equal)).toBe(true);
  });

  it("fails when a shipped resource differs from the scanned one or is not scanned at all", async () => {
    await materialize();
    const changed = await crossCheckSurface({ downloadDir: producers({ mutate: (contents) => write(join(contents, "Resources/loom-payload/package.json"), "changed") }) });
    expect(changed.status).toBe("fail");
    expect(changed.groups.find((group) => group.group === "resources/loom-payload")).toMatchObject({ equal: false, different: ["package.json"] });
    rmSync(join(root, "downloaded"), { recursive: true, force: true });
    rmSync(join(root, "app-build"), { recursive: true, force: true });
    const unscanned = await crossCheckSurface({ downloadDir: producers({ mutate: (contents) => write(join(contents, "Resources/new-payload/package.json"), "{}") }) });
    expect(unscanned.status).toBe("fail");
    expect(unscanned.groups.find((group) => group.group === "resource-set")).toMatchObject({ equal: false, unscanned: ["new-payload"] });
  });

  it("rejects producer bytes that do not match their producer manifest", async () => {
    await materialize();
    const downloadDir = producers();
    write(join(downloadDir, "nebular-macos-arm64-artifacts/node-runtime"), "substituted runtime");
    await expect(crossCheckSurface({ downloadDir })).rejects.toThrow(/node-runtime does not match its producer manifest/);
  });
});

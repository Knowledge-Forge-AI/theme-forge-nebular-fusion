// @vitest-environment node
import { describe, expect, it, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  collectFrontendSupplementalNotices,
  generateReleaseNotices,
  renderThirdPartyNoticesJson,
} from "../tools/release-notices.mjs";

const REPO_ROOT = resolve(new URL("../../..", import.meta.url).pathname);
const SOURCE_STUDIO = join(REPO_ROOT, "apps/studio");
const SOURCE_SUPPLEMENTAL = join(SOURCE_STUDIO, "legal/supplemental");
const SOURCE_FIXTURE = join(REPO_ROOT, "packages/stellar-loom/fixture");
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nebular-release-notices-"));
  roots.push(root);
  const studio = join(root, "apps/studio");
  const supplemental = join(studio, "legal/supplemental");
  const fixture = join(root, "packages/stellar-loom/fixture");
  mkdirSync(join(studio, "legal"), { recursive: true });
  cpSync(SOURCE_SUPPLEMENTAL, supplemental, { recursive: true });
  mkdirSync(studio, { recursive: true });
  cpSync(join(SOURCE_STUDIO, "package.json"), join(studio, "package.json"));
  mkdirSync(fixture, { recursive: true });
  for (const name of ["package.json", "package-lock.json"]) cpSync(join(SOURCE_FIXTURE, name), join(fixture, name));
  return { root, studio, supplemental, fixture, manifestPath: join(supplemental, "manifest.json") };
}

function manifestAt(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeManifest(path, manifest) {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe("authenticated distributed frontend legal supplements", () => {
  it("joins the current fixture package and lock and renders the four runtime records", () => {
    const { root, studio, supplemental, manifestPath } = setup();
    const manifest = manifestAt(manifestPath);
    const records = collectFrontendSupplementalNotices(studio, root, supplemental, manifest);
    expect(records.map(({ name, version }) => `${name}@${version}`)).toEqual([
      "@astrojs/starlight@0.42.0",
      "@pagefind/default-ui@1.5.2",
      "astro@7.3.3",
      "pagefind@1.5.2",
    ]);
    expect(records.find(({ name }) => name === "@pagefind/default-ui").licenseSourcePackage).toBe("pagefind@1.5.2");
    expect(records.find(({ name }) => name === "@pagefind/default-ui").embeddedProvenance.sourceFiles).toHaveLength(5);
    expect(records.find(({ name }) => name === "@pagefind/default-ui").embeddedProvenance.bundledDependencies.map(({ package: name, version }) => `${name}@${version}`)).toEqual([
      "svelte@4.2.20",
      "bcp-47@2.1.0",
      "is-alphabetical@2.0.1",
      "is-alphanumerical@2.0.1",
      "is-decimal@2.0.1",
    ]);
    const rendered = JSON.parse(renderThirdPartyNoticesJson({ root: { version: "0.7.0" }, frontend: records }));
    expect(rendered.frontend.map(({ name }) => name)).toEqual(["@astrojs/starlight", "@pagefind/default-ui", "astro", "pagefind"]);
    expect(rendered.frontend.every(({ files, hasLicenseText }) => files.length >= 1 && hasLicenseText)).toBe(true);
    expect(rendered.frontend.find(({ name }) => name === "pagefind").files).toContain("npm-frontend/pagefind-1.5.2/mark.js-LICENSE.txt");
    expect(rendered.frontend.find(({ name }) => name === "pagefind").files).toContain("npm-frontend/pagefind-1.5.2/mark.js-MIT.txt");
    expect(rendered.frontend.find(({ name }) => name === "@pagefind/default-ui").files).toEqual(expect.arrayContaining([
      "npm-frontend/pagefind-default-ui-1.5.2/svelte-4.2.20-LICENSE.md",
      "npm-frontend/pagefind-default-ui-1.5.2/bcp-47-2.1.0-license",
      "npm-frontend/pagefind-default-ui-1.5.2/is-alphabetical-2.0.1-license",
      "npm-frontend/pagefind-default-ui-1.5.2/is-alphanumerical-2.0.1-license",
      "npm-frontend/pagefind-default-ui-1.5.2/is-decimal-2.0.1-license",
    ]));
    const markFull = manifest.frontendPackages.find(({ name }) => name === "pagefind").files.find(({ path }) => path.endsWith("mark.js-MIT.txt"));
    expect(markFull.upstream).toEqual({
      package: "mark.js",
      version: "8.11.1",
      repository: "https://github.com/julmot/mark.js",
      revision: "8.11.1",
      path: "LICENSE",
      url: "https://raw.githubusercontent.com/julmot/mark.js/8.11.1/LICENSE",
    });
  });

  it("generates current-product notices from the tracked supplement without installed frontend dependencies", async () => {
    const { studio, root } = setup();
    const output = join(root, "release-notices");
    const cargoMetadata = { resolve: { root: "root", nodes: [{ id: "root", deps: [] }] }, packages: [{ id: "root", name: "theme-forge-nebular-fusion", version: "0.7.0" }] };
    const result = await generateReleaseNotices({
      studioRoot: studio,
      repoRoot: root,
      outDir: output,
      cargoMetadata,
      cargoLockContent: "",
      frontendSupplemental: true,
      allowExternalOutDir: true,
    });
    expect(result.success).toBe(true);
    expect(result.manifest.frontend.map(({ name }) => name)).toEqual(["@astrojs/starlight", "@pagefind/default-ui", "astro", "pagefind"]);
    expect(JSON.parse(readFileSync(join(output, "THIRD-PARTY-NOTICES.json"), "utf8")).frontend).toHaveLength(4);
  });

  it("refuses the current route when the four distributed frontend identities are absent", async () => {
    const { studio, root, manifestPath } = setup();
    const manifest = manifestAt(manifestPath);
    delete manifest.frontendPackages;
    writeManifest(manifestPath, manifest);
    const cargoMetadata = { resolve: { root: "root", nodes: [{ id: "root", deps: [] }] }, packages: [{ id: "root", name: "theme-forge-nebular-fusion", version: "0.7.0" }] };
    await expect(generateReleaseNotices({
      studioRoot: studio,
      repoRoot: root,
      outDir: join(root, "release-notices"),
      cargoMetadata,
      cargoLockContent: "",
      frontendSupplemental: true,
      allowExternalOutDir: true,
    })).rejects.toThrow(/Required distributed frontend runtime identity material is absent/);
  });

  it.each([
    ["missing license bytes", (fixture) => rmSync(join(fixture.supplemental, "frontend/astro-7.3.3/LICENSE")), /is missing/],
    ["missing bundled UI license bytes", (fixture) => rmSync(join(fixture.supplemental, "frontend/pagefind-default-ui-1.5.2/svelte-4.2.20-LICENSE.md")), /is missing/],
    ["tampered license bytes", (fixture) => { const bytes = readFileSync(join(fixture.supplemental, "frontend/astro-7.3.3/LICENSE")); bytes[0] ^= 1; writeFileSync(join(fixture.supplemental, "frontend/astro-7.3.3/LICENSE"), bytes); }, /digest mismatch/],
    ["symlinked license bytes", (fixture) => { rmSync(join(fixture.supplemental, "frontend/astro-7.3.3/LICENSE")); symlinkSync("/etc/hosts", join(fixture.supplemental, "frontend/astro-7.3.3/LICENSE")); }, /symbolic link/],
    ["unknown lock package", (fixture) => { const manifest = manifestAt(fixture.manifestPath); manifest.frontendPackages.push({ ...manifest.frontendPackages[0], name: "unknown-runtime", lockPackagePath: "node_modules/unknown-runtime" }); writeManifest(fixture.manifestPath, manifest); }, /authenticated fixture lock/],
    ["wrong lock identity", (fixture) => { const lock = JSON.parse(readFileSync(join(fixture.fixture, "package-lock.json"), "utf8")); lock.packages["node_modules/astro"].version = "7.3.2"; writeFileSync(join(fixture.fixture, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`); const manifest = manifestAt(fixture.manifestPath); manifest.frontendFixture.lockSha256 = sha256(readFileSync(join(fixture.fixture, "package-lock.json"))); manifest.frontendFixture.lockSize = readFileSync(join(fixture.fixture, "package-lock.json")).length; writeManifest(fixture.manifestPath, manifest); }, /authenticated fixture lock/],
  ])("refuses %s", async (_label, mutate, expected) => {
    const fixture = setup();
    mutate(fixture);
    expect(() => collectFrontendSupplementalNotices(fixture.studio, fixture.root, fixture.supplemental, manifestAt(fixture.manifestPath))).toThrow(expected);
  });
});

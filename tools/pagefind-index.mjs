// Deterministic Pagefind search indexes for the prebuilt Starlight previews (neutral preview and gallery).
//
// Pagefind numbers pages in the order it reads them. Starlight indexes a build with the service API's
// addDirectory, and both that path and the CLI enumerate the site in directory-read order, which is a
// property of the filesystem: APFS, the local Linux builder and the hosted ext4 runner each produced a
// different pf_index/pf_meta for byte-identical HTML (CI9 run-43 diagnosis). Each preview build is
// therefore re-indexed here: every HTML page is added to a fresh index one at a time, in sorted path
// order, through the Node API of the exact Pagefind package the build installed, whose binary is pinned
// explicitly instead of being resolved from the ambient environment.
//
// The one platform-specific output is wasm.<language>.pagefind: every Pagefind release binary embeds its
// own gzip-compressed WASM, and the decoded payloads differ between the Darwin and Linux release binaries
// (Linux arm64 and x64 differ only in the gzip header time). PAGEFIND_WASM_PAYLOADS pins those decoded
// payloads so a cross-platform comparison can accept exactly these members and nothing else.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectSnapshot, readRegularSnapshot } from "./fs-snapshot.mjs";

export const PAGEFIND_VERSION = "1.5.2";
export const PAGEFIND_BINARIES = Object.freeze(["pagefind_extended", "pagefind"]);

// SHA-256 of the gunzipped wasm.<language>.pagefind written by each official Pagefind 1.5.2 release binary.
export const PAGEFIND_WASM_PAYLOADS = Object.freeze({
  "darwin-arm64": Object.freeze({
    "wasm.en.pagefind": "24b8831b0d6c54f112bab9aa283eac515a24423bc4968e6fc7958ea372253bf2",
    "wasm.unknown.pagefind": "7a8e6dfc7bda3eca8043ea7936e61e0ebdca0e5bc96df5a613761824423dfc2b",
  }),
  "linux-arm64": Object.freeze({
    "wasm.en.pagefind": "7e092add3897f1c134d7f093ebae88a3358e671addd5e1a3d39dcebdee83b12a",
    "wasm.unknown.pagefind": "77e118a7fd29152134c0285a97d3048a07055172dbadeb4fc6f27c6a0d3f851c",
  }),
  "linux-x64": Object.freeze({
    "wasm.en.pagefind": "7e092add3897f1c134d7f093ebae88a3358e671addd5e1a3d39dcebdee83b12a",
    "wasm.unknown.pagefind": "77e118a7fd29152134c0285a97d3048a07055172dbadeb4fc6f27c6a0d3f851c",
  }),
});

export const PAGEFIND_WASM_MEMBER = /(^|\/)pagefind\/wasm\.[a-z0-9_-]+\.pagefind$/u;

/**
 * Read back a completed Pagefind tree before it is promoted into the preview.
 * A successful child exit and an indexed-page count are not sufficient: the
 * Pagefind writer can otherwise leave zero-byte members behind while reporting
 * no API errors.  The manifest is sorted so it is also suitable for a stable
 * byte/inventory comparison by callers and tests.
 * @param {string} outputPath
 * @returns {{ path: string, bytes: number, sha256: string }[]}
 */
export function pagefindOutputManifest(outputPath) {
  /** @type {{ path: string, bytes: number, sha256: string }[]} */
  const files = [];
  const visit = (directory) => {
    const inspection = inspectSnapshot(directory, { bindPath: true, label: "Pagefind output member" });
    if (!inspection) throw new Error(`Pagefind output member is missing: ${directory}`);
    if (inspection.type === "directory") {
      for (const name of inspection.entries) visit(join(directory, name));
      return;
    }
    const bytes = inspection.bytes;
    if (bytes.length === 0) throw new Error(`Pagefind output contains a zero-byte member: ${directory}`);
    files.push({ path: relative(outputPath, directory).split(sep).join("/"), bytes: inspection.size, sha256: inspection.sha256 });
  };
  visit(outputPath);
  if (files.length === 0) throw new Error(`Pagefind output is empty: ${outputPath}`);
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/**
 * Materialize the complete in-memory output returned by Pagefind's locked getFiles API.
 * All members are validated before the fresh output directory is created, and each file is
 * created with an exclusive synchronous write so an incomplete async writer cannot be promoted.
 * @param {string} outputPath
 * @param {{ path: string, content: Uint8Array }[]} files
 * @returns {{ path: string, bytes: number, sha256: string }[]}
 */
export function materializePagefindFiles(outputPath, files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error("Pagefind getFiles returned no members");
  const members = files.map((file, index) => {
    if (!file || typeof file.path !== "string") throw new Error(`Pagefind getFiles member ${index} has no path`);
    const path = file.path;
    const segments = path.split("/");
    if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.includes(":")) {
      throw new Error(`Pagefind getFiles member has an unsafe path: ${path}`);
    }
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error(`Pagefind getFiles member has an unsafe path: ${path}`);
    }
    if (!(file.content instanceof Uint8Array)) throw new Error(`Pagefind getFiles member has non-byte content: ${path}`);
    const content = Buffer.from(file.content);
    if (content.length === 0) throw new Error(`Pagefind getFiles member is zero-byte: ${path}`);
    return { path, content };
  });
  const paths = new Set(members.map(({ path }) => path));
  if (paths.size !== members.length) throw new Error("Pagefind getFiles returned duplicate member paths");
  for (const path of paths) {
    const segments = path.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      const parent = segments.slice(0, length).join("/");
      if (paths.has(parent)) throw new Error(`Pagefind getFiles returned parent-colliding paths: ${parent} and ${path}`);
    }
  }
  const ordered = members.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  mkdirSync(outputPath, { mode: 0o755 });
  for (const { path, content } of ordered) {
    const destination = join(outputPath, ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
    writeFileSync(destination, content, { flag: "wx", mode: 0o644 });
  }
  return ordered.map(({ path, content }) => ({ path, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") }));
}

/** @param {string} path @returns {string} */
function packageVersion(path) {
  const snapshot = readRegularSnapshot(path, { label: "Pagefind package manifest", maxBytes: 1024 * 1024 });
  if (!snapshot) throw new Error(`Pagefind package manifest is missing: ${path}`);
  const version = JSON.parse(snapshot.bytes.toString("utf8")).version;
  if (typeof version !== "string") throw new Error(`Pagefind package manifest has no version: ${path}`);
  return version;
}

/**
 * Resolves the Pagefind CLI binary of an installed pagefind package without consulting
 * PAGEFIND_BINARY_PATH-style environment overrides.
 * @param {string} nodeModules
 */
export function pagefindBinary(nodeModules, { platform = process.platform, arch = process.arch } = {}) {
  const version = packageVersion(join(nodeModules, "pagefind/package.json"));
  if (version !== PAGEFIND_VERSION) throw new Error(`Pagefind ${PAGEFIND_VERSION} required, found ${version}`);
  const platformPackage = join(nodeModules, "@pagefind", `${platform === "win32" ? "windows" : platform}-${arch}`);
  const platformVersion = packageVersion(join(platformPackage, "package.json"));
  if (platformVersion !== PAGEFIND_VERSION) throw new Error(`Pagefind platform package ${PAGEFIND_VERSION} required, found ${platformVersion}`);
  for (const name of PAGEFIND_BINARIES) {
    const candidate = join(platformPackage, "bin", name);
    const binary = readRegularSnapshot(candidate, { missingOk: true, label: "Pagefind binary", maxBytes: 512 * 1024 * 1024 });
    if (binary) {
      if (!binary.executable) throw new Error(`Pagefind binary is not executable: ${candidate}`);
      return { path: candidate, sha256: binary.sha256, version, platform: `${platform}-${arch}` };
    }
  }
  throw new Error(`No Pagefind binary in ${platformPackage}`);
}

/** @param {string} siteDir @returns {string[]} Every HTML page below siteDir, as sorted portable relative paths. */
export function sitePages(siteDir) {
  /** @type {string[]} */
  const pages = [];
  /** @param {string} directory */
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Preview sites cannot contain symbolic links: ${path}`);
      if (entry.isDirectory()) {
        if (path !== join(siteDir, "pagefind")) visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".html")) {
        pages.push(relative(siteDir, path).split(sep).join("/"));
      }
    }
  };
  visit(siteDir);
  return pages.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

// Runs in a child Node process so the Pagefind service binary can be pinned through its documented
// PAGEFIND_EXTENDED_BINARY_PATH override without touching this process's environment.
const INDEXER = `
const [library, helper, siteDir, outputPath, pagesJson] = process.argv.slice(1);
const { readFileSync } = await import("node:fs");
const pagefind = await import(library);
const { materializePagefindFiles } = await import(helper);
const fail = (label, response) => {
  if (!response || !Array.isArray(response.errors)) throw new Error(label + ": malformed response");
  if (response.errors.length) throw new Error(label + ": " + response.errors.join("; "));
  return response;
};
let indexed = 0;
try {
  const { index } = fail("createIndex", await pagefind.createIndex());
  for (const sourcePath of JSON.parse(pagesJson)) {
    const content = readFileSync(siteDir + "/" + sourcePath, "utf8");
    fail(sourcePath, await index.addHTMLFile({ sourcePath, content }));
    indexed += 1;
  }
  const { files } = fail("getFiles", await index.getFiles());
  materializePagefindFiles(outputPath, files);
} finally {
  await pagefind.close();
}
process.stdout.write(JSON.stringify({ indexed }));
`;

/**
 * Replaces siteDir/pagefind with an index whose pages were added one at a time in sorted path order.
 * The indexer runs from an empty working directory with a minimal environment, so no ambient
 * pagefind configuration or binary override can change the index.
 * @param {string} siteDir
 * @param {{ nodeModules: string }} options
 */
export function reindexPagefindSite(siteDir, { nodeModules }) {
  const binary = pagefindBinary(nodeModules);
  const pages = sitePages(siteDir);
  if (pages.length === 0) throw new Error(`No HTML pages to index in ${siteDir}`);
  const output = join(siteDir, "pagefind");
  rmSync(output, { recursive: true, force: true });
  const stagingParent = mkdtempSync(join(siteDir, ".nebular-pagefind-stage-"));
  const staging = join(stagingParent, "pagefind");
  const cwd = mkdtempSync(join(tmpdir(), "nebular-pagefind-"));
  try {
    const library = pathToFileURL(join(nodeModules, "pagefind/lib/index.js")).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", INDEXER, library, import.meta.url, siteDir, staging, JSON.stringify(pages)], {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC", PAGEFIND_EXTENDED_BINARY_PATH: binary.path },
      timeout: 300_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Pagefind indexing failed for ${siteDir} (exit ${result.status}): ${result.stderr || result.stdout}`);
    const { indexed } = JSON.parse(result.stdout);
    if (indexed !== pages.length) throw new Error(`Pagefind indexed ${indexed} of ${pages.length} pages in ${siteDir}`);
    const manifest = pagefindOutputManifest(staging);
    renameSync(staging, output);
    return { binary, siteDir, output, pages, manifest };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stagingParent, { recursive: true, force: true });
  }
}

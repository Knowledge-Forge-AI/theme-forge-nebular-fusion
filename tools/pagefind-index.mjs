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
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readRegularSnapshot } from "./fs-snapshot.mjs";

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

function packageVersion(path) {
  return JSON.parse(readRegularSnapshot(path, { label: "Pagefind package manifest", maxBytes: 1024 * 1024 }).bytes.toString("utf8")).version;
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

/** Every HTML page below siteDir (outside its pagefind output), as sorted portable relative paths. */
export function sitePages(siteDir) {
  const pages = [];
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
const [library, siteDir, outputPath, pagesJson] = process.argv.slice(1);
const { readFileSync } = await import("node:fs");
const pagefind = await import(library);
const fail = (label, response) => { if (response.errors.length) throw new Error(label + ": " + response.errors.join("; ")); return response; };
try {
  const { index } = fail("createIndex", await pagefind.createIndex());
  let indexed = 0;
  for (const sourcePath of JSON.parse(pagesJson)) {
    const content = readFileSync(siteDir + "/" + sourcePath, "utf8");
    fail(sourcePath, await index.addHTMLFile({ sourcePath, content }));
    indexed += 1;
  }
  fail("writeFiles", await index.writeFiles({ outputPath }));
  process.stdout.write(JSON.stringify({ indexed }));
} finally {
  await pagefind.close();
}
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
  const cwd = mkdtempSync(join(tmpdir(), "nebular-pagefind-"));
  try {
    const library = pathToFileURL(join(nodeModules, "pagefind/lib/index.js")).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", INDEXER, library, siteDir, output, JSON.stringify(pages)], {
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
    return { binary, siteDir, output, pages };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

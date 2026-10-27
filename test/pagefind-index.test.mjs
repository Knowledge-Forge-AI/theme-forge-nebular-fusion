// @vitest-environment node
// The preview search index must not depend on the order a filesystem returns directory entries: the
// same pages written in a different order must produce byte-identical Pagefind output, and the only
// platform-specific members are the pinned WASM payloads of the Pagefind release binary.
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import { PAGEFIND_WASM_PAYLOADS, materializePagefindFiles, pagefindOutputManifest, reindexPagefindSite, sitePages } from "../tools/pagefind-index.mjs";

const NODE_MODULES = new URL("../loom-preview-source/node_modules", import.meta.url).pathname;
const installed = existsSync(join(NODE_MODULES, "pagefind/package.json"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const PAGES = ["index.html", "catalog/index.html", "catalog/hero-banner/index.html", "catalog/hero-centered/index.html", "catalog/hero-media-left/index.html",
  "catalog/hero-media-right/index.html", "catalog/hero-media-top/index.html", "catalog/no-match/index.html", "catalog/preview/index.html",
  "catalog/sidebar-less/index.html", "catalog/sidebar-nested/index.html", "404.html"];

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function site(order) {
  const root = mkdtempSync(join(tmpdir(), "nebular-pagefind-"));
  roots.push(root);
  for (const page of order) {
    mkdirSync(dirname(join(root, page)), { recursive: true });
    const body = page === "404.html" ? "<main>Not found</main>" : `<main data-pagefind-body><h1>${page}</h1><p>Theme Forge ${page.replaceAll("/", " ")} gallery words</p></main>`;
    writeFileSync(join(root, page), `<!doctype html><html lang="en"><head><title>${page}</title></head><body>${body}</body></html>`);
  }
  return root;
}

function fakePagefindNodeModules() {
  const root = mkdtempSync(join(tmpdir(), "nebular-pagefind-fake-"));
  roots.push(root);
  mkdirSync(join(root, "pagefind/lib"), { recursive: true });
  writeFileSync(join(root, "pagefind/package.json"), '{"name":"pagefind","version":"1.5.2","type":"module"}\n');
  const fakeIndex = [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "let pendingWrite;",
    'const css = Buffer.from("complete css\\n");',
    'const entry = Buffer.from("{}\\n");',
    "const completeFiles = () => ({ errors: [], files: [",
    '  { path: "pagefind-component-ui.css", content: Buffer.from(css) },',
    '  { path: "pagefind-entry.json", content: Buffer.from(entry) },',
    "] });",
    "export const createIndex = async () => ({ errors: [], index: {",
    "  addHTMLFile: async () => ({ errors: [] }),",
    "  getFiles: async () => completeFiles(),",
    "  writeFiles: async ({ outputPath }) => {",
    "    mkdirSync(outputPath, { recursive: true });",
    '    writeFileSync(join(outputPath, "pagefind-component-ui.css"), Buffer.alloc(0));',
    '    writeFileSync(join(outputPath, "pagefind-entry.json"), entry);',
    '    pendingWrite = setTimeout(() => writeFileSync(join(outputPath, "pagefind-component-ui.css"), css), 1000);',
    "    return { errors: [], outputPath };",
    "  },",
    "} });",
    "export const close = async () => {",
    "  if (pendingWrite) clearTimeout(pendingWrite);",
    "  pendingWrite = undefined;",
    "};",
  ].join("\n");
  writeFileSync(join(root, "pagefind/lib/index.js"), fakeIndex);
  for (const platform of ["darwin-arm64", "linux-arm64", "linux-x64", "windows-x64"]) {
    const packageRoot = join(root, "@pagefind", platform);
    mkdirSync(join(packageRoot, "bin"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), `{"name":"@pagefind/${platform}","version":"1.5.2"}\n`);
    const binary = join(packageRoot, "bin", "pagefind_extended");
    writeFileSync(binary, "locked fake Pagefind executable sentinel\n");
    chmodSync(binary, 0o755);
  }
  return root;
}

function inventory(root) {
  const files = {};
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else files[relative(root, path)] = sha256(readFileSync(path));
    }
  };
  visit(root);
  return files;
}

describe("Pagefind output completeness contract", () => {
  it("materializes complete in-memory members before promotion", () => {
    const root = mkdtempSync(join(tmpdir(), "nebular-pagefind-materialize-"));
    roots.push(root);
    const output = join(root, "pagefind");
    materializePagefindFiles(output, [
      { path: "index/pagefind-entry.json", content: Buffer.from("{}\n") },
      { path: "pagefind-component-ui.css", content: Buffer.from("body {}\n") },
    ]);
    expect(pagefindOutputManifest(output)).toEqual([
      { path: "index/pagefind-entry.json", bytes: 3, sha256: sha256(Buffer.from("{}\n")) },
      { path: "pagefind-component-ui.css", bytes: 8, sha256: sha256(Buffer.from("body {}\n")) },
    ]);
  });

  it("rejects empty, unsafe, duplicate, and parent-colliding members before output creation", () => {
    const cases = [
      [{ path: "empty.bin", content: Buffer.alloc(0) }],
      [{ path: "../escape.bin", content: Buffer.from("x") }],
      [{ path: "/absolute.bin", content: Buffer.from("x") }],
      [{ path: "back\\slash.bin", content: Buffer.from("x") }],
      [{ path: "same.bin", content: Buffer.from("x") }, { path: "same.bin", content: Buffer.from("y") }],
      [{ path: "member", content: Buffer.from("x") }, { path: "member/child.bin", content: Buffer.from("y") }],
    ];
    for (const files of cases) {
      const root = mkdtempSync(join(tmpdir(), "nebular-pagefind-materialize-reject-"));
      roots.push(root);
      const output = join(root, "pagefind");
      expect(() => materializePagefindFiles(output, files)).toThrow();
      expect(existsSync(output)).toBe(false);
    }
  });

  it("rejects a zero-byte member before output promotion", () => {
    const root = mkdtempSync(join(tmpdir(), "nebular-pagefind-output-contract-"));
    roots.push(root);
    mkdirSync(join(root, "index"), { recursive: true });
    writeFileSync(join(root, "index", "pagefind-entry.json"), "{}\n");
    writeFileSync(join(root, "pagefind-component-ui.js"), "");
    expect(() => pagefindOutputManifest(root)).toThrow(/zero-byte member/);
  });

  it("returns a stable sorted manifest for complete members", () => {
    const root = mkdtempSync(join(tmpdir(), "nebular-pagefind-output-contract-"));
    roots.push(root);
    mkdirSync(join(root, "index"), { recursive: true });
    writeFileSync(join(root, "index", "pagefind-entry.json"), "{}\n");
    writeFileSync(join(root, "pagefind-component-ui.js"), "console.log(1);\n");
    expect(pagefindOutputManifest(root).map(({ path }) => path)).toEqual(["index/pagefind-entry.json", "pagefind-component-ui.js"]);
  });

  it("rejects symbolic links before reading a member body", () => {
    const root = mkdtempSync(join(tmpdir(), "nebular-pagefind-output-contract-"));
    roots.push(root);
    writeFileSync(join(root, "target.js"), "const target = true;\n");
    symlinkSync("target.js", join(root, "member.js"));
    expect(() => pagefindOutputManifest(root)).toThrow(/symbolic link/);
  });

  it("rejects non-regular members before reading a member body", () => {
    const root = mkdtempSync(join(tmpdir(), "nebular-pagefind-output-contract-"));
    roots.push(root);
    const fifo = join(root, "member.fifo");
    execFileSync("mkfifo", [fifo]);
    expect(() => pagefindOutputManifest(root)).toThrow(/unsupported type/);
  });

  it("materializes getFiles before the child closes a pending writer", () => {
    const root = site(["index.html"]);
    const nodeModules = fakePagefindNodeModules();
    const result = reindexPagefindSite(root, { nodeModules });
    expect(result.pages).toEqual(["index.html"]);
    expect(readFileSync(join(root, "pagefind", "pagefind-component-ui.css"), "utf8")).toBe("complete css\n");
    expect(pagefindOutputManifest(join(root, "pagefind")).map(({ path, bytes }) => ({ path, bytes }))).toEqual([
      { path: "pagefind-component-ui.css", bytes: 13 },
      { path: "pagefind-entry.json", bytes: 3 },
    ]);
    expect(readdirSync(root).some((name) => name.startsWith(".nebular-pagefind-stage-"))).toBe(false);
  });
});

describe.skipIf(!installed)("deterministic Pagefind preview index", () => {
  it("lists pages in sorted order regardless of creation order", () => {
    expect(sitePages(site([...PAGES].reverse()))).toEqual([...PAGES].sort());
  });

  it("writes byte-identical indexes for the same pages created in different orders", () => {
    const forward = site(PAGES);
    const reverse = site([...PAGES].reverse());
    const shuffled = site([...PAGES].sort((a, b) => sha256(a).localeCompare(sha256(b))));
    for (const root of [forward, reverse, shuffled]) expect(reindexPagefindSite(root, { nodeModules: NODE_MODULES }).pages).toEqual([...PAGES].sort());
    const expected = inventory(join(forward, "pagefind"));
    expect(Object.keys(expected).some((path) => path.startsWith("index/"))).toBe(true);
    expect(inventory(join(reverse, "pagefind"))).toEqual(expected);
    expect(inventory(join(shuffled, "pagefind"))).toEqual(expected);
    // Re-indexing replaces the previous output rather than accumulating it.
    reindexPagefindSite(forward, { nodeModules: NODE_MODULES });
    expect(inventory(join(forward, "pagefind"))).toEqual(expected);
  });

  it("decodes the platform WASM to the pinned Pagefind release payload", () => {
    const platform = `${process.platform}-${process.arch}`;
    const pins = PAGEFIND_WASM_PAYLOADS[platform];
    if (!pins) return;
    const root = site(PAGES);
    reindexPagefindSite(root, { nodeModules: NODE_MODULES });
    for (const [name, digest] of Object.entries(pins)) {
      expect(sha256(gunzipSync(readFileSync(join(root, "pagefind", name)))), `${platform} ${name}`).toBe(digest);
    }
  });

  it("refuses links inside a preview site", () => {
    const root = site(PAGES);
    writeFileSync(join(root, "target.html"), "<html></html>");
    rmSync(join(root, "catalog/preview/index.html"));
    symlinkSync(join(root, "target.html"), join(root, "catalog/preview/index.html"));
    expect(() => sitePages(root)).toThrow(/cannot contain symbolic links/);
    expect(() => reindexPagefindSite(root, { nodeModules: NODE_MODULES })).toThrow(/cannot contain symbolic links/);
  });
});

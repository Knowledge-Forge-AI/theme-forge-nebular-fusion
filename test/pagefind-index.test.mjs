// @vitest-environment node
// The preview search index must not depend on the order a filesystem returns directory entries: the
// same pages written in a different order must produce byte-identical Pagefind output, and the only
// platform-specific members are the pinned WASM payloads of the Pagefind release binary.
import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import { PAGEFIND_WASM_PAYLOADS, reindexPagefindSite, sitePages } from "../tools/pagefind-index.mjs";

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

import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

// Literal known-prefix policy, including binary and generated resources. This
// detects retained build paths, not every byte sequence resembling a pathname.
// Store/system references remain valid. No generic file-type exclusions apply.
export async function scanShippedPaths(root, prefixes, { preserveSpellings = false } = {}) {
  const base = await realpath(root);
  // Source authorities bind original locator bytes as well as resolved roots.
  // Keep the default policy unchanged for callers without source authority.
  const needles = [...new Set(prefixes.filter(Boolean).flatMap(path =>
    preserveSpellings ? [path, resolve(path)] : [resolve(path)]))].map(path => Buffer.from(path));
  if (!needles.length || needles.some(bytes => bytes.length < 2)) throw new Error("Explicit build-path prefixes required");
  const overlap = Math.max(...needles.map(bytes => bytes.length)) - 1;
  let files = 0;
  async function visit(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = await realpath(path);
      if (target !== base && !target.startsWith(base + sep)) throw new Error("Shipped symlink escapes artifact");
      return; // Its contained regular target is visited through the closed tree.
    }
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await visit(join(path, name));
    } else if (info.isFile()) {
      let tail = Buffer.alloc(0);
      for await (const chunk of createReadStream(path)) {
        const bytes = Buffer.concat([tail, chunk]);
        if (needles.some(needle => bytes.includes(needle))) {
          throw new Error(`Shipped member retains a known build-path prefix: ${relative(base, path)}`);
        }
        tail = bytes.subarray(Math.max(0, bytes.length - overlap));
      }
      files++;
    } else throw new Error("Shipped special member is unsupported");
  }
  await visit(base);
  return { policy: "known-build-prefix-literal-v1", files };
}

# Theme Forge Nebular Fusion

Theme Forge Nebular Fusion is a local, evidence-bound desktop workbench for reviewing, inspecting, and managing Theme Forge brand systems and artifacts.

- Package version: `0.1.0`
- Public repository: `Knowledge-Forge-AI/theme-forge-nebular-fusion`
- Target platform: macOS (Apple Silicon `aarch64-apple-darwin`)
- Architecture: Tauri v2 desktop host with strict CSP and isolated sidecar execution
- Paired core: Theme Forge Stellar Burst `0.4.0`, authenticated by exact package and source identities
- Minimum macOS version: 13.0 on Apple Silicon

## Application distribution

The [v0.1.0 release](https://github.com/Knowledge-Forge-AI/theme-forge-nebular-fusion/releases/tag/v0.1.0)
provides the macOS-arm64 application archive and its checksums, notices and SBOMs
once distribution qualification is complete. Follow that release's signature
and notarization requirements, verify the downloaded archive against its
checksum file, then extract the app and copy it to Applications using Finder.
The release record binds the exact Node runtime, Stellar package and sidecar
included in the app.

The optional raster capability is bundled from the authenticated companion
archive and lock under `authenticated-inputs/`. The companion remains
`@knowledge-forge-ai/tfsb-raster-resvg@0.0.0-tfsb47f`; it is not a separate
npm registry product. Its AGPL/commercial, MPL and third-party notices travel
with the distribution. No embedded model or provider is included.

## Development

Prerequisites:
- Node.js >= 22.23.2
- Rust 1.98.0 (edition 2024)

```sh
# Install frontend dependencies
npm ci

# Verify and extract the exact locked Node type inputs used by retained
# Studio test sources before typechecking. The archive contains only
# node_modules/@types/node and node_modules/undici-types.
node --input-type=module <<'NODE'
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractReleaseArchive } from "./tools/ci/artifact-manifest.mjs";
const binding = JSON.parse(readFileSync("authenticated-inputs/tooling/binding.json", "utf8"));
const types = binding.buildTypes;
const expected = [["@types/node", "22.20.1", "node_modules/@types/node"], ["undici-types", "6.21.0", "node_modules/undici-types"]];
if (!types || typeof types.filename !== "string" || !/^[a-f0-9]{64}$/.test(types.sha256) || !Array.isArray(types.packages) || expected.some(([name, version, prefix]) => !types.packages.some((pkg) => pkg.name === name && pkg.version === version && pkg.prefix === prefix))) throw new Error("invalid declared build-types binding");
const archive = "authenticated-inputs/tooling-tarball/" + types.filename;
const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
if (digest !== types.sha256) throw new Error("build-types archive digest mismatch");
const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
if (expected.some(([, , prefix]) => !entries.includes(prefix + "/package.json"))) throw new Error("build-types archive contents mismatch");
const scratch = mkdtempSync(join(tmpdir(), "nebular-build-types-"));
try {
  await extractReleaseArchive({ archivePath: archive, destination: scratch, expectedSha256: types.sha256 });
  for (const [, , path] of expected) cpSync(join(scratch, path), path, { recursive: true });
} finally { rmSync(scratch, { recursive: true, force: true }); }
NODE

# Run frontend typecheck and tests
npm run typecheck
npm test

# Build frontend
npm run build

# Run Rust tests
cd src-tauri
cargo test --locked --all-targets --all-features
```

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE) for details.

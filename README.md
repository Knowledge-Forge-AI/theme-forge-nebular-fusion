# Theme Forge Nebular Fusion

Theme Forge Nebular Fusion is a local, evidence-bound desktop workbench for reviewing, inspecting, and managing Theme Forge brand systems and artifacts.

- Package version: `0.2.0`
- Public repository: `Knowledge-Forge-AI/theme-forge-nebular-fusion`
- Target platform: macOS (Apple Silicon `aarch64-apple-darwin`)
- Architecture: Tauri v2 desktop host with strict CSP and isolated sidecar execution
- Paired core: Theme Forge Stellar Burst `0.4.0`, authenticated by exact package and source identities
- Minimum macOS version: 13.0 on Apple Silicon

## Application distribution

This is a local 0.2.0 candidate, not a published release. The macOS-arm64
application is an ad-hoc-signed, unnotarized developer distribution. Verify
its supplied checksum before opening it. No hosted package provenance or
Developer ID identity is claimed. The input manifests bind the exact Node,
Stellar Burst 0.4.0 and Stellar Loom 0.1.0 packages included in the app.

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
# Install each owning lock without dependency lifecycle scripts
npm ci --ignore-scripts
npm ci --prefix loom-preview-source --ignore-scripts
node tools/loom-prepare.mjs

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

# Authenticate the pinned Node release, then prepare the exact paired core.
# Choose fresh paths outside this source copy for the downloaded archive/receipt.
node tools/ci/verify-node-authenticity.mjs --download-dir /path/to/node-download --output-node /path/to/node-authenticated --output /path/to/node-receipt.json
node tools/sidecar-prepare.mjs --node /path/to/node-authenticated --root-tarball authenticated-inputs/core-tarball/knowledge-forge-ai-theme-forge-stellar-burst-0.4.0.tgz
node tools/sidecar-verify.mjs

# Build the normal application with its ordinary configuration.
npm run tauri:build

# Run host tests after the frontend and paired resources exist.
cd src-tauri
cargo test --locked --all-targets --all-features -- --test-threads=1
```

## Public CI input handoff

Local builds use the exact package bindings without requiring an unpublished
Loom commit. Before the separately authorized public campaign, supply
`authenticated-inputs/publication-manifest.json` with schema
`tfsb.public-paired-inputs-v1` and `stellar` / `loom` records containing the
actual full `commit`, `contentTree` and `packageSha256`. The source-policy
job rejects missing or inconsistent records. No future SHA is invented here.

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE) for details.

# Theme Forge Nebular Fusion

Theme Forge Nebular Fusion is a local, evidence-bound desktop workbench for reviewing, inspecting, and managing Theme Forge brand systems and artifacts. This candidate tree represents unreleased 0.3 development with metadata 0.3.0.

It provides three persistent work areas: **Brand/System**, **Vector/Graphics**, and **Starlight Theme**.
The Scene workbench produces SVG. Distributed PNG and remote resource ingestion are not supported.

- Package version: `0.3.0` (unreleased 0.3 release candidate)
- Public repository: `Knowledge-Forge-AI/theme-forge-nebular-fusion`
- Target platform: macOS (Apple Silicon `aarch64-apple-darwin`)
- Architecture: Tauri v2 desktop host with strict CSP and isolated sidecar execution
- Paired core: Theme Forge Stellar Burst `0.5.0`, authenticated by exact package and source identities
- Paired theme builder: Theme Forge Stellar Loom `0.2.0`, authenticated by exact package and source identities
- Minimum macOS version: 13.0 on Apple Silicon

## Application distribution

The macOS-arm64 application is an ad-hoc-signed, unnotarized developer distribution. Verify its supplied checksum before opening it. Homebrew cask distribution is WITHHELD pending Developer ID signing and notarization. The source and developer app distribution carries no published claim; this application is not published on npm. No hosted npm provenance or Developer ID identity is claimed. The input manifests bind the exact Node (v22.23.2), Stellar Burst 0.5.0, and Stellar Loom 0.2.0 release-candidate packages included in the app.

The optional raster capability is bundled from the authenticated companion archive and lock under `authenticated-inputs/`. The companion remains `@knowledge-forge-ai/tfsb-raster-resvg@0.0.0-tfsb47f`; it is not a separate npm registry product. Its AGPL/commercial, MPL and third-party notices travel with the distribution. No embedded model or provider is included.

## Development

Prerequisites:
- Node.js >= 22.23.2
- Nix for the product-local locked Rust 1.98.0 environment (edition 2024)

```sh
# Enter the locked toolchain; its Rust binaries precede host rustup proxies.
nix develop .
rustc --version # 1.98.0
cargo --version # 1.98.0

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
node tools/sidecar-prepare.mjs --node /path/to/node-authenticated --root-tarball authenticated-inputs/core-tarball/knowledge-forge-ai-theme-forge-stellar-burst-0.5.0.tgz
node tools/sidecar-verify.mjs

# Build the normal application with its ordinary configuration.
npm run tauri:build

# Run host tests after the frontend and paired resources exist.
cd src-tauri
cargo test --locked --all-targets --all-features -- --test-threads=1
```

## Bundled license material

The app build generates deterministic third-party notices for its native and
frontend dependencies and includes them under the bundle's release-notices
resources. Missing required material fails the build. Supplemental upstream
notices, source revisions and file digests are recorded under legal/supplemental.

## Public CI input handoff

The completed public release uses the exact published package bindings.
The composition supplies `authenticated-inputs/publication-manifest.json` with schema
`tfsb.public-paired-inputs-v1` and `stellar` / `loom` records containing the
recorded full `commit`, `contentTree` and `packageSha256`. The source-policy
job rejects missing or inconsistent records. No future SHA is invented here.

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE) for details.

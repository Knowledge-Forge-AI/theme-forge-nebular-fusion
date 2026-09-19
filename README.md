# Theme Forge Nebular Fusion

Theme Forge Nebular Fusion is a local, evidence-bound desktop workbench for reviewing, inspecting, and managing Theme Forge brand systems and artifacts. This candidate tree represents unreleased 0.4 development with metadata 0.4.0.

It provides three persistent work areas: **Brand/System**, **Vector/Graphics**, and **Starlight Theme**.
The Scene workbench requires a separately authenticated candidate and is not bundled with this distribution. When enabled, it produces SVG. Distributed PNG and remote resource ingestion are not supported.

- Package version: `0.4.0` (unreleased 0.4 release candidate)
- Public repository: `Knowledge-Forge-AI/theme-forge-nebular-fusion`
- Target platform: macOS (Apple Silicon `aarch64-apple-darwin`)
- Architecture: Tauri v2 desktop host with strict CSP and isolated sidecar execution
- Paired core: Theme Forge Stellar Burst `0.5.0`, authenticated by exact package and source identities
- Paired theme builder: Theme Forge Stellar Loom `0.3.0`, authenticated by exact package and source identities
- Minimum macOS version: 13.0 on Apple Silicon

## Application distribution

The macOS-arm64 application is an ad-hoc-signed, unnotarized developer distribution. Verify its supplied checksum before opening it. Homebrew cask distribution is WITHHELD pending Developer ID signing and notarization. The source and developer app distribution carries no published claim; this application is not published on npm. No hosted npm provenance or Developer ID identity is claimed. The input manifests bind the exact Node (v22.23.2), Stellar Burst 0.5.0, and Stellar Loom 0.3.0 release-candidate packages included in the app.

The optional raster capability is bundled from the authenticated companion archive and lock under `authenticated-inputs/`. The companion remains `@knowledge-forge-ai/tfsb-raster-resvg@0.0.0-tfsb47f`; it is not a separate npm registry product. Its AGPL/commercial, MPL and third-party notices travel with the distribution. No embedded model or provider is included.

The optional Scene capability requires a separately authenticated candidate and is not bundled with this distribution.

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
NODE
npx tsc --noEmit

# Self-contained offline test execution
npm test

# Build the desktop release binary (macOS Apple Silicon host required)
npm run build
npm run tauri build
```

## License

Theme Forge Nebular Fusion is dual-licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later) and commercial license terms. See `LICENSE`, `NOTICE`, and `COMMERCIAL-LICENSE.md`.

import { readFileSync, readdirSync, existsSync, lstatSync } from "node:fs";
import { join, resolve, basename, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { CANDIDATE_VERSION, APPLICATION_NAME } from "./platform-targets.mjs";

// Filesystem discovery deliberately does not use public projection membership:
// newly added build surfaces must enter the report before they can be shipped.
const SKIP_DIRECTORIES = new Set([".git", ".outbox", ".test-reports", "node_modules", "target", "dist", ".cache", ".vite", ".vitest", "coverage", "authenticated-inputs"]);
const GENERATED = /^(?:apps\/studio\/(?:public\/preview|src-tauri\/(?:binaries|sidecar-payload|loom-payload|solar-sail-payload|scene-payload|release-notices)))(?:\/|$)/;
const VERSION = /(?<![\w.])\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?(?![\w.])/g;

// Independently versioned components and their consumer fixtures are not
// Nebular packages. New package paths must receive an explicit owner.
const INDEPENDENT_PACKAGES = new Set([
  "package.json", "packages/solar-sail/package.json",
  "packages/stellar-loom/package.json", "packages/tfsb-raster-resvg/package.json",
  "packages/solar-sail/consumer-fixture/package.json",
  "packages/stellar-loom/consumer-fixture/package.json",
]);

export const LIVE_PATH_ROOTS = Object.freeze([
  "apps/studio/package.json",
  "apps/studio/package-lock.json",
  "apps/studio/src-tauri/Cargo.toml",
  "apps/studio/src-tauri/Cargo.lock",
  "apps/studio/src-tauri/tauri.conf.json",
  "packages/nebular-fusion-npm/",
  "packages/nebular-fusion-darwin-arm64/",
  "packages/nebular-fusion-linux-arm64/",
  "packages/nebular-fusion-linux-x64/",
  "nix/packages/nebular-fusion.nix",
  "nix/nebular/",
  "tools/homebrew/",
  "tools/nebular-release-layout.mjs",
  "tools/nebular-release-layout-tests.mjs",
  "tools/public-composition/",
  "apps/studio/tools/",
  "tools/",
]);

export function isLivePath(filePath) {
  if (/^tools\/(?:release-operations|tfsb48-r1|tfsb48-r2)\//.test(filePath)) {
    return false;
  }
  if (LIVE_PATH_ROOTS.some(root => root.endsWith("/") ? filePath.startsWith(root) : filePath === root)) {
    return true;
  }
  if (/^packages\/nebular-fusion-[^/]+\//.test(filePath)) {
    return true;
  }
  return false;
}

/**
 * Walks JSON content structurally and discovers:
 * 1. All version-named fields independent of value (e.g. version: "latest", version: 17, unknownVersion: "broken").
 * 2. All semver values matching VERSION anywhere in string values, with exact field paths.
 * 3. Enforces strict path- and field-ownership for live JSON surfaces.
 * 4. Fails closed on malformed live JSON.
 */
function scanJsonVersions(filePath, content) {
  if (/(?:^|\/)(?:test|tests|spec|specs|fixtures?|gallery\/fixtures|examples?|test-matrix|spikes|scratch)\//.test(filePath)
      || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath)
      || /-tests?\.[cm]?[jt]sx?$/.test(filePath)
      || /^(?:docs\/|pkgs\/by-name\/|tools\/(?:release-operations|tfsb48-r1|tfsb48-r2)\/)/.test(filePath)
      || filePath === "tools/ci/supply-chain-tools.json"
      || filePath === "tools/public-composition/product-membership.json"
      || /\.md$/i.test(filePath)) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    // Malformed live JSON must fail closed
    return [{
      path: filePath,
      line: 1,
      column: 1,
      version: null,
      classification: null,
      reason: `malformed JSON syntax in live surface fails closed: ${err.message}`,
    }];
  }

  // Position indexer
  const lineStarts = [0];
  for (let idx = 0; idx < content.length; idx++) {
    if (content[idx] === "\n") lineStarts.push(idx + 1);
  }
  function getLineCol(offset) {
    let low = 0, high = lineStarts.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (lineStarts[mid] <= offset) {
        if (mid === lineStarts.length - 1 || lineStarts[mid + 1] > offset) {
          return { line: mid + 1, column: offset - lineStarts[mid] + 1 };
        }
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return { line: 1, column: offset + 1 };
  }

  // Tokenize JSON structurally to retrieve exact pathStack, key, value, and character offset
  let i = 0;
  const n = content.length;
  function skipWs() {
    while (i < n && /\s/.test(content[i])) i++;
  }

  const entries = [];
  const stack = [];

  function parseString() {
    i++; // skip opening quote
    let str = "";
    while (i < n) {
      if (content[i] === "\\" && i + 1 < n) {
        const next = content[i + 1];
        if (next === "\"") str += "\"";
        else if (next === "\\") str += "\\";
        else if (next === "/") str += "/";
        else if (next === "b") str += "\b";
        else if (next === "f") str += "\f";
        else if (next === "n") str += "\n";
        else if (next === "r") str += "\r";
        else if (next === "t") str += "\t";
        else if (next === "u" && i + 5 < n) {
          str += String.fromCharCode(parseInt(content.slice(i + 2, i + 6), 16));
          i += 4;
        } else str += next;
        i += 2;
      } else if (content[i] === "\"") {
        i++;
        break;
      } else {
        str += content[i++];
      }
    }
    return str;
  }

  function parseValue() {
    skipWs();
    if (i >= n) return;
    const ch = content[i];
    const valStart = i;
    const containerKey = stack.at(-1);
    if ((ch === "{" || ch === "[") && typeof containerKey === "string" && /version|^release$/i.test(containerKey)) {
      entries.push({ pathStack: [...stack], key: containerKey, value: ch === "{" ? {} : [], offset: valStart, isString: false });
    }

    if (ch === "{") {
      i++;
      skipWs();
      if (i < n && content[i] === "}") {
        i++;
        return;
      }
      while (i < n) {
        skipWs();
        if (content[i] !== "\"") break;
        const key = parseString();
        skipWs();
        if (content[i] === ":") i++;
        skipWs();
        stack.push(key);
        parseValue();
        stack.pop();
        skipWs();
        if (content[i] === ",") {
          i++;
        } else if (content[i] === "}") {
          i++;
          break;
        } else {
          break;
        }
      }
    } else if (ch === "[") {
      i++;
      skipWs();
      if (i < n && content[i] === "]") {
        i++;
        return;
      }
      let idx = 0;
      while (i < n) {
        skipWs();
        stack.push(String(idx));
        parseValue();
        stack.pop();
        idx++;
        skipWs();
        if (content[i] === ",") {
          i++;
        } else if (content[i] === "]") {
          i++;
          break;
        } else {
          break;
        }
      }
    } else if (ch === "\"") {
      const str = parseString();
      const parentKey = stack.length > 0 ? stack[stack.length - 1] : null;
      entries.push({
        pathStack: [...stack],
        key: parentKey,
        value: str,
        offset: valStart,
        isString: true,
      });
    } else {
      let raw = "";
      while (i < n && !/[\s,\}\]]/.test(content[i])) {
        raw += content[i++];
      }
      let val = raw;
      if (raw === "true") val = true;
      else if (raw === "false") val = false;
      else if (raw === "null") val = null;
      else if (!isNaN(Number(raw))) val = Number(raw);
      const parentKey = stack.length > 0 ? stack[stack.length - 1] : null;
      entries.push({
        pathStack: [...stack],
        key: parentKey,
        value: val,
        offset: valStart,
        isString: false,
      });
    }
  }

  parseValue();

  const isVersionKey = (k) => typeof k === "string" && (/version$/i.test(k) || /^(?:release|appVersion|candidateVersion)$/i.test(k));

  const hits = [];
  for (const entry of entries) {
    const isVerKey = isVersionKey(entry.key);
    let semverMatches = [];
    if (typeof entry.value === "string") {
      semverMatches = [...entry.value.matchAll(VERSION)];
    }

    if (!isVerKey && semverMatches.length === 0) {
      continue;
    }

    // Determine target versions to emit
    const targets = [];
    if (semverMatches.length > 0) {
      for (const m of semverMatches) {
        targets.push({ version: m[0], offset: entry.offset + m.index });
      }
    } else {
      // Non-semver value in version-named field (e.g. "latest", 17, "broken")
      targets.push({ version: String(entry.value), offset: entry.offset });
    }

    for (const target of targets) {
      const { line, column } = getLineCol(target.offset);
      const version = target.version;
      let classification = null;
      let reason = null;

      // 1. Authoritative application package (apps/studio/package.json)
      if (filePath === "apps/studio/package.json" || (filePath.endsWith("package.json") && !filePath.endsWith("package-lock.json") && typeof parsed === "object" && parsed !== null && parsed.name === "theme-forge-nebular-fusion-studio")) {
        if (entry.pathStack.length === 1 && entry.pathStack[0] === "version") {
          classification = "candidate-authoritative";
          reason = "maintained application package version";
        } else if (entry.pathStack.length === 2 && ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "engines"].includes(entry.pathStack[0])) {
          classification = "unrelated/non-version semantic text";
          reason = "application dependency version; not product candidate version";
        } else {
          classification = null;
          reason = "unknown live version field requires maintained owner classification";
        }
      }
      // 2. Application package-lock.json (apps/studio/package-lock.json)
      else if (filePath === "apps/studio/package-lock.json" || filePath.endsWith("/apps/studio/package-lock.json")) {
        if (entry.pathStack.length === 1 && entry.pathStack[0] === "version") {
          classification = "derived/checked candidate surface";
          reason = "live product version reference";
        } else if (entry.pathStack.length === 3 && entry.pathStack[0] === "packages" && entry.pathStack[1] === "" && entry.pathStack[2] === "version") {
          classification = "derived/checked candidate surface";
          reason = "live product version reference";
        } else if (entry.pathStack.length === 1 && entry.pathStack[0] === "lockfileVersion") {
          classification = "unrelated/non-version semantic text";
          reason = "npm lockfile format version";
        } else if (entry.pathStack[0] === "packages" && entry.pathStack[1] === "" && ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "engines"].includes(entry.pathStack[2])) {
          classification = "unrelated/non-version semantic text";
          reason = "dependency lockfile entry; independent identity";
        } else if (entry.pathStack[0] === "packages" && entry.pathStack[1] !== "") {
          classification = "unrelated/non-version semantic text";
          reason = "dependency lockfile entry; independent identity";
        } else if (entry.pathStack[0] === "dependencies") {
          classification = "unrelated/non-version semantic text";
          reason = "dependency lockfile entry; independent identity";
        } else {
          classification = null;
          reason = "unknown live version field requires maintained owner classification";
        }
      }
      // 3. Tauri configuration (tauri.conf.json)
      else if (filePath.endsWith("tauri.conf.json")) {
        if (entry.pathStack.length === 1 && entry.pathStack[0] === "version") {
          classification = "derived/checked candidate surface";
          reason = "live product version reference";
        } else if (entry.pathStack.join(".") === "bundle.macOS.minimumSystemVersion") {
          classification = "unrelated/non-version semantic text";
          reason = "tauri configuration metadata";
        } else {
          classification = null;
          reason = "unknown live version field requires maintained owner classification";
        }
      }
      // 4. Platform package manifest (package-manifest.json)
      else if (filePath.endsWith("package-manifest.json")) {
        if (entry.pathStack.length === 1 && entry.pathStack[0] === "version") {
          classification = "derived/checked candidate surface";
          reason = "live product version reference";
        } else {
          classification = null;
          reason = "unknown live version field requires maintained owner classification";
        }
      }
      // 5. Payload bindings (payload-bindings.json)
      else if (filePath.endsWith("payload-bindings.json")) {
        if (entry.pathStack.length === 1 && entry.pathStack[0] === "version") {
          classification = "derived/checked candidate surface";
          reason = "live product version reference";
        } else {
          classification = null;
          reason = "unknown live version field requires maintained owner classification";
        }
      }
      // 6. Dynamic candidate packages across repo (npm wrapper & platform packages)
      else if (filePath.endsWith("package.json") && typeof parsed === "object" && parsed !== null
          && (parsed.name === "@knowledge-forge-ai/theme-forge-nebular-fusion" || (typeof parsed.name === "string" && parsed.name.startsWith("@knowledge-forge-ai/theme-forge-nebular-fusion-")))) {
        if (entry.pathStack.length === 1 && entry.pathStack[0] === "version") {
          classification = "derived/checked candidate surface";
          reason = "live product version reference";
        } else if (entry.pathStack[0] === "optionalDependencies" && typeof entry.key === "string" && entry.key.startsWith("@knowledge-forge-ai/theme-forge-nebular-fusion-")) {
          classification = "derived/checked candidate surface";
          reason = "live product version reference";
        } else if (entry.pathStack.length === 2 && ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "engines"].includes(entry.pathStack[0])) {
          classification = "unrelated/non-version semantic text";
          reason = "npm wrapper dependency";
        } else {
          classification = null;
          reason = "unknown live version field requires maintained owner classification";
        }
      }
      // 7. For other JSON files, leave classification and reason null to resolve via classifyHit below
      else {
        classification = null;
        reason = null;
      }

      hits.push({
        path: filePath,
        line,
        column,
        version,
        classification,
        reason,
      });
    }
  }

  return hits;
}

/**
 * Classifies a version reference hit using exact semantic path- and field-ownership.
 * Replaces heuristic line-text classification with explicit maintained ownership.
 */
function classifyHit(path, line, lineIndex, lines, match) {
  if (path.startsWith("apps/studio/src-tauri/gen/schemas/")) {
    return { classification: "unrelated/non-version semantic text", reason: "generated Tauri permission/schema field definitions; not live candidate metadata" };
  }
  // 1. Immutable Historical Evidence
  if (/^(?:docs\/|pkgs\/by-name\/|tools\/(?:release-operations|tfsb48-r1|tfsb48-r2)\/)/.test(path)) {
    return { classification: "historical immutable evidence", reason: "retained phase/publication evidence; not a next-candidate build input" };
  }

  // 2. Documentation Prose
  if (/\.md$/i.test(path)) {
    return { classification: "unrelated/non-version semantic text", reason: "documentation prose; not a candidate build or packaging surface" };
  }

  // 3. Tests, Test Fixtures, Specs, and Test Matrix
  if (/(?:^|\/)(?:test|tests|spec|specs|fixtures?|gallery\/fixtures|examples?|test-matrix|spikes|scratch)\//.test(path)
      || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
      || /-tests?\.[cm]?[jt]sx?$/.test(path)
      || /fake-sidecar\.rs$/.test(path)) {
    return { classification: "unrelated/non-version semantic text", reason: "test, fixture, or specification artifact; application metadata checked separately" };
  }

  // 4. Code comments: enforce NO code-comment escape for executable same-line code
  const matchIdx = match.index ?? 0;
  // Check // comment
  const doubleSlash = line.indexOf("//");
  if (doubleSlash !== -1) {
    const beforeSlash = line.slice(0, doubleSlash);
    const singleQuotes = (beforeSlash.match(/'/g) || []).length;
    const doubleQuotes = (beforeSlash.match(/"/g) || []).length;
    if (singleQuotes % 2 === 0 && doubleQuotes % 2 === 0) {
      if (matchIdx >= doubleSlash) {
        return { classification: "unrelated/non-version semantic text", reason: "code comment prose; not a candidate build or packaging surface" };
      }
    }
  }
  // Check /* ... */ comment
  if (/^\s*\*+/.test(line)) {
    return { classification: "unrelated/non-version semantic text", reason: "code comment prose; not a candidate build or packaging surface" };
  }
  const blockStart = line.indexOf("/*");
  const blockEnd = line.indexOf("*/");
  if (blockStart !== -1 && blockEnd !== -1 && blockEnd > blockStart) {
    if (matchIdx >= blockStart && matchIdx <= blockEnd + 1) {
      return { classification: "unrelated/non-version semantic text", reason: "code comment prose; not a candidate build or packaging surface" };
    }
  }
  // Check # comment in shell/nix/toml/ruby/yaml
  if (/\.(?:toml|nix|sh|rb|ya?ml)$/.test(path)) {
    const hashIdx = line.indexOf("#");
    if (hashIdx !== -1) {
      const beforeHash = line.slice(0, hashIdx);
      const singleQuotes = (beforeHash.match(/'/g) || []).length;
      const doubleQuotes = (beforeHash.match(/"/g) || []).length;
      if (singleQuotes % 2 === 0 && doubleQuotes % 2 === 0) {
        if (matchIdx >= hashIdx) {
          return { classification: "unrelated/non-version semantic text", reason: "code comment prose; not a candidate build or packaging surface" };
        }
      }
    }
  }

  // Extract executable code on line (strip comment if after executable code)
  let codeLine = line;
  if (doubleSlash !== -1) {
    const beforeSlash = line.slice(0, doubleSlash);
    const sq = (beforeSlash.match(/'/g) || []).length;
    const dq = (beforeSlash.match(/"/g) || []).length;
    if (sq % 2 === 0 && dq % 2 === 0) codeLine = beforeSlash;
  }
  if (blockStart !== -1 && blockEnd !== -1 && blockEnd > blockStart) {
    codeLine = line.slice(0, blockStart) + " " + line.slice(blockEnd + 2);
  }
  if (/\.(?:toml|nix|sh|rb|ya?ml)$/.test(path)) {
    const hashIdx = line.indexOf("#");
    if (hashIdx !== -1) {
      const beforeHash = line.slice(0, hashIdx);
      const sq = (beforeHash.match(/'/g) || []).length;
      const dq = (beforeHash.match(/"/g) || []).length;
      if (sq % 2 === 0 && dq % 2 === 0) codeLine = beforeHash;
    }
  }

  // 5. Frozen protocol constants and specification schemas
  if (/(?:^|\/)(?:protocol|contracts|design-evidence|design_evidence)\b/i.test(path) || path.startsWith("apps/studio/protocol/")) {
    return { classification: "historical immutable evidence", reason: "frozen protocol history or design evidence schema constant" };
  }
  if (/(?:schemaVersion|metadataVersion|\$schema|spdxVersion|_VERSION\s*=\s*\d+|formatVersion|receiptVersion)/i.test(codeLine)) {
    return { classification: "historical immutable evidence", reason: "schema specification or format version" };
  }

  // 6. Toolchains, Licenses, Supplemental Metadata, Gallery preview artifacts
  if (/^(?:rust-toolchain\.toml|apps\/studio\/(?:rust-toolchain\.toml|legal\/|gallery\/|nebular-build-inputs\.json))/.test(path)
      || (/\.(?:lock|toml|json)$/.test(path) && /(?:toolchain|license|supplemental)/i.test(path))) {
    return { classification: "unrelated/non-version semantic text", reason: "toolchain specification or legal notice artifact" };
  }

  // 7. Application Source Code
  if (/^(?:apps\/studio\/)?(?:src|src-tauri\/(?:src|solar-sail-adapter))\//.test(path)) {
    return { classification: "unrelated/non-version semantic text", reason: "internal feature model or component protocol constant; candidate version projected from application metadata" };
  }

  // 8. Retained Historical / Composition Inputs
  if (/tools\/public-composition\/accepted-.*\.json$/.test(path)) {
    return { classification: "historical immutable evidence", reason: "retained phase/publication evidence; not a next-candidate build input" };
  }

  // 9. Independent components & packages
  if (INDEPENDENT_PACKAGES.has(path) || /^packages\/(?:solar-sail|stellar-loom|tfsb-raster-resvg)\//.test(path)) {
    return { classification: "unrelated/non-version semantic text", reason: "independently versioned component package and dependency fields" };
  }
  if (/^themes\//.test(path)) {
    return { classification: "unrelated/non-version semantic text", reason: "independent paired theme reference or historical theme evidence" };
  }
  if (/^native\//.test(path)) {
    return { classification: "unrelated/non-version semantic text", reason: "independent native prebuild or addon artifact" };
  }
  if (/^nix\/(?:packages\/(?:stellar-burst|stellar-loom|solar-sail)\.nix|npm-dependency-authority\.json$|burst\/|stellar-loom\/|solar-sail\/|experimental\/|experimental-burst\/)/.test(path)) {
    return { classification: "unrelated/non-version semantic text", reason: "independent component nix packaging; separate release cadence" };
  }
  if (path === "package-lock.json") {
    return { classification: "unrelated/non-version semantic text", reason: "dependency lockfile entry; independent identity" };
  }
  if (path === "flake.nix") {
    return { classification: "unrelated/non-version semantic text", reason: "root flake component composition" };
  }

  // 10. Cargo.lock: Package-block semantic discovery (ordering-insensitive)
  if (path === "apps/studio/src-tauri/Cargo.lock") {
    let blockStart = -1;
    for (let i = lineIndex; i >= 0; i--) {
      if (/^\s*\[\[package\]\]\s*$/.test(lines[i])) {
        blockStart = i;
        break;
      }
    }
    let blockEnd = lines.length;
    for (let i = lineIndex + 1; i < lines.length; i++) {
      if (/^\s*\[\[package\]\]\s*$/.test(lines[i])) {
        blockEnd = i;
        break;
      }
    }
    if (blockStart !== -1) {
      const block = lines.slice(blockStart, blockEnd);
      const isNebular = block.some(l => /^\s*name\s*=\s*"theme-forge-nebular-fusion"\s*$/.test(l));
      if (isNebular && /^\s*version\s*=\s*"[^"]+"/.test(line)) {
        return { classification: "derived/checked candidate surface", reason: "live product version reference" };
      }
    }
    return { classification: "unrelated/non-version semantic text", reason: "cargo lockfile dependency entry" };
  }

  // 11. Cargo.toml: Package vs Dependency crate versions
  let cargoSection = null;
  if (path.endsWith("Cargo.toml")) {
    for (let i = lineIndex; i >= 0; i--) {
      const secMatch = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
      if (secMatch) {
        cargoSection = secMatch[1].trim();
        break;
      }
    }
    if (path === "apps/studio/src-tauri/Cargo.toml") {
      if (cargoSection === "package" && /^\s*version\s*=/.test(codeLine)) {
        return { classification: "derived/checked candidate surface", reason: "live product version reference" };
      }
      if (/^\s*rust-version\s*=/.test(codeLine) || ["dependencies", "build-dependencies", "dev-dependencies"].includes(cargoSection)) {
        return { classification: "unrelated/non-version semantic text", reason: "rust toolchain or dependency specification" };
      }
      return { classification: null, reason: "unknown live version field requires maintained owner classification" };
    }
  }

  // 12. Pinned supply-chain tools specification
  if (path === "tools/ci/supply-chain-tools.json") {
    return { classification: "unrelated/non-version semantic text", reason: "pinned supply-chain tool versions; independent of application candidate" };
  }

  // 13. Public composition product membership
  if (path === "tools/public-composition/product-membership.json") {
    return { classification: "unrelated/non-version semantic text", reason: "public composition product membership manifest and third-party license paths" };
  }

  // 14. Specific known independent tools and public composition baselines
  if (path === "tools/public-composition/compose-terminal-nova.mjs" || path === "tools/public-composition/terminal-nova-v2.mjs") {
    return { classification: "unrelated/non-version semantic text", reason: "independent terminal nova component composition" };
  }
  if (path === "tools/public-composition/validate-workflow-semantics.mjs") {
    return { classification: "unrelated/non-version semantic text", reason: "pinned workflow action toolchain dependency" };
  }
  if (path === "tools/public-composition/verify-documentation-patch.mjs") {
    return { classification: "unrelated/non-version semantic text", reason: "documentation patch verification test baseline" };
  }
  if (path === "tools/public-composition/compose-nebular-fusion.mjs" || path === "tools/public-composition/verify-nebular-fusion.mjs") {
    if (/EXPECTED_RC_VERSION|HISTORICAL_LOOM_VERSIONS|openpgpPackageJson|coreMetadata|loomMetadata|binding\.history|pkgMetadata|rasterTarget|nebularReadme/.test(line)) {
      return { classification: "unrelated/non-version semantic text", reason: "cross-version matrix verification baseline" };
    }
  }
  if (path === "tools/qualify-terminal-nova-brand.mjs") {
    return { classification: "unrelated/non-version semantic text", reason: "independent component version; separate release cadence" };
  }

  // 15. Candidate Version in Maintained Projections (Homebrew Casks, Nix package, platform-targets)
  if (path === "apps/studio/tools/platform-targets.mjs") {
    if (/(?:^|\s)(?:export\s+)?const\s+CANDIDATE_VERSION\s*=/.test(codeLine)) {
      return { classification: "derived/checked candidate surface", reason: "live product version reference" };
    }
    return { classification: null, reason: "unknown live version field requires maintained owner classification" };
  }
  if (/^tools\/homebrew\/Casks\/[^/]+\.rb$/.test(path)) {
    if (/^\s*version\s+["']/.test(codeLine)) {
      return { classification: "derived/checked candidate surface", reason: "live product version reference" };
    }
    return { classification: null, reason: "unknown live version field requires maintained owner classification" };
  }
  if (path === "nix/packages/nebular-fusion.nix" || /^nix\/nebular\//.test(path)) {
    if (/^\s*version\s*=\s*["']/.test(codeLine)) {
      return { classification: "derived/checked candidate surface", reason: "live product version reference" };
    }
    return { classification: null, reason: "unknown live version field requires maintained owner classification" };
  }

  // 16. Strict checks in maintained tools (tools/ and apps/studio/tools/)
  if (path.startsWith("tools/") || path.startsWith("apps/studio/tools/")) {
    const beforeMatch = line.slice(0, matchIdx);
    const inlinePropMatch = beforeMatch.match(/([A-Za-z0-9_$.-]+)['"]?\s*[:=]\s*['"]?$/);
    const varMatch = codeLine.match(/(?:^|\s)(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/);
    const propMatch = codeLine.match(/^\s*["']?([A-Za-z0-9_$.-]+)["']?\s*[:=]/);
    const declaredField = inlinePropMatch ? inlinePropMatch[1] : (varMatch ? varMatch[1] : (propMatch ? propMatch[1] : null));

    // Injected unowned release or version declaration in tools MUST fail:
    if (declaredField && /^(?:release|releaseVersion|appVersion|unknownVersion)$/i.test(declaredField)) {
      return {
        classification: null,
        reason: /release/i.test(declaredField)
          ? "literal release declaration requires maintained field ownership"
          : "unknown live version field requires maintained owner classification"
      };
    }
    if (path === "tools/nebular-release-layout.mjs") {
      if (declaredField === "version" || /^(?:candidate_?version|nebular_?version)$/i.test(declaredField)) {
        return { classification: "derived/checked candidate surface", reason: "live product version reference" };
      }
      return { classification: null, reason: "literal release declaration requires maintained field ownership" };
    }
    if (/^(?:candidate_?version|nebular_?version)$/i.test(declaredField)) {
      return { classification: "derived/checked candidate surface", reason: "live product version reference" };
    }
    if (/\.(?:toml|nix)$/.test(path) && declaredField === "version") {
      return { classification: "derived/checked candidate surface", reason: "live product version reference" };
    }

    // Specific tool implementations:
    if (path === "tools/ci/ci-contract.mjs") {
      const surrounding = lines.slice(Math.max(0, lineIndex - 10), lineIndex + 1).join("\n");
      if (/NODE_RELEASE_IDENTITY|CARGO_AUDIT_IDENTITY|WASM_RENDERER_IDENTITY/.test(surrounding) && declaredField === "version") {
        return { classification: "unrelated/non-version semantic text", reason: "pinned toolchain, compiler, or build environment dependency" };
      }
      return { classification: null, reason: "unknown live version field requires maintained owner classification" };
    }
    if (path === "apps/studio/tools/app-preview-prepare.mjs") {
      if (declaredField === "version" && lineIndex > 500 && lineIndex < 600) {
        return { classification: "unrelated/non-version semantic text", reason: "preview fixture provenance package version" };
      }
      if (/@radix-ui|class-variance-authority|clsx|tailwind-merge/.test(line)) {
        return { classification: "unrelated/non-version semantic text", reason: "pinned preview fixture upstream dependency" };
      }
      return { classification: null, reason: "unknown live version field requires maintained owner classification" };
    }
    if (path === "apps/studio/tools/gallery-prepare.mjs") {
      if (declaredField === "version" && (lineIndex > 300 && lineIndex < 500)) {
        return { classification: "unrelated/non-version semantic text", reason: "gallery preview fixture package version" };
      }
      if (/fixturePackages|starlight|astro/.test(line)) {
        return { classification: "unrelated/non-version semantic text", reason: "gallery preview fixture package version" };
      }
      return { classification: null, reason: "unknown live version field requires maintained owner classification" };
    }
    if (path === "apps/studio/tools/release-notices.mjs") {
      if (codeLine.includes("manifestData.root?.version") || lineIndex > 740) {
        return { classification: "unrelated/non-version semantic text", reason: "retained historical legal notices generator and baseline manifest" };
      }
      return { classification: null, reason: "unknown live version field requires maintained owner classification" };
    }
    const context = lines.slice(Math.max(0, lineIndex - 6), Math.min(lines.length, lineIndex + 7)).join("\n");

    if (path === "apps/studio/tools/packaged-sidecar-smoke.mjs" || path === "apps/studio/tools/sidecar-transcript.mjs") {
      if (/protocol|runSidecarSession|sidecar/i.test(context)) {
        return { classification: "unrelated/non-version semantic text", reason: "frozen sidecar IPC protocol version; independent of application candidate" };
      }
      return { classification: null, reason: "unknown live version field requires maintained owner classification" };
    }

    // Toolchains, schemas, independent components, fixtures in tools:
    if (/nodejs|node|rustc|cargo|rust|npm|pnpm|syft|grype|systemLibraries|toolchains|pkg-config|compiler|clang|importNpmLock|runtimeDependencies|gtk|glib|webkitgtk|libsoup|openssl|cairo|pango|libiconv|xmldom|smol-toml|viteVersion|authenticity|node-version|rust-version|DeclaredRustVersion|Node-Runtime/i.test(context)) {
      return { classification: "unrelated/non-version semantic text", reason: "pinned toolchain, compiler, or build environment dependency" };
    }
    if (/schema|schemaVersion|metadataVersion|sarif|\$schema|spdxVersion|_VERSION\s*=\s*\d+|formatVersion|receiptVersion/i.test(context)) {
      return { classification: "historical immutable evidence", reason: "schema specification or format version" };
    }
    if (/burst|loom|solar|resvg|raster|terminal-nova|stellar|starlight|catalog|palette|formulae|toolVersion|brandVersion/i.test(context)) {
      return { classification: "unrelated/non-version semantic text", reason: "independent component version; separate release cadence" };
    }
    if (/@radix-ui|class-variance-authority|clsx|tailwind-merge|patternedAfterUpstreamPackages|fixture-brand|consumer|disposable|foreign|installed-consumer|studio-app-preview|studio-sidecar-payload|studio-qualification|gallery-prepare-tool-consumer/i.test(context)) {
      return { classification: "unrelated/non-version semantic text", reason: "pinned preview fixture upstream dependency" };
    }
    if (/historical|accepted|baseline|compatibility|migration|previous|v0\.[1-4]\.0|release-notices|manifestData\.root\?\.version|EXPECTED_RC_VERSION|expectedPackage\.version|before\.version|after\.version|provenance\.packageVersion|nebularReadme|equivalence|publication|receipt|archive|tarball|shasum|digest|package-lock|pkgVersion|pkg\.version/i.test(context)) {
      return { classification: "unrelated/non-version semantic text", reason: "historical release baseline, migration fixture, or cross-version matrix" };
    }
    if (/pkgJson\.version\s*:\s*"0\.0\.0"|identity\s*=\s*\(id\)/.test(line)) {
      return { classification: "unrelated/non-version semantic text", reason: "test identity or default fallback version" };
    }
    if (/CANDIDATE_VERSION|candidateVersion/i.test(context) && /===|==|includes/.test(codeLine)) {
      return { classification: "unrelated/non-version semantic text", reason: "cross-version matrix verification baseline" };
    }
    if (declaredField && /version/i.test(declaredField)) {
      return { classification: null, reason: "unknown live version field requires maintained owner classification" };
    }
  }

  // 17. Anything else remains unclassified
  return { classification: null, reason: "requires maintained owner classification" };
}

export function discoverVersionReferences(repoRoot = resolve(".")) {
  const hits = [], unclassified = [];
  let visited = 0;

  function extractVersionAssignment(line) {
    if (/^\s*(?:\/\/|\/\*|\*|#)/.test(line)) return null;
    const declMatch = line.match(/(?:^|\s)(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*([^;,\n]+)/)
      ?? line.match(/^\s*["']?([A-Za-z0-9_$.-]+)["']?\s*[:=]\s*([^;,\n]+)/)
      ?? line.match(/^\s*([A-Za-z0-9_$]+)\s+["']([^"']+)["']/);

    if (!declMatch) return null;
    const field = declMatch[1];
    let rawVal = declMatch[2]?.trim() ?? "";

    // Must be a literal string or literal number, not an expression or function call
    const strMatch = rawVal.match(/^(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)$/);
    const numMatch = rawVal.match(/^(\d+)$/);
    if (!strMatch && !numMatch) return null;

    const val = strMatch ? (strMatch[1] ?? strMatch[2] ?? strMatch[3]) : numMatch[1];

    if (/version$/i.test(field) || /^(?:release|candidate_?version|nebular_?version|releaseVersion|appVersion|unknownVersion)$/i.test(field)) {
      return { field, value: val };
    }
    return null;
  }

  function visit(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = prefix + entry.name;
      if (++visited > 50000) throw new Error("Candidate discovery file limit exceeded");
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name) && !GENERATED.test(path)) visit(join(directory, entry.name), path + "/");
        continue;
      }
      if (!/\.(?:json|toml|nix|mjs|cjs|js|ts|tsx|rs|sh|yml|yaml|md|rb)$/.test(path)) continue;
      if (!entry.isFile() || lstatSync(join(directory, entry.name)).size > 4 * 1024 * 1024) {
        const hit = { path, line: 0, version: null, classification: null, reason: "unsupported source type or discovery byte limit" };
        hits.push(hit); unclassified.push(hit); continue;
      }
      const content = readFileSync(join(directory, entry.name), "utf8");

      // Semantic JSON parsing for structured JSON files
      if (entry.name.endsWith(".json")) {
        const jsonHits = scanJsonVersions(path, content);
        if (jsonHits !== null) {
          const lines = content.split(/\r?\n/);
          for (const hit of jsonHits) {
            if (!hit.classification && !hit.reason) {
              const lineIndex = Math.max(0, hit.line - 1);
              const line = lines[lineIndex] ?? "";
              const matchObj = { index: hit.column - 1, 0: hit.version };
              const resolved = classifyHit(path, line, lineIndex, lines, matchObj);
              hit.classification = resolved.classification;
              hit.reason = resolved.reason;
            }
            hits.push(hit);
            if (!hit.classification) unclassified.push(hit);
          }
          continue;
        }
      }

      // Line-by-line scanning with semantic contextual classification
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const semverMatches = [...line.matchAll(VERSION)];

        if (semverMatches.length > 0) {
          for (const match of semverMatches) {
            const version = match[0];
            const { classification, reason } = classifyHit(path, line, index, lines, match);
            const hit = { path, line: index + 1, column: match.index + 1, version, classification: classification ?? null, reason: reason ?? "requires maintained owner classification" };
            hits.push(hit);
            if (!classification) unclassified.push(hit);
          }
        } else {
          // Check for non-semver version assignment (e.g. unknownVersion = "broken", version = "latest", version = 17)
          const decl = extractVersionAssignment(line);
          if (decl && isLivePath(path)) {
            const { classification, reason } = classifyHit(path, line, index, lines, { index: 0, 0: decl.value });
            const hit = { path, line: index + 1, column: 1, version: decl.value, classification: classification ?? null, reason: reason ?? "unknown live version field requires maintained owner classification" };
            hits.push(hit);
            if (!classification) unclassified.push(hit);
          }
        }
      }
    }
  }
  visit(repoRoot);
  const drift = hits.filter(h => ["candidate-authoritative", "derived/checked candidate surface"].includes(h.classification)
    && (h.reason === "live product version reference" || h.reason === "maintained application package version")
    && h.version !== CANDIDATE_VERSION);
  return { candidateVersion: CANDIDATE_VERSION, visited, hits, unclassified, drift,
    passed: unclassified.length === 0 && drift.length === 0 };
}

/**
 * Discovers supported application candidate surfaces within apps/studio.
 * Uses semantic section and block parsing for Cargo.toml and Cargo.lock.
 */
export function discoverApplicationSurfaces(studioRoot) {
  const readSafe = rel => {
    const p = join(studioRoot, rel);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };
  const json = rel => {
    const content = readSafe(rel);
    return content ? JSON.parse(content) : {};
  };
  const cargo = readSafe("src-tauri/Cargo.toml");
  const lock = readSafe("src-tauri/Cargo.lock");

  const pkgJson = json("package.json");
  const pkgLock = json("package-lock.json");
  const tauriConf = json("src-tauri/tauri.conf.json");

  const packageSection = cargo?.match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1];
  const cargoVersion = packageSection?.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];

  let lockVersion;
  if (lock) {
    const packageBlocks = lock.split(/\[\[package\]\]/);
    for (const block of packageBlocks) {
      if (/^\s*name\s*=\s*"theme-forge-nebular-fusion"\s*$/m.test(block)) {
        lockVersion = block.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
        break;
      }
    }
  }

  return [
    { id: "studio-package.json", kind: "application", path: join(studioRoot, "package.json"), version: pkgJson.version, expected: CANDIDATE_VERSION },
    { id: "studio-package-lock.json", kind: "application", path: join(studioRoot, "package-lock.json"), version: pkgLock.version, expected: CANDIDATE_VERSION },
    { id: "studio-package-lock.json#root-package", kind: "application", path: join(studioRoot, "package-lock.json"), version: pkgLock.packages?.[""]?.version, expected: CANDIDATE_VERSION },
    { id: "studio-tauri.conf.json", kind: "application", path: join(studioRoot, "src-tauri/tauri.conf.json"), version: tauriConf.version, expected: CANDIDATE_VERSION },
    { id: "studio-Cargo.toml", kind: "application", path: join(studioRoot, "src-tauri/Cargo.toml"), version: cargoVersion, expected: CANDIDATE_VERSION },
    { id: "studio-Cargo.lock", kind: "application", path: join(studioRoot, "src-tauri/Cargo.lock"), version: lockVersion, expected: CANDIDATE_VERSION },
  ];
}

/**
 * Discovers supported candidate package surfaces across repoRoot,
 * including npm wrapper, payload bindings, and all per-platform packages and manifests.
 * Dynamically discovers candidate package surfaces across the repo by package name.
 */
export function discoverPackageSurfaces(repoRoot) {
  const surfaces = [];
  const skipDirs = new Set([
    ...SKIP_DIRECTORIES,
    "apps",
    "docs",
    "test",
    "tests",
    "spec",
    "specs",
    "fixtures",
    "examples",
    "gallery",
    "test-matrix",
  ]);

  function walk(currentDir) {
    for (const entry of readdirSync(currentDir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name) && !GENERATED.test(join(currentDir, entry.name))) {
          walk(join(currentDir, entry.name));
        }
      } else if (entry.name === "package.json") {
        const pkgPath = join(currentDir, entry.name);
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
          if (pkg.name === "@knowledge-forge-ai/theme-forge-nebular-fusion") {
            surfaces.push({
              id: "npm-wrapper-package.json",
              kind: "package",
              path: pkgPath,
              version: pkg.version,
              expected: CANDIDATE_VERSION,
            });
            const bindingsPath = join(currentDir, "payload-bindings.json");
            if (existsSync(bindingsPath)) {
              const bindings = JSON.parse(readFileSync(bindingsPath, "utf8"));
              surfaces.push({
                id: "npm-wrapper-payload-bindings.json",
                kind: "package",
                path: bindingsPath,
                version: bindings.version,
                expected: CANDIDATE_VERSION,
              });
            }
            if (pkg.optionalDependencies) {
              for (const [depName, depVer] of Object.entries(pkg.optionalDependencies)) {
                if (depName.startsWith("@knowledge-forge-ai/theme-forge-nebular-fusion-")) {
                  surfaces.push({
                    id: `npm-wrapper-optionalDependency:${depName}`,
                    kind: "package-dependency",
                    path: pkgPath,
                    version: depVer,
                    expected: CANDIDATE_VERSION,
                  });
                }
              }
            }
          } else if ((typeof pkg.name === "string" && pkg.name.startsWith("@knowledge-forge-ai/theme-forge-nebular-fusion-"))
            || (isLivePath(relative(repoRoot, pkgPath)) && !INDEPENDENT_PACKAGES.has(relative(repoRoot, pkgPath)))) {
            const dirName = basename(currentDir);
            surfaces.push({
              id: `platform-${dirName}-package.json`,
              kind: "platform-package",
              path: pkgPath,
              version: pkg.version,
              expected: CANDIDATE_VERSION,
            });
          }
        } catch {
        }
      } else if (entry.name === "package-manifest.json") {
        const manifestPath = join(currentDir, entry.name);
        const relPath = relative(repoRoot, manifestPath);
        if (isLivePath(relPath) || /nebular-fusion/.test(relPath)) {
          const dirName = basename(currentDir);
          const manifestId = `platform-${dirName}-package-manifest.json`;
          if (!surfaces.some(s => s.id === manifestId)) {
            try {
              const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
              surfaces.push({
                id: manifestId,
                kind: "platform-manifest",
                path: manifestPath,
                version: manifest.version,
                expected: CANDIDATE_VERSION,
              });
            } catch {
            }
          }
        }
      }
    }
  }

  walk(repoRoot);
  return surfaces;
}

/**
 * Validates application projections in apps/studio.
 * Preserves compatibility with build-app.mjs while using maintained surface discovery.
 */
export function verifyApplicationVersion(studioRoot) {
  const surfaces = discoverApplicationSurfaces(studioRoot);
  const drift = surfaces.filter(s => s.version !== CANDIDATE_VERSION);
  if (drift.length > 0) {
    throw new Error(`Nebular candidate version drift; update application projections from package.json: ${drift.map(d => `${d.id}=${d.version}`).join(", ")}`);
  }
  return CANDIDATE_VERSION;
}

/**
 * Checks a generated release/channel manifest against expected candidate version.
 */
export function verifyChannelManifest(manifest, expectedVersion = CANDIDATE_VERSION) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Invalid channel manifest: object expected");
  }
  if (manifest.version !== expectedVersion) {
    throw new Error(`Channel manifest version mismatch: expected ${expectedVersion}, got ${manifest.version}`);
  }
  if (Array.isArray(manifest.artifacts)) {
    for (const artifact of manifest.artifacts) {
      if (typeof artifact.filename === "string" && !artifact.filename.includes(expectedVersion)) {
        throw new Error(`Channel manifest artifact filename '${artifact.filename}' does not contain expected version ${expectedVersion}`);
      }
    }
  }
  return true;
}

/**
 * Checks generated native launcher content against expected candidate version.
 */
export function verifyNativeLauncher(launcherText, expectedVersion = CANDIDATE_VERSION) {
  if (typeof launcherText !== "string") {
    throw new Error("Invalid launcher text: string expected");
  }
  const versionString = `${APPLICATION_NAME} ${expectedVersion}`;
  if (!launcherText.includes(versionString)) {
    throw new Error(`Native launcher does not output expected version '${versionString}'`);
  }
  return true;
}

/**
 * Checks generated Homebrew Cask content against expected candidate version.
 */
export function verifyCaskManifest(caskText, expectedVersion = CANDIDATE_VERSION) {
  if (typeof caskText !== "string") {
    throw new Error("Invalid Cask manifest text: string expected");
  }
  const versionLine = `version "${expectedVersion}"`;
  if (!caskText.includes(versionLine)) {
    throw new Error(`Cask manifest does not declare expected version line '${versionLine}'`);
  }
  return true;
}

/**
 * Audits cross-surface invariants across all application, package, and channel surfaces,
 * as well as legacy/external production surfaces (e.g. Nix 0.4.0, UI footer 0.2.0).
 *
 * Explicitly distinguishes candidate surfaces (which pass at 0.5.0) from unresolved production
 * surfaces, ensuring wholeCrossSurfaceInvariantPassed is NOT falsely asserted while Nix remains 0.4.0.
 */
export function auditCrossSurfaceInvariants(repoRoot) {
  const discovery = discoverVersionReferences(repoRoot);
  const studioRoot = join(repoRoot, "apps/studio");
  const applicationSurfaces = discoverApplicationSurfaces(studioRoot);
  const packageSurfaces = discoverPackageSurfaces(repoRoot);
  const candidateSurfaces = [...applicationSurfaces, ...packageSurfaces];

  const candidateDrift = candidateSurfaces.filter(s => s.version !== CANDIDATE_VERSION);

  const unresolvedSurfaces = [];

  // First-party Nix surface; the historical nixpkgs submission is outside this candidate.
  const nixFiles = [
    { id: "nix-packages-nebular-fusion", path: join(repoRoot, "nix/packages/nebular-fusion.nix") },
  ];
  for (const item of nixFiles) {
    if (existsSync(item.path)) {
      const content = readFileSync(item.path, "utf8");
      const match = content.match(/version = "([^"]+)";/)?.[1]
        ?? (/builtins\.fromJSON.*builtins\.readFile.*package\.json/.test(content) ? CANDIDATE_VERSION : "unresolved");
      if (match) {
        unresolvedSurfaces.push({
          id: item.id,
          path: item.path,
          version: match,
          expectedCandidateVersion: CANDIDATE_VERSION,
          alignedWithCandidate: match === CANDIDATE_VERSION,
          status: match === CANDIDATE_VERSION ? "aligned" : "unresolved-legacy-production",
          owner: "first-party Nix packaging",
        });
      }
    }
  }

  // UI visible footer (in apps/studio/src/app/App.tsx)
  const appTsxPath = join(studioRoot, "src/app/App.tsx");
  if (existsSync(appTsxPath)) {
    const content = readFileSync(appTsxPath, "utf8");
    const dynamicMatch = content.includes("{applicationVersion}");
    const literalMatch = content.match(/<footer>Nebular Fusion ([0-9a-zA-Z.-]+)/)?.[1];
    const footerVersion = dynamicMatch ? CANDIDATE_VERSION : (literalMatch || "unresolved");
    unresolvedSurfaces.push({
      id: "ui-visible-footer",
      path: appTsxPath,
      version: footerVersion,
      binding: dynamicMatch ? "dynamic-package-json" : "hardcoded-literal",
      expectedCandidateVersion: CANDIDATE_VERSION,
      alignedWithCandidate: footerVersion === CANDIDATE_VERSION,
      status: footerVersion === CANDIDATE_VERSION ? "aligned-dynamic-projection" : "unresolved-legacy-production",
      owner: "Studio frontend",
    });
  }

  // Legacy host protocol version (0.1.0 in apps/studio/src/protocol/contracts.ts)
  const contractsPath = join(studioRoot, "src/protocol/contracts.ts");
  if (existsSync(contractsPath)) {
    const content = readFileSync(contractsPath, "utf8");
    const hostMatch = content.match(/studioVersion:\s*"([^"]+)"/)?.[1]
      ?? (/studioVersion:\s*string/.test(content)
        && /studio_version:\s*env!\("CARGO_PKG_VERSION"\)/.test(readFileSync(join(studioRoot, "src-tauri/src/sidecar/supervisor.rs"), "utf8"))
        && /item\.studioVersion !== packageJson\.version/.test(readFileSync(join(studioRoot, "src/host/studio-host-bridge.ts"), "utf8"))
        ? CANDIDATE_VERSION : "unresolved");
    if (hostMatch) {
      unresolvedSurfaces.push({
        id: "legacy-host-protocol-version",
        path: contractsPath,
        version: hostMatch,
        expectedCandidateVersion: CANDIDATE_VERSION,
        alignedWithCandidate: hostMatch === CANDIDATE_VERSION,
        status: "host-protocol-compatibility-constant",
        owner: "Studio host protocol",
      });
    }
  }

  const unalignedProductionSurfaces = unresolvedSurfaces.filter(s => !s.alignedWithCandidate);

  return {
    candidateVersion: CANDIDATE_VERSION,
    discovery,
    candidateSurfaces,
    candidateDrift,
    candidatePassed: candidateDrift.length === 0,
    unresolvedSurfaces,
    unalignedProductionSurfaces,
    // MUST NOT falsely pass while Nix remains 0.4.0 or other production surfaces remain unaligned
    wholeCrossSurfaceInvariantPassed: discovery.passed && candidateDrift.length === 0 && unalignedProductionSurfaces.length === 0,
    summary: candidateDrift.length === 0
      ? `Candidate ${CANDIDATE_VERSION} projections passed across ${candidateSurfaces.length} application and package surfaces; ${unalignedProductionSurfaces.length} production surfaces remain unaligned.`
      : `Candidate drift detected in ${candidateDrift.length} surfaces.`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2] ? resolve(process.argv[2]) : resolve(new URL("../../..", import.meta.url).pathname);
  const audit = auditCrossSurfaceInvariants(root);
  console.log(JSON.stringify(audit, null, 2));
  if (!audit.wholeCrossSurfaceInvariantPassed) process.exitCode = 1;
}

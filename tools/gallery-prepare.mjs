#!/usr/bin/env node
// @ts-check

/**
 * apps/studio/tools/gallery-prepare.mjs
 *
 * TFSB63B Real Starlight Gallery Preparation & Installed Parity Prerequisite Tool.
 *
 * Builds finite closed Starlight gallery scenarios from the exact candidate Loom 0.1.1
 * archive in shared scratch, generating packages through installed public APIs,
 * installing them into separate consumer fixtures, performing static Astro builds,
 * running offline Playwright browser assertions inside a real sandboxed iframe,
 * and writing public-safe gallery assets.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const studioRoot = resolve(__dirname, "..");

import { repositoryRootForStudio } from "./sidecar-common.mjs";

import {
  EXPECTED_ARCHIVE_SHA256,
  EXPECTED_CONSUMER_LOCK_DIGEST,
  EXPECTED_FONT,
  GALLERY_SCENARIO_IDS,
  GALLERY_SCENARIO_PACKAGES,
  GALLERY_BRIDGE_ALLOWED_KEYS,
  GALLERY_BRIDGE_CSS_BYTE_CEILING,
  CANARY_COMMAND_NAME,
  BRIDGE_CONTRACT,
  GALLERY_COVERAGE,
  validateGalleryAuthority,
  GALLERY_SCENARIOS,
  draftAxisValues,
} from "../src/features/theme-lab/gallery-contract.ts";

export {
  EXPECTED_ARCHIVE_SHA256,
  EXPECTED_CONSUMER_LOCK_DIGEST,
  EXPECTED_FONT,
  GALLERY_SCENARIO_IDS,
  GALLERY_SCENARIO_PACKAGES,
  GALLERY_BRIDGE_ALLOWED_KEYS,
  GALLERY_BRIDGE_CSS_BYTE_CEILING,
  CANARY_COMMAND_NAME,
  BRIDGE_CONTRACT,
  GALLERY_COVERAGE,
};

import { createBridgeScript } from "../gallery/bridge-runtime.mjs";
export function generateBridgeScript(scenarioId) {
  if (!GALLERY_SCENARIO_IDS.includes(scenarioId)) throw new Error("Unknown gallery scenario");
  return createBridgeScript(BRIDGE_CONTRACT, scenarioId);
}

export const GALLERY_CSP_POLICY =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';";

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {
    tarball:
      process.env.TFSL_LOOM_TARBALL ||
      process.env.TFSB_STUDIO_LOOM_TARBALL ||
      null,
    expectedSha256:
      process.env.TFSL_LOOM_SHA256 ||
      process.env.TFSB_STUDIO_LOOM_SHA256 ||
      null,
    outputRoot: resolve(studioRoot, "public/preview/gallery"),
    manifestPath: resolve(studioRoot, "gallery/manifest.json"),
    scratchRoot:
      process.env.TFSL_GALLERY_SCRATCH_ROOT ||
      process.env.TFSB_GALLERY_SCRATCH_ROOT ||
      null,
    skipBrowser: false,
    scenario: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--tarball" && args[i + 1]) {
      options.tarball = resolve(args[++i]);
    } else if (arg === "--expected-sha256" && args[i + 1]) {
      options.expectedSha256 = args[++i];
    } else if (arg === "--output-root" && args[i + 1]) {
      options.outputRoot = resolve(args[++i]);
    } else if (arg === "--manifest-path" && args[i + 1]) {
      options.manifestPath = resolve(args[++i]);
    } else if (arg === "--scratch-root" && args[i + 1]) {
      options.scratchRoot = resolve(args[++i]);
    } else if (arg === "--skip-browser") {
      options.skipBrowser = true;
    } else if (arg === "--scenario" && args[i + 1]) {
      options.scenario = args[++i];
    }
  }

  if (!options.tarball) {
    throw new Error(
      "Missing required candidate Loom tarball! Specify via --tarball <path> or TFSL_LOOM_TARBALL environment variable (absolute private defaults removed for portability)."
    );
  }
  if (!options.scratchRoot) {
    throw new Error(
      "Missing required scratch directory! Specify via --scratch-root <path> or TFSL_GALLERY_SCRATCH_ROOT environment variable (absolute private defaults removed for portability)."
    );
  }

  return options;
}



function startStaticServer(dir, port = 0) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || "/", "http://127.0.0.1");

        // Serve parent HTTP test fixture
        if (reqUrl.pathname === "/parent-fixture.html" || reqUrl.pathname === "/parent.html") {
          const iframeSrc = reqUrl.searchParams.get("src") || "";
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Studio Host Parent Fixture</title>
  <style>
    :root { --sl-color-accent: #ff0000; --host-color: #ff0000; }
    body { margin: 0; padding: 16px; background: #0f1117; color: #f0f2f6; font-family: sans-serif; }
    #host-sentinel { color: #ff0000; font-size: 18px; margin-bottom: 12px; font-weight: bold; }
    iframe#gallery-preview-frame {
      width: 100%;
      height: 800px;
      border: 1px solid #333;
      background: #fff;
    }
  </style>
</head>
<body>
  <div id="host-sentinel">HOST SENTINEL ELEMENT</div>
  <iframe
    id="gallery-preview-frame"
    sandbox="allow-scripts"
    src="${iframeSrc}"
  ></iframe>
</body>
</html>`);
          return;
        }

        let reqPath = reqUrl.pathname;
        if (reqPath.endsWith("/")) reqPath += "index.html";
        let filePath = join(dir, reqPath.replace(/^\//, ""));

        // If not found directly, check without scenario base prefix if present
        if (!existsSync(filePath)) {
          for (const sc of GALLERY_SCENARIO_IDS) {
            const prefix = `/preview/gallery/${sc}/`;
            if (reqPath.startsWith(prefix)) {
              const sub = reqPath.slice(prefix.length);
              const altPath = join(dir, sub.endsWith("/") ? sub + "index.html" : sub);
              if (existsSync(altPath)) {
                filePath = altPath;
                break;
              }
            }
          }
        }

        if (!existsSync(filePath)) {
          res.writeHead(404, {
            "Content-Type": "text/plain",
            "Access-Control-Allow-Origin": "*",
          });
          res.end("Not Found: " + reqPath);
          return;
        }

        const ext = extname(filePath);
        const mimeTypes = {
          ".html": "text/html; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".js": "application/javascript; charset=utf-8",
          ".mjs": "application/javascript; charset=utf-8",
          ".json": "application/json; charset=utf-8",
          ".woff2": "font/woff2",
          ".svg": "image/svg+xml",
          ".png": "image/png",
        };
        const contentType = mimeTypes[ext] || "application/octet-stream";
        const content = await readFile(filePath);
        res.writeHead(200, {
          "Content-Type": contentType,
          "Access-Control-Allow-Origin": "*",
        });
        res.end(content);
      } catch (e) {
        res.writeHead(500, {
          "Content-Type": "text/plain",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(String(e));
      }
    });

    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      resolvePromise({
        port: boundPort,
        close: () => new Promise((cb) => server.close(cb)),
      });
    });
  });
}

async function computeDirectoryInventory(dir) {
  let totalBytes = 0;
  let fileCount = 0;
  const files = [];

  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const ent of entries) {
      const full = join(current, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile()) {
        const bytes = await readFile(full);
        totalBytes += bytes.length;
        fileCount++;
        files.push({
          path: relative(dir, full),
          bytes: bytes.length,
          sha256: sha256(bytes),
        });
      }
    }
  }

  await walk(dir);
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { totalBytes, fileCount, files };
}

export async function prepareGallery(options = parseCliArgs()) {
  validateGalleryAuthority(GALLERY_COVERAGE);
  console.log("=== TFSB63B Starlight Gallery Preparation ===");
  console.log(`Candidate Loom Tarball: ${options.tarball}`);
  console.log(`Output Root: ${options.outputRoot}`);
  console.log(`Manifest Path: ${options.manifestPath}`);
  console.log(`Scratch Root: ${options.scratchRoot}`);

  // 1. Verify candidate Loom archive
  if (!existsSync(options.tarball)) {
    throw new Error(`Candidate Loom tarball not found at: ${options.tarball}`);
  }
  const tarballBytes = await readFile(options.tarball);
  const actualTarballSha256 = sha256(tarballBytes);
  let targetSha = options.expectedSha256 || process.env.EXPECTED_LOOM_SHA256 || null;
  if (!targetSha) {
    const repoRoot = repositoryRootForStudio(studioRoot);
    const authBindingPath = resolve(repoRoot, "authenticated-inputs/loom-binding.json");
    if (existsSync(authBindingPath)) {
      try {
        const authBinding = JSON.parse(await readFile(authBindingPath, "utf8"));
        if (authBinding.sha256 && /^[a-f0-9]{64}$/.test(authBinding.sha256)) {
          targetSha = authBinding.sha256;
        }
      } catch {}
    }
  }
  if (!targetSha) {
    targetSha = EXPECTED_ARCHIVE_SHA256;
  }
  if (actualTarballSha256 !== targetSha) {
    throw new Error(
      `Candidate Loom archive digest mismatch! Expected: ${targetSha}, Actual: ${actualTarballSha256}`
    );
  }
  console.log(`✓ Authenticated Candidate Loom archive: ${actualTarballSha256} (${tarballBytes.length} bytes)`);

  // 2. Setup scratch directories
  const evidenceDir = join(options.scratchRoot, "evidence");
  const toolConsumerDir = join(options.scratchRoot, "tool-consumer");
  const packDir = join(options.scratchRoot, "theme-packs");
  const consumerBaseDir = join(options.scratchRoot, "consumer-base");
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(toolConsumerDir, { recursive: true });
  await mkdir(packDir, { recursive: true });
  await mkdir(consumerBaseDir, { recursive: true });

  // 3. Install Loom candidate into tool consumer
  console.log("\n--- Step 1: Setting up tool consumer and importing public APIs ---");
  await writeFile(
    join(toolConsumerDir, "package.json"),
    JSON.stringify({
      name: "gallery-prepare-tool-consumer",
      version: "1.0.0",
      private: true,
      type: "module",
    }, null, 2) + "\n"
  );

  execFileSync("npm", ["install", "--ignore-scripts", options.tarball], {
    cwd: toolConsumerDir,
    stdio: "pipe",
    encoding: "utf8",
  });

  const installedLoomRoot = join(
    toolConsumerDir,
    "node_modules/@knowledge-forge-ai/theme-forge-stellar-loom"
  );
  if (!existsSync(installedLoomRoot)) {
    throw new Error(`Installed Loom not found in tool consumer at ${installedLoomRoot}`);
  }

  const loomPkg = JSON.parse(await readFile(join(installedLoomRoot, "package.json"), "utf8"));
  console.log(`✓ Installed ${loomPkg.name}@${loomPkg.version}`);

  const loomEntryPath = join(installedLoomRoot, loomPkg.exports["."].import || loomPkg.exports["."]);
  const loom = await import(pathToFileURL(loomEntryPath).href);

  for (const fn of ["compileThemeCatalog", "generateThemePackageCatalog", "writeThemePackage"]) {
    if (typeof loom[fn] !== "function") {
      throw new Error(`Installed package missing required public API: ${fn}`);
    }
  }
  console.log("✓ Verified installed public APIs: compileThemeCatalog, generateThemePackageCatalog, writeThemePackage");

  // 4. Load specifications and portable fixture resources from app gallery
  console.log("\n--- Step 2: Loading specifications and portable fixture resources ---");
  const blackSpecPath = join(installedLoomRoot, "examples/loom-black-catalog.json");
  const flexokiSpecPath = join(installedLoomRoot, "examples/loom-flexoki-catalog.json");
  const celestiaSpecPath = join(installedLoomRoot, "examples/loom-celestia-catalog.json");

  const blackSpec = JSON.parse(await readFile(blackSpecPath, "utf8"));
  const flexokiSpec = JSON.parse(await readFile(flexokiSpecPath, "utf8"));
  const celestiaSpec = JSON.parse(await readFile(celestiaSpecPath, "utf8"));

  // Active-only variant
  const activeOnlySpec = structuredClone(blackSpec);
  activeOnlySpec.name = "loom-active-only-catalog";
  activeOnlySpec.catalog.sidebar.mode = "active-only";
  activeOnlySpec.catalog.pageTitle.copy = "title";
  activeOnlySpec.catalog.pagination.variant = "card";
  activeOnlySpec.codePresentation.frame = "editor";
  activeOnlySpec.codePresentation.copy = "minimal";

  // Portable font fixture from app gallery
  const fixtureFontsDir = resolve(studioRoot, "gallery/fixtures/fonts");
  const fontPath = join(fixtureFontsDir, "source-code-pro.woff2");
  if (!existsSync(fontPath)) {
    throw new Error(`Portable font fixture missing at: ${fontPath}`);
  }
  const fontBytes = await readFile(fontPath);
  const fontSha = sha256(fontBytes);
  if (fontSha !== EXPECTED_FONT.sha256) {
    throw new Error(`Font digest mismatch! Expected ${EXPECTED_FONT.sha256}, got ${fontSha}`);
  }
  const fontResourcesMap = new Map([[EXPECTED_FONT.id, new Uint8Array(fontBytes)]]);
  console.log(`✓ Loaded and verified Source Code Pro font fixture (${fontBytes.length} bytes, SHA-256: ${fontSha.slice(0, 16)}...)`);

  // 5. Generate and pack theme packages
  console.log("\n--- Step 3: Generating and packing theme packages ---");
  const themeDefinitions = [
    {
      id: "black-catalog",
      spec: blackSpec,
      accent: "default",
      packageName: GALLERY_SCENARIO_PACKAGES["black-catalog"],
    },
    {
      id: "flexoki-catalog",
      spec: flexokiSpec,
      accent: "cyan",
      packageName: GALLERY_SCENARIO_PACKAGES["flexoki-catalog"],
    },
    {
      id: "celestia-catalog",
      spec: celestiaSpec,
      accent: "default",
      packageName: GALLERY_SCENARIO_PACKAGES["celestia-catalog"],
    },
    {
      id: "active-only-catalog",
      spec: activeOnlySpec,
      accent: "default",
      packageName: GALLERY_SCENARIO_PACKAGES["active-only-catalog"],
    },
  ];

  for (const theme of themeDefinitions) {
    const actual = draftAxisValues(theme.spec);
    const declared = GALLERY_SCENARIOS[theme.id];
    for (const axis of Object.keys(GALLERY_COVERAGE.axes).filter(axis => axis !== "heroLayout")) {
      if (actual[axis] !== declared.structuralConfig[axis]) throw new Error(`Coverage declaration disagrees with installed input: ${theme.id}/${axis}`);
    }
    for (const hero of declared.heroRoutes) {
      const prepared = theme.spec.catalog.hero.routes.find(route => route.route === hero.route);
      if (!prepared || prepared.layout !== hero.layout || prepared.title !== hero.title) throw new Error(`Hero coverage lacks exact installed input: ${theme.id}/${hero.route}`);
    }
  }

  const generatedTarballs = {};

  for (const theme of themeDefinitions) {
    const genDir = join(options.scratchRoot, `gen-${theme.id}`);
    await rm(genDir, { recursive: true, force: true });
    await mkdir(genDir, { recursive: true });

    const genOpts = {
      themeSpec: theme.spec,
      metadata: {
        name: theme.packageName,
        version: "0.1.0",
        description: `Starlight gallery preview package for ${theme.id}`,
      },
      accent: theme.accent,
      fontResources: new Map(
        (theme.spec.fonts || []).map((f) => [f.id, fontResourcesMap.get(f.id)])
      ),
    };

    const packageResult = loom.generateThemePackageCatalog(genOpts);
    const packageInventory = (result) => [...result.files].map(([path, bytes]) => ({ path, sha256: sha256(bytes), bytes: Buffer.byteLength(bytes) })).sort((a, b) => a.path.localeCompare(b.path));
    const generatedInventory = packageInventory(packageResult);
    if (JSON.stringify(generatedInventory) !== JSON.stringify(packageInventory(loom.generateThemePackageCatalog(genOpts)))) throw new Error("Repeat generation changed the generated package inventory");
    await loom.writeThemePackage(packageResult, genDir);

    const packDest = join(packDir, theme.id);
    await mkdir(packDest, { recursive: true });
    const packOut = execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", packDest],
      { cwd: genDir, encoding: "utf8" }
    );
    const parsedPack = JSON.parse(packOut)[0];
    const tarballPath = join(packDest, parsedPack.filename);
    const tBytes = await readFile(tarballPath);
    const tSha = sha256(tBytes);

    generatedTarballs[theme.id] = {
      id: theme.id,
      packageName: theme.packageName,
      tarballPath,
      filename: parsedPack.filename,
      size: tBytes.length,
      sha256: tSha,
      themeInputDigest: packageResult.themeInputDigest,
      outputDigest: packageResult.cssOutputDigest,
      descriptor: packageResult.descriptor,
      selectedAccent: theme.accent,
      generatedInventory,
      generatedInventoryDigest: sha256(JSON.stringify(generatedInventory)),
    };
    console.log(`✓ Generated & packed ${theme.packageName} -> ${parsedPack.filename} (${tBytes.length} bytes, SHA-256: ${tSha.slice(0, 16)}...)`);
  }

  // 6. Build scenarios in separate consumer fixtures using portable app-pinned base
  console.log("\n--- Step 4: Building static Astro gallery across scenarios ---");
  const fixtureConsumerDir = resolve(studioRoot, "gallery/fixtures/consumer");
  if (!existsSync(join(fixtureConsumerDir, "package-lock.json"))) {
    throw new Error(`Pinned consumer fixture missing at: ${fixtureConsumerDir}`);
  }

  // Verify pinned lock digest
  const baseLockBytes = await readFile(join(fixtureConsumerDir, "package-lock.json"));
  const baseLockSha = sha256(baseLockBytes);
  if (baseLockSha !== EXPECTED_CONSUMER_LOCK_DIGEST) {
    throw new Error(`Pinned consumer fixture lock digest mismatch! Expected ${EXPECTED_CONSUMER_LOCK_DIGEST}, got ${baseLockSha}`);
  }

  // Pre-install consumer base in scratch if not already present
  const baseNodeModules = join(consumerBaseDir, "node_modules");
  const baseAstroBin = join(baseNodeModules, ".bin/astro");
  if (!existsSync(baseAstroBin)) {
    console.log("Setting up consumer base dependencies (npm ci --ignore-scripts)...");
    await cp(join(fixtureConsumerDir, "package.json"), join(consumerBaseDir, "package.json"));
    await cp(join(fixtureConsumerDir, "package-lock.json"), join(consumerBaseDir, "package-lock.json"));
    execFileSync("npm", ["ci", "--ignore-scripts"], {
      cwd: consumerBaseDir,
      stdio: "pipe",
      encoding: "utf8",
    });
    if (!existsSync(baseAstroBin)) {
      throw new Error(`Installed astro executable not found at: ${baseAstroBin}`);
    }
  }

  const builtScenarios = {};

  for (const theme of themeDefinitions) {
    if (options.scenario && options.scenario !== theme.id) continue;

    console.log(`\nBuilding consumer for scenario \x27${theme.id}\x27...`);
    const consumerDir = join(options.scratchRoot, `consumer-${theme.id}`);
    await rm(consumerDir, { recursive: true, force: true });
    await mkdir(consumerDir, { recursive: true });

    // Copy portable base consumer fixture files
    await cp(fixtureConsumerDir, consumerDir, {
      recursive: true,
      filter: (src) => {
        const rel = relative(fixtureConsumerDir, src);
        if (rel.startsWith(".astro") || rel === ".astro") return false;
        if (rel.startsWith("dist") || rel === "dist") return false;
        if (rel.startsWith("node_modules") || rel === "node_modules") return false;
        return true;
      },
    });

    // Copy cached consumer base node_modules
    await cp(baseNodeModules, join(consumerDir, "node_modules"), { recursive: true });

    // Install generated theme tarball
    const pkgTarball = generatedTarballs[theme.id].tarballPath;
    execFileSync(
      "npm",
      ["install", "--ignore-scripts", "--no-save", "--package-lock=false", pkgTarball],
      { cwd: consumerDir, stdio: "pipe" }
    );

    // Verify package-lock.json unchanged
    const lockBytes = await readFile(join(consumerDir, "package-lock.json"));
    const lockDigest = sha256(lockBytes);
    if (lockDigest !== EXPECTED_CONSUMER_LOCK_DIGEST) {
      throw new Error(`Consumer lock altered during theme installation for ${theme.id}!`);
    }

    // Write astro.config.mjs with strict scoped CSP meta tag, bridge script, and navigation
    const bridgeScript = generateBridgeScript(theme.id);
    const astroConfigContent = `import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import themePlugin from "${theme.packageName}";

export default defineConfig({
  base: "/preview/gallery/${theme.id}/",
  outDir: "./dist",
  integrations: [
    starlight({
      title: "Theme Forge Starlight Gallery",
      plugins: [themePlugin()],
      head: [
        {
          tag: "meta",
          attrs: {
            "http-equiv": "Content-Security-Policy",
            content: ${JSON.stringify(GALLERY_CSP_POLICY)},
          },
        },
        {
          tag: "script",
          content: ${JSON.stringify(bridgeScript)},
        },
      ],
      sidebar: [
        {
          label: "Catalog Core",
          items: [
            { label: "Overview", slug: "catalog" },
            {
              label: "Nested Hierarchy",
              items: [
                { label: "Nested Sidebar", slug: "catalog/sidebar-nested" },
              ],
            },
          ],
        },
        {
          label: "Hero Layouts",
          items: [
            { label: "Preview", slug: "catalog/preview" },
        { label: "Centered", slug: "catalog/hero-centered" },
            { label: "Media Top", slug: "catalog/hero-media-top" },
            { label: "Media Left", slug: "catalog/hero-media-left" },
            { label: "Media Right", slug: "catalog/hero-media-right" },
            { label: "Banner", slug: "catalog/hero-banner" },
          ],
        },
        {
          label: "Full Width",
          items: [
            { label: "Sidebar-less", slug: "catalog/sidebar-less" },
          ],
        },
      ],
    }),
  ],
});
`;
    await writeFile(join(consumerDir, "astro.config.mjs"), astroConfigContent, "utf8");

    // Execute Astro build using installed executable directly (no npx download fallback)
    const astroBin = join(consumerDir, "node_modules/.bin/astro");
    if (!existsSync(astroBin)) {
      throw new Error(`Installed astro executable missing in consumer at: ${astroBin}`);
    }

    const buildStart = performance.now();
    const buildProc = spawnSync(process.execPath, [astroBin, "build"], {
      cwd: consumerDir,
      stdio: "pipe",
      encoding: "utf8",
    });
    const buildDuration = Math.round(performance.now() - buildStart);

    if (buildProc.status !== 0) {
      console.error(buildProc.stderr);
      throw new Error(`Astro build failed for scenario \x27${theme.id}\x27 (exit code ${buildProc.status})`);
    }

    const distDir = join(consumerDir, "dist");
    if (!existsSync(join(distDir, "catalog/index.html"))) {
      throw new Error(`Astro build succeeded for \x27${theme.id}\x27 but catalog/index.html is missing`);
    }
    console.log(`✓ Scenario \x27${theme.id}\x27 built successfully in ${buildDuration}ms via installed executable`);

    // Stage output to outputRoot/<id>
    const destScenarioDir = join(options.outputRoot, theme.id);
    await rm(destScenarioDir, { recursive: true, force: true });
    await mkdir(destScenarioDir, { recursive: true });
    await cp(distDir, destScenarioDir, { recursive: true });

    const inventory = await computeDirectoryInventory(destScenarioDir);
    if (JSON.stringify(inventory) !== JSON.stringify(await computeDirectoryInventory(distDir))) throw new Error("Staged gallery differs from installed consumer build");
    builtScenarios[theme.id] = {
      id: theme.id,
      consumerDir,
      distDir,
      destScenarioDir,
      buildDurationMs: buildDuration,
      inventory,
    };
    console.log(`✓ Staged \x27${theme.id}\x27 to ${destScenarioDir} (${inventory.fileCount} files, ${inventory.totalBytes} bytes)`);
  }

  // 7. Playwright Headless Browser Assertions inside Real Sandboxed Iframe (Opaque Origin)
  const browserResults = {
    chromiumVersion: null,
    externalRequestsRejected: 0,
    opaqueOriginVerified: true,
    parentAccessDenied: options.skipBrowser ? null : true,
    hostAccessDenied: options.skipBrowser ? null : true,
    cssHostIsolated: options.skipBrowser ? null : true,
    cspEnforced: true,
    scenarios: {},
  };

  if (!options.skipBrowser) {
    const qualFile = resolve(__dirname, "gallery-browser-qualification.mjs");
    if (!existsSync(qualFile)) {
      throw new Error(
        "Playwright browser qualification requires @playwright/test and gallery-browser-qualification.mjs (internal private tooling). Run with --skip-browser."
      );
    }
    try {
      const { runGalleryBrowserAssertions } = await import(pathToFileURL(qualFile).href);
      await runGalleryBrowserAssertions({
        options,
        themeDefinitions,
        builtScenarios,
        browserResults,
        startStaticServer,
        evidenceDir,
        GALLERY_SCENARIOS,
        loom,
      });
    } catch (err) {
      if (err && (err.code === "ERR_MODULE_NOT_FOUND" || err.message?.includes("Cannot find package '@playwright/test'") || err.message?.includes("Playwright browser qualification requires"))) {
        throw new Error(
          "Playwright browser qualification requires @playwright/test. Install @playwright/test or run with --skip-browser."
        );
      }
      throw err;
    }
  }

  // 8. Generate Public-Safe Gallery Manifest
  console.log("\n--- Step 6: Writing gallery manifest and receipts ---");
  let totalGalleryBytes = 0;
  let totalGalleryFiles = 0;
  const manifestScenarios = {};

  for (const theme of themeDefinitions) {
    const sc = builtScenarios[theme.id];
    if (!sc) continue;
    totalGalleryBytes += sc.inventory.totalBytes;
    totalGalleryFiles += sc.inventory.fileCount;

    manifestScenarios[theme.id] = {
      id: theme.id,
      name: theme.packageName,
      basePath: `/preview/gallery/${theme.id}/`,
      entryPath: GALLERY_SCENARIOS[theme.id].entryPath,
      previewUrl: GALLERY_SCENARIOS[theme.id].previewUrl,
      fileCount: sc.inventory.fileCount,
      totalBytes: sc.inventory.totalBytes,
      assetInventory: sc.inventory.files,
      assetInventoryDigest: sha256(JSON.stringify(sc.inventory.files)),
      canonicalThemeInputDigest: generatedTarballs[theme.id].themeInputDigest,
      representedProperties: GALLERY_SCENARIOS[theme.id].structuralConfig,
      preparedHeroData: theme.spec.catalog.hero.routes,
      unrepresentedProperties: GALLERY_COVERAGE.notRepresented,
      bridgeScriptSha256: sha256(generateBridgeScript(theme.id)),
      descriptor: generatedTarballs[theme.id].descriptor,
      selectedAccent: generatedTarballs[theme.id].selectedAccent,
      generatedInventory: generatedTarballs[theme.id].generatedInventory,
      generatedInventoryDigest: generatedTarballs[theme.id].generatedInventoryDigest,
      packageTarball: {
        filename: generatedTarballs[theme.id].filename,
        size: generatedTarballs[theme.id].size,
        sha256: generatedTarballs[theme.id].sha256,
      },
    };
  }

  if (!options.skipBrowser && browserResults.externalRequestsRejected !== 0) throw new Error("External runtime request observed");

  const manifest = {
    schema: "tfsb.gallery-manifest-v1",
    loomCandidate: {
      name: "@knowledge-forge-ai/theme-forge-stellar-loom",
      version: loomPkg.version,
      sha256: actualTarballSha256,
      size: tarballBytes.length,
    },
    coverage: {
      ...GALLERY_COVERAGE,
      loomArchiveDigest: actualTarballSha256,
    },
    bridgeContract: BRIDGE_CONTRACT,
    totalBytes: totalGalleryBytes,
    totalFiles: totalGalleryFiles,
    externalRequestsRejected: browserResults.externalRequestsRejected,
    verificationStatus: options.skipBrowser ? "built-not-browser-qualified" : "installed-build-and-sandbox-observed",
    fixtureLockDigest: EXPECTED_CONSUMER_LOCK_DIGEST,
    fixtureSourceInventory: (await computeDirectoryInventory(resolve(studioRoot, "gallery/fixtures/consumer"))).files,
    fixturePackages: { astro: "7.3.1", starlight: "0.42.0" },
    sandboxSecurity: {
      sandboxPolicy: "allow-scripts",
      opaqueOriginEnforced: options.skipBrowser ? null : true,
      noSameOrigin: true,
      parentAccessDenied: options.skipBrowser ? null : true,
      hostAccessDenied: options.skipBrowser ? null : true,
      cssHostIsolated: options.skipBrowser ? null : true,
      harnessOnlyCspPolicy: GALLERY_CSP_POLICY,
      effectiveTauriCsp: "requires separate native execution receipt",
      allowedKeys: GALLERY_BRIDGE_ALLOWED_KEYS,
      cssByteCeiling: GALLERY_BRIDGE_CSS_BYTE_CEILING,
      echoAckKeys: BRIDGE_CONTRACT.ackKeys,
    },
    limitations: {
      readOnlyStructuralConfig: true,
      pairedRepresentativeScenarios: true,
      representativeNotice: "The 4 prebuilt scenarios are paired representative configurations covering structural dimensions without Cartesian explosion. No arbitrary-combination runtime parity is claimed; arbitrary permutations require an installed consumer build.",
      fixedHeroContent: true,
      heroNotice: "Hero routes and content are fixed static prebuilt Starlight pages; runtime hero synthesis is omitted to faithfully reflect static Astro/Starlight structure.",
      editedSyntaxRulesPreviewed: false,
      syntaxNotice: "Edited syntax rules are not previewed in the static prebuilt gallery. Prototype testing proved Expressive Code default contrast divergence; full syntax qualification requires installed consumer build.",
      arbitraryCustomFontsPreviewed: false,
      fontNotice: "Only system fonts and licensed package-local Source Code Pro font are previewed. Arbitrary font uploads are not supported dynamically.",
      runtimeZeroBuildsOrInstalls: true,
    },
  };

  await mkdir(dirname(options.manifestPath), { recursive: true });
  await writeFile(options.manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`✓ Wrote gallery manifest to ${options.manifestPath}`);

  // 9. Write full evidence receipt to shared scratch
  const fullReceipt = {
    ...manifest,
    scratchRoot: options.scratchRoot,
    generatedTarballs,
    builtScenarios: Object.fromEntries(
      Object.entries(builtScenarios).map(([k, v]) => [
        k,
        {
          id: v.id,
          buildDurationMs: v.buildDurationMs,
          inventorySummary: { fileCount: v.inventory.fileCount, totalBytes: v.inventory.totalBytes },
        },
      ])
    ),
    browserObservations: browserResults,
  };

  const receiptPath = join(options.scratchRoot, "receipt.json");
  await writeFile(receiptPath, JSON.stringify(fullReceipt, null, 2) + "\n", "utf8");
  console.log(`✓ Wrote full evidence receipt to ${receiptPath}`);

  console.log("\n=======================================================");
  console.log("TFSB63B Gallery Preparation Completed Successfully!");
  console.log(`Total Scenarios Prepared: ${Object.keys(manifestScenarios).length}`);
  console.log(`Total Gallery Files: ${totalGalleryFiles}`);
  console.log(`Total Gallery Bundle Size: ${(totalGalleryBytes / (1024 * 1024)).toFixed(2)} MB (${totalGalleryBytes} bytes)`);
  console.log(`External Network Requests Rejected: ${browserResults.externalRequestsRejected}`);
  console.log("=======================================================\n");

  return fullReceipt;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const expectedSha256 = process.env.EXPECTED_LOOM_SHA256 || null;
  prepareGallery({ expectedSha256 }).catch((err) => {
    console.error("Gallery preparation failed with error:", err);
    process.exit(1);
  });
}

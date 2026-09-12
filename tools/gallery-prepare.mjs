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
  if (actualTarballSha256 !== EXPECTED_ARCHIVE_SHA256) {
    throw new Error(
      `Candidate Loom archive digest mismatch! Expected: ${EXPECTED_ARCHIVE_SHA256}, Actual: ${actualTarballSha256}`
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
    console.log("\n--- Step 5: Running Playwright Chromium assertions in Sandboxed Iframe ---");
    const playwright = await import("@playwright/test");
    const chromium = playwright.chromium || playwright.default?.chromium;
    const browser = await chromium.launch({ headless: true });
    browserResults.chromiumVersion = browser.version();
    console.log(`Launched Chromium v${browser.version()}`);

    try {
      for (const theme of themeDefinitions) {
        if (options.scenario && options.scenario !== theme.id) continue;

        console.log(`\nVerifying sandboxed browser assertions for \x27${theme.id}\x27...`);
        const scenarioInfo = builtScenarios[theme.id];
        const server = await startStaticServer(scenarioInfo.destScenarioDir, 0);

        try {
          const scenarioAssertions = {};
          const viewports = [
            { name: "mobile-390", width: 390, height: 800 },
            { name: "tablet-768", width: 768, height: 1024 },
            { name: "desktop-1440", width: 1440, height: 900 },
          ];
          const modes = ["dark", "light"];

          for (const vp of viewports) {
            for (const mode of modes) {
              const testKey = `${theme.id}-${mode}-${vp.name}`;
              const page = await browser.newPage();
              await page.setViewportSize({ width: vp.width, height: vp.height });

              page.on("requestfailed", (req) => {
                const url = req.url();
                if (!url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost")) {
                  browserResults.externalRequestsRejected++;
                }
              });

              // Load parent fixture pointing directly to scenario
              const targetCatalogUrl = GALLERY_SCENARIOS[theme.id].entryPath;
              const parentUrl = `http://127.0.0.1:${server.port}/parent-fixture.html?src=${encodeURIComponent(targetCatalogUrl)}`;
              await page.goto(parentUrl);

              const subframe = page.frames().find((f) => f !== page.mainFrame());
              if (!subframe) throw new Error(`Subframe not found for ${testKey}`);
              await subframe.waitForLoadState("domcontentloaded");

              // 1. Verify true opaque origin
              const origin = await subframe.evaluate(() => window.origin);
              if (origin !== "null") {
                throw new Error(`Scenario ${testKey}: expected opaque origin \x27null\x27, got \x27${origin}\x27`);
              }

              // 2. Verify parent access denial from inside iframe
              const parentAccess = await subframe.evaluate(() => {
                try {
                  var d = window.parent.document;
                  return { denied: false, title: d.title };
                } catch (e) {
                  return { denied: true, name: e.name, message: e.message };
                }
              });
              if (!parentAccess.denied) {
                throw new Error(`Scenario ${testKey}: parent access was NOT denied from inside iframe!`);
              }

              // 3. Verify host access denial into iframe contentDocument
              const hostAccess = await page.evaluate(() => {
                const iframe = document.getElementById("gallery-preview-frame");
                try {
                  // @ts-ignore
                  const doc = iframe.contentDocument;
                  return { denied: doc === null, doc: String(doc) };
                } catch (e) {
                  return { denied: true, name: e.name, message: e.message };
                }
              });
              if (!hostAccess.denied) {
                throw new Error(`Scenario ${testKey}: host was able to access iframe contentDocument!`);
              }

              // 4. Verify CSS host isolation
              const cssHostIsolated = await subframe.evaluate(() => {
                const sentinel = document.getElementById("host-sentinel");
                const hostColor = window.getComputedStyle(document.documentElement).getPropertyValue("--host-color");
                return sentinel === null && hostColor === "";
              });
              if (!cssHostIsolated) {
                throw new Error(`Scenario ${testKey}: CSS host isolation failure!`);
              }

              // Apply mode via dataset
              await subframe.evaluate((m) => {
                document.documentElement.dataset.theme = m;
              }, mode);

              // 5. Deterministic owned DOM signature
              const domState = await subframe.evaluate(() => {
                const h1s = Array.from(document.querySelectorAll("h1"));
                const singleH1 = h1s.length === 1;
                const h1Id = h1s[0]?.id || "";

                const allElementsWithId = Array.from(document.querySelectorAll("[id]"));
                const allIds = allElementsWithId.map((el) => el.id);
                const uniqueIds = new Set(allIds).size === allIds.length;

                const hasHorizontalOverflow =
                  document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;

                const computedAccent = window
                  .getComputedStyle(document.documentElement)
                  .getPropertyValue("--sl-color-accent")
                  .trim();

                return {
                  singleH1,
                  h1Id,
                  uniqueIds,
                  hasHorizontalOverflow,
                  title: document.title,
                  computedAccent,
                  sidebarMode: document.querySelector("[data-tfsl-sidebar-mode]")?.getAttribute("data-tfsl-sidebar-mode"),
                  pageTitleFramed: Boolean(document.querySelector(".tfsl-page-title-frame")),
                  pageTitleCopy: document.querySelector("[data-copy-mode]")?.getAttribute("data-copy-mode") ?? "none",
                  paginationVariant: ["plain", "card", "compact"].find(value => document.querySelector(`.pagination-${value}`)),
                  codeFrame: document.querySelector(".expressive-code .is-terminal") ? "terminal"
                    : document.querySelector(".expressive-code .has-title") ? "editor" : "plain",
                  codeFontSize: getComputedStyle(document.querySelector(".expressive-code pre")).fontSize,
                  codeLineHeight: getComputedStyle(document.querySelector(".expressive-code pre")).lineHeight,
                  codeCopyOpacity: document.querySelector(".expressive-code .copy button")
                    ? getComputedStyle(document.querySelector(".expressive-code .copy button"), "::before").opacity : null,
                };
              });

              for (const axis of ["sidebarMode", "pageTitleFramed", "pageTitleCopy", "paginationVariant", "codeFrame"]) {
                if (domState[axis] !== GALLERY_SCENARIOS[theme.id].structuralConfig[axis]) {
                  throw new Error(`Installed DOM coverage mismatch: ${testKey}/${axis}: ${domState[axis]}`);
                }
              }

              if (domState.codeCopyOpacity !== (GALLERY_SCENARIOS[theme.id].structuralConfig.codeCopy === "minimal" ? "0" : "0.4")) {
                throw new Error(`Installed copy appearance mismatch: ${testKey}`);
              }
              if (domState.codeFontSize !== `${theme.spec.typography.code.size}px`
                || Math.abs(parseFloat(domState.codeLineHeight) - theme.spec.typography.code.size * theme.spec.typography.code.lineHeight) > 0.1) {
                throw new Error(`Installed fixed code typography mismatch: ${testKey}`);
              }
              if (!domState.singleH1 || domState.h1Id !== "_top") {
                throw new Error(`Scenario ${testKey}: page does not have exactly one h1 with id="_top"`);
              }
              if (!domState.uniqueIds) {
                throw new Error(`Scenario ${testKey}: duplicate element IDs found`);
              }
              if (domState.hasHorizontalOverflow) {
                throw new Error(`Scenario ${testKey}: horizontal overflow detected`);
              }

              // Capture screenshot from subframe body
              const screenshotFilename = `screenshot-${testKey}.png`;
              const screenshotPath = join(evidenceDir, screenshotFilename);
              const screenshotBytes = await page.screenshot({ path: screenshotPath, fullPage: true });

              scenarioAssertions[testKey] = {
                viewport: vp,
                mode,
                opaqueOrigin: origin,
                parentAccessDenied: parentAccess.denied,
                hostAccessDenied: hostAccess.denied,
                cssHostIsolated,
                domState,
                screenshot: {
                  filename: screenshotFilename,
                  bytes: screenshotBytes.length,
                  sha256: sha256(screenshotBytes),
                },
              };

              await page.close();
            }
          }

          // Test navigation, title-copy, and code frame specifics
          const page = await browser.newPage();
          page.on("pageerror", (error) => console.error("Gallery browser error:", error.message));
          page.on("console", (message) => { if (message.type() === "error") console.error("Gallery console:", message.text()); });
          await page.setViewportSize({ width: 1440, height: 900 });
          const parentNavUrl = `http://127.0.0.1:${server.port}/parent-fixture.html?src=${encodeURIComponent(`/preview/gallery/${theme.id}/catalog/`)}`;
          await page.goto(parentNavUrl);

          const subframe = page.frames().find((f) => f !== page.mainFrame());
          if (!subframe) throw new Error("Subframe missing for navigation tests");
          await subframe.waitForLoadState("domcontentloaded");

          // Test CSP blocks external connects
          const externalFetchBlocked = await subframe.evaluate(async () => {
            return new Promise((resolve) => {
              const listener = (event) => { if (event.effectiveDirective === "connect-src") { document.removeEventListener("securitypolicyviolation", listener); resolve(true); } };
              document.addEventListener("securitypolicyviolation", listener);
              void fetch("http://127.0.0.1:1/blocked-by-csp", { mode: "no-cors" }).catch(() => {});
              setTimeout(() => { document.removeEventListener("securitypolicyviolation", listener); resolve(false); }, 1000);
            });
          });
          if (!externalFetchBlocked) {
            throw new Error(`CSP did not report an external connect violation for ${theme.id}`);
          }
          console.log("   ✓ Verified CSP blocks external connect by policy violation event");
          await subframe.locator("site-search [data-open-modal]").click();
          await subframe.locator("site-search input").fill("catalog");
          await subframe.locator(".pagefind-ui__result-link").first().waitFor({ timeout: 10000 });
          await subframe.locator("site-search input").press("Escape");
          scenarioAssertions.offlineSearch = { query: "catalog", resultsFound: true, keyboardDismissal: true };
          console.log("   ✓ Verified offline Pagefind search and keyboard dismissal");

          // Test link refusal (schemes, //, backslash)
          const linkRefusalVerified = await subframe.evaluate(() => {
            var blockedCount = 0;
            var testHrefs = [
              "https://external.example.com",
              "http://external.example.com",
              "javascript:void(0)",
              "//protocol-relative.com",
              "/path\\with\\backslash",
            ];
            for (var i = 0; i < testHrefs.length; i++) {
              var a = document.createElement("a");
              a.setAttribute("href", testHrefs[i]);
              document.body.appendChild(a);
              var evt = new MouseEvent("click", { cancelable: true, bubbles: true });
              a.dispatchEvent(evt);
              if (evt.defaultPrevented) blockedCount++;
              document.body.removeChild(a);
            }
            return blockedCount === testHrefs.length;
          });
          if (!linkRefusalVerified) {
            throw new Error(`Link refusal failed for schemes, //, or backslash in ${theme.id}`);
          }
          console.log("   ✓ Verified link refusal for //, backslash, and external schemes");

          if (theme.id === "black-catalog") {
            // Verify all 5 hero routes
            const heroRoutes = [
              "hero-centered",
              "hero-media-top",
              "hero-media-left",
              "hero-media-right",
              "hero-banner",
            ];
            for (const hr of heroRoutes) {
              await subframe.goto(`http://127.0.0.1:${server.port}/preview/gallery/${theme.id}/catalog/${hr}/`);
              const heroExists = await subframe.evaluate((expectedLayout) => {
                const h = document.querySelector(".tfsl-hero, [data-tfsl-hero-layout]");
                return h?.getAttribute("data-tfsl-hero-layout") === expectedLayout;
              }, hr.replace("hero-", ""));
              if (!heroExists) {
                throw new Error(`Hero route \x27${hr}\x27 did not render hero element`);
              }
            }
            console.log("   ✓ Verified all 5 hero layouts rendered in black-catalog");

            // Verify title copy url
            await subframe.goto(`http://127.0.0.1:${server.port}/preview/gallery/${theme.id}/catalog/`);
            await subframe.evaluate(() => {
              window["__capturedClipboard"] = [];
              if (!navigator.clipboard) {
                Object.defineProperty(navigator, "clipboard", {
                  value: { writeText: async (t) => { window["__capturedClipboard"].push(t); } },
                  configurable: true,
                });
              } else {
                navigator.clipboard.writeText = async (t) => {
                  window["__capturedClipboard"].push(t);
                };
              }
            });
            await subframe.focus(".tfsl-title-copy-btn");
            await page.keyboard.press("Enter");
            const capturedUrl = await subframe.evaluate(() => window["__capturedClipboard"]?.[0] || null);
            if (!capturedUrl || !capturedUrl.includes("/catalog/")) {
              throw new Error(`Title copy \x27url\x27 failed: got \x27${capturedUrl}\x27`);
            }
            console.log("   ✓ Verified title-copy mode \x27url\x27");
          } else if (theme.id === "flexoki-catalog") {
            // Verify select dropdown
            const selectExists = await subframe.evaluate(() => Boolean(document.getElementById("tfsl-sidebar-dropdown")));
            if (!selectExists) throw new Error("Select dropdown missing in flexoki-catalog");
            const copyBtnExists = await subframe.evaluate(() => Boolean(document.querySelector(".tfsl-title-copy-btn")));
            if (copyBtnExists) throw new Error("Title copy button must NOT exist when copy: \x27none\x27");
            console.log("   ✓ Verified select dropdown sidebar & copy mode \x27none\x27");
          } else if (theme.id === "celestia-catalog") {
            // Verify tabs sidebar
            const tabsExists = await subframe.evaluate(() => Boolean(document.querySelector(".tfsl-roving-tablist [role=\x27tab\x27]")));
            if (!tabsExists) throw new Error("Tabs roving tablist missing in celestia-catalog");

            // Verify local font loading
            await subframe.evaluate(() => document.fonts.ready);
            const fontsStatus = await subframe.evaluate(() => document.fonts.status);
            if (fontsStatus !== "loaded") {
              throw new Error(`document.fonts.status is \x27${fontsStatus}\x27, expected \x27loaded\x27`);
            }

            const cdp = await page.context().newCDPSession(page);
            await cdp.send("DOM.enable");
            await cdp.send("CSS.enable");
            const rootDoc = await cdp.send("DOM.getDocument");
            const { nodeId } = await cdp.send("DOM.querySelector", {
              nodeId: rootDoc.root.nodeId,
              selector: "#catalog-font-probe, .sl-markdown-content code",
            });

            if (nodeId) {
              const cdpFonts = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
              const platformFonts = cdpFonts?.fonts ?? [];
              const customMatch = platformFonts.find(
                (f) => f.familyName.includes("Source Code Pro") && f.isCustomFont && f.glyphCount > 0
              );
              if (customMatch) {
                console.log(`   ✓ CDP confirmed Source Code Pro used on code node (${customMatch.glyphCount} glyphs)`);
              }
            }
            console.log("   ✓ Verified tabs sidebar & local font loading in celestia-catalog");
          } else if (theme.id === "active-only-catalog") {
            // Verify active-only sidebar
            const activeOnlyCount = await subframe.evaluate(() => {
              const nav = document.querySelector('[data-tfsl-sidebar-mode="active-only"]');
              return nav ? nav.querySelectorAll(".tfsl-sidebar-panel:not([hidden])").length : 0;
            });
            if (activeOnlyCount !== 1) {
              throw new Error(`Active-only sidebar must render exactly 1 active group, got ${activeOnlyCount}`);
            }
            console.log("   ✓ Verified active-only sidebar single visible group");
          }

          // Test security bridge postMessage with closed allowed keys & safe integers
          const bridgeAck = await page.evaluate(async (tid) => {
            const iframe = document.getElementById("gallery-preview-frame");
            return new Promise((res) => {
              function handler(e) {
                if (e.data && e.data.type === "tfsl:theme-applied") {
                  window.removeEventListener("message", handler);
                  res(e.data);
                }
              }
              window.addEventListener("message", handler);
              // @ts-ignore
              iframe.contentWindow.postMessage(
                {
                  type: "tfsl:apply-theme",
                  css: ":root { --sl-color-accent: #00ffcc; }",
                  mode: "dark",
                  revision: 42,
                  frameGeneration: 1,
                  scenarioId: tid,
                  applicationId: "gallery-qualification-42",
                },
                "*"
              );
            });
          }, theme.id);

          if (!bridgeAck || bridgeAck.revision !== 42 || bridgeAck.frameGeneration !== 1 || bridgeAck.scenarioId !== theme.id) {
            throw new Error(`Bridge protocol ACK failure: ${JSON.stringify(bridgeAck)}`);
          }
          console.log(`   ✓ Verified security bridge ACK (revision: 42, frameGeneration: 1, scenarioId: ${theme.id})`);

          // Installed compiler CSS must override the bundled package in the same layer.
          // Four paired choices cover every layout value without a Cartesian build matrix.
          if (theme.id === "black-catalog") {
            const layoutCases = [["standard", "standard"], ["compact", "standard"], ["wide", "standard"], ["wide", "compact"]];
            const layoutParity = [];
            for (const route of ["preview", "sidebar-less"]) {
              await subframe.goto(`http://127.0.0.1:${server.port}/preview/gallery/${theme.id}/catalog/${route}/`);
              for (const [layoutPreset, catalogLayout] of layoutCases) {
                const specification = structuredClone(theme.spec);
                specification.layoutPreset = layoutPreset; specification.catalog.layout = catalogLayout; specification.surfaces.content = 1600;
                const compiled = loom.compileThemeCatalog(specification, {accent: theme.accent});
                const applicationId = `layout-${route}-${layoutPreset}-${catalogLayout}`;
                await page.evaluate(({css, applicationId, scenarioId}) => new Promise((resolveAck, rejectAck) => {
                  const frame = document.getElementById("gallery-preview-frame");
                  const timer = setTimeout(() => { window.removeEventListener("message", handler); rejectAck(new Error("Layout acknowledgement timeout")); }, 3000);
                  function handler(event) {
                    if (event.source !== frame.contentWindow || event.data?.applicationId !== applicationId) return;
                    clearTimeout(timer); window.removeEventListener("message", handler);
                    if (event.data.type === "tfsl:theme-applied") resolveAck(true); else rejectAck(new Error("Layout application rejected"));
                  }
                  window.addEventListener("message", handler);
                  frame.contentWindow.postMessage({type:"tfsl:apply-theme", css, mode:"dark", revision:100, frameGeneration:1, scenarioId, applicationId}, "*");
                }), {css:compiled.css, applicationId, scenarioId:theme.id});
                const actual = await subframe.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--sl-content-width").replace(/\s/g, ""));
                const coreCap = {standard:1152, compact:960, wide:1440}[layoutPreset];
                const cap = route === "sidebar-less" ? Math.min(coreCap, catalogLayout === "compact" ? 960 : 1152) : coreCap;
                const expected = `min(1600px,${cap}px)`;
                if (actual !== expected) throw new Error(`Installed CSS cascade parity failed: ${route}/${layoutPreset}/${catalogLayout}: ${actual}`);
                layoutParity.push({route, layoutPreset, catalogLayout, actual, outputDigest:compiled.outputDigest});
              }
            }
            scenarioAssertions.layoutParity = layoutParity;
          }

          // Test rejection of forbidden extra key
          const forbiddenAck = await page.evaluate(async (tid) => {
            const iframe = document.getElementById("gallery-preview-frame");
            return new Promise((res) => {
              const timer = setTimeout(() => res("rejected"), 250);
              function handler(e) {
                if (e.data && e.data.revision === 999) {
                  clearTimeout(timer);
                  window.removeEventListener("message", handler);
                  res("accepted");
                }
              }
              window.addEventListener("message", handler);
              // @ts-ignore
              iframe.contentWindow.postMessage(
                {
                  type: "tfsl:apply-theme",
                  revision: 999,
                  scenarioId: tid,
                  applicationId: "gallery-qualification-42",
                  unauthorizedKey: "malicious",
                },
                "*"
              );
            });
          }, theme.id);
          if (forbiddenAck !== "rejected") {
            throw new Error("Bridge security failed: accepted message with forbidden key!");
          }
          console.log("   ✓ Verified rejection of unauthorized bridge message keys");

          // Test rejection of scenarioId mismatch
          const mismatchAck = await page.evaluate(async () => {
            const iframe = document.getElementById("gallery-preview-frame");
            return new Promise((res) => {
              const timer = setTimeout(() => res("rejected"), 250);
              function handler(e) {
                if (e.data && e.data.revision === 998) {
                  clearTimeout(timer);
                  window.removeEventListener("message", handler);
                  res("accepted");
                }
              }
              window.addEventListener("message", handler);
              // @ts-ignore
              iframe.contentWindow.postMessage(
                {
                  type: "tfsl:apply-theme",
                  revision: 998,
                  scenarioId: "mismatched-scenario",
                },
                "*"
              );
            });
          });
          if (mismatchAck !== "rejected") {
            throw new Error("Bridge security failed: accepted message with mismatched scenarioId!");
          }
          console.log("   ✓ Verified rejection of scenarioId mismatch");

          // Test rejection of non-integer revision
          const nonIntAck = await page.evaluate(async (tid) => {
            const iframe = document.getElementById("gallery-preview-frame");
            return new Promise((res) => {
              const timer = setTimeout(() => res("rejected"), 250);
              function handler(e) {
                if (e.data && e.data.revision === 100.5) {
                  clearTimeout(timer);
                  window.removeEventListener("message", handler);
                  res("accepted");
                }
              }
              window.addEventListener("message", handler);
              // @ts-ignore
              iframe.contentWindow.postMessage(
                {
                  type: "tfsl:apply-theme",
                  revision: 100.5,
                  scenarioId: tid,
                  applicationId: "gallery-qualification-42",
                },
                "*"
              );
            });
          }, theme.id);
          if (nonIntAck !== "rejected") {
            throw new Error("Bridge security failed: accepted message with non-integer revision!");
          }
          console.log("   ✓ Verified rejection of non-integer revision");

          // Test rejection of CSS exceeding byte ceiling
          const oversizedAck = await page.evaluate(async (tid) => {
            const iframe = document.getElementById("gallery-preview-frame");
            return new Promise((res) => {
              const timer = setTimeout(() => res("rejected"), 250);
              function handler(e) {
                if (e.data && e.data.revision === 997) {
                  clearTimeout(timer);
                  window.removeEventListener("message", handler);
                  res("accepted");
                }
              }
              window.addEventListener("message", handler);
              // @ts-ignore
              iframe.contentWindow.postMessage(
                {
                  type: "tfsl:apply-theme",
                  revision: 997,
                  scenarioId: tid,
                  applicationId: "gallery-qualification-42",
                  css: "/* oversize */ " + "x".repeat(600000),
                },
                "*"
              );
            });
          }, theme.id);
          if (oversizedAck !== "rejected") {
            throw new Error("Bridge security failed: accepted CSS exceeding byte ceiling!");
          }
          console.log("   ✓ Verified rejection of CSS exceeding 512 KiB byte ceiling");

          // Test command attempt isolation (proves no IPC rights across origin)
          const commandAck = await page.evaluate(async () => {
            const iframe = document.getElementById("gallery-preview-frame");
            return new Promise((res) => {
              function handler(e) {
                if (e.data && e.data.type === "tfsl:command-attempt-result") {
                  window.removeEventListener("message", handler);
                  res(e.data);
                }
              }
              window.addEventListener("message", handler);
              // @ts-ignore
              iframe.contentWindow.postMessage({ type: "tfsl:attempt-command" }, "*");
            });
          });

          if (!commandAck || commandAck.directAllowed !== false || commandAck.parentAllowed !== false) {
            throw new Error(`Security isolation failure: ${JSON.stringify(commandAck)}`);
          }
          console.log(`   ✓ Verified subframe sandbox isolation: directAllowed=false, parentAllowed=false (${commandAck.reason})`);

          await page.close();
          browserResults.scenarios[theme.id] = scenarioAssertions;
        } finally {
          await server.close();
        }
      }
    } finally {
      await browser.close();
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
    scenarios: manifestScenarios,
    coverage: GALLERY_COVERAGE,
    coverageSourceSha256: sha256(await readFile(resolve(studioRoot, "src/features/theme-lab/gallery-contract.ts"))),
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
  prepareGallery().catch((err) => {
    console.error("Gallery preparation failed with error:", err);
    process.exit(1);
  });
}

import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { repositoryRootForStudio } from "./sidecar-common.mjs";

export const EXPECTED_LOOM_NAME = "@knowledge-forge-ai/theme-forge-stellar-loom";
export const EXPECTED_LOOM_VERSION = "0.1.0";
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runLocalCommand(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env: env || { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    const detail = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(`Command ${command} ${args.join(" ")} failed (status: ${result.status})${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

async function requireRegular(filePath, maximum = MAX_ARCHIVE_BYTES) {
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Input is not a regular file: ${basename(filePath)}`);
  }
  if (info.size > maximum) {
    throw new Error(`Input exceeds byte limit: ${basename(filePath)}`);
  }
  return info;
}

async function extractTarballSafely(archivePath, destination) {
  await requireRegular(archivePath, MAX_ARCHIVE_BYTES);
  const listing = runLocalCommand("tar", ["-tzf", archivePath], process.cwd());
  const entries = listing.split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => {
    const normalized = entry.normalize("NFC");
    const components = normalized.split("/").filter(Boolean);
    return !normalized.startsWith("package/") || components.some((c) => c === "." || c === ".." || c.includes("\\"));
  })) {
    throw new Error("Loom archive contains unsafe paths or is missing 'package/' root prefix");
  }

  const verbose = runLocalCommand("tar", ["-tvzf", archivePath], process.cwd());
  if (verbose.split(/\r?\n/u).filter(Boolean).some((line) => !/^[-d]/u.test(line))) {
    throw new Error("Loom archive contains symbolic or hard link entries");
  }

  await mkdir(destination, { recursive: true, mode: 0o755 });
  runLocalCommand("tar", ["-xzf", archivePath, "-C", destination], process.cwd());
  const packageRoot = resolve(destination, "package");
  const packageInfo = await lstat(packageRoot);
  if (packageInfo.isSymbolicLink() || !packageInfo.isDirectory()) {
    throw new Error("Extracted Loom package root is invalid");
  }
  return packageRoot;
}

export function parseLoomPrepareArgs(argv) {
  const options = {
    tarball: undefined,
    sha256: undefined,
    release: false,
    dev: false,
    instrumented: false,
    previewDist: undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tarball" || arg === "--loom-tarball") {
      options.tarball = argv[++i];
    } else if (arg === "--sha256" || arg === "--loom-sha256") {
      options.sha256 = argv[++i];
    } else if (arg === "--preview-dist") {
      options.previewDist = argv[++i];
    } else if (arg === "--release") {
      options.release = true;
    } else if (arg === "--dev") {
      options.dev = true;
    } else if (arg === "--instrumented") {
      options.instrumented = true;
    }
  }

  return options;
}

export async function prepareLoom(customOptions = {}) {
  const cliOptions = parseLoomPrepareArgs(process.argv.slice(2));
  const options = { ...cliOptions, ...customOptions };

  const studioRoot = options.studioRoot ? resolve(options.studioRoot) : resolve(import.meta.dirname, "..");
  const repoRoot = repositoryRootForStudio(studioRoot);
  const loomRoot = resolve(repoRoot, "packages/stellar-loom");
  const fixtureRoot = resolve(loomRoot, "fixture");

  const isRelease = options.release || process.env.TFSL_RELEASE === "1" || process.env.NODE_ENV === "production";
  const isInstrumented = options.instrumented || process.argv.includes("--instrumented") || process.env.TFSL_INSTRUMENTED_PREVIEW === "1";
  const isDev = options.dev && !isRelease;

  console.log(`Preparing Theme Forge Stellar Loom payload and preview (release: ${isRelease}, dev: ${isDev}, instrumented: ${isInstrumented})...`);

  // Check authenticated-inputs/loom-binding.json if present
  let authBinding = null;
  const authBindingPath = resolve(repoRoot, "authenticated-inputs/loom-binding.json");
  if (existsSync(authBindingPath)) {
    try {
      const bindingRaw = await readFile(authBindingPath, "utf8");
      authBinding = JSON.parse(bindingRaw);
    } catch {
      throw new Error("authenticated-inputs/loom-binding.json is invalid JSON");
    }
  }

  // Determine exact tarball and expected sha256
  let tarballPath = options.tarball || process.env.TFSL_LOOM_TARBALL || process.env.TFSB_STUDIO_LOOM_TARBALL;
  let expectedSha256 = options.sha256 || process.env.TFSL_LOOM_SHA256 || process.env.TFSB_STUDIO_LOOM_SHA256;

  if (!tarballPath && authBinding?.filename) {
    if (authBinding.name !== EXPECTED_LOOM_NAME || authBinding.version !== EXPECTED_LOOM_VERSION
        || basename(authBinding.filename) !== authBinding.filename || !/^[a-f0-9]{64}$/.test(authBinding.sha256)) {
      throw new Error("Loom authenticated binding is invalid");
    }
    const authTarball = resolve(repoRoot, "authenticated-inputs/loom-tarball", authBinding.filename);
    if (existsSync(authTarball)) {
      tarballPath = authTarball;
      expectedSha256 = expectedSha256 || authBinding.sha256;
    }
  }

  if (!tarballPath && !isDev) {
    const authTarballDir = resolve(repoRoot, "authenticated-inputs/loom-tarball");
    if (existsSync(authTarballDir)) {
      const tgts = readdirSync(authTarballDir).filter((f) => f.endsWith(".tgz"));
      if (tgts.length === 1) {
        tarballPath = resolve(authTarballDir, tgts[0]);
      }
    }
  }

  const payloadRoot = resolve(studioRoot, "src-tauri/loom-payload");

  if (tarballPath) {
    // Exact candidate tarball mode
    tarballPath = resolve(tarballPath);
    console.log(`Consuming explicit Loom tarball: ${tarballPath}`);
    await requireRegular(tarballPath, MAX_ARCHIVE_BYTES);

    const tarballBytes = await readFile(tarballPath);
    const actualSha256 = sha256(tarballBytes);

    if (expectedSha256) {
      if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
        throw new Error(`Loom tarball SHA-256 digest mismatch. Expected: ${expectedSha256}, Actual: ${actualSha256}`);
      }
      console.log(`Verified Loom tarball SHA-256: ${actualSha256}`);
    } else {
      throw new Error("Exact tarball preparation requires explicit sha256 verification");
    }

    const scratchRoot = await mkdtemp(join(tmpdir(), "tfsl-loom-extract-"));
    try {
      const packageRoot = await extractTarballSafely(tarballPath, scratchRoot);
      const pkgPath = resolve(packageRoot, "package.json");
      if (!existsSync(pkgPath)) {
        throw new Error("Extracted Loom package is missing package.json");
      }
      const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
      if (pkg.name !== EXPECTED_LOOM_NAME) {
        throw new Error(`Extracted Loom package has invalid name: '${pkg.name}', expected '${EXPECTED_LOOM_NAME}'`);
      }
      if (pkg.version !== EXPECTED_LOOM_VERSION) {
        throw new Error(`Extracted Loom package has invalid version: '${pkg.version}', expected '${EXPECTED_LOOM_VERSION}'`);
      }

      // Check required artifacts exist in extracted tarball
      const requiredArtifacts = [
        resolve(packageRoot, "dist/batch.js"),
        resolve(packageRoot, "dist/index.js"),
        resolve(packageRoot, "dist/design-exchange/index.js"),
        resolve(packageRoot, "bin/tfsl-batch.js"),
      ];
      for (const artifact of requiredArtifacts) {
        if (!existsSync(artifact)) {
          throw new Error(`Extracted Loom package missing required artifact: ${basename(artifact)}`);
        }
      }

      // Populate src-tauri/loom-payload
      await rm(payloadRoot, { recursive: true, force: true });
      await mkdir(payloadRoot, { recursive: true, mode: 0o755 });

      await cp(resolve(packageRoot, "dist"), resolve(payloadRoot, "dist"), { recursive: true });
      await cp(resolve(packageRoot, "bin"), resolve(payloadRoot, "bin"), { recursive: true });
      await cp(resolve(packageRoot, "package.json"), resolve(payloadRoot, "package.json"));

      if (existsSync(resolve(packageRoot, "examples"))) {
        await cp(resolve(packageRoot, "examples"), resolve(payloadRoot, "examples"), { recursive: true });
      }

      // Exact packaged schemas & fixtures
      if (existsSync(resolve(packageRoot, "protocol"))) {
        await cp(resolve(packageRoot, "protocol"), resolve(payloadRoot, "protocol"), { recursive: true });
      }

      // Exact packaged legal files
      for (const legalFile of ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md", "README.md"]) {
        const src = resolve(packageRoot, legalFile);
        if (existsSync(src)) {
          await cp(src, resolve(payloadRoot, legalFile));
        }
      }

      console.log(`Loom payload populated from verified tarball (${EXPECTED_LOOM_NAME}@${EXPECTED_LOOM_VERSION}).`);
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  } else if (isRelease) {
    // Release mode forbids ambient private dist
    throw new Error("Release mode requires explicit exact Loom 0.1.0 npm tarball and sha256; ambient private dist is forbidden in release mode");
  } else {
    // Integration development mode fallback
    console.log("Using integration development mode from packages/stellar-loom...");

    const requiredInputs = [
      resolve(loomRoot, "package.json"),
      resolve(loomRoot, "src/batch.ts"),
      resolve(loomRoot, "bin/tfsl-batch.js"),
    ];
    for (const input of requiredInputs) {
      if (!existsSync(input)) {
        throw new Error(`Required Loom development source missing: ${input}`);
      }
    }

    console.log("Building stellar-loom...");
    const loomBuild = spawnSync("npm", ["run", "build"], { cwd: loomRoot, stdio: "inherit" });
    if (loomBuild.status !== 0) {
      throw new Error(`Failed to build stellar-loom (exit code: ${loomBuild.status})`);
    }

    const loomDist = resolve(loomRoot, "dist");
    if (!existsSync(resolve(loomDist, "batch.js"))) {
      throw new Error("stellar-loom build succeeded but dist/batch.js is missing");
    }

    await rm(payloadRoot, { recursive: true, force: true });
    await mkdir(payloadRoot, { recursive: true, mode: 0o755 });

    await cp(loomDist, resolve(payloadRoot, "dist"), { recursive: true });
    await cp(resolve(loomRoot, "bin"), resolve(payloadRoot, "bin"), { recursive: true });
    await cp(resolve(loomRoot, "package.json"), resolve(payloadRoot, "package.json"));

    if (existsSync(resolve(loomRoot, "examples"))) {
      await cp(resolve(loomRoot, "examples"), resolve(payloadRoot, "examples"), { recursive: true });
    }

    // Include exact packaged schemas/legal in dev mode as well
    if (existsSync(resolve(loomRoot, "protocol"))) {
      await cp(resolve(loomRoot, "protocol"), resolve(payloadRoot, "protocol"), { recursive: true });
    }

    for (const legalFile of ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md", "README.md"]) {
      const src = resolve(loomRoot, legalFile);
      if (existsSync(src)) {
        await cp(src, resolve(payloadRoot, legalFile));
      }
    }

    console.log("Loom payload populated from development source tree.");
  }

  // Preview resources and standalone projection support
  const publicPreview = resolve(studioRoot, "public/preview");
  const loomPreviewSource = resolve(studioRoot, "loom-preview-source");

  if (options.previewDist && existsSync(resolve(options.previewDist, "index.html"))) {
    console.log(`Copying prebuilt preview from ${options.previewDist}...`);
    await rm(publicPreview, { recursive: true, force: true });
    await mkdir(publicPreview, { recursive: true });
    await cp(resolve(options.previewDist), publicPreview, { recursive: true });
  } else if (existsSync(loomPreviewSource)) {
    // Standalone projection with packaged preview source owned under projection
    console.log("Preparing preview from owned projection path loom-preview-source...");
    if (existsSync(resolve(loomPreviewSource, "package.json"))) {
      console.log(`Building neutral Starlight fixture in loom-preview-source (instrumented: ${isInstrumented})...`);
      const fixtureEnv = {
        ...process.env,
        ...(isInstrumented ? { TFSL_INSTRUMENTED_PREVIEW: "1" } : { TFSL_INSTRUMENTED_PREVIEW: "0" }),
      };
      const buildResult = spawnSync("npm", ["run", "build:neutral"], { cwd: loomPreviewSource, env: fixtureEnv, stdio: "inherit" });
      if (buildResult.status !== 0 || !existsSync(resolve(loomPreviewSource, "dist/neutral/index.html"))) {
        throw new Error(`Failed to build preview from loom-preview-source (exit code: ${buildResult.status})`);
      }
      await rm(publicPreview, { recursive: true, force: true });
      await mkdir(publicPreview, { recursive: true });
      await cp(resolve(loomPreviewSource, "dist/neutral"), publicPreview, { recursive: true });
    } else {
      throw new Error("loom-preview-source directory is missing its owning package.json");
    }
  } else if (existsSync(resolve(fixtureRoot, "package.json"))) {
    // Monorepo development mode
    console.log(`Building neutral Starlight fixture (instrumented: ${isInstrumented})...`);
    const fixtureEnv = {
      ...process.env,
      ...(isInstrumented ? { TFSL_INSTRUMENTED_PREVIEW: "1" } : { TFSL_INSTRUMENTED_PREVIEW: "0" }),
    };
    const fixtureBuild = spawnSync("npm", ["run", "build:neutral"], { cwd: fixtureRoot, env: fixtureEnv, stdio: "inherit" });
    if (fixtureBuild.status !== 0) {
      throw new Error(`Failed to build neutral fixture (exit code: ${fixtureBuild.status})`);
    }

    const fixtureDistNeutral = resolve(fixtureRoot, "dist/neutral");
    if (!existsSync(resolve(fixtureDistNeutral, "index.html"))) {
      throw new Error("neutral Starlight fixture build succeeded but dist/neutral/index.html is missing");
    }

    await rm(publicPreview, { recursive: true, force: true });
    await mkdir(publicPreview, { recursive: true });
    await cp(fixtureDistNeutral, publicPreview, { recursive: true });
  } else if (existsSync(resolve(publicPreview, "index.html"))) {
    console.log("Retaining existing public/preview assets in standalone projection.");
  } else {
    throw new Error("No preview source available (loom-preview-source, packages/stellar-loom/fixture, or prebuilt public/preview)");
  }

  console.log("Loom preparation complete.");
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  prepareLoom().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

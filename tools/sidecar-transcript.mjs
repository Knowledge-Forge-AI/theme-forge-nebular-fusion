import { repositoryRootForStudio } from "./sidecar-common.mjs";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateResult } from "../src-tauri/sidecar-payload/dist/service-protocol/v1-validate.js";

const MAX_FRAME_BYTES = 16_777_216;
const MAX_STDERR_BYTES = 1_048_576;
const RESPONSE_TIMEOUT_MS = 10_000;
const studioRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = repositoryRootForStudio(studioRoot);
const binary = join(studioRoot, "src-tauri/binaries/tfsb-studio-service-aarch64-apple-darwin");
const payload = join(studioRoot, "src-tauri/sidecar-payload");
const entrypoint = join(payload, "dist/service-protocol/server-cli.js");
const coreApi = await import(pathToFileURL(join(payload, "dist/index.js")).href);

const CAPABILITY_UNAVAILABLE = "METHOD_CAPABILITY_UNAVAILABLE";
const KNOWN_ERROR_CODES = new Set([
  "PARSE_ERROR", "INVALID_REQUEST", "METHOD_NOT_FOUND", "INVALID_PARAMS", "INTERNAL_ERROR",
  "INVALID_REQUEST_ID", "PROTOCOL_VERSION_UNSUPPORTED", "SESSION_NOT_INITIALIZED",
  "SESSION_NONCE_INVALID", "ROOT_INVALID", "ROOT_HANDLE_INVALID", CAPABILITY_UNAVAILABLE,
  "REQUEST_BUSY", "REQUEST_CANCELLED", "PLAN_TOKEN_INVALID", "PLAN_STALE",
  "PLAN_DIGEST_MISMATCH", "CURSOR_INVALID", "CURSOR_STALE", "DOMAIN_OPERATION_FAILED",
  "MESSAGE_TOO_LARGE",
]);

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function plainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) throw new Error(`${label} is not an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} shape is not exact`);
  }
}

function responseKey(id) {
  return `${typeof id}:${String(id)}`;
}

function assertResponseFrame(response, expectedId) {
  if (!plainObject(response) || response.jsonrpc !== "2.0" || !Object.hasOwn(response, "id")
      || !Object.is(response.id, expectedId)) {
    throw new Error("JSON-RPC response identity is invalid");
  }
  const hasResult = Object.hasOwn(response, "result");
  const hasError = Object.hasOwn(response, "error");
  if (hasResult === hasError) throw new Error("JSON-RPC response must contain one result or error");
  exactKeys(response, hasResult ? ["jsonrpc", "id", "result"] : ["jsonrpc", "id", "error"], "JSON-RPC response");
}

function assertErrorResponse(response, allowedCodes, label) {
  if (!Object.hasOwn(response, "error")) throw new Error(`${label} did not return an error`);
  const error = response.error;
  exactKeys(error, ["code", "message", "data"], `${label} error`);
  if (!Number.isInteger(error.code) || typeof error.message !== "string" || !plainObject(error.data)) {
    throw new Error(`${label} error fields are invalid`);
  }
  const dataKeys = Object.keys(error.data).sort();
  const expectedDataKeys = ["code", "message", "retryable"];
  if (dataKeys.length !== expectedDataKeys.length || dataKeys.some((key, index) => key !== expectedDataKeys[index])) {
    throw new Error(`${label} error data shape is invalid`);
  }
  const { code, message, retryable } = error.data;
  if (!KNOWN_ERROR_CODES.has(code) || !allowedCodes.has(code) || typeof message !== "string" || typeof retryable !== "boolean") {
    throw new Error(`${label} error code is not accepted`);
  }
  if (code === CAPABILITY_UNAVAILABLE && (error.code !== -32020 || retryable !== false)) {
    throw new Error(`${label} capability-unavailable error identity is invalid`);
  }
  return code;
}

function assertRendererDescriptor(capability) {
  exactKeys(capability, ["available", "adapterId", "rendererPackage", "rendererVersion", "rendererBuildDigest", "nodeMajor", "platformClaim", "qualificationId"], "raster capability");
  if (capability.available !== true || typeof capability.adapterId !== "string" || capability.adapterId.length === 0
      || typeof capability.rendererPackage !== "string" || capability.rendererPackage.length === 0
      || typeof capability.rendererVersion !== "string" || capability.rendererVersion.length === 0
      || !/^sha256:[0-9a-f]{64}$/u.test(capability.rendererBuildDigest)
      || !Number.isSafeInteger(capability.nodeMajor) || capability.nodeMajor < 1
      || typeof capability.platformClaim !== "string" || capability.platformClaim.length === 0
      || typeof capability.qualificationId !== "string" || capability.qualificationId.length === 0) {
    throw new Error("raster capability descriptor is not qualified by its observed shape");
  }
  return capability;
}

function summarizeCapability(capability) {
  const descriptor = assertRendererDescriptor(capability);
  return {
    available: descriptor.available,
    adapterId: descriptor.adapterId,
    rendererPackage: descriptor.rendererPackage,
    rendererVersion: descriptor.rendererVersion,
    rendererBuildDigest: descriptor.rendererBuildDigest,
    nodeMajor: descriptor.nodeMajor,
    platformClaim: descriptor.platformClaim,
    qualificationId: descriptor.qualificationId,
  };
}

function assertInitializeRaster(capabilities, descriptor) {
  if (!plainObject(capabilities) || !plainObject(capabilities.brand) || !plainObject(capabilities.brand.raster)) {
    throw new Error("initialize brand raster capability is missing");
  }
  const raster = capabilities.brand.raster;
  exactKeys(raster, ["available", "adapterId", "rendererVersion", "qualificationId", "platformClaim"], "initialize raster capability");
  if (raster.available !== true || raster.adapterId !== descriptor.adapterId
      || raster.rendererVersion !== descriptor.rendererVersion
      || raster.qualificationId !== descriptor.qualificationId
      || raster.platformClaim !== descriptor.platformClaim) {
    throw new Error("initialize raster capability does not match the observed descriptor");
  }
}

function summarizeVisualEvidence(result, descriptor) {
  if (result.renderer.id !== descriptor.adapterId || result.renderer.version !== descriptor.rendererVersion
      || result.renderer.qualificationId !== descriptor.qualificationId || result.renderer.platformClaim !== descriptor.platformClaim) {
    throw new Error("visual evidence renderer does not match the observed descriptor");
  }
  return {
    kind: result.kind,
    projectDigest: result.projectDigest,
    brandSystemDigest: result.brandSystemDigest,
    ...(result.sourceDigest === undefined ? {} : { sourceDigest: result.sourceDigest }),
    ...(result.qaDigest === undefined ? {} : { qaDigest: result.qaDigest }),
    target: result.target,
    configuration: result.configuration,
    renderer: result.renderer,
    artifacts: result.artifacts.map((artifact) => ({
      role: artifact.role,
      mediaType: artifact.mediaType,
      encoding: artifact.encoding,
      width: artifact.width,
      height: artifact.height,
      byteLength: artifact.byteLength,
      pngDigest: artifact.pngDigest,
      decodedPixelDigest: artifact.decodedPixelDigest,
    })),
    ...(result.difference === undefined ? {} : { difference: result.difference }),
    evidenceDigest: result.evidenceDigest,
  };
}

function summarizeQaPage(result) {
  return {
    page: {
      size: result.page.size,
      count: result.page.count,
      items: result.page.items,
    },
    viewDigest: result.viewDigest,
  };
}

function client() {
  const child = spawn(binary, [entrypoint], {
    cwd: payload,
    env: { LANG: "C", LC_ALL: "C", TZ: "UTC", TMPDIR: tmpdir() },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffered = Buffer.alloc(0);
  let failed;
  let exitInfo;
  let closeInfo;
  let stderrBytes = 0;
  const stderrHash = createHash("sha256");
  const pending = new Map();
  const closePromise = new Promise((resolveClose) => {
    child.once("close", (code, signal) => {
      closeInfo = { code, signal };
      resolveClose(closeInfo);
      const error = failed ?? new Error("sidecar closed before all responses arrived");
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    });
  });

  const fail = (error) => {
    if (failed !== undefined) return;
    failed = error instanceof Error ? error : new Error("sidecar transcript failed");
    for (const waiter of pending.values()) waiter.reject(failed);
    pending.clear();
  };

  child.once("exit", (code, signal) => { exitInfo = { code, signal }; });
  child.once("error", () => fail(new Error("sidecar child process failed")));
  child.stdin.once("error", () => fail(new Error("sidecar input stream failed")));
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    stderrHash.update(chunk);
    if (stderrBytes > MAX_STDERR_BYTES) fail(new Error("sidecar stderr exceeded the bounded capture"));
  });
  child.stdout.on("data", (chunk) => {
    if (failed !== undefined) return;
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > MAX_FRAME_BYTES) {
      fail(new Error("transcript frame exceeded the protocol limit"));
      return;
    }
    for (;;) {
      const newline = buffered.indexOf(10);
      if (newline < 0) break;
      const frame = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      let message;
      try {
        message = JSON.parse(frame.toString("utf8"));
      }
      catch {
        fail(new Error("transcript response was not JSON"));
        return;
      }
      if (plainObject(message) && typeof message.method === "string") continue;
      if (!plainObject(message) || !Object.hasOwn(message, "id")) {
        fail(new Error("transcript response identity is missing"));
        return;
      }
      const waiter = pending.get(responseKey(message.id));
      if (waiter === undefined) {
        fail(new Error("unexpected transcript response"));
        return;
      }
      pending.delete(responseKey(message.id));
      try { assertResponseFrame(message, waiter.id); }
      catch (error) { fail(error); return; }
      waiter.resolve(message);
    }
  });

  const send = (message) => {
    if (failed !== undefined) throw failed;
    try { child.stdin.write(`${JSON.stringify(message)}\n`); }
    catch { fail(new Error("sidecar input write failed")); throw failed; }
  };
  const call = (message) => new Promise((resolveResponse, reject) => {
    if (!plainObject(message) || !Object.hasOwn(message, "id")) {
      reject(new Error("sidecar request identity is missing"));
      return;
    }
    const key = responseKey(message.id);
    let waiter;
    const timer = setTimeout(() => {
      if (pending.get(key) !== waiter) return;
      pending.delete(key);
      const error = new Error("sidecar transcript response timed out");
      fail(error);
      reject(error);
    }, RESPONSE_TIMEOUT_MS);
    waiter = {
      id: message.id,
      resolve: (value) => { clearTimeout(timer); resolveResponse(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    };
    pending.set(key, waiter);
    try { send(message); }
    catch (error) { pending.delete(key); clearTimeout(timer); reject(error); }
  });
  const notify = (message) => send(message);
  const endInput = () => { if (!child.stdin.destroyed) child.stdin.end(); };
  const finish = async ({ force = false } = {}) => {
    if (force && child.exitCode === null && child.signalCode === null) child.kill();
    const closed = closeInfo ?? await closePromise;
    if (exitInfo === undefined) throw new Error("sidecar exit event was not observed");
    return {
      exit: { code: exitInfo.code, signal: exitInfo.signal },
      close: { code: closed.code, signal: closed.signal },
      stderr: { byteLength: stderrBytes, sha256: `sha256:${stderrHash.digest("hex")}` },
    };
  };
  const successfulMethodCounts = new Map();
  const result = async (method, id, params) => {
    const response = await call({ jsonrpc: "2.0", id, method, params });
    if (Object.hasOwn(response, "error")) {
      assertErrorResponse(response, KNOWN_ERROR_CODES, method);
      throw new Error(`${method} returned ${response.error.data.code}`);
    }
    try { validateResult(method, response.result); }
    catch { throw new Error(`${method} result schema is invalid`); }
    successfulMethodCounts.set(method, (successfulMethodCounts.get(method) ?? 0) + 1);
    return response.result;
  };
  const expectError = async (method, id, params, allowedCodes) => {
    const response = await call({ jsonrpc: "2.0", id, method, params });
    assertErrorResponse(response, new Set(allowedCodes), method);
    return response.error.data.code;
  };
  return {
    call,
    result,
    expectError,
    notify,
    endInput,
    finish,
    counts: () => Object.fromEntries([...successfulMethodCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

function assertCleanTermination(processEvidence) {
  if (processEvidence.exit.code !== 0 || processEvidence.exit.signal !== null
      || processEvidence.close.code !== 0 || processEvidence.close.signal !== null
      || processEvidence.stderr.byteLength !== 0) {
    throw new Error("sidecar termination was not clean");
  }
}

async function session(version, exercise) {
  const rpc = client();
  try {
    const initialized = await rpc.result("initialize", 1, {
      protocol: "tfsb.studio", minVersion: version, maxVersion: version,
      client: { name: "tfsb-studio-qualification", version: "0.1.0" },
      capabilities: { progress: true, cancellation: true },
    });
    if (initialized.selectedVersion !== version) throw new Error("negotiated protocol version differs from the requested version");
    const nonce = initialized.sessionNonce;
    rpc.notify({ jsonrpc: "2.0", method: "initialized", params: { sessionNonce: nonce } });
    const evidence = exercise === undefined ? {} : await exercise(rpc, nonce, initialized);
    await rpc.result("shutdown", 99, { sessionNonce: nonce });
    rpc.notify({ jsonrpc: "2.0", method: "exit", params: {} });
    rpc.endInput();
    const processEvidence = await rpc.finish();
    assertCleanTermination(processEvidence);
    return {
      selectedVersion: version,
      serverVersion: initialized.server.version,
      successfulMethodCounts: rpc.counts(),
      process: processEvidence,
      ...evidence,
    };
  }
  catch (error) {
    rpc.endInput();
    try { await rpc.finish({ force: true }); }
    catch { /* The failed child is intentionally bounded to this session. */ }
    const reason = error instanceof Error ? error.message : "unknown protocol failure";
    throw new Error(`protocol ${version} session failed: ${reason}`);
  }
}

async function unavailableInLegacy(rpc, nonce, startId) {
  const methods = [
    [startId, "brand.qa.profile.list", { sessionNonce: nonce, projectHandle: "project_unavailable", pageSize: 64 }],
    [startId + 1, "brand.visual.evidence.get", {
      kind: "project-render", sessionNonce: nonce, projectHandle: "project_unavailable",
      target: { kind: "asset", assetId: "mark" }, width: 16, height: 16, background: "transparent",
    }],
  ];
  return Object.fromEntries(await Promise.all(methods.map(async ([id, method, params]) => [
    method, await rpc.expectError(method, id, params, [CAPABILITY_UNAVAILABLE]),
  ])));
}

async function prepareQaProject(coreProject, qaProject) {
  const loadedCore = await coreApi.loadCanonicalProject(coreProject, "check");
  const asset = loadedCore.assets.find((entry) => entry.id === "fixture-mark-on-light");
  if (asset === undefined) throw new Error("QA fixture asset is missing");
  const svgBytes = loadedCore.outputs.get(asset.filename);
  if (!(svgBytes instanceof Uint8Array)) throw new Error("QA fixture SVG bytes are missing");
  const capability = await coreApi.loadRasterCapability();
  if (capability?.available !== true || capability.qa === undefined) throw new Error("QA fixture renderer capability is unavailable");
  const svgDigest = coreApi.computeSha256(svgBytes);
  const rendered = await coreApi.renderBrandQaRaster(capability.qa, {
    canonicalSvgBytes: svgBytes,
    svgDigest,
    width: 64,
    height: 64,
    background: "transparent",
    backgroundRgba: null,
    configuration: coreApi.BRAND_QA_RENDER_CONFIGURATION,
  });
  if (!(rendered.pngBytes instanceof Uint8Array) || rendered.pngBytes.byteLength === 0) throw new Error("QA fixture renderer returned no PNG");
  const brandTomlPath = join(qaProject, ".tfsb/brand.toml");
  const brandToml = await readFile(brandTomlPath, "utf8");
  await writeFile(brandTomlPath, brandToml.replace("qa = false", "qa = true").replace("exports = false", "exports = true"));
  const exportsToml = `schema = "tfsb.brand-exports"\nschema_version = 1\n\n[[profiles]]\nid = "transcript"\nadapter = "resvg-png-v1"\n\n[[profiles.outputs]]\nid = "fixture-mark"\npurpose = "pwa-icon"\nasset = "fixture-mark-on-light"\ndestination = "brand/export/fixture-mark.png"\nwidth = 64\nheight = 64\nfit = "contain-pad"\nbackground = "transparent"\ncolor_space = "srgb"\nalpha = "straight"\n`;
  const parsedExports = coreApi.parseBrandExportsToml(exportsToml);
  if (!parsedExports.ok) throw new Error("QA fixture export profile is invalid");
  await writeFile(join(qaProject, ".tfsb/brand-exports.toml"), exportsToml);
  const packagePath = join(qaProject, ".tfsb/brand-package.toml");
  const originalPackageToml = await readFile(packagePath, "utf8");
  await writeFile(packagePath, originalPackageToml.replace(/brand_system_digest = "sha256:[0-9a-f]{64}"/u, (line) => `${line}\nexport_profile_digest = "${coreApi.computeBrandExportsDomainDigest(parsedExports.value)}"`));
  const baselineDirectory = join(qaProject, ".tfsb/brand-baselines/release");
  await mkdir(baselineDirectory, { recursive: true });
  const pngDigest = coreApi.computeSha256(rendered.pngBytes);
  const decodedPixelDigest = coreApi.computeSha256(rendered.rgba8);
  await writeFile(join(baselineDirectory, "mark-baseline.png"), Buffer.from(rendered.pngBytes));
  await writeFile(join(qaProject, ".tfsb/brand-qa.toml"), `schema = "tfsb.brand-qa"\nschema_version = 1\n\n[[profiles]]\nid = "release"\nrenderer = "required"\nformats = ["json"]\ncases = ["mark-baseline"]\n\n[[cases]]\nid = "mark-baseline"\nkind = "baseline"\nasset = "fixture-mark-on-light"\nsizes = [[64, 64]]\nbackgrounds = ["transparent"]\nbaseline_path = ".tfsb/brand-baselines/release/mark-baseline.png"\nbaseline_digest = "${pngDigest}"\nrenderer_id = "${capability.qa.descriptor.id}"\nrenderer_version = "${capability.qa.descriptor.version}"\nplatform_claim = "${capability.qa.descriptor.platformClaim}"\ncanonical_asset_digest = "${coreApi.computeAssetSemanticDigest(asset)}"\nsvg_digest = "${svgDigest}"\n`);
  const loadedQa = await coreApi.loadCanonicalProject(qaProject, "check");
  const packageToml = await readFile(packagePath, "utf8");
  if (!/brand_system_digest = "sha256:[0-9a-f]{64}"/u.test(packageToml)) throw new Error("QA fixture package digest field is missing");
  await writeFile(packagePath, packageToml.replace(/brand_system_digest = "sha256:[0-9a-f]{64}"/u, `brand_system_digest = "${loadedQa.brand.brandSystemDigest}"`));
  return { pngDigest, decodedPixelDigest, descriptor: capability.qa.descriptor };
}

async function prepareDeriveProject(coreProject, deriveProject) {
  await cp(coreProject, deriveProject, { recursive: true });
  await rm(join(deriveProject, ".tfsb/brand-package.toml"), { force: true });
  await writeFile(join(deriveProject, ".tfsb/brand.toml"), `schema = "tfsb.brand"\nschema_version = 1\nenabled_domains = { tokens = true, recipes = true, qa = false, consumer_profiles = false, package = false, exports = false }\n\n[[families]]\nid = "fixture-fam"\nname = "Fixture Family"\nrequired_roles = []\noptional_roles = ["mark"]\n\n[[variants]]\nfamily = "fixture-fam"\nid = "light"\nbackgrounds = ["light"]\ncolor_mode = "full-color"\nscale = "standard"\nstatus = "primary"\n\n[[variants]]\nfamily = "fixture-fam"\nid = "derived-dark"\nbackgrounds = ["dark"]\ncolor_mode = "reversed"\nscale = "standard"\nstatus = "primary"\n\n[[bindings]]\nfamily = "fixture-fam"\nrole = "mark"\nvariant = "light"\nasset = "fixture-mark-on-light"\nauthority = "source"\n\n[[bindings]]\nfamily = "fixture-fam"\nrole = "mark"\nvariant = "derived-dark"\nasset = "fixture-mark-derived-dark"\nauthority = "derived"\n`);
  await writeFile(join(deriveProject, ".tfsb/brand-tokens.toml"), `schema = "tfsb.brand-tokens"\nschema_version = 1\n\n[[colors]]\nid = "brand-blue"\nvalue = "#0066CCFF"\n`);
  await writeFile(join(deriveProject, ".tfsb/brand-recipes.toml"), `schema = "tfsb.brand-recipes"\nschema_version = 1\n\n[[recipes]]\nid = "recipe-derived-dark"\ntarget_asset = "fixture-mark-derived-dark"\nsource_asset = "fixture-mark-on-light"\n\n[[recipes.operations]]\noperation = "replace-paint"\nchannel = "fill"\nsource_color = "#000000FF"\nreplacement_token = "brand-blue"\nexpected_occurrences = 1\n\n[[recipes.operations]]\noperation = "copy-accessibility"\npolicy = "preserve"\n`);
}

export async function runTranscript() {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "tfsb48r2-transcript-")));
  try {
    const target = join(scratch, "import-target");
    const consumerTarget = join(scratch, "consumer-target");
    const content = join(scratch, "content");
    const coreProject = join(repositoryRoot, "docs/examples/v0.4/brand-system/core-minimal");
    await mkdir(target);
    await mkdir(join(consumerTarget, ".tfsb/assets"), { recursive: true });
    await writeFile(join(consumerTarget, ".tfsb/project.toml"), 'schema_version = 2\nname = "transcript-consumer"\n\n[build]\ndirectory = "dist"\n');
    await mkdir(content);
    await writeFile(join(content, "mark.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>\n');
    const v10 = await session("1.0", async (rpc, nonce) => ({ capabilityUnavailable: await unavailableInLegacy(rpc, nonce, 40) }));
    const v11 = await session("1.1", async (rpc, nonce, initialized) => {
      const project = await rpc.result("project.open", 2, { sessionNonce: nonce, path: target, mode: "import-target" });
      const source = await rpc.result("source.open", 3, { sessionNonce: nonce, path: content, purpose: "content" });
      if (!project.projectHandle.startsWith("project_") || !source.sourceHandle.startsWith("source_")) throw new Error("opaque handles were not returned");
      const existing = await rpc.result("project.open", 4, { sessionNonce: nonce, path: coreProject, mode: "existing" });
      const capability = summarizeCapability(await rpc.result("brand.export.capability", 5, { sessionNonce: nonce, projectHandle: existing.projectHandle }));
      assertInitializeRaster(initialized.capabilities, capability);
      return {
        project: { kind: "import-target" },
        source: { kind: "content-directory" },
        rasterCapability: capability,
        capabilityUnavailable: await unavailableInLegacy(rpc, nonce, 40),
      };
    });
    const qaProject = join(scratch, "qa-project");
    const sourceProject = join(scratch, "source-project");
    const deriveProject = join(scratch, "derive-project");
    await cp(coreProject, qaProject, { recursive: true });
    await cp(coreProject, sourceProject, { recursive: true });
    await prepareDeriveProject(coreProject, deriveProject);
    const profileToml = `schema = "tfsb.consumer-profiles"\nschema_version = 1\n[[profiles]]\nid = "basic"\nversion = 1\ncompatible_package = "core-fixture-brand"\nminimum_brand_version = "0.4.0-fixture.1"\nmaximum_brand_version_exclusive = "1.0.0"\n[[profiles.outputs]]\nasset = "fixture-mark-on-light"\ndestination = "public/fixture-mark.svg"\nrequirement = "required"\ncollision = "error"\n[[profiles.outputs]]\ncompanion = "fixture-guidance"\ndestination = "GUIDANCE-BRAND.md"\nrequirement = "required"\ncollision = "error"\n`;
    const sourceBrandPath = join(sourceProject, ".tfsb/brand.toml");
    await writeFile(sourceBrandPath, (await readFile(sourceBrandPath, "utf8")).replace("consumer_profiles = false", "consumer_profiles = true"));
    await writeFile(join(sourceProject, ".tfsb/consumer-profiles.toml"), profileToml);
    const profileModel = coreApi.parseConsumerProfilesToml(profileToml);
    const packagePath = join(sourceProject, ".tfsb/brand-package.toml");
    const packageModel = coreApi.parseBrandPackageToml(await readFile(packagePath, "utf8"));
    if (!profileModel.ok || !packageModel.ok) throw new Error("consumer source fixture parse failed");
    const sourcePackage = { ...packageModel.value, compatibleProfiles: profileModel.value.profiles.map((profile) => profile.id), consumerProfileDigest: coreApi.computeConsumerProfilesDomainDigest(profileModel.value) };
    await writeFile(packagePath, coreApi.serializeBrandPackageToml(sourcePackage));
    const loadedSource = await coreApi.loadCanonicalProject(sourceProject, "bundle");
    await writeFile(packagePath, coreApi.serializeBrandPackageToml({ ...sourcePackage, brandSystemDigest: loadedSource.brand.brandSystemDigest }));
    await coreApi.bundleBrandProject({ root: sourceProject, output: "source.zip" });
    const qaFixture = await prepareQaProject(coreProject, qaProject);
    const v12 = await session("1.2", async (rpc, nonce, initialized) => {
      const project = await rpc.result("project.open", 50, { sessionNonce: nonce, path: qaProject, mode: "existing" });
      if (typeof project.projectHandle !== "string" || !project.projectHandle.startsWith("project_")) throw new Error("protocol 1.2 project handle is invalid");
      const capability = summarizeCapability(await rpc.result("brand.export.capability", 51, { sessionNonce: nonce, projectHandle: project.projectHandle }));
      assertInitializeRaster(initialized.capabilities, capability);
      if (initialized.capabilities.brand.methods.visualEvidenceGet !== true || initialized.capabilities.brand.visualEvidence.available !== true) {
        throw new Error("protocol 1.2 visual capability is not advertised by the observed service");
      }
      const qa = await rpc.result("brand.qa.profile.list", 52, { sessionNonce: nonce, projectHandle: project.projectHandle, pageSize: 64 });
      const visual = await rpc.result("brand.visual.evidence.get", 53, {
        kind: "project-render", sessionNonce: nonce, projectHandle: project.projectHandle,
        target: { kind: "asset", assetId: "fixture-mark-on-light" }, width: 64, height: 64, background: "transparent",
      });
      const visualSummary = summarizeVisualEvidence(visual, capability);
      const artifact = visual.artifacts[0];
      if (artifact.pngDigest !== qaFixture.pngDigest || artifact.decodedPixelDigest !== qaFixture.decodedPixelDigest) {
        throw new Error("sidecar raster does not match the observed QA fixture raster");
      }
      const deriveOpened = await rpc.result("project.open", 54, { sessionNonce: nonce, path: deriveProject, mode: "existing" });
      const consumerProject = await rpc.result("project.open", 55, { sessionNonce: nonce, path: consumerTarget, mode: "existing" });
      const consumerSource = await rpc.result("source.open", 56, { sessionNonce: nonce, path: await realpath(join(sourceProject, "source.zip")), purpose: "brand-bundle" });
      const planFamilies = [];
      const planAndApply = async (id, method, params) => {
        const planned = await rpc.result(method, id, { sessionNonce: nonce, ...params });
        if (planned.method !== method || typeof planned.planToken !== "string" || typeof planned.planDigest !== "string") throw new Error(`${method} did not return a bound plan`);
        const applied = await rpc.result("plan.apply", id + 100, { sessionNonce: nonce, planToken: planned.planToken, expectedPlanDigest: planned.planDigest });
        if (applied.applied !== true || applied.method !== method) throw new Error(`${method} did not apply in the scratch transcript`);
        planFamilies.push({ method, planDigest: planned.planDigest, applied: true });
      };
      await planAndApply(70, "brand.derive.plan", { projectHandle: deriveOpened.projectHandle, selection: { kind: "all" } });
      await planAndApply(71, "brand.consumer.install.plan", { projectHandle: consumerProject.projectHandle, sourceHandles: [consumerSource.sourceHandle], profiles: ["core-fixture-brand/basic"] });
      await planAndApply(72, "brand.consumer.sync.plan", { projectHandle: consumerProject.projectHandle, sourceHandles: [consumerSource.sourceHandle] });
      await planAndApply(73, "brand.qa.baseline.plan", { projectHandle: project.projectHandle, profileId: "release", caseId: "mark-baseline" });
      await planAndApply(74, "brand.export.plan", { projectHandle: project.projectHandle, profileId: "transcript" });
      return { project: { kind: "qa-scratch-copy" }, rasterCapability: capability, qaProfileList: summarizeQaPage(qa), visualEvidence: visualSummary, planFamilies };
    });
    const restartedV12 = await session("1.2", async (rpc, nonce, initialized) => {
      const project = await rpc.result("project.open", 60, { sessionNonce: nonce, path: qaProject, mode: "existing" });
      const capability = summarizeCapability(await rpc.result("brand.export.capability", 61, { sessionNonce: nonce, projectHandle: project.projectHandle }));
      assertInitializeRaster(initialized.capabilities, capability);
      const baseline = await rpc.result("brand.visual.evidence.get", 62, { kind: "qa-baseline", sessionNonce: nonce, projectHandle: project.projectHandle, profileId: "release", caseId: "mark-baseline" });
      const source = await rpc.result("source.open", 63, { sessionNonce: nonce, path: await realpath(join(sourceProject, "source.zip")), purpose: "brand-bundle" });
      const comparison = await rpc.result("brand.visual.evidence.get", 64, {
        kind: "brand-diff", sessionNonce: nonce, projectHandle: project.projectHandle, sourceHandle: source.sourceHandle,
        target: { kind: "asset", assetId: "fixture-mark-on-light" }, width: 64, height: 64, background: "transparent",
      });
      return {
        project: { kind: "qa-scratch-copy" },
        rasterCapability: capability,
        baseline: summarizeVisualEvidence(baseline, capability),
        semanticBeforeAfter: summarizeVisualEvidence(comparison, capability),
      };
    });
    return { schemaVersion: 2, evidenceScope: "synthetic-fixture-supplemental", v10, v11, v12, restartedV12 };
  }
  finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    process.stdout.write(`${JSON.stringify(await runTranscript(), null, 2)}\n`);
  }
  catch {
    process.stderr.write("sidecar transcript failed\n");
    process.exitCode = 1;
  }
}

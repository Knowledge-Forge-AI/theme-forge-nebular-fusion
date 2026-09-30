import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digest, identity, inventoryTree, seal, validateBuildReceipt, candidateProvenance } from "./candidate-provenance.mjs";
import { validateBuildInputs } from "./build-inputs.mjs";
import { payloadLayout } from "./platform-targets.mjs";
import { defaultSnapshotReader } from "./fs-snapshot.mjs";

// The executable bit and the target header are both taken from one no-follow
// descriptor, and the payload path must still name that file afterwards.
export function measureNativeExecutable(executable, target, reader = defaultSnapshotReader) {
  const produced = reader.readRegular(executable, {
    bindPath: true,
    label: "Native output",
    maxBytes: 1024 * 1024 * 1024,
    messages: { notRegular: "Native output must be a regular file", symlink: "Native output must be a regular file, not a symbolic link" },
  });
  if (!produced.executable) throw new Error("Native output is not executable");
  const header = produced.bytes;
  const correctTarget = target.os === "darwin"
    ? header.length >= 8 && header.readUInt32LE(0) === 0xfeedfacf && header.readUInt32LE(4) === 0x0100000c
    : header.length >= 20 && header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
      && header[4] === 2 && header[5] === 1
      && header.readUInt16LE(18) === (target.cpu === "arm64" ? 183 : 62);
  if (!correctTarget) throw new Error("Native output target mismatch");
  return produced;
}

// Called only after the native command exits successfully. All claims are
// collected from produced bytes; no pre-build or schema-only success receipt.
export async function produceBuildReceipt({ inputs, studioRoot, payloadRoot, output, reader = defaultSnapshotReader }) {
  const authority = await validateBuildInputs(inputs);
  measureNativeExecutable(join(payloadRoot, payloadLayout(authority.target).executable), authority.target, reader);
  const darwin = authority.target.os === "darwin";
  const plan = inputs.source.resourcePlans[inputs.target];
  const resources = [];
  for (const path of plan.resources) {
    const prepared = (await inventoryTree(join(studioRoot, "src-tauri", path))).identity;
    const shipped = (await inventoryTree(join(payloadRoot, payloadLayout(authority.target).resources, path))).identity;
    if (prepared !== shipped) throw new Error("Native resource differs from prepared authority");
    resources.push({ path, identity: shipped });
  }
  const externalBin = [];
  for (const path of plan.externalBin) {
    const prepared = digest(await readFile(join(studioRoot, "src-tauri", `${path}-${inputs.target}`)));
    const shippedPath = darwin ? "Theme Forge Nebular Fusion.app/Contents/MacOS/tfsb-studio-service" : "bin/tfsb-studio-service";
    const shipped = digest(await readFile(join(payloadRoot, shippedPath)));
    if (prepared !== shipped) throw new Error("Native sidecar differs from prepared authority");
    externalBin.push({ path, identity: shipped });
  }

  const pinsPath = join(studioRoot, "src-tauri", "source-build-pins.json");
  let pinsContent = null;
  try {
    pinsContent = JSON.parse(await readFile(pinsPath, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (pinsContent) {
    const runtimeIdentity = externalBin[0]?.identity;
    if (!runtimeIdentity) {
      throw new Error("Missing externalBin runtime identity for source-build pin verification");
    }
    if (pinsContent.sidecarManifest?.runtime?.sha256 !== runtimeIdentity) {
      throw new Error("Source-build sidecar manifest runtime does not match shipped externalBin");
    }
    if (pinsContent.scene?.node?.sha256 !== runtimeIdentity) {
      throw new Error("Source-build scene node pin does not match shipped externalBin");
    }
    if (pinsContent.loom?.node?.sha256 !== runtimeIdentity) {
      throw new Error("Source-build loom node pin does not match shipped externalBin");
    }
  }

  const preparation = { resources, externalBin };
  const payload = await inventoryTree(payloadRoot);
  const components = Object.fromEntries(Object.entries(authority.claims.components).map(([name, c]) =>
    [name, { source: c.source, output: c.output, producer: c.producer }]));
  const settingsIdentity = authority.claims.settings?.identity ?? authority.claims.settings;
  if (!settingsIdentity || typeof settingsIdentity !== "string" || !/^[a-f0-9]{64}$/.test(settingsIdentity)) {
    throw new Error("Valid settings identity required for build receipt");
  }
  const receipt = seal("nebular-build-receipt-v1", { sourceCandidate: inputs.source.identity,
    version: inputs.source.version, target: inputs.target, mode: inputs.mode,
    toolchains: authority.claims.toolchains, components, settings: settingsIdentity,
    preparation: { ...preparation, identity: identity(preparation) }, nativePayload: payload.identity });
  validateBuildReceipt(receipt, inputs.source);
  const provenance = candidateProvenance(inputs.source, receipt);
  for (const [name, record] of [["build-receipt.json", receipt], ["native-payload.json", payload], ["candidate-provenance.json", provenance]]) {
    await writeFile(join(output, name), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  }
  return { receipt, provenance, payload };
}

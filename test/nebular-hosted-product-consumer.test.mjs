// Contract tests for the projected consumer helper. These fixtures are synthetic
// refusal/shape tests only; they are never release or hosted-qualification evidence.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { RESOURCE_PREPARERS } from "../tools/platform-targets.mjs";
import { assemblePlatformPackage } from "../tools/native-rc-package.mjs";
import { inventoryNativePayload } from "../tools/native-runtime.mjs";
import {
  CORRESPONDING_SOURCE_OFFER_SCHEMA,
  DARWIN_AUTHORITIES,
  INPUT_SCHEMA,
  PACKAGE_MANIFEST_SCHEMAS,
  PLATFORM_RECEIPT_SCHEMA,
  PLATFORMS,
  PRODUCT,
  QUALIFICATION_RECEIPT_SCHEMA,
  RECEIPT_SCHEMA,
  REPOSITORY,
  SMOKE_FINALIZATION_SCHEMA,
  SMOKE_RUN_SCHEMA,
  SOURCE_CONTRACT,
  SOURCE_READBACK_FETCH_SCHEMA,
  SOURCE_READBACK_SCHEMA,
  SOURCE_PAYLOAD_SCHEMA,
  VERSION,
  buildCommandPlan,
  buildConsumerReceipt,
  fetchReleaseAsset,
  fetchSourceReadbacks,
  prepareConsumerQualifyCheckout,
  qualifyPlatform,
  resolveAssetsDir,
  resolveSourceAdmission,
  sourceInventoryFromGitListing,
  validateArchiveMemberNames,
  validateArchiveVerboseListing,
  validateExtractedPackageManifest,
  validateInput,
  validatePublicReleaseUrl,
  validateQualificationReceipt,
  validateSmokeRunReport,
  verifyAdmissionReceipt,
  verifyExtractedDarwinRawPayload,
} from "../tools/nebular-hosted-product-consumer.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const CONSUMER_TOOL_PATH = resolve(__dirname, "../tools/nebular-hosted-product-consumer.mjs");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`;
const digest = (character) => character.repeat(64);

const RETAINED_DARWIN_QUALIFICATION_JSON = `{
  "schema": "nebular.native-rc-qualification-v1",
  "platform": "darwin-arm64",
  "status": "pass",
  "executableSha256": "4c8ce3b880e87943f1e09614ff6a9639f3bbe0111b4bba61e00a3f4ec811f1b9",
  "glibcMinimum": null,
  "nativePayload": null,
  "materialDigest": null,
  "checks": [
    {
      "id": "executable-header",
      "ok": true,
      "detail": "4c8ce3b880e87943f1e09614ff6a9639f3bbe0111b4bba61e00a3f4ec811f1b9"
    },
    {
      "id": "launcher",
      "ok": true,
      "detail": "c46bc5c96cd401caf7ba44eaf136927ba2464ee04fd3d59479f63c99d7f8077b"
    },
    {
      "id": "sidecar-runtime",
      "ok": true,
      "detail": "node 22.23.3 68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b"
    },
    {
      "id": "resource:sidecar-payload",
      "ok": true,
      "detail": "f8eb572fd0873245e120b69bbf53718005e86323b9c56fb44b80bce659ce4c66"
    },
    {
      "id": "resource:loom-payload",
      "ok": true,
      "detail": "bbfbacba78d4b4bd84061f8a327b3c9bb7a9207dbcecd9712d01eddc5b5374a9"
    },
    {
      "id": "resource:loom-adapter",
      "ok": true,
      "detail": "01c55e6442ab41c4de58dbc2e0675aa7b1949b4c0c0dc4a811ec0fcc31764714"
    },
    {
      "id": "resource:solar-sail-payload",
      "ok": true,
      "detail": "9cc892091fd614e0425f4eadb2cb90e136e8299b6236b86c2605bd08f2ad6d31"
    },
    {
      "id": "resource:solar-sail-adapter",
      "ok": true,
      "detail": "5f3f504267c82c4e55c3f28ba7780b5f29de0a7b16e2e8a5a3fdaf543d64053a"
    },
    {
      "id": "resource:scene-payload",
      "ok": true,
      "detail": "a4cadda2a99a115cf2f94e208fb182549165f5cd2aa77326a77f188bc0847918"
    },
    {
      "id": "resource:release-notices",
      "ok": true,
      "detail": "b0c9439afa05c5a8929a26d079a8b48a754df1242531c87cd263ba0bf71849c5"
    },
    {
      "id": "legal-notices",
      "ok": true,
      "detail": "LICENSE, NOTICE"
    },
    {
      "id": "codesign",
      "ok": true,
      "detail": "valid · Signature=adhoc"
    }
  ]
}
`;

function makeQualificationChecks(platform, executableDetail = targetSources[platform]?.executableSha256 ?? digest("0")) {
  const checks = [
    { id: "executable-header", ok: true, detail: executableDetail },
    { id: "launcher", ok: true, detail: "ok" },
    { id: "sidecar-runtime", ok: true, detail: "ok" },
    ...Object.keys(RESOURCE_PREPARERS).map((dir) => ({ id: `resource:${dir}`, ok: true, detail: "1 files" })),
  ];
  if (platform === "darwin-arm64") {
    checks.push(
      { id: "legal-notices", ok: true, detail: "LICENSE and NOTICE match" },
      { id: "codesign", ok: true, detail: "codesign verified" },
    );
  } else {
    checks.push(
      { id: "mode:gui", ok: true, detail: "0755" },
      { id: "mode:sidecar", ok: true, detail: "0755" },
      { id: "mode:launcher", ok: true, detail: "0755" },
      { id: "glibc:gui", ok: true, detail: "2.36" },
      { id: "glibc:sidecar", ok: true, detail: "2.28" },
      { id: "glibc-floor", ok: true, detail: "2.36 <= 2.36" },
      { id: "linkage", ok: true, detail: "resolved" },
    );
  }
  return checks;
}

function makeQualificationReceipt(platform, targetSource) {
  if (platform === "darwin-arm64") {
    return {
      schema: QUALIFICATION_RECEIPT_SCHEMA,
      platform,
      status: "pass",
      executableSha256: targetSource.executableSha256,
      glibcMinimum: null,
      nativePayload: null,
      materialDigest: null,
      checks: makeQualificationChecks(platform, targetSource.executableSha256),
    };
  }
  return {
    schema: QUALIFICATION_RECEIPT_SCHEMA,
    platform,
    triple: platform === "linux-arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu",
    version: VERSION,
    status: "pass",
    executableSha256: targetSource.executableSha256,
    glibcMinimum: "2.36",
    nativePayload: { identity: targetSource.nativePayloadSha256, files: 10 },
    checks: makeQualificationChecks(platform, targetSource.executableSha256),
  };
}

function makeNativeExecutableBytes(platform) {
  if (platform === "darwin-arm64") {
    const buf = Buffer.alloc(64);
    buf.writeUInt32LE(0xfeedfacf, 0);
    buf.writeUInt32LE(0x0100000c, 4);
    buf.writeUInt32LE(2, 12);
    buf.write(`nebular-${platform}`, 32, "utf8");
    return buf;
  }
  const buf = Buffer.alloc(64);
  Buffer.from([0x7f, 69, 76, 70, 2, 1, 1]).copy(buf, 0);
  buf.writeUInt16LE(2, 16);
  buf.writeUInt16LE(platform === "linux-arm64" ? 183 : 62, 18);
  buf.write(`nebular-${platform}`, 32, "utf8");
  return buf;
}

// Public projection Git commit/tree is distinct from both retained Darwin b954 and current Linux compiler source.
const publicCommit = "7777777777777777777777777777777777777777";
const publicTree = "fd4252f5d86173212767339164836f11fe7c5254";
const darwinCommit = "b954cb27bb738a7c76b69285be6fb14c6e3b9485";
const darwinTree = "1111111111111111111111111111111111111111";
const darwinCandidate = digest("d");
const linuxCommit = "86e01ee2cc47e13a1f5910748cdcad023366ef6b";
const linuxTree = "2222222222222222222222222222222222222222";
const linuxCandidate = "9ce10142eb22369c65c4581db45ab5213cb1593152a1675b6f93802f70993e86";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/nebular-hosted-product-consumer/source-listing.json", import.meta.url), "utf8"),
);
assert.equal(fixture.purpose.includes("never release evidence"), true);
const listing = Buffer.from(fixture.listing, "utf8");
const parsedInventory = sourceInventoryFromGitListing(listing);
const payload = {
  schema: parsedInventory.schema,
  status: parsedInventory.status,
  kind: parsedInventory.kind,
  tree: publicTree,
  fileCount: parsedInventory.fileCount,
  totalBytes: parsedInventory.totalBytes,
  inventorySha256: parsedInventory.inventorySha256,
};
assert.deepEqual(
  { fileCount: payload.fileCount, totalBytes: payload.totalBytes },
  { fileCount: fixture.fileCount, totalBytes: fixture.totalBytes },
);

const sourceArchiveReadbackBytes = Buffer.alloc(4096, 0x41);
const sourceArchiveReadbackSha256 = sha256(sourceArchiveReadbackBytes);
const correspondingSourceOfferBody = {
  schema: CORRESPONDING_SOURCE_OFFER_SCHEMA,
  status: "pass",
  repository: REPOSITORY,
  commit: publicCommit,
  tree: publicTree,
  sourceArchiveSha256: sourceArchiveReadbackSha256,
  sourceArchiveBytes: sourceArchiveReadbackBytes.length,
  authoritySha256: digest("e"),
  publicBuildSourceIdentity: digest("f"),
};
const correspondingSourceOffer = {
  ...correspondingSourceOfferBody,
  manifestSha256: sha256(Buffer.from(canonical(correspondingSourceOfferBody))),
};

const retainedDarwinExecutableSha256 = "4c8ce3b880e87943f1e09614ff6a9639f3bbe0111b4bba61e00a3f4ec811f1b9";
const retainedDarwinNativePayloadSha256 = "b621e93397130738cea0f64f56959286b398861e0b190c73674449757b1eecaa";

const targetSources = {
  "darwin-arm64": {
    authority: "retained-darwin-b954",
    sourceCommit: darwinCommit,
    sourceTree: darwinTree,
    sourceCandidate: darwinCandidate,
    nativePayloadSha256: retainedDarwinNativePayloadSha256,
    executableSha256: retainedDarwinExecutableSha256,
    packageManifestSha256: digest("8"),
  },
  "linux-arm64": {
    authority: "current-linux-source",
    sourceCommit: linuxCommit,
    sourceTree: linuxTree,
    sourceCandidate: linuxCandidate,
    nativePayloadSha256: digest("9"),
    executableSha256: digest("0"),
    packageManifestSha256: digest("a"),
  },
  "linux-x64": {
    authority: "current-linux-source",
    sourceCommit: linuxCommit,
    sourceTree: linuxTree,
    sourceCandidate: linuxCandidate,
    nativePayloadSha256: digest("b"),
    executableSha256: digest("e"),
    packageManifestSha256: digest("f"),
  },
};

const asset = (platform, kind, index) => ({
  product: PRODUCT,
  platform,
  kind,
  assetId: 7000 + index,
  releaseId: 7070,
  tag: "v0.7.0",
  name: `${PRODUCT}-${platform}-${kind === "raw-archive" ? "raw.tar.gz" : "npm.tgz"}`,
  bytes: 1,
  sha256: digest(String(index)),
  integrity: `sha256-${Buffer.from(digest(String(index)), "hex").toString("base64")}`,
  apiUrl: `https://api.github.com/repos/${REPOSITORY}/releases/assets/${7000 + index}`,
  sourceCommit: targetSources[platform].sourceCommit,
  sourceTree: targetSources[platform].sourceTree,
  sourceCandidate: targetSources[platform].sourceCandidate,
});

const assets = [
  asset("darwin-arm64", "raw-archive", 1),
  asset("darwin-arm64", "npm-package", 2),
  asset("linux-arm64", "raw-archive", 3),
  asset("linux-arm64", "npm-package", 4),
  asset("linux-x64", "raw-archive", 5),
  asset("linux-x64", "npm-package", 6),
];

const darwinQualificationReadbackBytes = Buffer.from(RETAINED_DARWIN_QUALIFICATION_JSON, "utf8");
const darwinQualificationReadbackSha256 = sha256(darwinQualificationReadbackBytes);
assert.equal(darwinQualificationReadbackBytes.length, 1997);
assert.equal(
  darwinQualificationReadbackSha256,
  "2a366f1d0edfc7d19133a838c5eed72ee7c9d08ed2d2229f2526a719b898c805",
);
const darwinQualReceipt = JSON.parse(RETAINED_DARWIN_QUALIFICATION_JSON);
assert.equal(darwinQualReceipt.nativePayload, null);
assert.equal(darwinQualReceipt.materialDigest, null);
assert.equal(darwinQualReceipt.glibcMinimum, null);
assert.equal(darwinQualReceipt.checks.length, 12);
assert.equal(darwinQualReceipt.executableSha256, retainedDarwinExecutableSha256);
assert.equal(
  validateQualificationReceipt(darwinQualReceipt, "darwin-arm64", targetSources["darwin-arm64"]),
  darwinQualReceipt,
);
const darwinQualReceiptSha256 = sha256(Buffer.from(canonical(darwinQualReceipt)));
assert.equal(
  darwinQualReceiptSha256,
  "3f8fb0cf8248ce99cd3026d3d976f7bc42f1a3b2b717f37617af9a6f77c76f02",
);
const darwinSourceReadbackBytes = Buffer.from("darwin-source\n");
const linuxSourceReadbackBytes = Buffer.from("linux-source\n");
const targetSourceReadbacks = {
  "darwin-arm64": {
    role: "darwin-app-source",
    sourceCandidate: darwinCandidate,
    bytes: darwinSourceReadbackBytes.length,
    sha256: sha256(darwinSourceReadbackBytes),
  },
  "linux-arm64": {
    role: "linux-app-source",
    sourceCandidate: linuxCandidate,
    bytes: linuxSourceReadbackBytes.length,
    sha256: sha256(linuxSourceReadbackBytes),
  },
  "linux-x64": {
    role: "linux-app-source",
    sourceCandidate: linuxCandidate,
    bytes: linuxSourceReadbackBytes.length,
    sha256: sha256(linuxSourceReadbackBytes),
  },
};

const input = {
  schema: INPUT_SCHEMA,
  product: PRODUCT,
  version: VERSION,
  source: {
    contract: SOURCE_CONTRACT,
    status: "accepted",
    repository: REPOSITORY,
    commit: publicCommit,
    tree: publicTree,
    readback: {
      status: "pass",
      repository: REPOSITORY,
      commit: publicCommit,
      tree: publicTree,
      payload,
      manifestSha256: sha256(Buffer.from(canonical(payload))),
    },
    correspondingSourceOffer,
    trustedReadback: {
      schema: SOURCE_READBACK_SCHEMA,
      status: "pass",
      sourceArchive: { bytes: sourceArchiveReadbackBytes.length, sha256: sourceArchiveReadbackSha256 },
      darwinQualificationReceipt: {
        bytes: darwinQualificationReadbackBytes.length,
        sha256: darwinQualificationReadbackSha256,
        canonicalSha256: darwinQualReceiptSha256,
      },
    },
    targetSourceReadbacks,
  },
  targetSources,
  release: { repository: REPOSITORY, releaseId: 7070, tag: "v0.7.0", version: VERSION },
  assets,
  qualifications: {
    "darwin-arm64": {
      mode: "existing-qualified",
      status: "pass",
      receiptSha256: darwinQualReceiptSha256,
      receipt: darwinQualReceipt,
      executableSha256: targetSources["darwin-arm64"].executableSha256,
      nativePayloadSha256: targetSources["darwin-arm64"].nativePayloadSha256,
      sourceCommit: darwinCommit,
      sourceTree: darwinTree,
      sourceCandidate: darwinCandidate,
      rawSha256: assets[0].sha256,
      npmSha256: assets[1].sha256,
    },
  },
};

const normalizedInput = validateInput(input);
// Verify idempotency when an already-normalized input is passed back to validateInput
const revalidatedInput = validateInput(normalizedInput);
assert.equal(revalidatedInput.assets.length, 6);
assert.equal(payload.schema, SOURCE_PAYLOAD_SCHEMA);
assert.equal(normalizedInput.targetSources["darwin-arm64"].sourceCommit, darwinCommit);
assert.equal(normalizedInput.targetSources["linux-x64"].sourceCommit, linuxCommit);
assert.equal(normalizedInput.source.commit, publicCommit);

// Input refusal tests
assert.throws(
  () => validateInput({ ...input, source: { ...input.source, readback: { ...input.source.readback, manifestSha256: digest("z") } } }),
  /manifest digest/,
);
assert.throws(
  () => validateInput({ ...input, source: { ...input.source, correspondingSourceOffer: undefined } }),
  /correspondingSourceOffer/,
);
assert.throws(
  () => validateInput({ ...input, source: { ...input.source, correspondingSourceOffer: { ...correspondingSourceOfferBody } } }),
  /correspondingSourceOffer\.manifestSha256/,
);
assert.throws(
  () =>
    validateInput({
      ...input,
      source: {
        ...input.source,
        correspondingSourceOffer: { ...correspondingSourceOffer, manifestSha256: digest("9") },
      },
    }),
  /corresponding-source offer manifest digest mismatch/,
);
assert.throws(
  () => validateInput({ ...input, source: { ...input.source, correspondingSourceOffer: { ...correspondingSourceOffer, tree: darwinTree } } }),
  /corresponding-source offer readback commit\/tree mismatch/,
);
assert.throws(() => validateInput({ ...input, sdkImage: "bookworm" }), /private\/SDK\/helper/);
assert.throws(() => validateInput({ ...input, fixture: true }), /synthetic or fixture flag/);
assert.throws(() => validateInput({ ...input, note: "synthetic contract/refusal fixture only; never release evidence" }), /synthetic or fixture marker/);
assert.throws(() => validateInput({ ...input, assets: assets.slice(1) }), /exactly one raw archive/);
assert.throws(
  () =>
    validateInput({
      ...input,
      qualifications: {
        ...input.qualifications,
        "darwin-arm64": { ...input.qualifications["darwin-arm64"], sourceCommit: publicCommit },
      },
    }),
  /Darwin qualification must preserve retained b954/,
);
assert.throws(
  () =>
    validateInput({
      ...input,
      qualifications: {
        ...input.qualifications,
        "darwin-arm64": { ...input.qualifications["darwin-arm64"], receiptSha256: digest("9") },
      },
    }),
  /receiptSha256 does not match/,
);
assert.throws(
  () =>
    validateInput({
      ...input,
      qualifications: {
        ...input.qualifications,
        "darwin-arm64": {
          ...input.qualifications["darwin-arm64"],
          receipt: {
            ...darwinQualReceipt,
            checks: darwinQualReceipt.checks.filter((c) => c.id !== "codesign"),
          },
        },
      },
    }),
  /missing required passing check 'codesign'/,
);
assert.throws(
  () =>
    validateInput({
      ...input,
      targetSources: {
        ...targetSources,
        "darwin-arm64": { ...targetSources["darwin-arm64"], sourceCommit: linuxCommit },
      },
    }),
  /preserve retained b954 lineage/,
);
assert.throws(
  () =>
    validateInput({
      ...input,
      targetSources: {
        ...targetSources,
        "linux-x64": { ...targetSources["linux-x64"], sourceCommit: darwinCommit },
      },
    }),
  /current Linux source authority, not retained Darwin b954/,
);

// Explicit opt-in current-darwin-source authority validation and cross-lineage refusal checks
assert.deepEqual(DARWIN_AUTHORITIES, ["retained-darwin-b954", "current-darwin-source"]);
const currentDarwinCommit = "c490000000000000000000000000000000000001";
const currentDarwinTree = "3333333333333333333333333333333333333333";
const currentDarwinCandidate = digest("c");
const currentDarwinExecutableSha256 = digest("6");
const currentDarwinNativePayloadSha256 = digest("7");
const currentDarwinPackageManifestSha256 = digest("5");
const currentDarwinSourceReadbackBytes = Buffer.from("current-darwin-source\n");
const currentDarwinTargetSources = {
  ...targetSources,
  "darwin-arm64": {
    authority: "current-darwin-source",
    sourceCommit: currentDarwinCommit,
    sourceTree: currentDarwinTree,
    sourceCandidate: currentDarwinCandidate,
    nativePayloadSha256: currentDarwinNativePayloadSha256,
    executableSha256: currentDarwinExecutableSha256,
    packageManifestSha256: currentDarwinPackageManifestSha256,
  },
};
const currentDarwinQualReceipt = makeQualificationReceipt(
  "darwin-arm64",
  currentDarwinTargetSources["darwin-arm64"],
);
const currentDarwinQualReceiptBytes = Buffer.from(canonical(currentDarwinQualReceipt), "utf8");
const currentDarwinQualReceiptRawSha256 = sha256(currentDarwinQualReceiptBytes);
const currentDarwinQualReceiptCanonicalSha256 = sha256(Buffer.from(canonical(currentDarwinQualReceipt)));
const currentDarwinAssets = assets.map((row) =>
  row.platform === "darwin-arm64"
    ? {
        ...row,
        sourceCommit: currentDarwinCommit,
        sourceTree: currentDarwinTree,
        sourceCandidate: currentDarwinCandidate,
      }
    : row,
);
const currentDarwinInput = {
  ...input,
  source: {
    ...input.source,
    trustedReadback: {
      ...input.source.trustedReadback,
      darwinQualificationReceipt: {
        bytes: currentDarwinQualReceiptBytes.length,
        sha256: currentDarwinQualReceiptRawSha256,
        canonicalSha256: currentDarwinQualReceiptCanonicalSha256,
      },
    },
    targetSourceReadbacks: {
      ...targetSourceReadbacks,
      "darwin-arm64": {
        role: "darwin-app-source",
        sourceCandidate: currentDarwinCandidate,
        bytes: currentDarwinSourceReadbackBytes.length,
        sha256: sha256(currentDarwinSourceReadbackBytes),
      },
    },
  },
  targetSources: currentDarwinTargetSources,
  assets: currentDarwinAssets,
  qualifications: {
    "darwin-arm64": {
      mode: "existing-qualified",
      status: "pass",
      authority: "current-darwin-source",
      receiptSha256: currentDarwinQualReceiptCanonicalSha256,
      receipt: currentDarwinQualReceipt,
      executableSha256: currentDarwinExecutableSha256,
      nativePayloadSha256: currentDarwinNativePayloadSha256,
      sourceCommit: currentDarwinCommit,
      sourceTree: currentDarwinTree,
      sourceCandidate: currentDarwinCandidate,
      rawSha256: currentDarwinAssets[0].sha256,
      npmSha256: currentDarwinAssets[1].sha256,
    },
  },
};
const normalizedCurrentDarwinInput = validateInput(currentDarwinInput);
const revalidatedCurrentDarwinInput = validateInput(normalizedCurrentDarwinInput);
assert.equal(revalidatedCurrentDarwinInput.targetSources["darwin-arm64"].authority, "current-darwin-source");
assert.equal(revalidatedCurrentDarwinInput.qualifications["darwin-arm64"].authority, "current-darwin-source");
assert.equal(revalidatedCurrentDarwinInput.targetSources["darwin-arm64"].sourceCommit, currentDarwinCommit);

// current-darwin-source also permits sharing compiler commit/tree with current Linux when built from the same compiler tree
const sharedCompilerCurrentDarwinInput = validateInput({
  ...currentDarwinInput,
  targetSources: {
    ...currentDarwinTargetSources,
    "darwin-arm64": {
      ...currentDarwinTargetSources["darwin-arm64"],
      sourceCommit: linuxCommit,
      sourceTree: linuxTree,
    },
  },
  assets: currentDarwinAssets.map((row) =>
    row.platform === "darwin-arm64"
      ? { ...row, sourceCommit: linuxCommit, sourceTree: linuxTree }
      : row,
  ),
  qualifications: {
    "darwin-arm64": {
      ...currentDarwinInput.qualifications["darwin-arm64"],
      sourceCommit: linuxCommit,
      sourceTree: linuxTree,
    },
  },
});
assert.equal(sharedCompilerCurrentDarwinInput.targetSources["darwin-arm64"].authority, "current-darwin-source");
assert.equal(sharedCompilerCurrentDarwinInput.targetSources["darwin-arm64"].sourceCommit, linuxCommit);

assert.throws(
  () =>
    validateInput({
      ...currentDarwinInput,
      targetSources: {
        ...currentDarwinTargetSources,
        "darwin-arm64": {
          ...currentDarwinTargetSources["darwin-arm64"],
          authority: "unknown-darwin-authority",
        },
      },
    }),
  /targetSources\.darwin-arm64\.authority must be one of retained-darwin-b954, current-darwin-source/,
);
assert.throws(
  () =>
    validateInput({
      ...currentDarwinInput,
      targetSources: {
        ...currentDarwinTargetSources,
        "darwin-arm64": {
          ...currentDarwinTargetSources["darwin-arm64"],
          sourceCommit: darwinCommit,
        },
      },
    }),
  /current-darwin-source compiler sourceCommit must not use retained Darwin b954 lineage/,
);
assert.throws(
  () =>
    validateInput({
      ...input,
      targetSources: {
        ...targetSources,
        "darwin-arm64": {
          ...targetSources["darwin-arm64"],
          sourceTree: linuxTree,
        },
      },
    }),
  /retained darwin-arm64 sourceTree\/sourceCandidate must remain distinct from current Linux source authority/,
);
assert.throws(
  () =>
    validateInput({
      ...currentDarwinInput,
      targetSources: {
        ...currentDarwinTargetSources,
        "darwin-arm64": {
          ...currentDarwinTargetSources["darwin-arm64"],
          sourceCommit: publicCommit,
        },
      },
    }),
  /darwin-arm64 compiler sourceCommit\/sourceTree must remain distinct from public projection source/,
);
assert.throws(
  () =>
    validateInput({
      ...currentDarwinInput,
      qualifications: {
        "darwin-arm64": {
          ...currentDarwinInput.qualifications["darwin-arm64"],
          authority: "retained-darwin-b954",
        },
      },
    }),
  /Darwin qualification authority must match targetSources\.darwin-arm64\.authority/,
);
assert.throws(
  () =>
    validateInput({
      ...currentDarwinInput,
      qualifications: {
        "darwin-arm64": {
          ...currentDarwinInput.qualifications["darwin-arm64"],
          authority: undefined,
        },
      },
    }),
  /Darwin qualification authority must match targetSources\.darwin-arm64\.authority/,
);
assert.throws(
  () =>
    validateInput({
      ...currentDarwinInput,
      qualifications: {
        "darwin-arm64": {
          ...currentDarwinInput.qualifications["darwin-arm64"],
          sourceCommit: darwinCommit,
        },
      },
    }),
  /Darwin qualification for current-darwin-source must not use retained b954 sourceCommit/,
);
assert.throws(
  () =>
    validateInput({
      ...currentDarwinInput,
      qualifications: {
        "darwin-arm64": {
          ...currentDarwinInput.qualifications["darwin-arm64"],
          sourceTree: darwinTree,
        },
      },
    }),
  /Darwin qualification sourceCommit\/sourceTree\/sourceCandidate must match targetSources\.darwin-arm64/,
);
assert.throws(
  () =>
    validateInput({
      ...currentDarwinInput,
      source: {
        ...currentDarwinInput.source,
        targetSourceReadbacks: {
          ...currentDarwinInput.source.targetSourceReadbacks,
          "darwin-arm64": {
            ...currentDarwinInput.source.targetSourceReadbacks["darwin-arm64"],
            sourceCandidate: darwinCandidate,
          },
        },
      },
    }),
  /source\.targetSourceReadbacks\.darwin-arm64\.sourceCandidate does not bind targetSources\.darwin-arm64/,
);

// Archive member & verbose listing checks
assert.throws(() => validateArchiveMemberNames("safe/file\n../escape\n"), /unsafe member/);
assert.deepEqual(validateArchiveMemberNames("package/\npackage/package.json\n"), ["package/", "package/package.json"]);
assert.equal(
  validateArchiveVerboseListing(
    "drwxr-xr-x 0/0 0 2024-01-01 00:00 package/\n-rw-r--r-- 0/0 12 2024-01-01 00:00 package/package.json\nlrwxr-xr-x 0/0 0 2024-01-01 00:00 package/payload/opt/nebular-private/libfoo.so -> ../../lib/libfoo.so\n",
  ),
  3,
);
assert.throws(
  () => validateArchiveVerboseListing("lrwxr-xr-x 0/0 0 2024-01-01 00:00 package/escape -> ../../../etc/passwd\n"),
  /escapes the extraction root/,
);
assert.throws(
  () => validateArchiveVerboseListing("hrw-r--r-- 0/0 0 2024-01-01 00:00 package/hardlink link to package/package.json\n"),
  /forbidden member type/,
);
assert.throws(
  () => validateArchiveVerboseListing("-rwsr-xr-x 0/0 12 2024-01-01 00:00 package/bin/suid\n"),
  /setuid/,
);

// Consumer receipt aggregation and lineage checks
const receiptRows = {};
for (const platform of Object.keys(PLATFORMS)) {
  const scenarios = PLATFORMS[platform].scenarios;
  const targetSource = targetSources[platform];
  const qualificationReceipt = platform === "darwin-arm64"
    ? darwinQualReceipt
    : makeQualificationReceipt(platform, targetSource);
  receiptRows[platform] = {
    schema: PLATFORM_RECEIPT_SCHEMA,
    status: "pass",
    platform,
    source: {
      contract: SOURCE_CONTRACT,
      repository: REPOSITORY,
      commit: publicCommit,
      tree: publicTree,
      manifestSha256: normalizedInput.source.manifestSha256,
      correspondingSourceOfferSha256: normalizedInput.source.correspondingSourceOfferSha256,
      targetSourceReadbacks: normalizedInput.source.targetSourceReadbacks,
    },
    compilerSource: targetSource,
    release: normalizedInput.release,
    assets: normalizedInput.assets.filter((row) => row.platform === platform),
    transport: normalizedInput.assets.map((row) => ({
      platform: row.platform,
      kind: row.kind,
      assetId: row.assetId,
      name: row.name,
      bytes: row.bytes,
      sha256: row.sha256,
      sourceCommit: row.sourceCommit,
      sourceTree: row.sourceTree,
      sourceCandidate: row.sourceCandidate,
    })),
    packageManifestSha256: targetSource.packageManifestSha256,
    qualification: {
      status: "pass",
      mode: PLATFORMS[platform].qualification,
      authority: targetSource.authority,
      sourceCommit: targetSource.sourceCommit,
      sourceTree: targetSource.sourceTree,
      sourceCandidate: targetSource.sourceCandidate,
      executableSha256: targetSource.executableSha256,
      nativePayloadSha256: targetSource.nativePayloadSha256,
      ...(platform === "darwin-arm64"
        ? {
            receiptSha256: input.qualifications["darwin-arm64"].receiptSha256,
            nativePayload: { identity: targetSource.nativePayloadSha256, files: 12 },
          }
        : {}),
    },
    qualificationReceipt,
    qualificationReceiptSha256: sha256(Buffer.from(canonical(qualificationReceipt))),
    smoke: scenarios.flatMap((scenario) => [
      {
        platform,
        scenario,
        source: "raw-archive",
        status: "pass",
        executableSha256: targetSource.executableSha256,
        receiptSha256: digest("1"),
      },
      {
        platform,
        scenario,
        source: "npm-package",
        status: "pass",
        executableSha256: targetSource.executableSha256,
        receiptSha256: digest("2"),
      },
    ]),
  };
}
const builtReceipt = buildConsumerReceipt(input, receiptRows);
assert.equal(builtReceipt.schema, RECEIPT_SCHEMA);
assert.equal(builtReceipt.platforms.find((row) => row.platform === "darwin-arm64").qualification.sourceCommit, darwinCommit);
assert.throws(
  () =>
    buildConsumerReceipt(input, {
      ...receiptRows,
      "linux-x64": {
        ...receiptRows["linux-x64"],
        qualificationReceipt: {
          ...receiptRows["linux-x64"].qualificationReceipt,
          checks: receiptRows["linux-x64"].qualificationReceipt.checks.filter((check) => check.id !== "linkage"),
        },
      },
    }),
  /missing required passing check 'linkage'/,
);
assert.throws(
  () =>
    buildConsumerReceipt(input, {
      ...receiptRows,
      "darwin-arm64": {
        ...receiptRows["darwin-arm64"],
        qualification: { ...receiptRows["darwin-arm64"].qualification, sourceCommit: publicCommit },
      },
    }),
  /qualification lineage is invalid or restamped/,
);
assert.throws(
  () =>
    buildConsumerReceipt(input, {
      ...receiptRows,
      "linux-x64": { ...receiptRows["linux-x64"], smoke: receiptRows["linux-x64"].smoke.slice(1) },
    }),
  /incomplete/,
);
assert.throws(
  () =>
    buildConsumerReceipt(input, {
      ...receiptRows,
      "linux-x64": { ...receiptRows["linux-x64"], packageManifestSha256: digest("9") },
    }),
  /packageManifestSha256 does not match/,
);
assert.throws(
  () =>
    buildConsumerReceipt(input, {
      ...receiptRows,
      "linux-x64": {
        ...receiptRows["linux-x64"],
        release: { ...receiptRows["linux-x64"].release, releaseId: 9999 },
      },
    }),
  /release does not match/,
);
assert.throws(
  () =>
    buildConsumerReceipt(input, {
      ...receiptRows,
      "linux-x64": {
        ...receiptRows["linux-x64"],
        transport: receiptRows["linux-x64"].transport.map((entry, idx) =>
          idx === 0 ? { ...entry, sha256: digest("9") } : entry,
        ),
      },
    }),
  /transport does not match/,
);
assert.throws(
  () =>
    buildConsumerReceipt(input, {
      ...receiptRows,
      "darwin-arm64": {
        ...receiptRows["darwin-arm64"],
        smoke: [...receiptRows["darwin-arm64"].smoke, receiptRows["linux-x64"].smoke[0]],
      },
      "linux-x64": {
        ...receiptRows["linux-x64"],
        smoke: receiptRows["linux-x64"].smoke.slice(1),
      },
    }),
  /smoke rows must belong to darwin-arm64/,
);
assert.throws(
  () =>
    buildConsumerReceipt(input, {
      ...receiptRows,
      "darwin-arm64": {
        ...receiptRows["darwin-arm64"],
        qualification: {
          ...receiptRows["darwin-arm64"].qualification,
          nativePayload: null,
        },
      },
    }),
  /darwin-arm64 receipt qualification\.nativePayload must be a non-null object/,
);
assert.throws(
  () =>
    buildConsumerReceipt(input, {
      ...receiptRows,
      "darwin-arm64": {
        ...receiptRows["darwin-arm64"],
        qualification: {
          ...receiptRows["darwin-arm64"].qualification,
          nativePayload: true,
        },
      },
    }),
  /darwin-arm64 receipt qualification\.nativePayload must be a non-null object/,
);
assert.throws(
  () =>
    buildConsumerReceipt(input, {
      ...receiptRows,
      "darwin-arm64": {
        ...receiptRows["darwin-arm64"],
        qualification: {
          ...receiptRows["darwin-arm64"].qualification,
          nativePayload: { identity: digest("z"), files: 12 },
        },
      },
    }),
  /darwin-arm64 receipt qualification\.nativePayload nativePayload\.identity does not match/,
);
assert.throws(
  () =>
    buildConsumerReceipt(input, {
      ...receiptRows,
      "darwin-arm64": {
        ...receiptRows["darwin-arm64"],
        qualification: {
          ...receiptRows["darwin-arm64"].qualification,
          nativePayload: { identity: targetSources["darwin-arm64"].nativePayloadSha256, files: 12, extra: true },
        },
      },
    }),
  /darwin-arm64 receipt qualification\.nativePayload contains unknown or missing keys/,
);

const currentDarwinReceiptRows = {
  ...receiptRows,
  "darwin-arm64": {
    ...receiptRows["darwin-arm64"],
    source: {
      ...receiptRows["darwin-arm64"].source,
      targetSourceReadbacks: normalizedCurrentDarwinInput.source.targetSourceReadbacks,
    },
    compilerSource: normalizedCurrentDarwinInput.targetSources["darwin-arm64"],
    assets: normalizedCurrentDarwinInput.assets.filter((row) => row.platform === "darwin-arm64"),
    transport: normalizedCurrentDarwinInput.assets.map((row) => ({
      platform: row.platform,
      kind: row.kind,
      assetId: row.assetId,
      name: row.name,
      bytes: row.bytes,
      sha256: row.sha256,
      sourceCommit: row.sourceCommit,
      sourceTree: row.sourceTree,
      sourceCandidate: row.sourceCandidate,
    })),
    packageManifestSha256: currentDarwinPackageManifestSha256,
    qualification: {
      status: "pass",
      mode: "existing-qualified",
      authority: "current-darwin-source",
      sourceCommit: currentDarwinCommit,
      sourceTree: currentDarwinTree,
      sourceCandidate: currentDarwinCandidate,
      executableSha256: currentDarwinExecutableSha256,
      nativePayloadSha256: currentDarwinNativePayloadSha256,
      receiptSha256: currentDarwinQualReceiptCanonicalSha256,
      nativePayload: { identity: currentDarwinNativePayloadSha256, files: 12 },
    },
    qualificationReceipt: currentDarwinQualReceipt,
    qualificationReceiptSha256: currentDarwinQualReceiptCanonicalSha256,
    smoke: PLATFORMS["darwin-arm64"].scenarios.flatMap((scenario) => [
      {
        platform: "darwin-arm64",
        scenario,
        source: "raw-archive",
        status: "pass",
        executableSha256: currentDarwinExecutableSha256,
        receiptSha256: digest("1"),
      },
      {
        platform: "darwin-arm64",
        scenario,
        source: "npm-package",
        status: "pass",
        executableSha256: currentDarwinExecutableSha256,
        receiptSha256: digest("2"),
      },
    ]),
  },
  "linux-arm64": {
    ...receiptRows["linux-arm64"],
    source: {
      ...receiptRows["linux-arm64"].source,
      targetSourceReadbacks: normalizedCurrentDarwinInput.source.targetSourceReadbacks,
    },
    transport: normalizedCurrentDarwinInput.assets.map((row) => ({
      platform: row.platform,
      kind: row.kind,
      assetId: row.assetId,
      name: row.name,
      bytes: row.bytes,
      sha256: row.sha256,
      sourceCommit: row.sourceCommit,
      sourceTree: row.sourceTree,
      sourceCandidate: row.sourceCandidate,
    })),
  },
  "linux-x64": {
    ...receiptRows["linux-x64"],
    source: {
      ...receiptRows["linux-x64"].source,
      targetSourceReadbacks: normalizedCurrentDarwinInput.source.targetSourceReadbacks,
    },
    transport: normalizedCurrentDarwinInput.assets.map((row) => ({
      platform: row.platform,
      kind: row.kind,
      assetId: row.assetId,
      name: row.name,
      bytes: row.bytes,
      sha256: row.sha256,
      sourceCommit: row.sourceCommit,
      sourceTree: row.sourceTree,
      sourceCandidate: row.sourceCandidate,
    })),
  },
};
const builtCurrentDarwinReceipt = buildConsumerReceipt(currentDarwinInput, currentDarwinReceiptRows);
assert.equal(builtCurrentDarwinReceipt.targetSources["darwin-arm64"].authority, "current-darwin-source");
assert.equal(
  builtCurrentDarwinReceipt.platforms.find((row) => row.platform === "darwin-arm64").compilerSource.authority,
  "current-darwin-source",
);
assert.equal(
  builtCurrentDarwinReceipt.platforms.find((row) => row.platform === "darwin-arm64").qualification.authority,
  "current-darwin-source",
);
assert.throws(
  () =>
    buildConsumerReceipt(currentDarwinInput, {
      ...currentDarwinReceiptRows,
      "darwin-arm64": {
        ...currentDarwinReceiptRows["darwin-arm64"],
        qualification: {
          ...currentDarwinReceiptRows["darwin-arm64"].qualification,
          authority: "retained-darwin-b954",
        },
      },
    }),
  /darwin-arm64 receipt qualification lineage is invalid or restamped/,
);
assert.throws(
  () =>
    buildConsumerReceipt(currentDarwinInput, {
      ...currentDarwinReceiptRows,
      "darwin-arm64": {
        ...currentDarwinReceiptRows["darwin-arm64"],
        compilerSource: {
          ...currentDarwinReceiptRows["darwin-arm64"].compilerSource,
          authority: "retained-darwin-b954",
        },
      },
    }),
  /darwin-arm64 receipt compilerSource does not match authenticated targetSources\.darwin-arm64/,
);

// Command plan, Git source admission, self-inventory cycle refusal, real native-rc-package verify,
// real tauri.conf.json resource staging, nested download-artifact directory resolution, and CLI subcommands
const temp = await mkdtemp(join(tmpdir(), "nebular-consumer-helper-test-"));
try {
  const trustedReadbackDir = join(temp, "trusted-readbacks");
  await mkdir(trustedReadbackDir, { recursive: true });
  const trustedSourceArchivePath = join(trustedReadbackDir, "source-offer.tar.gz");
  const trustedDarwinSourceArchivePath = join(trustedReadbackDir, "darwin-app-source.tar.gz");
  const trustedLinuxSourceArchivePath = join(trustedReadbackDir, "linux-app-source.tar.gz");
  const trustedDarwinReceiptPath = join(trustedReadbackDir, "darwin-qualification.json");
  await writeFile(trustedSourceArchivePath, sourceArchiveReadbackBytes);
  await writeFile(trustedDarwinSourceArchivePath, darwinSourceReadbackBytes);
  await writeFile(trustedLinuxSourceArchivePath, linuxSourceReadbackBytes);
  await writeFile(trustedDarwinReceiptPath, darwinQualificationReadbackBytes);

  // Source-admission fetches the three source payloads and Darwin receipt once,
  // then carries those exact readbacks to every downstream job by artifact.
  const sourceReadbackFetchManifest = {
    schema: SOURCE_READBACK_FETCH_SCHEMA,
    sourceAssets: {
      "corresponding-source-offer": {
        url: "https://api.github.com/repos/Knowledge-Forge-AI/theme-forge-nebular-fusion/releases/assets/7101",
        bytes: sourceArchiveReadbackBytes.length,
        sha256: sourceArchiveReadbackSha256,
      },
      "darwin-app-source": {
        url: "https://api.github.com/repos/Knowledge-Forge-AI/theme-forge-nebular-fusion/releases/assets/7102",
        bytes: darwinSourceReadbackBytes.length,
        sha256: sha256(darwinSourceReadbackBytes),
      },
      "linux-app-source": {
        url: "https://api.github.com/repos/Knowledge-Forge-AI/theme-forge-nebular-fusion/releases/assets/7103",
        bytes: linuxSourceReadbackBytes.length,
        sha256: sha256(linuxSourceReadbackBytes),
      },
    },
    platformSourceRoles: {
      "darwin-arm64": "darwin-app-source",
      "linux-arm64": "linux-app-source",
      "linux-x64": "linux-app-source",
    },
    targetSourceReadbacks,
    darwinQualificationReceipt: {
      url: "https://api.github.com/repos/Knowledge-Forge-AI/theme-forge-nebular-fusion/releases/assets/7104",
      bytes: darwinQualificationReadbackBytes.length,
      sha256: darwinQualificationReadbackSha256,
    },
  };
  const sourceReadbackBodies = new Map([
    [sourceReadbackFetchManifest.sourceAssets["corresponding-source-offer"].url, sourceArchiveReadbackBytes],
    [sourceReadbackFetchManifest.sourceAssets["darwin-app-source"].url, darwinSourceReadbackBytes],
    [sourceReadbackFetchManifest.sourceAssets["linux-app-source"].url, linuxSourceReadbackBytes],
    [sourceReadbackFetchManifest.darwinQualificationReceipt.url, darwinQualificationReadbackBytes],
  ]);
  const fetchedSourceReadbacks = await fetchSourceReadbacks(
    sourceReadbackFetchManifest,
    join(temp, "source-readbacks-fetched"),
    async (url) => ({ status: 200, body: Readable.from([sourceReadbackBodies.get(url)]) }),
    normalizedInput.source,
  );
  assert.equal(fetchedSourceReadbacks.status, "pass");
  assert.deepEqual(Object.keys(fetchedSourceReadbacks.sourceAssets).sort(), [
    "corresponding-source-offer",
    "darwin-app-source",
    "linux-app-source",
  ]);
  assert.equal(fetchedSourceReadbacks.sourceAssets["darwin-app-source"].sourceCandidate, darwinCandidate);
  assert.equal(fetchedSourceReadbacks.sourceAssets["linux-app-source"].sourceCandidate, linuxCandidate);
  assert.equal(fetchedSourceReadbacks.platformSourceRoles["linux-x64"], "linux-app-source");
  assert.equal(fetchedSourceReadbacks.darwinQualificationReceipt.bytes, darwinQualificationReadbackBytes.length);
  assert.deepEqual(fetchedSourceReadbacks.correspondingSourceOffer, {
    bytes: sourceArchiveReadbackBytes.length,
    sha256: sourceArchiveReadbackSha256,
  });
  assert.equal(
    JSON.parse(await readFile(join(temp, "source-readbacks-fetched", "source-readback-manifest.json"))).schema,
    SOURCE_READBACK_FETCH_SCHEMA,
  );
  await assert.rejects(
    () => fetchSourceReadbacks(
      { ...sourceReadbackFetchManifest, platformSourceRoles: { ...sourceReadbackFetchManifest.platformSourceRoles, "linux-x64": "darwin-app-source" } },
      join(temp, "source-readbacks-invalid"),
      async () => ({ status: 200, body: Readable.from([]) }),
      normalizedInput.source,
    ),
    /platform source associations are invalid/,
  );
  await assert.rejects(
    () => fetchSourceReadbacks(
      {
        ...sourceReadbackFetchManifest,
        targetSourceReadbacks: {
          ...sourceReadbackFetchManifest.targetSourceReadbacks,
          "darwin-arm64": {
            ...sourceReadbackFetchManifest.targetSourceReadbacks["darwin-arm64"],
            sourceCandidate: digest("a"),
          },
        },
      },
      join(temp, "source-readbacks-binding-invalid"),
      async () => ({ status: 200, body: Readable.from([]) }),
      normalizedInput.source,
    ),
    /does not match the authenticated target source binding/,
  );
  await assert.rejects(
    () => fetchSourceReadbacks(
      {
        ...sourceReadbackFetchManifest,
        sourceAssets: {
          ...sourceReadbackFetchManifest.sourceAssets,
          "corresponding-source-offer": {
            ...sourceReadbackFetchManifest.sourceAssets["corresponding-source-offer"],
            bytes: sourceArchiveReadbackBytes.length + 1,
          },
        },
      },
      join(temp, "source-readbacks-offer-invalid"),
      async () => ({ status: 200, body: Readable.from([]) }),
      normalizedInput.source,
    ),
    /corresponding-source offer does not match/,
  );
  await assert.rejects(
    () => fetchSourceReadbacks(
      {
        ...sourceReadbackFetchManifest,
        sourceAssets: {
          ...sourceReadbackFetchManifest.sourceAssets,
          "darwin-app-source": {
            ...sourceReadbackFetchManifest.sourceAssets["darwin-app-source"],
            bytes: darwinSourceReadbackBytes.length + 1,
          },
        },
      },
      join(temp, "source-readbacks-target-bytes-invalid"),
      async () => ({ status: 200, body: Readable.from([]) }),
      normalizedInput.source,
    ),
    /darwin-app-source does not match its authenticated target source binding/,
  );

  const checkoutDir = join(temp, "checkout");
  const tools = join(checkoutDir, "tools");
  const tauriDir = join(checkoutDir, "src-tauri");
  await mkdir(tools, { recursive: true });
  await mkdir(tauriDir, { recursive: true });
  await writeFile(join(checkoutDir, "README.md"), "test\n");
  await copyFile(join(REPO_ROOT, "LICENSE"), join(checkoutDir, "LICENSE"));
  await copyFile(join(REPO_ROOT, "NOTICE"), join(checkoutDir, "NOTICE"));
  await copyFile(join(REPO_ROOT, "apps/studio/package.json"), join(checkoutDir, "package.json"));
  await copyFile(join(REPO_ROOT, "apps/studio/src-tauri/tauri.conf.json"), join(tauriDir, "tauri.conf.json"));

  // Copy real maintained native-rc-package.mjs and its sibling modules into checkout/tools/
  for (const toolFile of [
    "native-rc-package.mjs",
    "platform-targets.mjs",
    "native-launcher.mjs",
    "native-runtime.mjs",
    "fs-snapshot.mjs",
    "candidate-provenance.mjs",
  ]) {
    await copyFile(join(REPO_ROOT, "apps/studio/tools", toolFile), join(tools, toolFile));
  }

  const allResourceDirs = Object.keys(RESOURCE_PREPARERS);
  const qualifyScript = `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inventoryNativePayload } from "./native-runtime.mjs";
const args = process.argv.slice(2);
const val = (flag) => args[args.indexOf(flag) + 1];
const out = val("--output");
const platform = val("--platform");
const payload = val("--payload");
const checkout = val("--checkout");
const expectedPayload = val("--expected-native-payload-sha256");
const resourceDirs = ${JSON.stringify(allResourceDirs)};
for (const dir of resourceDirs) {
  if (!existsSync(join(checkout, "src-tauri", dir, "marker.txt"))) {
    process.stderr.write("Missing bridged resource dir: " + dir + "\\n");
    process.exit(1);
  }
}
const observedPayload = await inventoryNativePayload(payload);
if (observedPayload.identity !== expectedPayload) {
  process.stderr.write("Payload inventory mismatch: " + observedPayload.identity + " !== " + expectedPayload + "\\n");
  process.exit(1);
}
const executableSha256 = platform === "linux-x64" ? "__LINUX_X64_EXE__" : "__LINUX_ARM64_EXE__";
const checks = ${JSON.stringify(makeQualificationChecks("linux-x64"))}.map((c) => c.id === "executable-header" ? { ...c, detail: executableSha256 } : c);
writeFileSync(out, JSON.stringify({
  schema: "${QUALIFICATION_RECEIPT_SCHEMA}",
  platform,
  triple: platform === "linux-x64" ? "x86_64-unknown-linux-gnu" : "aarch64-unknown-linux-gnu",
  version: "${VERSION}",
  status: "pass",
  executableSha256,
  glibcMinimum: "2.36",
  nativePayload: { identity: observedPayload.identity, files: observedPayload.files.length },
  checks
}, null, 2));
process.stdout.write(JSON.stringify({ status: "pass", glibcMinimum: "2.36", failed: [] }) + "\\n");
`;
  const smokeScript = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const val = (flag) => args[args.indexOf(flag) + 1];
const platform = val("--platform");
const scenario = val("--scenario");
const source = val("--source");
const label = val("--label");
const evidence = val("--evidence");
const exeMap = {
  "darwin-arm64": "__DARWIN_ARM64_EXE__",
  "linux-arm64": "__LINUX_ARM64_EXE__",
  "linux-x64": "__LINUX_X64_EXE__"
};
writeFileSync(join(evidence, label + ".run.json"), JSON.stringify({
  schema: "${SMOKE_RUN_SCHEMA}",
  label,
  platform,
  scenario,
  source,
  status: "pass",
  problems: [],
  executable: { path: "bin/theme-forge-nebular-fusion", sha256: exeMap[platform], size: 64 },
  receipt: { sha256: "${digest("5")}", status: "pass", steps: [] },
  finalization: { schema: "${SMOKE_FINALIZATION_SCHEMA}", status: "complete", phase: "complete" }
}, null, 2));
process.stdout.write(JSON.stringify({ label, status: "pass", problems: [] }) + "\\n");
`;
  await writeFile(join(tools, "native-rc-qualify.mjs"), qualifyScript);
  await writeFile(join(tools, "native-rc-smoke.mjs"), smokeScript);

  const plan = buildCommandPlan({
    platform: "linux-x64",
    checkout: checkoutDir,
    rawPayload: "/owned/raw",
    npmPackage: "/owned/npm/package",
    packageManifestSha256: digest("c"),
    expectedNativePayloadSha256: targetSources["linux-x64"].nativePayloadSha256,
    evidenceDir: "/owned/evidence",
  });
  assert.throws(
    () =>
      buildCommandPlan({
        platform: "linux-x64",
        checkout: checkoutDir,
        rawPayload: "/owned/raw",
        npmPackage: "/owned/npm/package",
        packageManifestSha256: digest("p"),
        expectedNativePayloadSha256: targetSources["linux-x64"].nativePayloadSha256,
        evidenceDir: "/owned/evidence",
      }),
    /packageManifestSha256 is invalid/,
  );
  assert.equal(plan.expectedScenarioCount, 4);
  assert.equal(plan.qualification.args.includes("--payload"), true);
  assert.equal(plan.qualification.args.includes("--expected-native-payload-sha256"), true);
  assert.equal(plan.qualification.args.includes("/owned/evidence/linux-x64.qualification.json"), true);
  assert.equal(plan.packageVerify.args.includes("verify"), true);
  assert.equal(plan.smoke.some((row) => row.args.includes("C-signal")), true);
  assert.equal(plan.smoke.some((row) => row.args.some((arg) => arg.endsWith("native-rc-smoke.mjs"))), true);

  // Test prepareConsumerQualifyCheckout refusal when a declared resource directory is missing from npmPayload
  const incompleteNpmPayload = join(temp, "incomplete-npm-payload");
  await mkdir(join(incompleteNpmPayload, "lib/theme-forge-nebular-fusion/sidecar-payload"), { recursive: true });
  assert.throws(
    () => prepareConsumerQualifyCheckout(checkoutDir, incompleteNpmPayload, join(temp, "incomplete-scratch")),
    /missing declared resource directory/,
  );

  // Git checkout source admission + self-inventory hash cycle refusal test
  execFileSync("git", ["init", "-q"], { cwd: checkoutDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: checkoutDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: checkoutDir });
  await writeFile(join(checkoutDir, "tracked-descriptor.json"), "{}\n");

  const binDir = join(temp, "bin");
  await mkdir(binDir, { recursive: true });
  for (const wrapper of ["xvfb-run", "dbus-run-session"]) {
    const scriptPath = join(binDir, wrapper);
    await writeFile(
      scriptPath,
      `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then shift; break; fi
  if [ "$1" = "-a" ]; then shift; continue; fi
  if [ "$1" = "-s" ]; then shift 2; continue; fi
  break
done
exec "$@"
`,
    );
    await chmod(scriptPath, 0o755);
  }
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  try {
    const assetsDir = join(temp, "assets");
    const nestedArtifactDir = join(assetsDir, `nebular-${VERSION}-product-assets-999-a1`);
    const dynamicAssets = [];
    const dynamicTargetSources = structuredClone(targetSources);
    for (const [index, platform] of Object.keys(PLATFORMS).entries()) {
      const exeBytes = makeNativeExecutableBytes(platform);
      const exeSha = sha256(exeBytes);
      dynamicTargetSources[platform].executableSha256 = exeSha;
      const rawStage = join(temp, `stage-raw-${platform}`);
      const rawExeFile = join(
        rawStage,
        platform.startsWith("darwin")
          ? PLATFORMS[platform].rawExecutable
          : `${PLATFORMS[platform].rawRoot}/${PLATFORMS[platform].rawExecutable}`,
      );
      await mkdir(join(rawExeFile, ".."), { recursive: true });
      await writeFile(rawExeFile, exeBytes, { mode: 0o755 });
      if (platform.startsWith("darwin")) {
        const darwinResDir = join(rawStage, PLATFORMS[platform].rawRoot, "Contents/Resources");
        await mkdir(darwinResDir, { recursive: true });
        await writeFile(join(darwinResDir, "resource-marker.txt"), "darwin-resource-v1\n", { mode: 0o644 });
      }
      if (platform.startsWith("linux")) {
        for (const dir of allResourceDirs) {
          const resDir = join(rawStage, PLATFORMS[platform].rawRoot, "lib/theme-forge-nebular-fusion", dir);
          await mkdir(resDir, { recursive: true });
          await writeFile(join(resDir, "marker.txt"), `${platform}-${dir}\n`, { mode: 0o644 });
        }
      }
      const payloadSource = platform.startsWith("darwin")
        ? rawStage
        : join(rawStage, PLATFORMS[platform].rawRoot);
      const actualPayloadInventory = await inventoryNativePayload(payloadSource);
      dynamicTargetSources[platform].nativePayloadSha256 = actualPayloadInventory.identity;

      const rawTarDir = join(nestedArtifactDir, "raw", platform);
      await mkdir(rawTarDir, { recursive: true });
      const rawName = `${PRODUCT}-${platform}-raw.tar.gz`;
      const rawTarPath = join(rawTarDir, rawName);
      execFileSync(
        "tar",
        [
          "-czf",
          rawTarPath,
          "-C",
          rawStage,
          platform.startsWith("darwin") ? PLATFORMS[platform].rawRoot : ".",
        ],
        { env: { ...process.env, COPYFILE_DISABLE: "1" } },
      );
      const rawBytes = await readFile(rawTarPath);
      const rawSha = sha256(rawBytes);

      const npmStage = join(temp, `stage-npm-${platform}`);
      const npmPkgDir = join(npmStage, "package");
      const assembled = assemblePlatformPackage({
        platform,
        payload: payloadSource,
        checkout: checkoutDir,
        output: npmPkgDir,
        version: VERSION,
        ...(platform.startsWith("linux") ? { glibcMinimum: "2.36" } : {}),
      });
      dynamicTargetSources[platform].packageManifestSha256 = assembled.manifestSha256;
      const npmTarDir = join(nestedArtifactDir, "npm", platform);
      await mkdir(npmTarDir, { recursive: true });
      const npmName = `${PRODUCT}-${platform}-npm.tgz`;
      const npmTarPath = join(npmTarDir, npmName);
      execFileSync("tar", ["-czf", npmTarPath, "-C", npmStage, "package"]);
      const npmBytes = await readFile(npmTarPath);
      const npmSha = sha256(npmBytes);

      dynamicAssets.push(
        {
          product: PRODUCT,
          platform,
          kind: "raw-archive",
          assetId: 8001 + index * 2,
          releaseId: 7070,
          tag: "v0.7.0",
          name: rawName,
          bytes: rawBytes.length,
          sha256: rawSha,
          integrity: `sha256-${createHash("sha256").update(rawBytes).digest("base64")}`,
          apiUrl: `https://api.github.com/repos/${REPOSITORY}/releases/assets/${8001 + index * 2}`,
          sourceCommit: dynamicTargetSources[platform].sourceCommit,
          sourceTree: dynamicTargetSources[platform].sourceTree,
          sourceCandidate: dynamicTargetSources[platform].sourceCandidate,
        },
        {
          product: PRODUCT,
          platform,
          kind: "npm-package",
          assetId: 8002 + index * 2,
          releaseId: 7070,
          tag: "v0.7.0",
          name: npmName,
          bytes: npmBytes.length,
          sha256: npmSha,
          integrity: `sha256-${createHash("sha256").update(npmBytes).digest("base64")}`,
          apiUrl: `https://api.github.com/repos/${REPOSITORY}/releases/assets/${8002 + index * 2}`,
          sourceCommit: dynamicTargetSources[platform].sourceCommit,
          sourceTree: dynamicTargetSources[platform].sourceTree,
          sourceCandidate: dynamicTargetSources[platform].sourceCandidate,
        },
      );
    }

    const nativePackageTool = realpathSync(join(tools, "native-rc-package.mjs"));
    const verifyProcess = spawnSync(
      process.execPath,
      [
        nativePackageTool,
        "verify",
        "--package-root",
        join(temp, "stage-npm-linux-x64", "package"),
        "--platform",
        "linux-x64",
        "--manifest-sha256",
        dynamicTargetSources["linux-x64"].packageManifestSha256,
      ],
      { encoding: "utf8" },
    );
    assert.equal(verifyProcess.status, 0);
    assert.equal(verifyProcess.stderr, "");
    assert.equal(verifyProcess.stdout.length > 0, true, JSON.stringify(verifyProcess));
    const verifyOutput = JSON.parse(verifyProcess.stdout);
    assert.equal(verifyOutput.status, "pass");
    assert.equal(verifyOutput.members > 0, true);

    const invalidVerifyProcess = spawnSync(
      process.execPath,
      [
        nativePackageTool,
        "verify",
        "--package-root",
        join(temp, "stage-npm-linux-x64", "package"),
        "--platform",
        "unsupported-platform",
        "--manifest-sha256",
        dynamicTargetSources["linux-x64"].packageManifestSha256,
      ],
      { encoding: "utf8" },
    );
    assert.equal(invalidVerifyProcess.status, 1);
    assert.equal(invalidVerifyProcess.stdout, "");
    assert.match(invalidVerifyProcess.stderr, /unsupported platform|platform/i);

    // Update mock tools with dynamic executable digests BEFORE committing checkoutDir
    await writeFile(
      join(tools, "native-rc-qualify.mjs"),
      qualifyScript
        .replace("__LINUX_X64_EXE__", dynamicTargetSources["linux-x64"].executableSha256)
        .replace("__LINUX_ARM64_EXE__", dynamicTargetSources["linux-arm64"].executableSha256),
    );
    await writeFile(
      join(tools, "native-rc-smoke.mjs"),
      smokeScript
        .replace("__DARWIN_ARM64_EXE__", dynamicTargetSources["darwin-arm64"].executableSha256)
        .replace("__LINUX_ARM64_EXE__", dynamicTargetSources["linux-arm64"].executableSha256)
        .replace("__LINUX_X64_EXE__", dynamicTargetSources["linux-x64"].executableSha256),
    );

    execFileSync("git", ["add", "."], { cwd: checkoutDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: checkoutDir });
    const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkoutDir, encoding: "utf8" }).trim();
    const actualTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: checkoutDir, encoding: "utf8" }).trim();
    const canonicalCheckoutDir = realpathSync(checkoutDir);
    const actualListing = execFileSync("git", ["ls-tree", "-r", "-l", "-z", "--full-tree", "HEAD"], { cwd: checkoutDir });
    const actualParsed = sourceInventoryFromGitListing(actualListing);
    const actualPayload = {
      schema: actualParsed.schema,
      status: actualParsed.status,
      kind: actualParsed.kind,
      tree: actualTree,
      fileCount: actualParsed.fileCount,
      totalBytes: actualParsed.totalBytes,
      inventorySha256: actualParsed.inventorySha256,
    };
    const actualOfferBody = {
      ...correspondingSourceOfferBody,
      commit: actualCommit,
      tree: actualTree,
    };
    const actualOffer = {
      ...actualOfferBody,
      manifestSha256: sha256(Buffer.from(canonical(actualOfferBody))),
    };
    const dynamicDarwinQualReceipt = makeQualificationReceipt("darwin-arm64", dynamicTargetSources["darwin-arm64"]);
    const dynamicDarwinQualReceiptSha = sha256(Buffer.from(canonical(dynamicDarwinQualReceipt)));
    const dynamicDarwinQualReceiptBytes = Buffer.from(canonical(dynamicDarwinQualReceipt), "utf8");
    const dynamicDarwinQualReceiptRawSha = sha256(dynamicDarwinQualReceiptBytes);

    const dynamicInput = {
      ...input,
      source: {
        contract: SOURCE_CONTRACT,
        status: "accepted",
        repository: REPOSITORY,
        commit: actualCommit,
        tree: actualTree,
        readback: {
          status: "pass",
          repository: REPOSITORY,
          commit: actualCommit,
          tree: actualTree,
          payload: actualPayload,
          manifestSha256: sha256(Buffer.from(canonical(actualPayload))),
        },
        correspondingSourceOffer: actualOffer,
        trustedReadback: {
          ...input.source.trustedReadback,
          darwinQualificationReceipt: {
            bytes: dynamicDarwinQualReceiptBytes.length,
            sha256: dynamicDarwinQualReceiptRawSha,
            canonicalSha256: dynamicDarwinQualReceiptSha,
          },
        },
        targetSourceReadbacks: input.source.targetSourceReadbacks,
      },
      targetSources: dynamicTargetSources,
      assets: dynamicAssets,
      qualifications: {
        "darwin-arm64": {
          mode: "existing-qualified",
          status: "pass",
          receiptSha256: dynamicDarwinQualReceiptSha,
          receipt: dynamicDarwinQualReceipt,
          executableSha256: dynamicTargetSources["darwin-arm64"].executableSha256,
          nativePayloadSha256: dynamicTargetSources["darwin-arm64"].nativePayloadSha256,
          sourceCommit: darwinCommit,
          sourceTree: darwinTree,
          sourceCandidate: darwinCandidate,
          rawSha256: dynamicAssets[0].sha256,
          npmSha256: dynamicAssets[1].sha256,
        },
      },
    };
    await writeFile(trustedDarwinReceiptPath, dynamicDarwinQualReceiptBytes);
    const externalDescriptorPath = join(temp, "late-bound-consumer-input.json");
    const externalDescriptorBytes = Buffer.from(JSON.stringify(dynamicInput, null, 2));
    await writeFile(externalDescriptorPath, externalDescriptorBytes);

    const trustedReadbackOptions = {
      inputPath: externalDescriptorPath,
      checkout: checkoutDir,
      sourceArchivePath: trustedSourceArchivePath,
      darwinSourceArchivePath: trustedDarwinSourceArchivePath,
      linuxSourceArchivePath: trustedLinuxSourceArchivePath,
      darwinReceiptPath: trustedDarwinReceiptPath,
    };
    const admission = resolveSourceAdmission(dynamicInput, checkoutDir, trustedReadbackOptions);
    assert.equal(admission.status, "pass");
    assert.equal(admission.darwinQualificationReceiptSha256, dynamicDarwinQualReceiptSha);
    assert.equal(admission.trustedReadback.sourceArchive.sha256, sourceArchiveReadbackSha256);
    assert.equal(admission.trustedReadback.darwinAppSource.sha256, sha256(darwinSourceReadbackBytes));
    assert.equal(admission.trustedReadback.linuxAppSource.sha256, sha256(linuxSourceReadbackBytes));
    assert.equal(verifyAdmissionReceipt(admission, dynamicInput, trustedReadbackOptions).commit, actualCommit);

    // Descriptor-bound trusted readbacks refuse deterministic pathname substitutions,
    // non-regular FIFOs, privilege bits, and changed bytes without waiting on a FIFO.
    const sourceOfferLinkTarget = join(trustedReadbackDir, "source-offer-copy.tar.gz");
    await writeFile(sourceOfferLinkTarget, sourceArchiveReadbackBytes);
    await rm(trustedSourceArchivePath);
    await symlink(sourceOfferLinkTarget, trustedSourceArchivePath);
    assert.throws(
      () => resolveSourceAdmission(dynamicInput, checkoutDir, trustedReadbackOptions),
      /source archive readback is not a bounded regular file/,
    );
    await rm(trustedSourceArchivePath);
    await mkdir(trustedSourceArchivePath);
    assert.throws(
      () => resolveSourceAdmission(dynamicInput, checkoutDir, trustedReadbackOptions),
      /source archive readback is not a bounded regular file/,
    );
    await rm(trustedSourceArchivePath, { recursive: true });
    execFileSync("mkfifo", [trustedSourceArchivePath]);
    assert.throws(
      () => resolveSourceAdmission(dynamicInput, checkoutDir, trustedReadbackOptions),
      /source archive readback is not a bounded regular file/,
    );
    await rm(trustedSourceArchivePath);
    await writeFile(trustedSourceArchivePath, Buffer.from("changed-before-read\n"));
    assert.throws(
      () => resolveSourceAdmission(dynamicInput, checkoutDir, trustedReadbackOptions),
      /source archive readback bytes or SHA-256/,
    );
    await writeFile(trustedSourceArchivePath, sourceArchiveReadbackBytes);

    const validateInputResult = (inputPath) => spawnSync(
      process.execPath,
      [CONSUMER_TOOL_PATH, "validate", "--input", inputPath],
      { encoding: "utf8", timeout: 5000 },
    );
    const descriptorLink = join(temp, "descriptor-link.json");
    await symlink(externalDescriptorPath, descriptorLink);
    const descriptorLinkResult = validateInputResult(descriptorLink);
    assert.equal(descriptorLinkResult.error, undefined);
    assert.notEqual(descriptorLinkResult.status, 0);
    assert.match(descriptorLinkResult.stderr, /JSON input is not a bounded regular file/);
    await rm(descriptorLink);
    const descriptorFifo = join(temp, "descriptor.fifo");
    execFileSync("mkfifo", [descriptorFifo]);
    const descriptorFifoResult = validateInputResult(descriptorFifo);
    assert.equal(descriptorFifoResult.error, undefined);
    assert.notEqual(descriptorFifoResult.status, 0);
    assert.match(descriptorFifoResult.stderr, /JSON input is not a bounded regular file/);
    await rm(descriptorFifo);
    await chmod(externalDescriptorPath, 0o4644);
    const descriptorModeResult = validateInputResult(externalDescriptorPath);
    assert.equal(descriptorModeResult.error, undefined);
    assert.notEqual(descriptorModeResult.status, 0);
    assert.match(descriptorModeResult.stderr, /JSON input has unexpected privilege bits/);
    await chmod(externalDescriptorPath, 0o644);
    await writeFile(externalDescriptorPath, Buffer.from("{\n"));
    const descriptorMutationResult = validateInputResult(externalDescriptorPath);
    assert.equal(descriptorMutationResult.error, undefined);
    assert.notEqual(descriptorMutationResult.status, 0);
    assert.match(descriptorMutationResult.stderr, /JSON input is invalid/);
    await writeFile(externalDescriptorPath, externalDescriptorBytes);

    assert.throws(
      () => resolveSourceAdmission(dynamicInput, checkoutDir, { ...trustedReadbackOptions, inputPath: join(checkoutDir, "tracked-descriptor.json") }),
      /self-inventory hash cycle refused/,
    );
    await writeFile(join(trustedReadbackDir, "tampered-source-offer.tar.gz"), Buffer.from("tampered\n"));
    assert.throws(
      () => resolveSourceAdmission(dynamicInput, checkoutDir, { ...trustedReadbackOptions, sourceArchivePath: join(trustedReadbackDir, "tampered-source-offer.tar.gz") }),
      /source archive readback bytes or SHA-256/,
    );
    assert.throws(
      () => resolveSourceAdmission(dynamicInput, checkoutDir, { ...trustedReadbackOptions, darwinSourceArchivePath: join(trustedReadbackDir, "tampered-source-offer.tar.gz") }),
      /Darwin app source readback bytes or SHA-256/,
    );
    assert.throws(
      () => resolveSourceAdmission(dynamicInput, checkoutDir, { ...trustedReadbackOptions, linuxSourceArchivePath: join(trustedReadbackDir, "tampered-source-offer.tar.gz") }),
      /Linux app source readback bytes or SHA-256/,
    );
    assert.throws(
      () => verifyAdmissionReceipt({ ...admission, correspondingSourceOfferSha256: digest("9") }, dynamicInput, trustedReadbackOptions),
      /corresponding-source offer readback is missing or mismatched/,
    );
    assert.throws(
      () => verifyAdmissionReceipt({ ...admission, darwinQualificationReceiptSha256: digest("9") }, dynamicInput, trustedReadbackOptions),
      /Darwin existing-qualified receiptSha256 readback is missing or mismatched/,
    );

    // Verify resolveAssetsDir resolves nested download-artifact directory layout
    assert.equal(resolveAssetsDir(assetsDir), nestedArtifactDir);
    assert.equal(resolveAssetsDir(nestedArtifactDir), nestedArtifactDir);

    // Direct qualifyPlatform call for darwin-arm64 and linux-arm64 using nested assetsDir
    const receiptsOutDir = join(temp, "receipts");
    const darwinReceipt = await qualifyPlatform(
      dynamicInput,
      assetsDir,
      "darwin-arm64",
      canonicalCheckoutDir,
      receiptsOutDir,
      trustedReadbackOptions,
    );
    assert.equal(darwinReceipt.qualification.sourceCommit, darwinCommit);
    assert.equal(darwinReceipt.source.commit, actualCommit);
    assert.equal(darwinReceipt.qualificationReceipt.nativePayload, null);
    assert.equal(
      darwinReceipt.qualification.nativePayloadSha256,
      dynamicTargetSources["darwin-arm64"].nativePayloadSha256,
    );
    assert.deepEqual(darwinReceipt.qualification.nativePayload, {
      identity: dynamicTargetSources["darwin-arm64"].nativePayloadSha256,
      files: 2,
    });

    // Negative Darwin raw payload inventory checks: must refuse BEFORE any command invocation or qualification acceptance.
    // A checkout with missing/broken command scripts proves qualifyPlatform fails before packageVerify or smoke commands run.
    const noCommandCheckout = join(temp, "no-command-checkout");
    const noCommandMarker = join(temp, "unexpected-command-invoked.txt");
    await mkdir(join(noCommandCheckout, "tools"), { recursive: true });
    for (const scriptName of ["native-rc-package.mjs", "native-rc-qualify.mjs", "native-rc-smoke.mjs"]) {
      await writeFile(
        join(noCommandCheckout, "tools", scriptName),
        `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(noCommandMarker)}, ${JSON.stringify(scriptName)});\nprocess.exit(99);\n`,
      );
    }

    // 1. Wrong expected Darwin nativePayloadSha256 (while executableSha256, packageManifestSha256, and null-payload Darwin receipt all match)
    const wrongExpectedDarwinPayload = digest("9");
    const wrongExpectedDarwinInput = {
      ...dynamicInput,
      targetSources: {
        ...dynamicTargetSources,
        "darwin-arm64": {
          ...dynamicTargetSources["darwin-arm64"],
          nativePayloadSha256: wrongExpectedDarwinPayload,
        },
      },
      qualifications: {
        ...dynamicInput.qualifications,
        "darwin-arm64": {
          ...dynamicInput.qualifications["darwin-arm64"],
          nativePayloadSha256: wrongExpectedDarwinPayload,
        },
      },
    };
    const wrongExpectedOutDir = join(temp, "receipts-wrong-expected-darwin");
    await assert.rejects(
      () =>
        qualifyPlatform(
          wrongExpectedDarwinInput,
          assetsDir,
          "darwin-arm64",
          noCommandCheckout,
          wrongExpectedOutDir,
          trustedReadbackOptions,
        ),
      /extracted raw Darwin native payload inventory identity .* does not match targetSources\.darwin-arm64\.nativePayloadSha256/,
    );
    await assert.rejects(() => readFile(noCommandMarker, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(join(wrongExpectedOutDir, "darwin-arm64.consumer-receipt.json"), "utf8"), {
      code: "ENOENT",
    });

    // 2. Tampered raw Darwin payload member outside the GUI executable (executableSha256 and npm packageManifestSha256 remain intact)
    const tamperedDarwinStage = join(temp, "stage-raw-darwin-tampered");
    const tamperedDarwinExeFile = join(tamperedDarwinStage, PLATFORMS["darwin-arm64"].rawExecutable);
    await mkdir(join(tamperedDarwinExeFile, ".."), { recursive: true });
    await writeFile(tamperedDarwinExeFile, makeNativeExecutableBytes("darwin-arm64"), { mode: 0o755 });
    const tamperedDarwinResDir = join(tamperedDarwinStage, PLATFORMS["darwin-arm64"].rawRoot, "Contents/Resources");
    await mkdir(tamperedDarwinResDir, { recursive: true });
    await writeFile(join(tamperedDarwinResDir, "resource-marker.txt"), "darwin-resource-TAMPERED\n", { mode: 0o644 });

    const tamperedAssetsDir = join(temp, "assets-darwin-tampered");
    await mkdir(join(tamperedAssetsDir, "raw", "darwin-arm64"), { recursive: true });
    await mkdir(join(tamperedAssetsDir, "npm", "darwin-arm64"), { recursive: true });
    for (const platform of ["linux-arm64", "linux-x64"]) {
      await mkdir(join(tamperedAssetsDir, "raw", platform), { recursive: true });
      await mkdir(join(tamperedAssetsDir, "npm", platform), { recursive: true });
      const rawRow = dynamicAssets.find((row) => row.platform === platform && row.kind === "raw-archive");
      const npmRow = dynamicAssets.find((row) => row.platform === platform && row.kind === "npm-package");
      await copyFile(join(nestedArtifactDir, "raw", platform, rawRow.name), join(tamperedAssetsDir, "raw", platform, rawRow.name));
      await copyFile(join(nestedArtifactDir, "npm", platform, npmRow.name), join(tamperedAssetsDir, "npm", platform, npmRow.name));
    }
    const darwinNpmRow = dynamicAssets.find((row) => row.platform === "darwin-arm64" && row.kind === "npm-package");
    await copyFile(
      join(nestedArtifactDir, "npm", "darwin-arm64", darwinNpmRow.name),
      join(tamperedAssetsDir, "npm", "darwin-arm64", darwinNpmRow.name),
    );
    const darwinRawRow = dynamicAssets.find((row) => row.platform === "darwin-arm64" && row.kind === "raw-archive");
    const tamperedDarwinRawPath = join(tamperedAssetsDir, "raw", "darwin-arm64", darwinRawRow.name);
    execFileSync(
      "tar",
      ["-czf", tamperedDarwinRawPath, "-C", tamperedDarwinStage, PLATFORMS["darwin-arm64"].rawRoot],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );
    const tamperedDarwinRawBytes = await readFile(tamperedDarwinRawPath);
    const tamperedDarwinRawSha = sha256(tamperedDarwinRawBytes);
    const tamperedDarwinInput = {
      ...dynamicInput,
      assets: dynamicAssets.map((row) =>
        row.platform === "darwin-arm64" && row.kind === "raw-archive"
          ? {
              ...row,
              bytes: tamperedDarwinRawBytes.length,
              sha256: tamperedDarwinRawSha,
              integrity: `sha256-${createHash("sha256").update(tamperedDarwinRawBytes).digest("base64")}`,
            }
          : row,
      ),
      qualifications: {
        ...dynamicInput.qualifications,
        "darwin-arm64": {
          ...dynamicInput.qualifications["darwin-arm64"],
          rawSha256: tamperedDarwinRawSha,
        },
      },
    };
    const tamperedDarwinOutDir = join(temp, "receipts-tampered-darwin");
    await assert.rejects(
      () =>
        qualifyPlatform(
          tamperedDarwinInput,
          tamperedAssetsDir,
          "darwin-arm64",
          noCommandCheckout,
          tamperedDarwinOutDir,
          trustedReadbackOptions,
        ),
      /extracted raw Darwin native payload inventory identity .* does not match targetSources\.darwin-arm64\.nativePayloadSha256/,
    );
    await assert.rejects(() => readFile(noCommandMarker, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(join(tamperedDarwinOutDir, "darwin-arm64.consumer-receipt.json"), "utf8"), {
      code: "ENOENT",
    });

    // 3. Uncontained root sibling outside Theme Forge Nebular Fusion.app in Darwin raw root refused
    const uncontainedDarwinStage = join(temp, "stage-raw-darwin-uncontained");
    await mkdir(join(uncontainedDarwinStage, PLATFORMS["darwin-arm64"].rawRoot, "Contents/MacOS"), { recursive: true });
    await writeFile(
      join(uncontainedDarwinStage, PLATFORMS["darwin-arm64"].rawExecutable),
      makeNativeExecutableBytes("darwin-arm64"),
      { mode: 0o755 },
    );
    await writeFile(join(uncontainedDarwinStage, "stray-outside-app.txt"), "stray\n", { mode: 0o644 });
    await assert.rejects(
      () =>
        verifyExtractedDarwinRawPayload(
          uncontainedDarwinStage,
          dynamicTargetSources["darwin-arm64"],
          dynamicInput.qualifications["darwin-arm64"],
        ),
      /must contain only 'Theme Forge Nebular Fusion\.app'/,
    );

    const linuxArmReceipt = await qualifyPlatform(
      dynamicInput,
      assetsDir,
      "linux-arm64",
      canonicalCheckoutDir,
      receiptsOutDir,
      trustedReadbackOptions,
    );
    assert.equal(linuxArmReceipt.qualification.sourceCommit, linuxCommit);
    assert.equal(linuxArmReceipt.qualification.resourceComparison, "raw-vs-npm-cross-check");
    assert.equal(linuxArmReceipt.smoke.length, 2);

    // Subprocess CLI tests for validate, admit-source, verify-assets, qualify (linux-x64), and receipt
    const validateOut = JSON.parse(
      execFileSync(process.execPath, [CONSUMER_TOOL_PATH, "validate", "--input", externalDescriptorPath], {
        encoding: "utf8",
      }).trim(),
    );
    assert.equal(validateOut.status, "pass");

    const cliAdmissionPath = join(temp, "cli-admission.json");
    const admitOut = JSON.parse(
      execFileSync(
        process.execPath,
        [
          CONSUMER_TOOL_PATH,
          "admit-source",
          "--input",
          externalDescriptorPath,
          "--checkout",
          checkoutDir,
          "--output",
          cliAdmissionPath,
          "--source-archive",
          trustedSourceArchivePath,
          "--darwin-source-archive",
          trustedDarwinSourceArchivePath,
          "--linux-source-archive",
          trustedLinuxSourceArchivePath,
          "--darwin-receipt",
          trustedDarwinReceiptPath,
        ],
        { encoding: "utf8" },
      ).trim(),
    );
    assert.equal(admitOut.status, "pass");

    const verifyAssetsPath = join(temp, "cli-verify-assets.json");
    const verifyAssetsOut = JSON.parse(
      execFileSync(
        process.execPath,
        [
          CONSUMER_TOOL_PATH,
          "verify-assets",
          "--input",
          externalDescriptorPath,
          "--assets",
          assetsDir,
          "--output",
          verifyAssetsPath,
        ],
        { encoding: "utf8" },
      ).trim(),
    );
    assert.equal(verifyAssetsOut.assets, 6);

    // Write dpkg-packages.txt before running CLI qualify for linux-x64
    await writeFile(join(receiptsOutDir, "linux-x64.dpkg-packages.txt"), "libwebkit2gtk-4.1-0\t2.44.0\n", "utf8");
    const qualifyCliOut = JSON.parse(
      execFileSync(
        process.execPath,
        [
          CONSUMER_TOOL_PATH,
          "qualify",
          "--input",
          externalDescriptorPath,
          "--assets",
          assetsDir,
          "--platform",
          "linux-x64",
          "--checkout",
          canonicalCheckoutDir,
          "--source-archive",
          trustedSourceArchivePath,
          "--darwin-source-archive",
          trustedDarwinSourceArchivePath,
          "--linux-source-archive",
          trustedLinuxSourceArchivePath,
          "--darwin-receipt",
          trustedDarwinReceiptPath,
          "--output",
          receiptsOutDir,
        ],
        { encoding: "utf8", env: { ...process.env, PATH: `${binDir}:${previousPath}` } },
      ).trim(),
    );
    assert.equal(qualifyCliOut.status, "pass");
    assert.equal(qualifyCliOut.platform, "linux-x64");
    const linuxX64Receipt = JSON.parse(await readFile(join(receiptsOutDir, "linux-x64.consumer-receipt.json"), "utf8"));
    assert.equal(linuxX64Receipt.qualification.resourceComparison, "raw-vs-npm-cross-check");
    assert.equal(typeof linuxX64Receipt.dpkgPackagesSha256, "string");
    assert.equal(linuxX64Receipt.smoke.length, 4);

    // Aggregate consumer receipt via CLI subcommand
    const aggregateReceiptPath = join(receiptsOutDir, "consumer-receipt.json");
    const receiptCliOut = JSON.parse(
      execFileSync(
        process.execPath,
        [
          CONSUMER_TOOL_PATH,
          "receipt",
          "--input",
          externalDescriptorPath,
          "--checkout",
          canonicalCheckoutDir,
          "--source-archive",
          trustedSourceArchivePath,
          "--darwin-source-archive",
          trustedDarwinSourceArchivePath,
          "--linux-source-archive",
          trustedLinuxSourceArchivePath,
          "--darwin-receipt",
          trustedDarwinReceiptPath,
          "--platform-receipts",
          receiptsOutDir,
          "--output",
          aggregateReceiptPath,
        ],
        { encoding: "utf8" },
      ).trim(),
    );
    assert.equal(receiptCliOut.status, "pass");
    assert.equal(receiptCliOut.schema, RECEIPT_SCHEMA);

    // End-to-end current-darwin-source qualification, aggregation, and negative readback/inventory checks
    const trustedCurrentDarwinSourceArchivePath = join(trustedReadbackDir, "current-darwin-app-source.tar.gz");
    await writeFile(trustedCurrentDarwinSourceArchivePath, currentDarwinSourceReadbackBytes);
    const currentDarwinDynamicTargetSources = {
      ...dynamicTargetSources,
      "darwin-arm64": {
        ...dynamicTargetSources["darwin-arm64"],
        authority: "current-darwin-source",
        sourceCommit: currentDarwinCommit,
        sourceTree: currentDarwinTree,
        sourceCandidate: currentDarwinCandidate,
      },
    };
    const currentDarwinDynamicAssets = dynamicAssets.map((row) =>
      row.platform === "darwin-arm64"
        ? {
            ...row,
            sourceCommit: currentDarwinCommit,
            sourceTree: currentDarwinTree,
            sourceCandidate: currentDarwinCandidate,
          }
        : row,
    );
    const currentDarwinDynamicInput = {
      ...dynamicInput,
      source: {
        ...dynamicInput.source,
        targetSourceReadbacks: {
          ...dynamicInput.source.targetSourceReadbacks,
          "darwin-arm64": {
            role: "darwin-app-source",
            sourceCandidate: currentDarwinCandidate,
            bytes: currentDarwinSourceReadbackBytes.length,
            sha256: sha256(currentDarwinSourceReadbackBytes),
          },
        },
      },
      targetSources: currentDarwinDynamicTargetSources,
      assets: currentDarwinDynamicAssets,
      qualifications: {
        "darwin-arm64": {
          mode: "existing-qualified",
          status: "pass",
          authority: "current-darwin-source",
          receiptSha256: dynamicDarwinQualReceiptSha,
          receipt: dynamicDarwinQualReceipt,
          executableSha256: currentDarwinDynamicTargetSources["darwin-arm64"].executableSha256,
          nativePayloadSha256: currentDarwinDynamicTargetSources["darwin-arm64"].nativePayloadSha256,
          sourceCommit: currentDarwinCommit,
          sourceTree: currentDarwinTree,
          sourceCandidate: currentDarwinCandidate,
          rawSha256: currentDarwinDynamicAssets[0].sha256,
          npmSha256: currentDarwinDynamicAssets[1].sha256,
        },
      },
    };
    const currentDarwinExternalDescriptorPath = join(temp, "late-bound-current-darwin-consumer-input.json");
    await writeFile(currentDarwinExternalDescriptorPath, JSON.stringify(currentDarwinDynamicInput, null, 2));
    const currentDarwinReadbackOptions = {
      ...trustedReadbackOptions,
      inputPath: currentDarwinExternalDescriptorPath,
      darwinSourceArchivePath: trustedCurrentDarwinSourceArchivePath,
    };
    const currentDarwinAdmission = resolveSourceAdmission(
      currentDarwinDynamicInput,
      checkoutDir,
      currentDarwinReadbackOptions,
    );
    assert.equal(currentDarwinAdmission.status, "pass");
    assert.equal(
      currentDarwinAdmission.trustedReadback.darwinAppSource.sourceCandidate,
      currentDarwinCandidate,
    );
    assert.equal(
      verifyAdmissionReceipt(
        currentDarwinAdmission,
        currentDarwinDynamicInput,
        currentDarwinReadbackOptions,
      ).commit,
      actualCommit,
    );
    assert.throws(
      () =>
        resolveSourceAdmission(currentDarwinDynamicInput, checkoutDir, {
          ...currentDarwinReadbackOptions,
          darwinSourceArchivePath: join(trustedReadbackDir, "tampered-source-offer.tar.gz"),
        }),
      /Darwin app source readback bytes or SHA-256/,
    );
    assert.throws(
      () =>
        resolveSourceAdmission(currentDarwinDynamicInput, checkoutDir, {
          ...currentDarwinReadbackOptions,
          darwinReceiptPath: join(trustedReadbackDir, "tampered-source-offer.tar.gz"),
        }),
      /Darwin qualification readback bytes or SHA-256/,
    );

    const currentDarwinReceiptsOutDir = join(temp, "receipts-current-darwin");
    const currentDarwinPlatformReceipt = await qualifyPlatform(
      currentDarwinDynamicInput,
      assetsDir,
      "darwin-arm64",
      canonicalCheckoutDir,
      currentDarwinReceiptsOutDir,
      {
        ...currentDarwinReadbackOptions,
        trustedReadback: currentDarwinAdmission.trustedReadback,
      },
    );
    assert.equal(currentDarwinPlatformReceipt.compilerSource.authority, "current-darwin-source");
    assert.equal(currentDarwinPlatformReceipt.qualification.authority, "current-darwin-source");
    assert.equal(currentDarwinPlatformReceipt.qualification.sourceCommit, currentDarwinCommit);
    assert.equal(currentDarwinPlatformReceipt.qualificationReceipt.nativePayload, null);
    assert.deepEqual(currentDarwinPlatformReceipt.qualification.nativePayload, {
      identity: currentDarwinDynamicTargetSources["darwin-arm64"].nativePayloadSha256,
      files: 2,
    });
    assert.equal(currentDarwinPlatformReceipt.smoke.length, 2);

    const adaptLinuxReceiptForCurrentDarwin = (linuxReceipt) => ({
      ...linuxReceipt,
      source: {
        ...linuxReceipt.source,
        targetSourceReadbacks: currentDarwinAdmission.targetSourceReadbacks,
      },
      transport: linuxReceipt.transport.map((entry) =>
        entry.platform === "darwin-arm64"
          ? {
              ...entry,
              sourceCommit: currentDarwinCommit,
              sourceTree: currentDarwinTree,
              sourceCandidate: currentDarwinCandidate,
            }
          : entry,
      ),
    });
    const currentDarwinAggregateReceipt = buildConsumerReceipt(
      currentDarwinDynamicInput,
      {
        "darwin-arm64": currentDarwinPlatformReceipt,
        "linux-arm64": adaptLinuxReceiptForCurrentDarwin(linuxArmReceipt),
        "linux-x64": adaptLinuxReceiptForCurrentDarwin(linuxX64Receipt),
      },
      currentDarwinReadbackOptions,
    );
    assert.equal(currentDarwinAggregateReceipt.schema, RECEIPT_SCHEMA);
    assert.equal(currentDarwinAggregateReceipt.targetSources["darwin-arm64"].authority, "current-darwin-source");
    assert.equal(
      currentDarwinAggregateReceipt.platforms.find((row) => row.platform === "darwin-arm64").qualification.authority,
      "current-darwin-source",
    );

    const tamperedCurrentDarwinInput = {
      ...currentDarwinDynamicInput,
      assets: currentDarwinDynamicAssets.map((row) =>
        row.platform === "darwin-arm64" && row.kind === "raw-archive"
          ? {
              ...row,
              bytes: tamperedDarwinRawBytes.length,
              sha256: tamperedDarwinRawSha,
              integrity: `sha256-${createHash("sha256").update(tamperedDarwinRawBytes).digest("base64")}`,
            }
          : row,
      ),
      qualifications: {
        "darwin-arm64": {
          ...currentDarwinDynamicInput.qualifications["darwin-arm64"],
          rawSha256: tamperedDarwinRawSha,
        },
      },
    };
    const tamperedCurrentDarwinOutDir = join(temp, "receipts-tampered-current-darwin");
    await assert.rejects(
      () =>
        qualifyPlatform(
          tamperedCurrentDarwinInput,
          tamperedAssetsDir,
          "darwin-arm64",
          noCommandCheckout,
          tamperedCurrentDarwinOutDir,
          currentDarwinReadbackOptions,
        ),
      /extracted raw Darwin native payload inventory identity .* does not match targetSources\.darwin-arm64\.nativePayloadSha256/,
    );
    await assert.rejects(() => readFile(noCommandMarker, "utf8"), { code: "ENOENT" });
    await assert.rejects(
      () => readFile(join(tamperedCurrentDarwinOutDir, "darwin-arm64.consumer-receipt.json"), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    process.env.PATH = previousPath;
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}

// Receipt & manifest unit validation checks
// Positive check: Darwin non-null nativePayload matching targetSources.darwin-arm64.nativePayloadSha256 is also accepted
assert.equal(
  validateQualificationReceipt(
    {
      ...darwinQualReceipt,
      nativePayload: { identity: targetSources["darwin-arm64"].nativePayloadSha256, files: 12 },
    },
    "darwin-arm64",
    targetSources["darwin-arm64"],
  ).platform,
  "darwin-arm64",
);
// Darwin wrong executableSha256 refused
assert.throws(
  () =>
    validateQualificationReceipt(
      {
        ...darwinQualReceipt,
        executableSha256: digest("0"),
      },
      "darwin-arm64",
      targetSources["darwin-arm64"],
    ),
  /failed schema, status, or executableSha256 check for darwin-arm64/,
);
// Darwin wrong executable-header check detail refused
assert.throws(
  () =>
    validateQualificationReceipt(
      {
        ...darwinQualReceipt,
        checks: darwinQualReceipt.checks.map((check) =>
          check.id === "executable-header" ? { ...check, detail: digest("0") } : check,
        ),
      },
      "darwin-arm64",
      targetSources["darwin-arm64"],
    ),
  /executable-header check detail does not match/,
);
// Darwin unknown check ID refused
assert.throws(
  () =>
    validateQualificationReceipt(
      {
        ...darwinQualReceipt,
        checks: [...darwinQualReceipt.checks, { id: "unknown-check", ok: true, detail: "ok" }],
      },
      "darwin-arm64",
      targetSources["darwin-arm64"],
    ),
  /contains unknown or duplicate check 'unknown-check'/,
);
// Darwin missing nativePayload property refused
assert.throws(
  () => {
    const { nativePayload: _omitted, ...withoutNativePayload } = darwinQualReceipt;
    return validateQualificationReceipt(withoutNativePayload, "darwin-arm64", targetSources["darwin-arm64"]);
  },
  /nativePayload is missing for darwin-arm64/,
);
// Darwin undefined nativePayload refused
assert.throws(
  () =>
    validateQualificationReceipt(
      {
        ...darwinQualReceipt,
        nativePayload: undefined,
      },
      "darwin-arm64",
      targetSources["darwin-arm64"],
    ),
  /nativePayload is missing for darwin-arm64/,
);
// Darwin arbitrary/unknown nativePayload object refused
assert.throws(
  () =>
    validateQualificationReceipt(
      {
        ...darwinQualReceipt,
        nativePayload: { identity: targetSources["darwin-arm64"].nativePayloadSha256, files: 12, unknownField: true },
      },
      "darwin-arm64",
      targetSources["darwin-arm64"],
    ),
  /contains unknown or missing keys/,
);
// Darwin mismatched non-null nativePayload.identity refused
assert.throws(
  () =>
    validateQualificationReceipt(
      {
        ...darwinQualReceipt,
        nativePayload: { identity: digest("z"), files: 12 },
      },
      "darwin-arm64",
      targetSources["darwin-arm64"],
    ),
  /nativePayload\.identity does not match targetSources\.darwin-arm64\.nativePayloadSha256/,
);
// Darwin non-null or missing materialDigest / glibcMinimum refused
assert.throws(
  () =>
    validateQualificationReceipt(
      {
        ...darwinQualReceipt,
        materialDigest: digest("a"),
      },
      "darwin-arm64",
      targetSources["darwin-arm64"],
    ),
  /materialDigest must be null for darwin-arm64/,
);
assert.throws(
  () => {
    const { materialDigest: _omitted, ...withoutMaterialDigest } = darwinQualReceipt;
    return validateQualificationReceipt(withoutMaterialDigest, "darwin-arm64", targetSources["darwin-arm64"]);
  },
  /materialDigest must be null for darwin-arm64/,
);
assert.throws(
  () =>
    validateQualificationReceipt(
      {
        ...darwinQualReceipt,
        glibcMinimum: "2.36",
      },
      "darwin-arm64",
      targetSources["darwin-arm64"],
    ),
  /glibcMinimum must be null for darwin-arm64/,
);
assert.throws(
  () => {
    const { glibcMinimum: _omitted, ...withoutGlibcMinimum } = darwinQualReceipt;
    return validateQualificationReceipt(withoutGlibcMinimum, "darwin-arm64", targetSources["darwin-arm64"]);
  },
  /glibcMinimum must be null for darwin-arm64/,
);
// Linux null, missing, and unknown-key nativePayload refused
assert.throws(
  () =>
    validateQualificationReceipt(
      {
        schema: QUALIFICATION_RECEIPT_SCHEMA,
        platform: "linux-x64",
        status: "pass",
        executableSha256: targetSources["linux-x64"].executableSha256,
        nativePayload: null,
        checks: makeQualificationChecks("linux-x64"),
        glibcMinimum: "2.36",
      },
      "linux-x64",
      targetSources["linux-x64"],
    ),
  /must be a non-null object; nativePayload\.identity does not match targetSources\.linux-x64\.nativePayloadSha256/,
);
assert.throws(
  () =>
    validateQualificationReceipt(
      {
        schema: QUALIFICATION_RECEIPT_SCHEMA,
        platform: "linux-arm64",
        status: "pass",
        executableSha256: targetSources["linux-arm64"].executableSha256,
        nativePayload: null,
        checks: makeQualificationChecks("linux-arm64"),
        glibcMinimum: "2.36",
      },
      "linux-arm64",
      targetSources["linux-arm64"],
    ),
  /must be a non-null object; nativePayload\.identity does not match targetSources\.linux-arm64\.nativePayloadSha256/,
);
assert.throws(
  () =>
    validateQualificationReceipt(
      {
        schema: QUALIFICATION_RECEIPT_SCHEMA,
        platform: "linux-x64",
        status: "pass",
        executableSha256: targetSources["linux-x64"].executableSha256,
        checks: makeQualificationChecks("linux-x64"),
        glibcMinimum: "2.36",
      },
      "linux-x64",
      targetSources["linux-x64"],
    ),
  /nativePayload is missing for linux-x64/,
);
assert.throws(
  () =>
    validateQualificationReceipt(
      {
        schema: QUALIFICATION_RECEIPT_SCHEMA,
        platform: "linux-x64",
        status: "pass",
        executableSha256: targetSources["linux-x64"].executableSha256,
        nativePayload: { identity: targetSources["linux-x64"].nativePayloadSha256, files: 1, unknown: true },
        checks: makeQualificationChecks("linux-x64"),
        glibcMinimum: "2.36",
      },
      "linux-x64",
      targetSources["linux-x64"],
    ),
  /contains unknown or missing keys/,
);
assert.throws(
  () =>
    validateExtractedPackageManifest(
      {
        schema: PACKAGE_MANIFEST_SCHEMAS[0],
        package: "@knowledge-forge-ai/theme-forge-nebular-fusion-linux-x64",
        version: VERSION,
        payloadStatus: "complete",
        executable: PLATFORMS["linux-x64"].npmExecutable,
        fileCount: 1,
        members: [{ path: PLATFORMS["linux-x64"].npmExecutable, type: "file", sha256: digest("z") }],
      },
      "linux-x64",
      targetSources["linux-x64"],
    ),
  /executable digest does not match/,
);
assert.throws(
  () =>
    validateQualificationReceipt(
      {
        schema: QUALIFICATION_RECEIPT_SCHEMA,
        platform: "linux-x64",
        status: "pass",
        executableSha256: targetSources["linux-x64"].executableSha256,
        nativePayload: { identity: digest("z"), files: 1 },
        checks: makeQualificationChecks("linux-x64"),
        glibcMinimum: "2.36",
      },
      "linux-x64",
      targetSources["linux-x64"],
    ),
  /nativePayload\.identity does not match/,
);
assert.throws(
  () =>
    validateQualificationReceipt(
      {
        schema: QUALIFICATION_RECEIPT_SCHEMA,
        platform: "linux-x64",
        status: "pass",
        executableSha256: targetSources["linux-x64"].executableSha256,
        nativePayload: { identity: targetSources["linux-x64"].nativePayloadSha256, files: 1 },
        checks: [{ id: "executable-header", ok: true, detail: targetSources["linux-x64"].executableSha256 }],
        glibcMinimum: "2.36",
      },
      "linux-x64",
      targetSources["linux-x64"],
    ),
  /missing required passing check/,
);
assert.throws(
  () =>
    validateQualificationReceipt(
      {
        schema: QUALIFICATION_RECEIPT_SCHEMA,
        platform: "linux-x64",
        status: "pass",
        executableSha256: targetSources["linux-x64"].executableSha256,
        nativePayload: { identity: targetSources["linux-x64"].nativePayloadSha256, files: 1 },
        checks: makeQualificationChecks("linux-x64"),
        glibcMinimum: "2.39",
      },
      "linux-x64",
      targetSources["linux-x64"],
    ),
  /glibcMinimum 2\.39 exceeds floor 2\.36/,
);
assert.throws(
  () =>
    validateSmokeRunReport(
      {
        schema: SMOKE_RUN_SCHEMA,
        status: "pass",
        platform: "linux-x64",
        scenario: "C",
        source: "raw-archive",
        problems: [],
        executable: { sha256: targetSources["linux-x64"].executableSha256 },
        receipt: { status: "pass", sha256: digest("1") },
        finalization: { schema: SMOKE_FINALIZATION_SCHEMA, status: "failed" },
      },
      {
        platform: "linux-x64",
        scenario: "C",
        source: "raw-archive",
        executableSha256: targetSources["linux-x64"].executableSha256,
      },
    ),
  /finalization is incomplete/,
);

// Public release fetch & redirect checks
const fetchTemp = await mkdtemp(join(tmpdir(), "nebular-consumer-fetch-test-"));
try {
  const bytes = Buffer.from("x");
  const row = {
    ...assets[0],
    bytes: 1,
    sha256: sha256(bytes),
    integrity: `sha256-${createHash("sha256").update(bytes).digest("base64")}`,
  };
  const destination = join(fetchTemp, row.name);
  const result = await fetchReleaseAsset(row, destination, async (url, options) => {
    assert.equal(url, row.apiUrl);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.deepEqual(options.headers, { accept: "application/octet-stream" });
    return { status: 200, body: Readable.from([bytes]) };
  });
  assert.equal(result.readback.sha256, row.sha256);

  // Redirect to objects.githubusercontent.com succeeds
  const redirectDest = join(fetchTemp, "redirected.tar.gz");
  let hops = 0;
  const redirected = await fetchReleaseAsset(row, redirectDest, async (url) => {
    hops += 1;
    if (hops === 1) {
      return {
        status: 302,
        headers: new Map([["location", "https://objects.githubusercontent.com/github-production-release-asset/asset.tar.gz"]]),
      };
    }
    assert.equal(url, "https://objects.githubusercontent.com/github-production-release-asset/asset.tar.gz");
    return { status: 200, body: Readable.from([bytes]) };
  });
  assert.equal(redirected.readback.sha256, row.sha256);

  // Disallowed redirect host refused
  await assert.rejects(
    () =>
      fetchReleaseAsset(row, join(fetchTemp, "evil.tar.gz"), async () => ({
        status: 302,
        headers: new Map([["location", "https://evil.example.com/asset.tar.gz"]]),
      })),
    /disallowed release host/,
  );

  // HTTP downgrade refused
  assert.throws(() => validatePublicReleaseUrl("http://api.github.com/repos/x/y"), /must use https:/);

  // Bad digest refused
  await assert.rejects(
    () =>
      fetchReleaseAsset(
        { ...row, sha256: digest("q"), integrity: `sha256-${Buffer.from(digest("q"), "hex").toString("base64")}` },
        join(fetchTemp, "bad.tgz"),
        async () => ({ status: 200, body: Readable.from([bytes]) }),
      ),
    /exact byte/,
  );
} finally {
  await rm(fetchTemp, { recursive: true, force: true });
}

process.stdout.write(
  JSON.stringify({
    status: "pass",
    refusalCases: 69,
    sourceInventoryCases: 2,
    commandPlanCases: 7,
    fetchCases: 5,
    endToEndQualifyCases: 4,
    cliSubcommandCases: 5,
  }) + "\n",
);

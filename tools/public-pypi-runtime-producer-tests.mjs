import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_MANIFEST_SCHEMA,
  SOURCE_CONTRACT,
  REPOSITORY,
  SOURCE_ORIGIN_SCHEMA,
  VERSION,
  canonicalJson,
  fetchRuntimeAsset,
  sha256,
  sriForSha256,
  validateReleaseInputs,
  runtimeInputArguments,
  validateRuntimeManifest,
  validateSourceOrigin,
} from "./public-pypi-runtime-producer.mjs";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);
const digestD = "d".repeat(64);
const digestE = "e".repeat(64);
const digestF = "f".repeat(64);

function asset(target, assetId) {
  return {
    archive: { assetId, name: `runtime-input-${target}.tar.gz`, bytes: 3, sha256: digestA, integrity: sriForSha256(digestA) },
    expectedMemberListSha256: digestB,
    expectedManifestSha256: digestC,
    expectedMaterialDigest: digestD,
    correspondingSourceSha256: digestE,
    releaseAssetSha256: digestF,
  };
}
function manifest() {
  return { schema: RUNTIME_MANIFEST_SCHEMA, version: VERSION, repository: REPOSITORY, sourceContract: SOURCE_CONTRACT, runtimeToolSha256: digestA,
    assets: { "aarch64-unknown-linux-gnu": asset("aarch64-unknown-linux-gnu", 11), "x86_64-unknown-linux-gnu": asset("x86_64-unknown-linux-gnu", 22) } };
}
function expectFailure(fn, message) { assert.throws(fn, (error) => error instanceof Error && error.message.includes(message)); }

const normalized = validateRuntimeManifest(manifest());
assert.equal(normalized.schema, RUNTIME_MANIFEST_SCHEMA);
assert.match(normalized.manifestIdentity, /^[a-f0-9]{64}$/u);
const runtimeArgs = runtimeInputArguments(normalized, "x86_64-unknown-linux-gnu");
assert.deepEqual(runtimeArgs, { target: "x86_64-unknown-linux-gnu", archiveName: "runtime-input-x86_64-unknown-linux-gnu.tar.gz", archiveBytes: 3, archiveSha256: digestA, expectedMemberListSha256: digestB, expectedManifestSha256: digestC, expectedMaterialDigest: digestD, correspondingSourceSha256: digestE, releaseAssetSha256: digestF, runtimeToolSha256: digestA });
expectFailure(() => runtimeInputArguments(normalized, "darwin"), "unsupported runtime target");
expectFailure(() => validateRuntimeManifest({ ...manifest(), assets: { ...manifest().assets, "x86_64-unknown-linux-gnu": { ...asset("x86_64-unknown-linux-gnu", 22), archive: { ...asset("x86_64-unknown-linux-gnu", 22).archive, integrity: sriForSha256(digestB) } } } }), "integrity does not bind");
expectFailure(() => validateRuntimeManifest({ ...manifest(), assets: { ...manifest().assets, "aarch64-unknown-linux-gnu": { ...asset("x86_64-unknown-linux-gnu", 11) } } }), "fixed runtime archive name");
expectFailure(() => validateRuntimeManifest({ ...manifest(), runtimeToolSha256: "not-a-digest" }), "runtimeToolSha256 is invalid");

const sourceBody = {
  schema: SOURCE_ORIGIN_SCHEMA, status: "pass", contract: SOURCE_CONTRACT, repository: REPOSITORY, version: VERSION,
  source: { commit: "1".repeat(40), tree: "2".repeat(40) }, producer: { commit: "3".repeat(40), tree: "4".repeat(40) },
  ci: { provider: "github-actions", origin: "public-hosted-runner", workflow: "Public Linux portable runtime for PyPI", workflowPath: ".github/workflows/native-pypi-runtime.yml", runId: "101", runAttempt: "1", event: "workflow_dispatch", ref: "refs/heads/main" },
  runtime: { target: "x86_64-unknown-linux-gnu", manifestSha256: digestA, manifestIdentity: digestB, runtimeToolSha256: digestC, archiveAssetId: 22, archiveAssetName: "runtime-input-x86_64-unknown-linux-gnu.tar.gz", archiveSha256: digestD, archiveBytes: 3, expectedMemberListSha256: digestE, expectedManifestSha256: digestF, expectedMaterialDigest: digestA, descriptorSha256: digestB, descriptorBytes: 3, evidence: { correspondingSourceCustody: digestC, releaseAsset: digestD, runtimeMaterialArchive: digestE, runtimeMaterialManifest: digestF } },
};
assert.match(validateSourceOrigin({ ...sourceBody, identity: sha256(canonicalJson(sourceBody)) }).identity, /^[a-f0-9]{64}$/u);
expectFailure(() => validateSourceOrigin({ ...sourceBody, identity: digestF }), "does not bind");
const sameSource = { ...sourceBody, producer: { ...sourceBody.source } };
expectFailure(() => validateSourceOrigin({ ...sameSource, identity: sha256(canonicalJson(sameSource)) }), "remain distinct");
const scratch = await mkdtemp(join(tmpdir(), "nebular-public-runtime-producer-test-"));

function releaseFixture() {
  const executableSha256 = digestA;
  const materialDigest = digestD;
  const target = "x86_64-unknown-linux-gnu";
  const platform = "linux-x64";
  const projectionAlias = { path: "opt/nebular-private/libfoo.so", target: "../../lib/canonical.so", canonical: "lib/canonical.so", bytes: 3, mode: 0o644, sha256: digestB };
  const projection = { schema: "nebular-native-runtime-alias-projection-v1", materialDigest, aliases: [projectionAlias] };
  projection.digest = sha256(canonicalJson(projection));
  const payload = { schema: "nebular-native-payload-inventory-v1", materialDigest, files: [{ path: "bin/theme-forge-nebular-fusion", bytes: 3, mode: 0o755, sha256: executableSha256 }, { path: "lib/canonical.so", bytes: 3, mode: 0o644, sha256: digestB }], aliases: [{ path: projectionAlias.path, target: projectionAlias.target, canonical: projectionAlias.canonical }], directories: [] };
  const payloadIdentity = sha256(canonicalJson(payload));
  const manifest = { schema: "tfsb.nebular-package-manifest-v2", package: "@knowledge-forge-ai/theme-forge-nebular-fusion-linux-x64", version: VERSION, target: { os: "linux", cpu: "x64" }, payloadType: "linux-executable-resources", payloadRoot: "payload", executable: "payload/bin/theme-forge-nebular-fusion", payloadStatus: "complete", fileCount: 3, runtimeAliasProjection: projection, members: [{ path: "payload/bin/theme-forge-nebular-fusion", type: "file", size: 3, mode: 0o755, sha256: executableSha256 }, { path: "payload/lib/canonical.so", type: "file", size: 3, mode: 0o644, sha256: digestB }, { path: "payload/opt/nebular-private/libfoo.so", type: "file", size: 3, mode: 0o644, sha256: digestB }] };
  const origin = { ...sourceBody, runtime: { ...sourceBody.runtime, target } };
  origin.identity = sha256(canonicalJson(origin));
  const runtime = { schema: "nebular-native-runtime-material-receipt-v1", target, materialDigest, sourceCandidate: origin.identity, nativePayload: payloadIdentity, inputSha256: digestE };
  const qualified = { schema: "nebular.native-rc-qualification-v1", platform, status: "pass", executableSha256, nativePayload: { identity: payloadIdentity, files: 2 }, materialDigest, checks: [] };
  const built = { schema: "nebular.native-rc-build-receipt-v1", platform, triple: target, source: { ...origin.source }, nativePayload: { identity: payloadIdentity, files: 2 } };
  const record = { schema: "nebular.native-rc-package-v1", platform, version: VERSION, packageManifestSha256: null, npm: { filename: "package.tgz", size: 3, sha256: digestB, integrity: sriForSha256(digestB) }, raw: { filename: "raw.tar.gz", size: 3, sha256: digestC, executableSha256 } };
  return { platform, origin, runtime, qualified, built, record, manifest, smokeRuns: [
    { status: "pass", scenario: "C", source: "raw-archive", executable: { sha256: executableSha256 } },
    { status: "pass", scenario: "C-signal", source: "npm-package", executable: { sha256: executableSha256 } },
  ] };
}

const release = releaseFixture();
const releaseManifestPath = join(scratch, "package-manifest.json");
await writeFile(releaseManifestPath, `${JSON.stringify(release.manifest)}\n`);
release.record.packageManifestSha256 = sha256(await readFile(releaseManifestPath));
const validRelease = validateReleaseInputs({ ...release, packageManifest: releaseManifestPath });
assert.equal(validRelease.packagePayload.identity, release.qualified.nativePayload.identity);
assert.deepEqual(validRelease.scenarios, ["C", "C-signal"]);
const cliFiles = {
  origin: join(scratch, "source-origin.json"), runtime: join(scratch, "runtime-receipt.json"), qualification: join(scratch, "qualification.json"),
  build: join(scratch, "build-receipt.json"), record: join(scratch, "package-record.json"), smoke: join(scratch, "smoke"), output: join(scratch, "release-receipt.json"),
};
const writeJson = async (path, value) => writeFile(path, `${JSON.stringify(value)}\n`);
await mkdir(cliFiles.smoke);
await writeJson(cliFiles.origin, release.origin); await writeJson(cliFiles.runtime, release.runtime); await writeJson(cliFiles.qualification, release.qualified); await writeJson(cliFiles.build, release.built); await writeJson(cliFiles.record, release.record);
await writeJson(join(cliFiles.smoke, "c.run.json"), release.smokeRuns[0]); await writeJson(join(cliFiles.smoke, "c-signal.run.json"), release.smokeRuns[1]);
const producerPath = fileURLToPath(new URL("./public-pypi-runtime-producer.mjs", import.meta.url));
const cli = spawnSync(process.execPath, [producerPath, "release-receipt", "--platform", release.platform, "--source-origin", cliFiles.origin, "--runtime-receipt", cliFiles.runtime, "--qualification", cliFiles.qualification, "--build-receipt", cliFiles.build, "--package-record", cliFiles.record, "--package-manifest", releaseManifestPath, "--smoke-dir", cliFiles.smoke, "--output", cliFiles.output], { encoding: "utf8" });
assert.equal(cli.status, 0, cli.stderr);
assert.equal(JSON.parse(await readFile(cliFiles.output, "utf8")).status, "pass");
for (const [name, mutate, expected] of [
  ["runtime target", (value) => { value.runtime.target = "aarch64-unknown-linux-gnu"; }, "target/platform join"],
  ["runtime source candidate", (value) => { value.runtime.sourceCandidate = digestF; }, "sourceCandidate"],
  ["qualification platform", (value) => { value.qualified.platform = "linux-arm64"; }, "target/platform join"],
  ["build source", (value) => { value.built.source.commit = digestF.slice(0, 40); }, "build source"],
  ["build tree", (value) => { value.built.source.tree = digestF.slice(0, 40); }, "build source"],
  ["runtime material", (value) => { value.runtime.materialDigest = digestF; }, "runtime receipt"],
  ["runtime payload", (value) => { value.runtime.nativePayload = digestF; }, "runtime receipt"],
  ["build payload", (value) => { value.built.nativePayload.identity = digestF; }, "build and qualification"],
  ["package executable", (value) => { value.manifest.members[0].sha256 = digestF; }, "package manifest executable"],
  ["package manifest digest", (value) => { value.record.packageManifestSha256 = digestF; }, "package manifest digest"],
  ["package payload alias", (value) => { value.manifest.runtimeAliasProjection.aliases[0].target = "../escape.so"; }, "package runtime alias projection digest"],
  ["smoke status", (value) => { value.smokeRuns[0].status = "fail"; }, "smoke evidence"],
  ["smoke executable", (value) => { value.smokeRuns[1].executable.sha256 = digestF; }, "smoke evidence"],
]) {
  const candidate = releaseFixture();
  candidate.record.packageManifestSha256 = release.record.packageManifestSha256;
  mutate(candidate);
  expectFailure(() => validateReleaseInputs({ ...candidate, packageManifest: releaseManifestPath }), expected);
  assert.ok(name.length > 0);
}

try {
  const body = Buffer.from("abc"); const destination = join(scratch, "runtime.tar.gz"); const requests = [];
  const fakeFetch = async (url, options) => { requests.push({ url, options }); if (requests.length === 1) return { status: 302, headers: new Headers({ location: "https://objects.githubusercontent.com/runtime-input.tar.gz" }) }; return { status: 200, body: (async function* () { yield body.subarray(0, 1); yield body.subarray(1); })() }; };
  const archive = { ...asset("x86_64-unknown-linux-gnu", 22).archive, sha256: sha256(body), integrity: sriForSha256(sha256(body)) };
  const fetched = await fetchRuntimeAsset(archive, destination, "test-token", fakeFetch);
  assert.deepEqual(fetched.readback, { bytes: 3, sha256: sha256(body) });
  assert.equal(requests[0].options.method, "GET"); assert.equal(requests[0].options.headers.authorization, "Bearer test-token"); assert.equal(requests[1].options.headers.authorization, undefined); assert.deepEqual(await readFile(destination), body);
} finally { await rm(scratch, { recursive: true, force: true }); }

process.stdout.write("public-pypi-runtime-producer-tests: release joins, CLI, source transport, and refusal cases passed\n");

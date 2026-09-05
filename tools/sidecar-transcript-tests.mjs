import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

const transcriptSource = new URL("./sidecar-transcript.mjs", import.meta.url);
const studioRoot = resolve(import.meta.dirname, "..");
const packedBinary = join(studioRoot, "src-tauri/binaries/tfsb-studio-service-aarch64-apple-darwin");
const packedManifest = join(studioRoot, "src-tauri/sidecar-payload/manifest.json");

function sessions(transcript) {
  return [transcript.v10, transcript.v11, transcript.v12, transcript.restartedV12];
}

function assertProcessEvidence(processEvidence) {
  assert.deepEqual(processEvidence.exit, { code: 0, signal: null });
  assert.deepEqual(processEvidence.close, { code: 0, signal: null });
  assert.equal(processEvidence.stderr.byteLength, 0);
  assert.match(processEvidence.stderr.sha256, /^sha256:[0-9a-f]{64}$/u);
}

test("packed sidecar transcript validates observed protocol, capability, and process evidence", async (context) => {
  if (!existsSync(packedBinary) || !existsSync(packedManifest)) {
    context.skip("real packed sidecar evidence is produced and required by the macOS-arm64 qualification job");
    return;
  }
  const { runTranscript } = await import("./sidecar-transcript.mjs");
  const transcript = await runTranscript();
  assert.equal(transcript.schemaVersion, 2);
  assert.equal(transcript.evidenceScope, "synthetic-fixture-supplemental");
  assert.deepEqual(Object.keys(transcript).sort(), ["evidenceScope", "restartedV12", "schemaVersion", "v10", "v11", "v12"]);
  for (const session of sessions(transcript)) {
    assertProcessEvidence(session.process);
    assert.ok(Object.keys(session.successfulMethodCounts).length > 0);
    for (const count of Object.values(session.successfulMethodCounts)) assert.ok(Number.isSafeInteger(count) && count > 0);
  }

  assert.deepEqual(transcript.v10.capabilityUnavailable, {
    "brand.qa.profile.list": "METHOD_CAPABILITY_UNAVAILABLE",
    "brand.visual.evidence.get": "METHOD_CAPABILITY_UNAVAILABLE",
  });
  assert.equal(transcript.v11.rasterCapability.available, true);
  assert.equal(transcript.v12.rasterCapability.rendererBuildDigest, transcript.v11.rasterCapability.rendererBuildDigest);
  assert.equal(transcript.v12.rasterCapability.qualificationId, transcript.v11.rasterCapability.qualificationId);
  assert.ok(transcript.v12.qaProfileList.page.count > 0);

  const visualEvidence = [
    transcript.v12.visualEvidence,
    transcript.restartedV12.baseline,
    transcript.restartedV12.semanticBeforeAfter,
  ];
  for (const evidence of visualEvidence) {
    assert.match(evidence.evidenceDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(evidence.artifacts.length > 0);
    for (const artifact of evidence.artifacts) {
      assert.match(artifact.pngDigest, /^sha256:[0-9a-f]{64}$/u);
      assert.match(artifact.decodedPixelDigest, /^sha256:[0-9a-f]{64}$/u);
      assert.ok(artifact.byteLength > 0);
    }
  }
  assert.equal(transcript.v12.visualEvidence.artifacts[0].pngDigest, transcript.restartedV12.baseline.artifacts[1].pngDigest);
  assert.equal(transcript.v12.visualEvidence.artifacts[0].decodedPixelDigest, transcript.restartedV12.baseline.artifacts[1].decodedPixelDigest);

  const encoded = JSON.stringify(transcript);
  assert.doesNotMatch(encoded, /(?:^|[" ])(?:\/Users\/|\/private\/|\/tmp\/)/u);
  const obsoleteQualificationLabel = ["qualified", "in", "initialize"].join("-");
  const obsoleteSuccessLabel = ["current", "success"].join("-");
  assert.doesNotMatch(encoded, new RegExp(`${obsoleteQualificationLabel}|${obsoleteSuccessLabel}|"raster":"${["quali", "fied"].join("")}"`, "u"));
});

test("transcript implementation has no static qualification labels or self-asserted reaping flag", async () => {
  const source = await readFile(transcriptSource, "utf8");
  const obsoleteQualificationLabel = ["qualified", "in", "initialize"].join("-");
  const obsoleteSuccessLabel = ["current", "success"].join("-");
  const obsoleteRasterLabel = ["quali", "fied"].join("");
  assert.doesNotMatch(source, new RegExp(`${obsoleteQualificationLabel}|${obsoleteSuccessLabel}|raster:\\s*["']${obsoleteRasterLabel}["']`, "u"));
  assert.doesNotMatch(source, /\breaped\s*:\s*true\b/u);
  assert.match(source, /validateResult\(method, response\.result\)/u);
  assert.match(source, /close: \{ code: closed\.code, signal: closed\.signal \}/u);
});

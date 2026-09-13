import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createThemeCandidateV2, serializeThemeExchangeV2,
  createThemeCodeCandidate, serializeThemeCodeCandidate,
  createThemeCatalogCandidate, serializeThemeCatalogCandidate,
} from "../src-tauri/loom-payload/dist/index-catalog.js";

const adapter = fileURLToPath(new URL("../src-tauri/loom-adapter/theme-adapter.mjs", import.meta.url));
function call(request) {
  const result = spawnSync(process.execPath, [adapter], { input: JSON.stringify(request), encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  expect(result.error).toBeUndefined();
  return JSON.parse(result.stdout);
}
function review(packet) {
  return JSON.stringify({ schema: "tfsb.theme-review-context-v1", schemaVersion: 1,
    brief: { title: "Local theme study", goal: "Evaluate the candidate without altering the current theme." },
    candidateDigest: packet.candidateDigest, disposition: "approve", summary: "Reviewed locally for adoption as an unsaved draft." });
}
const families = [
  ["core", "loom-black-core.theme.json", createThemeCandidateV2, serializeThemeExchangeV2],
  ["code", "loom-black-code.theme.json", createThemeCodeCandidate, serializeThemeCodeCandidate],
  ["catalog", "loom-black-catalog.json", createThemeCatalogCandidate, serializeThemeCatalogCandidate],
];
describe("fixed installed Loom v2 adapter", () => {
  for (const [family, name, create, serialize] of families) {
    const theme = JSON.parse(readFileSync(new URL(`../src-tauri/loom-payload/examples/${name}`, import.meta.url), "utf8"));
    const packet = create(theme, { metadata: { name: "@fixture/adapter-theme", version: "1.0.0" } });
    const candidate = serialize(packet);
    it(`strictly parses and locally verifies ${family} with a bound review`, () => {
      expect(call({ action: "exchange-packet-parse-v2", packetJson: candidate }).digest).toBe(packet.candidateDigest);
      const result = call({ action: "exchange-candidate-verify-v2", candidate, brief: review(packet), uiRevision: 12 });
      expect(result.error).toBeUndefined();
      expect(result.valid).toBe(true);
      expect(result.uiRevision).toBe(12);
      expect(result.candidateVerification.schema).toBe("tfsb.theme-candidate-verification-v2");
      expect(result.candidateVerification.inputDigest).toBe(result.descriptor.inputDigest);
      expect(result.styles.map((style) => style.css).join("\n\n") + "\n").toBe(result.compiledCss);
    });
    it(`rejects stale review and changed output for ${family}`, () => {
      expect(call({ action: "exchange-candidate-verify-v2", candidate, brief: review({ candidateDigest: `sha256:${"0".repeat(64)}` }) }).valid).toBe(false);
      expect(call({ action: "exchange-candidate-verify-v2", candidate: candidate.replace(packet.outputDigest, `sha256:${"0".repeat(64)}`), brief: review(packet) }).valid).toBe(false);
      expect(call({ action: "exchange-candidate-verify-v2", candidate }).error.code).toBe("LOCAL_REVIEW_REQUIRED");
    });
  }
  it("refuses historical packets with injected successor fields", () => {
    expect(call({ action: "exchange-packet-parse-v2", packetJson: JSON.stringify({ schema: "tfsl.theme-candidate", schemaVersion: 1, semanticCompiler: "tfsl.theme-compiler-v2-core-1", catalog: "injected" }) }).valid).toBe(false);
  });
});

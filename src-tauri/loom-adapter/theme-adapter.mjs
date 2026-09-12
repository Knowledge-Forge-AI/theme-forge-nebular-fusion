#!/usr/bin/env node
// Application-owned fixed adapter, outside Loom's dist/bin identity.
import {
  compileTheme,
  parseThemeCatalogCandidate, serializeThemeCatalogCandidate, verifyThemeCatalogCandidate,
  parseThemeCodeCandidate, serializeThemeCodeCandidate, verifyThemeCodeCandidate,
  parseThemeExchangeV2, serializeThemeExchangeV2, verifyThemeCandidateV2,
} from "../loom-payload/dist/index-catalog.js";

const MAX_INPUT = 32 * 1024 * 1024;
const MAX_PACKET = 16 * 1024 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
function exact(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || required.some((key) => !Object.hasOwn(value, key))
      || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw new Error("INVALID_CLOSED_REQUEST");
}
function boundedText(value, max) {
  if (typeof value !== "string" || value.length > max || !value.trim()) throw new Error("INVALID_CONTEXT_TEXT");
}
function parseCandidate(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_PACKET) throw new Error("INVALID_PACKET_SIZE");
  // Probe only the declared family. Its public parser re-parses original bytes
  // and rejects duplicate keys, unknown fields, mixed tuples and digest drift.
  const probe = JSON.parse(raw);
  if (probe.schema === "tfsl.theme-catalog-candidate" && probe.schemaVersion === 1) {
    return { packet: parseThemeCatalogCandidate(raw), serialize: serializeThemeCatalogCandidate, verify: verifyThemeCatalogCandidate };
  }
  if (probe.schema === "tfsl.theme-candidate" && probe.schemaVersion === 2) {
    if (probe.semanticCompiler === "tfsl.theme-compiler-v2-code-1") {
      return { packet: parseThemeCodeCandidate(raw), serialize: serializeThemeCodeCandidate, verify: verifyThemeCodeCandidate };
    }
    if (probe.semanticCompiler === "tfsl.theme-compiler-v2-core-1") {
      return { packet: parseThemeExchangeV2(raw), serialize: serializeThemeExchangeV2, verify: verifyThemeCandidateV2 };
    }
  }
  throw new Error("UNSUPPORTED_DECLARED_PACKET_FAMILY");
}
function validateReview(raw, packet) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 16 * 1024) throw new Error("LOCAL_REVIEW_REQUIRED");
  const context = JSON.parse(raw);
  exact(context, ["schema", "schemaVersion", "brief", "candidateDigest", "disposition", "summary"]);
  exact(context.brief, ["title", "goal"]);
  if (context.schema !== "tfsb.theme-review-context-v1" || context.schemaVersion !== 1
      || context.disposition !== "approve" || typeof context.candidateDigest !== "string"
      || !/^(?:sha256:)?[0-9a-f]{64}$/.test(context.candidateDigest)
      || context.candidateDigest.replace(/^sha256:/, "") !== packet.candidateDigest.replace(/^sha256:/, "")) throw new Error("LOCAL_REVIEW_BINDING_MISMATCH");
  boundedText(context.brief.title, 160);
  boundedText(context.brief.goal, 4096);
  boundedText(context.summary, 4096);
}
function handle(request) {
  exact(request, ["action"], ["candidate", "packetJson", "brief", "expectedKind", "options", "uiRevision", "opaquePackets"]);
  if (request.uiRevision !== undefined && (!Number.isSafeInteger(request.uiRevision) || request.uiRevision < 0)) throw new Error("INVALID_REVISION");
  const base = { uiRevision: request.uiRevision, diagnostics: [] };
  switch (request.action) {
    case "exchange-packet-parse":
    case "exchange-packet-parse-v2": {
      const { packet, serialize } = parseCandidate(request.packetJson);
      if (request.expectedKind !== undefined && request.expectedKind !== "candidate") throw new Error("PACKET_KIND_MISMATCH");
      const canonicalJson = serialize(packet);
      return { ...base, status: "success", valid: true, kind: "candidate", digest: packet.candidateDigest,
        byteCount: Buffer.byteLength(canonicalJson), canonicalJson };
    }
    case "exchange-candidate-verify":
    case "exchange-candidate-verify-v2": {
      const { packet, verify } = parseCandidate(request.candidate);
      validateReview(request.brief, packet);
      if (request.options !== undefined) {
        exact(request.options, [], ["accent", "strictContrast"]);
        if (request.options.strictContrast || (request.options.accent !== undefined && request.options.accent !== packet.selectedAccent)) throw new Error("CANDIDATE_OPTIONS_MISMATCH");
      }
      // Public verification regenerates and compares the complete package inventory.
      const result = verify(packet);
      if (!result.valid) throw new Error("LOCAL_LOOM_VERIFICATION_FAILED");
      const compilation = compileTheme(packet.theme, { accent: packet.selectedAccent });
      const styles = [...compilation.styles].map(([path, css]) => ({ path, css }));
      const descriptor = compilation.descriptor;
      if (packet.inputDigest !== `sha256:${descriptor.inputDigest}` || packet.outputDigest !== `sha256:${descriptor.outputDigest}`) throw new Error("LOCAL_OUTPUT_BINDING_MISMATCH");
      const candidateVerification = {
        schema: "tfsb.theme-candidate-verification-v2", schemaVersion: 2, valid: true,
        candidateId: packet.candidateId ?? packet.candidateDigest,
        candidateDigest: packet.candidateDigest, inputDigest: descriptor.inputDigest, outputDigest: descriptor.outputDigest,
        descriptor, compiledCss: compilation.css, styles, diagnostics: compilation.diagnostics, errors: [], warnings: result.warnings ?? [],
      };
      return { ...base, status: "success", valid: true, specification: packet.theme,
        compiledCss: compilation.css, descriptor, styles, diagnostics: compilation.diagnostics, candidateVerification };
    }
    default: throw new Error("UNSUPPORTED_ACTION");
  }
}
async function run() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT) throw new Error("INPUT_TOO_LARGE");
    chunks.push(chunk);
  }
  return handle(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
try {
  process.stdout.write(JSON.stringify(await run()) + "\n");
} catch (error) {
  // Never return private paths or arbitrary compiler exception text.
  const code = error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : "INVALID_THEME_PACKET";
  process.stdout.write(JSON.stringify({ status: "error", valid: false, diagnostics: [],
    error: { code, message: `Local Theme Lab operation failed (${code}).` } }) + "\n");
  process.exitCode = 1;
}

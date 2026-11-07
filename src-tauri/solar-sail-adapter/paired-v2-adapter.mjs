import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Optional, fixed-resource native entrypoint. The Rust owner authenticates
// this closure before spawning it; no caller supplies a filesystem path.
const MAX_INPUT_BYTES = 2_097_152;
const MAX_OUTPUT_BYTES = 2_098_176;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sameKeys = (value, keys) => isRecord(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const isHash = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

function refused(context, code) {
  const sessionId = typeof context?.sessionId === "string" &&
    context.sessionId.length > 0 && Buffer.byteLength(context.sessionId) <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(context.sessionId)
    ? context.sessionId : "invalid-session";
  const uiRevision = Number.isSafeInteger(context?.uiRevision) && context.uiRevision >= 0
    ? context.uiRevision : 0;
  return { status: "error", valid: false, uiRevision, sessionId,
    solarSail: null, stellarLoom: null, applicationExtension: null,
    applicationAppearance: null, diagnostics: [],
    error: { code, message: "The paired profile operation could not be completed." } };
}

function emit(result) {
  let envelope = { status: result.valid ? "success" : "error", valid: result.valid,
    uiRevision: result.uiRevision, pairedV2Response: result };
  let serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized) > MAX_OUTPUT_BYTES) {
    const failure = refused(result, "V2_RESPONSE_TOO_LARGE");
    envelope = { status: "error", valid: false, uiRevision: failure.uiRevision, pairedV2Response: failure };
    serialized = JSON.stringify(envelope);
  }
  process.stdout.write(serialized + "\n");
}

function fixedInputs() {
  const inputBytes = readFileSync(new URL("./appearance-inputs.json", import.meta.url));
  if (inputBytes.length > 16_384) throw new Error("V2_INPUT_PIN_MISMATCH");
  const inputs = JSON.parse(inputBytes.toString("utf8"));
  if (!sameKeys(inputs, ["schema", "familyBindings", "applicationBaselineLayer", "templateSha256", "recipeSha256"]) ||
      inputs.schema !== "nebular.paired-v2-inputs.v1" ||
      !sameKeys(inputs.familyBindings, ["system-ui", "monospace"]) ||
      inputs.familyBindings["system-ui"] !== "system-sans" ||
      inputs.familyBindings.monospace !== "system-mono" ||
      inputs.applicationBaselineLayer !== "theme-forge-application-baseline" ||
      !isHash(inputs.templateSha256) || !isHash(inputs.recipeSha256)) throw new Error("V2_INPUT_PIN_MISMATCH");
  const template = readFileSync(new URL("./common-sttn-template.json", import.meta.url));
  const recipe = readFileSync(new URL("./common-appearance-recipe.mjs", import.meta.url));
  if (template.length > 131_072 || recipe.length > 131_072 ||
      sha256(template) !== inputs.templateSha256 || sha256(recipe) !== inputs.recipeSha256) {
    throw new Error("V2_INPUT_PIN_MISMATCH");
  }
  return { templateSource: template.toString("utf8"), familyBindings: inputs.familyBindings,
    applicationBaselineLayer: inputs.applicationBaselineLayer };
}

async function run() {
  let context;
  try {
    if (process.argv.length !== 2) throw new Error("V2_REQUEST_INVALID");
    let total = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      total += chunk.length;
      if (total > MAX_INPUT_BYTES) throw new Error("V2_REQUEST_INVALID");
      chunks.push(chunk);
    }
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    context = request?.pairedV2Request;
    if (!sameKeys(request, ["action", "uiRevision", "pairedV2Request"]) ||
        request.action !== "paired_compile_v2" || !isRecord(context) ||
        request.uiRevision !== context.uiRevision) throw new Error("V2_REQUEST_INVALID");
    const options = fixedInputs();
    const [solar, loom, recipe, compiler] = await Promise.all([
      import("../solar-sail-payload/dist/index.js"),
      import("../loom-payload/dist/index-catalog.js"),
      import("./common-appearance-recipe.mjs"),
      import("./paired-v2-compile.mjs"),
    ]);
    const compileSingleProfile = bound => {
      const result = recipe.compileBoundAppearanceProfile({ solar, loom }, bound, options);
      const identity = { sourceProfileSha256: bound.provenance.rawSourceSha256,
        canonicalDigest: bound.provenance.canonicalDigest };
      return {
        solarSail: { valid: true, compiledCss: result.solarResult.css,
          diagnostics: result.solarResult.diagnostics, mappingReport: result.solarMapping.report, ...identity },
        stellarLoom: { valid: true, compiledCss: result.loomResult.css,
          diagnostics: result.loomResult.diagnostics, mappingReport: result.loomMapping.report, ...identity },
        applicationExtension: { valid: true, compiledCss: result.extension.css,
          diagnostics: [], mappingReport: result.extension.report, ...identity },
        applicationAppearance: { valid: true, compiledCss: result.applicationCss, ...identity },
      };
    };
    emit(compiler.compilePairedV2(context, { solarApi: solar, compileSingleProfile,
      expectedSessionId: context.sessionId, expectedUiRevision: context.uiRevision }));
  } catch (error) {
    const code = error instanceof Error && ["V2_REQUEST_INVALID", "V2_INPUT_PIN_MISMATCH"].includes(error.message)
      ? error.message : "V2_RESOURCES_UNAVAILABLE";
    emit(refused(context, code));
  }
}

await run();

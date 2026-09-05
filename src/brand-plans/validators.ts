import type {
  BrandDerivePlanSummary, BrandPlanMethod, BrandQaBaselinePlanSummary,
  BrandRasterExportPlanSummary, ConsumerPlanSummary, StudioBrandPlanCancelResult,
  StudioBrandPlanStartResult, StudioPlanOperationEvent, StudioPlanSummary,
} from "./contracts";

export class StudioPlanValidationError extends Error {
  constructor() { super("Studio host returned an invalid typed plan response"); this.name = "StudioPlanValidationError"; }
}

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const localPlanPattern = /^plan_[a-f0-9]{64}$/u;
const operationPattern = /^operation_[a-f0-9]{64}$/u;
const publicHandlePattern = /^(project|source)_[A-Za-z0-9_-]{1,248}$/u;
const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const methods: readonly BrandPlanMethod[] = ["brand.derive.plan", "brand.qa.baseline.plan", "brand.consumer.install.plan", "brand.consumer.sync.plan", "brand.export.plan"];
const rasterPlan = {
  adapterId: "resvg-png-v1",
  companionPackage: "@knowledge-forge-ai/tfsb-raster-resvg",
  companionVersion: "0.0.0-tfsb47f",
  backend: "wasm",
  rendererPackage: "@resvg/resvg-wasm",
  rendererVersion: "2.6.2",
  rendererBuildDigest: "sha256:22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70",
  nodeMajor: 22,
  platformClaim: "darwin-arm64",
  qualificationId: "sha256:4bb08e677b87ef1ca74c35c5c22f547cebef4c22a1f98a08a9246fd9397d0f11",
} as const;
const planningStages = ["validate", "snapshot", "analyze", "plan", "ready"] as const;
const applyStages = ["revalidate", "waiting-lock", "staging", "promoting", "cleanup", "complete"] as const;

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new StudioPlanValidationError();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new StudioPlanValidationError();
  return record;
}

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) throw new StudioPlanValidationError();
  return value as number;
}

function text(value: unknown, maximum = 1024): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0") || value.startsWith("/") || value.includes("/Users/")) throw new StudioPlanValidationError();
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) throw new StudioPlanValidationError();
  return value;
}

function id(value: unknown): string {
  const result = text(value, 256);
  if (!idPattern.test(result)) throw new StudioPlanValidationError();
  return result;
}

function relative(value: unknown): string {
  const result = text(value, 4096);
  if (result.includes("\\") || result.split("/").some((part) => !part || part === "." || part === "..")) throw new StudioPlanValidationError();
  return result;
}

function orderedStrings(value: unknown, maximum: number, validator: (entry: unknown) => string = text): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new StudioPlanValidationError();
  const result = value.map((entry) => validator(entry));
  if (result.some((entry, index) => index > 0 && result[index - 1]! >= entry)) throw new StudioPlanValidationError();
  return result;
}

function stringList(value: unknown, maximum: number, validator: (entry: unknown) => string = text): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new StudioPlanValidationError();
  return value.map((entry) => validator(entry));
}

function digestPair(value: unknown): { readonly old: string; readonly next: string } {
  const item = exact(value, ["next", "old"]);
  return { old: digest(item.old), next: digest(item.next) };
}

function derive(value: unknown): BrandDerivePlanSummary {
  const item = exact(value, ["affectedTargets", "brandSystemDigest", "createdCount", "dryRun", "operationSummaries", "recipeDigest", "selectedRecipes", "targetStates", "tokenDigest", "transitiveRecipes", "unchangedCount", "updatedCount", "warnings"]);
  const selectedRecipes = orderedStrings(item.selectedRecipes, 128, id);
  if (selectedRecipes.length === 0 || typeof item.dryRun !== "boolean") throw new StudioPlanValidationError();
  const transitiveRecipes = orderedStrings(item.transitiveRecipes, 128, id);
  const affectedTargets = orderedStrings(item.affectedTargets, 128, id);
  if (!Array.isArray(item.operationSummaries) || item.operationSummaries.length > 128 || !Array.isArray(item.targetStates) || item.targetStates.length > 128) throw new StudioPlanValidationError();
  const operationSummaries = item.operationSummaries.map((raw) => {
    const entry = exact(raw, ["operations", "recipeId", "targetAssetId"]);
    return { recipeId: id(entry.recipeId), targetAssetId: id(entry.targetAssetId), operations: stringList(entry.operations, 128, (value) => text(value, 128)) };
  });
  const targetStates = item.targetStates.map((raw) => {
    const candidate = raw as Record<string, unknown>;
    const hasOld = candidate && "oldDigest" in candidate;
    const entry = exact(raw, hasOld ? ["newDigest", "newSvgDigest", "oldDigest", "recipeId", "state", "targetAssetId"] : ["newDigest", "newSvgDigest", "recipeId", "state", "targetAssetId"]);
    if (!["create", "update", "unchanged"].includes(entry.state as string) || (entry.state === "create") === hasOld) throw new StudioPlanValidationError();
    return { targetAssetId: id(entry.targetAssetId), recipeId: id(entry.recipeId), state: entry.state as "create" | "update" | "unchanged", ...(hasOld ? { oldDigest: digest(entry.oldDigest) } : {}), newDigest: digest(entry.newDigest), newSvgDigest: digest(entry.newSvgDigest) };
  });
  for (const entries of [operationSummaries.map((entry) => entry.targetAssetId), targetStates.map((entry) => entry.targetAssetId)]) if (entries.some((entry, index) => index > 0 && entries[index - 1]! >= entry)) throw new StudioPlanValidationError();
  const createdCount = integer(item.createdCount, 128); const updatedCount = integer(item.updatedCount, 128); const unchangedCount = integer(item.unchangedCount, 128);
  if (createdCount + updatedCount + unchangedCount !== targetStates.length) throw new StudioPlanValidationError();
  return { selectedRecipes, transitiveRecipes, affectedTargets, createdCount, updatedCount, unchangedCount, operationSummaries, targetStates, tokenDigest: digest(item.tokenDigest), recipeDigest: digest(item.recipeDigest), brandSystemDigest: digest(item.brandSystemDigest), warnings: stringList(item.warnings, 128), dryRun: item.dryRun };
}

function qa(value: unknown): BrandQaBaselinePlanSummary {
  const item = exact(value, ["assetDigests", "baselinePath", "brandSystemDigests", "caseId", "newBaselineDigest", "newQaDigest", "oldBaselineDigest", "oldQaDigest", "profileId", "rasterDifference", "renderer", "state", "svgDigests"]);
  if (!["create", "update", "rebaseline"].includes(item.state as string) || (item.state === "create") !== (item.oldBaselineDigest === null)) throw new StudioPlanValidationError();
  const renderer = exact(item.renderer, ["id", "platformClaim", "qualificationId", "rendererBuildDigest", "version"]);
  if (renderer.id !== rasterPlan.adapterId || renderer.version !== rasterPlan.rendererVersion || renderer.qualificationId !== rasterPlan.qualificationId || renderer.platformClaim !== rasterPlan.platformClaim || renderer.rendererBuildDigest !== rasterPlan.rendererBuildDigest) throw new StudioPlanValidationError();
  const difference = exact(item.rasterDifference, ["afterDecodedPixelDigest", "beforeDecodedPixelDigest", "changedBounds", "changedPixels", "maximumChannelDelta"]);
  let changedBounds: BrandQaBaselinePlanSummary["rasterDifference"]["changedBounds"] = null;
  if (difference.changedBounds !== null) {
    const bounds = exact(difference.changedBounds, ["bottom", "left", "right", "top"]);
    changedBounds = { left: integer(bounds.left, 4_294_967_295), top: integer(bounds.top, 4_294_967_295), right: integer(bounds.right, 4_294_967_295), bottom: integer(bounds.bottom, 4_294_967_295) };
    if (changedBounds.left > changedBounds.right || changedBounds.top > changedBounds.bottom) throw new StudioPlanValidationError();
  }
  return { profileId: id(item.profileId), caseId: id(item.caseId), baselinePath: relative(item.baselinePath), state: item.state as "create" | "update" | "rebaseline", oldBaselineDigest: item.oldBaselineDigest === null ? null : digest(item.oldBaselineDigest), newBaselineDigest: digest(item.newBaselineDigest), oldQaDigest: digest(item.oldQaDigest), newQaDigest: digest(item.newQaDigest), renderer: { id: text(renderer.id, 256), version: text(renderer.version, 256), qualificationId: text(renderer.qualificationId, 256), platformClaim: text(renderer.platformClaim, 256), rendererBuildDigest: digest(renderer.rendererBuildDigest) }, assetDigests: digestPair(item.assetDigests), svgDigests: digestPair(item.svgDigests), brandSystemDigests: digestPair(item.brandSystemDigests), rasterDifference: { changedPixels: difference.changedPixels === null ? null : integer(difference.changedPixels), maximumChannelDelta: difference.maximumChannelDelta === null ? null : integer(difference.maximumChannelDelta, 255), changedBounds, beforeDecodedPixelDigest: difference.beforeDecodedPixelDigest === null ? null : digest(difference.beforeDecodedPixelDigest), afterDecodedPixelDigest: digest(difference.afterDecodedPixelDigest) } };
}

function consumer(value: unknown, expected: "install" | "sync"): ConsumerPlanSummary {
  const item = exact(value, ["lockDigest", "omittedOptional", "operation", "outputs", "packages", "profiles"]);
  if (item.operation !== expected) throw new StudioPlanValidationError();
  const packages = orderedStrings(item.packages, 8); if (packages.length === 0) throw new StudioPlanValidationError();
  const profiles = orderedStrings(item.profiles, 8);
  const omittedOptional = orderedStrings(item.omittedOptional, 512);
  if (!Array.isArray(item.outputs) || item.outputs.length > 512) throw new StudioPlanValidationError();
  const outputs = item.outputs.map((raw) => { const output = exact(raw, ["byteDigest", "destination", "kind", "packageId", "sourceId"]); if (!["asset", "companion"].includes(output.kind as string)) throw new StudioPlanValidationError(); const packageId = text(output.packageId, 512); if (!packages.includes(packageId)) throw new StudioPlanValidationError(); return { kind: output.kind as "asset" | "companion", packageId, sourceId: text(output.sourceId, 256), destination: relative(output.destination), byteDigest: digest(output.byteDigest) }; });
  const keys = outputs.map((output) => `${output.packageId}\0${output.destination}\0${output.sourceId}`); if (keys.some((key, index) => index > 0 && keys[index - 1]! >= key)) throw new StudioPlanValidationError();
  return { operation: expected, packages, profiles, outputs, omittedOptional, lockDigest: digest(item.lockDigest) };
}

function raster(value: unknown): BrandRasterExportPlanSummary {
  const item = exact(value, ["adapter", "counts", "outputs", "profileId", "warnings"]);
  const profileId = id(item.profileId); const adapter = exact(item.adapter, ["adapterId", "backend", "companionPackage", "companionVersion", "nodeMajor", "platformClaim", "qualificationId", "rendererBuildDigest", "rendererPackage", "rendererVersion"]);
  for (const [key, expected] of Object.entries(rasterPlan)) if (adapter[key] !== expected) throw new StudioPlanValidationError();
  const publicAdapter: BrandRasterExportPlanSummary["adapter"] = { ...rasterPlan };
  if (!Array.isArray(item.outputs) || item.outputs.length > 128) throw new StudioPlanValidationError();
  const outputs = item.outputs.map((raw) => { const output = exact(raw, ["alpha", "assetId", "background", "canonicalAssetDigest", "decodedPixelDigest", "destination", "fit", "height", "outputConfigDigest", "outputId", "pngDigest", "profileDigest", "profileId", "purpose", "receiptDigest", "rendererBuildDigest", "state", "svgDigest", "width"]); if (output.profileId !== profileId || !["create", "update", "unchanged"].includes(output.state as string) || output.fit !== "contain-pad" || !["straight", "opaque"].includes(output.alpha as string) || output.rendererBuildDigest !== rasterPlan.rendererBuildDigest) throw new StudioPlanValidationError(); return { profileId, outputId: id(output.outputId), assetId: id(output.assetId), destination: relative(output.destination), state: output.state as "create" | "update" | "unchanged", width: Math.max(1, integer(output.width, 65535)), height: Math.max(1, integer(output.height, 65535)), purpose: text(output.purpose, 128), fit: "contain-pad", background: text(output.background, 256), alpha: output.alpha as string, canonicalAssetDigest: digest(output.canonicalAssetDigest), svgDigest: digest(output.svgDigest), profileDigest: digest(output.profileDigest), outputConfigDigest: digest(output.outputConfigDigest), rendererBuildDigest: digest(output.rendererBuildDigest), pngDigest: digest(output.pngDigest), decodedPixelDigest: digest(output.decodedPixelDigest), receiptDigest: digest(output.receiptDigest) }; });
  if (outputs.some((output, index) => index > 0 && outputs[index - 1]!.outputId >= output.outputId)) throw new StudioPlanValidationError();
  const counts = exact(item.counts, ["create", "unchanged", "update"]); const publicCounts = { create: integer(counts.create, 128), update: integer(counts.update, 128), unchanged: integer(counts.unchanged, 128) }; if (publicCounts.create + publicCounts.update + publicCounts.unchanged !== outputs.length) throw new StudioPlanValidationError();
  return { profileId, adapter: publicAdapter, outputs, counts: publicCounts, warnings: stringList(item.warnings, 128) };
}

function summary(method: BrandPlanMethod, value: unknown): StudioPlanSummary {
  if (method === "brand.derive.plan") return derive(value);
  if (method === "brand.qa.baseline.plan") return qa(value);
  if (method === "brand.consumer.install.plan") return consumer(value, "install");
  if (method === "brand.consumer.sync.plan") return consumer(value, "sync");
  return raster(value);
}

export function validatePlanResult(value: unknown): StudioBrandPlanStartResult {
  const candidate = value as Record<string, unknown>; const kind = candidate?.kind;
  if (kind === "discarded") { exact(value, ["kind"]); return { kind: "discarded" }; }
  if (kind === "applied" || kind === "indeterminate") { const item = exact(value, ["kind", "method"]); if (!methods.includes(item.method as BrandPlanMethod)) throw new StudioPlanValidationError(); return { kind, method: item.method as BrandPlanMethod }; }
  if (kind !== "ready") throw new StudioPlanValidationError();
  const item = exact(value, ["expiresInMs", "kind", "method", "planDigest", "planHandle", "projectHandle", "sourceHandles", "summary"]);
  if (!methods.includes(item.method as BrandPlanMethod) || item.expiresInMs !== 600000 || typeof item.planHandle !== "string" || !localPlanPattern.test(item.planHandle) || typeof item.projectHandle !== "string" || !publicHandlePattern.test(item.projectHandle) || !item.projectHandle.startsWith("project_")) throw new StudioPlanValidationError();
  const sourceHandles = orderedStrings(item.sourceHandles, 8, (entry) => { if (typeof entry !== "string" || !publicHandlePattern.test(entry) || !entry.startsWith("source_")) throw new StudioPlanValidationError(); return entry; });
  return { kind: "ready", planHandle: item.planHandle, planDigest: digest(item.planDigest), method: item.method as BrandPlanMethod, expiresInMs: 600000, summary: summary(item.method as BrandPlanMethod, item.summary), projectHandle: item.projectHandle, sourceHandles };
}

export function validatePlanEvent(value: unknown): StudioPlanOperationEvent {
  const candidate = value as Record<string, unknown>; const hasProgress = candidate && "progress" in candidate;
  const item = exact(value, hasProgress ? ["operationHandle", "progress", "schemaVersion", "sequence", "state"] : ["operationHandle", "schemaVersion", "sequence", "state"]);
  if (item.schemaVersion !== 1 || integer(item.sequence) < 1 || typeof item.operationHandle !== "string" || !operationPattern.test(item.operationHandle) || !["started", "progress", "cancellation-requested"].includes(item.state as string) || (item.state === "progress") !== hasProgress) throw new StudioPlanValidationError();
  if (!hasProgress) return { schemaVersion: 1, sequence: item.sequence as number, operationHandle: item.operationHandle, state: item.state as "started" | "cancellation-requested" };
  const raw = item.progress as Record<string, unknown>; const progress = exact(raw, "total" in raw ? ["completed", "stage", "total"] : ["completed", "stage"]); if (![...planningStages, ...applyStages].includes(progress.stage as never)) throw new StudioPlanValidationError(); const completed = integer(progress.completed); const total = "total" in progress ? integer(progress.total) : undefined; if (total !== undefined && completed > total) throw new StudioPlanValidationError();
  return { schemaVersion: 1, sequence: item.sequence as number, operationHandle: item.operationHandle, state: "progress", progress: { stage: progress.stage as typeof planningStages[number] | typeof applyStages[number], completed, ...(total === undefined ? {} : { total }) } };
}

export function validatePlanCancelResult(value: unknown): StudioBrandPlanCancelResult { const item = exact(value, ["accepted"]); if (typeof item.accepted !== "boolean") throw new StudioPlanValidationError(); return { accepted: item.accepted }; }

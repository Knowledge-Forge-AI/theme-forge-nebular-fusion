import { validateVisualEvidence } from "../brand-read/validators";
import { computePacketDigest } from "./canonical";
import type {
  BriefPacket,
  CandidatePacket,
  DesignEvidencePacket,
  Material,
  Proposal,
  ReviewAnnotation,
  ReviewPacket,
} from "./types";

export type DesignEvidenceValidationCategory =
  | "bounds"
  | "digest"
  | "link"
  | "ordering"
  | "schema"
  | "text"
  | "visual";

export class DesignEvidenceBrowserValidationError extends Error {
  constructor(readonly category: DesignEvidenceValidationCategory) {
    super(`Design evidence validation failed: ${category}.`);
    this.name = "DesignEvidenceBrowserValidationError";
  }
}

type UnknownRecord = Record<string, unknown>;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/u;
const PACKAGE_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;
const PROPOSALS = ["evidence-only", "derive", "qa-baseline", "consumer-install", "consumer-sync", "export"] as const;
const CATEGORIES = ["composition", "alignment", "spacing", "legibility", "contrast", "color", "brand-fit", "accessibility", "small-size", "technical", "other"] as const;
const SEVERITIES = ["note", "minor", "substantive", "blocking"] as const;
const DISPOSITIONS = ["unreviewed", "preferred", "approved", "rejected", "needs-revision", "deferred"] as const;
const encoder = new TextEncoder();

function fail(category: DesignEvidenceValidationCategory): never {
  throw new DesignEvidenceBrowserValidationError(category);
}

function record(value: unknown): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("schema");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("schema");
  return value as UnknownRecord;
}

function exact(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) fail("schema");
}

function array(value: unknown, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail("bounds");
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail("bounds");
  return value as number;
}

function text(value: unknown, maximum: number, multiline = false): string {
  if (typeof value !== "string" || encoder.encode(value).byteLength < 1 || encoder.encode(value).byteLength > maximum || value.normalize("NFC") !== value) fail("text");
  const controls = multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u;
  if (controls.test(value)) fail("text");
  return value;
}

function id(value: unknown): string {
  const result = text(value, 128);
  if (!ID.test(result)) fail("schema");
  return result;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("digest");
  return value;
}

function packageId(value: unknown): string {
  const result = text(value, 214);
  if (!PACKAGE_ID.test(result)) fail("schema");
  return result;
}

function version(value: unknown): string {
  const result = text(value, 64);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(result)) fail("schema");
  return result;
}

function enumeration<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) fail("schema");
  return value as T;
}

function compareUtf8(left: string, right: string): number {
  const a = encoder.encode(left), b = encoder.encode(right), length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  return a.length - b.length;
}

function assertSortedUnique(values: readonly string[]): void {
  const sorted = [...values].sort(compareUtf8);
  if (new Set(values).size !== values.length || values.some((value, index) => value !== sorted[index])) fail("ordering");
}

function sortedIds(value: unknown, minimum: number, maximum: number): string[] {
  const values = array(value, minimum, maximum).map(id);
  assertSortedUnique(values);
  return values;
}

function validateContext(raw: unknown): void {
  const value = record(raw); exact(value, ["corePackageVersion", "studioVersion", "studioProtocolVersion", "project"], ["source"]);
  if (value.corePackageVersion !== "0.4.0" || value.studioVersion !== "0.1.0" || value.studioProtocolVersion !== "1.2") fail("schema");
  const project = record(value.project); exact(project, ["canonicalDigest", "brandSystemDigest"], ["label"]); digest(project.canonicalDigest); digest(project.brandSystemDigest); if (project.label !== undefined) text(project.label, 256);
  if (value.source !== undefined) { const source = record(value.source); exact(source, ["packageId", "brandVersion", "brandSystemDigest"]); packageId(source.packageId); version(source.brandVersion); digest(source.brandSystemDigest); }
}

function validateTarget(raw: unknown): string {
  const value = record(raw); exact(value, ["targetId", "selector", "canonicalAssetDigest", "svgDigest", "purpose"]); const targetId = id(value.targetId); digest(value.canonicalAssetDigest); digest(value.svgDigest); id(value.purpose);
  const selector = record(value.selector);
  if (selector.kind === "asset") { exact(selector, ["kind", "assetId"]); id(selector.assetId); }
  else if (selector.kind === "binding") { exact(selector, ["kind", "family", "role", "variant"]); id(selector.family); id(selector.role); id(selector.variant); }
  else fail("schema");
  return targetId;
}

function validateRenderTuple(raw: unknown): void {
  const value = record(raw); exact(value, ["width", "height", "background"]); integer(value.width, 16, 1_024); integer(value.height, 16, 1_024);
  const background = text(value.background, 128);
  if (background !== "transparent" && !/^token:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(background) && !/^#[0-9A-F]{8}$/u.test(background)) fail("schema");
}

function validateMaterials(raw: unknown): void {
  const identities = array(raw, 0, 64).map((entry) => {
    const value = record(entry); exact(value, ["kind", "identifier", "digest"], ["licenseExpression", "noticeDigest"]); const kind = enumeration(value.kind, ["user-supplied", "tfsb-rendered", "third-party", "external-claim"] as const); const identifier = id(value.identifier); const valueDigest = digest(value.digest); if (value.licenseExpression !== undefined) text(value.licenseExpression, 256); if (value.noticeDigest !== undefined) digest(value.noticeDigest); return `${kind}\u0000${identifier}\u0000${valueDigest}`;
  });
  assertSortedUnique(identities);
}

async function validateVisuals(raw: unknown, minimum: number): Promise<void> {
  const values = array(raw, minimum, 8); const identities: string[] = []; let bytes = 0;
  for (const value of values) {
    try {
      const visual = await validateVisualEvidence({ kind: "visual-evidence", data: value });
      identities.push(visual.evidenceDigest); bytes += visual.artifacts.reduce((total, artifact) => total + artifact.byteLength, 0);
    } catch { fail("visual"); }
  }
  if (bytes > 8_388_608) fail("bounds");
  if (new Set(identities).size !== identities.length) fail("ordering");
}

function validateParameters(raw: unknown): void {
  const profiles = array(raw, 0, 32).map((entry) => {
    const value = record(entry); exact(value, ["profileId", "values"]); const profileId = id(value.profileId); const parameters = array(value.values, 0, 32).map((item) => { const parameter = record(item); exact(parameter, ["parameter", "value"]); const parameterId = id(parameter.parameter); text(parameter.value, 512); return parameterId; }); assertSortedUnique(parameters); return profileId;
  });
  assertSortedUnique(profiles);
}

function validateSources(raw: unknown): void {
  const packages = array(raw, 1, 8).map((entry) => { const value = record(entry); exact(value, ["packageId", "brandVersion", "brandSystemDigest"]); const packageIdentity = packageId(value.packageId); version(value.brandVersion); digest(value.brandSystemDigest); return packageIdentity; }); assertSortedUnique(packages);
}

function validateProposal(raw: unknown): void {
  const value = record(raw); const kind = enumeration(value.kind, PROPOSALS);
  if (kind === "evidence-only") exact(value, ["kind"]);
  else if (kind === "derive") { exact(value, ["kind", "selection"]); const selection = record(value.selection); if (selection.kind === "all") exact(selection, ["kind"]); else if (selection.kind === "recipes") { exact(selection, ["kind", "recipeIds"]); sortedIds(selection.recipeIds, 1, 128); } else fail("schema"); }
  else if (kind === "qa-baseline") { exact(value, ["kind", "profileId", "caseId"]); id(value.profileId); id(value.caseId); }
  else if (kind === "consumer-install") { exact(value, ["kind", "sourcePackages", "profileIds", "parameters"]); validateSources(value.sourcePackages); sortedIds(value.profileIds, 1, 32); validateParameters(value.parameters); }
  else if (kind === "consumer-sync") { exact(value, ["kind", "sourcePackages"], ["profileIds", "parameters"]); validateSources(value.sourcePackages); if (value.profileIds !== undefined) sortedIds(value.profileIds, 1, 32); if (value.parameters !== undefined) validateParameters(value.parameters); }
  else { exact(value, ["kind", "profileId"], ["outputIds"]); id(value.profileId); if (value.outputIds !== undefined) sortedIds(value.outputIds, 1, 128); }
}

async function validateBrief(value: UnknownRecord): Promise<void> {
  exact(value, ["schema", "schemaVersion", "briefId", "revision", "title", "objective", "context", "targets", "constraints", "materials", "visualEvidence", "briefDigest"]); id(value.briefId); integer(value.revision, 1, Number.MAX_SAFE_INTEGER); text(value.title, 512); text(value.objective, 4_096, true); validateContext(value.context);
  const targets = array(value.targets, 1, 32).map(validateTarget); assertSortedUnique(targets);
  const constraints = record(value.constraints); exact(constraints, ["allowedProposalKinds", "requiredTokenIds", "requiredRecipeIds", "qaProfileIds", "renderTuples", "acceptanceCriteria", "prohibitedChanges"]); const kinds = array(constraints.allowedProposalKinds, 1, 6).map((entry) => enumeration(entry, PROPOSALS)); assertSortedUnique(kinds); sortedIds(constraints.requiredTokenIds, 0, 128); sortedIds(constraints.requiredRecipeIds, 0, 128); sortedIds(constraints.qaProfileIds, 0, 128); array(constraints.renderTuples, 1, 16).forEach(validateRenderTuple); array(constraints.acceptanceCriteria, 1, 64).forEach((entry) => text(entry, 4_096, true)); array(constraints.prohibitedChanges, 0, 64).forEach((entry) => text(entry, 4_096, true));
  validateMaterials(value.materials); await validateVisuals(value.visualEvidence, 0); digest(value.briefDigest);
}

async function validateCandidate(value: UnknownRecord): Promise<void> {
  exact(value, ["schema", "schemaVersion", "briefDigest", "candidateId", "revision", "author", "title", "rationale", "proposal", "claims", "qaSummary", "materials", "visualEvidence", "candidateDigest"], ["revisionOf"]); digest(value.briefDigest); id(value.candidateId); integer(value.revision, 1, Number.MAX_SAFE_INTEGER); if (value.revisionOf !== undefined) digest(value.revisionOf);
  const author = record(value.author); exact(author, ["kind", "label"], ["toolName", "toolVersion"]); enumeration(author.kind, ["human", "agent", "tool"] as const); text(author.label, 256); if (author.toolName !== undefined) text(author.toolName, 256); if (author.toolVersion !== undefined) text(author.toolVersion, 128); text(value.title, 512); text(value.rationale, 4_096, true); validateProposal(value.proposal);
  array(value.claims, 0, 64).forEach((entry) => { const claim = record(entry); exact(claim, ["category", "severity", "message"]); enumeration(claim.category, CATEGORIES); enumeration(claim.severity, SEVERITIES); text(claim.message, 4_096, true); }); const qa = record(value.qaSummary); exact(qa, ["status"], ["qaResultDigest"]); enumeration(qa.status, ["pass", "fail", "skipped", "unavailable", "error"] as const); if (qa.qaResultDigest !== undefined) digest(qa.qaResultDigest); validateMaterials(value.materials); await validateVisuals(value.visualEvidence, 1); digest(value.candidateDigest);
}

function validateAnnotation(raw: unknown, candidates: ReadonlySet<string>): string {
  const value = record(raw); exact(value, ["annotationId", "candidateDigest", "visualEvidenceDigest", "artifactRole", "pngDigest", "scope", "category", "severity", "comment"], ["elementId"]); const annotationId = id(value.annotationId); const candidate = digest(value.candidateDigest); if (!candidates.has(candidate)) fail("link"); digest(value.visualEvidenceDigest); enumeration(value.artifactRole, ["current", "baseline", "before", "after"] as const); digest(value.pngDigest); enumeration(value.category, CATEGORIES); enumeration(value.severity, SEVERITIES); text(value.comment, 2_048, true); if (value.elementId !== undefined) id(value.elementId);
  const scope = record(value.scope); if (scope.kind === "artifact") exact(scope, ["kind"]); else if (scope.kind === "region") { exact(scope, ["kind", "xMillionths", "yMillionths", "widthMillionths", "heightMillionths"]); const x = integer(scope.xMillionths, 0, 1_000_000), y = integer(scope.yMillionths, 0, 1_000_000), width = integer(scope.widthMillionths, 1, 1_000_000), height = integer(scope.heightMillionths, 1, 1_000_000); if (x + width > 1_000_000 || y + height > 1_000_000) fail("bounds"); } else fail("schema");
  return annotationId;
}

function validateReview(value: UnknownRecord): void {
  exact(value, ["schema", "schemaVersion", "briefDigest", "candidateDigests", "annotations", "dispositions", "overallDisposition", "summary", "reviewDigest"], ["previousReviewDigest"]); digest(value.briefDigest); const candidateDigests = array(value.candidateDigests, 1, 8).map(digest); assertSortedUnique(candidateDigests); const candidates = new Set(candidateDigests); if (value.previousReviewDigest !== undefined) digest(value.previousReviewDigest);
  const annotations = array(value.annotations, 0, 128).map((entry) => validateAnnotation(entry, candidates)); assertSortedUnique(annotations); const dispositions = array(value.dispositions, candidates.size, candidates.size); const dispositionDigests: string[] = []; let selected: { candidate: string; disposition: string } | undefined; let reviewed = 0;
  for (const entry of dispositions) { const disposition = record(entry); exact(disposition, ["candidateDigest", "disposition"]); const candidate = digest(disposition.candidateDigest), status = enumeration(disposition.disposition, DISPOSITIONS); if (!candidates.has(candidate)) fail("link"); dispositionDigests.push(candidate); if (status !== "unreviewed") reviewed++; if (status === "preferred" || status === "approved") { if (selected !== undefined) fail("link"); selected = { candidate, disposition: status }; } }
  assertSortedUnique(dispositionDigests); if (reviewed === 0) fail("link"); const overall = record(value.overallDisposition); const kind = enumeration(overall.kind, ["no-decision", "preferred", "approved", "needs-revision", "rejected-all"] as const);
  if (kind === "preferred" || kind === "approved" || kind === "needs-revision") { exact(overall, ["kind", "candidateDigest"]); const candidate = digest(overall.candidateDigest); if (!candidates.has(candidate) || dispositions.filter((entry) => { const item = entry as UnknownRecord; return item.candidateDigest === candidate && item.disposition === kind; }).length !== 1) fail("link"); }
  else { exact(overall, ["kind"]); if (kind === "no-decision" && selected !== undefined) fail("link"); if (kind === "rejected-all" && dispositions.some((entry) => (entry as UnknownRecord).disposition !== "rejected")) fail("link"); }
  text(value.summary, 4_096, true); digest(value.reviewDigest);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value !== null && typeof value === "object" && !seen.has(value)) { seen.add(value); Object.values(value as UnknownRecord).forEach((child) => deepFreeze(child, seen)); Object.freeze(value); }
  return value;
}

export async function validateDesignEvidencePacket(raw: unknown): Promise<DesignEvidencePacket> {
  const value = record(raw); if (value.schemaVersion !== 1) fail("schema");
  if (value.schema === "tfsb.design-brief") await validateBrief(value);
  else if (value.schema === "tfsb.design-candidate") await validateCandidate(value);
  else if (value.schema === "tfsb.design-review") validateReview(value);
  else fail("schema");
  const packet = value as unknown as DesignEvidencePacket;
  const expected = packet.schema === "tfsb.design-brief" ? packet.briefDigest : packet.schema === "tfsb.design-candidate" ? packet.candidateDigest : packet.reviewDigest;
  if (await computePacketDigest(packet) !== expected) fail("digest");
  return deepFreeze(structuredClone(packet));
}

export function validateDesignEvidenceReviewLinks(review: ReviewPacket, candidates: readonly CandidatePacket[]): void {
  const byDigest = new Map(candidates.map((candidate) => [candidate.candidateDigest, candidate]));
  if (review.candidateDigests.length !== candidates.length || review.candidateDigests.some((candidateDigest) => !byDigest.has(candidateDigest))) fail("link");
  for (const annotation of review.annotations) { const candidate = byDigest.get(annotation.candidateDigest); const visual = candidate?.visualEvidence.find((entry) => entry.evidenceDigest === annotation.visualEvidenceDigest); if (!visual?.artifacts.some((artifact) => artifact.role === annotation.artifactRole && artifact.pngDigest === annotation.pngDigest)) fail("link"); }
}

export type { BriefPacket, CandidatePacket, Material, Proposal, ReviewAnnotation, ReviewPacket };

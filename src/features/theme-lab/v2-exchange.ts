import {
  validateHexDigest,
  validateSafeRevision,
  validateThemeDescriptorV2,
  validateThemeSpecificationV2,
  validateThemeV2Styles,
  verifyThemeV2CompiledCssAndInventory,
  type ThemeDescriptorV2,
  type ThemeSpecificationV2,
  type ThemeV2StyleFile,
} from "./v2-bridge";
import {
  ThemeLabValidationError,
  validateCandidateAdoptResponseV2,
  validateCandidateVerifyResponseV2,
} from "./theme-lab-bridge";
import type {
  ContrastDiagnostic,
  ThemeCandidateAdoptResponseV2,
  ThemeCandidateVerificationResultV2,
  ThemeCandidateVerifyResponseV2,
  ThemeLabBridge,
  ThemeLabError,
  ThemeReviewContextV1,
  ThemeReviewDispositionV2,
} from "./types";

// ---------------------------------------------------------------------------
// Schemas and Constants
// ---------------------------------------------------------------------------

export const REVIEW_CONTEXT_SCHEMA = "tfsb.theme-review-context-v1" as const;
export const REVIEW_CONTEXT_SCHEMA_VERSION = 1 as const;

export const CANDIDATE_VERIFICATION_SCHEMA = "tfsb.theme-candidate-verification-v2" as const;
export const CANDIDATE_VERIFICATION_SCHEMA_VERSION = 2 as const;

export const MAX_TITLE_LENGTH = 160;
export const MAX_GOAL_LENGTH = 4096;
export const MAX_SUMMARY_LENGTH = 4096;

export const DISPOSITIONS: readonly ThemeReviewDispositionV2[] = [
  "approve",
  "revise",
  "reject",
] as const;

export const CATALOG_CANDIDATE_ID_OVERRIDE_NOTICE =
  "Catalog candidate ID overridden with digest-derived canonical identity" as const;

export type CandidateFamilyV2 = "catalog" | "core-code";

export interface ParsedCandidateV2 {
  readonly family: CandidateFamilyV2;
  readonly schema: string;
  readonly schemaVersion: number;
  readonly candidateId: string;
  readonly candidateDigest: string; // 64-character lowercase hex without 'sha256:' prefix
  readonly theme: ThemeSpecificationV2;
  readonly canonicalJson: string;
  readonly briefDigest?: string | undefined;
  readonly rationale?: string | undefined;
  readonly claimedDiagnostics?: readonly ContrastDiagnostic[] | undefined;
  readonly claimedCssDigest?: string | undefined;
  readonly overrideNotice?: string | undefined;
}

// ---------------------------------------------------------------------------
// Local Review Context Validator & Factory
// ---------------------------------------------------------------------------

export function createReviewContextV1(input: {
  title: string;
  goal: string;
  candidateDigest: string;
  disposition: ThemeReviewDispositionV2;
  summary: string;
}): ThemeReviewContextV1 {
  const title = input.title.trim();
  if (!title) {
    throw new ThemeLabValidationError("Brief title cannot be empty");
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ThemeLabValidationError(
      `Brief title length (${title.length}) exceeds maximum allowed of ${MAX_TITLE_LENGTH} characters`
    );
  }

  const goal = input.goal;
  if (goal.length > MAX_GOAL_LENGTH) {
    throw new ThemeLabValidationError(
      `Brief goal length (${goal.length}) exceeds maximum allowed of ${MAX_GOAL_LENGTH} characters`
    );
  }

  const summary = input.summary;
  if (summary.length > MAX_SUMMARY_LENGTH) {
    throw new ThemeLabValidationError(
      `Review summary length (${summary.length}) exceeds maximum allowed of ${MAX_SUMMARY_LENGTH} characters`
    );
  }

  if (!DISPOSITIONS.includes(input.disposition)) {
    throw new ThemeLabValidationError(
      `Invalid review disposition '${String(input.disposition)}'. Expected 'approve' | 'revise' | 'reject'`
    );
  }

  const cleanDigest = validateHexDigest(
    input.candidateDigest.replace(/^sha256:/, "").toLowerCase(),
    "candidateDigest"
  );

  return {
    schema: REVIEW_CONTEXT_SCHEMA,
    schemaVersion: REVIEW_CONTEXT_SCHEMA_VERSION,
    brief: {
      title,
      goal,
    },
    candidateDigest: cleanDigest,
    disposition: input.disposition,
    summary,
  };
}

export function validateReviewContextV1(value: unknown): ThemeReviewContextV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ThemeLabValidationError("Expected review context object");
  }
  const obj = value as Record<string, unknown>;

  if (obj.schema !== REVIEW_CONTEXT_SCHEMA) {
    throw new ThemeLabValidationError(
      `Expected context schema '${REVIEW_CONTEXT_SCHEMA}', received '${String(obj.schema)}'`
    );
  }
  if (obj.schemaVersion !== REVIEW_CONTEXT_SCHEMA_VERSION) {
    throw new ThemeLabValidationError(
      `Expected context schemaVersion ${REVIEW_CONTEXT_SCHEMA_VERSION}, received ${String(obj.schemaVersion)}`
    );
  }

  if (typeof obj.brief !== "object" || obj.brief === null || Array.isArray(obj.brief)) {
    throw new ThemeLabValidationError("Context brief must be an object");
  }
  const briefObj = obj.brief as Record<string, unknown>;

  if (typeof briefObj.title !== "string" || !briefObj.title.trim()) {
    throw new ThemeLabValidationError("Brief title must be a non-empty string");
  }
  if (briefObj.title.trim().length > MAX_TITLE_LENGTH) {
    throw new ThemeLabValidationError(
      `Brief title length (${briefObj.title.trim().length}) exceeds maximum of ${MAX_TITLE_LENGTH}`
    );
  }

  if (typeof briefObj.goal !== "string") {
    throw new ThemeLabValidationError("Brief goal must be a string");
  }
  if (briefObj.goal.length > MAX_GOAL_LENGTH) {
    throw new ThemeLabValidationError(
      `Brief goal length (${briefObj.goal.length}) exceeds maximum of ${MAX_GOAL_LENGTH}`
    );
  }

  const candidateDigest = validateHexDigest(
    typeof obj.candidateDigest === "string" ? obj.candidateDigest.replace(/^sha256:/, "").toLowerCase() : "",
    "candidateDigest"
  );

  const disposition = obj.disposition as ThemeReviewDispositionV2;
  if (!DISPOSITIONS.includes(disposition)) {
    throw new ThemeLabValidationError(
      `Invalid disposition '${String(obj.disposition)}'. Expected 'approve' | 'revise' | 'reject'`
    );
  }

  if (typeof obj.summary !== "string") {
    throw new ThemeLabValidationError("Review summary must be a string");
  }
  if (obj.summary.length > MAX_SUMMARY_LENGTH) {
    throw new ThemeLabValidationError(
      `Review summary length (${obj.summary.length}) exceeds maximum of ${MAX_SUMMARY_LENGTH}`
    );
  }

  return {
    schema: REVIEW_CONTEXT_SCHEMA,
    schemaVersion: REVIEW_CONTEXT_SCHEMA_VERSION,
    brief: {
      title: briefObj.title.trim(),
      goal: briefObj.goal,
    },
    candidateDigest,
    disposition,
    summary: obj.summary,
  };
}

// ---------------------------------------------------------------------------
// Candidate Packet Parser & Family Discriminator
// ---------------------------------------------------------------------------

export function parseCandidatePacketV2(input: unknown): ParsedCandidateV2 {
  let canonicalJson: string;
  let obj: Record<string, unknown>;

  if (typeof input === "string") {
    canonicalJson = input;
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ThemeLabValidationError("Parsed JSON is not an object");
      }
      obj = parsed as Record<string, unknown>;
    } catch (err: any) {
      throw new ThemeLabValidationError(`Invalid candidate JSON string: ${err.message || String(err)}`);
    }
  } else if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    obj = input as Record<string, unknown>;
    try {
      canonicalJson = JSON.stringify(input);
    } catch {
      canonicalJson = "";
    }
  } else {
    throw new ThemeLabValidationError("Expected candidate packet object or JSON string");
  }

  // Reject v1 candidates: never convert v1
  if (
    obj.schema === "tfsl.theme-candidate" &&
    (obj.schemaVersion === 1 || obj.schemaVersion === undefined || obj.schemaVersion === null)
  ) {
    throw new ThemeLabValidationError(
      "Legacy v1 candidates (tfsl.theme-candidate v1) cannot be converted to v2. Only v2 candidates are supported."
    );
  }

  let family: CandidateFamilyV2;
  if (obj.schema === "tfsl.theme-catalog-candidate" && obj.schemaVersion === 1) {
    family = "catalog";
  } else if (obj.schema === "tfsl.theme-candidate" && obj.schemaVersion === 2) {
    family = "core-code";
  } else {
    throw new ThemeLabValidationError(
      `Unsupported candidate packet schema '${String(obj.schema)}' version ${String(obj.schemaVersion)}`
    );
  }

  if (typeof obj.candidateDigest !== "string" || !obj.candidateDigest.trim()) {
    throw new ThemeLabValidationError("Candidate packet missing valid 'candidateDigest'");
  }
  const cleanDigest = validateHexDigest(
    obj.candidateDigest.replace(/^sha256:/, "").toLowerCase(),
    "candidateDigest"
  );

  // Catalog packets have no candidateId. Use their validated digest as a
  // filename-safe display identity without changing the authenticated packet.
  let candidateId = cleanDigest;
  let overrideNotice: string | undefined = undefined;

  if (family === "catalog") {
    if (Object.hasOwn(obj, "candidateId") && obj.candidateId !== cleanDigest) {
      overrideNotice = CATALOG_CANDIDATE_ID_OVERRIDE_NOTICE;
    }
  } else if (family === "core-code") {
    if (typeof obj.candidateId !== "string" || !obj.candidateId.trim()) {
      throw new ThemeLabValidationError("Candidate packet missing valid 'candidateId'");
    }
    candidateId = obj.candidateId.trim();
  }

  // Validate theme specification adheres strictly to v2
  const rawTheme = obj.theme ?? (obj as any).specification;
  if (!rawTheme || typeof rawTheme !== "object") {
    throw new ThemeLabValidationError("Candidate packet missing 'theme' specification");
  }
  const theme = validateThemeSpecificationV2(rawTheme);

  return {
    family,
    schema: obj.schema as string,
    schemaVersion: obj.schemaVersion as number,
    candidateId,
    candidateDigest: cleanDigest,
    theme,
    canonicalJson,
    briefDigest: typeof obj.briefDigest === "string" ? obj.briefDigest : undefined,
    rationale: typeof obj.rationale === "string" ? obj.rationale : undefined,
    claimedDiagnostics: Array.isArray(obj.claimedDiagnostics) ? (obj.claimedDiagnostics as ContrastDiagnostic[]) : undefined,
    claimedCssDigest: typeof obj.claimedCssDigest === "string" ? obj.claimedCssDigest : undefined,
    overrideNotice,
  };
}

// ---------------------------------------------------------------------------
// Candidate Verification Executor (Fail-Closed)
// ---------------------------------------------------------------------------

export async function executeCandidateVerification(
  bridge: ThemeLabBridge,
  params: {
    rawCandidateBytes: string;
    candidate: ParsedCandidateV2;
    context: ThemeReviewContextV1;
    sessionId?: string | undefined;
    draftRevision: number;
    options?: {
      strictContrast?: boolean | undefined;
      accent?: string | undefined;
    } | undefined;
  }
): Promise<ThemeCandidateVerificationResultV2> {
  validateSafeRevision(params.draftRevision, "draftRevision");
  validateReviewContextV1(params.context);

  if (params.context.candidateDigest !== params.candidate.candidateDigest) {
    throw new ThemeLabValidationError(
      `Context candidateDigest '${params.context.candidateDigest}' does not match candidate '${params.candidate.candidateDigest}'`
    );
  }

  let verifyResponse: ThemeCandidateVerifyResponseV2;

  if (typeof bridge.verifyCandidateV2 === "function") {
    verifyResponse = await bridge.verifyCandidateV2({
      candidate: params.rawCandidateBytes,
      brief: JSON.stringify(params.context),
      sessionId: params.sessionId,
      uiRevision: params.draftRevision,
      options: params.options,
    });
  } else if (typeof bridge.verifyThemeCandidate === "function") {
    const raw = await bridge.verifyThemeCandidate({
      candidate: params.rawCandidateBytes,
      brief: JSON.stringify(params.context),
      options: params.options,
    });
    verifyResponse = await validateCandidateVerifyResponseV2(raw);
  } else {
    throw new ThemeLabValidationError("Theme Lab bridge does not support candidate verification");
  }

  if (!verifyResponse.valid) {
    if (verifyResponse.candidateVerification) {
      return verifyResponse.candidateVerification;
    }
    const errMessage = typeof verifyResponse.error === "string"
      ? verifyResponse.error
      : verifyResponse.error?.message ?? "Candidate verification failed";
    return {
      schema: CANDIDATE_VERIFICATION_SCHEMA,
      schemaVersion: CANDIDATE_VERIFICATION_SCHEMA_VERSION,
      valid: false,
      candidateId: params.candidate.candidateId,
      candidateDigest: params.candidate.candidateDigest,
      inputDigest: "",
      outputDigest: "",
      diagnostics: verifyResponse.diagnostics ?? [],
      errors: [errMessage],
      warnings: [],
    };
  }

  if (!verifyResponse.candidateVerification) {
    throw new ThemeLabValidationError("Valid candidate verification missing candidateVerification result");
  }

  const cv = verifyResponse.candidateVerification;

  // Fail closed on digest mismatch between verified DTO and imported candidate
  if (cv.candidateDigest !== params.candidate.candidateDigest) {
    throw new ThemeLabValidationError(
      `Verification result candidateDigest '${cv.candidateDigest}' does not match candidate '${params.candidate.candidateDigest}'`
    );
  }

  return cv;
}

// ---------------------------------------------------------------------------
// Candidate Adoption Executor
// ---------------------------------------------------------------------------

export async function executeCandidateAdoption(
  bridge: ThemeLabBridge,
  params: {
    rawCandidateBytes: string;
    candidate: ParsedCandidateV2;
    context: ThemeReviewContextV1;
    verifiedResult: ThemeCandidateVerificationResultV2;
    sessionId?: string | undefined;
    draftRevision: number;
    adoptionRevision?: number | undefined;
    force?: boolean | undefined;
    options?: {
      strictContrast?: boolean | undefined;
      accent?: string | undefined;
    } | undefined;
  }
): Promise<{
  adopted: boolean;
  requiresConfirmation?: boolean | undefined;
  specification?: ThemeSpecificationV2 | undefined;
  descriptor?: ThemeDescriptorV2 | undefined;
  styles?: readonly ThemeV2StyleFile[] | undefined;
  compiledCss?: string | undefined;
  compiledResult?: ThemeCandidateVerificationResultV2 | undefined;
  error?: ThemeLabError | string | undefined;
}> {
  validateSafeRevision(params.draftRevision, "draftRevision");
  const adoptionRevision = params.adoptionRevision ?? params.draftRevision + 1;
  validateSafeRevision(adoptionRevision, "adoptionRevision");
  if (adoptionRevision <= params.draftRevision) throw new ThemeLabValidationError("Adoption must advance the draft revision");
  if (!params.verifiedResult.valid) {
    throw new ThemeLabValidationError("Cannot adopt unverified or invalid candidate");
  }
  if (params.verifiedResult.candidateDigest !== params.candidate.candidateDigest) {
    throw new ThemeLabValidationError("Verified result candidateDigest does not match active candidate");
  }
  if (params.context.candidateDigest !== params.candidate.candidateDigest) {
    throw new ThemeLabValidationError("Context candidateDigest does not match active candidate");
  }

  let adoptResponse: ThemeCandidateAdoptResponseV2;

  if (typeof bridge.adoptCandidateV2 === "function") {
    adoptResponse = await bridge.adoptCandidateV2({
      candidate: params.rawCandidateBytes,
      brief: JSON.stringify(params.context),
      sessionId: params.sessionId ?? "",
      uiRevision: adoptionRevision,
      force: params.force,
      options: params.options,
    });
  } else if (typeof bridge.adoptCandidate === "function") {
    const raw = await bridge.adoptCandidate({
      candidate: params.rawCandidateBytes,
      brief: JSON.stringify(params.context),
      sessionId: params.sessionId ?? "",
      uiRevision: adoptionRevision,
      force: params.force,
      options: params.options,
    });
    adoptResponse = await validateCandidateAdoptResponseV2(raw);
  } else {
    throw new ThemeLabValidationError("Theme Lab bridge does not support candidate adoption");
  }

  if (adoptResponse.requiresConfirmation && !params.force) {
    return {
      adopted: false,
      requiresConfirmation: true,
    };
  }

  if (adoptResponse.adopted && adoptResponse.specification) {
    return {
      adopted: true,
      specification: adoptResponse.specification,
      descriptor: adoptResponse.descriptor,
      styles: adoptResponse.styles,
      compiledCss: adoptResponse.compiledCss,
      compiledResult: params.verifiedResult,
    };
  }

  return {
    adopted: false,
    error: adoptResponse.error,
  };
}

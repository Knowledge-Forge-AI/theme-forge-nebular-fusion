import type {
  ThemeAnnotation,
  ThemeAnnotationCategory,
  ThemeAnnotationSeverity,
  ThemeBriefCreateInput,
  ThemeBriefPacket,
  ThemeCandidateDisposition,
  ThemeReviewCreateInput,
  ThemeReviewOverallDisposition,
  ThemeSpecification,
  ThemeVisualRecord,
} from "./types";

const encoder = new TextEncoder();

/**
 * Compare two strings lexicographically by their UTF-8 byte representation.
 * Conforms to the TFSL canonical ordering specification.
 */
export function compareUtf8(a: string, b: string): number {
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  const minLen = Math.min(bufA.length, bufB.length);
  for (let i = 0; i < minLen; i++) {
    const byteA = bufA[i] ?? 0;
    const byteB = bufB[i] ?? 0;
    if (byteA !== byteB) {
      return byteA - byteB;
    }
  }
  return bufA.length - bufB.length;
}

const ID_REGEX = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const DIGEST_REGEX = /^sha256:[0-9a-f]{64}$/;

export function isValidId(id: string): boolean {
  return typeof id === "string" && ID_REGEX.test(id.trim());
}

export function isValidDigest(digest: string): boolean {
  return typeof digest === "string" && DIGEST_REGEX.test(digest.trim());
}

export interface BuildBriefCreateInputParams {
  briefId: string;
  title: string;
  goal: string;
  baselineTheme: ThemeSpecification;
  allowedFields?: readonly string[] | undefined;
  allowedModes?: readonly ("dark" | "light")[] | undefined;
  approvedTemplates?: readonly string[] | undefined;
  acceptanceCriteria?: readonly string[] | undefined;
  prohibitedChanges?: readonly string[] | undefined;
  visualEvidence?: readonly ThemeVisualRecord[] | undefined;
  metadata?: {
    author?: string | undefined;
    timestamp?: string | undefined;
  } | undefined;
  adapter?: string | undefined;
}

/**
 * Pure typed request builder for ThemeBriefCreateInput.
 * Applies TFSL creator input contracts from packages/stellar-loom:
 * - Sanitizes and validates briefId, title, and goal
 * - Ensures canonical UTF-8 sorting of allowedFields, allowedModes, and approvedTemplates
 * - Incorporates editable brief constraints derived from current draft
 */
export function buildThemeBriefCreateInput(params: BuildBriefCreateInputParams): ThemeBriefCreateInput {
  const briefId = params.briefId.trim();
  if (!isValidId(briefId)) {
    throw new Error(`Invalid briefId '${briefId}'. Must match ${ID_REGEX.source}`);
  }

  const title = params.title.trim();
  if (!title) {
    throw new Error("Brief title cannot be empty");
  }

  const goal = params.goal.trim();
  if (!goal) {
    throw new Error("Brief goal cannot be empty");
  }

  if (!params.baselineTheme || typeof params.baselineTheme !== "object" || !params.baselineTheme.name) {
    throw new Error("Valid baselineTheme specification is required");
  }

  const allowedFields = params.allowedFields
    ? [...new Set(params.allowedFields.map((f) => f.trim()).filter(Boolean))].sort(compareUtf8)
    : [];

  const allowedModes: ("dark" | "light")[] = params.allowedModes !== undefined
    ? [...new Set(params.allowedModes)].sort(compareUtf8) as ("dark" | "light")[]
    : ["dark", "light"];

  const approvedTemplates = params.approvedTemplates
    ? [...new Set(params.approvedTemplates.map((t) => t.trim()).filter(Boolean))].sort(compareUtf8)
    : [];

  const acceptanceCriteria = params.acceptanceCriteria
    ? params.acceptanceCriteria.map((c) => c.trim()).filter(Boolean)
    : [];

  const prohibitedChanges = params.prohibitedChanges
    ? params.prohibitedChanges.map((p) => p.trim()).filter(Boolean)
    : [];

  const visualEvidence = params.visualEvidence ? [...params.visualEvidence] : [];

  const result: ThemeBriefCreateInput = {
    briefId,
    title,
    goal,
    baselineTheme: params.baselineTheme,
    allowedFields,
    allowedModes,
    approvedTemplates,
    acceptanceCriteria,
    prohibitedChanges,
    visualEvidence,
    adapter: params.adapter?.trim() || params.baselineTheme.adapter || "starlight-v0.42",
    ...(params.metadata
      ? {
          metadata: {
            author: params.metadata.author?.trim() || undefined,
            timestamp: params.metadata.timestamp?.trim() || undefined,
          },
        }
      : {}),
  };

  return result;
}

export interface BuildReviewCreateInputParams {
  reviewId: string;
  brief: ThemeBriefPacket | string;
  candidateDigests: readonly string[];
  dispositions: Record<string, { disposition: ThemeCandidateDisposition; comment?: string | undefined }>;
  overallDisposition: ThemeReviewOverallDisposition;
  annotations?: readonly ThemeAnnotation[] | undefined;
  summary: string;
}

const VALID_DISPOSITIONS: ReadonlySet<ThemeCandidateDisposition> = new Set([
  "unreviewed",
  "preferred",
  "approved",
  "rejected",
  "needs-revision",
  "deferred",
]);

/**
 * Pure typed request builder for ThemeReviewCreateInput.
 * Applies TFSL creator input contracts from packages/stellar-loom:
 * - Requires actual brief and reviewId (no unknown digest or fake candidate fallback)
 * - Exact protocol enums for candidate dispositions and discriminated overall disposition
 * - Omits empty or whitespace-only optional comments
 * - Orders candidateDigests and dispositions in canonical UTF-8 sequence
 */
export function buildThemeReviewCreateInput(params: BuildReviewCreateInputParams): ThemeReviewCreateInput {
  const reviewId = params.reviewId.trim();
  if (!isValidId(reviewId)) {
    throw new Error(`Invalid reviewId '${reviewId}'. Must match ${ID_REGEX.source}`);
  }

  let briefDigest = "";
  if (typeof params.brief === "string") {
    briefDigest = params.brief.trim();
    if (!isValidDigest(briefDigest)) {
      throw new Error(`Invalid briefDigest '${briefDigest}'. An actual brief digest is required.`);
    }
  } else if (params.brief && typeof params.brief === "object" && typeof params.brief.briefDigest === "string") {
    briefDigest = params.brief.briefDigest.trim();
    if (!isValidDigest(briefDigest)) {
      throw new Error(`Invalid briefDigest in brief packet '${briefDigest}'.`);
    }
  } else {
    throw new Error("Actual brief or brief digest is required for review creation. Unknown digest fallback is prohibited.");
  }

  if (!params.candidateDigests || params.candidateDigests.length === 0) {
    throw new Error("At least one candidateDigest is required for review creation");
  }

  for (const dig of params.candidateDigests) {
    if (!isValidDigest(dig)) {
      throw new Error(`Invalid candidateDigest '${dig}' in candidateDigests.`);
    }
  }

  // Canonical unique UTF-8 sorted candidateDigests
  const sortedCandidateDigests = [...new Set(params.candidateDigests.map((d) => d.trim()))].sort(compareUtf8);
  const candidateSet = new Set(sortedCandidateDigests);

  // Build dispositions matching sortedCandidateDigests order exactly
  let preferredOrApprovedCount = 0;
  const dispositions: { candidateDigest: string; disposition: ThemeCandidateDisposition; comment?: string | undefined }[] = [];

  for (const candDigest of sortedCandidateDigests) {
    const entry = params.dispositions[candDigest];
    const dispKind: ThemeCandidateDisposition = entry && VALID_DISPOSITIONS.has(entry.disposition)
      ? entry.disposition
      : "unreviewed";

    if (dispKind === "preferred" || dispKind === "approved") {
      preferredOrApprovedCount++;
    }

    const item: { candidateDigest: string; disposition: ThemeCandidateDisposition; comment?: string | undefined } = {
      candidateDigest: candDigest,
      disposition: dispKind,
    };

    // Omit empty optional comments
    const trimmedComment = entry?.comment?.trim();
    if (trimmedComment) {
      item.comment = entry!.comment!;
    }

    dispositions.push(item);
  }

  if (preferredOrApprovedCount > 1) {
    throw new Error("At most one candidate may be marked 'preferred' or 'approved'");
  }

  // Validate discriminated overallDisposition
  const overall = params.overallDisposition;
  let validatedOverall: ThemeReviewOverallDisposition;

  if (overall.kind === "no-decision") {
    if (preferredOrApprovedCount > 0) {
      throw new Error("overallDisposition cannot be 'no-decision' when a candidate is preferred or approved");
    }
    validatedOverall = { kind: "no-decision" };
  } else if (overall.kind === "rejected-all") {
    const allRejected = dispositions.every((d) => d.disposition === "rejected");
    if (!allRejected) {
      throw new Error("overallDisposition 'rejected-all' requires all candidates to have 'rejected' disposition");
    }
    validatedOverall = { kind: "rejected-all" };
  } else if (overall.kind === "preferred" || overall.kind === "approved" || overall.kind === "needs-revision") {
    const targetDigest = overall.candidateDigest?.trim();
    if (!targetDigest || !isValidDigest(targetDigest)) {
      throw new Error(`overallDisposition '${overall.kind}' requires a valid candidateDigest. First-candidate fallback is prohibited.`);
    }
    if (!candidateSet.has(targetDigest)) {
      throw new Error(`overallDisposition candidateDigest '${targetDigest}' not found in candidateDigests`);
    }
    const matchingDisp = dispositions.find((d) => d.candidateDigest === targetDigest);
    if (!matchingDisp || matchingDisp.disposition !== overall.kind) {
      throw new Error(
        `overallDisposition '${overall.kind}' requires candidate '${targetDigest}' to have matching disposition '${overall.kind}' (got '${matchingDisp?.disposition}')`
      );
    }
    validatedOverall = { kind: overall.kind, candidateDigest: targetDigest };
  } else {
    throw new Error(`Invalid overallDisposition kind '${(overall as any).kind}'`);
  }

  // Filter and sort annotations
  const annotations: ThemeAnnotation[] = [];
  if (params.annotations && params.annotations.length > 0) {
    for (const ann of params.annotations) {
      if (!candidateSet.has(ann.candidateDigest)) throw new Error("Annotation refers to a candidate outside this review.");
      annotations.push(ann);
    }
    annotations.sort((a, b) => compareUtf8(a.annotationId, b.annotationId));
  }

  const summary = params.summary;
  if (!summary.trim()) {
    throw new Error("Review summary text cannot be empty");
  }

  return {
    reviewId,
    brief: typeof params.brief === "string" ? briefDigest : params.brief,
    candidateDigests: sortedCandidateDigests,
    dispositions,
    annotations: annotations.length > 0 ? annotations : undefined,
    overallDisposition: validatedOverall,
    summary,
  };
}

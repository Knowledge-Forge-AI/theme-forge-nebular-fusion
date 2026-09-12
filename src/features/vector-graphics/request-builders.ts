// Pure typed request builders for Vector Graphics workbench operations.
// Constructs closed, path-free requests adhering to TFSB63A.

import type {
  Artboard,
  LayoutDirective,
  Presentation,
  SceneAccessibility,
  SceneAdoptRequest,
  SceneApplyRequest,
  SceneBriefRequest,
  SceneCompileRequest,
  SceneEditOperation,
  SceneEditRequest,
  SceneElement,
  SceneExpected,
  SceneExportPlanRequest,
  SceneNewRequest,
  SceneProfile,
  SceneReviewAnnotationDto,
  SceneReviewRequest,
  SceneSavePlanRequest,
  SceneTokenBindRequest,
  SceneVerifyRequest,
  VectorScene,
} from "./types";

export function buildExpected(
  sessionId: string,
  revision: number,
  draftInputDigest?: string,
  sourceId?: string,
  tokenSnapshotId?: string,
  engineIdentity?: string,
): SceneExpected {
  return {
    sessionId: sessionId.trim(),
    revision,
    draftInputDigest: draftInputDigest?.trim(),
    sourceId: sourceId?.trim(),
    tokenSnapshotId: tokenSnapshotId?.trim(),
    engineIdentity: engineIdentity?.trim(),
  };
}

export function buildNewSceneRequest(params: {
  expected?: SceneExpected;
  profile?: SceneProfile;
  preset?: string;
  artboard?: Artboard;
  title?: string;
  replacementIntentId?: string;
}): SceneNewRequest {
  return {
    expected: params.expected,
    replacementIntentId: params.replacementIntentId?.trim(),
    profile: params.profile,
    preset: params.preset?.trim(),
    artboard: params.artboard,
    title: params.title?.trim(),
  };
}

export function buildEditRequest(
  expected: SceneExpected,
  operations: readonly SceneEditOperation[],
): SceneEditRequest {
  if (operations.length === 0) {
    throw new Error("Cannot build edit request with zero operations");
  }
  return {
    expected,
    operations,
  };
}

export function buildCompileRequest(
  expected: SceneExpected,
  dryRun?: boolean,
): SceneCompileRequest {
  return {
    expected,
    dryRun: dryRun ?? false,
  };
}

export function buildSavePlanRequest(
  expected: SceneExpected,
  defaultName?: string,
): SceneSavePlanRequest {
  return {
    expected,
    defaultName: defaultName?.trim(),
  };
}

export function buildApplyRequest(
  expected: SceneExpected,
  planId: string,
): SceneApplyRequest {
  if (!planId.trim()) {
    throw new Error("planId must not be empty");
  }
  return {
    expected,
    planId: planId.trim(),
  };
}

export function buildExportPlanRequest(
  expected: SceneExpected,
  defaultName?: string,
): SceneExportPlanRequest {
  return {
    expected,
    defaultName: defaultName?.trim(),
  };
}

export function buildTokenBindRequest(
  expected: SceneExpected,
  projectHandle: string,
): SceneTokenBindRequest {
  const clean = projectHandle.trim();
  if (!clean) {
    throw new Error("projectHandle must not be empty");
  }
  return {
    expected,
    projectHandle: clean,
  };
}

export function buildBriefRequest(
  expected: SceneExpected,
  title: string,
  objective: string,
  acceptanceCriteria?: readonly string[],
  prohibitedChanges?: readonly string[],
): SceneBriefRequest {
  const cleanTitle = title.trim();
  const cleanObjective = objective.trim();
  if (!cleanTitle) throw new Error("Brief title must not be empty");
  if (!cleanObjective) throw new Error("Brief objective must not be empty");

  return {
    expected,
    title: cleanTitle,
    objective: cleanObjective,
    acceptanceCriteria: acceptanceCriteria ? acceptanceCriteria.map((c) => c.trim()).filter(Boolean) : [],
    prohibitedChanges: prohibitedChanges ? prohibitedChanges.map((p) => p.trim()).filter(Boolean) : [],
  };
}

export function buildReviewRequest(
  expected: SceneExpected,
  briefPacketId: string,
  candidatePacketIds: readonly string[],
  overallDisposition: string,
  summary: string,
  annotations?: readonly SceneReviewAnnotationDto[],
): SceneReviewRequest {
  if (!briefPacketId.trim()) throw new Error("briefPacketId must not be empty");
  if (!summary.trim()) throw new Error("summary must not be empty");

  return {
    expected,
    briefPacketId: briefPacketId.trim(),
    candidatePacketIds: candidatePacketIds.map((id) => id.trim()).filter(Boolean),
    overallDisposition: overallDisposition.trim(),
    summary: summary.trim(),
    annotations: annotations ?? [],
  };
}

export function buildVerifyRequest(
  expected: SceneExpected,
  candidatePacketId: string,
  briefPacketId?: string,
): SceneVerifyRequest {
  if (!candidatePacketId.trim()) throw new Error("candidatePacketId must not be empty");
  return {
    expected,
    candidatePacketId: candidatePacketId.trim(),
    briefPacketId: briefPacketId?.trim(),
  };
}

export function buildAdoptRequest(
  expected: SceneExpected,
  verificationHandle: string,
): SceneAdoptRequest {
  if (!verificationHandle.trim()) throw new Error("verificationHandle must not be empty");
  return {
    expected,
    verificationHandle: verificationHandle.trim(),
  };
}

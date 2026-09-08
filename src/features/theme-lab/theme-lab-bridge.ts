import { invoke } from "@tauri-apps/api/core";
import type {
  ContrastDiagnostic,
  ThemeBriefCreateRequest,
  ThemeBriefCreateResponse,
  ThemeCandidateAdoptRequest,
  ThemeCandidateAdoptResponse,
  ThemeCandidateVerifyRequest,
  ThemeCandidateVerifyResponse,
  ThemeCandidateVerificationResult,
  ThemeDescriptor,
  ThemeLabBridge,
  ThemeLabCompileRequest,
  ThemeLabCompileResponse,
  ThemeLabError,
  ThemeLabExampleResponse,
  ThemeLabOpenResponse,
  ThemeLabSaveRequest,
  ThemeLabSaveResponse,
  ThemeLabStatusResponse,
  ThemePacketExportRequest,
  ThemePacketExportResponse,
  ThemePacketImportRequest,
  ThemePacketImportResponse,
  ThemeReviewCreateRequest,
  ThemeReviewCreateResponse,
  ThemeReviewValidateRequest,
  ThemeReviewValidateResponse,
  ThemeReviewValidationResult,
  ThemeSpecification,
} from "./types";

export const THEME_LAB_COMMANDS = {
  status: "studio_theme_lab_status",
  compile: "studio_theme_lab_compile",
  example: "studio_theme_lab_example",
  open: "studio_theme_lab_open",
  save: "studio_theme_lab_save",
  dispose: "studio_theme_lab_dispose",
  briefCreate: "studio_theme_brief_create",
  packetImport: "studio_theme_packet_import",
  packetExport: "studio_theme_packet_export",
  reviewCreate: "studio_theme_review_create",
  candidateAdopt: "studio_theme_candidate_adopt",
  candidateVerify: "studio_theme_candidate_verify",
  reviewValidate: "studio_theme_review_validate",
} as const;

export class ThemeLabValidationError extends Error {
  constructor(message = "Theme Lab backend returned an invalid typed response") {
    super(message);
    this.name = "ThemeLabValidationError";
  }
}

function expectObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ThemeLabValidationError("Expected object");
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new ThemeLabValidationError(`Expected string for ${name}`);
  }
  return value;
}

function expectNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ThemeLabValidationError(`Expected number for ${name}`);
  }
  return value;
}

function expectBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new ThemeLabValidationError(`Expected boolean for ${name}`);
  }
  return value;
}

function validateDiagnostics(value: unknown): ContrastDiagnostic[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const obj = expectObject(entry);
    return {
      severity: expectString(obj.severity, "diagnostic severity"),
      code: expectString(obj.code, "diagnostic code"),
      role: expectString(obj.role, "diagnostic role"),
      mode: expectString(obj.mode, "diagnostic mode"),
      element: expectString(obj.element, "diagnostic element"),
      foreground: expectString(obj.foreground, "diagnostic foreground"),
      background: expectString(obj.background, "diagnostic background"),
      ratio: expectNumber(obj.ratio, "diagnostic ratio"),
      displayRatio: expectString(obj.displayRatio, "diagnostic displayRatio"),
      criterion: expectString(obj.criterion, "diagnostic criterion"),
      threshold: expectNumber(obj.threshold, "diagnostic threshold"),
      disposition: expectString(obj.disposition, "diagnostic disposition"),
      message: expectString(obj.message, "diagnostic message"),
    };
  });
}

function validateDescriptor(value: unknown): ThemeDescriptor | undefined {
  if (value === null || value === undefined) return undefined;
  const obj = expectObject(value);
  const provObj = expectObject(obj.provenance);
  return {
    schema: expectString(obj.schema, "descriptor schema"),
    schemaVersion: expectNumber(obj.schemaVersion, "descriptor schemaVersion"),
    themeSchemaVersion: expectString(obj.themeSchemaVersion, "descriptor themeSchemaVersion"),
    themeName: expectString(obj.themeName, "descriptor themeName"),
    themeVersion: expectString(obj.themeVersion, "descriptor themeVersion"),
    adapter: expectString(obj.adapter, "descriptor adapter"),
    inputDigest: expectString(obj.inputDigest, "descriptor inputDigest"),
    outputDigest: expectString(obj.outputDigest, "descriptor outputDigest"),
    cssFile: expectString(obj.cssFile, "descriptor cssFile"),
    provenance: {
      categories: Array.isArray(provObj.categories) ? provObj.categories.map(String) : [],
      compiler: expectString(provObj.compiler, "descriptor compiler"),
      compilerVersion: expectString(provObj.compilerVersion, "descriptor compilerVersion"),
    },
  };
}

function validateError(value: unknown): ThemeLabError | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return { code: "ERROR", message: value };
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const code = typeof obj.code === "string" ? obj.code : "ERROR";
    const message = typeof obj.message === "string" ? obj.message : String(value);
    const fieldPath = typeof obj.fieldPath === "string" ? obj.fieldPath : undefined;
    return { code, message, fieldPath };
  }
  return { code: "ERROR", message: String(value) };
}

export function validateStatusResponse(value: unknown): ThemeLabStatusResponse {
  const obj = expectObject(value);
  return {
    available: expectBoolean(obj.available, "status available"),
    compilerVersion: expectString(obj.compilerVersion, "status compilerVersion"),
    sessionId: typeof obj.sessionId === "string" ? obj.sessionId : undefined,
    latestRevision: typeof obj.latestRevision === "number" ? obj.latestRevision : undefined,
    message: typeof obj.message === "string" ? obj.message : undefined,
  };
}

export function validateCompileResponse(value: unknown): ThemeLabCompileResponse {
  const obj = expectObject(value);
  return {
    uiRevision: expectNumber(obj.uiRevision, "compile uiRevision"),
    valid: expectBoolean(obj.valid, "compile valid"),
    compiledCss: typeof obj.compiledCss === "string" ? obj.compiledCss : undefined,
    descriptor: validateDescriptor(obj.descriptor),
    diagnostics: validateDiagnostics(obj.diagnostics),
    error: validateError(obj.error),
  };
}

export function validateExampleResponse(value: unknown): ThemeLabExampleResponse {
  const obj = expectObject(value);
  return {
    uiRevision: expectNumber(obj.uiRevision, "example uiRevision"),
    valid: expectBoolean(obj.valid, "example valid"),
    exampleName: expectString(obj.exampleName, "example exampleName"),
    specification: obj.specification ? (expectObject(obj.specification) as unknown as ThemeSpecification) : undefined,
    compiledCss: typeof obj.compiledCss === "string" ? obj.compiledCss : undefined,
    descriptor: validateDescriptor(obj.descriptor),
    diagnostics: validateDiagnostics(obj.diagnostics),
    error: validateError(obj.error),
  };
}

export function validateOpenResponse(value: unknown): ThemeLabOpenResponse {
  const obj = expectObject(value);
  return {
    cancelled: expectBoolean(obj.cancelled, "open cancelled"),
    displayName: typeof obj.displayName === "string" ? obj.displayName : undefined,
    specification: obj.specification ? (expectObject(obj.specification) as unknown as ThemeSpecification) : undefined,
    compiledCss: typeof obj.compiledCss === "string" ? obj.compiledCss : undefined,
    descriptor: validateDescriptor(obj.descriptor),
    diagnostics: validateDiagnostics(obj.diagnostics),
    error: validateError(obj.error),
  };
}

export function validateSaveResponse(value: unknown): ThemeLabSaveResponse {
  const obj = expectObject(value);
  return {
    cancelled: expectBoolean(obj.cancelled, "save cancelled"),
    displayName: typeof obj.displayName === "string" ? obj.displayName : undefined,
  };
}

export function validateBriefCreateResponse(value: unknown): ThemeBriefCreateResponse {
  const obj = expectObject(value);
  if (obj.error) throw new ThemeLabValidationError(validateError(obj.error)?.message ?? "Packet creation rejected");
  return {
    packet: expectObject(JSON.parse(expectString(obj.canonicalJson, "canonicalJson"))),
    canonicalJson: expectString(obj.canonicalJson, "canonicalJson"),
    digest: expectString(obj.digest, "digest"),
  };
}

export function validatePacketImportResponse(value: unknown): ThemePacketImportResponse {
  const obj = expectObject(value);
  return {
    cancelled: expectBoolean(obj.cancelled, "import cancelled"),
    displayName: typeof obj.displayName === "string" ? obj.displayName : undefined,
    packet: typeof obj.canonicalJson === "string" ? expectObject(JSON.parse(obj.canonicalJson)) : undefined,
    canonicalJson: typeof obj.canonicalJson === "string" ? obj.canonicalJson : undefined,
    kind: typeof obj.kind === "string" ? obj.kind : undefined,
    digest: typeof obj.digest === "string" ? obj.digest : undefined,
    error: validateError(obj.error),
  };
}

export function validatePacketExportResponse(value: unknown): ThemePacketExportResponse {
  const obj = expectObject(value);
  return {
    cancelled: expectBoolean(obj.cancelled, "export cancelled"),
    saved: expectBoolean(obj.saved, "export saved"),
    displayName: typeof obj.displayName === "string" ? obj.displayName : undefined,
    digest: typeof obj.digest === "string" ? obj.digest : undefined,
    error: validateError(obj.error),
  };
}

export function validateReviewCreateResponse(value: unknown): ThemeReviewCreateResponse {
  const obj = expectObject(value);
  if (obj.error) throw new ThemeLabValidationError(validateError(obj.error)?.message ?? "Packet creation rejected");
  return {
    packet: expectObject(JSON.parse(expectString(obj.canonicalJson, "canonicalJson"))),
    canonicalJson: expectString(obj.canonicalJson, "canonicalJson"),
    digest: expectString(obj.digest, "digest"),
  };
}

export function validateCandidateAdoptResponse(value: unknown): ThemeCandidateAdoptResponse {
  const obj = expectObject(value);
  return {
    adopted: expectBoolean(obj.adopted, "adopted"),
    requiresConfirmation: typeof obj.requiresConfirmation === "boolean" ? obj.requiresConfirmation : undefined,
    specification: obj.specification ? (expectObject(obj.specification) as unknown as ThemeSpecification) : undefined,
    compiledCss: typeof obj.compiledCss === "string" ? obj.compiledCss : undefined,
    descriptor: validateDescriptor(obj.descriptor),
    diagnostics: validateDiagnostics(obj.diagnostics),
    error: validateError(obj.error),
  };
}

export function validateCandidateVerifyResponse(value: unknown): ThemeCandidateVerifyResponse {
  const obj = expectObject(value);
  const result = {
    valid: expectBoolean(obj.valid, "verify valid"),
    compiledCss: typeof obj.compiledCss === "string" ? obj.compiledCss : undefined,
    descriptor: validateDescriptor(obj.descriptor),
    diagnostics: validateDiagnostics(obj.diagnostics),
    candidateVerification: obj.candidateVerification
      ? (expectObject(obj.candidateVerification) as unknown as ThemeCandidateVerificationResult)
      : undefined,
    error: validateError(obj.error),
  };
  if (result.candidateVerification) {
    const verification = result.candidateVerification;
    for (const key of ["candidateId", "candidateDigest", "briefDigest", "themeDigest"] as const) expectString(verification[key], key);
    expectBoolean(verification.valid, "candidate verification valid");
    for (const key of ["errors", "warnings", "constraintViolations"] as const) {
      if (!Array.isArray(verification[key]) || verification[key].some((entry) => typeof entry !== "string")) throw new ThemeLabValidationError(`Invalid verification ${key}`);
    }
  }
  if (result.valid && (!result.compiledCss || !result.descriptor || !result.candidateVerification?.valid
    || result.candidateVerification.themeDigest !== `sha256:${result.descriptor.inputDigest}`
    || result.candidateVerification.computedCssDigest?.replace(/^sha256:/, "") !== result.descriptor.outputDigest
    || !Array.isArray(obj.diagnostics))) {
    throw new ThemeLabValidationError("Candidate success lacks matching local compiler evidence");
  }
  return result;
}

export function validateReviewValidateResponse(value: unknown): ThemeReviewValidateResponse {
  const obj = expectObject(value);
  const result = {
    valid: expectBoolean(obj.valid, "reviewValidate valid"),
    reviewValidation: obj.reviewValidation
      ? (expectObject(obj.reviewValidation) as unknown as ThemeReviewValidationResult)
      : undefined,
    error: validateError(obj.error),
  };
  if (result.valid && (result.reviewValidation?.valid !== true || result.reviewValidation.candidateMatches !== true || result.reviewValidation.dispositionMatches !== true)) throw new ThemeLabValidationError("Review success lacks complete link validation");
  return result;
}

function boundExchangeRequest(request: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 32 * 1024 * 1024 - 1024) {
    throw new ThemeLabValidationError("Complete exchange context exceeds the 32 MiB transport limit; reduce included images or candidates.");
  }
}

export class TauriThemeLabBridge implements ThemeLabBridge {
  async getStatus(): Promise<ThemeLabStatusResponse> {
    const raw = await invoke("studio_theme_lab_status");
    return validateStatusResponse(raw);
  }

  async compile(request: ThemeLabCompileRequest): Promise<ThemeLabCompileResponse> {
    const raw = await invoke("studio_theme_lab_compile", { request });
    return validateCompileResponse(raw);
  }

  async loadExample(name: string, uiRevision?: number, sessionId?: string): Promise<ThemeLabExampleResponse> {
    const raw = await invoke("studio_theme_lab_example", { exampleName: name, uiRevision, sessionId });
    return validateExampleResponse(raw);
  }

  async openTheme(): Promise<ThemeLabOpenResponse> {
    const raw = await invoke("studio_theme_lab_open");
    return validateOpenResponse(raw);
  }

  async saveTheme(request: ThemeLabSaveRequest): Promise<ThemeLabSaveResponse> {
    const raw = await invoke("studio_theme_lab_save", { request });
    return validateSaveResponse(raw);
  }

  async createBrief(request: ThemeBriefCreateRequest): Promise<ThemeBriefCreateResponse> {
    const raw = await invoke(THEME_LAB_COMMANDS.briefCreate, { request: { briefInput: JSON.stringify(request.briefInput) } });
    return validateBriefCreateResponse(raw);
  }

  async importPacket(request?: ThemePacketImportRequest): Promise<ThemePacketImportResponse> {
    const raw = await invoke(THEME_LAB_COMMANDS.packetImport, { request: request ?? {} });
    return validatePacketImportResponse(raw);
  }

  async exportPacket(request: ThemePacketExportRequest): Promise<ThemePacketExportResponse> {
    const raw = await invoke(THEME_LAB_COMMANDS.packetExport, { request });
    return validatePacketExportResponse(raw);
  }

  async createReview(request: ThemeReviewCreateRequest): Promise<ThemeReviewCreateResponse> {
    const raw = await invoke(THEME_LAB_COMMANDS.reviewCreate, { request: { reviewInput: JSON.stringify(request.reviewInput) } });
    return validateReviewCreateResponse(raw);
  }

  async adoptCandidate(request: ThemeCandidateAdoptRequest): Promise<ThemeCandidateAdoptResponse> {
    const raw = await invoke(THEME_LAB_COMMANDS.candidateAdopt, { request });
    return validateCandidateAdoptResponse(raw);
  }

  async verifyThemeCandidate(request: ThemeCandidateVerifyRequest): Promise<ThemeCandidateVerifyResponse> {
    boundExchangeRequest(request);
    const raw = await invoke(THEME_LAB_COMMANDS.candidateVerify, { request });
    return validateCandidateVerifyResponse(raw);
  }

  async validateThemeReview(request: ThemeReviewValidateRequest): Promise<ThemeReviewValidateResponse> {
    boundExchangeRequest(request);
    const raw = await invoke(THEME_LAB_COMMANDS.reviewValidate, { request });
    return validateReviewValidateResponse(raw);
  }

  async dispose(): Promise<void> {
    if (typeof window !== "undefined" && typeof (window as any).__TAURI_INTERNALS__?.invoke === "function") {
      try {
        await invoke(THEME_LAB_COMMANDS.dispose);
      } catch {
        // ignore
      }
    }
  }
}

import { invoke } from "@tauri-apps/api/core";
import { BUILTIN_FORGE_CONSOLE_PROFILE } from "./builtin-profiles";
import type {
  AppThemeBridge,
  AppThemeCompileResult,
  AppThemeStatus,
  AppThemeOpenedDocument,
  AppThemeOpenProfileResponse,
  AppThemeSaveProfileRequest,
  AppThemeSaveProfileResponse,
  PairedCompileResult,
  PairedProfile,
} from "./types";

export class TauriAppThemeBridge implements AppThemeBridge {
  async getStatus(): Promise<AppThemeStatus> {
    try {
      return await invoke<AppThemeStatus>("studio_app_theme_status");
    } catch (e: any) {
      return {
        available: false,
        compilerVersion: "unknown",
        supportedFormats: [],
        sessionId: "unavailable",
        latestRevision: 0,
        message: e?.message || "Failed to communicate with native Application Theme host",
        dirty: false,
      };
    }
  }

  async compile(spec: any, uiRevision?: number): Promise<AppThemeCompileResult> {
    return await invoke<AppThemeCompileResult>("studio_app_theme_compile", {
      request: { specification: spec, uiRevision },
    });
  }

  async pairedCompile(profile: PairedProfile, uiRevision?: number): Promise<PairedCompileResult> {
    return await invoke<PairedCompileResult>("studio_app_theme_paired_compile", {
      request: { profile, uiRevision },
    });
  }

  async openProfile(): Promise<AppThemeOpenProfileResponse> {
    return await invoke<AppThemeOpenProfileResponse>("studio_app_theme_open_profile");
  }

  async saveProfile(request: AppThemeSaveProfileRequest): Promise<AppThemeSaveProfileResponse> {
    return await invoke<AppThemeSaveProfileResponse>("studio_app_theme_save_profile", { request });
  }

  async exportPackage(
    spec: any,
    language: "typescript" | "javascript" = "typescript"
  ): Promise<{
    cancelled: boolean;
    destination?: string;
    fileCount?: number;
    error?: string;
  }> {
    return await invoke("studio_app_theme_export_package", {
      request: { specification: spec, language },
    });
  }


  async reset(): Promise<AppThemeStatus> {
    return await invoke<AppThemeStatus>("studio_app_theme_reset");
  }

  async resetAll(): Promise<AppThemeStatus> {
    return await this.reset();
  }
}

export interface MockAppThemeBridgeOptions {
  available?: boolean | undefined;
  message?: string | undefined;
  loomError?: string | undefined;
  compiledSolarSailCss?: string | undefined;
  compiledStarlightCss?: string | undefined;
}

export class MockAppThemeBridge implements AppThemeBridge {
  private status: AppThemeStatus;
  private document: AppThemeOpenedDocument | null = null;
  private loomError?: string | undefined;
  private compiledSolarSailCss?: string | undefined;
  private compiledStarlightCss?: string | undefined;

  constructor(options?: MockAppThemeBridgeOptions) {
    this.status = {
      available: options?.available ?? true,
      compilerVersion: "0.1.0",
      supportedFormats: ["tf-paired-profile-v1", "tf-paired-profile-v2"],
      sessionId: "mock-session",
      latestRevision: 1,
      dirty: false,
      ...(options?.message !== undefined ? { message: options.message } : {}),
    };
    this.loomError = options?.loomError;
    this.compiledSolarSailCss = options?.compiledSolarSailCss;
    this.compiledStarlightCss = options?.compiledStarlightCss;
  }

  async getStatus(): Promise<AppThemeStatus> {
    return { ...this.status };
  }

  async compile(spec: any, uiRevision: number = 1): Promise<AppThemeCompileResult> {
    this.status.latestRevision = uiRevision;
    const primary = spec?.palette?.dark?.primary || spec?.palette?.light?.primary || spec?.colors?.primary || "#126475";
    const compiledCss = this.compiledSolarSailCss ?? `:root { --primary: ${primary}; }`;
    return {
      status: "success",
      valid: true,
      uiRevision,
      compiledCss,
      diagnostics: [],
    };
  }

  async pairedCompile(profile: PairedProfile, uiRevision: number = 1): Promise<PairedCompileResult> {
    this.status.latestRevision = uiRevision;
    const loomError = this.loomError;
    const primary = profile?.palette?.dark?.primary || profile?.palette?.light?.primary || "#126475";
    const ssCss = this.compiledSolarSailCss ?? `:root { --primary: ${primary}; }`;
    const loomCss = this.compiledStarlightCss ?? `:root { --sl-color-accent: ${primary}; --tfsl-color-accent-base: ${primary}; }`;
    return {
      status: loomError ? "partial" : "success",
      valid: true,
      uiRevision,
      solarSail: {
        status: "success",
        valid: true,
        uiRevision,
        compiledCss: ssCss,
        diagnostics: [],
      },
      stellarLoom: {
        valid: !loomError,
        ...(loomError ? {} : { compiledCss: loomCss }),
        ...(loomError !== undefined ? { error: loomError } : {}),
        diagnostics: loomError
          ? [{ severity: "error", code: "LOOM_UNAVAILABLE", message: loomError }]
          : [],
      },
      sharedTokens: ["primary", "accent", "background", "foreground", "radius"],
    };
  }

  private rememberDocument(document: AppThemeOpenedDocument): AppThemeOpenedDocument {
    this.document = document;
    this.status.activeDocumentId = document.documentId;
    this.status.activeDisplayName = document.displayName;
    this.status.activeSchemaVersion = document.schemaVersion;
    this.status.activeVerificationStatus = document.verificationStatus;
    return document;
  }

  async openProfile(): Promise<AppThemeOpenProfileResponse> {
    return {
      cancelled: false,
      document: this.rememberDocument({
        documentId: "mock-profile-document",
        displayName: "forge-console.profile.json",
        schemaVersion: "tf-paired-profile-v1",
        aliasResolved: false,
        verificationStatus: "verified",
        isTransformed: false,
        semantic: "validated",
        rawSourceSha256: "0".repeat(64),
        normalizedSha256: "1".repeat(64),
        editable: true,
        profile: JSON.parse(JSON.stringify(BUILTIN_FORGE_CONSOLE_PROFILE)),
      }),
    };
  }

  async saveProfile(request: AppThemeSaveProfileRequest): Promise<AppThemeSaveProfileResponse> {
    if (request.saveMode === "original") {
      if (!this.document || this.document.documentId !== request.documentId) {
        return { cancelled: false, saved: false, error: "Document is unavailable." };
      }
      return { cancelled: false, saved: true, document: { ...this.document } };
    }
    if (!request.profile) {
      return { cancelled: false, saved: false, error: "Profile is required." };
    }
    const isEdited = request.saveMode === "edited" || Boolean(request.documentId);
    const parentSha = isEdited ? (this.document?.rawSourceSha256 ?? "0".repeat(64)) : undefined;
    return {
      cancelled: false,
      saved: true,
      document: this.rememberDocument({
        documentId: this.document?.documentId ?? "mock-profile-document",
        displayName: "forge-console.profile.json",
        schemaVersion: "tf-paired-profile-v1",
        aliasResolved: false,
        verificationStatus: isEdited ? "transformed" : "verified",
        isTransformed: isEdited,
        ...(parentSha !== undefined ? { parentSourceSha256: parentSha } : {}),
        semantic: "validated",
        rawSourceSha256: "2".repeat(64),
        normalizedSha256: "3".repeat(64),
        editable: true,
        profile: request.profile,
      }),
    };
  }

  async exportPackage(
    _spec: any,
    _language?: "typescript" | "javascript"
  ): Promise<{
    cancelled: boolean;
    destination?: string;
    fileCount?: number;
    error?: string;
  }> {
    return {
      cancelled: false,
      destination: "/mock/forge-console-theme",
      fileCount: 11,
    };
  }


  async reset(): Promise<AppThemeStatus> {
    this.status.latestRevision = (this.status.latestRevision ?? 0) + 1;
    this.status.dirty = false;
    this.document = null;
    delete this.status.activeDocumentId;
    delete this.status.activeDisplayName;
    delete this.status.activeSchemaVersion;
    delete this.status.activeVerificationStatus;
    return { ...this.status };
  }

  async resetAll(): Promise<AppThemeStatus> {
    return await this.reset();
  }
}

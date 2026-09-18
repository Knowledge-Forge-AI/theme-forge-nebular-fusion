import { invoke } from "@tauri-apps/api/core";
import { BUILTIN_FORGE_CONSOLE_PROFILE } from "./builtin-profiles";
import type {
  AppThemeBridge,
  AppThemeCompileResult,
  AppThemeStatus,
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

  async openProfile(): Promise<{
    cancelled: boolean;
    profile?: PairedProfile;
    displayName?: string;
    filePath?: string;
    error?: string;
  }> {
    return await invoke("studio_app_theme_open_profile");
  }

  async saveProfile(profile: PairedProfile, saveAs?: boolean): Promise<{
    cancelled: boolean;
    filePath?: string;
    error?: string;
  }> {
    return await invoke("studio_app_theme_save_profile", {
      request: { profile, saveAs },
    });
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
  private loomError?: string | undefined;
  private compiledSolarSailCss?: string | undefined;
  private compiledStarlightCss?: string | undefined;

  constructor(options?: MockAppThemeBridgeOptions) {
    this.status = {
      available: options?.available ?? true,
      compilerVersion: "0.1.0",
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

  async openProfile(): Promise<{
    cancelled: boolean;
    profile?: PairedProfile;
    displayName?: string;
    filePath?: string;
    error?: string;
  }> {
    return {
      cancelled: false,
      profile: { ...BUILTIN_FORGE_CONSOLE_PROFILE },
      displayName: "forge-console.profile.json",
      filePath: "/mock/forge-console.profile.json",
    };
  }

  async saveProfile(_profile: PairedProfile, _saveAs?: boolean): Promise<{
    cancelled: boolean;
    filePath?: string;
    error?: string;
  }> {
    return {
      cancelled: false,
      filePath: "/mock/forge-console.profile.json",
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
    this.status.latestRevision += 1;
    this.status.dirty = false;
    return { ...this.status };
  }
}

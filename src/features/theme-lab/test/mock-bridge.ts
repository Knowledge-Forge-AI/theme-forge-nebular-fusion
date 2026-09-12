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
} from "../types";
import { SAMPLE_CYAN_THEME, SAMPLE_AMBER_THEME } from "../builtin-themes";
export { SAMPLE_CYAN_THEME, SAMPLE_AMBER_THEME } from "../builtin-themes";
export function generateMockThemeCss(spec: ThemeSpecification): string {
  const dark = spec.colors.dark;
  const light = spec.colors.light;
  return `/* Starlight compiled theme: ${spec.name} v${spec.version} */
:root {
  --sl-font-system: ${spec.typography.bodyFont === "system-serif" ? "Georgia, Cambria, serif" : "system-ui, -apple-system, sans-serif"};
  --sl-font-system-mono: ${spec.typography.codeFont === "system-code" ? "Consolas, 'Liberation Mono', monospace" : "ui-monospace, monospace"};
  --sl-content-width: ${spec.layout.contentWidth};
  --sl-sidebar-width: ${spec.layout.sidebarWidth};
  --sl-line-height: ${spec.typography.lineHeight ?? 1.6};
  --sl-color-accent-low: ${dark.accent.low};
  --sl-color-accent: ${dark.accent.base};
  --sl-color-accent-high: ${dark.accent.high};
  --sl-color-bg: ${dark.neutrals.bg};
  --sl-color-bg-nav: ${dark.neutrals.bgNav};
  --sl-color-bg-sidebar: ${dark.neutrals.bgSidebar};
  --sl-color-bg-inline-code: ${dark.neutrals.bgInlineCode};
  --sl-color-bg-accent: ${dark.neutrals.bgAccent};
  --sl-color-text: ${dark.neutrals.text};
  --sl-color-text-accent: ${dark.neutrals.textAccent};
  --sl-color-text-invert: ${dark.neutrals.textInvert};
  --sl-color-hairline: ${dark.neutrals.hairline};
  --sl-color-hairline-light: ${dark.neutrals.hairlineLight};
  --sl-color-hairline-shade: ${dark.neutrals.hairlineShade};
  --sl-color-gray-1: ${dark.grays.gray1};
  --sl-color-gray-2: ${dark.grays.gray2};
  --sl-color-gray-3: ${dark.grays.gray3};
  --sl-color-gray-4: ${dark.grays.gray4};
  --sl-color-gray-5: ${dark.grays.gray5};
  --sl-color-gray-6: ${dark.grays.gray6};
  --sl-color-gray-7: ${dark.grays.gray7};
}
:root[data-theme='light'] {
  --sl-color-accent-low: ${light.accent.low};
  --sl-color-accent: ${light.accent.base};
  --sl-color-accent-high: ${light.accent.high};
  --sl-color-bg: ${light.neutrals.bg};
  --sl-color-bg-nav: ${light.neutrals.bgNav};
  --sl-color-bg-sidebar: ${light.neutrals.bgSidebar};
  --sl-color-bg-inline-code: ${light.neutrals.bgInlineCode};
  --sl-color-bg-accent: ${light.neutrals.bgAccent};
  --sl-color-text: ${light.neutrals.text};
  --sl-color-text-accent: ${light.neutrals.textAccent};
  --sl-color-text-invert: ${light.neutrals.textInvert};
  --sl-color-hairline: ${light.neutrals.hairline};
  --sl-color-hairline-light: ${light.neutrals.hairlineLight};
  --sl-color-hairline-shade: ${light.neutrals.hairlineShade};
  --sl-color-gray-1: ${light.grays.gray1};
  --sl-color-gray-2: ${light.grays.gray2};
  --sl-color-gray-3: ${light.grays.gray3};
  --sl-color-gray-4: ${light.grays.gray4};
  --sl-color-gray-5: ${light.grays.gray5};
  --sl-color-gray-6: ${light.grays.gray6};
  --sl-color-gray-7: ${light.grays.gray7};
}
`;
}

// Retain sample fixture definitions for mock bridges and parent testing adapters
export const SAMPLE_BRIEF_PACKET = {
  schema: "tfsl.theme-brief",
  schemaVersion: 1,
  briefId: "brief-cyan-refresh",
  title: "Stellar Cyan Aesthetic Refresh",
  goal: "Refine Starlight theme aesthetics and contrast while preserving brand identity",
  baselineTheme: SAMPLE_CYAN_THEME,
  themeDigest: "sha256:d8c54c1264c185bb81765c7cfa6cbfe4e0d4cbbfa064d1f274cb7c0ef3cfec77",
  compilerVersion: "0.1.0-alpha.1",
  adapter: "starlight-v0.42",
  allowedFields: [
    "colors.dark.accent.base",
    "colors.dark.accent.high",
    "colors.dark.accent.low",
    "colors.light.accent.base",
    "colors.light.accent.high",
    "colors.light.accent.low",
    "typography.lineHeight",
  ],
  allowedModes: ["dark", "light"],
  approvedTemplates: ["page-title-frame"],
  acceptanceCriteria: [
    "Maintain WCAG 2.2 AA contrast on accent text",
    "Body line height at least 1.6",
  ],
  prohibitedChanges: ["layout.contentWidth", "colors.dark.neutrals.bg"],
  visualEvidence: [],
  briefDigest: "sha256:78e5c95a29fb970ce9eb876c74b5f3cbd6c5be184ace560fae049d7e0e252888",
};

export const SAMPLE_CANDIDATE_A_PACKET = {
  schema: "tfsl.theme-candidate",
  schemaVersion: 1,
  candidateId: "cyan-accessible-high-contrast",
  briefDigest: "sha256:78e5c95a29fb970ce9eb876c74b5f3cbd6c5be184ace560fae049d7e0e252888",
  theme: {
    ...SAMPLE_CYAN_THEME,
    name: "cyan-accessible-high-contrast",
    colors: {
      ...SAMPLE_CYAN_THEME.colors,
      dark: {
        ...SAMPLE_CYAN_THEME.colors.dark,
        accent: {
          base: "#00e1ff",
          low: "#09324a",
          high: "#d4f7ff",
        },
      },
    },
  },
  themeDigest: "sha256:5b796aa4c856b3a3c945b08c90961b7f041ff2337d11ef78f0d040a463c6d701",
  rationale: "Improves WCAG 2.2 AA contrast on dark mode background while keeping vibrant cyan identity.",
  packageMetadata: {
    name: "@knowledge-forge-ai/starlight-theme-cyan-accessible",
    version: "0.2.0",
    template: "default",
    license: "AGPL-3.0-or-later",
  },
  claimedProvenance: {
    author: "Agent-Designer-01",
    toolName: "tfsl",
    toolVersion: "0.1.0",
    timestamp: "2026-09-07T12:00:00Z",
  },
  visualEvidence: [
    {
      schema: "tfsl.theme-visual-evidence",
      schemaVersion: 1,
      presence: "included",
      pngDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      bytesBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      byteCount: 68,
      width: 1,
      height: 1,
      mode: "dark",
      viewport: "desktop",
      themeDigest: "sha256:5b796aa4c856b3a3c945b08c90961b7f041ff2337d11ef78f0d040a463c6d701",
      fixtureId: "page-title-frame",
      evidenceDigest: "sha256:aaaa1111222233334444555566667777888899990000aaaabbbbccccddddeeee",
    },
  ],
  candidateDigest: "sha256:87ca505a52d1459ce84eef4041aa8f499f004f8abaa5512490468223b09d1da5",
};

export const SAMPLE_CANDIDATE_B_PACKET = {
  schema: "tfsl.theme-candidate",
  schemaVersion: 1,
  candidateId: "cyan-neon-burst",
  briefDigest: "sha256:78e5c95a29fb970ce9eb876c74b5f3cbd6c5be184ace560fae049d7e0e252888",
  theme: {
    ...SAMPLE_CYAN_THEME,
    name: "cyan-neon-burst",
    colors: {
      ...SAMPLE_CYAN_THEME.colors,
      dark: {
        ...SAMPLE_CYAN_THEME.colors.dark,
        accent: {
          base: "#38bdf8",
          low: "#07283b",
          high: "#e0f2fe",
        },
      },
    },
  },
  themeDigest: "sha256:f4bb7d84813580556e8b7921a97dbad5080e7d56e9c9ad041935eb97063cc17c",
  rationale: "Vibrant neon accent designed for punchy developer docs.",
  visualEvidence: [],
  candidateDigest: "sha256:f05b43bc948b1550154f2a8e323334902521d4b3012945268279836eb8cdd24d",
};

export const SAMPLE_REVIEW_PACKET = {
  schema: "tfsl.theme-review",
  schemaVersion: 1,
  reviewId: "review-cyan-refresh-01",
  briefDigest: "sha256:78e5c95a29fb970ce9eb876c74b5f3cbd6c5be184ace560fae049d7e0e252888",
  candidateDigests: [
    "sha256:87ca505a52d1459ce84eef4041aa8f499f004f8abaa5512490468223b09d1da5",
    "sha256:f05b43bc948b1550154f2a8e323334902521d4b3012945268279836eb8cdd24d",
  ],
  summary: "Candidate A is preferred due to superior contrast and typography readability.",
  overallDisposition: {
    kind: "preferred" as const,
    candidateDigest: "sha256:87ca505a52d1459ce84eef4041aa8f499f004f8abaa5512490468223b09d1da5",
  },
  dispositions: [
    {
      candidateDigest: "sha256:87ca505a52d1459ce84eef4041aa8f499f004f8abaa5512490468223b09d1da5",
      disposition: "preferred" as const,
      comment: "Excellent contrast across both dark and light modes",
    },
    {
      candidateDigest: "sha256:f05b43bc948b1550154f2a8e323334902521d4b3012945268279836eb8cdd24d",
      disposition: "deferred" as const,
      comment: "Vibrant look, reserved for alternative dark-only skin",
    },
  ],
  annotations: [
    {
      annotationId: "ann-accent-dark",
      candidateDigest: "sha256:87ca505a52d1459ce84eef4041aa8f499f004f8abaa5512490468223b09d1da5",
      target: {
        kind: "field" as const,
        fieldPath: "colors.dark.accent.base",
        mode: "dark" as const,
      },
      severity: "note" as const,
      category: "contrast" as const,
      comment: "Crisp primary cyan accent meets WCAG 2.2 AA on dark neutral background",
    },
  ],
  reviewDigest: "sha256:mock-review-digest-01",
};

export class MockThemeLabBridge implements ThemeLabBridge {
  private currentSpec: ThemeSpecification = JSON.parse(JSON.stringify(SAMPLE_CYAN_THEME)) as ThemeSpecification;
  private dirty = false;
  private revision = 1;
  private filePath?: string | undefined;

  async getStatus(): Promise<ThemeLabStatusResponse> {
    return {
      available: true,
      compilerVersion: "0.0.0-mock",
      sessionId: "mock-session-1",
      latestRevision: this.revision,
    };
  }

  async compile(request: ThemeLabCompileRequest): Promise<ThemeLabCompileResponse> {
    const rev = request.uiRevision ?? (this.revision + 1);
    if (request.uiRevision !== undefined && request.uiRevision < this.revision) {
      return {
        uiRevision: rev,
        valid: false,
        diagnostics: [],
        error: { code: "STALE_REVISION", message: "Stale compilation revision superseded" },
      };
    }
    this.revision = Math.max(this.revision, rev);
    this.currentSpec = JSON.parse(JSON.stringify(request.specification)) as ThemeSpecification;
    this.dirty = true;
    const css = generateMockThemeCss(this.currentSpec);
    return {
      uiRevision: rev,
      valid: true,
      compiledCss: css,
      descriptor: {
        schema: "https://schemas.knowledgeforge.ai/tfsl/theme-descriptor-v1.json",
        schemaVersion: 1,
        themeSchemaVersion: "tfsl.theme-v1",
        themeName: this.currentSpec.name,
        themeVersion: this.currentSpec.version,
        adapter: "starlight-v0.42",
        inputDigest: "mock-in-digest",
        outputDigest: "mock-out-digest",
        cssFile: "theme.css",
        provenance: {
          categories: ["theme"],
          compiler: "tfsl",
          compilerVersion: "0.0.0-mock",
        },
      },
      diagnostics: [
        {
          severity: "pass",
          code: "WCAG_AA",
          role: "accent-text",
          mode: "dark",
          element: "a.link",
          foreground: this.currentSpec.colors.dark.accent.high,
          background: this.currentSpec.colors.dark.neutrals.bg,
          ratio: 7.2,
          displayRatio: "7.2:1",
          criterion: "WCAG AA Normal Text",
          threshold: 4.5,
          disposition: "pass",
          message: "Contrast ratio meets WCAG AA criteria.",
        },
      ],
    };
  }

  async loadExample(name: string, uiRevision?: number, _sessionId?: string): Promise<ThemeLabExampleResponse> {
    const rev = uiRevision ?? (this.revision + 1);
    if (uiRevision !== undefined && uiRevision < this.revision) {
      return {
        uiRevision: rev,
        valid: false,
        exampleName: name,
        diagnostics: [],
        error: { code: "STALE_REVISION", message: "Stale example revision superseded" },
      };
    }
    this.revision = Math.max(this.revision, rev);
    const isAmber = name.toLowerCase().includes("amber");
    const chosenName = isAmber ? "amber-forge" : "stellar-cyan";
    this.currentSpec = JSON.parse(JSON.stringify(isAmber ? SAMPLE_AMBER_THEME : SAMPLE_CYAN_THEME)) as ThemeSpecification;
    this.dirty = false;
    const css = generateMockThemeCss(this.currentSpec);
    return {
      uiRevision: rev,
      valid: true,
      exampleName: chosenName,
      specification: this.currentSpec,
      compiledCss: css,
      descriptor: {
        schema: "https://schemas.knowledgeforge.ai/tfsl/theme-descriptor-v1.json",
        schemaVersion: 1,
        themeSchemaVersion: "tfsl.theme-v1",
        themeName: this.currentSpec.name,
        themeVersion: this.currentSpec.version,
        adapter: "starlight-v0.42",
        inputDigest: "mock-in-digest",
        outputDigest: "mock-out-digest",
        cssFile: "theme.css",
        provenance: {
          categories: ["theme"],
          compiler: "tfsl",
          compilerVersion: "0.0.0-mock",
        },
      },
      diagnostics: [],
    };
  }

  async openTheme(): Promise<ThemeLabOpenResponse> {
    return {
      cancelled: true,
      diagnostics: [],
    };
  }

  async saveTheme(request: ThemeLabSaveRequest): Promise<ThemeLabSaveResponse> {
    this.currentSpec = JSON.parse(JSON.stringify(request.specification)) as ThemeSpecification;
    this.dirty = false;
    this.filePath = "/mock/theme.json";
    return {
      cancelled: false,
      displayName: "theme.json",
    };
  }

  async createBrief(request: ThemeBriefCreateRequest): Promise<ThemeBriefCreateResponse> {
    const packet = {
      ...SAMPLE_BRIEF_PACKET,
      ...(request.briefInput as Record<string, unknown>),
      baselineTheme: (request.briefInput.baselineTheme as ThemeSpecification) ?? this.currentSpec,
    };
    const canonicalJson = JSON.stringify(packet, null, 2);
    return {
      packet,
      canonicalJson,
      digest: (packet.briefDigest as string) ?? "sha256:mock-brief-digest",
    };
  }

  async importPacket(request?: ThemePacketImportRequest): Promise<ThemePacketImportResponse> {
    let packet: Record<string, unknown> = SAMPLE_CANDIDATE_A_PACKET as unknown as Record<string, unknown>;
    let kind = "tfsl.theme-candidate";
    let digest = SAMPLE_CANDIDATE_A_PACKET.candidateDigest;
    if (request?.expectedKind === "tfsl.theme-brief") {
      packet = SAMPLE_BRIEF_PACKET as unknown as Record<string, unknown>;
      kind = "tfsl.theme-brief";
      digest = SAMPLE_BRIEF_PACKET.briefDigest;
    } else if (request?.expectedKind === "tfsl.theme-review") {
      packet = SAMPLE_REVIEW_PACKET as unknown as Record<string, unknown>;
      kind = "tfsl.theme-review";
      digest = SAMPLE_REVIEW_PACKET.reviewDigest;
    }
    return {
      cancelled: false,
      displayName: "packet.json",
      packet,
      canonicalJson: JSON.stringify(packet, null, 2),
      kind,
      digest,
    };
  }

  async exportPacket(request: ThemePacketExportRequest): Promise<ThemePacketExportResponse> {
    return {
      cancelled: false,
      saved: true,
      displayName: request.defaultName ?? "packet.json",
      digest: "sha256:mock-export-digest",
    };
  }

  async createReview(request: ThemeReviewCreateRequest): Promise<ThemeReviewCreateResponse> {
    const packet = {
      ...SAMPLE_REVIEW_PACKET,
      ...(request.reviewInput as Record<string, unknown>),
    };
    const canonicalJson = JSON.stringify(packet, null, 2);
    return {
      packet,
      canonicalJson,
      digest: (packet.reviewDigest as string) ?? "sha256:mock-review-digest",
    };
  }

  async adoptCandidate(request: ThemeCandidateAdoptRequest): Promise<ThemeCandidateAdoptResponse> {
    if (this.dirty && !request.force && !request.force) {
      return {
        adopted: false,
        requiresConfirmation: true,
      };
    }
    const cand = JSON.parse(request.candidate) as unknown as { theme: ThemeSpecification; themeDigest?: string };
    this.currentSpec = JSON.parse(JSON.stringify(cand.theme)) as ThemeSpecification;
    this.dirty = true;
    this.filePath = undefined;
    const css = generateMockThemeCss(this.currentSpec);
    return {
      adopted: true,
      requiresConfirmation: false,
      specification: this.currentSpec,
      compiledCss: css,
      descriptor: {
        schema: "https://schemas.knowledgeforge.ai/tfsl/theme-descriptor-v1.json",
        schemaVersion: 1,
        themeSchemaVersion: "tfsl.theme-v1",
        themeName: this.currentSpec.name,
        themeVersion: this.currentSpec.version,
        adapter: "starlight-v0.42",
        inputDigest: cand.themeDigest ?? "mock-in-digest",
        outputDigest: "mock-out-digest",
        cssFile: "theme.css",
        provenance: {
          categories: ["theme"],
          compiler: "tfsl",
          compilerVersion: "0.0.0-mock",
        },
      },
      diagnostics: [
        {
          severity: "pass",
          code: "WCAG_AA",
          role: "accent-text",
          mode: "dark",
          element: "a.link",
          foreground: this.currentSpec.colors.dark.accent.high,
          background: this.currentSpec.colors.dark.neutrals.bg,
          ratio: 7.4,
          displayRatio: "7.4:1",
          criterion: "WCAG AA Normal Text",
          threshold: 4.5,
          disposition: "pass",
          message: "Contrast ratio meets WCAG AA criteria.",
        },
      ],
    };
  }

  async verifyThemeCandidate(request: ThemeCandidateVerifyRequest): Promise<ThemeCandidateVerifyResponse> {
    try {
      const packet = JSON.parse(request.candidate);
      const brief = request.brief ? JSON.parse(request.brief) : undefined;
      const theme = packet.theme;
      if (!theme || !theme.colors) {
        return {
          valid: false,
          candidateVerification: {
            valid: false,
            candidateId: packet.candidateId ?? "unknown",
            candidateDigest: packet.candidateDigest ?? "",
            briefDigest: packet.briefDigest ?? "",
            themeDigest: "",
            diagnostics: [],
            constraintViolations: [],
            errors: ["Invalid theme specification in candidate packet"],
            warnings: [],
          },
          error: { code: "INVALID_CANDIDATE", message: "Invalid theme specification" },
        };
      }

      const errors: string[] = [];
      const constraintViolations: string[] = [];
      if (brief && packet.briefDigest && brief.briefDigest && packet.briefDigest !== brief.briefDigest) {
        errors.push(`Candidate briefDigest '${packet.briefDigest}' does not match brief digest '${brief.briefDigest}'`);
      }

      const valid = errors.length === 0 && constraintViolations.length === 0;
      const css = generateMockThemeCss(theme);
      const diagnostics: ContrastDiagnostic[] = [
        {
          severity: "pass",
          code: "WCAG_AA",
          role: "accent-text",
          mode: "dark",
          element: "a.link",
          foreground: theme.colors.dark?.accent?.high ?? "#b8f2ff",
          background: theme.colors.dark?.neutrals?.bg ?? "#090e17",
          ratio: 7.2,
          displayRatio: "7.2:1",
          criterion: "WCAG AA Normal Text",
          threshold: 4.5,
          disposition: "pass",
          message: "Contrast ratio meets WCAG AA criteria.",
        },
      ];

      return {
        valid,
        compiledCss: valid ? css : undefined,
        descriptor: {
          schema: "https://schemas.knowledgeforge.ai/tfsl/theme-descriptor-v1.json",
          schemaVersion: 1,
          themeSchemaVersion: "tfsl.theme-v1",
          themeName: theme.name,
          themeVersion: theme.version,
          adapter: theme.adapter ?? "starlight-v0.42",
          inputDigest: packet.themeDigest ?? "mock-in-digest",
          outputDigest: "mock-out-digest",
          cssFile: "theme.css",
          provenance: {
            categories: ["theme"],
            compiler: "tfsl",
            compilerVersion: "0.0.0-mock",
          },
        },
        diagnostics,
        candidateVerification: {
          valid,
          candidateId: packet.candidateId ?? "cand-1",
          candidateDigest: packet.candidateDigest ?? "sha256:cand-digest",
          briefDigest: packet.briefDigest ?? "sha256:brief-digest",
          themeDigest: packet.themeDigest ?? "sha256:theme-digest",
          computedCssDigest: "sha256:computed-css",
          diagnostics,
          constraintViolations,
          errors,
          warnings: [],
        },
        error: valid ? undefined : { code: "CANDIDATE_VERIFICATION_FAILED", message: errors.join("; ") },
      };
    } catch (err: any) {
      return {
        valid: false,
        error: { code: "PARSE_ERROR", message: err.message || String(err) },
      };
    }
  }

  async validateThemeReview(request: ThemeReviewValidateRequest): Promise<ThemeReviewValidateResponse> {
    try {
      const review = JSON.parse(request.review);
      const brief = request.brief ? JSON.parse(request.brief) : undefined;
      const candidates = request.candidates ? request.candidates.map((c: string) => JSON.parse(c)) : [];
      const errors: string[] = [];

      if (brief && review.briefDigest && brief.briefDigest && review.briefDigest !== brief.briefDigest) {
        errors.push(`Review briefDigest '${review.briefDigest}' does not match brief digest '${brief.briefDigest}'`);
      }

      const candMap = new Map<string, any>();
      for (const c of candidates) {
        candMap.set(c.candidateDigest, c);
      }

      let candidateMatches = true;
      if (Array.isArray(review.candidateDigests)) {
        for (const d of review.candidateDigests) {
          if (candidates.length > 0 && !candMap.has(d)) {
            errors.push(`Review references candidate digest '${d}' not present in provided candidates`);
            candidateMatches = false;
          }
        }
      }

      const valid = errors.length === 0;
      return {
        valid,
        reviewValidation: {
          valid,
          reviewId: review.reviewId ?? "review-1",
          reviewDigest: review.reviewDigest ?? "sha256:review-digest",
          briefDigest: review.briefDigest ?? "sha256:brief-digest",
          candidateMatches,
          dispositionMatches: true,
          annotationErrors: [],
          errors,
        },
        error: valid ? undefined : { code: "REVIEW_VALIDATION_FAILED", message: errors.join("; ") },
      };
    } catch (err: any) {
      return {
        valid: false,
        error: { code: "PARSE_ERROR", message: err.message || String(err) },
      };
    }
  }

  async dispose(): Promise<void> {
    // mock disposal clears any pending operations
  }
}

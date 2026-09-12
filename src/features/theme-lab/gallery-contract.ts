/**
 * apps/studio/src/features/theme-lab/gallery-contract.ts
 *
 * TFSB63B Closed Starlight Gallery Contract & Finite Prebuilt Scenario Definitions.
 *
 * Canonical source of truth for:
 * 1. Finite prebuilt Starlight gallery coverage authority (scenarios, structural axes, installed identities)
 * 2. Bridge protocol keys, limits, ack/diagnostic shape, and byte ceilings
 * 3. Exact-axis/subset draft-to-scenario selection (never nearest falsely current)
 * 4. CSS-driven layout override parity proof
 * 5. Pre-send and receiver UTF-8 524,288 byte ceiling enforcement
 * 6. Closed bounded frame diagnostics and fixed native status canary validation
 *
 * Consumed by:
 * - Frontend: ThemeLab.tsx, StarlightPreview.tsx, ThemeV2Controls.tsx
 * - Preparation: apps/studio/tools/gallery-prepare.mjs
 * - CI & Contract Tests: test/ci/gallery-bridge.test.ts, apps/studio/src/test/starlight-preview.studio.tsx
 */

import type {
  ThemeSpecificationV2,
  CodePresentationConfig,
} from "./v2-model";

function isCodePresentationConfig(cp: unknown): cp is CodePresentationConfig {
  return typeof cp === "object" && cp !== null && (cp as Record<string, unknown>).mode === "expressive-code";
}

// ---------------------------------------------------------------------------
// Pinned Installed Candidate Identities & Fixture Digests
// ---------------------------------------------------------------------------

export const EXPECTED_ARCHIVE_SHA256 =
  "cdfb1ada33fb146a89622f32e3d676f581e4972b0b5654171ba0a6f08264cd0f" as const;

export const EXPECTED_CONSUMER_LOCK_DIGEST =
  "7c3c03ea0b02f2af883e411ba4500d7ef2951a7bd599e452d3bb91e23a8c9bbf" as const;

export const EXPECTED_FONT = Object.freeze({
  family: "Source Code Pro",
  id: "source-code-pro",
  format: "woff2",
  weight: 400,
  style: "normal",
  sha256: "8badfe75c98da1e8315a52619f177def4618350f7b3e496baf5b8894da2c2ac0",
  licenseSha256: "67f54ca75bed5827c712f2d87a168c6e97d56fbd2312eea5de510adda74aaedd",
  noticeSlug: "source-code-pro-ofl",
} as const);

// ---------------------------------------------------------------------------
// Finite Gallery Scenarios & Package Bindings
// ---------------------------------------------------------------------------

export const GALLERY_SCENARIO_IDS = [
  "black-catalog",
  "flexoki-catalog",
  "celestia-catalog",
  "active-only-catalog",
] as const;

export type GalleryScenarioId = (typeof GALLERY_SCENARIO_IDS)[number];

export const GALLERY_SCENARIO_PACKAGES: Record<GalleryScenarioId, string> = Object.freeze({
  "black-catalog": "@gallery/starlight-theme-black-catalog",
  "flexoki-catalog": "@gallery/starlight-theme-flexoki-catalog",
  "celestia-catalog": "@gallery/starlight-theme-celestia-catalog",
  "active-only-catalog": "@gallery/starlight-theme-active-only-catalog",
});

export interface GalleryScenarioStructuralConfig {
  readonly sidebarMode: "nested" | "select" | "tabs" | "active-only";
  readonly paginationVariant: "card" | "plain" | "compact";
  readonly pageTitleCopy: "url" | "none" | "title";
  readonly pageTitleFramed: boolean;
  readonly codeFrame: "terminal" | "editor" | "plain";
  readonly codeCopy: "standard" | "minimal";
  readonly layoutPreset: "standard" | "compact";
  readonly catalogLayout: "standard" | "compact";
  readonly fontMode: "system" | "package-local";
  readonly primaryFontFamily: string;
}

export interface GalleryHeroRouteDefinition {
  readonly route: string;
  readonly layout: "centered" | "media-top" | "media-left" | "media-right" | "banner";
  readonly previewPath: string;
  readonly title: string;
}

export interface GalleryScenarioDefinition {
  readonly id: GalleryScenarioId;
  readonly name: string;
  readonly packageName: string;
  readonly description: string;
  readonly basePath: string;
  readonly entryPath: string;
  readonly previewUrl: string;
  readonly structuralConfig: GalleryScenarioStructuralConfig;
  readonly heroRoutes: readonly GalleryHeroRouteDefinition[];
  readonly limitations: {
    readonly readOnlyStructure: true;
    readonly dynamicPaletteSupported: true;
    readonly editedSyntaxRulesPreviewed: false;
    readonly syntaxLimitationNotice: string;
    readonly arbitraryFontsSupported: false;
    readonly fontLimitationNotice: string;
    readonly fixedHeroContent: true;
    readonly heroLimitationNotice: string;
    readonly pairedRepresentativeScenarios: true;
    readonly representativeNotice: string;
  };
}

export const GALLERY_SCENARIOS: Record<GalleryScenarioId, GalleryScenarioDefinition> = Object.freeze({
  "black-catalog": {
    id: "black-catalog",
    name: "Black Layered Chrome",
    packageName: GALLERY_SCENARIO_PACKAGES["black-catalog"],
    description: "Nested sidebar navigation, card pagination, URL framed page-title, terminal code frames, standard layout with all 5 hero routes.",
    basePath: "/preview/gallery/black-catalog/",
    entryPath: "/preview/gallery/black-catalog/catalog/preview/index.html",
    previewUrl: "/preview/gallery/black-catalog/catalog/preview/",
    structuralConfig: {
      sidebarMode: "nested",
      paginationVariant: "card",
      pageTitleCopy: "url",
      pageTitleFramed: true,
      codeFrame: "terminal",
      codeCopy: "standard",
      layoutPreset: "standard",
      catalogLayout: "standard",
      fontMode: "system",
      primaryFontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas",
    },
    heroRoutes: [
      {
        route: "/catalog/hero-centered",
        layout: "centered",
        previewPath: "/preview/gallery/black-catalog/catalog/hero-centered/",
        title: "Black Centered Hero",
      },
      {
        route: "/catalog/hero-media-top",
        layout: "media-top",
        previewPath: "/preview/gallery/black-catalog/catalog/hero-media-top/",
        title: "Black Media Top Hero",
      },
      {
        route: "/catalog/hero-media-left",
        layout: "media-left",
        previewPath: "/preview/gallery/black-catalog/catalog/hero-media-left/",
        title: "Black Media Left Hero",
      },
      {
        route: "/catalog/hero-media-right",
        layout: "media-right",
        previewPath: "/preview/gallery/black-catalog/catalog/hero-media-right/",
        title: "Black Media Right Hero",
      },
      {
        route: "/catalog/hero-banner",
        layout: "banner",
        previewPath: "/preview/gallery/black-catalog/catalog/hero-banner/",
        title: "Black Banner Hero",
      },
    ],
    limitations: {
      readOnlyStructure: true,
      dynamicPaletteSupported: true,
      editedSyntaxRulesPreviewed: false,
      syntaxLimitationNotice: "Edited syntax rules are not dynamically previewed in the prebuilt gallery. Static Expressive Code / Shiki tokenization divergence was proven in prototype testing (EC default contrast shifts). Full syntax qualification requires installed consumer build.",
      arbitraryFontsSupported: false,
      fontLimitationNotice: "System font stacks are fully previewed via live CSS. Arbitrary user font file upload is not previewed in the prebuilt gallery.",
      fixedHeroContent: true,
      heroLimitationNotice: "Hero content and routes are fixed static prebuilt Starlight pages; runtime hero synthesis is omitted to faithfully reflect static Astro/Starlight structure.",
      pairedRepresentativeScenarios: true,
      representativeNotice: "The 4 prebuilt scenarios are paired representative configurations covering structural dimensions without Cartesian explosion. No arbitrary-combination runtime parity is claimed; arbitrary permutations require an installed consumer build.",
    },
  },
  "flexoki-catalog": {
    id: "flexoki-catalog",
    name: "Flexoki Inked Select",
    packageName: GALLERY_SCENARIO_PACKAGES["flexoki-catalog"],
    description: "Dropdown select sidebar navigation, plain pagination, clean unframed page-title without copy, editor code frames, and standard layout.",
    basePath: "/preview/gallery/flexoki-catalog/",
    entryPath: "/preview/gallery/flexoki-catalog/catalog/preview/index.html",
    previewUrl: "/preview/gallery/flexoki-catalog/catalog/preview/",
    structuralConfig: {
      sidebarMode: "select",
      paginationVariant: "plain",
      pageTitleCopy: "none",
      pageTitleFramed: false,
      codeFrame: "editor",
      codeCopy: "standard",
      layoutPreset: "standard",
      catalogLayout: "standard",
      fontMode: "system",
      primaryFontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    },
    heroRoutes: [
      {
        route: "/catalog",
        layout: "centered",
        previewPath: "/preview/gallery/flexoki-catalog/catalog/",
        title: "Flexoki Documentation",
      },
    ],
    limitations: {
      readOnlyStructure: true,
      dynamicPaletteSupported: true,
      editedSyntaxRulesPreviewed: false,
      syntaxLimitationNotice: "Edited syntax rules are not dynamically previewed in the prebuilt gallery. Static Expressive Code / Shiki tokenization divergence was proven in prototype testing (EC default contrast shifts). Full syntax qualification requires installed consumer build.",
      arbitraryFontsSupported: false,
      fontLimitationNotice: "System font stacks are fully previewed via live CSS. Arbitrary user font file upload is not previewed in the prebuilt gallery.",
      fixedHeroContent: true,
      heroLimitationNotice: "Hero content and routes are fixed static prebuilt Starlight pages; runtime hero synthesis is omitted to faithfully reflect static Astro/Starlight structure.",
      pairedRepresentativeScenarios: true,
      representativeNotice: "The 4 prebuilt scenarios are paired representative configurations covering structural dimensions without Cartesian explosion. No arbitrary-combination runtime parity is claimed; arbitrary permutations require an installed consumer build.",
    },
  },
  "celestia-catalog": {
    id: "celestia-catalog",
    name: "Celestia Tabbed Compact",
    packageName: GALLERY_SCENARIO_PACKAGES["celestia-catalog"],
    description: "Roving tablist sidebar navigation, compact pagination, title copy, plain code frames, compact layout, and licensed Source Code Pro WOFF2 local font.",
    basePath: "/preview/gallery/celestia-catalog/",
    entryPath: "/preview/gallery/celestia-catalog/catalog/preview/index.html",
    previewUrl: "/preview/gallery/celestia-catalog/catalog/preview/",
    structuralConfig: {
      sidebarMode: "tabs",
      paginationVariant: "compact",
      pageTitleCopy: "title",
      pageTitleFramed: false,
      codeFrame: "plain",
      codeCopy: "minimal",
      layoutPreset: "compact",
      catalogLayout: "compact",
      fontMode: "package-local",
      primaryFontFamily: "'Source Code Pro', monospace",
    },
    heroRoutes: [
      {
        route: "/catalog/celestia-hero",
        layout: "media-right",
        previewPath: "/preview/gallery/celestia-catalog/catalog/celestia-hero/",
        title: "Celestia Compact Hero",
      },
    ],
    limitations: {
      readOnlyStructure: true,
      dynamicPaletteSupported: true,
      editedSyntaxRulesPreviewed: false,
      syntaxLimitationNotice: "Edited syntax rules are not dynamically previewed in the prebuilt gallery. Static Expressive Code / Shiki tokenization divergence was proven in prototype testing (EC default contrast shifts). Full syntax qualification requires installed consumer build.",
      arbitraryFontsSupported: false,
      fontLimitationNotice: "Package-local Source Code Pro font is licensed (OFL-1.1) and rendered offline. Arbitrary user font files cannot be loaded dynamically.",
      fixedHeroContent: true,
      heroLimitationNotice: "Hero content and routes are fixed static prebuilt Starlight pages; runtime hero synthesis is omitted to faithfully reflect static Astro/Starlight structure.",
      pairedRepresentativeScenarios: true,
      representativeNotice: "The 4 prebuilt scenarios are paired representative configurations covering structural dimensions without Cartesian explosion. No arbitrary-combination runtime parity is claimed; arbitrary permutations require an installed consumer build.",
    },
  },
  "active-only-catalog": {
    id: "active-only-catalog",
    name: "Active-Only Focused Nav",
    packageName: GALLERY_SCENARIO_PACKAGES["active-only-catalog"],
    description: "Active-only sidebar navigation displaying only the active group, card pagination, title copy (framed), and editor code frames.",
    basePath: "/preview/gallery/active-only-catalog/",
    entryPath: "/preview/gallery/active-only-catalog/catalog/preview/index.html",
    previewUrl: "/preview/gallery/active-only-catalog/catalog/preview/",
    structuralConfig: {
      sidebarMode: "active-only",
      paginationVariant: "card",
      pageTitleCopy: "title",
      pageTitleFramed: true,
      codeFrame: "editor",
      codeCopy: "minimal",
      layoutPreset: "standard",
      catalogLayout: "standard",
      fontMode: "system",
      primaryFontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    },
    heroRoutes: [
      {
        route: "/catalog/hero-centered",
        layout: "centered",
        previewPath: "/preview/gallery/active-only-catalog/catalog/hero-centered/",
        title: "Black Centered Hero",
      },
    ],
    limitations: {
      readOnlyStructure: true,
      dynamicPaletteSupported: true,
      editedSyntaxRulesPreviewed: false,
      syntaxLimitationNotice: "Edited syntax rules are not dynamically previewed in the prebuilt gallery. Static Expressive Code / Shiki tokenization divergence was proven in prototype testing (EC default contrast shifts). Full syntax qualification requires installed consumer build.",
      arbitraryFontsSupported: false,
      fontLimitationNotice: "System font stacks are fully previewed via live CSS. Arbitrary user font file upload is not previewed in the prebuilt gallery.",
      fixedHeroContent: true,
      heroLimitationNotice: "Hero content and routes are fixed static prebuilt Starlight pages; runtime hero synthesis is omitted to faithfully reflect static Astro/Starlight structure.",
      pairedRepresentativeScenarios: true,
      representativeNotice: "The 4 prebuilt scenarios are paired representative configurations covering structural dimensions without Cartesian explosion. No arbitrary-combination runtime parity is claimed; arbitrary permutations require an installed consumer build.",
    },
  },
});

export const GALLERY_SCENARIO_LIST = Object.values(GALLERY_SCENARIOS);

// ---------------------------------------------------------------------------
// TFSB65 Machine-Readable Editable Structural Field Inventory & Authority
// ---------------------------------------------------------------------------

export const STRUCTURAL_FIELD_CLASSIFICATIONS = [
  "finite representative structural axis",
  "CSS-carried exact field",
  "explicitly not live-previewed",
] as const;

export type StructuralFieldClassification =
  (typeof STRUCTURAL_FIELD_CLASSIFICATIONS)[number];

export const CLASSIFICATION_AXIS: StructuralFieldClassification =
  "finite representative structural axis";
export const CLASSIFICATION_CSS_CARRIED: StructuralFieldClassification =
  "CSS-carried exact field";
export const CLASSIFICATION_NOT_LIVE: StructuralFieldClassification =
  "explicitly not live-previewed";

export interface StructuralFieldDefinition {
  /** Deterministic machine-readable unique identifier for this field */
  readonly id: string;
  /** Human-readable field label matching the editor UI */
  readonly label: string;
  /** Canonical path in ThemeSpecificationV2 */
  readonly specPath: string;
  /** Exactly one classification */
  readonly classification: StructuralFieldClassification;
  /** Whether this field defines structural / layout geometry (true) vs cosmetic palette / meta */
  readonly isStructural: boolean;
  /** If finite representative structural axis: the corresponding GalleryAxis key */
  readonly axisKey?: string | undefined;
  /** Discrete values or options for this field */
  readonly values?: readonly unknown[] | undefined;
  /** If CSS-carried exact field: the CSS variable or cascade mechanism carrying the value */
  readonly cssMechanism?: string | undefined;
  /** Canonical notice key matching GALLERY_COVERAGE.notRepresented for backwards compatibility */
  readonly notice?: string | undefined;
  /** Honest disclosure explanation for fields that are explicitly not live-previewed */
  readonly disclosure?: string | undefined;
}

export const STRUCTURAL_FIELD_INVENTORY: readonly StructuralFieldDefinition[] = Object.freeze([
  // -------------------------------------------------------------------------
  // 1. Finite Representative Structural Axes (7 axes covered by 4 finite scenarios)
  // -------------------------------------------------------------------------
  {
    id: "catalog.sidebar.mode",
    label: "Sidebar Mode",
    specPath: "catalog.sidebar.mode",
    classification: "finite representative structural axis",
    isStructural: true,
    axisKey: "sidebarMode",
    values: ["nested", "select", "tabs", "active-only"],
  },
  {
    id: "catalog.pagination.variant",
    label: "Pagination Variant",
    specPath: "catalog.pagination.variant",
    classification: "finite representative structural axis",
    isStructural: true,
    axisKey: "paginationVariant",
    values: ["plain", "card", "compact"],
  },
  {
    id: "catalog.pageTitle.copy",
    label: "Page Title Copy Mode",
    specPath: "catalog.pageTitle.copy",
    classification: "finite representative structural axis",
    isStructural: true,
    axisKey: "pageTitleCopy",
    values: ["none", "title", "url"],
  },
  {
    id: "components.pageTitle",
    label: "Page Title Component",
    specPath: "components.pageTitle",
    classification: "finite representative structural axis",
    isStructural: true,
    axisKey: "pageTitleFramed",
    values: [false, true],
  },
  {
    id: "codePresentation.frame",
    label: "Code Frame",
    specPath: "codePresentation.frame",
    classification: "finite representative structural axis",
    isStructural: true,
    axisKey: "codeFrame",
    values: ["plain", "editor", "terminal"],
  },
  {
    id: "codePresentation.copy",
    label: "Code Copy Button",
    specPath: "codePresentation.copy",
    classification: "finite representative structural axis",
    isStructural: true,
    axisKey: "codeCopy",
    values: ["standard", "minimal"],
  },
  {
    id: "catalog.hero.layout",
    label: "Hero Layout",
    specPath: "catalog.hero.routes[].layout",
    classification: "finite representative structural axis",
    isStructural: true,
    axisKey: "heroLayout",
    values: ["centered", "media-top", "media-left", "media-right", "banner"],
  },

  // -------------------------------------------------------------------------
  // 2. CSS-Carried Exact Fields (carried into live preview via compiled CSS)
  // -------------------------------------------------------------------------
  {
    id: "layoutPreset",
    label: "Layout Preset",
    specPath: "layoutPreset",
    classification: "CSS-carried exact field",
    isStructural: true,
    values: ["standard", "compact", "wide"],
    cssMechanism: "--sl-content-width variable dynamically injected by compiled stylesheet",
  },
  {
    id: "catalog.layout",
    label: "Catalog Layout",
    specPath: "catalog.layout",
    classification: "CSS-carried exact field",
    isStructural: true,
    values: ["standard", "compact"],
    cssMechanism: "--sl-content-width cap dynamically injected by compiled stylesheet in catalog routes",
  },
  {
    id: "surfaces.content",
    label: "Content Max Width",
    specPath: "surfaces.content",
    classification: "CSS-carried exact field",
    isStructural: true,
    cssMechanism: "--sl-content-width: min({content}px, {cap}px) in compiled CSS",
  },
  {
    id: "surfaces.sidebar",
    label: "Sidebar Width",
    specPath: "surfaces.sidebar",
    classification: "CSS-carried exact field",
    isStructural: true,
    cssMechanism: "--sl-sidebar-width in compiled CSS",
  },
  {
    id: "surfaces.spacing",
    label: "Spacing",
    specPath: "surfaces.spacing",
    classification: "CSS-carried exact field",
    isStructural: true,
    cssMechanism: "--tfsl-surfaces-spacing in compiled CSS",
  },
  {
    id: "surfaces.radii",
    label: "Corner Radii",
    specPath: "surfaces.radii",
    classification: "CSS-carried exact field",
    isStructural: true,
    cssMechanism: "--tfsl-surfaces-radii in compiled CSS",
  },
  {
    id: "surfaces.border",
    label: "Border Width",
    specPath: "surfaces.border",
    classification: "CSS-carried exact field",
    isStructural: true,
    cssMechanism: "--tfsl-surfaces-border in compiled CSS",
  },
  {
    id: "surfaces.focus",
    label: "Focus Ring Width",
    specPath: "surfaces.focus",
    classification: "CSS-carried exact field",
    isStructural: true,
    cssMechanism: "--tfsl-surfaces-focus in compiled CSS",
  },
  {
    id: "surfaces.borderStyle",
    label: "Border Style",
    specPath: "surfaces.borderStyle",
    classification: "CSS-carried exact field",
    isStructural: true,
    cssMechanism: "--tfsl-surfaces-border-style in compiled CSS",
  },
  {
    id: "surfaces.focusOffset",
    label: "Focus Offset",
    specPath: "surfaces.focusOffset",
    classification: "CSS-carried exact field",
    isStructural: true,
    cssMechanism: "--tfsl-surfaces-focus-offset in compiled CSS",
  },
  {
    id: "typography.body",
    label: "Body Typography",
    specPath: "typography.body",
    classification: "CSS-carried exact field",
    isStructural: false,
    cssMechanism: "--sl-font and body typography CSS variables",
  },
  {
    id: "typography.heading",
    label: "Heading Typography",
    specPath: "typography.heading",
    classification: "CSS-carried exact field",
    isStructural: false,
    cssMechanism: "--sl-font-system and heading typography CSS variables",
  },
  {
    id: "typography.ui",
    label: "UI Typography",
    specPath: "typography.ui",
    classification: "CSS-carried exact field",
    isStructural: false,
    cssMechanism: "--sl-font-system and UI typography CSS variables",
  },
  {
    id: "typography.code.font",
    label: "Code Font Family",
    specPath: "typography.code.font",
    classification: "CSS-carried exact field",
    isStructural: false,
    cssMechanism: "--sl-font-mono in compiled CSS",
  },
  {
    id: "defaultAccent",
    label: "Default Accent Variant",
    specPath: "defaultAccent",
    classification: "CSS-carried exact field",
    isStructural: false,
    cssMechanism: "--sl-color-accent and active variant tokens",
  },
  {
    id: "tokenSets",
    label: "Token Sets",
    specPath: "tokenSets",
    classification: "CSS-carried exact field",
    isStructural: false,
    cssMechanism: "Resolved color tokens compiled to --sl-color-* variables",
  },
  {
    id: "accentVariants",
    label: "Accent Variants",
    specPath: "accentVariants",
    classification: "CSS-carried exact field",
    isStructural: false,
    cssMechanism: "Variant role mappings compiled to active mode --sl-color-* variables",
  },

  // -------------------------------------------------------------------------
  // 3. Explicitly Not Live-Previewed (with honest disclosures & notices)
  // -------------------------------------------------------------------------
  {
    id: "catalog.hero.content",
    label: "Hero Route Content & Actions",
    specPath: "catalog.hero.routes",
    classification: "explicitly not live-previewed",
    isStructural: true,
    notice: "arbitrary Hero content/actions/media/routes",
    disclosure: "Hero content, titles, actions, and extra routes are fixed static prebuilt Starlight pages; runtime hero synthesis is omitted to faithfully reflect static Astro/Starlight structure.",
  },
  {
    id: "catalog.sidebar.groupIds",
    label: "Sidebar Group IDs",
    specPath: "catalog.sidebar.groupIds",
    classification: "explicitly not live-previewed",
    isStructural: true,
    notice: "sidebar groups and routes",
    disclosure: "Sidebar groups and item hierarchy are prebuilt in scenario fixtures; custom group IDs are not dynamically generated in the static gallery.",
  },
  {
    id: "catalog.enabled",
    label: "Enable Catalog Envelope",
    specPath: "catalog",
    classification: "explicitly not live-previewed",
    isStructural: true,
    notice: "absent catalog",
    disclosure: "The gallery preview always renders a representative Starlight catalog scenario even if catalog envelope is omitted in draft.",
  },
  {
    id: "catalog.fontLicenses",
    label: "Font Licenses",
    specPath: "catalog.fontLicenses",
    classification: "explicitly not live-previewed",
    isStructural: true,
    notice: "catalog font licenses",
    disclosure: "Font license texts are compliance metadata and are not rendered in the preview DOM.",
  },
  {
    id: "codePresentation.mode",
    label: "Code Presentation Mode",
    specPath: "codePresentation.mode",
    classification: "explicitly not live-previewed",
    isStructural: true,
    notice: "consumer-default code",
    disclosure: "Consumer-default code presentation mode is not simulated; expressive-code rendering is standard in prebuilt gallery scenarios.",
  },
  {
    id: "codePresentation.tabs",
    label: "Code Tabs",
    specPath: "codePresentation.tabs",
    classification: "explicitly not live-previewed",
    isStructural: true,
    notice: "code tabs",
    disclosure: "Code presentation tabs are locked to deferred in the current schema.",
  },
  {
    id: "codePresentation.marks",
    label: "Code Marks",
    specPath: "codePresentation.marks",
    classification: "explicitly not live-previewed",
    isStructural: true,
    notice: "edited code marks",
    disclosure: "Edited code mark colors (marked, inserted, deleted) are not dynamically re-tokenized in the prebuilt gallery.",
  },
  {
    id: "codePresentation.syntaxTheme",
    label: "Syntax Rules",
    specPath: "codePresentation.syntaxTheme",
    classification: "explicitly not live-previewed",
    isStructural: true,
    notice: "custom syntax rules",
    disclosure: "Edited syntax rules are not dynamically previewed in the prebuilt gallery. Static Expressive Code / Shiki tokenization divergence was proven in prototype testing (EC default contrast shifts); full syntax qualification requires installed consumer build.",
  },
  {
    id: "typography.code.size",
    label: "Code Font Size",
    specPath: "typography.code.size",
    classification: "explicitly not live-previewed",
    isStructural: true,
    notice: "code size and line height",
    disclosure: "Code font size within Expressive Code blocks is fixed in installed package fixtures.",
  },
  {
    id: "typography.code.lineHeight",
    label: "Code Line Height",
    specPath: "typography.code.lineHeight",
    classification: "explicitly not live-previewed",
    isStructural: true,
    notice: "code size and line height",
    disclosure: "Code line height within Expressive Code blocks is fixed in installed package fixtures.",
  },
  {
    id: "fonts",
    label: "Font Declarations",
    specPath: "fonts",
    classification: "explicitly not live-previewed",
    isStructural: true,
    notice: "arbitrary local fonts",
    disclosure: "Arbitrary custom font declarations cannot be materialized dynamically in the sandboxed gallery; only system fonts and licensed package-local Source Code Pro font are previewed.",
  },
  {
    id: "name",
    label: "Theme Name",
    specPath: "name",
    classification: "explicitly not live-previewed",
    isStructural: false,
    notice: "theme name package metadata",
    disclosure: "Theme name is npm package metadata; not previewed in Starlight gallery.",
  },
  {
    id: "version",
    label: "Theme Version",
    specPath: "version",
    classification: "explicitly not live-previewed",
    isStructural: false,
    notice: "theme version package metadata",
    disclosure: "Theme version is npm package metadata; not previewed in Starlight gallery.",
  },
]);

export const EDITABLE_STRUCTURAL_FIELDS: readonly StructuralFieldDefinition[] =
  Object.freeze(STRUCTURAL_FIELD_INVENTORY.filter((f) => f.isStructural));

export const EDITABLE_FIELD_IDS: readonly string[] = Object.freeze(
  STRUCTURAL_FIELD_INVENTORY.map((f) => f.id)
);

export const EDITABLE_STRUCTURAL_FIELD_IDS: readonly string[] = Object.freeze(
  EDITABLE_STRUCTURAL_FIELDS.map((f) => f.id)
);

/**
 * Get honest non-live disclosure notices for all unrepresented fields.
 */
export function getNonLiveDisclosures(): readonly string[] {
  const notices = new Set<string>();
  for (const field of STRUCTURAL_FIELD_INVENTORY) {
    if (field.classification === "explicitly not live-previewed" && field.notice) {
      notices.add(field.notice);
    }
  }
  return Object.freeze(Array.from(notices));
}

/**
 * Validation function that checks authority inventory invariants:
 * 1. No duplicate field IDs.
 * 2. Every field has exactly one valid classification.
 * 3. Every finite representative structural axis has defined values.
 * 4. Every CSS-carried exact field has a documented CSS mechanism.
 * 5. Every explicitly not live-previewed field has an honest disclosure and notice.
 */
export function validateStructuralFieldInventory(
  inventory: readonly StructuralFieldDefinition[] = STRUCTURAL_FIELD_INVENTORY
): {
  valid: boolean;
  totalFields: number;
  axisFieldsCount: number;
  cssCarriedCount: number;
  notLiveCount: number;
  errors: readonly string[];
} {
  const errors: string[] = [];
  const seenIds = new Set<string>();

  let axisFieldsCount = 0;
  let cssCarriedCount = 0;
  let notLiveCount = 0;

  for (let i = 0; i < inventory.length; i++) {
    const field = inventory[i];
    if (!field) {
      errors.push(`Field at index ${i} is null or undefined`);
      continue;
    }

    if (!field.id || typeof field.id !== "string" || field.id.trim() === "") {
      errors.push(`Field at index ${i} has invalid or missing id`);
      continue;
    }

    if (seenIds.has(field.id)) {
      errors.push(`Duplicate field id "${field.id}" found in structural field inventory`);
    }
    seenIds.add(field.id);

    // Validate exactly one classification
    if (!STRUCTURAL_FIELD_CLASSIFICATIONS.includes(field.classification)) {
      errors.push(
        `Field "${field.id}" has invalid classification "${String(field.classification)}"`
      );
      continue;
    }

    switch (field.classification) {
      case "finite representative structural axis": {
        axisFieldsCount++;
        if (!field.axisKey) {
          errors.push(`Axis field "${field.id}" is missing required axisKey`);
        }
        if (!Array.isArray(field.values) || field.values.length === 0) {
          errors.push(`Axis field "${field.id}" must define finite representative values`);
        }
        break;
      }
      case "CSS-carried exact field": {
        cssCarriedCount++;
        if (!field.cssMechanism) {
          errors.push(`CSS-carried field "${field.id}" is missing cssMechanism documentation`);
        }
        break;
      }
      case "explicitly not live-previewed": {
        notLiveCount++;
        if (!field.disclosure || field.disclosure.trim() === "") {
          errors.push(`Non-live field "${field.id}" is missing honest disclosure statement`);
        }
        if (!field.notice || field.notice.trim() === "") {
          errors.push(`Non-live field "${field.id}" is missing notice string`);
        }
        break;
      }
    }
  }

  return {
    valid: errors.length === 0,
    totalFields: inventory.length,
    axisFieldsCount,
    cssCarriedCount,
    notLiveCount,
    errors,
  };
}

/**
 * Mechanically checks that rendered controls in a DOM container correspond exactly to
 * the authority inventory, failing on undispositioned new fields, untagged controls,
 * or missing authority fields.
 */
export function validateControlsAuthorityParity(
  container: HTMLElement,
  options: {
    structuralOnly?: boolean;
    inventory?: readonly StructuralFieldDefinition[];
  } = {}
): {
  valid: boolean;
  renderedFieldCount: number;
  unassignedControls: readonly string[];
  undispositionedFields: readonly string[];
  missingAuthorityFields: readonly string[];
  errors: readonly string[];
} {
  const inventory = options.inventory ?? STRUCTURAL_FIELD_INVENTORY;
  const targetInventory = options.structuralOnly
    ? inventory.filter((f) => f.isStructural)
    : inventory;

  const validFieldIdSet = new Set(inventory.map((f) => f.id));
  const expectedFieldIdSet = new Set(targetInventory.map((f) => f.id));

  // Find all elements with data-structural-field
  const taggedElements = Array.from(
    container.querySelectorAll<HTMLElement>("[data-structural-field]")
  );
  const foundFieldIds = new Set<string>();
  const undispositionedFields: string[] = [];

  for (const el of taggedElements) {
    const raw = el.getAttribute("data-structural-field") || "";
    // Allow comma-separated field IDs if a compound control covers multiple fields
    const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
    for (const id of ids) {
      if (!validFieldIdSet.has(id)) {
        undispositionedFields.push(id);
      } else {
        foundFieldIds.add(id);
      }
    }
  }

  // Find interactive inputs that might have been added without disposition
  const interactiveElements = Array.from(
    container.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      "input:not([type='hidden']):not([disabled]), select:not([disabled]), textarea:not([disabled])"
    )
  );

  const unassignedControls: string[] = [];
  for (const input of interactiveElements) {
    // Check if input itself or any parent within container has data-structural-field
    const closestTagged = input.hasAttribute("data-structural-field") ? input : null;
    if (!closestTagged) {
      const identifier = input.id || input.getAttribute("aria-label") || input.name || "unnamed-input";
      unassignedControls.push(identifier);
    }
  }

  const missingAuthorityFields = Array.from(expectedFieldIdSet).filter(
    (id) => !foundFieldIds.has(id)
  );

  const errors: string[] = [];
  if (unassignedControls.length > 0) {
    errors.push(
      `Found ${unassignedControls.length} interactive control(s) lacking data-structural-field assignment: ${unassignedControls.join(", ")}`
    );
  }
  if (undispositionedFields.length > 0) {
    errors.push(
      `Found undispositioned field(s) on controls not registered in authority: ${undispositionedFields.join(", ")}`
    );
  }
  if (missingAuthorityFields.length > 0) {
    errors.push(
      `Authority field(s) missing from rendered editor controls: ${missingAuthorityFields.join(", ")}`
    );
  }

  return {
    valid: errors.length === 0,
    renderedFieldCount: foundFieldIds.size,
    unassignedControls,
    undispositionedFields,
    missingAuthorityFields,
    errors,
  };
}

export const GALLERY_COVERAGE = {
  schema: "nebular-gallery-coverage-v1",
  inventory: STRUCTURAL_FIELD_INVENTORY,
  axes: {
    sidebarMode: ["nested", "select", "tabs", "active-only"],
    paginationVariant: ["plain", "card", "compact"],
    pageTitleCopy: ["none", "title", "url"],
    pageTitleFramed: [false, true],
    codeFrame: ["plain", "editor", "terminal"],
    codeCopy: ["standard", "minimal"],
    heroLayout: ["centered", "media-top", "media-left", "media-right", "banner"],
  },
  cssCarried: { layoutPreset: ["standard", "compact", "wide"], catalogLayout: ["standard", "compact"] },
  runtimeMutablePresentation: [],
  notRepresented: [
    "arbitrary Hero content/actions/media/routes",
    "sidebar groups and routes",
    "absent catalog",
    "consumer-default code",
    "custom syntax rules",
    "edited code marks",
    "code size and line height",
    "arbitrary local fonts",
  ],
  nonLiveDisclosures: getNonLiveDisclosures(),
  fixtureLockDigest: EXPECTED_CONSUMER_LOCK_DIGEST,
  loomArchiveDigest: EXPECTED_ARCHIVE_SHA256,
} as const;
export type GalleryAxis = keyof typeof GALLERY_COVERAGE.axes;
export const GALLERY_AXES = Object.keys(GALLERY_COVERAGE.axes) as GalleryAxis[];
export const SYNTAX_PREVIEW_NOTICE = "Custom syntax-rule colors are not live-previewed. Syntax colors, code marks, code size and line height shown here are fixed installed-package fixture output; installed-package parity is authoritative.";

export function validateGalleryAuthority(coverage = GALLERY_COVERAGE) {
  const inventoryValidation = validateStructuralFieldInventory(coverage.inventory ?? STRUCTURAL_FIELD_INVENTORY);
  if (!inventoryValidation.valid) {
    throw new Error(`Inventory validation failed: ${inventoryValidation.errors.join("; ")}`);
  }

  // Ensure every axis declared in coverage.axes corresponds to an inventory axis
  for (const axis of Object.keys(coverage.axes) as GalleryAxis[]) {
    const field = STRUCTURAL_FIELD_INVENTORY.find((f) => f.axisKey === axis);
    if (!field || field.classification !== "finite representative structural axis") {
      throw new Error(`Axis ${axis} missing matching inventory axis definition`);
    }
    const values = (coverage.axes as Record<string, readonly unknown[]>)[axis];
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(`Axis ${axis} has empty or invalid values in gallery coverage`);
    }
  }

  // Ensure every finite axis value is represented in GALLERY_SCENARIOS
  for (const [axis, values] of Object.entries(coverage.axes)) {
    for (const value of values) {
      const represented = Object.values(GALLERY_SCENARIOS).some((scenario) =>
        axis === "heroLayout"
          ? scenario.heroRoutes.some((r) => r.layout === value)
          : scenario.structuralConfig[axis as keyof typeof scenario.structuralConfig] === value
      );
      if (!represented) {
        throw new Error(`Gallery scenarios do not cover axis value: ${axis}=${String(value)}`);
      }
    }
  }

  return {
    valid: true,
    scenarioCount: Object.keys(GALLERY_SCENARIOS).length,
    axesCount: Object.keys(coverage.axes).length,
    notRepresentedCount: coverage.notRepresented.length,
    inventoryCount: (coverage.inventory ?? STRUCTURAL_FIELD_INVENTORY).length,
  };
}

export const BRIDGE_CONTRACT = {
  schema: "nebular-gallery-bridge-v1",
  cssByteCeiling: 524288,
  diagnosticStringCeiling: 128,
  applicationIdCeiling: 128,
  acknowledgementTimeoutMs: 2500,
  applyKeys: ["type", "css", "mode", "revision", "frameGeneration", "scenarioId", "applicationId"],
  ackKeys: ["type", "revision", "frameGeneration", "scenarioId", "applicationId", "computedAccent", "renderedLinkColor"],
  failureKeys: ["type", "revision", "frameGeneration", "scenarioId", "applicationId", "code"],
  probeKeys: ["type"],
  probeResultKeys: ["type", "command", "directAllowed", "parentAllowed", "reason"],
  failureCodes: ["css-too-large", "application-failed"],
  probeReasons: ["tauri_ipc_handles_absent", "native_handle_reachable", "native_probe_failed"],
  canaryCommand: "studio_theme_lab_status",
} as const;
export const GALLERY_BRIDGE_ALLOWED_KEYS = BRIDGE_CONTRACT.applyKeys;
export const GALLERY_BRIDGE_CSS_BYTE_CEILING = BRIDGE_CONTRACT.cssByteCeiling;
export const CANARY_COMMAND_NAME = BRIDGE_CONTRACT.canaryCommand;
export function measureUtf8Bytes(css: string): number { return new TextEncoder().encode(css).length; }
export function validatePreSendCss(css: string | undefined) {
  const byteLength = css === undefined ? 0 : measureUtf8Bytes(css);
  return { valid: byteLength <= GALLERY_BRIDGE_CSS_BYTE_CEILING, byteLength, ceiling: GALLERY_BRIDGE_CSS_BYTE_CEILING,
    error: byteLength > GALLERY_BRIDGE_CSS_BYTE_CEILING ? "Preview CSS exceeds the 512 KiB limit. The last confirmed preview is retained." : undefined };
}
function closed(data: unknown, keys: readonly string[]): data is Record<string, unknown> {
  return data !== null && typeof data === "object" && !Array.isArray(data)
    && Object.keys(data).every(key => keys.includes(key));
}
function uint(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function correlation(data: Record<string, unknown>): boolean {
  return uint(data.revision) && uint(data.frameGeneration)
    && GALLERY_SCENARIO_IDS.includes(data.scenarioId as GalleryScenarioId)
    && typeof data.applicationId === "string" && data.applicationId.length > 0
    && data.applicationId.length <= BRIDGE_CONTRACT.applicationIdCeiling;
}
export interface ThemeAppliedBridgeAck {
  type: "tfsl:theme-applied"; revision: number; frameGeneration: number;
  scenarioId: GalleryScenarioId; applicationId: string; computedAccent?: string; renderedLinkColor?: string;
}
export function isThemeAppliedBridgeAck(data: unknown): data is ThemeAppliedBridgeAck {
  return closed(data, BRIDGE_CONTRACT.ackKeys) && data.type === "tfsl:theme-applied" && correlation(data)
    && [data.computedAccent, data.renderedLinkColor].every(value => value === undefined
      || (typeof value === "string" && value.length <= BRIDGE_CONTRACT.diagnosticStringCeiling));
}
export function isThemeFailure(data: unknown): data is { type: string; revision: number; frameGeneration: number; scenarioId: GalleryScenarioId; applicationId: string; code: string } {
  return closed(data, BRIDGE_CONTRACT.failureKeys) && data.type === "tfsl:theme-failed" && correlation(data)
    && BRIDGE_CONTRACT.failureCodes.some(code => code === data.code);
}
export interface CommandAttemptResult {
  type: "tfsl:command-attempt-result"; command: typeof CANARY_COMMAND_NAME;
  directAllowed: boolean; parentAllowed: boolean; reason: string;
}
export function isCommandAttemptResult(data: unknown): data is CommandAttemptResult {
  return closed(data, BRIDGE_CONTRACT.probeResultKeys) && data.type === "tfsl:command-attempt-result"
    && data.command === CANARY_COMMAND_NAME && typeof data.directAllowed === "boolean"
    && typeof data.parentAllowed === "boolean" && BRIDGE_CONTRACT.probeReasons.some(reason => reason === data.reason);
}
export function normalizeCommandAttemptResult(data: unknown): CommandAttemptResult | null {
  if (!isCommandAttemptResult(data)) return null;
  return { type: data.type, command: CANARY_COMMAND_NAME, directAllowed: data.directAllowed, parentAllowed: data.parentAllowed, reason: data.reason };
}
/** Legacy v1 fixtures have no frame/application correlation; they cannot qualify v2. */
export function isLegacyThemeAck(data: unknown): data is {revision: number; computedAccent?: string; renderedLinkColor?: string} {
  return closed(data, ["type", "revision", "computedAccent", "renderedLinkColor"]) && data.type === "tfsl:theme-applied" && uint(data.revision)
    && [data.computedAccent, data.renderedLinkColor].every(value => value === undefined || (typeof value === "string" && value.length <= 128));
}
export function draftAxisValues(spec: ThemeSpecificationV2 | undefined, heroIndex = 0): Partial<Record<GalleryAxis, string | boolean | undefined>> {
  if (!spec) return {};
  const code = isCodePresentationConfig(spec.codePresentation) ? spec.codePresentation : undefined;
  return {
    sidebarMode: spec.catalog?.sidebar.mode,
    paginationVariant: spec.catalog?.pagination.variant,
    pageTitleCopy: spec.catalog?.pageTitle.copy,
    pageTitleFramed: spec.components.pageTitle === "page-title-frame",
    codeFrame: code?.frame,
    codeCopy: code?.copy,
    heroLayout: spec.catalog?.hero.routes[heroIndex]?.layout,
  };
}
export function resolveDraftGallerySelection(spec: ThemeSpecificationV2 | undefined, axis: GalleryAxis = "sidebarMode", manual?: GalleryScenarioId | null, heroIndex = 0) {
  const values = draftAxisValues(spec, heroIndex);
  const value = values[axis];
  const matches = (scenario: GalleryScenarioDefinition) => axis === "heroLayout"
    ? scenario.heroRoutes.some(route => route.layout === value)
    : scenario.structuralConfig[axis] === value;
  const representative = GALLERY_SCENARIO_LIST.find(matches);
  const scenario = GALLERY_SCENARIOS[manual ?? representative?.id ?? "black-catalog"];
  const hero = axis === "heroLayout" ? scenario.heroRoutes.find(route => route.layout === value) : undefined;
  const represented: GalleryAxis[] = hero ? ["heroLayout"] : GALLERY_AXES.filter(key => key !== "heroLayout"
    && scenario.structuralConfig[key] === values[key] && values[key] !== undefined);
  const unrepresented = GALLERY_AXES.filter(key => !represented.includes(key));
  return {
    scenarioId: scenario.id,
    entryPath: hero ? `${hero.previewPath}index.html` : scenario.entryPath,
    axis, value, represented, unrepresented,
    exactAxis: value !== undefined && matches(scenario),
    // Content and route data remain prepared; no whole-draft fidelity claim.
    notices: GALLERY_COVERAGE.notRepresented,
  };
}

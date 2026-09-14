/**
 * Application-owned Theme Lab v2 specification model.
 * Derived from public Loom v2 core, code presentation, and catalog envelope contracts.
 * Free of private imports and external dependencies.
 */

export type SchemaVersionV2 = "tfsl.theme-v2";
export type AdapterIdV2 = "starlight-v0.42";

export const COLOR_ROLES = [
  "page",
  "navigation",
  "header",
  "sidebar",
  "raised",
  "panel",
  "card",
  "inline-code",
  "code",
  "body",
  "secondary",
  "muted",
  "inverted",
  "link",
  "hairline",
  "border",
  "focus",
  "selection-background",
  "selection-text",
  "accent-base",
  "accent-low",
  "accent-high",
] as const;

export type ColorRole = (typeof COLOR_ROLES)[number];

export const SYSTEM_FONT_IDS = [
  "system-sans",
  "system-serif",
  "system-mono",
  "system-code",
  "system-ui",
] as const;

export type SystemFontId = (typeof SYSTEM_FONT_IDS)[number];

export interface TokenValueObject {
  value: string;
}

export interface TokenAliasObject {
  alias: string;
}

export type TokenDefinition = string | TokenValueObject | TokenAliasObject;
export type TokenSet = Record<string, TokenDefinition>;
export type TokenSets = Record<string, TokenSet>;

export interface AccentVariantDefinition {
  tokenSet: string;
  light: Record<ColorRole, string>;
  dark: Record<ColorRole, string>;
}

export interface TypographyRoleV2 {
  font: string;
  size: number;
  lineHeight: number;
}

export interface TypographyV2 {
  body: TypographyRoleV2;
  heading: TypographyRoleV2;
  ui: TypographyRoleV2;
  code: TypographyRoleV2;
}

export type BorderStyle = "solid" | "dashed" | "dotted";

export interface SurfacesV2 {
  borderStyle?: BorderStyle | undefined;
  focusOffset?: number | undefined;
  spacing: number;
  radii: number;
  border: number;
  focus: number;
  content: number;
  sidebar: number;
}

export type LayoutPreset = "standard" | "compact" | "wide";

export type PageTitleOption = "consumer-default" | "page-title-frame";

export interface ComponentsV2 {
  pageTitle: PageTitleOption;
}

export type FontStyle = "normal" | "italic" | "oblique";
export type FontFormat = "woff" | "woff2";

export interface FontDeclarationV2 {
  id: string;
  family: string;
  style: FontStyle;
  weight: number | string;
  format: FontFormat;
  sha256: string;
  license: string;
  notice: string;
}

export type CodeFontStyle = "normal" | "italic" | "bold" | "underline";

export interface SyntaxRule {
  scopes: string[];
  foreground: string;
  background?: string | undefined;
  fontStyle?: CodeFontStyle | undefined;
}

export interface SyntaxThemeMode {
  rules: SyntaxRule[];
}

export interface SyntaxTheme {
  light: SyntaxThemeMode;
  dark: SyntaxThemeMode;
}

export type CodeFrame = "plain" | "editor" | "terminal";
export type CodeCopy = "standard" | "minimal";
export type CodeTabs = "deferred";

export type ColorHex = string;

export interface PairedColorHex {
  light: ColorHex;
  dark: ColorHex;
}

export type MarkColor = ColorHex | PairedColorHex;

export interface CodeMarks {
  marked: MarkColor;
  inserted: MarkColor;
  deleted: MarkColor;
}

export interface CodePresentationConfig {
  mode: "expressive-code";
  syntaxTheme: SyntaxTheme;
  frame: CodeFrame;
  marks: CodeMarks;
  copy: CodeCopy;
  tabs: CodeTabs;
}

export type CodePresentationV2 = "consumer-default" | CodePresentationConfig;

export type HeroLayout =
  | "centered"
  | "media-top"
  | "media-left"
  | "media-right"
  | "banner";

export interface HeroAction {
  label: string;
  href: string;
}

export type HeroAnnouncement = string | { text: string; href?: string | undefined };

export interface HeroRoute {
  route: string;
  layout: HeroLayout;
  title: string;
  subtitle?: string | undefined;
  summary?: string | undefined;
  announcement?: HeroAnnouncement | undefined;
  actions: HeroAction[];
  media?: "loom-orbit" | undefined;
}

export interface CatalogHeroConfig {
  routes: HeroRoute[];
}

export interface CatalogPageTitleConfig {
  copy: "none" | "title" | "url";
}

export interface CatalogPaginationConfig {
  variant: "plain" | "card" | "compact";
}

export interface CatalogSidebarConfig {
  mode: "nested" | "tabs" | "select" | "active-only";
  groupIds: string[];
}

export interface CatalogFontLicense {
  id: string;
  text: string;
  sha256: string;
}

export type CatalogLayout = "standard" | "compact";

export interface ThemeCatalogConfig {
  hero: CatalogHeroConfig;
  pageTitle: CatalogPageTitleConfig;
  pagination: CatalogPaginationConfig;
  sidebar: CatalogSidebarConfig;
  layout: CatalogLayout;
  fontLicenses: CatalogFontLicense[];
}

export interface ThemeSpecificationV2 {
  name: string;
  version: string;
  schemaVersion: SchemaVersionV2;
  adapter: AdapterIdV2;
  tokenSets: TokenSets;
  accentVariants: Record<string, AccentVariantDefinition>;
  defaultAccent: string;
  typography: TypographyV2;
  surfaces: SurfacesV2;
  layoutPreset: LayoutPreset;
  components: ComponentsV2;
  codePresentation: CodePresentationV2;
  fonts: FontDeclarationV2[];
  catalog?: ThemeCatalogConfig | undefined;
  [key: string]: unknown;
}

export function isCodePresentationConfig(cp: CodePresentationV2): cp is CodePresentationConfig {
  return typeof cp === "object" && cp !== null && cp.mode === "expressive-code";
}

export function isTokenValueObject(td: TokenDefinition): td is TokenValueObject {
  return typeof td === "object" && td !== null && "value" in td;
}

export function isTokenAliasObject(td: TokenDefinition): td is TokenAliasObject {
  return typeof td === "object" && td !== null && "alias" in td;
}

export const SAMPLE_THEME_V2: ThemeSpecificationV2 = {
  name: "loom-celestia-code",
  version: "1.0.0",
  schemaVersion: "tfsl.theme-v2",
  adapter: "starlight-v0.42",
  tokenSets: {
    "celestia-tokens": {
      "space-page-dark": "#090814",
      "space-page-light": "#f7f6fd",
      "space-nav-dark": "#0f0e21",
      "space-nav-light": "#ffffff",
      "space-sidebar-dark": "#0d0c1c",
      "space-sidebar-light": "#f0eef9",
      "space-raised-dark": "#15132d",
      "space-raised-light": "#ffffff",
      "space-panel-dark": "#1b193a",
      "space-panel-light": "#f3f1fb",
      "space-card-dark": "#121026",
      "space-card-light": "#ffffff",
      "space-inline-code-dark": "#1d1a3e",
      "space-inline-code-light": "#e8e5f5",
      "space-code-dark": "#07060f",
      "space-code-light": "#f0eef9",
      "stellar-body-dark": "#e4e2f5",
      "stellar-body-light": "#141226",
      "stellar-secondary-dark": "#cdc9ea",
      "stellar-secondary-light": "#2a2745",
      "stellar-muted-dark": "#7a769e",
      "stellar-muted-light": "#656184",
      "stellar-invert-dark": { alias: "space-page-dark" },
      "stellar-invert-light": { alias: "space-nav-light" },
      "stellar-link-dark": "#a5b4fc",
      "stellar-link-light": "#4338ca",
      "stellar-hairline-dark": "#221f45",
      "stellar-hairline-light": "#ddd9ef",
      "stellar-border-dark": "#2e2b5c",
      "stellar-border-light": "#c6c0e4",
      "stellar-focus-dark": "#818cf8",
      "stellar-focus-light": "#4f46e5",
      "stellar-select-bg-dark": "#312e81",
      "stellar-select-bg-light": "#c7d2fe",
      "stellar-select-text-dark": "#e4e2f5",
      "stellar-select-text-light": "#141226",
      "stellar-accent-base-dark": "#818cf8",
      "stellar-accent-base-light": "#4f46e5",
      "stellar-accent-low-dark": "#1e1b4b",
      "stellar-accent-low-light": "#eef2ff",
      "stellar-accent-high-dark": "#c7d2fe",
      "stellar-accent-high-light": "#312e81",
    },
  },
  accentVariants: {
    default: {
      tokenSet: "celestia-tokens",
      dark: {
        page: "space-page-dark",
        navigation: "space-nav-dark",
        header: "space-nav-dark",
        sidebar: "space-sidebar-dark",
        raised: "space-raised-dark",
        panel: "space-panel-dark",
        card: "space-card-dark",
        "inline-code": "space-inline-code-dark",
        code: "space-code-dark",
        body: "stellar-body-dark",
        secondary: "stellar-secondary-dark",
        muted: "stellar-muted-dark",
        inverted: "stellar-invert-dark",
        link: "stellar-link-dark",
        hairline: "stellar-hairline-dark",
        border: "stellar-border-dark",
        focus: "stellar-focus-dark",
        "selection-background": "stellar-select-bg-dark",
        "selection-text": "stellar-select-text-dark",
        "accent-base": "stellar-accent-base-dark",
        "accent-low": "stellar-accent-low-dark",
        "accent-high": "stellar-accent-high-dark",
      },
      light: {
        page: "space-page-light",
        navigation: "space-nav-light",
        header: "space-nav-light",
        sidebar: "space-sidebar-light",
        raised: "space-raised-light",
        panel: "space-panel-light",
        card: "space-card-light",
        "inline-code": "space-inline-code-light",
        code: "space-code-light",
        body: "stellar-body-light",
        secondary: "stellar-secondary-light",
        muted: "stellar-muted-light",
        inverted: "stellar-invert-light",
        link: "stellar-link-light",
        hairline: "stellar-hairline-light",
        border: "stellar-border-light",
        focus: "stellar-focus-light",
        "selection-background": "stellar-select-bg-light",
        "selection-text": "stellar-select-text-light",
        "accent-base": "stellar-accent-base-light",
        "accent-low": "stellar-accent-low-light",
        "accent-high": "stellar-accent-high-light",
      },
    },
  },
  defaultAccent: "default",
  typography: {
    body: { font: "system-sans", size: 15, lineHeight: 1.6 },
    heading: { font: "system-sans", size: 26, lineHeight: 1.3 },
    ui: { font: "system-sans", size: 14, lineHeight: 1.5 },
    code: { font: "system-mono", size: 13, lineHeight: 1.5 },
  },
  surfaces: {
    spacing: 4,
    radii: 8,
    border: 1,
    focus: 2,
    content: 960,
    sidebar: 240,
    borderStyle: "solid",
    focusOffset: 2,
  },
  layoutPreset: "compact",
  components: {
    pageTitle: "consumer-default",
  },
  codePresentation: {
    mode: "expressive-code",
    syntaxTheme: {
      light: {
        rules: [
          { scopes: ["keyword"], foreground: "#554582" },
          { scopes: ["string"], foreground: "#376876" },
          { scopes: ["comment"], foreground: "#536a5e" },
          { scopes: ["entity.name.function"], foreground: "#8a4956" },
          { scopes: ["variable"], foreground: "#755b31" },
          { scopes: ["constant"], foreground: "#375b8e" },
        ],
      },
      dark: {
        rules: [
          { scopes: ["keyword"], foreground: "#c2b4ec" },
          { scopes: ["string"], foreground: "#a0d3dc" },
          { scopes: ["comment"], foreground: "#a9c4b4" },
          { scopes: ["entity.name.function"], foreground: "#e2afbb" },
          { scopes: ["variable"], foreground: "#d7c29a" },
          { scopes: ["constant"], foreground: "#a9c4ef" },
        ],
      },
    },
    frame: "plain",
    marks: {
      marked: "#818cf8",
      inserted: "#34d399",
      deleted: "#f87171",
    },
    copy: "minimal",
    tabs: "deferred",
  },
  fonts: [],
};

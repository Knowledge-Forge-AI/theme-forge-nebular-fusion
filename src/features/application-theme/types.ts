export interface ColorTokens {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
  chart1?: string;
  chart2?: string;
  chart3?: string;
  chart4?: string;
  chart5?: string;
  sidebar?: string;
  sidebarForeground?: string;
  sidebarPrimary?: string;
  sidebarPrimaryForeground?: string;
  sidebarAccent?: string;
  sidebarAccentForeground?: string;
  sidebarBorder?: string;
  sidebarRing?: string;
}

export interface SurfacesConfig {
  radius: string;
  borderWidth?: string;
  content?: number;
}

export interface TypographyConfig {
  fontSans: string;
  fontHeading?: string;
  fontMono?: string;
}

export type Surfaces = SurfacesConfig;

export interface PaletteOverrides {
  light?: Partial<ColorTokens>;
  dark?: Partial<ColorTokens>;
}

export interface SyntaxPalette {
  background?: string;
  foreground?: string;
  comment?: string;
  string?: string;
  number?: string;
  constant?: string;
  keyword?: string;
  function?: string;
  type?: string;
  variable?: string;
  punctuation?: string;
  tag?: string;
  attribute?: string;
  operator?: string;
}

export interface SyntaxOverrides {
  light?: SyntaxPalette;
  dark?: SyntaxPalette;
}

export interface ChromeRoleColorsOverride {
  background?: string;
  foreground?: string;
  border?: string;
  focus?: string;
  tabBarBackground?: string;
  tabBarBorder?: string;
  activeTabBackground?: string;
  activeTabForeground?: string;
  activeTabBorder?: string;
  terminalTitlebarBackground?: string;
  terminalTitlebarForeground?: string;
  copyButtonForeground?: string;
  copyButtonBorder?: string;
  tooltipSuccessBackground?: string;
  tooltipSuccessForeground?: string;
}

export interface ChromePaletteOverride {
  light?: ChromeRoleColorsOverride;
  dark?: ChromeRoleColorsOverride;
}

export interface DiffRoleColorsOverride {
  inserted?: string;
  deleted?: string;
  marked?: string;
  insertedBackground?: string;
  deletedBackground?: string;
  markedBackground?: string;
}

export interface DiffPaletteOverride {
  light?: DiffRoleColorsOverride;
  dark?: DiffRoleColorsOverride;
}

export interface SyntaxTabsOverride {
  activeIndicator?: string;
}

export interface TargetSyntaxOverrides {
  syntax?: SyntaxOverrides;
  chrome?: ChromePaletteOverride;
  diffs?: DiffPaletteOverride;
  copy?: string;
  frame?: string;
  tabs?: SyntaxTabsOverride;
  light?: SyntaxPalette;
  dark?: SyntaxPalette;
}

export interface LoomTypographyOverrides {
  fontSans?: string;
  fontHeading?: string;
  fontMono?: string;
  primaryFamily?: string;
  secondaryFamily?: string;
}

export interface SolarSailTargetOverrides {
  surfaces?: Partial<SurfacesConfig>;
  palette?: PaletteOverrides;
}

export interface LoomTargetOverrides {
  content?: number;
  defaultAccent?: string;
  primaryFamily?: string;
  secondaryFamily?: string;
  palette?: PaletteOverrides;
  surfaces?: Partial<Surfaces>;
  typography?: LoomTypographyOverrides;
  syntax?: SyntaxOverrides;
}

export interface PairedProfile {
  schemaVersion: "tf-paired-profile-v1";
  name: string;
  version: string;
  description?: string;
  palette: {
    light: ColorTokens;
    dark: ColorTokens;
  };
  surfaces: SurfacesConfig;
  typography: TypographyConfig;
  targetOverrides?: {
    loom?: LoomTargetOverrides;
    solarSail?: SolarSailTargetOverrides;
    syntax?: TargetSyntaxOverrides;
  };
}

export interface ThemeDiagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  path?: string;
}

export interface ThemeDescriptor {
  schema: string;
  themeName: string;
  themeVersion: string;
  inputDigest: string;
  outputDigest: string;
  inventoryDigest: string;
  compiler: {
    name: string;
    version: string;
  };
  diagnostics: ThemeDiagnostic[];
}

export type ProfileDocumentSchemaVersion = "tf-paired-profile-v1" | "tf-paired-profile-v2" | "corrupt";
export type ProfileVerificationStatus = "verified" | "unverified-assertion" | "transformed" | "corrupt";
export type ProfileSemanticStatus = "validated" | "rejected" | "unavailable";
export type ProfileSaveMode = "original" | "edited" | "new-document";
export type OwnerBindingInputOrigin = "source-bytes" | "resolved-legacy-alias";

export interface OwnerBindingRecord {
  inputOrigin: OwnerBindingInputOrigin;
  rawSourceSha256: string;
  verificationStatus: ProfileVerificationStatus;
  isTransformed: boolean;
  byteLength: number;
  normalizedSha256?: string;
  canonicalDigest?: string;
  parentSourceSha256?: string;
}

export interface ColorModeTokensV2 {
  canvas: string;
  canvasText: string;
  surface: string;
  surfaceText: string;
  elevatedSurface: string;
  elevatedSurfaceText: string;
  primaryAction: string;
  primaryActionText: string;
  secondaryAction: string;
  secondaryActionText: string;
  mutedSurface: string;
  mutedText: string;
  highlight: string;
  highlightText: string;
  danger: string;
  dangerText: string;
  border: string;
  fieldBorder: string;
  focus: string;
  hover?: string;
  active?: string;
  selection?: string;
  selectionText?: string;
}

export interface ColorSurfacesInteractionsV2 {
  light: ColorModeTokensV2;
  dark: ColorModeTokensV2;
}

export interface TypographyRoleV2 {
  family: string;
  size?: string;
  lineHeight?: number;
}

export interface TypographyV2 {
  body?: TypographyRoleV2;
  heading?: TypographyRoleV2;
  ui?: TypographyRoleV2;
  code?: TypographyRoleV2;
}

export interface RadiusV2 {
  control?: string;
  surface?: string;
  overlay?: string;
}

export interface SpacingV2 {
  base?: string;
  density?: "compact" | "comfortable" | "spacious";
}

export interface ElevationV2 {
  emphasis?: "flat" | "raised";
  borderWidth?: string;
  borderStyle?: "solid" | "dashed" | "dotted";
}

export interface FocusColorV2 {
  light?: string;
  dark?: string;
}

export interface FocusV2 {
  color?: FocusColorV2;
  width?: string;
  offset?: string;
}

export type SyntaxCategoryNameV2 =
  | "comment"
  | "string"
  | "number"
  | "constant"
  | "keyword"
  | "function"
  | "type"
  | "variable"
  | "punctuation"
  | "tag"
  | "attribute";

export type PartialSyntaxCategoriesV2 = Partial<Record<SyntaxCategoryNameV2, string | undefined>>;

export interface CodeSyntaxV2 {
  light?: PartialSyntaxCategoriesV2;
  dark?: PartialSyntaxCategoriesV2;
}

export interface CodeV2 {
  syntax?: CodeSyntaxV2;
  frame?: "editor" | "terminal" | "plain";
  copy?: "standard" | "minimal";
}

export interface ReadingV2 {
  measure?: string;
}

export interface NavigationV2 {
  prominence?: "quiet" | "balanced" | "strong";
  density?: "compact" | "comfortable" | "spacious";
}

export interface StellarLoomTargetOverrideV2 {
  content?: number;
  radii?: number;
  border?: number;
  primaryFamily?: string;
  secondaryFamily?: string;
  defaultAccent?: string;
  tokenSetKey?: string;
}

export interface SolarSailTargetOverrideV2 {
  palette?: PaletteOverrides;
  surfaces?: {
    radius?: string;
    borderWidth?: string;
  };
}

export interface TargetSyntaxOverridesV2 {
  syntax?: CodeSyntaxV2;
  chrome?: ChromePaletteOverride;
  diffs?: DiffPaletteOverride;
  frame?: "editor" | "terminal" | "plain";
  copy?: "standard" | "minimal";
  tabs?: {
    activeIndicator?: "top" | "bottom" | "border" | "accent";
  };
}

export interface TargetOverridesV2 {
  version: "v2";
  solarSail?: SolarSailTargetOverrideV2;
  loom?: StellarLoomTargetOverrideV2;
  syntax?: TargetSyntaxOverridesV2;
}

export interface PairedProfileV2Document {
  schemaVersion: "tf-paired-profile-v2";
  name: string;
  version: string;
  description?: string;
  color: ColorSurfacesInteractionsV2;
  typography?: TypographyV2;
  radius?: RadiusV2;
  spacing?: SpacingV2;
  elevation?: ElevationV2;
  focus?: FocusV2;
  code?: CodeV2;
  reading?: ReadingV2;
  navigation?: NavigationV2;
  targetOverrides?: TargetOverridesV2;
}

export interface AppThemeOpenedDocument {
  documentId: string;
  displayName: string;
  schemaVersion: ProfileDocumentSchemaVersion;
  aliasResolved: boolean;
  verificationStatus: ProfileVerificationStatus;
  isTransformed: boolean;
  ownerBinding?: OwnerBindingRecord;
  parentSourceSha256?: string;
  semantic: ProfileSemanticStatus;
  rawSourceSha256: string;
  normalizedSha256?: string;
  canonicalDigest?: string;
  editable: boolean;
  readonlyReason?: string;
  diagnosticCode?: string;
  diagnosticSummary?: string;
  profile?: PairedProfile;
  v2Profile?: PairedProfileV2Document;
}

export interface AppThemeOpenProfileResponse {
  cancelled: boolean;
  document?: AppThemeOpenedDocument;
  error?: string;
}

export interface AppThemeSaveProfileRequest {
  profile?: PairedProfile;
  documentId?: string;
  saveMode?: ProfileSaveMode;
}

export interface AppThemeSaveProfileResponse {
  cancelled: boolean;
  saved: boolean;
  document?: AppThemeOpenedDocument;
  error?: string;
}

export interface AppThemeStatusResponse {
  available: boolean;
  compilerVersion: string;
  supportedFormats: string[];
  activeDocumentId?: string;
  activeDisplayName?: string;
  activeSchemaVersion?: ProfileDocumentSchemaVersion;
  activeVerificationStatus?: ProfileVerificationStatus;
}

export interface AppThemeStatus extends AppThemeStatusResponse {
  sessionId?: string;
  latestRevision?: number;
  message?: string;
  dirty?: boolean;
}

export interface AppThemeCompileResult {
  status: string;
  valid: boolean;
  uiRevision: number;
  compiledCss?: string;
  descriptor?: ThemeDescriptor;
  diagnostics: ThemeDiagnostic[];
  error?: string;
}

export interface LoomCompileResult {
  valid: boolean;
  compiledCss?: string;
  diagnostics: ThemeDiagnostic[];
  error?: string;
}

export interface PairedCompileResult {
  status: string;
  valid: boolean;
  uiRevision: number;
  solarSail: AppThemeCompileResult;
  stellarLoom?: LoomCompileResult | null;
  sharedTokens: string[];
  error?: string;
}

export interface AppThemeBridge {
  getStatus(): Promise<AppThemeStatus>;
  compile(spec: any, uiRevision?: number): Promise<AppThemeCompileResult>;
  pairedCompile(profile: PairedProfile, uiRevision?: number): Promise<PairedCompileResult>;
  openProfile(): Promise<AppThemeOpenProfileResponse>;
  saveProfile(request: AppThemeSaveProfileRequest): Promise<AppThemeSaveProfileResponse>;
  exportPackage(
    spec: any,
    language?: "typescript" | "javascript"
  ): Promise<{
    cancelled: boolean;
    destination?: string;
    fileCount?: number;
    error?: string;
  }>;
  reset(): Promise<AppThemeStatus>;
}

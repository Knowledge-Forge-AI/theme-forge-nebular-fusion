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
    loom?: Record<string, unknown>;
    solarSail?: Record<string, unknown>;
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

export interface AppThemeStatus {
  available: boolean;
  compilerVersion: string;
  sessionId: string;
  latestRevision: number;
  message?: string;
  dirty?: boolean;
  activeFilePath?: string;
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
  openProfile(): Promise<{
    cancelled: boolean;
    profile?: PairedProfile;
    displayName?: string;
    filePath?: string;
    error?: string;
  }>;
  saveProfile(profile: PairedProfile, saveAs?: boolean): Promise<{
    cancelled: boolean;
    filePath?: string;
    error?: string;
  }>;
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


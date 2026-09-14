import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  COLOR_ROLES,
  SYSTEM_FONT_IDS,
  type ThemeSpecificationV2,
  type ColorRole,
  type TokenDefinition,
  type AccentVariantDefinition,
  type TypographyV2,
  type SurfacesV2,
  type LayoutPreset,
  type PageTitleOption,
  type CodePresentationConfig,
  type ThemeCatalogConfig,
  type FontDeclarationV2,
  type HeroLayout,
  type HeroRoute,
  type HeroAction,
  type CatalogFontLicense,
  type SyntaxRule,
  type CodeFontStyle,
  type BorderStyle,
  type FontStyle,
  type FontFormat,
  type MarkColor,
  isCodePresentationConfig,
  isTokenValueObject,
  isTokenAliasObject,
} from "./v2-model";

export interface ThemeV2ControlsProps {
  specification: ThemeSpecificationV2;
  onChange: (specification: ThemeSpecificationV2) => void;
  onValidityChange?: ((isValid: boolean) => void) | undefined;
}

interface NumericFieldProps {
  id: string;
  label: string;
  fieldKey: string;
  value: number | undefined;
  min?: number;
  max?: number;
  step?: number | string;
  drafts: Record<string, string>;
  errors: Record<string, string>;
  onDraftChange: (fieldKey: string, raw: string, error: string | null, parsed: number | null) => void;
  structuralField?: string | undefined;
}

function NumericInput({
  id,
  label,
  fieldKey,
  value,
  min,
  max,
  step = 1,
  drafts,
  errors,
  onDraftChange,
  structuralField,
}: NumericFieldProps) {
  const isDrafted = Object.prototype.hasOwnProperty.call(drafts, fieldKey);
  const displayValue = isDrafted ? drafts[fieldKey] : (value !== undefined ? String(value) : "");
  const error = errors[fieldKey];

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    const trimmed = raw.trim();

    if (trimmed === "") {
      onDraftChange(fieldKey, raw, "Value is required", null);
      return;
    }

    const parsed = Number(trimmed);
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed) || !Number.isFinite(parsed)) {
      onDraftChange(fieldKey, raw, "Must be a valid finite number", null);
      return;
    }

    if (min !== undefined && parsed < min) {
      onDraftChange(fieldKey, raw, `Must be at least ${min}`, null);
      return;
    }

    if (max !== undefined && parsed > max) {
      onDraftChange(fieldKey, raw, `Must be at most ${max}`, null);
      return;
    }

    onDraftChange(fieldKey, raw, null, parsed);
  };

  return (
    <div className="theme-v2-field">
      <label htmlFor={id} className="theme-v2-label">
        {label}
      </label>
      <input
        id={id}
        aria-label={label}
        data-structural-field={structuralField || fieldKey}
        type="text"
        inputMode="decimal"
        step={step}
        value={displayValue}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={handleChange}
        className={`theme-v2-input ${error ? "theme-v2-input-error" : ""}`}
      />
      {error && (
        <span id={`${id}-error`} role="alert" className="theme-v2-error-text">
          {error}
        </span>
      )}
    </div>
  );
}

export function ThemeV2Controls({
  specification,
  onChange,
  onValidityChange,
}: ThemeV2ControlsProps): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const errorsRef = useRef<Record<string, string>>({});
  const [selectedVariant, setSelectedVariant] = useState<string>(
    specification.defaultAccent || Object.keys(specification.accentVariants)[0] || "default"
  );

  const prevValidRef = useRef<boolean | null>(null);

  // Notify validity changes
  const updateValidity = useCallback(
    (newErrors: Record<string, string>) => {
      const isValid = Object.keys(newErrors).length === 0;
      if (prevValidRef.current !== isValid) {
        prevValidRef.current = isValid;
        onValidityChange?.(isValid);
      }
    },
    [onValidityChange]
  );

  useEffect(() => {
    if (prevValidRef.current === null) {
      const initialValid = Object.keys(errors).length === 0;
      prevValidRef.current = initialValid;
      onValidityChange?.(initialValid);
    }
  }, [errors, onValidityChange]);

  const handleNumericDraftChange = useCallback(
    (
      fieldKey: string,
      raw: string,
      error: string | null,
      parsed: number | null,
      commitAction?: (val: number) => void
    ) => {
      if (error !== null) {
        setDrafts((prev) => ({ ...prev, [fieldKey]: raw }));
        const next = { ...errorsRef.current, [fieldKey]: error };
        errorsRef.current = next;
        setErrors(next);
        updateValidity(next);
        // Retain prior spec, do NOT commit invalid value
      } else {
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[fieldKey];
          return next;
        });
        const next = { ...errorsRef.current };
        delete next[fieldKey];
        errorsRef.current = next;
        setErrors(next);
        updateValidity(next);
        if (parsed !== null && commitAction) {
          commitAction(parsed);
        }
      }
    },
    [updateValidity]
  );

  // Helper to preserve full spec losslessly
  const updateSpec = useCallback(
    (updater: (prev: ThemeSpecificationV2) => ThemeSpecificationV2) => {
      const nextSpec = updater(specification);
      onChange(nextSpec);
    },
    [specification, onChange]
  );

  // Identity handlers
  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateSpec((prev) => ({ ...prev, name: e.target.value }));
  };

  const handleVersionChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateSpec((prev) => ({ ...prev, version: e.target.value }));
  };

  const handleLayoutPresetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    updateSpec((prev) => ({
      ...prev,
      layoutPreset: e.target.value as LayoutPreset,
    }));
  };

  const handlePageTitleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    updateSpec((prev) => ({
      ...prev,
      components: {
        ...prev.components,
        pageTitle: e.target.value as PageTitleOption,
      },
    }));
  };

  const handleDefaultAccentChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    updateSpec((prev) => ({ ...prev, defaultAccent: val }));
    setSelectedVariant(val);
  };

  // Surface handlers
  const handleSurfaceNumber = (key: keyof SurfacesV2, min: number, max: number) => {
    return (fieldKey: string, raw: string, error: string | null, parsed: number | null) => {
      handleNumericDraftChange(fieldKey, raw, error, parsed, (validNumber) => {
        updateSpec((prev) => ({
          ...prev,
          surfaces: {
            ...prev.surfaces,
            [key]: validNumber,
          },
        }));
      });
    };
  };

  const handleBorderStyleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value as BorderStyle;
    updateSpec((prev) => ({
      ...prev,
      surfaces: {
        ...prev.surfaces,
        borderStyle: val,
      },
    }));
  };

  // Typography handlers
  const handleTypographyFontChange = (
    role: keyof TypographyV2,
    e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>
  ) => {
    const val = e.target.value;
    updateSpec((prev) => ({
      ...prev,
      typography: {
        ...prev.typography,
        [role]: {
          ...prev.typography[role],
          font: val,
        },
      },
    }));
  };

  const handleTypographyNumber = (role: keyof TypographyV2, prop: "size" | "lineHeight", min: number, max: number) => {
    return (fieldKey: string, raw: string, error: string | null, parsed: number | null) => {
      handleNumericDraftChange(fieldKey, raw, error, parsed, (validNumber) => {
        updateSpec((prev) => ({
          ...prev,
          typography: {
            ...prev.typography,
            [role]: {
              ...prev.typography[role],
              [prop]: validNumber,
            },
          },
        }));
      });
    };
  };

  // Token Sets handlers
  const handleTokenDefinitionChange = (
    setName: string,
    tokenId: string,
    kind: "raw" | "value" | "alias",
    newRawValue: string
  ) => {
    updateSpec((prev) => {
      const set = { ...prev.tokenSets[setName] };
      if (kind === "raw") {
        set[tokenId] = newRawValue;
      } else if (kind === "value") {
        set[tokenId] = { value: newRawValue };
      } else {
        set[tokenId] = { alias: newRawValue };
      }
      return {
        ...prev,
        tokenSets: {
          ...prev.tokenSets,
          [setName]: set,
        },
      };
    });
  };

  const handleAddToken = (setName: string) => {
    const newId = `token-${Date.now().toString(36)}`;
    updateSpec((prev) => {
      const set = { ...prev.tokenSets[setName] };
      set[newId] = "#000000";
      return {
        ...prev,
        tokenSets: {
          ...prev.tokenSets,
          [setName]: set,
        },
      };
    });
  };

  const handleDeleteToken = (setName: string, tokenId: string) => {
    updateSpec((prev) => {
      const set = { ...prev.tokenSets[setName] };
      delete set[tokenId];
      return {
        ...prev,
        tokenSets: {
          ...prev.tokenSets,
          [setName]: set,
        },
      };
    });
  };

  // Accent Variants handlers
  const handleVariantRoleChange = (
    variantKey: string,
    mode: "light" | "dark",
    role: ColorRole,
    tokenRef: string
  ) => {
    updateSpec((prev) => {
      const variant = prev.accentVariants[variantKey];
      if (!variant) return prev;
      return {
        ...prev,
        accentVariants: {
          ...prev.accentVariants,
          [variantKey]: {
            ...variant,
            [mode]: {
              ...variant[mode],
              [role]: tokenRef,
            },
          },
        },
      };
    });
  };

  const handleVariantTokenSetChange = (variantKey: string, tokenSet: string) => {
    updateSpec((prev) => {
      const variant = prev.accentVariants[variantKey];
      if (!variant) return prev;
      return {
        ...prev,
        accentVariants: {
          ...prev.accentVariants,
          [variantKey]: {
            ...variant,
            tokenSet,
          },
        },
      };
    });
  };

  // Code presentation handlers
  const isEcConfig = isCodePresentationConfig(specification.codePresentation);
  const ecConfig: CodePresentationConfig | null = isEcConfig
    ? (specification.codePresentation as CodePresentationConfig)
    : null;

  const handleCodeModeToggle = (enableConfig: boolean) => {
    if (enableConfig) {
      const defaultEc: CodePresentationConfig = {
        mode: "expressive-code",
        syntaxTheme: {
          light: {
            rules: [
              { scopes: ["keyword"], foreground: "#554582" },
              { scopes: ["string"], foreground: "#376876" },
              { scopes: ["comment"], foreground: "#536a5e" },
            ],
          },
          dark: {
            rules: [
              { scopes: ["keyword"], foreground: "#c2b4ec" },
              { scopes: ["string"], foreground: "#a0d3dc" },
              { scopes: ["comment"], foreground: "#a9c4b4" },
            ],
          },
        },
        frame: "plain",
        marks: {
          marked: "#818cf8",
          inserted: "#34d399",
          deleted: "#f87171",
        },
        copy: "standard",
        tabs: "deferred",
      };
      updateSpec((prev) => ({ ...prev, codePresentation: defaultEc }));
    } else {
      updateSpec((prev) => ({ ...prev, codePresentation: "consumer-default" }));
    }
  };

  const updateEc = (updater: (prev: CodePresentationConfig) => CodePresentationConfig) => {
    if (!ecConfig) return;
    const nextEc = updater(ecConfig);
    updateSpec((prev) => ({ ...prev, codePresentation: nextEc }));
  };

  const handleSyntaxRuleChange = (
    mode: "light" | "dark",
    index: number,
    field: keyof SyntaxRule,
    val: unknown
  ) => {
    updateEc((prev) => {
      const rules = [...prev.syntaxTheme[mode].rules];
      const updatedRule: SyntaxRule = {
        ...rules[index],
        [field]: val,
      } as SyntaxRule;
      rules[index] = updatedRule;
      return {
        ...prev,
        syntaxTheme: {
          ...prev.syntaxTheme,
          [mode]: { rules },
        },
      };
    });
  };

  const handleAddSyntaxRule = (mode: "light" | "dark") => {
    updateEc((prev) => {
      const rules = [
        ...prev.syntaxTheme[mode].rules,
        { scopes: ["variable"], foreground: "#888888" },
      ];
      return {
        ...prev,
        syntaxTheme: {
          ...prev.syntaxTheme,
          [mode]: { rules },
        },
      };
    });
  };

  const handleRemoveSyntaxRule = (mode: "light" | "dark", index: number) => {
    updateEc((prev) => {
      const rules = prev.syntaxTheme[mode].rules.filter((_, i) => i !== index);
      return {
        ...prev,
        syntaxTheme: {
          ...prev.syntaxTheme,
          [mode]: { rules },
        },
      };
    });
  };

  // Helper for mark color
  const getMarkColorString = (mark: MarkColor): string => {
    if (typeof mark === "string") return mark;
    return mark.light;
  };

  // Catalog handlers
  const hasCatalog = specification.catalog !== undefined;
  const catalog = specification.catalog;

  const handleToggleCatalog = (enable: boolean) => {
    if (enable) {
      const defaultCatalog: ThemeCatalogConfig = {
        layout: "standard",
        pageTitle: { copy: "none" },
        pagination: { variant: "plain" },
        sidebar: { mode: "nested", groupIds: ["default"] },
        hero: {
          routes: [
            {
              route: "/index",
              layout: "centered",
              title: "Welcome",
              actions: [{ label: "Get Started", href: "/guide" }],
            },
          ],
        },
        fontLicenses: [],
      };
      updateSpec((prev) => ({ ...prev, catalog: defaultCatalog }));
    } else {
      updateSpec((prev) => {
        const next = { ...prev };
        delete next.catalog;
        return next;
      });
    }
  };

  const updateCatalog = (updater: (prev: ThemeCatalogConfig) => ThemeCatalogConfig) => {
    if (!catalog) return;
    const nextCat = updater(catalog);
    updateSpec((prev) => ({ ...prev, catalog: nextCat }));
  };

  const updateHeroRoute = (rtIdx: number, updater: (prev: HeroRoute) => HeroRoute) => {
    updateCatalog((prev) => {
      const current = prev.hero.routes[rtIdx];
      if (!current) return prev;
      const routes = [...prev.hero.routes];
      routes[rtIdx] = updater(current);
      return { ...prev, hero: { routes } };
    });
  };

  // Font declarations handlers
  const handleAddFont = () => {
    const newFont: FontDeclarationV2 = {
      id: `font-${Date.now().toString(36)}`,
      family: "Custom Font",
      style: "normal",
      weight: 400,
      format: "woff2",
      sha256: "0".repeat(64),
      license: "OFL-1.1",
      notice: "custom-font-notice",
    };
    updateSpec((prev) => ({
      ...prev,
      fonts: [...prev.fonts, newFont],
    }));
  };

  const handleFontChange = (index: number, field: keyof FontDeclarationV2, val: unknown) => {
    updateSpec((prev) => {
      const fonts = [...prev.fonts];
      fonts[index] = {
        ...fonts[index],
        [field]: val,
      } as FontDeclarationV2;
      return { ...prev, fonts };
    });
  };

  const handleRemoveFont = (index: number) => {
    updateSpec((prev) => ({
      ...prev,
      fonts: prev.fonts.filter((_, i) => i !== index),
    }));
  };

  // Catalog font licenses handlers
  const handleAddFontLicense = () => {
    updateCatalog((prev) => ({
      ...prev,
      fontLicenses: [
        ...prev.fontLicenses,
        {
          id: `license-${Date.now().toString(36)}`,
          text: "Font license agreement text here",
          sha256: "0".repeat(64),
        },
      ],
    }));
  };

  const handleFontLicenseChange = (
    index: number,
    field: keyof CatalogFontLicense,
    val: string
  ) => {
    updateCatalog((prev) => {
      const fontLicenses = [...prev.fontLicenses];
      fontLicenses[index] = {
        ...fontLicenses[index],
        [field]: val,
      } as CatalogFontLicense;
      return { ...prev, fontLicenses };
    });
  };

  const handleRemoveFontLicense = (index: number) => {
    updateCatalog((prev) => ({
      ...prev,
      fontLicenses: prev.fontLicenses.filter((_, i) => i !== index),
    }));
  };

  const availableFontIds = [
    ...SYSTEM_FONT_IDS,
    ...specification.fonts.map((f) => f.id),
  ];

  const currentVariantData = specification.accentVariants[selectedVariant];

  return (
    <div className="theme-v2-controls" data-testid="theme-v2-controls">
      <style>{`
        .theme-v2-controls {
          display: flex;
          flex-direction: column;
          gap: 1rem;
          color: #f7f5ff;
          font-family: inherit;
        }
        .theme-v2-group {
          border: 1px solid #433567;
          border-radius: 0.75rem;
          background: #171128;
          padding: 0.75rem 1rem;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
        }
        .theme-v2-group summary {
          font-weight: 700;
          font-size: 1.05rem;
          color: #b8a9ff;
          cursor: pointer;
          padding: 0.25rem 0;
          outline-offset: 4px;
        }
        .theme-v2-group[open] summary {
          margin-bottom: 0.85rem;
          border-bottom: 1px solid #2e2348;
          padding-bottom: 0.5rem;
        }
        .theme-v2-field-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 0.75rem;
        }
        .theme-v2-field {
          display: flex;
          flex-direction: column;
          gap: 0.3rem;
        }
        .theme-v2-label {
          font-size: 0.8rem;
          font-weight: 600;
          color: #c9c1d7;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .theme-v2-input, .theme-v2-select, .theme-v2-textarea {
          padding: 0.45rem 0.65rem;
          border: 1px solid #6f5b91;
          border-radius: 0.4rem;
          background: #241a3a;
          color: #f7f5ff;
          font-size: 0.9rem;
        }
        .theme-v2-input:focus, .theme-v2-select:focus, .theme-v2-textarea:focus {
          outline: 2px solid #f6c65b;
        }
        .theme-v2-input-error {
          border-color: #f87171 !important;
          outline-color: #f87171 !important;
          background: #2a1520;
        }
        .theme-v2-error-text {
          font-size: 0.75rem;
          color: #fca5a5;
          font-weight: 600;
        }
        .theme-v2-btn {
          padding: 0.45rem 0.8rem;
          border: 1px solid #6f5b91;
          border-radius: 0.4rem;
          background: #241a3a;
          color: #f7f5ff;
          cursor: pointer;
          font-size: 0.85rem;
          font-weight: 600;
        }
        .theme-v2-btn:hover {
          background: #342654;
        }
        .theme-v2-btn-danger {
          border-color: #ef4444;
          color: #fca5a5;
        }
        .theme-v2-btn-primary {
          border-color: #f6c65b;
          color: #fff4c8;
          background: #3b285d;
        }
        .theme-v2-notice {
          padding: 0.75rem 1rem;
          border-left: 4px solid #f6c65b;
          background: #241c30;
          color: #fef08a;
          font-size: 0.85rem;
          border-radius: 0 0.4rem 0.4rem 0;
          margin-bottom: 0.75rem;
        }
        .theme-v2-role-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
          gap: 0.5rem;
        }
        .theme-v2-role-item {
          display: flex;
          flex-direction: column;
          gap: 0.2rem;
          padding: 0.4rem;
          border: 1px solid #3e3159;
          border-radius: 0.35rem;
          background: #1b142f;
        }
        .theme-v2-color-swatch {
          display: inline-block;
          width: 1.2rem;
          height: 1.2rem;
          border-radius: 0.25rem;
          border: 1px solid #ffffff44;
          vertical-align: middle;
        }
        .theme-v2-subcard {
          border: 1px solid #3e3159;
          border-radius: 0.5rem;
          padding: 0.65rem;
          background: #1e1634;
          margin-bottom: 0.65rem;
        }
        .theme-inspector-pre {
          background: #090814;
          color: #a5b4fc;
          padding: 1rem;
          border-radius: 0.5rem;
          overflow-x: auto;
          font-size: 0.8rem;
          max-height: 24rem;
        }
      `}</style>

      {/* 1. IDENTITY & CORE PRESETS */}
      <details open className="theme-v2-group" data-testid="group-identity">
        <summary>Theme Identity & Presets</summary>
        <div className="theme-v2-field-grid">
          <div className="theme-v2-field">
            <label htmlFor="theme-v2-name" className="theme-v2-label">
              Theme Name
            </label>
            <input
              id="theme-v2-name"
              aria-label="Theme Name"
              data-structural-field="name"
              type="text"
              className="theme-v2-input"
              value={specification.name}
              onChange={handleNameChange}
            />
          </div>

          <div className="theme-v2-field">
            <label htmlFor="theme-v2-version" className="theme-v2-label">
              Theme Version
            </label>
            <input
              id="theme-v2-version"
              aria-label="Theme Version"
              data-structural-field="version"
              type="text"
              className="theme-v2-input"
              value={specification.version}
              onChange={handleVersionChange}
            />
          </div>

          <div className="theme-v2-field">
            <label htmlFor="theme-v2-schema-version" className="theme-v2-label">
              Schema Version
            </label>
            <input
              id="theme-v2-schema-version"
              aria-label="Schema Version"
              type="text"
              className="theme-v2-input"
              value={specification.schemaVersion}
              readOnly
              disabled
            />
          </div>

          <div className="theme-v2-field">
            <label htmlFor="theme-v2-adapter" className="theme-v2-label">
              Adapter
            </label>
            <input
              id="theme-v2-adapter"
              aria-label="Adapter"
              type="text"
              className="theme-v2-input"
              value={specification.adapter}
              readOnly
              disabled
            />
          </div>

          <div className="theme-v2-field">
            <label htmlFor="theme-v2-layout-preset" className="theme-v2-label">
              Layout Preset
            </label>
            <select
              id="theme-v2-layout-preset"
              aria-label="Layout Preset"
              data-structural-field="layoutPreset"
              className="theme-v2-select"
              value={specification.layoutPreset}
              onChange={handleLayoutPresetChange}
            >
              <option value="standard">standard</option>
              <option value="compact">compact</option>
              <option value="wide">wide</option>
            </select>
          </div>

          <div className="theme-v2-field">
            <label htmlFor="theme-v2-page-title" className="theme-v2-label">
              Page Title Component
            </label>
            <select
              id="theme-v2-page-title"
              aria-label="Page Title Component"
              data-structural-field="components.pageTitle"
              className="theme-v2-select"
              value={specification.components?.pageTitle ?? "consumer-default"}
              onChange={handlePageTitleChange}
            >
              <option value="consumer-default">consumer-default</option>
              <option value="page-title-frame">page-title-frame</option>
            </select>
          </div>

          <div className="theme-v2-field">
            <label htmlFor="theme-v2-default-accent" className="theme-v2-label">
              Default Accent Variant
            </label>
            <select
              id="theme-v2-default-accent"
              aria-label="Default Accent Variant"
              data-structural-field="defaultAccent"
              className="theme-v2-select"
              value={specification.defaultAccent}
              onChange={handleDefaultAccentChange}
            >
              {Object.keys(specification.accentVariants).map((variantKey) => (
                <option key={variantKey} value={variantKey}>
                  {variantKey}
                </option>
              ))}
            </select>
          </div>
        </div>
      </details>

      {/* 2. TOKEN SETS */}
      <details open className="theme-v2-group" data-testid="group-token-sets">
        <summary>Token Sets</summary>
        <p style={{ fontSize: "0.85rem", color: "#bcb3ce", margin: "0 0 0.75rem" }}>
          Define token sets with hex strings, explicit value objects, or token alias references.
        </p>

        {Object.entries(specification.tokenSets).map(([setName, tokens]) => (
          <div key={setName} className="theme-v2-subcard" data-testid={`token-set-${setName}`}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
              <strong style={{ color: "#f6c65b" }}>{setName}</strong>
              <button
                type="button"
                className="theme-v2-btn"
                data-structural-field="tokenSets"
                onClick={() => handleAddToken(setName)}
                aria-label={`Add token to ${setName}`}
              >
                + Add Token
              </button>
            </div>

            <div style={{ display: "grid", gap: "0.5rem" }}>
              {Object.entries(tokens).map(([tokenId, tokenDef]) => {
                const isValObj = isTokenValueObject(tokenDef);
                const isAliasObj = isTokenAliasObject(tokenDef);
                const kind: "raw" | "value" | "alias" = isValObj ? "value" : isAliasObj ? "alias" : "raw";
                const currentVal = isValObj
                  ? tokenDef.value
                  : isAliasObj
                  ? tokenDef.alias
                  : (tokenDef as string);

                return (
                  <div
                    key={tokenId}
                    style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" }}
                  >
                    <span style={{ minWidth: "12rem", fontSize: "0.85rem", fontFamily: "monospace" }}>
                      {tokenId}
                    </span>

                    <select
                      aria-label={`Token ${tokenId} Kind`}
                      data-structural-field="tokenSets"
                      className="theme-v2-select"
                      value={kind}
                      onChange={(e) =>
                        handleTokenDefinitionChange(
                          setName,
                          tokenId,
                          e.target.value as "raw" | "value" | "alias",
                          currentVal
                        )
                      }
                    >
                      <option value="raw">Raw Hex</option>
                      <option value="value">Value Object</option>
                      <option value="alias">Alias Object</option>
                    </select>

                    <input
                      aria-label={`Token ${tokenId} Value`}
                      data-structural-field="tokenSets"
                      type="text"
                      className="theme-v2-input"
                      value={currentVal}
                      onChange={(e) =>
                        handleTokenDefinitionChange(setName, tokenId, kind, e.target.value)
                      }
                      style={{ flex: 1, minWidth: "8rem" }}
                    />

                    {kind !== "alias" && (
                      <span
                        className="theme-v2-color-swatch"
                        style={{ backgroundColor: currentVal }}
                        title={currentVal}
                      />
                    )}

                    <button
                      type="button"
                      className="theme-v2-btn theme-v2-btn-danger"
                      data-structural-field="tokenSets"
                      onClick={() => handleDeleteToken(setName, tokenId)}
                      aria-label={`Delete token ${tokenId}`}
                    >
                      Remove
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </details>

      {/* 3. ACCENT VARIANTS */}
      <details open className="theme-v2-group" data-testid="group-accent-variants">
        <summary>Accent Variants (22 Color Roles)</summary>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", marginBottom: "0.75rem" }}>
          <label htmlFor="theme-v2-variant-picker" className="theme-v2-label">
            Edit Variant:
          </label>
          <select
            id="theme-v2-variant-picker"
            aria-label="Active Accent Variant"
            data-structural-field="accentVariants"
            className="theme-v2-select"
            value={selectedVariant}
            onChange={(e) => setSelectedVariant(e.target.value)}
          >
            {Object.keys(specification.accentVariants).map((vKey) => (
              <option key={vKey} value={vKey}>
                {vKey} {specification.defaultAccent === vKey ? "(Default)" : ""}
              </option>
            ))}
          </select>
        </div>

        {currentVariantData && (
          <div className="theme-v2-subcard">
            <div style={{ marginBottom: "0.75rem" }}>
              <label htmlFor={`variant-${selectedVariant}-tokenset`} className="theme-v2-label">
                Bound Token Set:
              </label>
              <select
                id={`variant-${selectedVariant}-tokenset`}
                aria-label={`Variant ${selectedVariant} Token Set`}
                data-structural-field="accentVariants"
                className="theme-v2-select"
                value={currentVariantData.tokenSet}
                onChange={(e) => handleVariantTokenSetChange(selectedVariant, e.target.value)}
                style={{ marginLeft: "0.5rem" }}
              >
                {Object.keys(specification.tokenSets).map((setName) => (
                  <option key={setName} value={setName}>
                    {setName}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              {/* Light Mode 22 Roles */}
              <div>
                <h4 style={{ margin: "0 0 0.5rem", color: "#fef08a" }}>Light Mode (22 Roles)</h4>
                <div className="theme-v2-role-grid">
                  {COLOR_ROLES.map((role) => (
                    <div key={role} className="theme-v2-role-item">
                      <span style={{ fontSize: "0.75rem", color: "#bcb3ce" }}>{role}</span>
                      <input
                        aria-label={`Light ${role} Token`}
                        data-structural-field="accentVariants"
                        type="text"
                        className="theme-v2-input"
                        value={currentVariantData.light[role] ?? ""}
                        onChange={(e) =>
                          handleVariantRoleChange(selectedVariant, "light", role, e.target.value)
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Dark Mode 22 Roles */}
              <div>
                <h4 style={{ margin: "0 0 0.5rem", color: "#93c5fd" }}>Dark Mode (22 Roles)</h4>
                <div className="theme-v2-role-grid">
                  {COLOR_ROLES.map((role) => (
                    <div key={role} className="theme-v2-role-item">
                      <span style={{ fontSize: "0.75rem", color: "#bcb3ce" }}>{role}</span>
                      <input
                        aria-label={`Dark ${role} Token`}
                        data-structural-field="accentVariants"
                        type="text"
                        className="theme-v2-input"
                        value={currentVariantData.dark[role] ?? ""}
                        onChange={(e) =>
                          handleVariantRoleChange(selectedVariant, "dark", role, e.target.value)
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </details>

      {/* 4. TYPOGRAPHY */}
      <details open className="theme-v2-group" data-testid="group-typography">
        <summary>Typography (4 Roles & System Font IDs)</summary>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "1rem" }}>
          {(["body", "heading", "ui", "code"] as const).map((role) => {
            const roleData = specification.typography[role];
            const sizeKey = `typography.${role}.size`;
            const lhKey = `typography.${role}.lineHeight`;

            return (
              <div key={role} className="theme-v2-subcard">
                <h4 style={{ margin: "0 0 0.5rem", textTransform: "capitalize", color: "#f6c65b" }}>
                  {role} Role
                </h4>

                <div className="theme-v2-field" style={{ marginBottom: "0.5rem" }}>
                  <label htmlFor={`typo-${role}-font`} className="theme-v2-label">
                    {role} Font
                  </label>
                  <select
                    id={`typo-${role}-font`}
                    aria-label={`${role} Font`}
                    data-structural-field={role === "code" ? "typography.code.font" : `typography.${role}`}
                    className="theme-v2-select"
                    value={roleData.font}
                    onChange={(e) => handleTypographyFontChange(role, e)}
                  >
                    {availableFontIds.map((fId) => (
                      <option key={fId} value={fId}>
                        {fId}
                      </option>
                    ))}
                  </select>
                </div>

                <NumericInput
                  id={`typo-${role}-size`}
                  label={`${role} Font Size`}
                  fieldKey={sizeKey}
                  structuralField={role === "code" ? "typography.code.size" : `typography.${role}`}
                  value={roleData.size}
                  min={8}
                  max={96}
                  drafts={drafts}
                  errors={errors}
                  onDraftChange={handleTypographyNumber(role, "size", 8, 96)}
                />

                <NumericInput
                  id={`typo-${role}-lineheight`}
                  label={`${role} Line Height`}
                  fieldKey={lhKey}
                  structuralField={role === "code" ? "typography.code.lineHeight" : `typography.${role}`}
                  value={roleData.lineHeight}
                  min={1}
                  max={2.5}
                  step={0.05}
                  drafts={drafts}
                  errors={errors}
                  onDraftChange={handleTypographyNumber(role, "lineHeight", 1, 2.5)}
                />
              </div>
            );
          })}
        </div>
      </details>

      {/* 5. SURFACES */}
      <details open className="theme-v2-group" data-testid="group-surfaces">
        <summary>Surfaces (Layout, Spacing & Borders)</summary>
        <div className="theme-v2-field-grid">
          <NumericInput
            id="surface-spacing"
            label="Spacing"
            fieldKey="surfaces.spacing"
            value={specification.surfaces.spacing}
            min={0}
            max={32}
            drafts={drafts}
            errors={errors}
            onDraftChange={handleSurfaceNumber("spacing", 0, 32)}
          />

          <NumericInput
            id="surface-radii"
            label="Border Radius"
            fieldKey="surfaces.radii"
            value={specification.surfaces.radii}
            min={0}
            max={64}
            drafts={drafts}
            errors={errors}
            onDraftChange={handleSurfaceNumber("radii", 0, 64)}
          />

          <NumericInput
            id="surface-border"
            label="Border Width"
            fieldKey="surfaces.border"
            value={specification.surfaces.border}
            min={0}
            max={8}
            drafts={drafts}
            errors={errors}
            onDraftChange={handleSurfaceNumber("border", 0, 8)}
          />

          <NumericInput
            id="surface-focus"
            label="Focus Ring Width"
            fieldKey="surfaces.focus"
            value={specification.surfaces.focus}
            min={1}
            max={8}
            drafts={drafts}
            errors={errors}
            onDraftChange={handleSurfaceNumber("focus", 1, 8)}
          />

          <NumericInput
            id="surface-content"
            label="Content Max Width"
            fieldKey="surfaces.content"
            value={specification.surfaces.content}
            min={320}
            max={3840}
            drafts={drafts}
            errors={errors}
            onDraftChange={handleSurfaceNumber("content", 320, 3840)}
          />

          <NumericInput
            id="surface-sidebar"
            label="Sidebar Width"
            fieldKey="surfaces.sidebar"
            value={specification.surfaces.sidebar}
            min={120}
            max={960}
            drafts={drafts}
            errors={errors}
            onDraftChange={handleSurfaceNumber("sidebar", 120, 960)}
          />

          <div className="theme-v2-field">
            <label htmlFor="surface-border-style" className="theme-v2-label">
              Border Style
            </label>
            <select
              id="surface-border-style"
              aria-label="Border Style"
              data-structural-field="surfaces.borderStyle"
              className="theme-v2-select"
              value={specification.surfaces.borderStyle ?? "solid"}
              onChange={handleBorderStyleChange}
            >
              <option value="solid">solid</option>
              <option value="dashed">dashed</option>
              <option value="dotted">dotted</option>
            </select>
          </div>

          <NumericInput
            id="surface-focus-offset"
            label="Focus Offset"
            fieldKey="surfaces.focusOffset"
            value={specification.surfaces.focusOffset ?? 2}
            min={0}
            max={16}
            drafts={drafts}
            errors={errors}
            onDraftChange={handleSurfaceNumber("focusOffset", 0, 16)}
          />
        </div>
      </details>

      {/* 6. CODE PRESENTATION */}
      <details open className="theme-v2-group" data-testid="group-code-presentation">
        <summary>Code Presentation (Expressive Code)</summary>
        <div style={{ marginBottom: "0.75rem" }}>
          <label htmlFor="code-presentation-mode" className="theme-v2-label" style={{ marginRight: "0.5rem" }}>
            Presentation Mode:
          </label>
          <select
            id="code-presentation-mode"
            aria-label="Code Presentation Mode"
            data-structural-field="codePresentation.mode"
            className="theme-v2-select"
            value={isEcConfig ? "expressive-code" : "consumer-default"}
            onChange={(e) => handleCodeModeToggle(e.target.value === "expressive-code")}
          >
            <option value="consumer-default">consumer-default (Inherit)</option>
            <option value="expressive-code">expressive-code (Configured)</option>
          </select>
        </div>

        {ecConfig ? (
          <div className="theme-v2-subcard">
            <div className="theme-v2-field-grid" style={{ marginBottom: "0.75rem" }}>
              <div className="theme-v2-field">
                <label htmlFor="code-frame" className="theme-v2-label">
                  Code Frame
                </label>
                <select
                  id="code-frame"
                  aria-label="Code Frame"
                  data-structural-field="codePresentation.frame"
                  className="theme-v2-select"
                  value={ecConfig.frame}
                  onChange={(e) =>
                    updateEc((prev) => ({
                      ...prev,
                      frame: e.target.value as CodePresentationConfig["frame"],
                    }))
                  }
                >
                  <option value="plain">plain</option>
                  <option value="editor">editor</option>
                  <option value="terminal">terminal</option>
                </select>
              </div>

              <div className="theme-v2-field">
                <label htmlFor="code-copy" className="theme-v2-label">
                  Code Copy Button
                </label>
                <select
                  id="code-copy"
                  aria-label="Code Copy Button"
                  data-structural-field="codePresentation.copy"
                  className="theme-v2-select"
                  value={ecConfig.copy}
                  onChange={(e) =>
                    updateEc((prev) => ({
                      ...prev,
                      copy: e.target.value as CodePresentationConfig["copy"],
                    }))
                  }
                >
                  <option value="standard">standard</option>
                  <option value="minimal">minimal</option>
                </select>
              </div>

              <div className="theme-v2-field">
                <label htmlFor="code-tabs" className="theme-v2-label">
                  Code Tabs (Locked)
                </label>
                <input
                  id="code-tabs"
                  aria-label="Code Tabs"
                  data-structural-field="codePresentation.tabs"
                  type="text"
                  className="theme-v2-input"
                  value={ecConfig.tabs}
                  readOnly
                  disabled
                  title="Code tabs option is locked to deferred"
                />
              </div>
            </div>

            {/* Marks */}
            <div style={{ marginBottom: "0.75rem" }} data-structural-field="codePresentation.marks">
              <h5 style={{ margin: "0 0 0.4rem", color: "#f6c65b" }}>Code Marks</h5>
              <div className="theme-v2-field-grid">
                <div className="theme-v2-field">
                  <label htmlFor="code-mark-marked" className="theme-v2-label">
                    Marked Color
                  </label>
                  <input
                    id="code-mark-marked"
                    aria-label="Marked Color"
                    data-structural-field="codePresentation.marks"
                    type="text"
                    className="theme-v2-input"
                    value={getMarkColorString(ecConfig.marks.marked)}
                    onChange={(e) =>
                      updateEc((prev) => ({
                        ...prev,
                        marks: { ...prev.marks, marked: e.target.value },
                      }))
                    }
                  />
                </div>

                <div className="theme-v2-field">
                  <label htmlFor="code-mark-inserted" className="theme-v2-label">
                    Inserted Color
                  </label>
                  <input
                    id="code-mark-inserted"
                    aria-label="Inserted Color"
                    data-structural-field="codePresentation.marks"
                    type="text"
                    className="theme-v2-input"
                    value={getMarkColorString(ecConfig.marks.inserted)}
                    onChange={(e) =>
                      updateEc((prev) => ({
                        ...prev,
                        marks: { ...prev.marks, inserted: e.target.value },
                      }))
                    }
                  />
                </div>

                <div className="theme-v2-field">
                  <label htmlFor="code-mark-deleted" className="theme-v2-label">
                    Deleted Color
                  </label>
                  <input
                    id="code-mark-deleted"
                    aria-label="Deleted Color"
                    data-structural-field="codePresentation.marks"
                    type="text"
                    className="theme-v2-input"
                    value={getMarkColorString(ecConfig.marks.deleted)}
                    onChange={(e) =>
                      updateEc((prev) => ({
                        ...prev,
                        marks: { ...prev.marks, deleted: e.target.value },
                      }))
                    }
                  />
                </div>
              </div>
            </div>

            {/* Prominent Syntax Rules Limitation Notice */}
            <div
              role="note"
              style={{
                background: "#2a1e17",
                border: "1px solid #d97706",
                borderRadius: "0.375rem",
                padding: "0.6rem 0.8rem",
                marginBottom: "0.75rem",
                fontSize: "0.825rem",
                color: "#fef3c7",
                lineHeight: "1.4",
              }}
            >
              <strong>Notice:</strong> Edited syntax rules are NOT live-previewed in the
              preview or gallery frame. Expressive Code token contrast, scoping, and rule
              compilation require an installed consumer build.
            </div>

            {/* Syntax Rules */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }} data-structural-field="codePresentation.syntaxTheme">
              {(["light", "dark"] as const).map((mode) => (
                <div key={mode}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem" }}>
                    <h5 style={{ margin: 0, color: mode === "light" ? "#fef08a" : "#93c5fd", textTransform: "capitalize" }}>
                      {mode} Syntax Rules
                    </h5>
                    <button
                      type="button"
                      className="theme-v2-btn"
                      onClick={() => handleAddSyntaxRule(mode)}
                      aria-label={`Add ${mode} syntax rule`}
                    >
                      + Rule
                    </button>
                  </div>

                  <div style={{ display: "grid", gap: "0.4rem" }}>
                    {ecConfig.syntaxTheme[mode].rules.map((rule, rIdx) => (
                      <div
                        key={rIdx}
                        style={{
                          display: "flex",
                          gap: "0.4rem",
                          alignItems: "center",
                          border: "1px solid #3e3159",
                          borderRadius: "0.35rem",
                          padding: "0.4rem",
                          background: "#171026",
                        }}
                      >
                        <input
                          aria-label={`${mode} Rule ${rIdx} Scopes`}
                          data-structural-field="codePresentation.syntaxTheme"
                          type="text"
                          placeholder="scopes (comma-separated)"
                          className="theme-v2-input"
                          value={rule.scopes.join(", ")}
                          onChange={(e) =>
                            handleSyntaxRuleChange(
                              mode,
                              rIdx,
                              "scopes",
                              e.target.value.split(",").map((s) => s.trim()).filter(Boolean)
                            )
                          }
                          style={{ flex: 1 }}
                        />

                        <input
                          aria-label={`${mode} Rule ${rIdx} Foreground`}
                          data-structural-field="codePresentation.syntaxTheme"
                          type="text"
                          placeholder="#foreground"
                          className="theme-v2-input"
                          value={rule.foreground}
                          onChange={(e) =>
                            handleSyntaxRuleChange(mode, rIdx, "foreground", e.target.value)
                          }
                          style={{ width: "6.5rem" }}
                        />

                        <select
                          aria-label={`${mode} Rule ${rIdx} Font Style`}
                          data-structural-field="codePresentation.syntaxTheme"
                          className="theme-v2-select"
                          value={rule.fontStyle ?? "normal"}
                          onChange={(e) =>
                            handleSyntaxRuleChange(
                              mode,
                              rIdx,
                              "fontStyle",
                              e.target.value as CodeFontStyle
                            )
                          }
                        >
                          <option value="normal">normal</option>
                          <option value="italic">italic</option>
                          <option value="bold">bold</option>
                          <option value="underline">underline</option>
                        </select>

                        <button
                          type="button"
                          className="theme-v2-btn theme-v2-btn-danger"
                          onClick={() => handleRemoveSyntaxRule(mode, rIdx)}
                          aria-label={`Remove ${mode} rule ${rIdx}`}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p role="note" style={{ fontSize: "0.85rem", color: "#bcb3ce", margin: 0 }}>
            Code blocks currently use default consumer presentations. Expressive Code custom framing and styling are not represented in prebuilt catalog previews without an installed consumer build.
          </p>
        )}
      </details>

      {/* 7. CATALOG CONFIGURATION */}
      <details open className="theme-v2-group" data-testid="group-catalog">
        <summary>Catalog Configuration</summary>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
          <input
            id="theme-v2-catalog-toggle"
            type="checkbox"
            data-structural-field="catalog.enabled"
            checked={hasCatalog}
            onChange={(e) => handleToggleCatalog(e.target.checked)}
            aria-label="Enable Catalog Envelope"
          />
          <label htmlFor="theme-v2-catalog-toggle" className="theme-v2-label" style={{ cursor: "pointer" }}>
            Enable Catalog Envelope
          </label>
        </div>

        {hasCatalog && catalog && (
          <div className="theme-v2-subcard">
            <div className="theme-v2-field-grid" style={{ marginBottom: "0.75rem" }}>
              <div className="theme-v2-field">
                <label htmlFor="catalog-layout" className="theme-v2-label">
                  Catalog Layout (2 options)
                </label>
                <select
                  id="catalog-layout"
                  aria-label="Catalog Layout"
                  data-structural-field="catalog.layout"
                  className="theme-v2-select"
                  value={catalog.layout}
                  onChange={(e) =>
                    updateCatalog((prev) => ({
                      ...prev,
                      layout: e.target.value as ThemeCatalogConfig["layout"],
                    }))
                  }
                >
                  <option value="standard">standard</option>
                  <option value="compact">compact</option>
                </select>
              </div>

              <div className="theme-v2-field">
                <label htmlFor="catalog-page-title-copy" className="theme-v2-label">
                  Page Title Copy Mode (3 options)
                </label>
                <select
                  id="catalog-page-title-copy"
                  aria-label="Page Title Copy Mode"
                  data-structural-field="catalog.pageTitle.copy"
                  className="theme-v2-select"
                  value={catalog.pageTitle.copy}
                  onChange={(e) =>
                    updateCatalog((prev) => ({
                      ...prev,
                      pageTitle: {
                        copy: e.target.value as ThemeCatalogConfig["pageTitle"]["copy"],
                      },
                    }))
                  }
                >
                  <option value="none">none</option>
                  <option value="title">title</option>
                  <option value="url">url</option>
                </select>
              </div>

              <div className="theme-v2-field">
                <label htmlFor="catalog-pagination-variant" className="theme-v2-label">
                  Pagination Variant (3 options)
                </label>
                <select
                  id="catalog-pagination-variant"
                  aria-label="Pagination Variant"
                  data-structural-field="catalog.pagination.variant"
                  className="theme-v2-select"
                  value={catalog.pagination.variant}
                  onChange={(e) =>
                    updateCatalog((prev) => ({
                      ...prev,
                      pagination: {
                        variant: e.target.value as ThemeCatalogConfig["pagination"]["variant"],
                      },
                    }))
                  }
                >
                  <option value="plain">plain</option>
                  <option value="card">card</option>
                  <option value="compact">compact</option>
                </select>
              </div>

              <div className="theme-v2-field">
                <label htmlFor="catalog-sidebar-mode" className="theme-v2-label">
                  Sidebar Mode (4 options)
                </label>
                <select
                  id="catalog-sidebar-mode"
                  aria-label="Sidebar Mode"
                  data-structural-field="catalog.sidebar.mode"
                  className="theme-v2-select"
                  value={catalog.sidebar.mode}
                  onChange={(e) =>
                    updateCatalog((prev) => ({
                      ...prev,
                      sidebar: {
                        ...prev.sidebar,
                        mode: e.target.value as ThemeCatalogConfig["sidebar"]["mode"],
                      },
                    }))
                  }
                >
                  <option value="nested">nested</option>
                  <option value="tabs">tabs</option>
                  <option value="select">select</option>
                  <option value="active-only">active-only</option>
                </select>
              </div>

              <div className="theme-v2-field">
                <label htmlFor="catalog-sidebar-groups" className="theme-v2-label">
                  Sidebar Group IDs
                </label>
                <input
                  id="catalog-sidebar-groups"
                  aria-label="Sidebar Group IDs"
                  data-structural-field="catalog.sidebar.groupIds"
                  type="text"
                  className="theme-v2-input"
                  value={catalog.sidebar.groupIds.join(", ")}
                  onChange={(e) =>
                    updateCatalog((prev) => ({
                      ...prev,
                      sidebar: {
                        ...prev.sidebar,
                        groupIds: e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      },
                    }))
                  }
                />
              </div>
            </div>

            {/* Hero Routes (Hero5) */}
            <div style={{ marginBottom: "1rem" }} data-structural-field="catalog.hero.content">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                <h5 style={{ margin: 0, color: "#f6c65b" }}>Hero Routes (5 Layouts Supported)</h5>
                <button
                  type="button"
                  className="theme-v2-btn"
                  onClick={() => {
                    const newRoute: HeroRoute = {
                      route: `/page-${Date.now().toString(36)}`,
                      layout: "centered",
                      title: "Hero Title",
                      actions: [{ label: "Learn More", href: "/docs" }],
                      media: "loom-orbit",
                    };
                    updateCatalog((prev) => ({
                      ...prev,
                      hero: { routes: [...prev.hero.routes, newRoute] },
                    }));
                  }}
                  aria-label="Add Hero Route"
                >
                  + Add Route
                </button>
              </div>

              {catalog.hero.routes.map((route, rtIdx) => (
                <div key={rtIdx} className="theme-v2-subcard" data-structural-field="catalog.hero.content">
                  <div className="theme-v2-field-grid">
                    <div className="theme-v2-field">
                      <label htmlFor={`hero-route-${rtIdx}`} className="theme-v2-label">
                        Route Path
                      </label>
                      <input
                        id={`hero-route-${rtIdx}`}
                        aria-label="Hero Route"
                        data-structural-field="catalog.hero.content"
                        type="text"
                        className="theme-v2-input"
                        value={route.route}
                        onChange={(e) =>
                          updateHeroRoute(rtIdx, (prev) => ({ ...prev, route: e.target.value }))
                        }
                      />
                    </div>

                    <div className="theme-v2-field">
                      <label htmlFor={`hero-layout-${rtIdx}`} className="theme-v2-label">
                        Hero Layout (Hero5)
                      </label>
                      <select
                        id={`hero-layout-${rtIdx}`}
                        aria-label="Hero Layout"
                        data-structural-field="catalog.hero.layout"
                        className="theme-v2-select"
                        value={route.layout}
                        onChange={(e) =>
                          updateHeroRoute(rtIdx, (prev) => ({ ...prev, layout: e.target.value as HeroLayout }))
                        }
                      >
                        <option value="centered">centered</option>
                        <option value="media-top">media-top</option>
                        <option value="media-left">media-left</option>
                        <option value="media-right">media-right</option>
                        <option value="banner">banner</option>
                      </select>
                    </div>

                    <div className="theme-v2-field">
                      <label htmlFor={`hero-title-${rtIdx}`} className="theme-v2-label">
                        Title
                      </label>
                      <input
                        id={`hero-title-${rtIdx}`}
                        aria-label="Hero Title"
                        data-structural-field="catalog.hero.content"
                        type="text"
                        className="theme-v2-input"
                        value={route.title}
                        onChange={(e) =>
                          updateHeroRoute(rtIdx, (prev) => ({ ...prev, title: e.target.value }))
                        }
                      />
                    </div>

                    <div className="theme-v2-field">
                      <label htmlFor={`hero-subtitle-${rtIdx}`} className="theme-v2-label">
                        Subtitle
                      </label>
                      <input
                        id={`hero-subtitle-${rtIdx}`}
                        aria-label="Hero Subtitle"
                        data-structural-field="catalog.hero.content"
                        type="text"
                        className="theme-v2-input"
                        value={route.subtitle ?? ""}
                        onChange={(e) =>
                          updateHeroRoute(rtIdx, (prev) => ({ ...prev, subtitle: e.target.value || undefined }))
                        }
                      />
                    </div>

                    <div className="theme-v2-field">
                      <label htmlFor={`hero-announcement-${rtIdx}`} className="theme-v2-label">
                        Announcement
                      </label>
                      <input
                        id={`hero-announcement-${rtIdx}`}
                        aria-label="Hero Announcement"
                        data-structural-field="catalog.hero.content"
                        type="text"
                        className="theme-v2-input"
                        value={typeof route.announcement === "string" ? route.announcement : route.announcement?.text ?? ""}
                        onChange={(e) =>
                          updateHeroRoute(rtIdx, (prev) => ({ ...prev, announcement: e.target.value || undefined }))
                        }
                      />
                    </div>

                    <div className="theme-v2-field">
                      <label htmlFor={`hero-media-${rtIdx}`} className="theme-v2-label">
                        Media (Fixed Orbit)
                      </label>
                      <select
                        id={`hero-media-${rtIdx}`}
                        aria-label="Hero Media"
                        data-structural-field="catalog.hero.content"
                        className="theme-v2-select"
                        value={route.media ?? "none"}
                        onChange={(e) =>
                          updateHeroRoute(rtIdx, (prev) => ({
                            ...prev,
                            media: e.target.value === "loom-orbit" ? "loom-orbit" : undefined,
                          }))
                        }
                      >
                        <option value="none">none</option>
                        <option value="loom-orbit">loom-orbit</option>
                      </select>
                    </div>
                  </div>

                  <div className="theme-v2-field" style={{ marginTop: "0.5rem" }}>
                    <label htmlFor={`hero-summary-${rtIdx}`} className="theme-v2-label">
                      Summary
                    </label>
                    <textarea
                      id={`hero-summary-${rtIdx}`}
                      aria-label="Hero Summary"
                      data-structural-field="catalog.hero.content"
                      className="theme-v2-textarea"
                      rows={2}
                      value={route.summary ?? ""}
                      onChange={(e) =>
                        updateHeroRoute(rtIdx, (prev) => ({ ...prev, summary: e.target.value || undefined }))
                      }
                    />
                  </div>

                  {/* Actions */}
                  <div style={{ marginTop: "0.5rem" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.3rem" }}>
                      <span style={{ fontSize: "0.75rem", color: "#bcb3ce", fontWeight: 600 }}>
                        Actions ({route.actions.length})
                      </span>
                      <button
                        type="button"
                        className="theme-v2-btn"
                        onClick={() =>
                          updateHeroRoute(rtIdx, (prev) => ({
                            ...prev,
                            actions: [...prev.actions, { label: "Action", href: "/link" }],
                          }))
                        }
                        aria-label={`Add action to route ${route.route}`}
                      >
                        + Action
                      </button>
                    </div>

                    {route.actions.map((action, aIdx) => (
                      <div key={aIdx} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.3rem" }}>
                        <input
                          aria-label={`Hero Action Label ${aIdx}`}
                          data-structural-field="catalog.hero.content"
                          type="text"
                          className="theme-v2-input"
                          value={action.label}
                          placeholder="Label"
                          onChange={(e) =>
                            updateHeroRoute(rtIdx, (prev) => {
                              const actions = [...prev.actions];
                              actions[aIdx] = { ...actions[aIdx], label: e.target.value } as HeroAction;
                              return { ...prev, actions };
                            })
                          }
                          style={{ flex: 1 }}
                        />
                        <input
                          aria-label={`Hero Action Link ${aIdx}`}
                          data-structural-field="catalog.hero.content"
                          type="text"
                          className="theme-v2-input"
                          value={action.href}
                          placeholder="/href"
                          onChange={(e) =>
                            updateHeroRoute(rtIdx, (prev) => {
                              const actions = [...prev.actions];
                              actions[aIdx] = { ...actions[aIdx], href: e.target.value } as HeroAction;
                              return { ...prev, actions };
                            })
                          }
                          style={{ flex: 1 }}
                        />
                        <button
                          type="button"
                          className="theme-v2-btn theme-v2-btn-danger"
                          onClick={() =>
                            updateHeroRoute(rtIdx, (prev) => ({
                              ...prev,
                              actions: prev.actions.filter((_, i) => i !== aIdx),
                            }))
                          }
                          aria-label={`Remove action ${aIdx}`}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>

                  <div style={{ marginTop: "0.5rem", display: "flex", justifyContent: "flex-end" }}>
                    <button
                      type="button"
                      className="theme-v2-btn theme-v2-btn-danger"
                      onClick={() =>
                        updateCatalog((prev) => ({
                          ...prev,
                          hero: { routes: prev.hero.routes.filter((_, i) => i !== rtIdx) },
                        }))
                      }
                      aria-label={`Remove hero route ${route.route}`}
                    >
                      Remove Route
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Font Licenses */}
            <div style={{ marginBottom: "0.5rem" }} data-structural-field="catalog.fontLicenses">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem" }}>
                <h5 style={{ margin: 0, color: "#f6c65b" }}>Catalog Font Licenses ({catalog.fontLicenses.length})</h5>
                <button
                  type="button"
                  className="theme-v2-btn"
                  onClick={handleAddFontLicense}
                  aria-label="Add Font License"
                >
                  + Add License
                </button>
              </div>

              {catalog.fontLicenses.map((lic, lIdx) => (
                <div key={lIdx} className="theme-v2-subcard" data-structural-field="catalog.fontLicenses">
                  <div className="theme-v2-field-grid">
                    <div className="theme-v2-field">
                      <label htmlFor={`license-id-${lIdx}`} className="theme-v2-label">
                        License ID
                      </label>
                      <input
                        id={`license-id-${lIdx}`}
                        aria-label="License ID"
                        data-structural-field="catalog.fontLicenses"
                        type="text"
                        className="theme-v2-input"
                        value={lic.id}
                        onChange={(e) => handleFontLicenseChange(lIdx, "id", e.target.value)}
                      />
                    </div>
                    <div className="theme-v2-field">
                      <label htmlFor={`license-sha-${lIdx}`} className="theme-v2-label">
                        SHA256
                      </label>
                      <input
                        id={`license-sha-${lIdx}`}
                        aria-label="License SHA256"
                        data-structural-field="catalog.fontLicenses"
                        type="text"
                        className="theme-v2-input"
                        value={lic.sha256}
                        onChange={(e) => handleFontLicenseChange(lIdx, "sha256", e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="theme-v2-field" style={{ marginTop: "0.4rem" }}>
                    <label htmlFor={`license-text-${lIdx}`} className="theme-v2-label">
                      License Text
                    </label>
                    <textarea
                      id={`license-text-${lIdx}`}
                      aria-label="License Text"
                      data-structural-field="catalog.fontLicenses"
                      className="theme-v2-textarea"
                      rows={3}
                      value={lic.text}
                      onChange={(e) => handleFontLicenseChange(lIdx, "text", e.target.value)}
                    />
                  </div>

                  <div style={{ marginTop: "0.4rem", display: "flex", justifyContent: "flex-end" }}>
                    <button
                      type="button"
                      className="theme-v2-btn theme-v2-btn-danger"
                      onClick={() => handleRemoveFontLicense(lIdx)}
                      aria-label={`Remove license ${lic.id}`}
                    >
                      Remove License
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </details>

      {/* 8. FONTS & LICENSES */}
      <details open className="theme-v2-group" data-testid="group-fonts" data-structural-field="fonts">
        <summary>Font Declarations & Licenses (Logical Data)</summary>
        <div role="note" aria-label="Font Materialization Notice" className="theme-v2-notice">
          <strong>Notice:</strong> Font declarations and license text are preserved and editable as
          logical metadata only. Font file binary materialization and native file picker commands are
          unavailable in this visual editor.
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }} data-structural-field="fonts">
          <h5 style={{ margin: 0, color: "#f6c65b" }}>Declared Fonts ({specification.fonts.length})</h5>
          <button
            type="button"
            className="theme-v2-btn"
            onClick={handleAddFont}
            aria-label="Add Font Declaration"
          >
            + Add Font
          </button>
        </div>

        {specification.fonts.map((font, fIdx) => (
          <div key={font.id || fIdx} className="theme-v2-subcard" data-structural-field="fonts">
            <div className="theme-v2-field-grid">
              <div className="theme-v2-field">
                <label htmlFor={`font-id-${fIdx}`} className="theme-v2-label">
                  Font ID
                </label>
                <input
                  id={`font-id-${fIdx}`}
                  aria-label="Font ID"
                  data-structural-field="fonts"
                  type="text"
                  className="theme-v2-input"
                  value={font.id}
                  onChange={(e) => handleFontChange(fIdx, "id", e.target.value)}
                />
              </div>

              <div className="theme-v2-field">
                <label htmlFor={`font-family-${fIdx}`} className="theme-v2-label">
                  Font Family
                </label>
                <input
                  id={`font-family-${fIdx}`}
                  aria-label="Font Family"
                  data-structural-field="fonts"
                  type="text"
                  className="theme-v2-input"
                  value={font.family}
                  onChange={(e) => handleFontChange(fIdx, "family", e.target.value)}
                />
              </div>

              <div className="theme-v2-field">
                <label htmlFor={`font-style-${fIdx}`} className="theme-v2-label">
                  Font Style
                </label>
                <select
                  id={`font-style-${fIdx}`}
                  aria-label="Font Style"
                  data-structural-field="fonts"
                  className="theme-v2-select"
                  value={font.style}
                  onChange={(e) => handleFontChange(fIdx, "style", e.target.value as FontStyle)}
                >
                  <option value="normal">normal</option>
                  <option value="italic">italic</option>
                  <option value="oblique">oblique</option>
                </select>
              </div>

              <div className="theme-v2-field">
                <label htmlFor={`font-weight-${fIdx}`} className="theme-v2-label">
                  Font Weight
                </label>
                <input
                  id={`font-weight-${fIdx}`}
                  aria-label="Font Weight"
                  data-structural-field="fonts"
                  type="text"
                  className="theme-v2-input"
                  value={font.weight}
                  onChange={(e) => handleFontChange(fIdx, "weight", e.target.value)}
                />
              </div>

              <div className="theme-v2-field">
                <label htmlFor={`font-format-${fIdx}`} className="theme-v2-label">
                  Font Format
                </label>
                <select
                  id={`font-format-${fIdx}`}
                  aria-label="Font Format"
                  data-structural-field="fonts"
                  className="theme-v2-select"
                  value={font.format}
                  onChange={(e) => handleFontChange(fIdx, "format", e.target.value as FontFormat)}
                >
                  <option value="woff2">woff2</option>
                  <option value="woff">woff</option>
                </select>
              </div>

              <div className="theme-v2-field">
                <label htmlFor={`font-license-${fIdx}`} className="theme-v2-label">
                  Font License
                </label>
                <input
                  id={`font-license-${fIdx}`}
                  aria-label="Font License"
                  data-structural-field="fonts"
                  type="text"
                  className="theme-v2-input"
                  value={font.license}
                  onChange={(e) => handleFontChange(fIdx, "license", e.target.value)}
                />
              </div>

              <div className="theme-v2-field">
                <label htmlFor={`font-notice-${fIdx}`} className="theme-v2-label">
                  Font Notice
                </label>
                <input
                  id={`font-notice-${fIdx}`}
                  aria-label="Font Notice"
                  data-structural-field="fonts"
                  type="text"
                  className="theme-v2-input"
                  value={font.notice}
                  onChange={(e) => handleFontChange(fIdx, "notice", e.target.value)}
                />
              </div>
            </div>

            <div style={{ marginTop: "0.5rem", display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="theme-v2-btn theme-v2-btn-danger"
                onClick={() => handleRemoveFont(fIdx)}
                aria-label={`Remove font ${font.id}`}
              >
                Remove Font
              </button>
            </div>
          </div>
        ))}
      </details>

      {/* 9. SUPPLEMENTARY READ-ONLY INSPECTOR */}
      <details className="theme-v2-group" data-testid="group-inspector">
        <summary>Theme Specification Inspector (Read-only)</summary>
        <p style={{ fontSize: "0.85rem", color: "#bcb3ce", margin: "0 0 0.5rem" }}>
          Supplementary JSON view for live verification. Editing is performed through visual controls.
        </p>
        <pre aria-label="Theme Specification JSON" className="theme-inspector-pre">
          <code>{JSON.stringify(specification, null, 2)}</code>
        </pre>
      </details>
    </div>
  );
}

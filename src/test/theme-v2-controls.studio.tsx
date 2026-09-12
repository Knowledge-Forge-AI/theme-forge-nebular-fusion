import React, { useState } from "react";
import "../features/theme-lab/test/structural-inventory.test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeV2Controls } from "../features/theme-lab/ThemeV2Controls";
import {
  SAMPLE_THEME_V2,
  COLOR_ROLES,
  type ThemeSpecificationV2,
  isCodePresentationConfig,
} from "../features/theme-lab/v2-model";

function getLastCall(spy: ReturnType<typeof vi.fn>): ThemeSpecificationV2 {
  const calls = spy.mock.calls;
  if (!calls.length) throw new Error("No calls recorded");
  const call = calls[calls.length - 1];
  if (!call) throw new Error("Missing call");
  return call[0] as ThemeSpecificationV2;
}

function ControlledThemeV2Controls(props: {
  initialSpec?: ThemeSpecificationV2 | undefined;
  onChangeSpy?: ((spec: ThemeSpecificationV2) => void) | undefined;
  onValiditySpy?: ((isValid: boolean) => void) | undefined;
}) {
  const [spec, setSpec] = useState<ThemeSpecificationV2>(
    props.initialSpec ?? SAMPLE_THEME_V2
  );

  return (
    <ThemeV2Controls
      specification={spec}
      onChange={(updated) => {
        setSpec(updated);
        props.onChangeSpy?.(updated);
      }}
      onValidityChange={props.onValiditySpy}
    />
  );
}

describe("ThemeV2Controls Component", () => {
  it("renders all visual control groups and supplementary read-only inspector", () => {
    render(<ControlledThemeV2Controls />);

    expect(screen.getByTestId("group-identity")).toBeTruthy();
    expect(screen.getByTestId("group-token-sets")).toBeTruthy();
    expect(screen.getByTestId("group-accent-variants")).toBeTruthy();
    expect(screen.getByTestId("group-typography")).toBeTruthy();
    expect(screen.getByTestId("group-surfaces")).toBeTruthy();
    expect(screen.getByTestId("group-code-presentation")).toBeTruthy();
    expect(screen.getByTestId("group-catalog")).toBeTruthy();
    expect(screen.getByTestId("group-fonts")).toBeTruthy();
    expect(screen.getByTestId("group-inspector")).toBeTruthy();

    // Supplementary inspector shows valid JSON
    const pre = screen.getByLabelText("Theme Specification JSON");
    expect(pre.textContent).toContain("loom-celestia-code");
    expect(pre.textContent).toContain("tfsl.theme-v2");
  });

  it("updates theme name and version while preserving the rest of the specification", () => {
    const onChangeSpy = vi.fn();
    render(<ControlledThemeV2Controls onChangeSpy={onChangeSpy} />);

    const nameInput = screen.getByLabelText("Theme Name");
    fireEvent.change(nameInput, { target: { value: "my-custom-theme" } });

    expect(onChangeSpy).toHaveBeenCalled();
    const lastCall = getLastCall(onChangeSpy);
    expect(lastCall.name).toBe("my-custom-theme");
    expect(lastCall.version).toBe("1.0.0");
    expect(lastCall.adapter).toBe("starlight-v0.42");
    expect(lastCall.schemaVersion).toBe("tfsl.theme-v2");

    const versionInput = screen.getByLabelText("Theme Version");
    fireEvent.change(versionInput, { target: { value: "2.1.0" } });

    const updatedCall = getLastCall(onChangeSpy);
    expect(updatedCall.name).toBe("my-custom-theme");
    expect(updatedCall.version).toBe("2.1.0");
  });

  it("updates layoutPreset (3 core layouts) and pageTitle component", () => {
    const onChangeSpy = vi.fn();
    render(<ControlledThemeV2Controls onChangeSpy={onChangeSpy} />);

    const layoutSelect = screen.getByLabelText("Layout Preset");
    fireEvent.change(layoutSelect, { target: { value: "wide" } });

    expect(onChangeSpy).toHaveBeenCalled();
    let lastSpec = getLastCall(onChangeSpy);
    expect(lastSpec.layoutPreset).toBe("wide");

    const pageTitleSelect = screen.getByLabelText("Page Title Component");
    fireEvent.change(pageTitleSelect, { target: { value: "page-title-frame" } });

    lastSpec = getLastCall(onChangeSpy);
    expect(lastSpec.components.pageTitle).toBe("page-title-frame");
  });

  it("preserves unknown / extra top-level fields losslessly upon editing", () => {
    const onChangeSpy = vi.fn();
    const specWithCustomField: ThemeSpecificationV2 = {
      ...SAMPLE_THEME_V2,
      _customVendorMetadata: { id: "nebular-prime", flags: [1, 2, 3] },
    };

    render(
      <ControlledThemeV2Controls
        initialSpec={specWithCustomField}
        onChangeSpy={onChangeSpy}
      />
    );

    const nameInput = screen.getByLabelText("Theme Name");
    fireEvent.change(nameInput, { target: { value: "renamed-spec" } });

    expect(onChangeSpy).toHaveBeenCalled();
    const result = getLastCall(onChangeSpy);
    expect(result.name).toBe("renamed-spec");
    expect(result["_customVendorMetadata"]).toEqual({
      id: "nebular-prime",
      flags: [1, 2, 3],
    });
  });

  it("handles invalid numeric drafts in local state, triggers onValidityChange(false), retains prior spec", () => {
    const onChangeSpy = vi.fn();
    const onValiditySpy = vi.fn();

    render(
      <ControlledThemeV2Controls
        onChangeSpy={onChangeSpy}
        onValiditySpy={onValiditySpy}
      />
    );

    // Initial valid state notification
    expect(onValiditySpy).toHaveBeenCalledWith(true);

    const spacingInput = screen.getByLabelText("Spacing") as HTMLInputElement;
    expect(spacingInput.value).toBe("4");

    onChangeSpy.mockClear();
    onValiditySpy.mockClear();

    // Type invalid non-numeric string
    fireEvent.change(spacingInput, { target: { value: "not-a-number" } });

    // 1. Input retains the invalid draft string
    expect(spacingInput.value).toBe("not-a-number");
    expect(spacingInput.getAttribute("aria-invalid")).toBe("true");

    // 2. Inline error is displayed with role="alert"
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Must be a valid finite number");

    // 3. onValidityChange was called with false
    expect(onValiditySpy).toHaveBeenCalledWith(false);

    // 4. onChange was NOT called with the invalid value (prior spec retained)
    expect(onChangeSpy).not.toHaveBeenCalled();

    // Now type a valid finite number
    fireEvent.change(spacingInput, { target: { value: "12" } });

    // 5. Input value updated, error cleared, onValidityChange called with true
    expect(spacingInput.value).toBe("12");
    expect(spacingInput.getAttribute("aria-invalid")).toBe("false");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onValiditySpy).toHaveBeenCalledWith(true);

    // 6. onChange was called with numeric value 12
    expect(onChangeSpy).toHaveBeenCalled();
    const updatedSpec = getLastCall(onChangeSpy);
    expect(updatedSpec.surfaces.spacing).toBe(12);
  });

  it("handles out-of-bounds numeric inputs with validation errors", () => {
    const onChangeSpy = vi.fn();
    const onValiditySpy = vi.fn();

    render(
      <ControlledThemeV2Controls
        onChangeSpy={onChangeSpy}
        onValiditySpy={onValiditySpy}
      />
    );

    const borderInput = screen.getByLabelText("Border Width");
    // Max border is 8
    fireEvent.change(borderInput, { target: { value: "99" } });

    expect(screen.getByRole("alert").textContent).toContain("Must be at most 8");
    expect(onValiditySpy).toHaveBeenCalledWith(false);
    expect(onChangeSpy).not.toHaveBeenCalled();

    // Fix to valid 3
    fireEvent.change(borderInput, { target: { value: "3" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onValiditySpy).toHaveBeenCalledWith(true);
    expect(onChangeSpy).toHaveBeenCalled();
  });

  it("collapsed groups preserve data and user input without reset", () => {
    const onChangeSpy = vi.fn();
    render(<ControlledThemeV2Controls onChangeSpy={onChangeSpy} />);

    const surfacesDetails = screen.getByTestId("group-surfaces") as HTMLDetailsElement;
    expect(surfacesDetails.open).toBe(true);

    // Toggle collapse
    fireEvent.click(screen.getByText("Surfaces (Layout, Spacing & Borders)"));

    // Edit identity while surfaces is collapsed
    const nameInput = screen.getByLabelText("Theme Name");
    fireEvent.change(nameInput, { target: { value: "collapsed-test" } });

    expect(onChangeSpy).toHaveBeenCalled();
    const result = getLastCall(onChangeSpy);
    expect(result.name).toBe("collapsed-test");
    // Surfaces data remains completely intact
    expect(result.surfaces.content).toBe(960);
    expect(result.surfaces.sidebar).toBe(240);
    expect(result.surfaces.spacing).toBe(4);
  });

  it("edits token sets: supports raw hex strings, value objects, and alias objects", () => {
    const onChangeSpy = vi.fn();
    render(<ControlledThemeV2Controls onChangeSpy={onChangeSpy} />);

    // 1. Edit raw hex token
    const tokenInput = screen.getByLabelText("Token space-page-dark Value");
    fireEvent.change(tokenInput, { target: { value: "#112233" } });

    expect(onChangeSpy).toHaveBeenCalled();
    let spec = getLastCall(onChangeSpy);
    const tokens = spec.tokenSets["celestia-tokens"];
    expect(tokens).toBeDefined();
    expect(tokens!["space-page-dark"]).toBe("#112233");

    // 2. Change kind to Value Object
    const kindSelect = screen.getByLabelText("Token space-page-dark Kind");
    fireEvent.change(kindSelect, { target: { value: "value" } });

    spec = getLastCall(onChangeSpy);
    expect(spec.tokenSets["celestia-tokens"]!["space-page-dark"]).toEqual({
      value: "#112233",
    });

    // 3. Change kind to Alias Object
    fireEvent.change(kindSelect, { target: { value: "alias" } });
    const aliasInput = screen.getByLabelText("Token space-page-dark Value");
    fireEvent.change(aliasInput, { target: { value: "space-nav-dark" } });

    spec = getLastCall(onChangeSpy);
    expect(spec.tokenSets["celestia-tokens"]!["space-page-dark"]).toEqual({
      alias: "space-nav-dark",
    });

    // 4. Add token to set
    const addTokenBtn = screen.getByLabelText("Add token to celestia-tokens");
    fireEvent.click(addTokenBtn);

    spec = getLastCall(onChangeSpy);
    const setTokens = spec.tokenSets["celestia-tokens"]!;
    const tokenKeys = Object.keys(setTokens);
    const sampleTokens = SAMPLE_THEME_V2.tokenSets["celestia-tokens"]!;
    expect(tokenKeys.length).toBeGreaterThan(Object.keys(sampleTokens).length);

    // 5. Remove a token
    const removeBtn = screen.getByLabelText("Delete token space-card-dark");
    fireEvent.click(removeBtn);

    spec = getLastCall(onChangeSpy);
    expect(spec.tokenSets["celestia-tokens"]!["space-card-dark"]).toBeUndefined();
  });

  it("exposes all 22 accent color roles for light and dark modes and allows editing", () => {
    const onChangeSpy = vi.fn();
    render(<ControlledThemeV2Controls onChangeSpy={onChangeSpy} />);

    // Verify all 22 roles exist in DOM for light and dark
    expect(COLOR_ROLES.length).toBe(22);
    for (const role of COLOR_ROLES) {
      expect(screen.getByLabelText(`Light ${role} Token`)).toBeTruthy();
      expect(screen.getByLabelText(`Dark ${role} Token`)).toBeTruthy();
    }

    // Edit light accent-base
    const lightAccentInput = screen.getByLabelText("Light accent-base Token");
    fireEvent.change(lightAccentInput, { target: { value: "stellar-accent-custom" } });

    expect(onChangeSpy).toHaveBeenCalled();
    const updated = getLastCall(onChangeSpy);
    const defaultVariant = updated.accentVariants["default"];
    expect(defaultVariant).toBeDefined();
    expect(defaultVariant!.light["accent-base"]).toBe("stellar-accent-custom");
  });

  it("edits typography 4 roles with system font IDs and numeric size/lineHeight", () => {
    const onChangeSpy = vi.fn();
    render(<ControlledThemeV2Controls onChangeSpy={onChangeSpy} />);

    // 4 roles: body, heading, ui, code
    for (const role of ["body", "heading", "ui", "code"] as const) {
      expect(screen.getByLabelText(`${role} Font`)).toBeTruthy();
      expect(screen.getByLabelText(`${role} Font Size`)).toBeTruthy();
      expect(screen.getByLabelText(`${role} Line Height`)).toBeTruthy();
    }

    // Change body font to system-serif
    const bodyFontSelect = screen.getByLabelText("body Font");
    fireEvent.change(bodyFontSelect, { target: { value: "system-serif" } });

    expect(onChangeSpy).toHaveBeenCalled();
    let spec = getLastCall(onChangeSpy);
    expect(spec.typography.body.font).toBe("system-serif");

    // Change body font size to 18
    const bodySizeInput = screen.getByLabelText("body Font Size");
    fireEvent.change(bodySizeInput, { target: { value: "18" } });

    spec = getLastCall(onChangeSpy);
    expect(spec.typography.body.size).toBe(18);

    // Change body line height to 1.75
    const bodyLhInput = screen.getByLabelText("body Line Height");
    fireEvent.change(bodyLhInput, { target: { value: "1.75" } });

    spec = getLastCall(onChangeSpy);
    expect(spec.typography.body.lineHeight).toBe(1.75);
  });

  it("edits surfaces properties (borderStyle, radii, content, sidebar)", () => {
    const onChangeSpy = vi.fn();
    render(<ControlledThemeV2Controls onChangeSpy={onChangeSpy} />);

    // Border style
    const borderStyleSelect = screen.getByLabelText("Border Style");
    fireEvent.change(borderStyleSelect, { target: { value: "dashed" } });

    let spec = getLastCall(onChangeSpy);
    expect(spec.surfaces.borderStyle).toBe("dashed");

    // Content max width
    const contentInput = screen.getByLabelText("Content Max Width");
    fireEvent.change(contentInput, { target: { value: "1280" } });

    spec = getLastCall(onChangeSpy);
    expect(spec.surfaces.content).toBe(1280);

    // Sidebar width
    const sidebarInput = screen.getByLabelText("Sidebar Width");
    fireEvent.change(sidebarInput, { target: { value: "280" } });

    spec = getLastCall(onChangeSpy);
    expect(spec.surfaces.sidebar).toBe(280);
  });

  it("handles code presentation switching, frame, locked tabs, marks, and syntax rules", () => {
    const onChangeSpy = vi.fn();
    render(<ControlledThemeV2Controls onChangeSpy={onChangeSpy} />);

    expect(screen.getAllByRole("note").some(node => node.textContent?.includes("NOT live-previewed"))).toBe(true);

    // In SAMPLE_THEME_V2, expressive-code is configured
    const modeSelect = screen.getByLabelText("Code Presentation Mode") as HTMLSelectElement;
    expect(modeSelect.value).toBe("expressive-code");

    // Tabs is locked to deferred
    const tabsInput = screen.getByLabelText("Code Tabs") as HTMLInputElement;
    expect(tabsInput.disabled).toBe(true);
    expect(tabsInput.value).toBe("deferred");

    // Frame change
    const frameSelect = screen.getByLabelText("Code Frame");
    fireEvent.change(frameSelect, { target: { value: "terminal" } });

    let spec = getLastCall(onChangeSpy);
    expect(isCodePresentationConfig(spec.codePresentation)).toBe(true);
    if (isCodePresentationConfig(spec.codePresentation)) {
      expect(spec.codePresentation.frame).toBe("terminal");
    }

    // Copy change
    const copySelect = screen.getByLabelText("Code Copy Button");
    fireEvent.change(copySelect, { target: { value: "standard" } });

    spec = getLastCall(onChangeSpy);
    if (isCodePresentationConfig(spec.codePresentation)) {
      expect(spec.codePresentation.copy).toBe("standard");
    }

    // Marks color change
    const markedColor = screen.getByLabelText("Marked Color");
    fireEvent.change(markedColor, { target: { value: "#10b981" } });

    spec = getLastCall(onChangeSpy);
    if (isCodePresentationConfig(spec.codePresentation)) {
      expect(spec.codePresentation.marks.marked).toBe("#10b981");
    }

    // Add syntax rule
    const addRuleBtn = screen.getByLabelText("Add light syntax rule");
    fireEvent.click(addRuleBtn);

    spec = getLastCall(onChangeSpy);
    if (isCodePresentationConfig(spec.codePresentation)) {
      const lightRules = spec.codePresentation.syntaxTheme.light.rules;
      expect(lightRules[lightRules.length - 1]!.scopes).toContain("variable");
    }

    // Switch to consumer-default
    fireEvent.change(modeSelect, { target: { value: "consumer-default" } });

    spec = getLastCall(onChangeSpy);
    expect(spec.codePresentation).toBe("consumer-default");
  });

  it("handles catalog layout, title copy, pagination and sidebar groups", () => {
    const onChangeSpy = vi.fn();
    render(<ControlledThemeV2Controls onChangeSpy={onChangeSpy} />);

    // Enable catalog
    const catalogToggle = screen.getByLabelText("Enable Catalog Envelope");
    fireEvent.click(catalogToggle);

    expect(onChangeSpy).toHaveBeenCalled();
    let spec = getLastCall(onChangeSpy);
    expect(spec.catalog).toBeDefined();
    expect(spec.catalog?.layout).toBe("standard");

    // Catalog Layout (2 options: standard, compact)
    const layoutSelect = screen.getByLabelText("Catalog Layout");
    fireEvent.change(layoutSelect, { target: { value: "compact" } });
    spec = getLastCall(onChangeSpy);
    expect(spec.catalog?.layout).toBe("compact");

    // Page Title Copy (3 options: none, title, url)
    const titleCopySelect = screen.getByLabelText("Page Title Copy Mode");
    fireEvent.change(titleCopySelect, { target: { value: "url" } });
    spec = getLastCall(onChangeSpy);
    expect(spec.catalog?.pageTitle.copy).toBe("url");

    // Pagination variant (3 options: plain, card, compact)
    const pagSelect = screen.getByLabelText("Pagination Variant");
    fireEvent.change(pagSelect, { target: { value: "card" } });
    spec = getLastCall(onChangeSpy);
    expect(spec.catalog?.pagination.variant).toBe("card");

    // Sidebar mode (4 options: nested, tabs, select, active-only)
    const sidebarModeSelect = screen.getByLabelText("Sidebar Mode");
    fireEvent.change(sidebarModeSelect, { target: { value: "tabs" } });
    spec = getLastCall(onChangeSpy);
    expect(spec.catalog?.sidebar.mode).toBe("tabs");

    // Sidebar group IDs
    const sidebarGroupsInput = screen.getByLabelText("Sidebar Group IDs");
    fireEvent.change(sidebarGroupsInput, { target: { value: "core, heroes, width" } });
    spec = getLastCall(onChangeSpy);
    expect(spec.catalog?.sidebar.groupIds).toEqual(["core", "heroes", "width"]);

  });

  it("handles catalog Hero layout, media and font licenses", () => {
    const onChangeSpy = vi.fn();
    render(<ControlledThemeV2Controls onChangeSpy={onChangeSpy} />);
    fireEvent.click(screen.getByLabelText("Enable Catalog Envelope"));
    let spec = getLastCall(onChangeSpy);

    // Hero route layout (Hero5: centered, media-top, media-left, media-right, banner)
    const heroLayoutSelect = screen.getByLabelText("Hero Layout");
    fireEvent.change(heroLayoutSelect, { target: { value: "media-right" } });
    spec = getLastCall(onChangeSpy);
    expect(spec.catalog?.hero.routes[0]!.layout).toBe("media-right");

    // Hero media (fixed loom-orbit)
    const heroMediaSelect = screen.getByLabelText("Hero Media");
    fireEvent.change(heroMediaSelect, { target: { value: "loom-orbit" } });
    spec = getLastCall(onChangeSpy);
    expect(spec.catalog?.hero.routes[0]!.media).toBe("loom-orbit");

    // Add font license
    const addLicenseBtn = screen.getByLabelText("Add Font License");
    fireEvent.click(addLicenseBtn);
    spec = getLastCall(onChangeSpy);
    expect(spec.catalog?.fontLicenses.length).toBe(1);
  });

  it("displays unavailable font materialization notice, provides no picker command, preserves editable logical font declarations", () => {
    const onChangeSpy = vi.fn();
    render(<ControlledThemeV2Controls onChangeSpy={onChangeSpy} />);

    // Check notice banner
    const notice = screen.getByLabelText("Font Materialization Notice");
    expect(notice.textContent).toContain("logical metadata only");
    expect(notice.textContent).toContain("file picker commands are unavailable");

    // Ensure NO picker button exists
    expect(screen.queryByRole("button", { name: /pick|browse|upload/i })).toBeNull();

    // Add font declaration
    const addFontBtn = screen.getByLabelText("Add Font Declaration");
    fireEvent.click(addFontBtn);

    expect(onChangeSpy).toHaveBeenCalled();
    let spec = getLastCall(onChangeSpy);
    expect(spec.fonts.length).toBe(1);
    expect(spec.fonts[0]!.family).toBe("Custom Font");

    // Edit font family
    const familyInput = screen.getByLabelText("Font Family");
    fireEvent.change(familyInput, { target: { value: "Geist Mono" } });

    spec = getLastCall(onChangeSpy);
    expect(spec.fonts[0]!.family).toBe("Geist Mono");

    // Remove font declaration
    const removeBtn = screen.getByLabelText(`Remove font ${spec.fonts[0]!.id}`);
    fireEvent.click(removeBtn);

    spec = getLastCall(onChangeSpy);
    expect(spec.fonts.length).toBe(0);
  });
});

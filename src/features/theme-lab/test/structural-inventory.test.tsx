import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import React from "react";
import {
  STRUCTURAL_FIELD_CLASSIFICATIONS,
  STRUCTURAL_FIELD_INVENTORY,
  EDITABLE_STRUCTURAL_FIELDS,
  EDITABLE_FIELD_IDS,
  EDITABLE_STRUCTURAL_FIELD_IDS,
  getNonLiveDisclosures,
  validateStructuralFieldInventory,
  validateControlsAuthorityParity,
  type StructuralFieldDefinition,
} from "../structural-inventory";
import {
  GALLERY_COVERAGE,
  GALLERY_SCENARIO_IDS,
  validateGalleryAuthority,
} from "../gallery-contract";
import { ThemeV2Controls } from "../ThemeV2Controls";
import { SAMPLE_THEME_V2, type ThemeSpecificationV2 } from "../v2-model";

describe("TFSB65 Structural Inventory & Editor/Gallery Exhaustiveness", () => {
  // -------------------------------------------------------------------------
  // 1. Inventory Authority & Invariants
  // -------------------------------------------------------------------------
  describe("Structural Field Inventory Invariants", () => {
    it("validates that canonical inventory is exhaustive and error-free", () => {
      const result = validateStructuralFieldInventory(STRUCTURAL_FIELD_INVENTORY);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.totalFields).toBe(37);
      expect(result.axisFieldsCount).toBe(7);
      expect(result.cssCarriedCount).toBe(17);
      expect(result.notLiveCount).toBe(13);
      expect(result.axisFieldsCount + result.cssCarriedCount + result.notLiveCount).toBe(result.totalFields);
    });

    it("ensures every field has exactly one classification belonging to the canonical 3", () => {
      for (const field of STRUCTURAL_FIELD_INVENTORY) {
        expect(STRUCTURAL_FIELD_CLASSIFICATIONS).toContain(field.classification);
        expect(typeof field.id).toBe("string");
        expect(field.id.trim()).not.toBe("");
        expect(typeof field.label).toBe("string");
        expect(typeof field.specPath).toBe("string");
      }
    });

    it("ensures structural axes define finite representative discrete values", () => {
      const axes = STRUCTURAL_FIELD_INVENTORY.filter(
        (f) => f.classification === "finite representative structural axis"
      );
      expect(axes.length).toBe(7);
      for (const axis of axes) {
        expect(axis.axisKey).toBeDefined();
        expect(Array.isArray(axis.values)).toBe(true);
        expect(axis.values!.length).toBeGreaterThan(0);
      }
    });

    it("ensures CSS-carried fields specify exact CSS carrying mechanisms", () => {
      const cssFields = STRUCTURAL_FIELD_INVENTORY.filter(
        (f) => f.classification === "CSS-carried exact field"
      );
      expect(cssFields.length).toBe(17);
      for (const f of cssFields) {
        expect(typeof f.cssMechanism).toBe("string");
        expect(f.cssMechanism!.length).toBeGreaterThan(5);
      }
    });

    it("ensures explicitly not live-previewed fields specify honest disclosures and notices", () => {
      const nonLiveFields = STRUCTURAL_FIELD_INVENTORY.filter(
        (f) => f.classification === "explicitly not live-previewed"
      );
      expect(nonLiveFields.length).toBe(13);
      for (const f of nonLiveFields) {
        expect(typeof f.disclosure).toBe("string");
        expect(f.disclosure!.length).toBeGreaterThan(10);
        expect(typeof f.notice).toBe("string");
        expect(f.notice!.trim()).not.toBe("");
      }
    });

    it("ensures EDITABLE_FIELD_IDS and EDITABLE_STRUCTURAL_FIELD_IDS are frozen and consistent", () => {
      expect(Object.isFrozen(EDITABLE_FIELD_IDS)).toBe(true);
      expect(Object.isFrozen(EDITABLE_STRUCTURAL_FIELD_IDS)).toBe(true);
      expect(EDITABLE_FIELD_IDS.length).toBe(37);
      expect(EDITABLE_STRUCTURAL_FIELD_IDS.length).toBe(28);
      expect(EDITABLE_FIELD_IDS).toContain("layoutPreset");
      expect(EDITABLE_FIELD_IDS).toContain("catalog.sidebar.mode");
      expect(EDITABLE_FIELD_IDS).toContain("codePresentation.marks");
      expect(EDITABLE_FIELD_IDS).toContain("fonts");
    });
  });

  // -------------------------------------------------------------------------
  // 2. Failure Detection: Duplicate, Missing, and Invalid Fields
  // -------------------------------------------------------------------------
  describe("Authority Failure Rejection", () => {
    it("fails validation when a duplicate field ID is injected", () => {
      const duplicateField: StructuralFieldDefinition = {
        id: "catalog.sidebar.mode",
        label: "Duplicate Sidebar Mode",
        specPath: "catalog.sidebar.mode",
        classification: "finite representative structural axis",
        isStructural: true,
        axisKey: "sidebarMode",
        values: ["nested"],
      };
      const inventoryWithDup = [...STRUCTURAL_FIELD_INVENTORY, duplicateField];
      const result = validateStructuralFieldInventory(inventoryWithDup);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Duplicate field id"))).toBe(true);
    });

    it("fails validation when a field has an invalid classification", () => {
      const badClassField: any = {
        id: "bad.classification.field",
        label: "Bad Field",
        specPath: "bad",
        classification: "arbitrary-unknown-classification",
        isStructural: true,
      };
      const inventoryWithBadClass = [...STRUCTURAL_FIELD_INVENTORY, badClassField];
      const result = validateStructuralFieldInventory(inventoryWithBadClass);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("invalid classification"))).toBe(true);
    });

    it("fails validation when a structural axis is missing axisKey or values", () => {
      const badAxis: StructuralFieldDefinition = {
        id: "incomplete.axis",
        label: "Incomplete Axis",
        specPath: "incomplete",
        classification: "finite representative structural axis",
        isStructural: true,
      };
      const result = validateStructuralFieldInventory([...STRUCTURAL_FIELD_INVENTORY, badAxis]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("missing required axisKey"))).toBe(true);
      expect(result.errors.some((e) => e.includes("finite representative values"))).toBe(true);
    });

    it("fails validation when a CSS-carried field is missing cssMechanism", () => {
      const badCss: StructuralFieldDefinition = {
        id: "incomplete.css",
        label: "Incomplete CSS",
        specPath: "incomplete",
        classification: "CSS-carried exact field",
        isStructural: true,
      };
      const result = validateStructuralFieldInventory([...STRUCTURAL_FIELD_INVENTORY, badCss]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("missing cssMechanism"))).toBe(true);
    });

    it("fails validation when a non-live field is missing disclosure or notice", () => {
      const badNonLive: StructuralFieldDefinition = {
        id: "incomplete.nonlive",
        label: "Incomplete NonLive",
        specPath: "incomplete",
        classification: "explicitly not live-previewed",
        isStructural: true,
      };
      const result = validateStructuralFieldInventory([...STRUCTURAL_FIELD_INVENTORY, badNonLive]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("missing honest disclosure"))).toBe(true);
      expect(result.errors.some((e) => e.includes("missing notice"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Mechanical Parity & ThemeV2Controls Integration
  // -------------------------------------------------------------------------
  describe("Mechanical Connection to ThemeV2Controls", () => {
    it("renders ThemeV2Controls and verifies full parity against authority", () => {
      const spec: ThemeSpecificationV2 = {
        ...SAMPLE_THEME_V2,
        catalog: {
          layout: "standard",
          pageTitle: { copy: "none" },
          pagination: { variant: "plain" },
          sidebar: { mode: "nested", groupIds: ["guides"] },
          hero: {
            routes: [
              {
                route: "/intro",
                layout: "centered",
                title: "Intro",
                actions: [{ label: "Start", href: "/start" }],
              },
            ],
          },
          fontLicenses: [{ id: "lic-1", sha256: "abc", text: "license text" }],
        },
      };

      const { container } = render(
        <ThemeV2Controls specification={spec} onChange={() => {}} />
      );

      const parityResult = validateControlsAuthorityParity(container);
      expect(parityResult.valid).toBe(true);
      expect(parityResult.unassignedControls).toEqual([]);
      expect(parityResult.undispositionedFields).toEqual([]);
      expect(parityResult.missingAuthorityFields).toEqual([]);
      expect(parityResult.renderedFieldCount).toBe(37);
    });

    it("fails when an undispositioned interactive input is added to controls DOM", () => {
      const spec = { ...SAMPLE_THEME_V2 };
      const { container } = render(
        <ThemeV2Controls specification={spec} onChange={() => {}} />
      );

      // Artificially inject an untagged input into the DOM
      const untaggedInput = document.createElement("input");
      untaggedInput.id = "rogue-new-field-input";
      untaggedInput.setAttribute("aria-label", "Rogue New Field");
      container.appendChild(untaggedInput);

      const parityResult = validateControlsAuthorityParity(container);
      expect(parityResult.valid).toBe(false);
      expect(parityResult.unassignedControls).toContain("rogue-new-field-input");
      expect(parityResult.errors.some((e) => e.includes("lacking data-structural-field"))).toBe(true);
    });

    it("fails when a control is tagged with an undispositioned field name", () => {
      const spec = { ...SAMPLE_THEME_V2 };
      const { container } = render(
        <ThemeV2Controls specification={spec} onChange={() => {}} />
      );

      // Artificially inject a control with an undispositioned field ID
      const badTaggedInput = document.createElement("input");
      badTaggedInput.setAttribute("data-structural-field", "brandNewUndispositionedField");
      container.appendChild(badTaggedInput);

      const parityResult = validateControlsAuthorityParity(container);
      expect(parityResult.valid).toBe(false);
      expect(parityResult.undispositionedFields).toContain("brandNewUndispositionedField");
      expect(parityResult.errors.some((e) => e.includes("undispositioned field(s)"))).toBe(true);
    });

    it("fails when an expected authority field is absent from rendered controls", () => {
      const spec = { ...SAMPLE_THEME_V2 };
      const { container } = render(
        <ThemeV2Controls specification={spec} onChange={() => {}} />
      );

      // Custom inventory expecting an unrendered field
      const missingField: StructuralFieldDefinition = {
        id: "missing.phantom.field",
        label: "Phantom Field",
        specPath: "phantom",
        classification: "CSS-carried exact field",
        isStructural: true,
        cssMechanism: "--phantom in CSS",
      };
      const expandedInventory = [...STRUCTURAL_FIELD_INVENTORY, missingField];

      const parityResult = validateControlsAuthorityParity(container, {
        inventory: expandedInventory,
      });
      expect(parityResult.valid).toBe(false);
      expect(parityResult.missingAuthorityFields).toContain("missing.phantom.field");
    });
  });

  // -------------------------------------------------------------------------
  // 4. Gallery Contract Authority & Consumption
  // -------------------------------------------------------------------------
  describe("Gallery Authority Consumption", () => {
    it("validates that GALLERY_COVERAGE passes authority validation", () => {
      const result = validateGalleryAuthority(GALLERY_COVERAGE);
      expect(result.valid).toBe(true);
      expect(result.scenarioCount).toBe(4);
      expect(result.axesCount).toBe(7);
      expect(result.inventoryCount).toBe(37);
      expect(result.notRepresentedCount).toBeGreaterThan(0);
    });

    it("validates that finite gallery scenarios cover all 7 structural axes", () => {
      expect(GALLERY_SCENARIO_IDS).toHaveLength(4);
      const axesKeys = Object.keys(GALLERY_COVERAGE.axes);
      expect(axesKeys).toEqual(
        expect.arrayContaining([
          "sidebarMode",
          "paginationVariant",
          "pageTitleCopy",
          "pageTitleFramed",
          "codeFrame",
          "codeCopy",
          "heroLayout",
        ])
      );
    });

    it("extracts honest non-live preview disclosures matching notRepresented notices", () => {
      const disclosures = getNonLiveDisclosures();
      expect(disclosures.length).toBeGreaterThan(0);
      for (const notice of GALLERY_COVERAGE.notRepresented) {
        expect(disclosures).toContain(notice);
      }
      expect(disclosures).toContain("custom syntax rules");
      expect(disclosures).toContain("arbitrary local fonts");
      expect(disclosures).toContain("arbitrary Hero content/actions/media/routes");
      expect(disclosures).toContain("sidebar groups and routes");
      expect(disclosures).toContain("consumer-default code");
      expect(disclosures).toContain("code tabs");
      expect(disclosures).toContain("edited code marks");
      expect(disclosures).toContain("code size and line height");
    });

    it("fails gallery authority validation if an axis is missing or has empty values", () => {
      const brokenCoverage = {
        ...GALLERY_COVERAGE,
        axes: {
          ...GALLERY_COVERAGE.axes,
          sidebarMode: [],
        },
      };
      expect(() => validateGalleryAuthority(brokenCoverage as any)).toThrow(
        /empty or invalid values/
      );
    });
  });
});

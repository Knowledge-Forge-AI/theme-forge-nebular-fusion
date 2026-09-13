import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { ThemeLab } from "../features/theme-lab/ThemeLab";
import { TfslBatchTestBridge } from "./tfsl-batch-bridge";
import type { ThemeSpecification } from "../features/theme-lab/types";

const require = createRequire(import.meta.url);
const tfslDistCandidates = [
  resolve(import.meta.dirname, "../../src-tauri/loom-payload/dist/design-exchange/index.js"),
  resolve(process.cwd(), "src-tauri/loom-payload/dist/design-exchange/index.js"),
  resolve(import.meta.dirname, "../../../../packages/stellar-loom/dist/design-exchange/index.js"),
  resolve(process.cwd(), "packages/stellar-loom/dist/design-exchange/index.js"),
];
let tfslDistPath = tfslDistCandidates.find((p) => existsSync(p));
if (!tfslDistPath) {
  try {
    tfslDistPath = require.resolve("@knowledge-forge-ai/theme-forge-stellar-loom/design-exchange");
  } catch {}
}
const tfslDist = require(tfslDistPath || tfslDistCandidates[0]!);
const { createThemeBrief, createThemeCandidate } = tfslDist;

describe("TFSB53E-R1 Theme Design Exchange Integration", () => {
  describe("Bridge Contract and Dist Fail-Closed Policy", () => {
    it("fails closed when batch dist is missing or pointed at invalid binary (fail NOT skip)", () => {
      expect(() => new TfslBatchTestBridge({ batchScriptPath: "/nonexistent/path/tfsl-batch.js" })).toThrow(
        /missing.*fails closed/i
      );
    });

    it("fails closed on operations when bridge is disconnected", async () => {
      const bridge = new TfslBatchTestBridge({ disconnected: true });
      const status = await bridge.getStatus();
      expect(status.available).toBe(false);
      expect(status.compilerVersion).toBe("0.0.0-disconnected");

      await expect(
        bridge.compile({
          specification: {
            name: "test",
            version: "0.1.0",
            schemaVersion: "tfsl.theme-v1",
            adapter: "starlight-v0.42",
            colors: {} as any,
            typography: {} as any,
            layout: {} as any,
          },
        })
      ).rejects.toThrow(/disconnected/i);

      await expect(
        bridge.createBrief({
          briefInput: {
            briefId: "test-brief",
            title: "Test",
            goal: "Test",
            baselineTheme: {} as any,
          },
        })
      ).rejects.toThrow(/disconnected/i);
    });

    it("disables exchange controls in UI when backend is disconnected", async () => {
      const bridge = new TfslBatchTestBridge({ disconnected: true });
      render(<ThemeLab bridge={bridge} />);

      expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();
      expect(await screen.findByText(/Backend Unavailable/i)).toBeTruthy();

      // Open Exchange tab
      const exchangeTab = screen.getByRole("tab", { name: /Design Exchange/ });
      fireEvent.click(exchangeTab);

      // Verify buttons in exchange panel are disabled
      const exportBriefBtns = screen.getAllByRole("button", { name: "Export Brief…" });
      for (const btn of exportBriefBtns) {
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      }

      const importBtns = screen.getAllByRole("button", { name: "Import Packet…" });
      for (const btn of importBtns) {
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      }
    });
  });

  describe("Real Batch Execution with Rendered UI", () => {
    let bridge: TfslBatchTestBridge;
    let baseTheme: ThemeSpecification;
    let brief: any;
    let candA: any;
    let candB: any;

    beforeEach(async () => {
      bridge = new TfslBatchTestBridge();
      const exRes = await bridge.loadExample("stellar-cyan");
      expect(exRes.valid).toBe(true);
      baseTheme = exRes.specification!;

      // Generate 2 valid candidates with the real built TFSL API
      brief = createThemeBrief({
        briefId: "brief-cyan",
        title: "Stellar Cyan Enhancement Brief",
        goal: "Refine Starlight theme aesthetics and contrast",
        baselineTheme: baseTheme,
        allowedFields: [
          "colors.dark.accent.base",
          "colors.dark.accent.high",
          "colors.dark.accent.low",
          "colors.light.accent.base",
        ],
        allowedModes: ["dark", "light"],
      });

      const themeA = JSON.parse(JSON.stringify(baseTheme));
      themeA.colors.dark.accent.base = "#00d4ff";
      themeA.colors.dark.accent.high = "#b3f0ff";
      candA = createThemeCandidate({
        candidateId: "cand-cyan-contrast",
        brief,
        theme: themeA,
        rationale: "High contrast dark mode accent meets WCAG AA criteria",
      });

      const themeB = JSON.parse(JSON.stringify(baseTheme));
      themeB.colors.dark.accent.base = "#00b4d8";
      themeB.colors.dark.accent.high = "#90e0ef";
      candB = createThemeCandidate({
        candidateId: "cand-cyan-vibrant",
        brief,
        theme: themeB,
        rationale: "Vibrant cyan look for alternate visual style",
      });
    });

    it("exports brief reaching real packet creator via actual rendered button", async () => {
      render(<ThemeLab bridge={bridge} />);
      expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

      // Open Exchange tab
      const exchangeTab = screen.getByRole("tab", { name: /Design Exchange/ });
      fireEvent.click(exchangeTab);

      // Fill brief controls
      fireEvent.change(screen.getByLabelText("Brief ID"), { target: { value: "brief-stellar-cyan" } });
      fireEvent.change(screen.getByLabelText("Brief Title"), { target: { value: "Stellar Cyan Enhancement Brief" } });
      fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Refine Starlight theme aesthetics and contrast" } });
      fireEvent.change(screen.getByLabelText(/Allowed Fields/), {
        target: { value: "colors.dark.accent.base\ncolors.dark.accent.high\ncolors.dark.accent.low\ncolors.light.accent.base" },
      });

      const exportBriefBtn = screen.getAllByRole("button", { name: "Export Brief…" })[0]!;
      fireEvent.click(exportBriefBtn);

      await waitFor(() => {
        expect(screen.getByText(/Exported brief to/)).toBeTruthy();
      });

      const exported = bridge.getExportedPackets();
      expect(exported.length).toBeGreaterThan(0);
      const briefPacket = exported[exported.length - 1]!.packet as any;
      expect(briefPacket.schema).toBe("tfsl.theme-brief");
      expect(briefPacket.briefId).toBe("brief-stellar-cyan");
      expect(briefPacket.briefDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(briefPacket.compilerVersion).toBe("0.2.0");
    });

    it("exercises two imports without draft mutation and explicit select preview reaching real compiler", async () => {
      const { container } = render(<ThemeLab bridge={bridge} />);
      expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

      // Open Exchange tab - initially empty
      const exchangeTab = screen.getByRole("tab", { name: /Design Exchange/ });
      fireEvent.click(exchangeTab);
      expect(screen.getByText(/No design candidates imported yet/)).toBeTruthy();

      // Import brief first so activeBrief matches candidate briefDigest
      bridge.queueImport(brief);
      const importBtn = screen.getAllByRole("button", { name: "Import Packet…" })[0]!;
      fireEvent.click(importBtn);

      await waitFor(() => {
        expect(screen.getByText(/Imported brief/)).toBeTruthy();
      });

      // Import Candidate A
      bridge.queueImport(candA);
      fireEvent.click(importBtn);

      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /cand-cyan-contrast/ })).toBeTruthy();
      });

      // Verification 1: Draft NOT mutated by import
      expect(container.querySelector(".theme-title")?.textContent).toContain("stellar-cyan");
      expect(screen.queryByText(/\* Modified/)).toBeNull();
      // Candidate details NOT shown until explicitly selected
      expect(screen.queryByRole("heading", { name: "cand-cyan-contrast" })).toBeNull();

      // Import Candidate B
      bridge.queueImport(candB);
      fireEvent.click(importBtn);

      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /cand-cyan-vibrant/ })).toBeTruthy();
      });

      // Verification 2: Draft STILL NOT mutated
      expect(container.querySelector(".theme-title")?.textContent).toContain("stellar-cyan");
      expect(screen.queryByText(/\* Modified/)).toBeNull();

      // Explicit select of Candidate A
      const candAChip = screen.getByRole("tab", { name: /cand-cyan-contrast/ });
      fireEvent.click(candAChip);

      expect(await screen.findByRole("heading", { name: "cand-cyan-contrast" })).toBeTruthy();
      expect(screen.getByText(/High contrast dark mode accent meets WCAG AA criteria/)).toBeTruthy();

      // Preview candidate reaching real compiler
      const previewBtn = screen.getByRole("button", { name: "Preview Candidate" });
      fireEvent.click(previewBtn);

      await waitFor(() => {
        expect(screen.getByText("Previewing Candidate")).toBeTruthy();
        expect(screen.getAllByRole("button", { name: "Restore Draft Preview" }).length).toBeGreaterThan(0);
      });

      // Restore preview
      const restoreBtn = screen.getAllByRole("button", { name: "Restore Draft Preview" })[0]!;
      fireEvent.click(restoreBtn);

      await waitFor(() => {
        expect(screen.queryByText("Previewing Candidate")).toBeNull();
      });
    });

    it("records annotations, dispositions, exports review, and validates hydration upon re-import", async () => {
      render(<ThemeLab bridge={bridge} />);
      expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

      // Open Exchange tab first
      const exchangeTab = screen.getByRole("tab", { name: /Design Exchange/ });
      fireEvent.click(exchangeTab);

      // Fill brief controls
      fireEvent.change(screen.getByLabelText("Brief ID"), { target: { value: "brief-stellar-cyan" } });
      fireEvent.change(screen.getByLabelText("Brief Title"), { target: { value: "Stellar Cyan Enhancement Brief" } });
      fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Refine Starlight theme aesthetics and contrast" } });
      fireEvent.change(screen.getByLabelText(/Allowed Fields/), {
        target: { value: "colors.dark.accent.base\ncolors.dark.accent.high\ncolors.dark.accent.low\ncolors.light.accent.base" },
      });

      // Export brief so activeBrief is set
      const exportBriefBtn = screen.getAllByRole("button", { name: "Export Brief…" })[0]!;
      fireEvent.click(exportBriefBtn);
      await screen.findByText(/Exported brief to/);

      const exported = bridge.getExportedPackets();
      const activeBriefPacket = exported.find((p) => (p.packet as any)?.schema === "tfsl.theme-brief")!.packet as any;

      // Create candidates bound to activeBriefPacket so briefDigests align for link validation
      const themeA = JSON.parse(JSON.stringify(baseTheme));
      themeA.colors.dark.accent.base = "#00d4ff";
      themeA.colors.dark.accent.high = "#b3f0ff";
      const candAForBrief = createThemeCandidate({
        candidateId: "cand-cyan-contrast",
        brief: activeBriefPacket,
        theme: themeA,
        rationale: "High contrast dark mode accent meets WCAG AA criteria",
      });

      const themeB = JSON.parse(JSON.stringify(baseTheme));
      themeB.colors.dark.accent.base = "#00b4d8";
      themeB.colors.dark.accent.high = "#90e0ef";
      const candBForBrief = createThemeCandidate({
        candidateId: "cand-cyan-vibrant",
        brief: activeBriefPacket,
        theme: themeB,
        rationale: "Vibrant cyan look for alternate visual style",
      });

      // Import Candidate A
      bridge.queueImport(candAForBrief);
      const importBtn = screen.getAllByRole("button", { name: "Import Packet…" })[0]!;
      fireEvent.click(importBtn);
      const candAChip = await screen.findByRole("tab", { name: /cand-cyan-contrast/ });

      // Import Candidate B
      bridge.queueImport(candBForBrief);
      fireEvent.click(importBtn);
      await screen.findByRole("tab", { name: /cand-cyan-vibrant/ });

      // Explicitly select Candidate A
      fireEvent.click(candAChip);

      // Add annotation
      const reviewSchemaCandidates = [
        resolve(import.meta.dirname, "../../src-tauri/loom-payload/protocol/tfsl-theme-evidence-v1/review.schema.json"),
        resolve(process.cwd(), "src-tauri/loom-payload/protocol/tfsl-theme-evidence-v1/review.schema.json"),
        resolve(import.meta.dirname, "../../../../packages/stellar-loom/protocol/tfsl-theme-evidence-v1/review.schema.json"),
        resolve(process.cwd(), "packages/stellar-loom/protocol/tfsl-theme-evidence-v1/review.schema.json"),
      ];
      const reviewSchemaPath = reviewSchemaCandidates.find((p) => existsSync(p)) || reviewSchemaCandidates[0]!;
      const reviewSchema = require(reviewSchemaPath);
      const optionValues = (label: string) => Array.from(
        (screen.getByLabelText(label) as HTMLSelectElement).options,
        (option) => option.value,
      ).sort();
      const defs = reviewSchema.$defs;
      expect(optionValues("Annotation severity")).toEqual([...defs.annotation.properties.severity.enum].sort());
      expect(optionValues("Annotation category")).toEqual([...defs.annotation.properties.category.enum].sort());
      expect(optionValues("Decision:")).toEqual([...defs.disposition.properties.disposition.enum].sort());
      expect(optionValues("Overall Result:")).toEqual(
        defs.overall.oneOf.flatMap((variant: any) => variant.properties.kind.enum).sort(),
      );
      const fieldInput = screen.getByLabelText("Annotation field path");
      fireEvent.change(fieldInput, { target: { value: "colors.dark.accent.base" } });
      const commentInput = screen.getByLabelText("Annotation comment");
      fireEvent.change(commentInput, { target: { value: "Accent high contrast color passes AA" } });
      const addAnnBtn = screen.getByRole("button", { name: "Add Annotation" });
      fireEvent.click(addAnnBtn);

      await waitFor(() => {
        expect(screen.getByText("Accent high contrast color passes AA")).toBeTruthy();
      });

      // Set candidate disposition for Candidate A to approved
      const dispSelect = screen.getByLabelText("Decision:");
      fireEvent.change(dispSelect, { target: { value: "approved" } });

      const dispComment = screen.getByLabelText("Comment:");
      fireEvent.change(dispComment, { target: { value: "Approved for contrast fidelity" } });

      // Select Candidate B and mark deferred
      const candBChip = screen.getByRole("tab", { name: /cand-cyan-vibrant/ });
      fireEvent.click(candBChip);

      const dispSelectB = screen.getByLabelText("Decision:");
      fireEvent.change(dispSelectB, { target: { value: "deferred" } });

      // Configure overall disposition matching Candidate A
      const overallSelect = screen.getByLabelText("Overall Result:");
      fireEvent.change(overallSelect, { target: { value: "approved" } });

      const candidateSelect = screen.getByLabelText("Selected Candidate:");
      fireEvent.change(candidateSelect, { target: { value: candAForBrief.candidateDigest } });

      const summaryInput = screen.getByLabelText("Review Summary:");
      fireEvent.change(summaryInput, { target: { value: "Candidate A approved for dark mode contrast compliance." } });

      // Export Final Review Packet
      const exportReviewBtn = screen.getByRole("button", { name: "Export Final Review Packet…" });
      expect((exportReviewBtn as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(exportReviewBtn);

      await waitFor(() => {
        expect(screen.getByText(/Exported review to/)).toBeTruthy();
      });

      const exportedPackets = bridge.getExportedPackets();
      const reviewRecord = exportedPackets.find((p) => (p.packet as any)?.schema === "tfsl.theme-review");
      expect(reviewRecord).toBeDefined();
      const reviewPacket = reviewRecord!.packet as any;

      expect(reviewPacket.schema).toBe("tfsl.theme-review");
      expect(reviewPacket.reviewDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(reviewPacket.overallDisposition).toEqual({
        kind: "approved",
        candidateDigest: candAForBrief.candidateDigest,
      });
      expect(reviewPacket.dispositions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            candidateDigest: candAForBrief.candidateDigest,
            disposition: "approved",
            comment: "Approved for contrast fidelity",
          }),
          expect.objectContaining({
            candidateDigest: candBForBrief.candidateDigest,
            disposition: "deferred",
          }),
        ])
      );
      expect(reviewPacket.annotations.length).toBeGreaterThan(0);

      // Test hydration by re-importing the review packet
      bridge.queueImport(reviewPacket);
      fireEvent.click(importBtn);

      await waitFor(() => {
        expect(screen.getByText(/Imported and validated review/)).toBeTruthy();
      });

      // Verify hydrated review state
      expect(screen.getByDisplayValue("Candidate A approved for dark mode contrast compliance.")).toBeTruthy();
    });

    it("verifies dirty cancel and unsaved adopt flow with real compiler execution", async () => {
      const { container } = render(<ThemeLab bridge={bridge} />);
      expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

      // Make draft dirty by editing accent color on Palette tab
      const hexInput = screen.getByLabelText("Accent base hex code");
      fireEvent.change(hexInput, { target: { value: "#e11d48" } });

      await waitFor(() => {
        expect(screen.getByText(/\* Modified/)).toBeTruthy();
      });

      // Open Exchange tab
      const exchangeTab = screen.getByRole("tab", { name: /Design Exchange/ });
      fireEvent.click(exchangeTab);

      // Import brief first so activeBrief matches candidate briefDigest
      bridge.queueImport(brief);
      const importBtn = screen.getAllByRole("button", { name: "Import Packet…" })[0]!;
      fireEvent.click(importBtn);
      await waitFor(() => {
        expect(screen.getByText(/Imported brief/)).toBeTruthy();
      });

      // Import Candidate A
      bridge.queueImport(candA);
      fireEvent.click(importBtn);

      // Explicitly select Candidate A
      const candAChip = await screen.findByRole("tab", { name: /cand-cyan-contrast/ });
      fireEvent.click(candAChip);

      // Preview candidate reaching real compiler
      const previewBtn = screen.getByRole("button", { name: "Preview Candidate" });
      fireEvent.click(previewBtn);
      await screen.findByText("Previewing Candidate");

      // Click Use as Draft
      const adoptBtn = screen.getByRole("button", { name: "Use as Draft" });
      fireEvent.click(adoptBtn);

      // Modal appears because draft is dirty
      expect(await screen.findByRole("dialog")).toBeTruthy();
      expect(screen.getByText("Discard Unsaved Changes?")).toBeTruthy();

      // Test 1: Dirty cancel preserves dirty draft
      const cancelBtn = screen.getByRole("button", { name: "Cancel" });
      fireEvent.click(cancelBtn);

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(screen.getByText(/\* Modified/)).toBeTruthy();
      });

      // Test 2: Unsaved adopt with confirmation adopts candidate
      fireEvent.click(adoptBtn);
      expect(await screen.findByRole("dialog")).toBeTruthy();

      const confirmBtn = screen.getByRole("button", { name: "Discard & Adopt" });
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(screen.getByText(/Adopted candidate cand-cyan-contrast as active draft/)).toBeTruthy();
      });

      // Candidate is adopted and spec is updated with candidate's colors and dirty state
      expect(container.querySelector(".theme-title")?.textContent).toContain("stellar-cyan");
      expect(screen.getByText(/\* Modified/)).toBeTruthy();
      // Verify candidate's accent was adopted into draft
      const paletteTab = screen.getByRole("tab", { name: "Palette" });
      fireEvent.click(paletteTab);
      expect((screen.getByLabelText("Accent base hex code") as HTMLInputElement).value).toBe("#00d4ff");
    });
  });
});

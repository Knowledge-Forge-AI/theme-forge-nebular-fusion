import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppearanceControls } from "../AppearanceControls";
import { createAppearanceController, type AppearanceCatalog } from "../appearance-controller";

const catalog: AppearanceCatalog = {
  defaultFamily: "nebular",
  defaults: { light: "terminal-nova", dark: "nebular", mode: "system" },
  families: [
    { id: "nebular", label: "Nebular", css: ":root { --background: purple; }" },
    { id: "terminal-nova", label: "Terminal Nova", css: ":root { --background: cyan; }" },
  ],
};
const doc = () => document.implementation.createHTMLDocument("Appearance pair fixture");
const css = (value: Document) => [...value.head.querySelectorAll("style")].map((node) => node.textContent);
afterEach(cleanup);

describe("persistent custom appearance pairs", () => {
  it("loads separate saved sides before attachment and follows System without writing preferences", () => {
    const preferences = { version: 1, light: "nebular", dark: "terminal-nova", mode: "system" };
    const appearance = createAppearanceController(catalog, { preferences });
    preferences.light = "terminal-nova";
    const value = doc();
    expect(appearance.getSnapshot()).toMatchObject({ preferenceRevision: 0, resolvedFamilies: { light: "nebular", dark: "terminal-nova" } });
    expect(css(value)).toEqual([]);
    expect(appearance.attach(value, "light").ok).toBe(true);
    expect(css(value)).toEqual([catalog.families[0]!.css]);
    expect(appearance.change({ kind: "set-system-mode", mode: "dark" }).ok).toBe(true);
    expect(css(value)).toEqual([catalog.families[1]!.css]);
    expect(appearance.getSnapshot().preferenceRevision).toBe(0);
    appearance.detach();
  });

  it("keeps product defaults separate from an explicit System choice and resets to the product mode", () => {
    const appearance = createAppearanceController({ ...catalog, defaults: { light: "terminal-nova", dark: "nebular", mode: "light" } });
    const value = doc();
    appearance.attach(value, "dark");
    expect(appearance.getSnapshot()).toMatchObject({ effectiveMode: "light", preferences: { version: 1 } });
    appearance.change({ kind: "set-mode-preference", preference: "system" });
    expect(appearance.getSnapshot()).toMatchObject({ effectiveMode: "dark", preferences: { version: 1, mode: "system" }, preferenceRevision: 1 });
    appearance.change({ kind: "reset" });
    expect(appearance.getSnapshot()).toMatchObject({ effectiveMode: "light", preferences: { version: 1 }, preferenceRevision: 2 });
    appearance.detach();
  });

  it("falls back per side for obsolete saved IDs while retaining the saved record unchanged", () => {
    const appearance = createAppearanceController(catalog, { preferences: { version: 1, light: "retired-family", dark: "terminal-nova" } });
    const value = doc();
    appearance.attach(value, "light");
    expect(css(value)).toEqual([catalog.families[1]!.css]);
    expect(appearance.getSnapshot()).toMatchObject({ preferences: { light: "retired-family", dark: "terminal-nova" }, preferenceRevision: 0 });
    expect(appearance.getSnapshot().preferenceDiagnostics).toContainEqual({ code: "missing-family", side: "light", familyId: "retired-family", fallbackFamilyId: "terminal-nova" });
    appearance.change({ kind: "set-system-mode", mode: "dark" });
    expect(appearance.getSnapshot().preferenceRevision).toBe(0);
    appearance.detach();
  });

  it("rejects an unavailable inactive side before touching styles or the persisted record", () => {
    const appearance = createAppearanceController(catalog);
    const value = doc();
    appearance.attach(value, "light");
    const previous = [...value.head.children];
    expect(appearance.change({ kind: "select-custom-pair", light: "nebular", dark: "missing" }).ok).toBe(false);
    expect(appearance.getSnapshot()).toMatchObject({ preferences: { version: 1 }, preferenceRevision: 0 });
    [...value.head.children].forEach((element, index) => expect(element).toBe(previous[index]));
    appearance.detach();
  });

  it("only persists a pair after its stylesheet transaction succeeds", () => {
    const appearance = createAppearanceController(catalog);
    const value = doc();
    appearance.attach(value, "light");
    const insertion = vi.spyOn(value.head, "insertBefore").mockImplementationOnce(() => { throw new Error("fixture insertion refusal"); });
    expect(appearance.change({ kind: "select-custom-pair", light: "nebular" }).ok).toBe(false);
    expect(appearance.getSnapshot()).toMatchObject({ preferences: { version: 1 }, preferenceRevision: 0 });
    insertion.mockRestore();
    expect(appearance.change({ kind: "select-custom-pair", light: "nebular" }).ok).toBe(true);
    expect(appearance.getSnapshot()).toMatchObject({ preferences: { version: 1, light: "nebular" }, preferenceRevision: 1 });
    appearance.detach();
  });

  it("retains a draft for repeated custom choices and invalidates it when either side changes", () => {
    const appearance = createAppearanceController(catalog);
    const value = doc();
    appearance.attach(value, "light");
    appearance.change({ kind: "select-custom-pair", light: "terminal-nova", dark: "nebular" });
    const owner = appearance.registerEditor();
    const token = appearance.captureApplyEligibility(owner)!;
    appearance.applyDraft(owner, token, ":root { --primary: gold; }");
    const previous = [...value.head.children];
    appearance.change({ kind: "select-custom-pair", light: "terminal-nova", dark: "nebular" });
    expect(appearance.getSnapshot().hasDraft).toBe(true);
    [...value.head.children].forEach((element, index) => expect(element).toBe(previous[index]));
    appearance.change({ kind: "select-custom-pair", light: "terminal-nova", dark: "terminal-nova" });
    expect(appearance.getSnapshot().hasDraft).toBe(false);
    expect(appearance.applyDraft(owner, token, "draft").reason).toBe("stale-eligibility");
    appearance.detach();
  });

  it("does not rewrite invalid startup data until an explicit user action", () => {
    const appearance = createAppearanceController(catalog, { preferences: { version: 9, mode: null } });
    const value = doc();
    appearance.attach(value, "light");
    expect(appearance.getSnapshot()).toMatchObject({ preferenceRevision: 0, preferences: { version: 1 } });
    expect(appearance.getSnapshot().preferenceDiagnostics.length).toBeGreaterThan(0);
    appearance.change({ kind: "select-application-default" });
    expect(appearance.getSnapshot()).toMatchObject({ preferenceRevision: 1, preferences: { version: 1 }, preferenceDiagnostics: [] });
    appearance.detach();
  });

  it("offers independent selectors and resets both explicit side overrides", () => {
    const appearance = createAppearanceController(catalog);
    render(<AppearanceControls appearance={appearance} />);
    fireEvent.change(screen.getByLabelText("Light appearance"), { target: { value: "nebular" } });
    expect(appearance.getSnapshot().preferences).toEqual({ version: 1, light: "nebular" });
    fireEvent.change(screen.getByLabelText("Dark appearance"), { target: { value: "terminal-nova" } });
    expect(appearance.getSnapshot().preferences).toEqual({ version: 1, light: "nebular", dark: "terminal-nova" });
    expect((screen.getByLabelText("Application appearance", { selector: "select" }) as HTMLSelectElement).value).toBe("__custom");
    fireEvent.change(screen.getByLabelText("Application display mode"), { target: { value: "dark" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset appearance" }));
    expect(appearance.getSnapshot().preferences).toEqual({ version: 1 });
    expect((screen.getByLabelText("Light appearance") as HTMLSelectElement).value).toBe("");
  });

  it("lets the healthy side change while retaining an obsolete choice on the other side", () => {
    const appearance = createAppearanceController(catalog, { preferences: { version: 1, light: "retired-family", dark: "terminal-nova" } });
    render(<AppearanceControls appearance={appearance} />);
    fireEvent.change(screen.getByLabelText("Dark appearance"), { target: { value: "nebular" } });
    expect(appearance.getSnapshot()).toMatchObject({ problem: null, preferences: { version: 1, light: "retired-family", dark: "nebular" }, preferenceRevision: 1,
      resolvedFamilies: { light: "terminal-nova", dark: "nebular" } });
  });

  it("canonicalizes the same family on both sides without releasing an existing draft", () => {
    const appearance = createAppearanceController(catalog);
    const value = doc();
    appearance.attach(value, "light");
    appearance.change({ kind: "select-pair", pairId: "terminal-nova" });
    const owner = appearance.registerEditor();
    const token = appearance.captureApplyEligibility(owner)!;
    appearance.applyDraft(owner, token, ":root { --primary: gold; }");
    const before = appearance.getSnapshot();
    const previous = [...value.head.children];
    appearance.change({ kind: "select-custom-pair", light: "terminal-nova", dark: "terminal-nova" });
    expect(appearance.getSnapshot()).toBe(before);
    expect(appearance.getSnapshot().hasDraft).toBe(true);
    [...value.head.children].forEach((element, index) => expect(element).toBe(previous[index]));
    appearance.detach();
  });

  it("shows an unavailable saved pair rather than visually claiming the product default", () => {
    const appearance = createAppearanceController(catalog, { preferences: { version: 1, light: "retired-family", dark: "retired-family" } });
    render(<AppearanceControls appearance={appearance} />);
    const primary = screen.getByLabelText("Application appearance", { selector: "select" }) as HTMLSelectElement;
    expect(primary.selectedOptions[0]!.textContent).toBe("Saved appearance unavailable");
    expect(primary.value).toBe("retired-family");
  });

  it("disables interactive adoption and preserves the saved record when native sheets are unavailable", async () => {
    const preferences = { version: 1 as const, mode: "light" as const, light: "terminal-nova" };
    const appearance = createAppearanceController(catalog, { preferences, allowStyleElementFallback: false });
    render(<AppearanceControls appearance={appearance} />);
    let attached = true;
    await act(async () => {
      attached = appearance.attach(doc(), "light").ok;
    });
    expect(attached).toBe(false);

    expect(screen.getByRole("alert").textContent).toContain("native appearance stylesheet backend is unavailable");
    expect((screen.getByLabelText("Application appearance", { selector: "select" }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("Application display mode") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reset appearance" }) as HTMLButtonElement).disabled).toBe(true);
    expect(appearance.getSnapshot()).toMatchObject({ preferences, preferenceRevision: 0, problem: "unsupported-backend" });
  });
});

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppearanceControls } from "../AppearanceControls";
import { createAppearanceController, type AppearanceCatalog } from "../appearance-controller";

const catalog: AppearanceCatalog = {
  defaultFamily: "terminal-nova",
  defaults: { light: "terminal-nova", dark: "anime", mode: "system" },
  families: [
    { id: "terminal-nova", label: "Terminal Nova", css: ":root { --background: #101018; }" },
    { id: "anime", label: "Anime", css: ":root { --background: #281b33; }" },
  ],
};

const appearanceDocument = () => document.implementation.createHTMLDocument("Anime artwork fixture");
afterEach(cleanup);

describe("Anime application artwork", () => {
  it("projects only the effective attached Anime family and keeps the selector authoritative", () => {
    const appearance = createAppearanceController(catalog);
    render(<AppearanceControls appearance={appearance} />);
    expect(screen.queryByTestId("anime-application-artwork")).toBeNull();

    act(() => { expect(appearance.attach(appearanceDocument(), "dark").ok).toBe(true); });
    const card = screen.getByTestId("anime-application-artwork");
    const image = screen.getByTestId("anime-application-artwork-image");
    expect(card).not.toBeNull();
    expect(image.getAttribute("src")).toBe("/appearance-artwork/anime/cartographer-v2.png");
    expect(image.getAttribute("alt")).toBe("");
    expect(image.hasAttribute("tabindex")).toBe(false);
    expect(screen.getByLabelText("Application appearance", { selector: "select" })).not.toBeNull();

    act(() => { appearance.change({ kind: "select-pair", pairId: "terminal-nova" }); });
    expect(screen.queryByTestId("anime-application-artwork")).toBeNull();
    expect(appearance.getSnapshot().preferences).toEqual({ version: 1, light: "terminal-nova", dark: "terminal-nova" });
    act(() => { appearance.detach(); });
  });

  it("follows system mode and separate custom-pair sides without adding artwork preference state", () => {
    const appearance = createAppearanceController(catalog);
    render(<AppearanceControls appearance={appearance} />);
    act(() => { appearance.attach(appearanceDocument(), "light"); });
    expect(screen.queryByTestId("anime-application-artwork")).toBeNull();

    act(() => { appearance.change({ kind: "set-system-mode", mode: "dark" }); });
    expect(screen.queryByTestId("anime-application-artwork")).not.toBeNull();

    act(() => { appearance.change({ kind: "select-custom-pair", light: "anime", dark: "terminal-nova" }); });
    expect(screen.queryByTestId("anime-application-artwork")).toBeNull();
    act(() => { appearance.change({ kind: "set-mode-preference", preference: "light" }); });
    expect(screen.queryByTestId("anime-application-artwork")).not.toBeNull();
    expect(appearance.getSnapshot().preferences).toEqual({ version: 1, light: "anime", dark: "terminal-nova", mode: "light" });
    act(() => { appearance.detach(); });
  });

  it("uses an opaque local fallback after image failure while preserving controls and preferences", () => {
    const appearance = createAppearanceController(catalog);
    render(<AppearanceControls appearance={appearance} />);
    act(() => { appearance.attach(appearanceDocument(), "dark"); });
    const before = appearance.getSnapshot().preferences;
    fireEvent.error(screen.getByTestId("anime-application-artwork-image"));

    const card = screen.getByTestId("anime-application-artwork");
    expect(card.getAttribute("data-artwork-state")).toBe("fallback");
    expect(screen.getByTestId("anime-application-artwork-fallback").textContent).toContain("appearance controls remain available");
    expect(screen.getByLabelText("Application appearance", { selector: "select" })).not.toBeNull();
    expect(appearance.getSnapshot().preferences).toBe(before);
    act(() => { appearance.detach(); });
  });

  it("records only public packaging evidence for the exact v2 candidate", () => {
    const assetPath = "public/appearance-artwork/anime/cartographer-v2.png";
    const provenancePath = "public/appearance-artwork/anime/cartographer-v2.provenance.json";
    const bytes = readFileSync(assetPath);
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as Record<string, unknown>;
    expect(statSync(assetPath).size).toBe(1_905_125);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("e1df9e0c364ee97748fe2511f8a015f4ef8618d303e96ed868d4efd93800eada");
    expect(provenance).toEqual({
      schema: "theme-forge.application-artwork-projection.v1",
      asset: "appearance-artwork/anime/cartographer-v2.png",
      role: "optional-decorative-anime-application-chrome",
      bytes: 1_905_125,
      sha256: "e1df9e0c364ee97748fe2511f8a015f4ef8618d303e96ed868d4efd93800eada",
      dimensions: [1024, 1536],
      sourceSchema: "theme-forge.generated-artwork-candidate.v1",
      status: "source-preparation-only",
      rights: "Project artwork-policy decision required before distribution; software terms do not grant artwork rights.",
    });
  });
});

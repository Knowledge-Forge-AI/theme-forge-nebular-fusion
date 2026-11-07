import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppearanceStartupSession } from "../appearance-bootstrap";
import type { AppearancePreferenceLoadReply, AppearanceSettingsBridge } from "../appearance-settings-bridge";

const catalog = { defaultFamily: "nebular", families: [{ id: "nebular", label: "Nebular", css: ":root{--primary:purple}" }] };
afterEach(() => vi.useRealTimers());

describe("appearance startup assembly", () => {
  it("keeps a timed-out unread record session-only even after an explicit user change", async () => {
    vi.useFakeTimers();
    let finish!: (reply: AppearancePreferenceLoadReply) => void;
    const save = vi.fn().mockResolvedValue({ status: "saved" });
    const bridge: AppearanceSettingsBridge = { load: () => new Promise((resolve) => { finish = resolve; }), save };
    const pending = createAppearanceStartupSession(catalog, bridge);
    await vi.advanceTimersByTimeAsync(5_000);
    const session = await pending;
    expect(session.startup).toMatchObject({ status: "rejected", reason: "storage-unavailable" });
    expect(session.persistence).toBeNull();
    session.appearance.change({ kind: "set-mode-preference", preference: "dark" });
    finish({ status: "loaded", preferences: { version: 1, light: "retired-family" } });
    await Promise.resolve();
    expect(save).not.toHaveBeenCalled();
    expect(session.appearance.getSnapshot().preferences).toEqual({ version: 1, mode: "dark" });
  });

  it("loads before creating the controller and saves only a subsequent explicit action", async () => {
    const save = vi.fn().mockResolvedValue({ status: "saved" });
    const session = await createAppearanceStartupSession(catalog, {
      load: async () => ({ status: "loaded", preferences: { version: 1, mode: "light" } }), save,
    });
    expect(session.appearance.getSnapshot()).toMatchObject({ modePreference: "light", preferenceRevision: 0 });
    session.persistence!.connect();
    expect(save).not.toHaveBeenCalled();
    session.appearance.change({ kind: "set-mode-preference", preference: "dark" });
    await Promise.resolve();
    expect(save).toHaveBeenCalledExactlyOnceWith({ version: 1, mode: "dark" });
    session.persistence!.disconnect();
  });

  it("does not access settings or claim persistent storage in the browser fixture", async () => {
    const session = await createAppearanceStartupSession(catalog, null);
    expect(session.startup).toBeNull();
    expect(session.persistence).toBeNull();
    expect(session.appearance.getSnapshot().preferences).toEqual({ version: 1 });
  });

  it("requires prepared external CSSOM slots for a native bridge startup", async () => {
    const session = await createAppearanceStartupSession(catalog, {
      load: async () => ({ status: "missing" }),
      save: async () => ({ status: "saved" }),
    });
    const documentValue = document.implementation.createHTMLDocument("Native CSP fixture");

    const result = session.appearance.attach(documentValue, "light");
    expect(result).toMatchObject({ ok: false, reason: "unsupported-backend" });
    expect(session.stylesheetStartup).toMatchObject({ status: "rejected", reason: "unsupported-backend" });
    expect(session.appearance.getSnapshot()).toMatchObject({ attached: false, problem: "unsupported-backend" });
    expect(documentValue.head.querySelectorAll("style")).toHaveLength(0);
    expect(documentValue.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(session.dispose()).toMatchObject({ ok: true, status: "closed" });
    expect(session.dispose()).toMatchObject({ ok: true, status: "closed" });
  });

  it.each(["invalid-record", "record-too-large", "storage-unavailable"] as const)("preserves a rejected %s record during subsequent appearance changes", async (reason) => {
    const save = vi.fn().mockResolvedValue({ status: "saved" });
    const session = await createAppearanceStartupSession(catalog, {
      load: async () => ({ status: "rejected", reason }), save,
    });
    expect(session.persistence).toBeNull();
    session.appearance.change({ kind: "set-mode-preference", preference: "dark" });
    session.appearance.change({ kind: "reset" });
    await Promise.resolve();
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps browser fixture startup free of native slot preparation and supports terminal disposal", async () => {
    const session = await createAppearanceStartupSession(catalog, null);
    expect(session.stylesheetStartup).toBeNull();
    expect(session.dispose()).toMatchObject({ ok: true, status: "closed" });
    expect(session.appearance.getSnapshot()).toMatchObject({ attached: false });
  });
});

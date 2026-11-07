import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  APPEARANCE_SETTINGS_COMMANDS,
  AppearanceSettingsBridgeError,
  TauriAppearanceSettingsBridge,
  loadAppearancePreferencesAtStartup,
} from "../appearance-settings-bridge";

describe("appearance settings bridge", () => {
  beforeEach(() => invokeMock.mockReset());
  afterEach(() => vi.useRealTimers());

  it("routes the fixed load/save commands and copies V1 records", async () => {
    invokeMock.mockResolvedValueOnce({
      status: "loaded",
      preferences: { version: 1, mode: "dark", light: "nebular" },
    });
    const bridge = new TauriAppearanceSettingsBridge();
    const loaded = await bridge.load();

    expect(loaded).toEqual({ status: "loaded", preferences: { version: 1, mode: "dark", light: "nebular" } });
    expect(invokeMock).toHaveBeenNthCalledWith(1, APPEARANCE_SETTINGS_COMMANDS.load);
    expect(Object.isFrozen(loaded)).toBe(true);
    if (loaded.status === "loaded") expect(Object.isFrozen(loaded.preferences)).toBe(true);

    const input = { version: 1 as const, mode: "light" as const, dark: "terminal-nova" };
    invokeMock.mockResolvedValueOnce({ status: "saved" });
    const saved = await bridge.save(input);
    input.dark = "nebular";

    expect(saved).toEqual({ status: "saved" });
    expect(invokeMock).toHaveBeenNthCalledWith(2, APPEARANCE_SETTINGS_COMMANDS.save, {
      preferences: { version: 1, mode: "light", dark: "terminal-nova" },
    });
    expect(invokeMock.mock.calls[1]?.[1]?.preferences).not.toBe(input);
  });

  it.each([
    null,
    undefined,
    [],
    { status: "loaded", preferences: { version: 1 }, extra: true },
    { status: "missing", extra: false },
    { status: "rejected", reason: "unknown" },
    { status: "rejected", reason: "invalid-record", extra: true },
  ])("rejects malformed load DTO %p with a closed bridge error", async (reply) => {
    invokeMock.mockResolvedValue(reply);
    await expect(new TauriAppearanceSettingsBridge().load()).rejects.toBeInstanceOf(AppearanceSettingsBridgeError);
    await expect(new TauriAppearanceSettingsBridge().load()).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("rejects malformed loaded records and save replies without exposing them", async () => {
    invokeMock.mockResolvedValueOnce({ status: "loaded", preferences: { version: 1, unknown: true } });
    await expect(new TauriAppearanceSettingsBridge().load()).rejects.toMatchObject({ code: "invalid-record" });

    invokeMock.mockResolvedValueOnce({ status: "loaded", preferences: { version: 1, light: "x".repeat(129) } });
    await expect(new TauriAppearanceSettingsBridge().load()).rejects.toMatchObject({ code: "invalid-record" });

    invokeMock.mockResolvedValueOnce(null);
    await expect(new TauriAppearanceSettingsBridge().save({ version: 1 })).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("rejects invalid save input before invoking native code", async () => {
    await expect(new TauriAppearanceSettingsBridge().save({ version: 2 } as never)).rejects.toMatchObject({ code: "invalid-record" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("returns a closed fallback for missing, rejected, and thrown startup loads", async () => {
    const bridge = new TauriAppearanceSettingsBridge();
    invokeMock.mockResolvedValueOnce({ status: "missing" });
    expect(await loadAppearancePreferencesAtStartup(bridge)).toEqual({ status: "missing", record: { version: 1 } });

    invokeMock.mockResolvedValueOnce({ status: "rejected", reason: "record-too-large" });
    expect(await loadAppearancePreferencesAtStartup(bridge)).toEqual({
      status: "rejected",
      record: { version: 1 },
      reason: "record-too-large",
    });

    invokeMock.mockRejectedValueOnce(new Error("private native detail"));
    expect(await loadAppearancePreferencesAtStartup(bridge)).toEqual({
      status: "rejected",
      record: { version: 1 },
      reason: "storage-unavailable",
    });

    invokeMock.mockResolvedValueOnce({ status: "unexpected" });
    expect(await loadAppearancePreferencesAtStartup(bridge)).toEqual({ status: "rejected", record: { version: 1 }, reason: "storage-unavailable" });

    invokeMock.mockResolvedValueOnce({ status: "loaded", preferences: { version: 1, extra: true } });
    expect(await loadAppearancePreferencesAtStartup(bridge)).toEqual({
      status: "rejected",
      record: { version: 1 },
      reason: "invalid-record",
    });
  });

  it("falls back at five seconds for a hung startup load and ignores a late rejection", async () => {
    vi.useFakeTimers();
    let rejectLoad!: (reason?: unknown) => void;
    const lateLoad = new Promise<{ readonly status: "missing" }>((_resolve, reject) => { rejectLoad = reject; });
    const bridge = {
      load: () => lateLoad,
      save: async () => ({ status: "saved" as const }),
    };

    const resultPromise = loadAppearancePreferencesAtStartup(bridge);
    await vi.advanceTimersByTimeAsync(4_999);
    let settled = false;
    void resultPromise.then(() => { settled = true; });
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(resultPromise).resolves.toEqual({
      status: "rejected",
      record: { version: 1 },
      reason: "storage-unavailable",
    });
    expect(vi.getTimerCount()).toBe(0);

    rejectLoad(new Error("late private native detail"));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the five-second timeout when a valid load resolves quickly", async () => {
    vi.useFakeTimers();
    invokeMock.mockResolvedValue({ status: "loaded", preferences: { version: 1, mode: "dark" } });

    await expect(loadAppearancePreferencesAtStartup(new TauriAppearanceSettingsBridge())).resolves.toEqual({
      status: "loaded",
      record: { version: 1, mode: "dark" },
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

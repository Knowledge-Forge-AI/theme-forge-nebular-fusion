import { describe, expect, it, vi } from "vitest";
import { createAppearanceController, type AppearanceCatalog } from "../appearance-controller";
import {
  createAppearancePreferencePersistence,
  type AppearancePreferencePersistence,
} from "../appearance-persistence";
import type {
  AppearancePreferenceLoadReply,
  AppearancePreferenceSaveReply,
  AppearanceSettingsBridge,
} from "../appearance-settings-bridge";
import type { AppearancePreferenceRecordV1 } from "../appearance-preferences";

const catalog: AppearanceCatalog = {
  defaultFamily: "nebular",
  families: [
    { id: "nebular", label: "Nebular", css: ":root { --background: #151020; }" },
    { id: "terminal-nova", label: "Terminal Nova", css: ":root { --background: #111318; }" },
  ],
};

function makeController(preferences?: unknown) {
  return createAppearanceController(catalog, preferences === undefined ? {} : { preferences });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function bridgeWithSave(save: (preferences: AppearancePreferenceRecordV1) => Promise<AppearancePreferenceSaveReply>): AppearanceSettingsBridge {
  return {
    load: async (): Promise<AppearancePreferenceLoadReply> => ({ status: "missing" }),
    save,
  };
}

function bridgeWithRawSave(save: (preferences: AppearancePreferenceRecordV1) => Promise<unknown>): AppearanceSettingsBridge {
  return {
    load: async (): Promise<AppearancePreferenceLoadReply> => ({ status: "missing" }),
    save: save as unknown as AppearanceSettingsBridge["save"],
  };
}

async function settlePromises(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("appearance preference persistence", () => {
  it("does not write revision zero or OS system-mode changes", async () => {
    const controller = makeController();
    const save = vi.fn().mockResolvedValue({ status: "saved" as const });
    const persistence = createAppearancePreferencePersistence(controller, bridgeWithSave(save));
    persistence.connect();

    controller.change({ kind: "set-system-mode", mode: "dark" });
    await settlePromises();
    expect(save).not.toHaveBeenCalled();
    expect(persistence.getSnapshot()).toEqual({ status: "idle", savedRevision: 0 });

    controller.change({ kind: "set-mode-preference", preference: "dark" });
    await settlePromises();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual({ version: 1, mode: "dark" });
    expect(persistence.getSnapshot()).toEqual({ status: "saved", savedRevision: 1 });
  });

  it("serializes writes and coalesces delayed pending revisions to the latest record", async () => {
    const controller = makeController();
    const saves: Array<{ record: AppearancePreferenceRecordV1; deferred: ReturnType<typeof deferred<AppearancePreferenceSaveReply>> }> = [];
    const bridge = bridgeWithSave(async (preferences) => {
      const pending = deferred<AppearancePreferenceSaveReply>();
      saves.push({ record: preferences, deferred: pending });
      return pending.promise;
    });
    const persistence = createAppearancePreferencePersistence(controller, bridge);
    persistence.connect();

    controller.change({ kind: "set-mode-preference", preference: "dark" });
    controller.change({ kind: "select-pair", pairId: "terminal-nova" });
    controller.change({ kind: "select-custom-pair", light: "nebular", dark: "terminal-nova" });
    await settlePromises();

    expect(saves).toHaveLength(1);
    expect(saves[0]?.record).toEqual({ version: 1, mode: "dark" });
    saves[0]!.deferred.resolve({ status: "saved" });
    await settlePromises();

    expect(saves).toHaveLength(2);
    expect(saves[1]?.record).toEqual({ version: 1, mode: "dark", light: "nebular", dark: "terminal-nova" });
    saves[1]!.deferred.resolve({ status: "saved" });
    await settlePromises();

    expect(saves).toHaveLength(2);
    expect(persistence.getSnapshot()).toEqual({ status: "saved", savedRevision: 3 });
  });

  it("marks a rejected or thrown save failed without retrying the same revision", async () => {
    const controller = makeController();
    const save = vi.fn()
      .mockRejectedValueOnce(new Error("private native detail"))
      .mockResolvedValueOnce({ status: "saved" as const });
    const persistence = createAppearancePreferencePersistence(controller, bridgeWithSave(save));
    persistence.connect();

    controller.change({ kind: "set-mode-preference", preference: "dark" });
    await settlePromises();
    expect(save).toHaveBeenCalledTimes(1);
    expect(persistence.getSnapshot()).toEqual({ status: "failed", savedRevision: 0 });

    await settlePromises();
    expect(save).toHaveBeenCalledTimes(1);
    controller.change({ kind: "select-pair", pairId: "terminal-nova" });
    await settlePromises();
    expect(save).toHaveBeenCalledTimes(2);
    expect(persistence.getSnapshot()).toEqual({ status: "saved", savedRevision: 2 });
  });

  it("treats an unexpected save DTO as failed without leaving an unhandled callback", async () => {
    const controller = makeController();
    const save = vi.fn().mockResolvedValue(null);
    const persistence = createAppearancePreferencePersistence(controller, bridgeWithSave(save));
    persistence.connect();

    controller.change({ kind: "set-mode-preference", preference: "dark" });
    await settlePromises();
    expect(save).toHaveBeenCalledTimes(1);
    expect(persistence.getSnapshot()).toEqual({ status: "failed", savedRevision: 0 });
  });

  it.each([
    null,
    { status: "saved", extra: true },
    Object.create({ status: "saved" }),
  ])("does not claim saved for malformed injected reply %p", async (reply) => {
    const controller = makeController();
    const save = vi.fn().mockResolvedValue(reply);
    const persistence = createAppearancePreferencePersistence(controller, bridgeWithRawSave(save));
    persistence.connect();

    controller.change({ kind: "set-mode-preference", preference: "dark" });
    await settlePromises();
    expect(save).toHaveBeenCalledTimes(1);
    expect(persistence.getSnapshot()).toEqual({ status: "failed", savedRevision: 0 });
  });

  it("does not emit late notifications after disconnect and reconnects without duplicate revisions", async () => {
    const controller = makeController();
    const pending = deferred<AppearancePreferenceSaveReply>();
    const save = vi.fn().mockReturnValue(pending.promise);
    const persistence = createAppearancePreferencePersistence(controller, bridgeWithSave(save));
    const observer = vi.fn();
    persistence.subscribe(observer);
    persistence.connect();

    controller.change({ kind: "set-mode-preference", preference: "dark" });
    await settlePromises();
    expect(save).toHaveBeenCalledTimes(1);
    observer.mockClear();

    persistence.disconnect();
    pending.resolve({ status: "saved" });
    await settlePromises();
    expect(observer).not.toHaveBeenCalled();
    expect(persistence.getSnapshot()).toEqual({ status: "saved", savedRevision: 1 });

    persistence.connect();
    await settlePromises();
    expect(save).toHaveBeenCalledTimes(1);
    expect(persistence.getSnapshot()).toEqual({ status: "saved", savedRevision: 1 });
  });

  it("coalesces a change made while disconnected and writes it only after reconnect", async () => {
    const controller = makeController();
    const saves: Array<{ record: AppearancePreferenceRecordV1; deferred: ReturnType<typeof deferred<AppearancePreferenceSaveReply>> }> = [];
    const bridge = bridgeWithSave(async (preferences) => {
      const next = deferred<AppearancePreferenceSaveReply>();
      saves.push({ record: preferences, deferred: next });
      return next.promise;
    });
    const persistence: AppearancePreferencePersistence = createAppearancePreferencePersistence(controller, bridge);
    persistence.connect();
    persistence.disconnect();

    controller.change({ kind: "set-mode-preference", preference: "dark" });
    expect(saves).toHaveLength(0);
    persistence.connect();
    await settlePromises();
    expect(saves).toHaveLength(1);
    expect(saves[0]?.record).toEqual({ version: 1, mode: "dark" });
    saves[0]!.deferred.resolve({ status: "saved" });
    await settlePromises();
    expect(persistence.getSnapshot()).toEqual({ status: "saved", savedRevision: 1 });
  });

  it("reuses one in-flight revision across reconnect and only writes the latest stale pending revision once", async () => {
    const controller = makeController();
    const saves: Array<{ record: AppearancePreferenceRecordV1; deferred: ReturnType<typeof deferred<AppearancePreferenceSaveReply>> }> = [];
    const bridge = bridgeWithSave(async (preferences) => {
      const next = deferred<AppearancePreferenceSaveReply>();
      saves.push({ record: preferences, deferred: next });
      return next.promise;
    });
    const persistence = createAppearancePreferencePersistence(controller, bridge);
    persistence.connect();

    controller.change({ kind: "set-mode-preference", preference: "dark" });
    controller.change({ kind: "select-pair", pairId: "terminal-nova" });
    await settlePromises();
    expect(saves).toHaveLength(1);

    persistence.disconnect();
    persistence.connect();
    expect(saves).toHaveLength(1);
    saves[0]!.deferred.resolve({ status: "saved" });
    await settlePromises();

    expect(saves).toHaveLength(2);
    expect(saves[1]?.record).toEqual({ version: 1, mode: "dark", light: "terminal-nova", dark: "terminal-nova" });
    saves[1]!.deferred.resolve({ status: "saved" });
    await settlePromises();
    expect(saves).toHaveLength(2);
    expect(persistence.getSnapshot()).toEqual({ status: "saved", savedRevision: 2 });
  });

  it("keeps the cached public snapshot immutable and stable while idle", () => {
    const controller = makeController();
    const persistence = createAppearancePreferencePersistence(controller, bridgeWithSave(async () => ({ status: "saved" })));
    const first = persistence.getSnapshot();
    expect(Object.isFrozen(first)).toBe(true);
    expect(persistence.getSnapshot()).toBe(first);
    persistence.connect();
    expect(persistence.getSnapshot()).toBe(first);
  });
});

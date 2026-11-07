import { invoke } from "@tauri-apps/api/core";
import {
  createAppearancePreferenceRecord,
  decodeAppearancePreferences,
  type AppearancePreferenceRecordV1,
} from "./appearance-preferences";

export const APPEARANCE_SETTINGS_COMMANDS = Object.freeze({
  load: "studio_appearance_preferences_load",
  save: "studio_appearance_preferences_save",
} as const);

export type AppearanceSettingsClosedReason =
  | "invalid-record"
  | "storage-unavailable"
  | "record-too-large";

export type AppearancePreferenceLoadReply =
  | { readonly status: "loaded"; readonly preferences: AppearancePreferenceRecordV1 }
  | { readonly status: "missing" }
  | { readonly status: "rejected"; readonly reason: AppearanceSettingsClosedReason };

export type AppearancePreferenceSaveReply =
  | { readonly status: "saved" }
  | { readonly status: "rejected"; readonly reason: AppearanceSettingsClosedReason };

export interface AppearanceSettingsBridge {
  load(): Promise<AppearancePreferenceLoadReply>;
  save(preferences: AppearancePreferenceRecordV1): Promise<AppearancePreferenceSaveReply>;
}

export type AppearanceSettingsBridgeErrorCode = "invalid-response" | "invalid-record";

export class AppearanceSettingsBridgeError extends Error {
  readonly code: AppearanceSettingsBridgeErrorCode;

  constructor(code: AppearanceSettingsBridgeErrorCode) {
    super(code === "invalid-record" ? "Appearance preference record rejected" : "Appearance settings response rejected");
    this.name = "AppearanceSettingsBridgeError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactOwnKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  let names: readonly string[];
  let symbols: readonly symbol[];
  try {
    names = Object.getOwnPropertyNames(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return false;
  }
  if (symbols.length > 0 || names.length !== expected.length) return false;
  const expectedSet = new Set(expected);
  return names.every((name) => expectedSet.has(name));
}

function closedReason(value: unknown): value is AppearanceSettingsClosedReason {
  return value === "invalid-record" || value === "storage-unavailable" || value === "record-too-large";
}

/** Copy a record through the existing strict V1 decoder before crossing a boundary. */
export function cloneAppearancePreferenceRecord(value: unknown): AppearancePreferenceRecordV1 {
  const decoded = decodeAppearancePreferences(value);
  if (!decoded.accepted) throw new AppearanceSettingsBridgeError("invalid-record");
  return decoded.record;
}

function validateLoadReply(value: unknown): AppearancePreferenceLoadReply {
  try {
    if (!isRecord(value) || typeof value.status !== "string") {
      throw new AppearanceSettingsBridgeError("invalid-response");
    }
    switch (value.status) {
      case "loaded":
        if (!hasExactOwnKeys(value, ["status", "preferences"])) {
          throw new AppearanceSettingsBridgeError("invalid-response");
        }
        return Object.freeze({
          status: "loaded" as const,
          preferences: cloneAppearancePreferenceRecord(value.preferences),
        });
      case "missing":
        if (!hasExactOwnKeys(value, ["status"])) {
          throw new AppearanceSettingsBridgeError("invalid-response");
        }
        return Object.freeze({ status: "missing" as const });
      case "rejected":
        if (!hasExactOwnKeys(value, ["status", "reason"]) || !closedReason(value.reason)) {
          throw new AppearanceSettingsBridgeError("invalid-response");
        }
        return Object.freeze({ status: "rejected" as const, reason: value.reason });
      default:
        throw new AppearanceSettingsBridgeError("invalid-response");
    }
  } catch (error) {
    if (error instanceof AppearanceSettingsBridgeError) throw error;
    throw new AppearanceSettingsBridgeError("invalid-response");
  }
}

function validateSaveReply(value: unknown): AppearancePreferenceSaveReply {
  try {
    if (!isRecord(value) || typeof value.status !== "string") {
      throw new AppearanceSettingsBridgeError("invalid-response");
    }
    switch (value.status) {
      case "saved":
        if (!hasExactOwnKeys(value, ["status"])) {
          throw new AppearanceSettingsBridgeError("invalid-response");
        }
        return Object.freeze({ status: "saved" as const });
      case "rejected":
        if (!hasExactOwnKeys(value, ["status", "reason"]) || !closedReason(value.reason)) {
          throw new AppearanceSettingsBridgeError("invalid-response");
        }
        return Object.freeze({ status: "rejected" as const, reason: value.reason });
      default:
        throw new AppearanceSettingsBridgeError("invalid-response");
    }
  } catch (error) {
    if (error instanceof AppearanceSettingsBridgeError) throw error;
    throw new AppearanceSettingsBridgeError("invalid-response");
  }
}

export function validateAppearancePreferenceLoadReply(value: unknown): AppearancePreferenceLoadReply {
  return validateLoadReply(value);
}

export function validateAppearancePreferenceSaveReply(value: unknown): AppearancePreferenceSaveReply {
  return validateSaveReply(value);
}

export class TauriAppearanceSettingsBridge implements AppearanceSettingsBridge {
  async load(): Promise<AppearancePreferenceLoadReply> {
    const raw = await invoke<unknown>(APPEARANCE_SETTINGS_COMMANDS.load);
    return validateLoadReply(raw);
  }

  async save(preferences: AppearancePreferenceRecordV1): Promise<AppearancePreferenceSaveReply> {
    const copied = cloneAppearancePreferenceRecord(preferences);
    const raw = await invoke<unknown>(APPEARANCE_SETTINGS_COMMANDS.save, { preferences: copied });
    return validateSaveReply(raw);
  }
}

export type AppearancePreferenceStartupStatus = "loaded" | "missing" | "rejected";

export interface AppearancePreferenceStartupLoad {
  readonly status: AppearancePreferenceStartupStatus;
  readonly record: AppearancePreferenceRecordV1;
  readonly reason?: AppearanceSettingsClosedReason;
}

/** Convert native load failure into an empty, closed fallback for startup callers. */
export async function loadAppearancePreferencesAtStartup(
  bridge: AppearanceSettingsBridge,
): Promise<AppearancePreferenceStartupLoad> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      bridge.load(),
      new Promise<AppearancePreferenceLoadReply>((resolve) => {
        timeout = setTimeout(() => resolve({ status: "rejected", reason: "storage-unavailable" }), 5_000);
      }),
    ]);
    if (reply.status === "loaded") {
      return Object.freeze({ status: "loaded" as const, record: cloneAppearancePreferenceRecord(reply.preferences) });
    }
    if (reply.status === "missing") {
      return Object.freeze({ status: "missing" as const, record: createAppearancePreferenceRecord() });
    }
    return Object.freeze({ status: "rejected" as const, record: createAppearancePreferenceRecord(), reason: reply.reason });
  } catch (error) {
    const reason: AppearanceSettingsClosedReason = error instanceof AppearanceSettingsBridgeError && error.code === "invalid-record"
      ? "invalid-record" : "storage-unavailable";
    return Object.freeze({ status: "rejected" as const, record: createAppearancePreferenceRecord(), reason });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

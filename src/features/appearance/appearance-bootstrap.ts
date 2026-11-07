import { createAppearanceController, type AppearanceCatalog, type AppearanceDisposeResult } from "./appearance-controller";
import { createAppearancePreferencePersistence } from "./appearance-persistence";
import { createAppearancePreferenceRecord } from "./appearance-preferences";
import { prepareAppearanceExternalCssomSlots, type AppearanceExternalCssomSlots } from "./appearance-external-cssom-slots";
import { loadAppearancePreferencesAtStartup, type AppearanceSettingsBridge, type AppearancePreferenceStartupLoad } from "./appearance-settings-bridge";

export interface AppearanceStartupOptions {
  readonly documentValue?: Document;
  readonly signal?: AbortSignal;
}

export interface AppearanceStylesheetStartupStatus {
  readonly status: "ready" | "rejected";
  readonly reason?: "unsupported-backend";
}

/** Assemble bounded settings before mount; an unread record cannot be overwritten. */
export async function createAppearanceStartupSession(
  catalog: AppearanceCatalog,
  bridge: AppearanceSettingsBridge | null,
  options: AppearanceStartupOptions = {},
) {
  const settingsPromise = bridge
    ? loadAppearancePreferencesAtStartup(bridge)
    : Promise.resolve<AppearancePreferenceStartupLoad | null>(null);
  const slotsPromise = bridge && options.documentValue
    ? prepareAppearanceExternalCssomSlots(options.documentValue, options.signal)
    : Promise.resolve<AppearanceExternalCssomSlots | null>(null);
  const [settingsResult, slotsResult] = await Promise.allSettled([settingsPromise, slotsPromise]);
  const startup = settingsResult.status === "fulfilled"
    ? settingsResult.value
    : Object.freeze({ status: "rejected" as const, record: createAppearancePreferenceRecord(), reason: "storage-unavailable" as const });
  const externalCssomSlots = slotsResult.status === "fulfilled" ? slotsResult.value : null;
  const stylesheetStartup: AppearanceStylesheetStartupStatus | null = bridge === null
    ? null
    : externalCssomSlots
      ? Object.freeze({ status: "ready" as const })
      : Object.freeze({ status: "rejected" as const, reason: "unsupported-backend" as const });
  let appearance: ReturnType<typeof createAppearanceController>;
  try {
    appearance = createAppearanceController(catalog, {
      ...(startup ? { preferences: startup.record } : {}),
      // The native CSP is style-src 'self'; do not report a style-element fallback as attached.
      allowStyleElementFallback: bridge === null,
      requireExternalBackend: bridge !== null,
      ...(externalCssomSlots ? { externalCssomSlots } : {}),
    });
  } catch (error) {
    // A prepared pool is startup-owned until the controller successfully
    // captures it. Do not leak its four inert links if catalog/controller
    // construction rejects the startup session.
    try { externalCssomSlots?.dispose(); } catch { /* preserve the original construction failure */ }
    throw error;
  }
  // A valid loaded record may still be saved after a later explicit user
  // action even when visual slot preparation was unavailable; no startup
  // action advances the preference revision or writes a record.
  const canSave = bridge !== null && startup !== null && startup.status !== "rejected";
  const persistence = canSave ? createAppearancePreferencePersistence(appearance, bridge) : null;
  let terminalResult: AppearanceDisposeResult | null = null;
  const dispose = (): AppearanceDisposeResult => {
    if (terminalResult) return terminalResult;
    const result = appearance.dispose();
    if (result.ok) terminalResult = result;
    return result;
  };
  return Object.freeze({ startup, appearance, persistence, stylesheetStartup, dispose });
}

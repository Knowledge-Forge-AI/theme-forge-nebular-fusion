import { describe, expect, it } from "vitest";
import { bundledAppearanceCatalog } from "../bundled-appearance-catalog";
import {
  createAppearancePreferenceRecord,
  decodeAppearancePreferences,
  resetAppearancePreferences,
  resolveAppearancePreferences,
  selectApplicationDefault,
  setAppearanceMode,
  setAppearancePair,
  setAppearanceSide,
  type AppearanceFamilyDefaults,
  type AppearancePreferenceRecordV1,
} from "../appearance-preferences";

const defaults: AppearanceFamilyDefaults = {
  light: "nebular",
  dark: "nebular",
  mode: "system",
};

function resolve(
  record: AppearancePreferenceRecordV1,
  familyDefaults: AppearanceFamilyDefaults = defaults,
  systemMode: "light" | "dark" = "light",
) {
  return resolveAppearancePreferences(
    decodeAppearancePreferences(record),
    bundledAppearanceCatalog,
    familyDefaults,
    systemMode,
  );
}

describe("versioned appearance preference records", () => {
  it("decodes a valid pair and resolves both concrete sides against the bundled catalog", () => {
    const decoded = decodeAppearancePreferences({
      version: 1,
      mode: "dark",
      light: "nebular",
      dark: "terminal-nova",
    });

    expect(decoded.accepted).toBe(true);
    expect(decoded.diagnostics).toEqual([]);
    expect(decoded.record).toEqual({
      version: 1,
      mode: "dark",
      light: "nebular",
      dark: "terminal-nova",
    });
    const resolved = resolveAppearancePreferences(decoded, bundledAppearanceCatalog, defaults, "light");
    expect(resolved.effectiveMode).toBe("dark");
    expect(resolved.resolvedFamilies.light?.id).toBe("nebular");
    expect(resolved.resolvedFamilies.dark?.id).toBe("terminal-nova");
    expect(resolved.diagnostics).toEqual([]);
  });

  it.each([
    [{ version: 2, mode: "system" }, "unsupported-version"],
    [{ version: "1", mode: "system" }, "invalid-version"],
    [{ version: 1, mode: "LIGHT" }, "invalid-mode"],
    [{ version: 1, mode: "system", extra: true }, "unknown-key"],
    [{ version: 1, mode: "dark", light: null }, "invalid-override"],
    [{ version: 1, mode: undefined }, "invalid-mode"],
    [null, "invalid-input"],
  ] as const)("rejects bounded invalid input with %s", (input, code) => {
    const decoded = decodeAppearancePreferences(input);
    expect(decoded.accepted).toBe(false);
    expect(decoded.diagnostics[0]?.code).toBe(code);
    if (code === "unknown-key") expect(decoded.diagnostics[0]).toEqual({ code });
    expect(decoded.record).toEqual({ version: 1 });
  });

  it("accepts an omitted mode but rejects an explicitly undefined mode", () => {
    const omitted = decodeAppearancePreferences({ version: 1, light: "nebular" });
    expect(omitted.accepted).toBe(true);
    expect(omitted.record).toEqual({ version: 1, light: "nebular" });

    const explicitUndefined = decodeAppearancePreferences({ version: 1, mode: undefined });
    expect(explicitUndefined.accepted).toBe(false);
    expect(explicitUndefined.diagnostics).toEqual([{ code: "invalid-mode" }]);
    expect(explicitUndefined.record).toEqual({ version: 1 });
  });

  it("rejects family IDs outside the bounded record length while retaining valid obsolete IDs", () => {
    const tooLong = decodeAppearancePreferences({ version: 1, light: "x".repeat(129) });
    expect(tooLong.accepted).toBe(false);
    expect(tooLong.diagnostics).toEqual([{ code: "invalid-override", side: "light" }]);

    const obsoleteAtLimit = "x".repeat(128);
    const retained = decodeAppearancePreferences({ version: 1, light: obsoleteAtLimit });
    expect(retained.accepted).toBe(true);
    expect(retained.record.light).toBe(obsoleteAtLimit);
  });

  it("retains an obsolete override in the decoded record while resolving that side to its default", () => {
    const decoded = decodeAppearancePreferences({
      version: 1,
      mode: "light",
      light: "retired-family",
      dark: "terminal-nova",
    });
    expect(decoded.accepted).toBe(true);
    expect(decoded.record.light).toBe("retired-family");

    const resolved = resolveAppearancePreferences(decoded, bundledAppearanceCatalog, defaults, "dark");
    expect(resolved.record.light).toBe("retired-family");
    expect(resolved.resolvedFamilies.light?.id).toBe("nebular");
    expect(resolved.resolvedFamilies.dark?.id).toBe("terminal-nova");
    expect(resolved.effectiveMode).toBe("light");
    expect(resolved.diagnostics).toContainEqual({
      code: "missing-family",
      side: "light",
      familyId: "retired-family",
      fallbackFamilyId: "nebular",
    });
  });

  it("resolves each side independently when application defaults change, while explicit overrides survive", () => {
    const noOverrides = createAppearancePreferenceRecord("system");
    const firstDefaults: AppearanceFamilyDefaults = {
      light: "nebular",
      dark: "terminal-nova",
      mode: "system",
    };
    const changedDefaults: AppearanceFamilyDefaults = {
      light: "terminal-nova",
      dark: "nebular",
      mode: "system",
    };
    const first = resolve(noOverrides, firstDefaults);
    const changed = resolve(noOverrides, changedDefaults);
    expect(first.resolvedFamilies.light?.id).toBe("nebular");
    expect(first.resolvedFamilies.dark?.id).toBe("terminal-nova");
    expect(changed.resolvedFamilies.light?.id).toBe("terminal-nova");
    expect(changed.resolvedFamilies.dark?.id).toBe("nebular");

    const explicitLight = setAppearanceSide(noOverrides, "light", "nebular");
    const explicitAfterDefaultChange = resolve(explicitLight, changedDefaults);
    expect(explicitAfterDefaultChange.resolvedFamilies.light?.id).toBe("nebular");
    expect(explicitAfterDefaultChange.resolvedFamilies.dark?.id).toBe("nebular");
  });

  it("lets an absent mode follow changed application defaults while explicit System remains explicit", () => {
    const modeLightDefaults: AppearanceFamilyDefaults = {
      light: "nebular",
      dark: "nebular",
      mode: "light",
    };
    const modeDarkDefaults: AppearanceFamilyDefaults = {
      light: "nebular",
      dark: "nebular",
      mode: "dark",
    };
    const absentMode = createAppearancePreferenceRecord();
    expect(absentMode).toEqual({ version: 1 });
    expect(resolve(absentMode, modeLightDefaults, "dark").modePreference).toBe("light");
    expect(resolve(absentMode, modeLightDefaults, "dark").effectiveMode).toBe("light");
    expect(resolve(absentMode, modeDarkDefaults, "light").modePreference).toBe("dark");
    expect(resolve(absentMode, modeDarkDefaults, "light").effectiveMode).toBe("dark");

    const explicitSystem = setAppearanceMode(absentMode, "system");
    expect(resolve(explicitSystem, modeDarkDefaults, "light").modePreference).toBe("system");
    expect(resolve(explicitSystem, modeDarkDefaults, "light").effectiveMode).toBe("light");
  });

  it("keeps paired and side setters separate, while Application default and Reset clear the required fields", () => {
    const initial = createAppearancePreferenceRecord("dark");
    const pair = setAppearancePair(initial, "nebular", "terminal-nova");
    expect(pair).toEqual({ version: 1, mode: "dark", light: "nebular", dark: "terminal-nova" });
    expect(initial).toEqual({ version: 1, mode: "dark" });

    const lightOnly = setAppearanceSide(pair, "light", "terminal-nova");
    expect(lightOnly).toEqual({ version: 1, mode: "dark", light: "terminal-nova", dark: "terminal-nova" });
    const darkOnly = setAppearanceSide(lightOnly, "dark", "nebular");
    expect(darkOnly).toEqual({ version: 1, mode: "dark", light: "terminal-nova", dark: "nebular" });

    const applicationDefault = selectApplicationDefault(darkOnly);
    expect(applicationDefault).toEqual({ version: 1, mode: "dark" });
    const reset = resetAppearancePreferences(darkOnly);
    expect(reset).toEqual({ version: 1 });

    const lightMode = setAppearanceMode(darkOnly, "light");
    expect(lightMode).toEqual({ version: 1, mode: "light", light: "terminal-nova", dark: "nebular" });
  });

  it("resolves System independently from explicit mode preferences", () => {
    const system = createAppearancePreferenceRecord("system");
    expect(resolve(system, defaults, "light").effectiveMode).toBe("light");
    expect(resolve(system, defaults, "dark").effectiveMode).toBe("dark");

    const explicitDark = setAppearanceMode(system, "dark");
    expect(resolve(explicitDark, defaults, "light").effectiveMode).toBe("dark");
  });

  it("freezes public outputs and snapshots mutable input boundaries", () => {
    const mutableInput: { version: number; mode: "dark"; light: string } = {
      version: 1,
      mode: "dark",
      light: "nebular",
    };
    const decoded = decodeAppearancePreferences(mutableInput);
    mutableInput.light = "terminal-nova";
    expect(decoded.record.light).toBe("nebular");
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.record)).toBe(true);
    expect(Object.isFrozen(decoded.diagnostics)).toBe(true);

    const mutableDefaults: { light: string; dark: string; mode: "system" } = {
      light: "nebular",
      dark: "terminal-nova",
      mode: "system",
    };
    const mutableCatalog = {
      defaultFamily: bundledAppearanceCatalog.defaultFamily,
      families: bundledAppearanceCatalog.families.map((family) => ({ ...family })),
    };
    const resolved = resolveAppearancePreferences(decoded, mutableCatalog, mutableDefaults, "light");
    mutableDefaults.light = "terminal-nova";
    mutableCatalog.families[0]!.css = "mutated-after-resolution";
    expect(resolved.resolvedFamilies.light?.id).toBe("nebular");
    expect(resolved.resolvedFamilies.light?.css).not.toBe("mutated-after-resolution");
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.resolvedFamilies)).toBe(true);
    expect(Object.isFrozen(resolved.resolvedFamilies.light)).toBe(true);
    expect(Object.isFrozen(resolved.diagnostics)).toBe(true);

    expect(Object.isFrozen(setAppearancePair(decoded.record, "nebular", "terminal-nova"))).toBe(true);
  });

  it("reports closed fallback diagnostics when defaults or system input are unusable", () => {
    const decoded = decodeAppearancePreferences({ version: 1, mode: "system" });
    const resolved = resolveAppearancePreferences(
      decoded,
      bundledAppearanceCatalog,
      { light: "missing-default", dark: "terminal-nova", mode: "system" },
      "sepia" as never,
    );
    expect(resolved.resolvedFamilies.light?.id).toBe("nebular");
    expect(resolved.resolvedFamilies.dark?.id).toBe("terminal-nova");
    expect(resolved.effectiveMode).toBe("light");
    expect(resolved.diagnostics).toContainEqual({
      code: "invalid-default",
      side: "light",
      familyId: "missing-default",
      fallbackFamilyId: "nebular",
    });
    expect(resolved.diagnostics).toContainEqual({ code: "invalid-system-mode" });
  });
});

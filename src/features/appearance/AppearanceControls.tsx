import { useSyncExternalStore } from "react";
import type { AppearanceModePreference } from "./appearance-session";
import type { AppearanceController } from "./appearance-controller";
import type { AppearancePreferencePersistence } from "./appearance-persistence";
import type { AppearancePreferenceStartupStatus } from "./appearance-settings-bridge";
import { AnimeApplicationArtwork } from "./AnimeApplicationArtwork";

const SESSION_ONLY = Object.freeze({ status: "idle" as const, savedRevision: 0 });
const emptySubscribe = () => () => undefined;
const sessionSnapshot = () => SESSION_ONLY;

export function AppearanceControls({ appearance, persistence, startupStatus }: {
  readonly appearance: AppearanceController;
  readonly persistence?: AppearancePreferencePersistence;
  readonly startupStatus?: AppearancePreferenceStartupStatus;
}) {
  const state = useSyncExternalStore(appearance.subscribe, appearance.getSnapshot, appearance.getSnapshot);
  const saved = useSyncExternalStore(persistence?.subscribe ?? emptySubscribe, persistence?.getSnapshot ?? sessionSnapshot, sessionSnapshot);
  const label = (id: string) => appearance.catalog.families.find((family) => family.id === id)?.label ?? "Bundled";
  const defaults = appearance.catalog.defaults;
  const defaultLabel = defaults.light === defaults.dark ? label(defaults.light) : `${label(defaults.light)} / ${label(defaults.dark)}`;
  const selectionValue = state.selection.kind === "application-default" ? "" : state.selection.kind === "pair-override" ? state.selection.id : "__custom";
  const selectedPairId = state.selection.kind === "pair-override" ? state.selection.id : undefined;
  const controlsDisabled = state.problem === "unsupported-backend";
  const changeSide = (side: "light" | "dark", value: string) => {
    const light = side === "light" ? value || undefined : state.preferences.light;
    const dark = side === "dark" ? value || undefined : state.preferences.dark;
    appearance.change({ kind: "select-custom-pair", ...(light === undefined ? {} : { light }), ...(dark === undefined ? {} : { dark }) });
  };
  return <section className="application-appearance-controls" aria-label="Application appearance">
    <label>Appearance <select aria-label="Application appearance" value={selectionValue}
      disabled={controlsDisabled}
      onChange={(event) => appearance.change(event.target.value === "" ? { kind: "select-application-default" } : { kind: "select-pair", pairId: event.target.value })}>
      <option value="">Application default ({defaultLabel})</option>
      {selectedPairId !== undefined && !appearance.catalog.families.some((family) => family.id === selectedPairId)
        ? <option value={selectedPairId} disabled>Saved appearance unavailable</option> : null}
      {state.selection.kind === "custom-pair" ? <option value="__custom" disabled>Custom light/dark pair</option> : null}
      {appearance.catalog.families.map((family) => <option key={family.id} value={family.id}>{family.label}</option>)}
    </select></label>
    <label>Display <select aria-label="Application display mode" value={state.preferences.mode ?? ""}
      disabled={controlsDisabled}
      // Returning to the product mode default is provided by Reset appearance.
      onChange={(event) => appearance.change({ kind: "set-mode-preference", preference: event.target.value as AppearanceModePreference })}>
      <option value="" disabled>Application default ({defaults.mode === "system" ? "System" : defaults.mode === "light" ? "Light" : "Dark"})</option>
      <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
    </select></label>
    <details className="appearance-custom-pair"><summary>Choose light and dark separately</summary>
      {(["light", "dark"] as const).map((side) => <label key={side}>{side === "light" ? "Light" : "Dark"} appearance <select
        aria-label={`${side === "light" ? "Light" : "Dark"} appearance`} value={state.preferences[side] ?? ""} disabled={controlsDisabled}
        onChange={(event) => changeSide(side, event.target.value)}>
        <option value="">Application default ({label(defaults[side])})</option>
        {state.preferences[side] !== undefined && !appearance.catalog.families.some((family) => family.id === state.preferences[side])
          ? <option value={state.preferences[side]} disabled>Saved appearance unavailable</option> : null}
        {appearance.catalog.families.map((family) => <option key={family.id} value={family.id}>{family.label}</option>)}
      </select></label>)}
    </details>
    <AnimeApplicationArtwork
      visible={state.attached && state.problem === null && state.resolvedFamilies[state.effectiveMode] === "anime"}
    />
    <button type="button" disabled={controlsDisabled} onClick={() => appearance.change({ kind: "reset" })}>Reset appearance</button>
    {saved.status === "saving" ? <p role="status">Saving appearance…</p> : null}
    {saved.status === "saved" ? <p role="status">Appearance saved on this device.</p> : null}
    {saved.status === "failed" ? <p role="alert">The appearance is active for this session but could not be saved.</p> : null}
    {startupStatus === "rejected" && saved.status === "idle" ? <p role="status">Saved preferences are unavailable. Changes will stay in this session.</p> : null}
    {state.preferenceDiagnostics.length > 0 ? <p role="status">Some saved appearance preferences could not be used. Bundled defaults are in use for those choices.</p> : null}
    {state.hasDraft ? <span role="status">Unsaved theme draft is active.</span> : null}
    {state.problem ? <p role="alert">{state.problem === "recovery-required"
      ? "Appearance recovery is needed. Reload the application before trying again."
      : state.problem === "unsupported-backend" ? "The native appearance stylesheet backend is unavailable. The bundled static appearance remains in use and saved preferences are retained; changes are disabled until it is available."
      : state.problem === "unavailable-family" ? "That appearance is unavailable. Choose a bundled appearance."
      : "The appearance change could not be applied. The previous appearance is retained."}</p> : null}
  </section>;
}

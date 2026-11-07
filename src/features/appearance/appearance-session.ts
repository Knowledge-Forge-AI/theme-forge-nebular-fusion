/**
 * Pure session-appearance ownership state for the Studio integration.
 *
 * A caller prepares a plan, performs its synchronous validation and stylesheet
 * transaction, then commits ownership through this state boundary.
 */

export type AppearanceModePreference = "system" | "light" | "dark";
export type EffectiveAppearanceMode = Exclude<AppearanceModePreference, "system">;

/**
 * Family identifiers are stable catalog keys persisted in user preferences.
 * They identify installed appearances independently of authored profile versions.
 */
export type AppearanceSelection =
  | { readonly kind: "application-default" }
  | { readonly kind: "pair-override"; readonly id: string }
  | {
      readonly kind: "custom-pair";
      /** Omitted means use the application's light-side default. */
      readonly light?: string;
      /** Omitted means use the application's dark-side default. */
      readonly dark?: string;
    };

export type AppearanceChangeIntent =
  | { readonly kind: "select-application-default" }
  | { readonly kind: "select-pair"; readonly pairId: string }
  | {
      readonly kind: "select-custom-pair";
      /** Omitted means use the application's light-side default. */
      readonly light?: string;
      /** Omitted means use the application's dark-side default. */
      readonly dark?: string;
    }
  | { readonly kind: "set-mode-preference"; readonly preference: AppearanceModePreference }
  | { readonly kind: "set-system-mode"; readonly mode: EffectiveAppearanceMode }
  | { readonly kind: "reset" };

declare const editorHandleBrand: unique symbol;

/** Opaque lifetime identity for one mounted editor owner. */
export interface EditorHandle {
  readonly [editorHandleBrand]: never;
}

declare const applyEligibilityBrand: unique symbol;

/** Opaque eligibility captured for one deliberate synchronous Apply. */
export interface ApplyEligibility {
  readonly [applyEligibilityBrand]: never;
}

declare const appearancePlanBrand: unique symbol;

/**
 * Effect-free appearance transition plan. Its opaque identity is scoped to
 * the session that created it and is checked again at commit.
 */
export interface AppearanceChangePlan {
  readonly [appearancePlanBrand]: never;
  readonly intent: AppearanceChangeIntent;
  readonly nextSnapshot: AppearanceSnapshot;
  readonly changed: boolean;
  readonly draftWillRelease: boolean;
  readonly eligibilityInvalidated: boolean;
}

export interface AppearanceSessionOptions {
  readonly initialSystemMode?: EffectiveAppearanceMode;
  /** Default mode preference restored by Reset; invalid runtime values use System. */
  readonly defaultModePreference?: AppearanceModePreference;
  /** Initial mode preference; invalid runtime values use defaultModePreference. */
  readonly initialModePreference?: AppearanceModePreference;
  /** Initial selection is copied and normalized; invalid runtime values use Application default. */
  readonly initialSelection?: AppearanceSelection;
}

export interface AppearanceSnapshot {
  readonly selection: AppearanceSelection;
  readonly modePreference: AppearanceModePreference;
  readonly systemMode: EffectiveAppearanceMode;
  readonly effectiveMode: EffectiveAppearanceMode;
  readonly hasDraft: boolean;
  /**
   * Monotonic invalidation counter for selection/effective-mode/reset
   * transitions.  It is exposed for integration diagnostics; callers should
   * treat it as an opaque epoch, not a catalog or document version.
   */
  readonly appearanceEpoch: number;
}

export type AppearanceTransitionKind =
  | "selection-changed"
  | "mode-preference-changed"
  | "system-mode-changed"
  | "effective-mode-changed"
  | "reset"
  | "draft-eligible"
  | "draft-applied"
  | "draft-released"
  | "editor-disposed"
  | "unchanged"
  | "rejected";

export type AppearanceTransitionReason =
  | "unknown-owner"
  | "owner-disposed"
  | "unknown-eligibility"
  | "eligibility-owner-mismatch"
  | "stale-eligibility"
  | "draft-owned-by-another-owner"
  | "unknown-plan"
  | "stale-plan"
  | "invalid-mode"
  | "invalid-intent";

export interface AppearanceTransition {
  readonly accepted: boolean;
  /**
   * True when session or owner-eligibility state changed. It need not imply a
   * new public snapshot; React subscribers should compare getSnapshot()
   * identity instead.
   */
  readonly changed: boolean;
  readonly kind: AppearanceTransitionKind;
  readonly draftReleased: boolean;
  /** True when an owner token or all appearance tokens became invalid. */
  readonly eligibilityInvalidated: boolean;
  readonly snapshot: AppearanceSnapshot;
  readonly reason?: AppearanceTransitionReason;
}

export interface AppearanceSession {
  getSnapshot(): AppearanceSnapshot;
  registerEditor(): EditorHandle;
  disposeEditor(owner: EditorHandle): AppearanceTransition;
  isDraftOwner(owner: EditorHandle): boolean;

  /** Prepare before an owned stylesheet transaction; this never mutates. */
  prepareAppearanceChange(intent: AppearanceChangeIntent): AppearanceChangePlan | null;
  /** Commit only the still-current plan; stale or foreign plans are rejected. */
  commitAppearanceChange(plan: AppearanceChangePlan): AppearanceTransition;

  /** Convenience action for callers that do not need a separate transaction. */
  selectApplicationDefault(): AppearanceTransition;
  /** Convenience action for callers that do not need a separate transaction. */
  selectPair(pairId: string): AppearanceTransition;
  /** Convenience action for callers that do not need a separate transaction. */
  selectCustomPair(light?: string, dark?: string): AppearanceTransition;
  /** Convenience action for callers that do not need a separate transaction. */
  setModePreference(preference: AppearanceModePreference): AppearanceTransition;
  /** Convenience action for callers that do not need a separate transaction. */
  setSystemMode(mode: EffectiveAppearanceMode): AppearanceTransition;
  /** Convenience action for callers that do not need a separate transaction. */
  reset(): AppearanceTransition;

  captureApplyEligibility(owner: EditorHandle): ApplyEligibility | null;
  validateDraftApplication(owner: EditorHandle, eligibility: ApplyEligibility): AppearanceTransition;
  applyDraft(owner: EditorHandle, eligibility: ApplyEligibility): AppearanceTransition;
  releaseDraft(owner: EditorHandle): AppearanceTransition;
}

const APPLICATION_DEFAULT: AppearanceSelection = Object.freeze({
  kind: "application-default",
} as const);
const MAX_FAMILY_ID_LENGTH = 128;

interface OwnerRecord {
  disposed: boolean;
  eligibilityEpoch: number;
}

interface EligibilityRecord {
  readonly owner: EditorHandle;
  readonly appearanceEpoch: number;
  readonly ownerEligibilityEpoch: number;
}

interface InternalPlanRecord {
  readonly baseSnapshot: AppearanceSnapshot;
  readonly baseStateRevision: number;
  readonly intent: AppearanceChangeIntent;
  readonly nextSelection: AppearanceSelection;
  readonly nextModePreference: AppearanceModePreference;
  readonly nextSystemMode: EffectiveAppearanceMode;
  readonly nextEffectiveMode: EffectiveAppearanceMode;
  readonly nextAppearanceEpoch: number;
  readonly draftWillRelease: boolean;
  readonly eligibilityInvalidated: boolean;
  readonly changed: boolean;
  readonly kind: AppearanceTransitionKind;
  committed: boolean;
}

interface TransitionOptions {
  readonly accepted?: boolean;
  readonly changed?: boolean;
  readonly draftReleased?: boolean;
  readonly eligibilityInvalidated?: boolean;
  readonly reason?: AppearanceTransitionReason;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isModePreference(value: unknown): value is AppearanceModePreference {
  return value === "system" || value === "light" || value === "dark";
}

function isEffectiveAppearanceMode(value: unknown): value is EffectiveAppearanceMode {
  return value === "light" || value === "dark";
}

function isFamilyId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FAMILY_ID_LENGTH;
}

function makeCustomSelection(
  light: string | undefined,
  dark: string | undefined,
): AppearanceSelection {
  if (light === undefined && dark === undefined) return APPLICATION_DEFAULT;
  if (light !== undefined && light === dark) return Object.freeze({ kind: "pair-override", id: light } as const);
  return Object.freeze({
    kind: "custom-pair",
    ...(light === undefined ? {} : { light }),
    ...(dark === undefined ? {} : { dark }),
  }) as AppearanceSelection;
}

function normalizeSelection(value: unknown): AppearanceSelection | null {
  if (!isRecord(value)) return null;

  switch (value.kind) {
    case "application-default":
      return APPLICATION_DEFAULT;
    case "pair-override": {
      const id = value.id;
      return isFamilyId(id)
        ? Object.freeze({ kind: "pair-override", id } as const)
        : null;
    }
    case "custom-pair": {
      const light = value.light;
      const dark = value.dark;
      if (light !== undefined && !isFamilyId(light)) return null;
      if (dark !== undefined && !isFamilyId(dark)) return null;
      return makeCustomSelection(light, dark);
    }
    default:
      return null;
  }
}

function sameSelection(left: AppearanceSelection, right: AppearanceSelection): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "application-default":
      return true;
    case "pair-override":
      return right.kind === "pair-override" && left.id === right.id;
    case "custom-pair":
      return right.kind === "custom-pair" && left.light === right.light && left.dark === right.dark;
  }
  return false;
}

function resolveEffectiveMode(
  preference: AppearanceModePreference,
  systemMode: EffectiveAppearanceMode,
): EffectiveAppearanceMode {
  return preference === "system" ? systemMode : preference;
}

function makeEditorHandle(): EditorHandle {
  return Object.freeze({}) as EditorHandle;
}

function makeEligibility(): ApplyEligibility {
  return Object.freeze({}) as ApplyEligibility;
}

function invalidIntentReason(intent: unknown): "invalid-mode" | "invalid-intent" {
  if (
    isRecord(intent) &&
    (intent.kind === "set-mode-preference" || intent.kind === "set-system-mode")
  ) {
    return "invalid-mode";
  }
  return "invalid-intent";
}

function normalizeIntent(intent: AppearanceChangeIntent): AppearanceChangeIntent | null {
  if (!isRecord(intent)) return null;
  const kind = intent.kind;
  if (typeof kind !== "string") return null;

  switch (kind) {
    case "select-application-default":
      return Object.freeze({ kind: "select-application-default" } as const);
    case "select-pair": {
      const pairId = intent.pairId;
      return isFamilyId(pairId)
        ? Object.freeze({ kind: "select-pair", pairId } as const)
        : null;
    }
    case "select-custom-pair": {
      const light = intent.light;
      const dark = intent.dark;
      if (light !== undefined && !isFamilyId(light)) return null;
      if (dark !== undefined && !isFamilyId(dark)) return null;
      return Object.freeze({
        kind: "select-custom-pair",
        ...(light === undefined ? {} : { light }),
        ...(dark === undefined ? {} : { dark }),
      }) as AppearanceChangeIntent;
    }
    case "set-mode-preference": {
      const preference = intent.preference;
      return isModePreference(preference)
        ? Object.freeze({ kind: "set-mode-preference", preference } as const)
        : null;
    }
    case "set-system-mode": {
      const mode = intent.mode;
      return isEffectiveAppearanceMode(mode)
        ? Object.freeze({ kind: "set-system-mode", mode } as const)
        : null;
    }
    case "reset":
      return Object.freeze({ kind: "reset" } as const);
    default:
      return null;
  }
}

export function createAppearanceSession(
  options: AppearanceSessionOptions = {},
): AppearanceSession {
  const optionRecord = isRecord(options) ? options : undefined;
  const initialSystemModeCandidate = optionRecord?.initialSystemMode;
  const initialSystemMode = isEffectiveAppearanceMode(initialSystemModeCandidate)
    ? initialSystemModeCandidate
    : "light";
  const defaultModePreferenceCandidate = optionRecord?.defaultModePreference;
  const defaultModePreference = isModePreference(defaultModePreferenceCandidate)
    ? defaultModePreferenceCandidate
    : "system";
  const initialModePreferenceCandidate = optionRecord?.initialModePreference;
  const initialModePreference = isModePreference(initialModePreferenceCandidate)
    ? initialModePreferenceCandidate
    : defaultModePreference;
  const initialSelection = normalizeSelection(optionRecord?.initialSelection) ?? APPLICATION_DEFAULT;
  let selection: AppearanceSelection = initialSelection;
  let modePreference: AppearanceModePreference = initialModePreference;
  let systemMode: EffectiveAppearanceMode = initialSystemMode;
  let effectiveMode = resolveEffectiveMode(modePreference, systemMode);
  let appearanceEpoch = 0;
  let stateRevision = 0;
  let draftOwner: EditorHandle | null = null;

  const owners = new WeakMap<EditorHandle, OwnerRecord>();
  const eligibilities = new WeakMap<ApplyEligibility, EligibilityRecord>();
  const plans = new WeakMap<AppearanceChangePlan, InternalPlanRecord>();

  let snapshot = makeSnapshot();

  function makeSnapshot(): AppearanceSnapshot {
    return Object.freeze({
      selection,
      modePreference,
      systemMode,
      effectiveMode,
      hasDraft: draftOwner !== null,
      appearanceEpoch,
    });
  }

  function refreshSnapshot(): void {
    snapshot = makeSnapshot();
  }

  function transition(
    kind: AppearanceTransitionKind,
    options: TransitionOptions = {},
  ): AppearanceTransition {
    const result: AppearanceTransition = {
      accepted: options.accepted ?? true,
      changed: options.changed ?? true,
      kind,
      draftReleased: options.draftReleased ?? false,
      eligibilityInvalidated: options.eligibilityInvalidated ?? false,
      snapshot,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    };
    return Object.freeze(result);
  }

  function unchanged(): AppearanceTransition {
    return transition("unchanged", { changed: false });
  }

  function rejected(reason: AppearanceTransitionReason): AppearanceTransition {
    return transition("rejected", {
      accepted: false,
      changed: false,
      reason,
    });
  }

  function currentOwner(owner: EditorHandle): OwnerRecord | undefined {
    return owners.get(owner);
  }

  function draftApplicationFailure(
    owner: EditorHandle,
    eligibility: ApplyEligibility,
  ): AppearanceTransitionReason | undefined {
    const record = currentOwner(owner);
    if (!record) return "unknown-owner";
    if (record.disposed) return "owner-disposed";
    const captured = eligibilities.get(eligibility);
    if (!captured) return "unknown-eligibility";
    if (captured.owner !== owner) return "eligibility-owner-mismatch";
    if (captured.appearanceEpoch !== appearanceEpoch ||
        captured.ownerEligibilityEpoch !== record.eligibilityEpoch) return "stale-eligibility";
    if (draftOwner !== null && draftOwner !== owner) return "draft-owned-by-another-owner";
    return undefined;
  }

  function clearDraft(): boolean {
    const hadDraft = draftOwner !== null;
    draftOwner = null;
    return hadDraft;
  }

  function preparePlan(intent: AppearanceChangeIntent): AppearanceChangePlan {
    const currentHasDraft = draftOwner !== null;
    let nextSelection = selection;
    let nextModePreference = modePreference;
    let nextSystemMode = systemMode;
    let nextEffectiveMode = effectiveMode;
    let nextAppearanceEpoch = appearanceEpoch;
    let draftWillRelease = false;
    let eligibilityInvalidated = false;
    let changed = false;
    let kind: AppearanceTransitionKind = "unchanged";

    switch (intent.kind) {
      case "select-application-default":
        if (!sameSelection(selection, APPLICATION_DEFAULT)) {
          nextSelection = APPLICATION_DEFAULT;
          draftWillRelease = currentHasDraft;
          eligibilityInvalidated = true;
          nextAppearanceEpoch += 1;
          changed = true;
          kind = "selection-changed";
        }
        break;
      case "select-pair":
        {
          const candidate = Object.freeze({ kind: "pair-override", id: intent.pairId } as const);
          if (sameSelection(selection, candidate)) break;
          nextSelection = candidate;
          draftWillRelease = currentHasDraft;
          eligibilityInvalidated = true;
          nextAppearanceEpoch += 1;
          changed = true;
          kind = "selection-changed";
        }
        break;
      case "select-custom-pair":
        {
          const candidate = makeCustomSelection(intent.light, intent.dark);
          if (sameSelection(selection, candidate)) break;
          nextSelection = candidate;
          draftWillRelease = currentHasDraft;
          eligibilityInvalidated = true;
          nextAppearanceEpoch += 1;
          changed = true;
          kind = "selection-changed";
        }
        break;
      case "set-mode-preference":
        if (modePreference !== intent.preference) {
          nextModePreference = intent.preference;
          nextEffectiveMode = resolveEffectiveMode(intent.preference, systemMode);
          changed = true;
          if (nextEffectiveMode !== effectiveMode) {
            draftWillRelease = currentHasDraft;
            eligibilityInvalidated = true;
            nextAppearanceEpoch += 1;
            kind = "effective-mode-changed";
          } else {
            kind = "mode-preference-changed";
          }
        }
        break;
      case "set-system-mode":
        if (systemMode !== intent.mode) {
          nextSystemMode = intent.mode;
          nextEffectiveMode = resolveEffectiveMode(modePreference, intent.mode);
          changed = true;
          if (nextEffectiveMode !== effectiveMode) {
            draftWillRelease = currentHasDraft;
            eligibilityInvalidated = true;
            nextAppearanceEpoch += 1;
            kind = "effective-mode-changed";
          } else {
            kind = "system-mode-changed";
          }
        }
        break;
      case "reset":
        nextSelection = APPLICATION_DEFAULT;
        nextModePreference = defaultModePreference;
        nextEffectiveMode = resolveEffectiveMode(defaultModePreference, nextSystemMode);
        draftWillRelease = currentHasDraft;
        eligibilityInvalidated = true;
        nextAppearanceEpoch += 1;
        changed = true;
        kind = "reset";
        break;
    }

    const nextSnapshot: AppearanceSnapshot = Object.freeze({
      selection: nextSelection,
      modePreference: nextModePreference,
      systemMode: nextSystemMode,
      effectiveMode: nextEffectiveMode,
      hasDraft: currentHasDraft && !draftWillRelease,
      appearanceEpoch: nextAppearanceEpoch,
    });
    const plan = Object.freeze({
      intent,
      nextSnapshot,
      changed,
      draftWillRelease,
      eligibilityInvalidated,
    }) as AppearanceChangePlan;

    plans.set(plan, {
      baseSnapshot: snapshot,
      baseStateRevision: stateRevision,
      intent,
      nextSelection,
      nextModePreference,
      nextSystemMode,
      nextEffectiveMode,
      nextAppearanceEpoch,
      draftWillRelease,
      eligibilityInvalidated,
      changed,
      kind,
      committed: false,
    });
    return plan;
  }

  function commitPlan(plan: AppearanceChangePlan): AppearanceTransition {
    const record = plans.get(plan);
    if (!record) return rejected("unknown-plan");
    if (
      record.committed ||
      record.baseSnapshot !== snapshot ||
      record.baseStateRevision !== stateRevision
    ) {
      return rejected("stale-plan");
    }

    record.committed = true;
    if (!record.changed) return unchanged();

    selection = record.nextSelection;
    modePreference = record.nextModePreference;
    systemMode = record.nextSystemMode;
    effectiveMode = record.nextEffectiveMode;
    appearanceEpoch = record.nextAppearanceEpoch;
    const draftReleased = record.draftWillRelease ? clearDraft() : false;
    stateRevision += 1;
    refreshSnapshot();

    return transition(record.kind, {
      draftReleased,
      eligibilityInvalidated: record.eligibilityInvalidated,
    });
  }

  function commitIntent(intent: AppearanceChangeIntent): AppearanceTransition {
    const normalized = normalizeIntent(intent);
    if (!normalized) return rejected(invalidIntentReason(intent));
    return commitPlan(preparePlan(normalized));
  }

  const session: AppearanceSession = {
    getSnapshot(): AppearanceSnapshot {
      return snapshot;
    },

    registerEditor(): EditorHandle {
      const handle = makeEditorHandle();
      owners.set(handle, { disposed: false, eligibilityEpoch: 0 });
      return handle;
    },

    disposeEditor(owner: EditorHandle): AppearanceTransition {
      const record = currentOwner(owner);
      if (!record) return rejected("unknown-owner");
      if (record.disposed) return rejected("owner-disposed");

      record.disposed = true;
      const draftReleased = draftOwner === owner && clearDraft();
      stateRevision += 1;
      if (draftReleased) refreshSnapshot();

      return transition("editor-disposed", {
        changed: true,
        draftReleased,
        eligibilityInvalidated: true,
      });
    },

    isDraftOwner(owner: EditorHandle): boolean {
      return draftOwner === owner;
    },

    prepareAppearanceChange(intent: AppearanceChangeIntent): AppearanceChangePlan | null {
      const normalized = normalizeIntent(intent);
      return normalized ? preparePlan(normalized) : null;
    },

    commitAppearanceChange(plan: AppearanceChangePlan): AppearanceTransition {
      return commitPlan(plan);
    },

    selectApplicationDefault(): AppearanceTransition {
      return commitIntent({ kind: "select-application-default" });
    },

    selectPair(pairId: string): AppearanceTransition {
      return commitIntent({ kind: "select-pair", pairId });
    },

    selectCustomPair(light?: string, dark?: string): AppearanceTransition {
      return commitIntent({
        kind: "select-custom-pair",
        ...(light === undefined ? {} : { light }),
        ...(dark === undefined ? {} : { dark }),
      } as AppearanceChangeIntent);
    },

    setModePreference(preference: AppearanceModePreference): AppearanceTransition {
      return commitIntent({ kind: "set-mode-preference", preference });
    },

    setSystemMode(mode: EffectiveAppearanceMode): AppearanceTransition {
      return commitIntent({ kind: "set-system-mode", mode });
    },

    reset(): AppearanceTransition {
      return commitIntent({ kind: "reset" });
    },

    captureApplyEligibility(owner: EditorHandle): ApplyEligibility | null {
      const record = currentOwner(owner);
      if (!record || record.disposed) return null;

      const eligibility = makeEligibility();
      eligibilities.set(eligibility, {
        owner,
        appearanceEpoch,
        ownerEligibilityEpoch: record.eligibilityEpoch,
      });
      return eligibility;
    },

    validateDraftApplication(owner: EditorHandle, eligibility: ApplyEligibility): AppearanceTransition {
      const reason = draftApplicationFailure(owner, eligibility);
      return reason ? rejected(reason) : transition("draft-eligible", { changed: false });
    },

    applyDraft(owner: EditorHandle, eligibility: ApplyEligibility): AppearanceTransition {
      const reason = draftApplicationFailure(owner, eligibility);
      if (reason) return rejected(reason);

      const changed = draftOwner !== owner;
      draftOwner = owner;
      if (changed) {
        stateRevision += 1;
        refreshSnapshot();
      }
      return transition("draft-applied", { changed });
    },

    releaseDraft(owner: EditorHandle): AppearanceTransition {
      const record = currentOwner(owner);
      if (!record) return rejected("unknown-owner");
      if (record.disposed) return rejected("owner-disposed");

      const draftReleased = draftOwner === owner;
      record.eligibilityEpoch += 1;
      stateRevision += 1;
      if (draftReleased) {
        draftOwner = null;
        refreshSnapshot();
      }
      return transition("draft-released", {
        changed: true,
        draftReleased,
        eligibilityInvalidated: true,
      });
    },
  };

  return Object.freeze(session);
}

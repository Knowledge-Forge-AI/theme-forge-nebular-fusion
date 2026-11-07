import {
  createAppearanceSession,
  type AppearanceChangeIntent,
  type AppearanceSnapshot,
  type AppearanceTransition,
  type ApplyEligibility,
  type EditorHandle,
  type EffectiveAppearanceMode,
  type AppearanceSelection,
} from "./appearance-session";
import {
  createAppearancePreferenceRecord,
  decodeAppearancePreferences,
  resetAppearancePreferences,
  resolveAppearancePreferences,
  selectApplicationDefault,
  setAppearanceMode,
  setAppearancePair,
  type AppearanceFamilyDefaults,
  type AppearancePreferenceDiagnostic,
  type AppearancePreferenceRecordV1,
} from "./appearance-preferences";
import {
  createAppearanceStylesheetOwner,
  AppearanceStylesheetError,
  type AppearanceStylesheetOwner,
  type AppearanceStylesheetOwnerOptions,
  type AppearanceStylesheetTransaction,
} from "./appearance-stylesheet-owner";
import type { AppearanceExternalCssomSlots } from "./appearance-external-cssom-slots";

export interface AppearanceFamily {
  readonly id: string;
  readonly label: string;
  readonly css: string;
}

export interface AppearanceCatalog {
  readonly defaultFamily: string;
  readonly families: readonly AppearanceFamily[];
  readonly defaults?: AppearanceFamilyDefaults;
}

export type AppearanceProblem = "unavailable-family" | "not-attached" | "change-failed" | "unsupported-backend" | "recovery-required";
export interface ApplicationAppearanceSnapshot extends AppearanceSnapshot {
  readonly attached: boolean;
  readonly problem: AppearanceProblem | null;
  readonly preferences: AppearancePreferenceRecordV1;
  /** Advances only for a committed explicit user preference change. */
  readonly preferenceRevision: number;
  readonly preferenceDiagnostics: readonly AppearancePreferenceDiagnostic[];
  readonly resolvedFamilies: Readonly<{ light: string; dark: string }>;
}
export interface AppearanceControllerOptions {
  /** Native load is completed before controller creation; no I/O occurs here. */
  readonly preferences?: unknown;
  /** Browser fixtures may use style elements; native startup supplies external CSSOM slots. */
  readonly allowStyleElementFallback?: AppearanceStylesheetOwnerOptions["allowStyleElementFallback"];
  /** Prepared native external CSSOM slots. Native startup prefers this backend. */
  readonly externalCssomSlots?: AppearanceExternalCssomSlots;
  /** Refuse constructable/style fallback when native slot preparation failed. */
  readonly requireExternalBackend?: boolean;
}
export interface AppearanceActionResult {
  readonly ok: boolean;
  readonly snapshot: ApplicationAppearanceSnapshot;
  readonly reason?: string;
}

export interface AppearanceDisposeResult {
  readonly ok: boolean;
  readonly status: "closed" | "failed" | "busy";
  readonly reason?: string;
}

/** Coordinates synchronous state adoption with the owned document transaction. */
export function createAppearanceController(catalogInput: AppearanceCatalog, options: AppearanceControllerOptions = {}) {
  const families = new Map<string, AppearanceFamily>();
  for (const value of catalogInput.families) {
    const { id, label, css } = value;
    if (typeof id !== "string" || typeof label !== "string" || typeof css !== "string" ||
        !id || !label || !css || families.has(id)) throw new Error("Invalid bundled appearance catalog");
    families.set(id, Object.freeze({ id, label, css }));
  }
  const defaultFamily = catalogInput.defaultFamily;
  if (!families.has(defaultFamily)) throw new Error("Bundled default appearance is unavailable");
  const defaults: AppearanceFamilyDefaults = Object.freeze({
    light: catalogInput.defaults?.light ?? defaultFamily,
    dark: catalogInput.defaults?.dark ?? defaultFamily,
    mode: catalogInput.defaults?.mode ?? "system",
  });
  if (!families.has(defaults.light) || !families.has(defaults.dark) ||
      !["system", "light", "dark"].includes(defaults.mode)) throw new Error("Bundled appearance defaults are unavailable");
  const catalog = Object.freeze({ defaultFamily, defaults, families: Object.freeze([...families.values()]) });
  const decoded = options.preferences === undefined
    ? decodeAppearancePreferences(createAppearancePreferenceRecord())
    : decodeAppearancePreferences(options.preferences);
  let preferences = decoded.record;
  let loadDiagnostics = decoded.diagnostics;
  let preferenceRevision = 0;
  const initialSelection: AppearanceSelection = preferences.light === undefined && preferences.dark === undefined
    ? { kind: "application-default" }
    : preferences.light !== undefined && preferences.light === preferences.dark
      ? { kind: "pair-override", id: preferences.light }
      : { kind: "custom-pair", ...(preferences.light === undefined ? {} : { light: preferences.light }), ...(preferences.dark === undefined ? {} : { dark: preferences.dark }) };
  const session = createAppearanceSession({ defaultModePreference: defaults.mode,
    ...(preferences.mode === undefined ? {} : { initialModePreference: preferences.mode }), initialSelection });
  const editors = new Set<EditorHandle>();
  const subscribers = new Set<() => void>();
  let styles: AppearanceStylesheetOwner | null = null;
  let attachedDocument: Document | null = null;
  let attachedClaim = false;
  let problem: AppearanceProblem | null = null;
  let busy = false;
  let poisoned = false;
  let unsupportedBackend = false;
  let terminalDisposed = false;
  let terminalDisposeQueued = false;
  let terminalDisposeResult: AppearanceDisposeResult | null = null;
  const queuedEditorDisposals = new Set<EditorHandle>();
  let drainingEditorDisposals = false;
  let lastSessionSnapshot = session.getSnapshot();
  let snapshot: ApplicationAppearanceSnapshot = makeSnapshot(lastSessionSnapshot);

  function makeSnapshot(current: AppearanceSnapshot): ApplicationAppearanceSnapshot {
    const resolved = resolveAppearancePreferences({ ...decoded, record: preferences, diagnostics: loadDiagnostics }, catalog, defaults, current.systemMode);
    return Object.freeze({ ...current, attached: attachedClaim, problem, preferences, preferenceRevision,
      preferenceDiagnostics: resolved.diagnostics,
      resolvedFamilies: Object.freeze({ light: resolved.resolvedFamilies.light!.id, dark: resolved.resolvedFamilies.dark!.id }),
    });
  }

  function publish(): void {
    const current = session.getSnapshot();
    if (current === lastSessionSnapshot && snapshot.attached === attachedClaim && snapshot.problem === problem && snapshot.preferences === preferences) return;
    lastSessionSnapshot = current;
    snapshot = makeSnapshot(current);
    for (const notify of subscribers) {
      try { notify(); } catch { /* An observer cannot undo completed adoption. */ }
    }
  }

  function result(ok: boolean, reason?: string): AppearanceActionResult {
    publish();
    return Object.freeze({ ok, snapshot, ...(reason === undefined ? {} : { reason }) });
  }

  function refused(reason: string, nextProblem: AppearanceProblem | null = problem): AppearanceActionResult {
    problem = nextProblem;
    return result(false, reason);
  }

  function rollback(transaction: AppearanceStylesheetTransaction | undefined): void {
    if (!transaction) return;
    try {
      if (!transaction.rollback().ok) poisoned = true;
    } catch { poisoned = true; }
  }

  function perform(
    operation: () => { transition: AppearanceTransition; transaction?: AppearanceStylesheetTransaction },
    onAccepted?: () => void,
  ): AppearanceActionResult {
    if (terminalDisposed) return refused("appearance-closed", "recovery-required");
    if (busy) return refused("operation-in-progress");
    if (poisoned) return refused("recovery-required", "recovery-required");
    busy = true;
    let transaction: AppearanceStylesheetTransaction | undefined;
    let transition: AppearanceTransition | undefined;
    try {
      const operationResult = operation();
      transaction = operationResult.transaction;
      transition = operationResult.transition;
      if (transaction && !transaction.finalize(transition.accepted).ok) {
        poisoned = true;
        problem = "recovery-required";
      } else if (transition.accepted) {
        problem = null;
        onAccepted?.();
      }
    } catch (error) {
      rollback(transaction);
      if (error instanceof AppearanceStylesheetError &&
          (error.code === "rollback-failed" || error.code === "owner-closed" || error.code === "state-drift" ||
            error.code === "capability-unavailable" || error.code === "root-mode-failed")) poisoned = true;
      problem = poisoned ? "recovery-required" : "change-failed";
    } finally {
      busy = false;
      flushQueuedEditorDisposals();
      flushQueuedTerminalDispose();
    }
    return result(Boolean(transition?.accepted) && !poisoned && problem === null, transition?.reason);
  }

  function resolvedFamily(next: AppearanceSnapshot): AppearanceFamily | undefined {
    const selected = next.selection;
    const id = selected.kind === "application-default" ? defaults[next.effectiveMode]
      : selected.kind === "pair-override" ? selected.id
      : selected[next.effectiveMode] ?? defaults[next.effectiveMode];
    // Persisted obsolete IDs fall back in memory without rewriting the record.
    return families.get(id) ?? families.get(defaults[next.effectiveMode]);
  }

  function recordForIntent(intent: AppearanceChangeIntent): AppearancePreferenceRecordV1 {
    switch (intent.kind) {
      case "select-application-default": return selectApplicationDefault(preferences);
      case "select-pair": return setAppearancePair(preferences, intent.pairId, intent.pairId);
      case "select-custom-pair": return Object.freeze({ version: 1 as const,
        ...(preferences.mode === undefined ? {} : { mode: preferences.mode }),
        ...(intent.light === undefined ? {} : { light: intent.light }),
        ...(intent.dark === undefined ? {} : { dark: intent.dark }),
      });
      case "set-mode-preference": return setAppearanceMode(preferences, intent.preference);
      case "reset": return resetAppearancePreferences(preferences);
      case "set-system-mode": return preferences;
    }
  }

  function retainPreferences(next: AppearancePreferenceRecordV1, force = false): void {
    if (!force && loadDiagnostics.length === 0 && next.mode === preferences.mode && next.light === preferences.light && next.dark === preferences.dark) return;
    preferences = next;
    loadDiagnostics = Object.freeze([]);
    preferenceRevision += 1;
  }

  function closeEditorHandle(owner: EditorHandle): AppearanceTransition {
    const transition = session.disposeEditor(owner);
    // Keep controller bookkeeping closed even when the pure session rejects a
    // repeated or foreign handle. A visual draft, if any, is handled by the
    // caller before this pure-handle close.
    editors.delete(owner);
    return transition;
  }

  function flushQueuedEditorDisposals(): void {
    if (busy || drainingEditorDisposals || queuedEditorDisposals.size === 0) return;
    drainingEditorDisposals = true;
    try {
      while (queuedEditorDisposals.size > 0) {
        const queued = [...queuedEditorDisposals];
        queuedEditorDisposals.clear();
        for (const owner of queued) disposeEditorAction(owner);
      }
    } finally {
      drainingEditorDisposals = false;
    }
  }

  function flushQueuedTerminalDispose(): void {
    if (busy || !terminalDisposeQueued || terminalDisposed) return;
    terminalDisposeQueued = false;
    terminalDisposeResult = disposeAction();
  }

  function disposeEditorAction(owner: EditorHandle): AppearanceActionResult {
    if (busy) {
      // The current transaction owns the visual boundary. Finish it first,
      // then close the pure editor handle; never leave a queued unowned draft.
      queuedEditorDisposals.add(owner);
      return refused("operation-in-progress");
    }
    if (unsupportedBackend) {
      closeEditorHandle(owner);
      return refused("unsupported-backend", "unsupported-backend");
    }
    if (poisoned) {
      // A failed visual cleanup still owns the pure draft. Keep that handle
      // reachable until the stylesheet owner can be recovered or disposed.
      if (styles !== null && session.isDraftOwner(owner)) {
        return refused("recovery-required", "recovery-required");
      }
      closeEditorHandle(owner);
      return refused("recovery-required", "recovery-required");
    }

    busy = true;
    let transaction: AppearanceStylesheetTransaction | undefined;
    let transition: AppearanceTransition | undefined;
    let visualDraft = false;
    try {
      visualDraft = styles !== null && session.isDraftOwner(owner);
      transaction = visualDraft ? styles!.releaseDraft() : undefined;
      if (transaction) {
        const completed = transaction.finalize(true);
        if (!completed.ok) {
          poisoned = true;
          problem = "recovery-required";
          // Do not close the pure handle: it is the recovery owner for the
          // retained visual draft/resources.
          return result(false, "recovery-required");
        }
      }

      // Close the pure owner only after its visual draft has been committed as
      // released. If the pure close itself rejects, the visual resource is
      // already gone and no CSS handle is orphaned.
      transition = closeEditorHandle(owner);
      if (!transition.accepted) {
        return result(false, transition.reason);
      }
      return result(problem === null, transition.reason);
    } catch {
      if (transaction && visualDraft) {
        try {
          if (!transaction.rollback().ok) poisoned = true;
        } catch {
          poisoned = true;
        }
      }
      if (visualDraft) {
        // Keep both the pure handle and owner reachable for recovery.
        poisoned = true;
        problem = "recovery-required";
        return result(false, "recovery-required");
      }
      try { closeEditorHandle(owner); } catch { editors.delete(owner); }
      problem = poisoned ? "recovery-required" : "change-failed";
      return result(false, problem);
    } finally {
      busy = false;
      flushQueuedEditorDisposals();
      flushQueuedTerminalDispose();
    }
  }

  function disposeAction(): AppearanceDisposeResult {
    if (terminalDisposed && terminalDisposeResult?.status === "closed") return terminalDisposeResult;
    if (busy) {
      terminalDisposeQueued = true;
      return Object.freeze({ ok: false, status: "busy", reason: "operation-in-progress" });
    }
    busy = true;
    let result: AppearanceDisposeResult;
    try {
      let ownerClosed = true;
      if (styles) {
        let teardown: ReturnType<AppearanceStylesheetOwner["teardown"]>;
        try { teardown = styles.teardown(); } catch { teardown = { ok: false, status: "failed", baselineReleased: false, draftReleased: false, rootRestored: false }; }
        if (!teardown.ok) {
          ownerClosed = false;
          poisoned = true;
          problem = "recovery-required";
        } else {
          styles = null;
        }
      }
      if (!ownerClosed) {
        result = Object.freeze({ ok: false, status: "failed", reason: "appearance-owner-cleanup-failed" });
      } else if (options.externalCssomSlots) {
        let slotsResult: ReturnType<AppearanceExternalCssomSlots["dispose"]>;
        try { slotsResult = options.externalCssomSlots.dispose(); } catch { slotsResult = { ok: false, releasedLinks: 0, remainingOwnedLinks: 4, reason: "appearance-slot-cleanup-failed" }; }
        if (!slotsResult.ok) {
          poisoned = true;
          problem = "recovery-required";
          result = Object.freeze({ ok: false, status: "failed", reason: "appearance-slot-cleanup-failed" });
        } else {
          result = Object.freeze({ ok: true, status: "closed" });
        }
      } else {
        result = Object.freeze({ ok: true, status: "closed" });
      }
      if (!result.ok) {
        // Keep the attached document/claim and every pure draft owner
        // reachable until the visual/backend cleanup can be retried.
        publish();
        return result;
      }

      let editorReleaseFailed = false;
      for (const owner of editors) {
        if (!session.isDraftOwner(owner)) continue;
        try {
          if (!session.releaseDraft(owner).accepted) editorReleaseFailed = true;
        } catch {
          editorReleaseFailed = true;
        }
      }
      if (editorReleaseFailed) {
        poisoned = true;
        problem = "recovery-required";
        result = Object.freeze({ ok: false, status: "failed", reason: "appearance-editor-cleanup-failed" });
        publish();
        return result;
      }
      editors.clear();
      attachedClaim = false;
      attachedDocument = null;
      terminalDisposed = true;
      problem = null;
      publish();
      if (result.status === "closed") terminalDisposeResult = result;
      return result;
    } finally {
      busy = false;
      flushQueuedEditorDisposals();
      flushQueuedTerminalDispose();
    }
  }

  return Object.freeze({
    catalog,
    getSnapshot: () => snapshot,
    subscribe(notify: () => void): () => void {
      subscribers.add(notify);
      return () => { subscribers.delete(notify); };
    },

    attach(documentValue: Document, systemMode: EffectiveAppearanceMode): AppearanceActionResult {
      if (terminalDisposed) return refused("appearance-closed", "recovery-required");
      if (busy) return refused("operation-in-progress");
      if (poisoned) return refused("recovery-required", "recovery-required");
      if (styles) {
        if (!attachedClaim) return refused("recovery-required", "recovery-required");
        return result(documentValue === attachedDocument, documentValue === attachedDocument ? undefined : "different-document");
      }
      if (options.requireExternalBackend && !options.externalCssomSlots) {
        unsupportedBackend = true;
        return refused("unsupported-backend", "unsupported-backend");
      }
      busy = true;
      let candidate: AppearanceStylesheetOwner | undefined;
      let transaction: AppearanceStylesheetTransaction | undefined;
      let failureReason: string | undefined;
      try {
        const plan = session.prepareAppearanceChange({ kind: "set-system-mode", mode: systemMode });
        if (!plan) return refused("invalid-mode");
        const family = resolvedFamily(plan.nextSnapshot);
        if (!family) return refused("unavailable-family", "unavailable-family");
        candidate = createAppearanceStylesheetOwner(documentValue, {
          allowStyleElementFallback: options.allowStyleElementFallback ?? true,
          ...(options.externalCssomSlots ? { externalCssomSlots: options.externalCssomSlots } : {}),
        });
        transaction = candidate.stageBaseline(family.css, { rootMode: plan.nextSnapshot.effectiveMode, releaseDraft: true });
        const transition = session.commitAppearanceChange(plan);
        const completed = transaction.finalize(transition.accepted);
        if (!transition.accepted || !completed.ok) {
          poisoned = !completed.ok;
          const teardown = candidate.teardown();
          if (!teardown.ok) {
            styles = candidate;
            attachedClaim = false;
            attachedDocument = null;
            poisoned = true;
          }
          return refused(transition.reason ?? completed.reason ?? "change-failed", poisoned ? "recovery-required" : "change-failed");
        }
        styles = candidate;
        attachedDocument = documentValue;
        attachedClaim = true;
        unsupportedBackend = false;
        problem = null;
      } catch (error) {
        rollback(transaction);
        if (candidate) {
          try {
            const teardown = candidate.teardown();
            if (!teardown.ok) {
              styles = candidate;
              attachedClaim = false;
              attachedDocument = null;
              poisoned = true;
            }
          } catch {
            styles = candidate;
            attachedClaim = false;
            attachedDocument = null;
            poisoned = true;
          }
        }
        const nativeBackendFailure = options.allowStyleElementFallback === false &&
          error instanceof AppearanceStylesheetError &&
          (error.code === "capability-unavailable" || error.code === "attachment-failed");
        if (nativeBackendFailure && !poisoned) {
          unsupportedBackend = true;
          failureReason = "unsupported-backend";
          problem = "unsupported-backend";
        } else {
          problem = poisoned ? "recovery-required" : "change-failed";
          failureReason = poisoned ? "recovery-required" : "change-failed";
        }
      } finally {
        busy = false;
        flushQueuedEditorDisposals();
        flushQueuedTerminalDispose();
      }
      return result(styles !== null && !poisoned, failureReason);
    },

    change(intent: AppearanceChangeIntent): AppearanceActionResult {
      if (terminalDisposed) return refused("appearance-closed", "recovery-required");
      if (busy) return refused("operation-in-progress");
      if (poisoned) return refused("recovery-required", "recovery-required");
      if (unsupportedBackend) return refused("unsupported-backend", "unsupported-backend");
      const plan = session.prepareAppearanceChange(intent);
      if (!plan) return refused("invalid-intent");
      if ((plan.intent.kind === "select-pair" && !families.has(plan.intent.pairId)) ||
          (plan.intent.kind === "select-custom-pair" && (["light", "dark"] as const).some((side) => {
            const id = plan.intent.kind === "select-custom-pair" ? plan.intent[side] : undefined;
            return id !== undefined && id !== preferences[side] && !families.has(id);
          }))) {
        return refused("unavailable-family", "unavailable-family");
      }
      const family = resolvedFamily(plan.nextSnapshot);
      if (!family) return refused("unavailable-family", "unavailable-family");
      const needsStyles = plan.changed && (plan.intent.kind === "reset" || plan.eligibilityInvalidated);
      return perform(() => {
        const transaction = styles && needsStyles
          ? styles.stageBaseline(family.css, { rootMode: plan.nextSnapshot.effectiveMode, releaseDraft: plan.draftWillRelease })
          : undefined;
        const transition = session.commitAppearanceChange(plan);
        return { transition, ...(transaction ? { transaction } : {}) };
      }, () => {
        if (plan.intent.kind !== "set-system-mode") retainPreferences(recordForIntent(plan.intent), plan.intent.kind === "reset");
      });
    },

    registerEditor(): EditorHandle {
      if (terminalDisposed) throw new Error("Appearance controller is closed.");
      const owner = session.registerEditor();
      editors.add(owner);
      return owner;
    },
    captureApplyEligibility: (owner: EditorHandle): ApplyEligibility | null => terminalDisposed ? null : session.captureApplyEligibility(owner),
    isDraftOwner: (owner: EditorHandle): boolean => !terminalDisposed && session.isDraftOwner(owner),

    applyDraft(owner: EditorHandle, eligibility: ApplyEligibility, css: string): AppearanceActionResult {
      if (terminalDisposed) return refused("appearance-closed", "recovery-required");
      if (busy) return refused("operation-in-progress");
      if (poisoned) return refused("recovery-required", "recovery-required");
      if (unsupportedBackend) return refused("unsupported-backend", "unsupported-backend");
      if (!styles) return refused("not-attached", "not-attached");
      const checked = session.validateDraftApplication(owner, eligibility);
      if (!checked.accepted) return result(false, checked.reason);
      if (typeof css !== "string" || !css.trim()) return refused("invalid-css");
      return perform(() => {
        const transaction = styles!.stageDraft(css);
        return { transition: session.applyDraft(owner, eligibility), transaction };
      });
    },

    releaseDraft(owner: EditorHandle): AppearanceActionResult {
      if (terminalDisposed) return refused("appearance-closed", "recovery-required");
      if (busy) return refused("operation-in-progress");
      if (poisoned) return refused("recovery-required", "recovery-required");
      if (unsupportedBackend) return refused("unsupported-backend", "unsupported-backend");
      return perform(() => {
        const transaction = styles && session.isDraftOwner(owner) ? styles.releaseDraft() : undefined;
        return { transition: session.releaseDraft(owner), ...(transaction ? { transaction } : {}) };
      });
    },

    disposeEditor: disposeEditorAction,

    detach(): AppearanceActionResult {
      if (terminalDisposed) return refused("appearance-closed", "recovery-required");
      if (busy) return refused("operation-in-progress");
      busy = true;
      let cleanupOk = true;
      try {
        if (styles) {
          const teardown = styles.teardown();
          if (!teardown.ok) {
            cleanupOk = false;
            poisoned = true;
            problem = "recovery-required";
          } else {
            styles = null;
          }
        }
        if (cleanupOk) {
          for (const owner of editors) {
            if (!session.isDraftOwner(owner)) continue;
            try {
              if (!session.releaseDraft(owner).accepted) cleanupOk = false;
            } catch {
              cleanupOk = false;
            }
          }
        }
        if (cleanupOk && !unsupportedBackend) {
          // Clearing the claim is the commit point for a successful visual
          // teardown. Failed cleanup keeps both document and pure draft owners
          // reachable for a later retry.
          attachedClaim = false;
          attachedDocument = null;
          poisoned = false;
          problem = null;
        } else if (!cleanupOk) {
          poisoned = true;
          problem = "recovery-required";
        } else {
          problem = "unsupported-backend";
        }
      } catch {
        cleanupOk = false;
        poisoned = true;
        problem = "recovery-required";
      } finally {
        busy = false;
        flushQueuedEditorDisposals();
        flushQueuedTerminalDispose();
      }
      return result(cleanupOk && !poisoned && !unsupportedBackend, !cleanupOk || poisoned ? "recovery-required" : unsupportedBackend ? "unsupported-backend" : undefined);
    },

    dispose(): AppearanceDisposeResult {
      return disposeAction();
    },
  });
}

export type AppearanceController = ReturnType<typeof createAppearanceController>;

import { describe, expect, it } from "vitest";
import {
  createAppearanceSession,
  type ApplyEligibility,
  type EditorHandle,
} from "../appearance-session";

describe("appearance session ownership contract", () => {
  it("adopts the same input value that passed validation even for stateful getters", () => {
    let initialReads = 0;
    const session = createAppearanceSession({
      get initialSystemMode() { return initialReads++ === 0 ? "dark" : "sepia"; },
    } as never);
    expect(session.getSnapshot().systemMode).toBe("dark");

    let preferenceReads = 0;
    let kindReads = 0;
    const preference = session.prepareAppearanceChange({
      get kind() { return kindReads++ === 0 ? "set-mode-preference" : "reset"; },
      get preference() { return preferenceReads++ === 0 ? "dark" : "sepia"; },
    } as never)!;
    expect(session.commitAppearanceChange(preference).snapshot.modePreference).toBe("dark");

    let modeReads = 0;
    const system = session.prepareAppearanceChange({
      kind: "set-system-mode",
      get mode() { return modeReads++ === 0 ? "light" : "sepia"; },
    } as never)!;
    expect(session.commitAppearanceChange(system).snapshot.systemMode).toBe("light");

    let pairReads = 0;
    const selection = session.prepareAppearanceChange({
      kind: "select-pair",
      get pairId() { return pairReads++ === 0 ? "validated-pair" : "changed-pair"; },
    } as never)!;
    expect(session.commitAppearanceChange(selection).snapshot.selection)
      .toEqual({ kind: "pair-override", id: "validated-pair" });
  });

  it("checks eligibility without changing ownership before a stylesheet transaction", () => {
    const session = createAppearanceSession();
    const owner = session.registerEditor();
    const eligibility = session.captureApplyEligibility(owner)!;
    const before = session.getSnapshot();
    const eligible = session.validateDraftApplication(owner, eligibility);
    expect(eligible.accepted).toBe(true);
    expect(eligible.changed).toBe(false);
    expect(eligible.snapshot).toBe(before);
    expect(eligible.snapshot.hasDraft).toBe(false);

    session.applyDraft(owner, eligibility);
    const other = session.registerEditor();
    const otherEligibility = session.captureApplyEligibility(other)!;
    const occupied = session.getSnapshot();
    expect(session.validateDraftApplication(other, otherEligibility).reason)
      .toBe("draft-owned-by-another-owner");
    expect(session.getSnapshot()).toBe(occupied);
  });

  it("prepares a replacement appearance without mutation and rejects a plan after commit", () => {
    const session = createAppearanceSession({ initialSystemMode: "light" });
    const owner = session.registerEditor();
    const eligibility = session.captureApplyEligibility(owner)!;
    session.applyDraft(owner, eligibility);
    const before = session.getSnapshot();

    const plan = session.prepareAppearanceChange({
      kind: "select-pair",
      pairId: "provisional-pair-plan",
    });
    expect(plan).not.toBeNull();
    expect(session.getSnapshot()).toBe(before);
    expect(plan!.nextSnapshot.selection).toEqual({
      kind: "pair-override",
      id: "provisional-pair-plan",
    });
    expect(plan!.nextSnapshot.effectiveMode).toBe("light");
    expect(plan!.nextSnapshot.hasDraft).toBe(false);
    expect(plan!.draftWillRelease).toBe(true);
    expect(plan!.eligibilityInvalidated).toBe(true);
    expect(session.isDraftOwner(owner)).toBe(true);

    const committed = session.commitAppearanceChange(plan!);
    expect(committed.accepted).toBe(true);
    expect(committed.draftReleased).toBe(true);
    expect(committed.snapshot.hasDraft).toBe(false);
    expect(session.isDraftOwner(owner)).toBe(false);
    expect(session.commitAppearanceChange(plan!).reason).toBe("stale-plan");

    const planBeforeOwnerStateChange = session.prepareAppearanceChange({ kind: "reset" })!;
    session.releaseDraft(owner);
    expect(session.commitAppearanceChange(planBeforeOwnerStateChange).reason).toBe("stale-plan");
  });

  it("plans mode, System, and Reset resolutions through one effect-free table", () => {
    const session = createAppearanceSession({ initialSystemMode: "light" });

    const modePlan = session.prepareAppearanceChange({
      kind: "set-mode-preference",
      preference: "dark",
    });
    expect(modePlan!.nextSnapshot.modePreference).toBe("dark");
    expect(modePlan!.nextSnapshot.effectiveMode).toBe("dark");
    expect(modePlan!.draftWillRelease).toBe(false);
    expect(modePlan!.eligibilityInvalidated).toBe(true);
    expect(session.getSnapshot().effectiveMode).toBe("light");
    session.commitAppearanceChange(modePlan!);

    const systemPlan = session.prepareAppearanceChange({
      kind: "set-system-mode",
      mode: "dark",
    });
    expect(systemPlan!.nextSnapshot.systemMode).toBe("dark");
    expect(systemPlan!.nextSnapshot.effectiveMode).toBe("dark");
    expect(systemPlan!.eligibilityInvalidated).toBe(false);
    session.commitAppearanceChange(systemPlan!);

    const resetPlan = session.prepareAppearanceChange({ kind: "reset" });
    expect(resetPlan!.nextSnapshot.selection).toEqual({ kind: "application-default" });
    expect(resetPlan!.nextSnapshot.modePreference).toBe("system");
    expect(resetPlan!.nextSnapshot.effectiveMode).toBe("dark");
    expect(resetPlan!.eligibilityInvalidated).toBe(true);
    expect(session.getSnapshot().modePreference).toBe("dark");
  });

  it.each(["light", "dark"] as const)(
    "retains a draft and eligibility when following System changes to the same explicit %s mode",
    (mode) => {
      const session = createAppearanceSession({ initialSystemMode: mode });
      const owner = session.registerEditor();
      const eligibility = session.captureApplyEligibility(owner)!;
      session.applyDraft(owner, eligibility);
      const preference = session.setModePreference(mode);
      expect(preference.snapshot.modePreference).toBe(mode);
      expect(preference.snapshot.hasDraft).toBe(true);
      expect(session.isDraftOwner(owner)).toBe(true);
      expect(preference.draftReleased).toBe(false);
      expect(preference.eligibilityInvalidated).toBe(false);
      expect(session.validateDraftApplication(owner, eligibility).accepted).toBe(true);
    },
  );

  it("invalidates editor-local eligibility when releasing a draft or pending application", () => {
    const session = createAppearanceSession();
    const owner = session.registerEditor();
    const eligibility = session.captureApplyEligibility(owner)!;
    session.applyDraft(owner, eligibility);
    expect(session.releaseDraft(owner).eligibilityInvalidated).toBe(true);
    expect(session.applyDraft(owner, eligibility).reason).toBe("stale-eligibility");

    const pending = session.captureApplyEligibility(owner)!;
    const before = session.getSnapshot();
    const released = session.releaseDraft(owner);
    expect(released.draftReleased).toBe(false);
    expect(released.eligibilityInvalidated).toBe(true);
    expect(released.snapshot).toBe(before);
    expect(session.validateDraftApplication(owner, pending).reason).toBe("stale-eligibility");

    const fresh = session.captureApplyEligibility(owner)!;
    expect(session.applyDraft(owner, fresh).accepted).toBe(true);
  });

  it("invalidates a live owner's pending token even when another owner holds the draft", () => {
    const session = createAppearanceSession();
    const firstOwner = session.registerEditor();
    const secondOwner = session.registerEditor();
    const firstEligibility = session.captureApplyEligibility(firstOwner)!;
    session.applyDraft(firstOwner, firstEligibility);
    const secondEligibility = session.captureApplyEligibility(secondOwner)!;

    const beforeRelease = session.getSnapshot();
    const release = session.releaseDraft(secondOwner);
    expect(release.accepted).toBe(true);
    expect(release.draftReleased).toBe(false);
    expect(release.eligibilityInvalidated).toBe(true);
    expect(release.snapshot).toBe(beforeRelease);
    expect(session.isDraftOwner(firstOwner)).toBe(true);

    expect(session.releaseDraft(firstOwner).draftReleased).toBe(true);
    expect(session.applyDraft(secondOwner, secondEligibility).reason).toBe("stale-eligibility");
  });

  it("keeps pair selection independent from mode and distinguishes default from a pair override", () => {
    const session = createAppearanceSession({ initialSystemMode: "dark" });
    const owner = session.registerEditor();

    expect(session.getSnapshot().selection).toEqual({ kind: "application-default" });
    expect(session.getSnapshot().modePreference).toBe("system");
    expect(session.getSnapshot().effectiveMode).toBe("dark");

    const initialEligibility = session.captureApplyEligibility(owner);
    expect(initialEligibility).not.toBeNull();
    expect(session.applyDraft(owner, initialEligibility!).accepted).toBe(true);

    const pairChange = session.selectPair("provisional-pair-a");
    expect(pairChange.kind).toBe("selection-changed");
    expect(pairChange.draftReleased).toBe(true);
    expect(pairChange.eligibilityInvalidated).toBe(true);
    expect(pairChange.snapshot.selection).toEqual({
      kind: "pair-override",
      id: "provisional-pair-a",
    });
    expect(pairChange.snapshot.modePreference).toBe("system");
    expect(pairChange.snapshot.hasDraft).toBe(false);
    expect(session.applyDraft(owner, initialEligibility!).reason).toBe("stale-eligibility");

    const freshEligibility = session.captureApplyEligibility(owner)!;
    expect(session.applyDraft(owner, freshEligibility).accepted).toBe(true);
    const beforeRepeatedPair = session.getSnapshot();

    const repeatedPair = session.selectPair("provisional-pair-a");
    expect(repeatedPair.kind).toBe("unchanged");
    expect(repeatedPair.changed).toBe(false);
    expect(repeatedPair.snapshot).toBe(beforeRepeatedPair);
    expect(repeatedPair.snapshot.hasDraft).toBe(true);
    expect(session.isDraftOwner(owner)).toBe(true);

    const defaultChange = session.selectApplicationDefault();
    expect(defaultChange.kind).toBe("selection-changed");
    expect(defaultChange.draftReleased).toBe(true);
    expect(defaultChange.snapshot.selection).toEqual({ kind: "application-default" });
    expect(defaultChange.snapshot.hasDraft).toBe(false);
  });

  it("selects custom pair sides independently and normalizes two absent sides", () => {
    const session = createAppearanceSession({ initialSystemMode: "dark" });
    const owner = session.registerEditor();
    const initialEligibility = session.captureApplyEligibility(owner)!;
    expect(session.applyDraft(owner, initialEligibility).accepted).toBe(true);

    const lightOnly = session.selectCustomPair("custom-light");
    expect(lightOnly.kind).toBe("selection-changed");
    expect(lightOnly.snapshot.selection).toEqual({
      kind: "custom-pair",
      light: "custom-light",
    });
    expect(lightOnly.draftReleased).toBe(true);
    expect(lightOnly.eligibilityInvalidated).toBe(true);

    const freshEligibility = session.captureApplyEligibility(owner)!;
    expect(session.applyDraft(owner, freshEligibility).accepted).toBe(true);
    const beforeRepeat = session.getSnapshot();
    const repeated = session.selectCustomPair("custom-light");
    expect(repeated.kind).toBe("unchanged");
    expect(repeated.changed).toBe(false);
    expect(repeated.snapshot).toBe(beforeRepeat);
    expect(session.validateDraftApplication(owner, freshEligibility).accepted).toBe(true);

    const bothSides = session.selectCustomPair("custom-light", "custom-dark");
    expect(bothSides.snapshot.selection).toEqual({
      kind: "custom-pair",
      light: "custom-light",
      dark: "custom-dark",
    });
    expect(bothSides.draftReleased).toBe(true);
    expect(session.validateDraftApplication(owner, freshEligibility).reason)
      .toBe("stale-eligibility");

    const darkOnly = session.selectCustomPair(undefined, "custom-dark");
    expect(darkOnly.snapshot.selection).toEqual({
      kind: "custom-pair",
      dark: "custom-dark",
    });

    const applicationDefault = session.selectCustomPair();
    expect(applicationDefault.snapshot.selection).toEqual({ kind: "application-default" });
  });

  it("rejects invalid custom-pair input without mutation and bounds family IDs", () => {
    const session = createAppearanceSession();
    const before = session.getSnapshot();

    const emptyLight = session.selectCustomPair("", "valid-dark");
    expect(emptyLight.accepted).toBe(false);
    expect(emptyLight.reason).toBe("invalid-intent");
    expect(emptyLight.snapshot).toBe(before);

    const tooLong = "x".repeat(129);
    const invalidPlan = session.prepareAppearanceChange({
      kind: "select-custom-pair",
      light: tooLong,
    });
    expect(invalidPlan).toBeNull();
    expect(session.getSnapshot()).toBe(before);

    const invalidDark = session.selectCustomPair("valid-light", tooLong);
    expect(invalidDark.accepted).toBe(false);
    expect(invalidDark.reason).toBe("invalid-intent");
    expect(invalidDark.snapshot).toBe(before);
  });

  it("copies and normalizes initial custom selection while falling back invalid input", () => {
    const initialSelection = {
      kind: "custom-pair",
      light: "initial-light",
      dark: "initial-dark",
    } as const;
    const session = createAppearanceSession({
      initialSelection,
      initialSystemMode: "light",
      initialModePreference: "system",
      defaultModePreference: "dark",
    });
    const initialSnapshot = session.getSnapshot();
    expect(initialSnapshot.selection).toEqual(initialSelection);
    expect(Object.isFrozen(initialSnapshot.selection)).toBe(true);
    expect(Object.isFrozen(initialSnapshot)).toBe(true);
    expect(initialSnapshot.modePreference).toBe("system");
    expect(initialSnapshot.effectiveMode).toBe("light");

    (initialSelection as { light: string; dark: string }).light = "mutated-input";
    expect(session.getSnapshot().selection).toEqual({
      kind: "custom-pair",
      light: "initial-light",
      dark: "initial-dark",
    });

    const invalidInitial = createAppearanceSession({
      initialSelection: { kind: "custom-pair", light: "" } as never,
      initialModePreference: "sepia" as never,
      defaultModePreference: "dark",
    });
    expect(invalidInitial.getSnapshot().selection).toEqual({ kind: "application-default" });
    expect(invalidInitial.getSnapshot().modePreference).toBe("dark");
    expect(invalidInitial.getSnapshot().effectiveMode).toBe("dark");

    const invalidDefault = createAppearanceSession({
      initialSystemMode: "light",
      defaultModePreference: "sepia" as never,
      initialModePreference: "sepia" as never,
    });
    expect(invalidDefault.getSnapshot().modePreference).toBe("system");
    expect(invalidDefault.getSnapshot().effectiveMode).toBe("light");
  });

  it("uses the configured default on Reset while explicit System still follows system changes", () => {
    const session = createAppearanceSession({
      initialSystemMode: "light",
      defaultModePreference: "dark",
      initialModePreference: "system",
      initialSelection: { kind: "custom-pair", light: "initial-light" },
    });
    const owner = session.registerEditor();
    const eligibility = session.captureApplyEligibility(owner)!;
    expect(session.applyDraft(owner, eligibility).accepted).toBe(true);

    const explicitSystem = session.setModePreference("system");
    expect(explicitSystem.kind).toBe("unchanged");
    expect(explicitSystem.snapshot.effectiveMode).toBe("light");

    const changedSystem = session.setSystemMode("dark");
    expect(changedSystem.kind).toBe("effective-mode-changed");
    expect(changedSystem.snapshot.modePreference).toBe("system");
    expect(changedSystem.snapshot.effectiveMode).toBe("dark");
    expect(changedSystem.draftReleased).toBe(true);

    const reset = session.reset();
    expect(reset.kind).toBe("reset");
    expect(reset.snapshot.selection).toEqual({ kind: "application-default" });
    expect(reset.snapshot.modePreference).toBe("dark");
    expect(reset.snapshot.effectiveMode).toBe("dark");
    expect(reset.eligibilityInvalidated).toBe(true);

    const explicitSystemAfterReset = session.setModePreference("system");
    expect(explicitSystemAfterReset.snapshot.modePreference).toBe("system");
    expect(explicitSystemAfterReset.snapshot.effectiveMode).toBe("dark");
    expect(session.setSystemMode("light").snapshot.effectiveMode).toBe("light");
  });

  it("invalidates custom-pair tokens and plans only when the selection changes", () => {
    const session = createAppearanceSession();
    const owner = session.registerEditor();
    const eligibility = session.captureApplyEligibility(owner)!;
    const plan = session.prepareAppearanceChange({
      kind: "select-custom-pair",
      light: "planned-light",
    })!;
    expect(session.getSnapshot().selection).toEqual({ kind: "application-default" });
    expect(plan.nextSnapshot.selection).toEqual({
      kind: "custom-pair",
      light: "planned-light",
    });
    expect(session.commitAppearanceChange(plan).accepted).toBe(true);
    expect(session.applyDraft(owner, eligibility).reason).toBe("stale-eligibility");

    const fresh = session.captureApplyEligibility(owner)!;
    expect(session.applyDraft(owner, fresh).accepted).toBe(true);
    const samePlan = session.prepareAppearanceChange({
      kind: "select-custom-pair",
      light: "planned-light",
    })!;
    const beforeSame = session.getSnapshot();
    expect(session.commitAppearanceChange(samePlan).kind).toBe("unchanged");
    expect(session.getSnapshot()).toBe(beforeSame);
    expect(session.validateDraftApplication(owner, fresh).accepted).toBe(true);

    const stalePlan = session.prepareAppearanceChange({
      kind: "select-custom-pair",
      light: "planned-light",
      dark: "planned-dark",
    })!;
    expect(session.selectCustomPair("replacement-light").accepted).toBe(true);
    expect(session.commitAppearanceChange(stalePlan).reason).toBe("stale-plan");
  });

  it("preserves a draft for same-effective mode preference changes but invalidates it on effective changes", () => {
    const session = createAppearanceSession({ initialSystemMode: "dark" });
    const owner = session.registerEditor();
    const eligibility = session.captureApplyEligibility(owner)!;
    expect(session.applyDraft(owner, eligibility).accepted).toBe(true);
    const beforeExplicitPreference = session.getSnapshot();

    const explicitDark = session.setModePreference("dark");
    expect(explicitDark.kind).toBe("mode-preference-changed");
    expect(explicitDark.snapshot.modePreference).toBe("dark");
    expect(explicitDark.snapshot.effectiveMode).toBe("dark");
    expect(explicitDark.snapshot.hasDraft).toBe(true);
    expect(session.isDraftOwner(owner)).toBe(true);
    expect(explicitDark.snapshot.appearanceEpoch).toBe(beforeExplicitPreference.appearanceEpoch);

    const systemChangesWhileExplicit = session.setSystemMode("light");
    expect(systemChangesWhileExplicit.kind).toBe("system-mode-changed");
    expect(systemChangesWhileExplicit.snapshot.systemMode).toBe("light");
    expect(systemChangesWhileExplicit.snapshot.effectiveMode).toBe("dark");
    expect(systemChangesWhileExplicit.snapshot.hasDraft).toBe(true);
    expect(session.isDraftOwner(owner)).toBe(true);

    const followsSystem = session.setModePreference("system");
    expect(followsSystem.kind).toBe("effective-mode-changed");
    expect(followsSystem.snapshot.effectiveMode).toBe("light");
    expect(followsSystem.draftReleased).toBe(true);
    expect(followsSystem.eligibilityInvalidated).toBe(true);
    expect(session.applyDraft(owner, eligibility).reason).toBe("stale-eligibility");
  });

  it("invalidates a pending token on selection even when no draft is attached", () => {
    const session = createAppearanceSession();
    const owner = session.registerEditor();
    const pending = session.captureApplyEligibility(owner)!;
    const before = session.getSnapshot();

    const changed = session.selectPair("provisional-pair-no-draft");
    expect(changed.draftReleased).toBe(false);
    expect(changed.eligibilityInvalidated).toBe(true);
    expect(before).not.toBe(changed.snapshot);
    expect(session.applyDraft(owner, pending).reason).toBe("stale-eligibility");
  });

  it("releases the draft when a following-System preference changes effective mode, while explicit mode ignores system attachment changes", () => {
    const session = createAppearanceSession({ initialSystemMode: "light" });
    const owner = session.registerEditor();
    const eligibility = session.captureApplyEligibility(owner)!;
    expect(session.applyDraft(owner, eligibility).accepted).toBe(true);

    const systemDark = session.setSystemMode("dark");
    expect(systemDark.kind).toBe("effective-mode-changed");
    expect(systemDark.snapshot.modePreference).toBe("system");
    expect(systemDark.snapshot.effectiveMode).toBe("dark");
    expect(systemDark.draftReleased).toBe(true);

    const freshEligibility = session.captureApplyEligibility(owner)!;
    expect(session.applyDraft(owner, freshEligibility).accepted).toBe(true);
    const explicitLight = session.setModePreference("light");
    expect(explicitLight.kind).toBe("effective-mode-changed");
    expect(explicitLight.snapshot.effectiveMode).toBe("light");
    expect(explicitLight.snapshot.hasDraft).toBe(false);

    const reapply = session.captureApplyEligibility(owner)!;
    expect(session.applyDraft(owner, reapply).accepted).toBe(true);
    const explicitSystemLight = session.setSystemMode("light");
    expect(explicitSystemLight.kind).toBe("system-mode-changed");
    expect(explicitSystemLight.snapshot.modePreference).toBe("light");
    expect(explicitSystemLight.snapshot.effectiveMode).toBe("light");
    expect(explicitSystemLight.snapshot.hasDraft).toBe(true);
    expect(session.isDraftOwner(owner)).toBe(true);
  });

  it("keeps an identical System event as a stable no-op", () => {
    const session = createAppearanceSession({ initialSystemMode: "dark" });
    const before = session.getSnapshot();
    const unchanged = session.setSystemMode("dark");
    expect(unchanged.kind).toBe("unchanged");
    expect(unchanged.changed).toBe(false);
    expect(unchanged.snapshot).toBe(before);
  });

  it("rejects invalid runtime mode values without storing them", () => {
    const session = createAppearanceSession();
    const before = session.getSnapshot();

    const invalidPreference = session.setModePreference("sepia" as never);
    expect(invalidPreference.accepted).toBe(false);
    expect(invalidPreference.reason).toBe("invalid-mode");
    expect(invalidPreference.snapshot).toBe(before);

    const invalidSystem = session.setSystemMode("sepia" as never);
    expect(invalidSystem.accepted).toBe(false);
    expect(invalidSystem.reason).toBe("invalid-mode");
    expect(invalidSystem.snapshot).toBe(before);

    expect(session.prepareAppearanceChange({
      kind: "set-mode-preference",
      preference: "sepia" as never,
    })).toBeNull();
    expect(session.prepareAppearanceChange({
      kind: "set-system-mode",
      mode: "sepia" as never,
    })).toBeNull();

    const invalidInitial = createAppearanceSession({ initialSystemMode: "sepia" as never });
    expect(invalidInitial.getSnapshot().systemMode).toBe("light");
    expect(invalidInitial.getSnapshot().effectiveMode).toBe("light");
  });

  it("invalidates eligibility on every reset, including a repeat reset", () => {
    const session = createAppearanceSession({ initialSystemMode: "light" });
    const owner = session.registerEditor();

    session.selectPair("provisional-pair-b");
    session.setModePreference("dark");
    const eligibility = session.captureApplyEligibility(owner)!;
    expect(session.applyDraft(owner, eligibility).accepted).toBe(true);

    const firstReset = session.reset();
    expect(firstReset.kind).toBe("reset");
    expect(firstReset.draftReleased).toBe(true);
    expect(firstReset.eligibilityInvalidated).toBe(true);
    expect(firstReset.snapshot.selection).toEqual({ kind: "application-default" });
    expect(firstReset.snapshot.modePreference).toBe("system");
    expect(firstReset.snapshot.effectiveMode).toBe("light");
    expect(firstReset.snapshot.hasDraft).toBe(false);
    expect(session.applyDraft(owner, eligibility).reason).toBe("stale-eligibility");

    const betweenResets = session.captureApplyEligibility(owner)!;
    expect(session.applyDraft(owner, betweenResets).accepted).toBe(true);
    const secondReset = session.reset();
    expect(secondReset.kind).toBe("reset");
    expect(secondReset.draftReleased).toBe(true);
    expect(secondReset.snapshot.hasDraft).toBe(false);
    expect(secondReset.snapshot).not.toBe(firstReset.snapshot);
    expect(secondReset.snapshot.appearanceEpoch).toBe(firstReset.snapshot.appearanceEpoch + 1);
    expect(session.applyDraft(owner, betweenResets).reason).toBe("stale-eligibility");
    expect(session.applyDraft(owner, eligibility).reason).toBe("stale-eligibility");

    const freshEligibility = session.captureApplyEligibility(owner)!;
    expect(session.applyDraft(owner, freshEligibility).accepted).toBe(true);
  });

  it("rejects a token, owner, or plan created by another session", () => {
    const firstSession = createAppearanceSession();
    const secondSession = createAppearanceSession();
    const firstOwner = firstSession.registerEditor();
    const secondOwner = secondSession.registerEditor();
    const firstEligibility = firstSession.captureApplyEligibility(firstOwner)!;
    const firstPlan = firstSession.prepareAppearanceChange({
      kind: "select-pair",
      pairId: "provisional-cross-session",
    })!;

    expect(secondSession.captureApplyEligibility(firstOwner)).toBeNull();
    expect(secondSession.applyDraft(secondOwner, firstEligibility).reason)
      .toBe("unknown-eligibility");
    expect(secondSession.commitAppearanceChange(firstPlan).reason).toBe("unknown-plan");
    expect(firstSession.getSnapshot().selection).toEqual({ kind: "application-default" });
  });

  it("keeps disposal owner-local and preserves snapshot identity when no draft is attached", () => {
    const session = createAppearanceSession();
    const owner = session.registerEditor();
    const unknownOwner = {} as EditorHandle;
    expect(session.disposeEditor(unknownOwner).reason).toBe("unknown-owner");

    const beforeDispose = session.getSnapshot();
    const disposed = session.disposeEditor(owner);
    expect(disposed.accepted).toBe(true);
    expect(disposed.draftReleased).toBe(false);
    expect(disposed.snapshot).toBe(beforeDispose);
    expect(session.isDraftOwner(owner)).toBe(false);
    expect(session.disposeEditor(owner).reason).toBe("owner-disposed");
    expect(session.captureApplyEligibility(owner)).toBeNull();
  });

  it("allows only a live owner to apply or release its own draft", () => {
    const session = createAppearanceSession();
    const firstOwner = session.registerEditor();
    const secondOwner = session.registerEditor();
    const firstEligibility = session.captureApplyEligibility(firstOwner)!;
    expect(session.applyDraft(firstOwner, firstEligibility).accepted).toBe(true);

    const beforeCrossOwnerRelease = session.getSnapshot();
    const crossOwnerRelease = session.releaseDraft(secondOwner);
    expect(crossOwnerRelease.accepted).toBe(true);
    expect(crossOwnerRelease.reason).toBeUndefined();
    expect(crossOwnerRelease.draftReleased).toBe(false);
    expect(crossOwnerRelease.eligibilityInvalidated).toBe(true);
    expect(crossOwnerRelease.snapshot).toBe(beforeCrossOwnerRelease);

    const secondEligibility = session.captureApplyEligibility(secondOwner)!;
    const crossOwnerApply = session.applyDraft(secondOwner, secondEligibility);
    expect(crossOwnerApply.accepted).toBe(false);
    expect(crossOwnerApply.reason).toBe("draft-owned-by-another-owner");
    expect(crossOwnerApply.snapshot.hasDraft).toBe(true);
    expect(session.isDraftOwner(firstOwner)).toBe(true);

    expect(session.disposeEditor(secondOwner).accepted).toBe(true);
    const disposedApply = session.applyDraft(secondOwner, secondEligibility);
    expect(disposedApply.accepted).toBe(false);
    expect(disposedApply.reason).toBe("owner-disposed");
    const disposedRelease = session.releaseDraft(secondOwner);
    expect(disposedRelease.accepted).toBe(false);
    expect(disposedRelease.reason).toBe("owner-disposed");
    expect(session.getSnapshot().hasDraft).toBe(true);
    expect(session.isDraftOwner(firstOwner)).toBe(true);

    expect(session.releaseDraft(firstOwner).accepted).toBe(true);
    const firstOwnerEligibility = session.captureApplyEligibility(firstOwner)!;
    expect(session.applyDraft(firstOwner, firstOwnerEligibility).accepted).toBe(true);
    expect(session.disposeEditor(firstOwner).draftReleased).toBe(true);
    expect(session.getSnapshot().hasDraft).toBe(false);
  });

  it("rejects eligibility from a different owner without exposing the opaque handle", () => {
    const session = createAppearanceSession();
    const owner = session.registerEditor();
    const otherOwner = session.registerEditor();
    const eligibility = session.captureApplyEligibility(owner)!;

    const mismatched = session.applyDraft(otherOwner, eligibility);
    expect(mismatched.accepted).toBe(false);
    expect(mismatched.reason).toBe("eligibility-owner-mismatch");
    expect(session.getSnapshot().hasDraft).toBe(false);

    const fakeEligibility = {} as ApplyEligibility;
    expect(session.applyDraft(owner, fakeEligibility).reason).toBe("unknown-eligibility");

    const fakeOwner = {} as EditorHandle;
    expect(session.captureApplyEligibility(fakeOwner)).toBeNull();
    expect(session.releaseDraft(fakeOwner).reason).toBe("unknown-owner");
  });
});

/**
 * Parent-document stylesheet ownership for the Studio appearance boundary.
 *
 * This adapter keeps all attachment identities in a private closure. It does
 * not inspect child documents, interpret CSS, or decide whether a session
 * transition is eligible.
 */

import type {
  AppearanceExternalCssomSlot,
  AppearanceExternalCssomSlots,
} from "./appearance-external-cssom-slots";
import { AppearanceExternalCssomSlotsError } from "./appearance-external-cssom-slots";

export type AppearanceAttachmentKind = "constructable" | "style-element" | "external-cssom";
export type AppearanceRootMode = "light" | "dark";

export interface AppearanceStylesheetChange {
  /** A string stages a fresh baseline; null releases the current baseline. */
  readonly baselineCss?: string | null;
  /** A string stages a fresh draft; null releases the current draft. */
  readonly draftCss?: string | null;
  /** Undefined keeps the owned root value; null removes the owned attribute. */
  readonly rootMode?: AppearanceRootMode | null;
}

export interface AppearanceStylesheetBaselineOptions {
  readonly rootMode?: AppearanceRootMode | null;
  readonly releaseDraft?: boolean;
}

export interface AppearanceStylesheetOwnerOptions {
  /** Browser fixtures may opt into the style-element fallback; native startup does not. */
  readonly allowStyleElementFallback?: boolean;
  /** Native startup supplies the already-prepared external CSSOM slot pool. */
  readonly externalCssomSlots?: AppearanceExternalCssomSlots;
}

export interface AppearanceStylesheetSnapshot {
  readonly attachment: AppearanceAttachmentKind;
  readonly baselineAttached: boolean;
  readonly draftAttached: boolean;
  readonly rootMode: string | null;
  readonly pending: boolean;
  readonly closed: boolean;
}

export type AppearanceStylesheetTransactionStatus =
  | "committed"
  | "rolled-back"
  | "rollback-failed"
  | "commit-failed"
  | "stale";

export interface AppearanceStylesheetTransactionResult {
  readonly ok: boolean;
  readonly status: AppearanceStylesheetTransactionStatus;
  readonly snapshot: AppearanceStylesheetSnapshot;
  readonly reason?: string;
}

export interface AppearanceStylesheetTransaction {
  readonly before: AppearanceStylesheetSnapshot;
  readonly after: AppearanceStylesheetSnapshot;
  /** Finalizes a successful pure-session commit without DOM reordering. */
  commit(): AppearanceStylesheetTransactionResult;
  /** Restores the owned DOM state captured before staging. */
  rollback(): AppearanceStylesheetTransactionResult;
  /** Commits or rolls back after the pure session reports its decision. */
  finalize(accepted: boolean): AppearanceStylesheetTransactionResult;
}

export interface AppearanceStylesheetTeardownResult {
  readonly ok: boolean;
  readonly status: "closed" | "failed";
  readonly baselineReleased: boolean;
  readonly draftReleased: boolean;
  readonly rootRestored: boolean;
  readonly reason?: string;
}

export interface AppearanceStylesheetOwner {
  snapshot(): AppearanceStylesheetSnapshot;
  stage(change: AppearanceStylesheetChange): AppearanceStylesheetTransaction;
  stageBaseline(css: string, options?: AppearanceStylesheetBaselineOptions): AppearanceStylesheetTransaction;
  stageDraft(css: string): AppearanceStylesheetTransaction;
  releaseDraft(): AppearanceStylesheetTransaction;
  teardown(): AppearanceStylesheetTeardownResult;
}

export type AppearanceStylesheetErrorCode =
  | "invalid-change"
  | "owner-closed"
  | "transaction-pending"
  | "capability-unavailable"
  | "attachment-failed"
  | "root-mode-failed"
  | "state-drift"
  | "rollback-failed";

export class AppearanceStylesheetError extends Error {
  readonly code: AppearanceStylesheetErrorCode;

  constructor(code: AppearanceStylesheetErrorCode, message: string) {
    super(message);
    this.name = "AppearanceStylesheetError";
    this.code = code;
  }
}

const ROOT_MODE_ATTRIBUTE = "data-theme";

interface RootState {
  readonly touched: boolean;
  readonly themePresent: boolean;
  readonly themeValue: string | null;
  readonly classPresent: boolean;
  readonly classValue: string | null;
  readonly darkClassPresent: boolean;
}

interface RootCapture {
  readonly themePresent: boolean;
  readonly themeValue: string | null;
  readonly classPresent: boolean;
  readonly classValue: string | null;
  readonly darkClassPresent: boolean;
}

interface ConstructableSheet extends CSSStyleSheet {
  replaceSync(source: string): void;
}

type ConstructableSheetConstructor = new () => ConstructableSheet;

interface ConstructableResource {
  readonly kind: "constructable";
  readonly sheet: ConstructableSheet;
  readonly css: string;
}

interface StyleElementResource {
  readonly kind: "style-element";
  readonly element: HTMLStyleElement;
  readonly css: string;
}

interface ExternalCssomResource {
  readonly kind: "external-cssom";
  readonly role: "baseline" | "draft";
  readonly handle: AppearanceExternalCssomSlot;
  readonly css: string;
}

type OwnedResource = ConstructableResource | StyleElementResource | ExternalCssomResource;

interface ResourcePair {
  readonly baseline: OwnedResource | null;
  readonly draft: OwnedResource | null;
}

interface ResourceReleaseResult {
  readonly ok: boolean;
  readonly baselineReleased: boolean;
  readonly draftReleased: boolean;
  readonly reason?: string;
}

interface TransactionRecord {
  readonly beforeResources: ResourcePair;
  readonly afterResources: ResourcePair;
  readonly beforeRoot: RootState;
  readonly afterRoot: RootState;
  readonly foreignSlot: number | null;
  readonly before: AppearanceStylesheetSnapshot;
  readonly after: AppearanceStylesheetSnapshot;
  state: "pending" | "committed" | "rolled-back" | "rollback-failed" | "commit-failed" | "stale";
  result?: AppearanceStylesheetTransactionResult;
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function resourceList(pair: ResourcePair): OwnedResource[] {
  return [pair.baseline, pair.draft].filter((resource): resource is OwnedResource => resource !== null);
}

function isExternalResource(resource: OwnedResource): resource is ExternalCssomResource {
  return resource.kind === "external-cssom";
}

function resourceIdentity(resource: OwnedResource): object {
  if (resource.kind === "constructable") return resource.sheet;
  if (resource.kind === "style-element") return resource.element;
  return resource.handle;
}

function captureRoot(root: Element | null): RootCapture {
  if (!root) {
    return {
      themePresent: false,
      themeValue: null,
      classPresent: false,
      classValue: null,
      darkClassPresent: false,
    };
  }
  return {
    themePresent: root.hasAttribute(ROOT_MODE_ATTRIBUTE),
    themeValue: root.getAttribute(ROOT_MODE_ATTRIBUTE),
    classPresent: root.hasAttribute("class"),
    classValue: root.getAttribute("class"),
    darkClassPresent: root.classList.contains("dark"),
  };
}

function rootStateFromCapture(capture: RootCapture, touched: boolean): RootState {
  return freeze({ touched, ...capture });
}

function sameRootCapture(left: RootCapture, right: RootCapture): boolean {
  return left.themePresent === right.themePresent &&
    left.themeValue === right.themeValue &&
    left.darkClassPresent === right.darkClassPresent;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasWritableAdoptedSheets(documentValue: Document): boolean {
  let current: object | null = documentValue;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "adoptedStyleSheets");
    if (descriptor) {
      return descriptor.set !== undefined || descriptor.writable === true;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

function constructableSheetConstructor(documentValue: Document): ConstructableSheetConstructor | null {
  const documentWindow = documentValue.defaultView as (Window & { CSSStyleSheet?: unknown }) | null;
  const globalValue = globalThis as typeof globalThis & { CSSStyleSheet?: unknown };
  const candidate = documentWindow?.CSSStyleSheet ?? globalValue.CSSStyleSheet;
  if (
    typeof candidate !== "function" ||
    !("adoptedStyleSheets" in documentValue) ||
    !hasWritableAdoptedSheets(documentValue)
  ) return null;
  try {
    if (!Array.isArray(documentValue.adoptedStyleSheets)) return null;
  } catch {
    return null;
  }
  const prototype = (candidate as { prototype?: { replaceSync?: unknown } }).prototype;
  return typeof prototype?.replaceSync === "function"
    ? (candidate as ConstructableSheetConstructor)
    : null;
}

function makeError(code: AppearanceStylesheetErrorCode, message: string): AppearanceStylesheetError {
  return new AppearanceStylesheetError(code, message);
}

function mapExternalCssomError(error: unknown): AppearanceStylesheetError {
  if (error instanceof AppearanceExternalCssomSlotsError) {
    switch (error.code) {
      case "css-too-large":
      case "forbidden-at-rule":
      case "css-parse-failed":
        return makeError("invalid-change", "Appearance CSS was rejected.");
      case "invalid-resource":
      case "resource-active":
      case "resource-drift":
        return makeError("state-drift", "External CSSOM resource state drifted.");
      case "rollback-failed":
        return makeError("rollback-failed", "External CSSOM rollback failed.");
      case "capability-unavailable":
        return makeError("capability-unavailable", "External CSSOM capability is unavailable.");
      case "closed":
        return makeError("owner-closed", "External CSSOM slots are closed.");
      default:
        return makeError("attachment-failed", "External CSSOM attachment failed.");
    }
  }
  return makeError("attachment-failed", "External CSSOM attachment failed.");
}

function normalizeChange(change: AppearanceStylesheetChange): AppearanceStylesheetChange {
  if (typeof change !== "object" || change === null) {
    throw makeError("invalid-change", "Appearance change must be an object.");
  }
  const result: { baselineCss?: string | null; draftCss?: string | null; rootMode?: AppearanceRootMode | null } = {};
  if (hasOwn(change, "baselineCss")) {
    const value = change.baselineCss;
    if (value !== null && typeof value !== "string") throw makeError("invalid-change", "Baseline CSS must be a string or null.");
    result.baselineCss = value;
  }
  if (hasOwn(change, "draftCss")) {
    const value = change.draftCss;
    if (value !== null && typeof value !== "string") throw makeError("invalid-change", "Draft CSS must be a string or null.");
    result.draftCss = value;
  }
  if (hasOwn(change, "rootMode")) {
    const value = change.rootMode;
    if (value !== null && value !== "light" && value !== "dark") throw makeError("invalid-change", "Root mode must be light, dark, or null.");
    result.rootMode = value;
  }
  return freeze(result);
}

function makeSnapshot(
  attachment: AppearanceAttachmentKind,
  resources: ResourcePair,
  root: RootCapture,
  pending: boolean,
  closed: boolean,
): AppearanceStylesheetSnapshot {
  return freeze({
    attachment,
    baselineAttached: resources.baseline !== null,
    draftAttached: resources.draft !== null,
    rootMode: root.themeValue,
    pending,
    closed,
  });
}

function getStyleParent(documentValue: Document): Element {
  const parent = documentValue.head ?? documentValue.documentElement;
  if (!parent) throw makeError("capability-unavailable", "Parent document has no style parent.");
  return parent;
}

function readAdoptedStyleSheets(documentValue: Document): ConstructableSheet[] {
  const value = (documentValue as Document & { adoptedStyleSheets?: readonly CSSStyleSheet[] }).adoptedStyleSheets;
  if (!Array.isArray(value)) throw makeError("capability-unavailable", "Parent document has no adopted sheet list.");
  return value as ConstructableSheet[];
}

function writeAdoptedStyleSheets(documentValue: Document, sheets: ConstructableSheet[]): void {
  (documentValue as Document & { adoptedStyleSheets: readonly CSSStyleSheet[] }).adoptedStyleSheets = sheets;
}

function sameSheetSequence(left: readonly ConstructableSheet[], right: readonly ConstructableSheet[]): boolean {
  return left.length === right.length && left.every((sheet, index) => sheet === right[index]);
}

function writeAndVerifyAdoptedStyleSheets(documentValue: Document, sheets: ConstructableSheet[]): void {
  writeAdoptedStyleSheets(documentValue, sheets);
  if (!sameSheetSequence(readAdoptedStyleSheets(documentValue), sheets)) {
    throw makeError("attachment-failed", "Adopted sheet attachment did not preserve sheet identity.");
  }
}

function sameResource(resource: OwnedResource, other: OwnedResource): boolean {
  return resource.kind === other.kind && resourceIdentity(resource) === resourceIdentity(other);
}

function resourcesMatchKind(resources: OwnedResource[], kind: AppearanceAttachmentKind): boolean {
  return resources.every((resource) => resource.kind === kind);
}

function countForeignBefore(resources: OwnedResource[], current: OwnedResource[]): number {
  const firstOwned = current.findIndex((candidate) => resources.some((resource) => sameResource(resource, candidate)));
  return current.slice(0, firstOwned < 0 ? current.length : firstOwned).filter(
    (candidate) => !resources.some((resource) => sameResource(resource, candidate)),
  ).length;
}

function replaceConstructableResources(
  documentValue: Document,
  oldResources: OwnedResource[],
  nextResources: OwnedResource[],
  foreignSlot: number,
): void {
  if (!resourcesMatchKind(oldResources, "constructable") || !resourcesMatchKind(nextResources, "constructable")) {
    throw makeError("attachment-failed", "Constructable resources do not match the selected attachment.");
  }
  const current = readAdoptedStyleSheets(documentValue);
  const oldSheets = oldResources.map((resource) => (resource as ConstructableResource).sheet);
  if (oldSheets.some((sheet) => !current.includes(sheet))) {
    throw makeError("state-drift", "An owned adopted sheet is no longer attached.");
  }
  const foreign = current.filter((sheet) => !oldSheets.includes(sheet));
  const slot = Math.max(0, Math.min(foreignSlot, foreign.length));
  const nextSheets = nextResources.map((resource) => (resource as ConstructableResource).sheet);
  const next = [
    ...foreign.slice(0, slot),
    ...nextSheets,
    ...foreign.slice(slot),
  ];
  try {
    writeAndVerifyAdoptedStyleSheets(documentValue, next);
  } catch (error) {
    try {
      writeAndVerifyAdoptedStyleSheets(documentValue, current);
    } catch (restoreError) {
      throw makeError(
        "rollback-failed",
        "Adopted sheet rollback failed.",
      );
    }
    throw makeError("attachment-failed", "Adopted sheet attachment failed.");
  }
}

function currentFallbackChildren(parent: Element): Node[] {
  return Array.from(parent.childNodes);
}

function replaceFallbackResources(
  parent: Element,
  oldResources: OwnedResource[],
  nextResources: OwnedResource[],
  foreignSlot: number,
): void {
  if (!resourcesMatchKind(oldResources, "style-element") || !resourcesMatchKind(nextResources, "style-element")) {
    throw makeError("attachment-failed", "Style-element resources do not match the selected attachment.");
  }
  const currentChildren = currentFallbackChildren(parent);
  const oldElements = oldResources.map((resource) => (resource as StyleElementResource).element);
  if (oldElements.some((element) => element.parentNode !== parent || !currentChildren.includes(element))) {
    throw makeError("state-drift", "An owned style element is no longer attached to the parent document.");
  }
  const foreign = currentChildren.filter((child) => !oldElements.includes(child as HTMLStyleElement));
  const slot = Math.max(0, Math.min(foreignSlot, foreign.length));
  const anchor = foreign[slot] ?? null;

  try {
    for (const element of oldElements) parent.removeChild(element);
    for (const resource of nextResources) {
      parent.insertBefore((resource as StyleElementResource).element, anchor);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const resource of nextResources) {
      const element = (resource as StyleElementResource).element;
      if (element.parentNode === parent) {
        try {
          parent.removeChild(element);
        } catch (removeError) {
          rollbackErrors.push("Style-element cleanup failed.");
        }
      }
    }
    for (const element of oldElements) {
      try {
        parent.insertBefore(element, anchor);
      } catch (restoreError) {
        rollbackErrors.push("Style-element rollback failed.");
      }
    }
    if (rollbackErrors.length > 0) {
      throw makeError("rollback-failed", `Style-element attachment rollback failed: ${rollbackErrors.join("; ")}`);
    }
    throw makeError("attachment-failed", "Style-element attachment failed.");
  }
}

function rootMatchesState(root: Element | null, state: RootState): boolean {
  return sameRootCapture(captureRoot(root), {
    themePresent: state.themePresent,
    themeValue: state.themeValue,
    classPresent: state.classPresent,
    classValue: state.classValue,
    darkClassPresent: state.darkClassPresent,
  });
}

function setRootState(root: Element | null, state: RootState): void {
  if (!root) throw makeError("root-mode-failed", "Parent document has no root element.");
  if (state.themePresent) {
    if (state.themeValue === null) throw makeError("root-mode-failed", "Owned root mode has no value.");
    root.setAttribute(ROOT_MODE_ATTRIBUTE, state.themeValue);
  } else {
    root.removeAttribute(ROOT_MODE_ATTRIBUTE);
  }
  const priorClass = root.getAttribute("class");
  if (state.darkClassPresent) root.classList.add("dark");
  else root.classList.remove("dark");
  if (!state.classPresent && priorClass === "dark" && root.getAttribute("class") === "") root.removeAttribute("class");
  if (!rootMatchesState(root, state)) {
    throw makeError("root-mode-failed", "Root mode did not reach the requested value.");
  }
}

function makeResourcePair(baseline: OwnedResource | null, draft: OwnedResource | null): ResourcePair {
  return freeze({ baseline, draft });
}

export function createAppearanceStylesheetOwner(
  documentValue: Document,
  options: AppearanceStylesheetOwnerOptions = {},
): AppearanceStylesheetOwner {
  if (!documentValue || typeof documentValue !== "object") {
    throw makeError("capability-unavailable", "A parent document is required.");
  }

  const externalCssomSlots = options.externalCssomSlots;
  const constructableConstructor = externalCssomSlots ? null : constructableSheetConstructor(documentValue);
  const allowStyleElementFallback = options.allowStyleElementFallback ?? true;
  if (!externalCssomSlots && !constructableConstructor && !allowStyleElementFallback) {
    throw makeError("capability-unavailable", "Appearance stylesheet backend is unavailable.");
  }
  const attachment: AppearanceAttachmentKind = externalCssomSlots
    ? "external-cssom"
    : constructableConstructor
      ? "constructable"
      : "style-element";
  if (externalCssomSlots) {
    try {
      if (!externalCssomSlots.belongsToDocument(documentValue)) {
        throw makeError("capability-unavailable", "External CSSOM slots belong to another document.");
      }
      externalCssomSlots.verify();
    } catch (error) {
      if (error instanceof AppearanceStylesheetError) throw error;
      throw makeError("capability-unavailable", "External CSSOM slot integrity is unavailable.");
    }
  }
  const styleParent = attachment === "style-element" ? getStyleParent(documentValue) : null;
  const root = documentValue.documentElement;
  const initialRootCapture = captureRoot(root);

  let resources = makeResourcePair(null, null);
  let rootState = rootStateFromCapture(initialRootCapture, false);
  let pending: TransactionRecord | null = null;
  let closed = false;
  let broken = false;
  let terminalTeardown: AppearanceStylesheetTeardownResult | null = null;
  let recoveryResources: OwnedResource[] = [];

  function currentRootCapture(): RootCapture {
    return captureRoot(root);
  }

  function snapshot(): AppearanceStylesheetSnapshot {
    return makeSnapshot(attachment, resources, currentRootCapture(), pending !== null, closed);
  }

  function makeDetachedResource(css: string, role: "baseline" | "draft"): OwnedResource {
    if (attachment === "external-cssom") {
      if (!externalCssomSlots) throw makeError("capability-unavailable", "External CSSOM slots are unavailable.");
      try {
        const handle = externalCssomSlots.acquire(role, css);
        return freeze({ kind: "external-cssom", role, handle, css } as const);
      } catch (error) {
        throw mapExternalCssomError(error);
      }
    }
    if (attachment === "constructable") {
      try {
        if (!constructableConstructor) throw makeError("capability-unavailable", "Constructable sheets are unavailable.");
        const sheet = new constructableConstructor();
        sheet.replaceSync(css);
        return freeze({ kind: "constructable", sheet, css } as const);
      } catch (error) {
        throw makeError("attachment-failed", "Constructable sheet creation failed.");
      }
    }
    if (!styleParent) throw makeError("capability-unavailable", "Style attachment has no parent element.");
    try {
      const element = documentValue.createElement("style");
      if (element.ownerDocument !== documentValue) {
        throw makeError("attachment-failed", "Style element belongs to another document.");
      }
      element.textContent = css;
      return freeze({ kind: "style-element", element, css } as const);
    } catch (error) {
      throw makeError("attachment-failed", "Style element creation failed.");
    }
  }

  function captureForeignSlot(oldResources: OwnedResource[]): number | null {
    if (attachment === "external-cssom") return null;
    if (attachment === "constructable") {
      const current = readAdoptedStyleSheets(documentValue).map(
        (sheet) => freeze({ kind: "constructable", sheet, css: "" }) as OwnedResource,
      );
      return countForeignBefore(oldResources, current);
    }
    if (!styleParent) throw makeError("capability-unavailable", "Style attachment has no parent element.");
    const current = currentFallbackChildren(styleParent)
      .map((element) => freeze({ kind: "style-element", element: element as HTMLStyleElement, css: "" }) as OwnedResource);
    return countForeignBefore(oldResources, current);
  }

  function replaceExternalResources(beforeResources: ResourcePair, afterResources: ResourcePair): void {
    if (attachment !== "external-cssom" || !externalCssomSlots) {
      throw makeError("capability-unavailable", "External CSSOM slots are unavailable.");
    }
    const oldResources = resourceList(beforeResources);
    const nextResources = resourceList(afterResources);
    if (!resourcesMatchKind(oldResources, "external-cssom") || !resourcesMatchKind(nextResources, "external-cssom")) {
      throw makeError("attachment-failed", "External CSSOM resources do not match the selected attachment.");
    }
    const oldToDeactivate = oldResources.filter(
      (resource): resource is ExternalCssomResource => isExternalResource(resource) &&
        !nextResources.some((candidate) => sameResource(resource, candidate)),
    );
    const nextToActivate = nextResources.filter(
      (resource): resource is ExternalCssomResource => isExternalResource(resource) &&
        !oldResources.some((candidate) => sameResource(resource, candidate)),
    );
    const deactivated: ExternalCssomResource[] = [];
    const activated: ExternalCssomResource[] = [];
    try {
      externalCssomSlots.verify();
      for (const resource of oldToDeactivate) {
        externalCssomSlots.deactivate(resource.handle);
        deactivated.push(resource);
      }
      for (const resource of nextToActivate) {
        externalCssomSlots.activate(resource.handle);
        activated.push(resource);
      }
      externalCssomSlots.verify();
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const resource of activated.reverse()) {
        try { externalCssomSlots.deactivate(resource.handle); } catch { rollbackFailures.push("External CSSOM candidate rollback failed."); }
      }
      for (const resource of deactivated.reverse()) {
        try { externalCssomSlots.activate(resource.handle); } catch { rollbackFailures.push("External CSSOM prior-resource restoration failed."); }
      }
      if (rollbackFailures.length > 0) {
        // A failed activation may never reach `activated.push`. Retain the
        // complete before/after union as well as every attempted transition so
        // teardown still has a reachable handle for every acquired slot.
        addRecoveryResources([...oldResources, ...nextResources, ...activated, ...deactivated]);
        throw makeError("rollback-failed", rollbackFailures.join(" "));
      }
      if (error instanceof AppearanceStylesheetError) throw error;
      throw mapExternalCssomError(error);
    }
  }

  function replaceResources(
    beforeResources: ResourcePair,
    afterResources: ResourcePair,
    foreignSlot: number | null,
  ): void {
    const oldResources = resourceList(beforeResources);
    const nextResources = resourceList(afterResources);
    if (attachment === "external-cssom") {
      replaceExternalResources(beforeResources, afterResources);
      return;
    }
    if (attachment === "constructable") {
      if (foreignSlot === null) throw makeError("attachment-failed", "Constructable resources have no foreign insertion slot.");
      replaceConstructableResources(documentValue, oldResources, nextResources, foreignSlot);
      return;
    }
    if (!styleParent) throw makeError("capability-unavailable", "Style attachment has no parent element.");
    if (foreignSlot === null) throw makeError("attachment-failed", "Style-element resources have no foreign insertion slot.");
    replaceFallbackResources(styleParent, oldResources, nextResources, foreignSlot);
  }

  function releaseKnownResources(knownResources: ResourcePair): ResourceReleaseResult {
    const known = resourceList(knownResources);
    if (known.length === 0) {
      if (attachment !== "external-cssom" || recoveryResources.length === 0) {
        return { ok: true, baselineReleased: true, draftReleased: true };
      }
    }

    if (attachment === "external-cssom") {
      const allKnown = [...known, ...recoveryResources].filter(
        (resource, index, candidates) => candidates.findIndex((candidate) => sameResource(candidate, resource)) === index,
      );
      const cleanup = releaseExternalResources(allKnown);
      const baselineReleased = knownResources.baseline === null || !cleanup.remaining.some(
        (resource) => sameResource(resource, knownResources.baseline!),
      );
      const draftReleased = knownResources.draft === null || !cleanup.remaining.some(
        (resource) => sameResource(resource, knownResources.draft!),
      );
      return {
        ok: cleanup.ok && baselineReleased && draftReleased && recoveryResources.length === 0,
        baselineReleased,
        draftReleased,
        ...(cleanup.reason === undefined ? {} : { reason: cleanup.reason }),
      };
    }

    if (attachment === "constructable") {
      let current: ConstructableSheet[];
      try {
        current = readAdoptedStyleSheets(documentValue);
      } catch (error) {
        return {
          ok: false,
          baselineReleased: false,
          draftReleased: false,
          reason: "Appearance adopted-sheet cleanup could not read the current sheet list.",
        };
      }
      const owned = known
        .filter((resource): resource is ConstructableResource => resource.kind === "constructable")
        .map((resource) => resource.sheet);
      const next = current.filter((sheet) => !owned.includes(sheet));
      if (next.length !== current.length) {
        try {
          writeAndVerifyAdoptedStyleSheets(documentValue, next);
        } catch (error) {
          try {
            writeAndVerifyAdoptedStyleSheets(documentValue, current);
          } catch (restoreError) {
            return {
              ok: false,
              baselineReleased: false,
              draftReleased: false,
              reason: "Appearance adopted-sheet cleanup and restoration failed.",
            };
          }
          return {
            ok: false,
            baselineReleased: false,
            draftReleased: false,
            reason: "Appearance adopted-sheet cleanup failed.",
          };
        }
      }
      return { ok: true, baselineReleased: true, draftReleased: true };
    }

    if (!styleParent) {
      return {
        ok: false,
        baselineReleased: false,
        draftReleased: false,
        reason: "Style-element cleanup has no parent element.",
      };
    }
    let failed = false;
    const currentChildren = currentFallbackChildren(styleParent);
    for (const resource of known) {
      if (resource.kind !== "style-element") continue;
      if (resource.element.parentNode !== styleParent || !currentChildren.includes(resource.element)) continue;
      try {
        styleParent.removeChild(resource.element);
      } catch (error) {
        failed = true;
      }
    }
    const remaining = currentFallbackChildren(styleParent);
    const baselineReleased = knownResources.baseline === null || !remaining.includes(
      (knownResources.baseline as StyleElementResource).element,
    );
    const draftReleased = knownResources.draft === null || !remaining.includes(
      (knownResources.draft as StyleElementResource).element,
    );
    return {
      ok: !failed && baselineReleased && draftReleased,
      baselineReleased,
      draftReleased,
      ...(failed || !baselineReleased || !draftReleased
        ? { reason: "Style-element cleanup failed." }
        : {}),
    };
  }

  function applyRootMode(mode: AppearanceRootMode | null): RootState {
    if (!root) throw makeError("root-mode-failed", "Parent document has no root element.");
    if (mode === null) {
      root.removeAttribute(ROOT_MODE_ATTRIBUTE);
      root.classList.remove("dark");
    } else {
      root.setAttribute(ROOT_MODE_ATTRIBUTE, mode);
      if (mode === "dark") root.classList.add("dark");
      else root.classList.remove("dark");
    }
    return rootStateFromCapture(captureRoot(root), true);
  }

  function resourceSetDifference(left: ResourcePair, right: ResourcePair): OwnedResource[] {
    return resourceList(left).filter((candidate) => !resourceList(right).some((current) => sameResource(candidate, current)));
  }

  function addRecoveryResources(candidates: readonly OwnedResource[]): void {
    for (const candidate of candidates) {
      if (!recoveryResources.some((current) => sameResource(current, candidate))) recoveryResources.push(candidate);
    }
  }

  function releaseExternalResources(candidates: readonly OwnedResource[]): {
    readonly ok: boolean;
    readonly remaining: readonly OwnedResource[];
    readonly reason?: string;
  } {
    if (attachment !== "external-cssom") return { ok: true, remaining: [] };
    if (!externalCssomSlots) return { ok: false, remaining: candidates, reason: "External CSSOM slots are unavailable." };
    const remaining: OwnedResource[] = [];
    const failures: string[] = [];
    const released: OwnedResource[] = [];
    for (const candidate of candidates) {
      if (!isExternalResource(candidate)) continue;
      try {
        externalCssomSlots.release(candidate.handle);
        released.push(candidate);
      } catch {
        remaining.push(candidate);
        failures.push("External CSSOM resource cleanup failed.");
      }
    }
    recoveryResources = recoveryResources.filter(
      (candidate) => !released.some((releasedResource) => sameResource(candidate, releasedResource)),
    );
    try { externalCssomSlots.verify(); } catch { failures.push("External CSSOM slot verification failed."); }
    return {
      ok: failures.length === 0 && remaining.length === 0,
      remaining: freeze([...remaining]),
      ...(failures.length === 0 ? {} : { reason: failures.join(" ") }),
    };
  }

  function resourcesForChange(change: AppearanceStylesheetChange): ResourcePair {
    const baselineCss = change.baselineCss;
    const draftCss = change.draftCss;
    let baseline: OwnedResource | null = null;
    try {
      baseline = baselineCss === undefined ? resources.baseline : baselineCss === null ? null : makeDetachedResource(baselineCss, "baseline");
      const draft = draftCss === undefined ? resources.draft : draftCss === null ? null : makeDetachedResource(draftCss, "draft");
      return makeResourcePair(baseline, draft);
    } catch (error) {
      if (baseline && baselineCss !== undefined && baselineCss !== null && attachment === "external-cssom") {
        const cleanup = releaseExternalResources([baseline]);
        if (!cleanup.ok) {
          addRecoveryResources(cleanup.remaining);
          broken = true;
          throw makeError("rollback-failed", cleanup.reason ?? "External CSSOM candidate cleanup failed.");
        }
      }
      throw error;
    }
  }

  function stage(input: AppearanceStylesheetChange): AppearanceStylesheetTransaction {
    if (closed || broken) throw makeError("owner-closed", "Appearance stylesheet owner is not active.");
    if (pending) throw makeError("transaction-pending", "An appearance stylesheet transaction is already pending.");
    const change = normalizeChange(input);

    const beforeResources = resources;
    const beforeRootCapture = currentRootCapture();
    const beforeRoot = rootState.touched
      ? rootState
      : rootStateFromCapture(beforeRootCapture, false);
    const foreignSlot = captureForeignSlot(resourceList(beforeResources));
    const afterResources = resourcesForChange(change);
    let afterRoot = beforeRoot;
    const before = snapshot();

    let rootAttempted = false;
    try {
      if (beforeRoot.touched && !rootMatchesState(root, beforeRoot)) {
        throw makeError("state-drift", "Owned root mode was changed outside the appearance owner.");
      }
      if (hasOwn(change, "rootMode")) {
        const mode = change.rootMode;
        if (mode === undefined) throw makeError("invalid-change", "Root mode cannot be undefined when supplied.");
        rootAttempted = true;
        afterRoot = applyRootMode(mode);
      }
      replaceResources(beforeResources, afterResources, foreignSlot);
    } catch (error) {
      const failures: string[] = [];
      const errorCode = error instanceof AppearanceStylesheetError ? error.code : undefined;
      if (attachment === "external-cssom") {
        const cleanup = releaseExternalResources(resourceSetDifference(afterResources, beforeResources));
        if (!cleanup.ok) {
          addRecoveryResources(cleanup.remaining);
          failures.push(cleanup.reason ?? "External CSSOM candidate cleanup failed.");
        }
      }
      if (rootAttempted) {
        try {
          setRootState(root, beforeRoot);
        } catch (restoreError) {
          failures.push("Root rollback failed.");
        }
      }
      if (errorCode === "rollback-failed") {
        broken = true;
        if (failures.length > 0) {
          throw makeError("rollback-failed", `Appearance staging failed and rollback failed: ${failures.join("; ")}`);
        }
        throw error;
      }
      if (failures.length > 0) {
        broken = true;
        throw makeError("rollback-failed", `Appearance staging failed and rollback failed: ${failures.join("; ")}`);
      }
      throw error;
    }

    resources = afterResources;
    rootState = afterRoot;
    const after = makeSnapshot(attachment, resources, currentRootCapture(), true, false);
    const record: TransactionRecord = {
      beforeResources,
      afterResources,
      beforeRoot,
      afterRoot,
      foreignSlot,
      before,
      after,
      state: "pending",
    };
    pending = record;

    const resultFor = (
      status: AppearanceStylesheetTransactionStatus,
      ok: boolean,
      reason?: string,
      resultSnapshot?: AppearanceStylesheetSnapshot,
    ): AppearanceStylesheetTransactionResult =>
      freeze({
        ok,
        status,
        snapshot: resultSnapshot ?? makeSnapshot(attachment, resources, rootState, pending !== null, closed),
        ...(reason === undefined ? {} : { reason }),
      } as const);

    function terminalResult(): AppearanceStylesheetTransactionResult {
      if (record.result) return record.result;
      const status: AppearanceStylesheetTransactionStatus = record.state === "committed"
        ? "committed"
        : record.state === "rolled-back"
          ? "rolled-back"
          : record.state === "rollback-failed"
            ? "rollback-failed"
            : record.state === "commit-failed"
              ? "commit-failed"
            : "stale";
      return resultFor(status, status === "committed" || status === "rolled-back");
    }

    function commit(): AppearanceStylesheetTransactionResult {
      if (record.state !== "pending") return terminalResult();
      if (pending !== record || closed || broken) {
        record.state = "stale";
        record.result = resultFor("stale", false, "Transaction no longer owns the pending appearance state.");
        return record.result;
      }
      if (attachment === "external-cssom") {
        const cleanup = releaseExternalResources(resourceSetDifference(record.beforeResources, record.afterResources));
        if (!cleanup.ok) {
          addRecoveryResources(cleanup.remaining);
          broken = true;
          pending = null;
          record.state = "commit-failed";
          record.result = resultFor(
            "commit-failed",
            false,
            cleanup.reason ?? "External CSSOM commit cleanup failed.",
          );
          return record.result;
        }
      }
      pending = null;
      record.state = "committed";
      record.result = resultFor(
        "committed",
        true,
        undefined,
        freeze({ ...record.after, pending: false, closed: false } as const),
      );
      return record.result;
    }

    function rollback(): AppearanceStylesheetTransactionResult {
      if (record.state !== "pending") return terminalResult();
      if (pending !== record || closed || broken) {
        record.state = "stale";
        record.result = resultFor("stale", false, "Transaction no longer owns the pending appearance state.");
        return record.result;
      }
      try {
        if (record.afterRoot.touched && !rootMatchesState(root, record.afterRoot)) {
          throw makeError("state-drift", "Owned root mode changed before rollback.");
        }
        replaceResources(record.afterResources, record.beforeResources, record.foreignSlot);
        if (attachment === "external-cssom") {
          const cleanup = releaseExternalResources(resourceSetDifference(record.afterResources, record.beforeResources));
          if (!cleanup.ok) {
            addRecoveryResources(cleanup.remaining);
            resources = record.beforeResources;
            throw makeError("rollback-failed", cleanup.reason ?? "External CSSOM candidate cleanup failed.");
          }
        }
        if (record.afterRoot.touched) setRootState(root, record.beforeRoot);
        resources = record.beforeResources;
        rootState = record.beforeRoot;
        pending = null;
        record.state = "rolled-back";
        record.result = resultFor("rolled-back", true, undefined, record.before);
        return record.result;
      } catch (error) {
        if (attachment === "external-cssom") {
          addRecoveryResources([
            ...resourceList(record.beforeResources),
            ...resourceList(record.afterResources),
          ]);
        }
        broken = true;
        pending = null;
        record.state = "rollback-failed";
        record.result = resultFor(
          "rollback-failed",
          false,
          "Appearance rollback failed.",
        );
        return record.result;
      }
    }

    const transaction: AppearanceStylesheetTransaction = {
      before,
      after,
      commit,
      rollback,
      finalize(accepted: boolean): AppearanceStylesheetTransactionResult {
        return accepted ? commit() : rollback();
      },
    };
    return Object.freeze(transaction);
  }

  function teardown(): AppearanceStylesheetTeardownResult {
    if (terminalTeardown?.ok) return terminalTeardown;
    const pendingBeforeTeardown = pending;
    let pendingFailure: string | undefined;
    if (pending) {
      const rollbackResult = rollbackPending();
      if (!rollbackResult.ok) {
        pendingFailure = rollbackResult.reason ?? "Appearance rollback failed.";
      }
    }

    const hadBaseline = resources.baseline !== null;
    const hadDraft = resources.draft !== null;
    let release: ResourceReleaseResult = {
      ok: true,
      baselineReleased: !hadBaseline,
      draftReleased: !hadDraft,
    };
    const failureReasons: string[] = pendingFailure === undefined ? [] : [pendingFailure];
    const poisoned = broken || pendingFailure !== undefined;
    const poisonBlocksClose = poisoned && attachment !== "external-cssom";
    if (poisonBlocksClose && failureReasons.length === 0) {
      failureReasons.push("Appearance owner cannot safely continue after a rollback failure.");
    }
    let rootRestored = true;
    try {
      if (attachment === "external-cssom") {
        release = releaseKnownResources(resources);
      } else if (broken) {
        release = releaseKnownResources(resources);
      } else {
        try {
          const oldResources = resourceList(resources);
          if (attachment === "constructable") {
            const foreignSlot = captureForeignSlot(oldResources);
            if (foreignSlot === null) throw makeError("attachment-failed", "Constructable resources have no foreign insertion slot.");
            replaceConstructableResources(documentValue, oldResources, [], foreignSlot);
          } else if (styleParent) {
            const foreignSlot = captureForeignSlot(oldResources);
            if (foreignSlot === null) throw makeError("attachment-failed", "Style-element resources have no foreign insertion slot.");
            replaceFallbackResources(styleParent, oldResources, [], foreignSlot);
          }
          release = { ok: true, baselineReleased: hadBaseline, draftReleased: hadDraft };
        } catch (error) {
          const cleanup = releaseKnownResources(resources);
          release = {
            ...cleanup,
            ok: false,
            reason: cleanup.reason ?? "Appearance teardown failed.",
          };
        }
      }
      if (attachment === "external-cssom") {
        resources = makeResourcePair(
          release.baselineReleased ? null : resources.baseline,
          release.draftReleased ? null : resources.draft,
        );
      }
      if (!release.ok && release.reason) failureReasons.push(release.reason);
      const beforeCapture = currentRootCapture();
      if (rootState.touched) {
        if (!sameRootCapture(beforeCapture, {
          themePresent: rootState.themePresent,
          themeValue: rootState.themeValue,
          classPresent: rootState.classPresent,
          classValue: rootState.classValue,
          darkClassPresent: rootState.darkClassPresent,
        })) {
          rootRestored = false;
          failureReasons.push("Owned root mode changed outside the appearance owner.");
        } else {
          try {
            const restoredRootState = rootStateFromCapture(initialRootCapture, false);
            setRootState(root, restoredRootState);
            rootState = restoredRootState;
          } catch (error) {
            rootRestored = false;
            failureReasons.push("Appearance root restoration failed.");
          }
        }
      }
      if (failureReasons.length > 0 || !rootRestored || poisonBlocksClose) {
        if (release.baselineReleased && release.draftReleased && recoveryResources.length === 0) {
          closed = true;
          resources = makeResourcePair(null, null);
        }
        terminalTeardown = freeze({
          ok: false,
          status: "failed",
          baselineReleased: release.baselineReleased,
          draftReleased: release.draftReleased,
          rootRestored,
          reason: failureReasons.join(" "),
        } as const);
        if (pendingBeforeTeardown && pendingBeforeTeardown.state !== "rollback-failed") {
          pendingBeforeTeardown.state = "stale";
          pendingBeforeTeardown.result = freeze({
            ok: false,
            status: "stale",
            snapshot: makeSnapshot(attachment, resources, currentRootCapture(), false, true),
            reason: "Owner teardown invalidated the pending transaction.",
          } as const);
        }
        return terminalTeardown;
      }
      closed = true;
      resources = makeResourcePair(null, null);
      recoveryResources = [];
      if (pendingBeforeTeardown) {
        pendingBeforeTeardown.state = "stale";
        pendingBeforeTeardown.result = freeze({
          ok: false,
          status: "stale",
          snapshot: makeSnapshot(attachment, resources, currentRootCapture(), false, true),
          reason: "Owner teardown invalidated the pending transaction.",
        } as const);
      }
      terminalTeardown = freeze({
        ok: true,
        status: "closed",
        baselineReleased: release.baselineReleased,
        draftReleased: release.draftReleased,
        rootRestored: true,
      } as const);
      return terminalTeardown;
    } catch (error) {
      terminalTeardown = freeze({
        ok: false,
        status: "failed",
        baselineReleased: release.baselineReleased,
        draftReleased: release.draftReleased,
        rootRestored,
        reason: "Appearance teardown failed.",
      } as const);
      return terminalTeardown;
    }
  }

  function rollbackPending(): AppearanceStylesheetTransactionResult {
    if (!pending) {
      return freeze({ ok: true, status: "rolled-back", snapshot: snapshot() } as const);
    }
    const record = pending;
    try {
      if (record.afterRoot.touched && !rootMatchesState(root, record.afterRoot)) {
        throw makeError("state-drift", "Owned root mode changed before pending teardown.");
      }
      replaceResources(record.afterResources, record.beforeResources, record.foreignSlot);
      if (attachment === "external-cssom") {
        const cleanup = releaseExternalResources(resourceSetDifference(record.afterResources, record.beforeResources));
        if (!cleanup.ok) {
          addRecoveryResources(cleanup.remaining);
          resources = record.beforeResources;
          throw makeError("rollback-failed", cleanup.reason ?? "External CSSOM candidate cleanup failed.");
        }
      }
      if (record.afterRoot.touched) setRootState(root, record.beforeRoot);
      resources = record.beforeResources;
      rootState = record.beforeRoot;
      pending = null;
      record.state = "rolled-back";
      record.result = freeze({ ok: true, status: "rolled-back", snapshot: snapshot() } as const);
      return record.result;
    } catch (error) {
      if (attachment === "external-cssom") {
        addRecoveryResources([
          ...resourceList(record.beforeResources),
          ...resourceList(record.afterResources),
        ]);
      }
      broken = true;
      pending = null;
      record.state = "rollback-failed";
      record.result = freeze({
        ok: false,
        status: "rollback-failed",
        snapshot: makeSnapshot(attachment, resources, rootState, false, closed),
        reason: "Appearance rollback failed.",
      } as const);
      return record.result;
    }
  }

  const owner: AppearanceStylesheetOwner = {
    snapshot,
    stage,
    stageBaseline(css: string, options: AppearanceStylesheetBaselineOptions = {}): AppearanceStylesheetTransaction {
      return stage({
        baselineCss: css,
        ...(options.rootMode === undefined ? {} : { rootMode: options.rootMode }),
        ...(options.releaseDraft ? { draftCss: null } : {}),
      });
    },
    stageDraft(css: string): AppearanceStylesheetTransaction {
      return stage({ draftCss: css });
    },
    releaseDraft(): AppearanceStylesheetTransaction {
      return stage({ draftCss: null });
    },
    teardown,
  };

  return Object.freeze(owner);
}

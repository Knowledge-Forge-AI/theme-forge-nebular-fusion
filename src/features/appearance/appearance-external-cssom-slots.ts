const APPEARANCE_OWNED_SLOT_PATH = "/appearance-owned-slot.css";
const APPEARANCE_OWNED_SLOT_MEDIA = "not all";
const APPEARANCE_ACTIVE_MEDIA = "all";
const APPEARANCE_OWNED_SLOT_COUNT = 4;
const APPEARANCE_PREPARE_TIMEOUT_MS = 5_000;
const APPEARANCE_MAX_CSS_BYTES = 1024 * 1024;
const APPEARANCE_INERT_PROPERTY = "--theme-forge-appearance-owned-slot-inert";
const APPEARANCE_INERT_VALUE = "0";
const FORBIDDEN_AT_RULE = /(?:^|[\s;{}])@(import|charset|namespace)\b/i;

export const APPEARANCE_EXTERNAL_CSSOM_SLOT_PATH = APPEARANCE_OWNED_SLOT_PATH;
export const APPEARANCE_EXTERNAL_CSSOM_SLOT_COUNT = APPEARANCE_OWNED_SLOT_COUNT;
export const APPEARANCE_EXTERNAL_CSSOM_SLOTS_PER_ROLE = APPEARANCE_OWNED_SLOT_COUNT / 2;
export const APPEARANCE_EXTERNAL_CSSOM_PREPARE_TIMEOUT_MS = APPEARANCE_PREPARE_TIMEOUT_MS;
export const APPEARANCE_EXTERNAL_CSSOM_MAX_CSS_BYTES = APPEARANCE_MAX_CSS_BYTES;

export type AppearanceExternalCssomSlotState = "staged" | "active";
export type AppearanceExternalCssomSlotRole = "baseline" | "draft";

declare const appearanceExternalCssomSlotBrand: unique symbol;

export interface AppearanceExternalCssomSlot {
  readonly [appearanceExternalCssomSlotBrand]: never;
}

export type AppearanceExternalCssomSlotsErrorCode =
  | "invalid-document"
  | "capability-unavailable"
  | "aborted"
  | "timeout"
  | "load-failed"
  | "asset-invalid"
  | "cleanup-failed"
  | "closed"
  | "invalid-resource"
  | "resource-active"
  | "resource-drift"
  | "pool-exhausted"
  | "css-too-large"
  | "forbidden-at-rule"
  | "css-parse-failed"
  | "rollback-failed";

export class AppearanceExternalCssomSlotsError extends Error {
  readonly code: AppearanceExternalCssomSlotsErrorCode;

  constructor(code: AppearanceExternalCssomSlotsErrorCode, message: string) {
    super(message);
    this.name = "AppearanceExternalCssomSlotsError";
    this.code = code;
  }
}

export interface AppearanceExternalCssomSlotsTeardownResult {
  readonly ok: boolean;
  readonly releasedLinks: number;
  readonly remainingOwnedLinks: number;
  readonly reason?: string;
}

export interface AppearanceExternalCssomSlots {
  acquire(role: AppearanceExternalCssomSlotRole, css: string): AppearanceExternalCssomSlot;
  stage(resource: AppearanceExternalCssomSlot, css: string): void;
  activate(resource: AppearanceExternalCssomSlot): void;
  deactivate(resource: AppearanceExternalCssomSlot): void;
  release(resource: AppearanceExternalCssomSlot): void;
  /** Returns whether this opaque capability was prepared for the given document. */
  belongsToDocument(documentValue: Document): boolean;
  verify(): void;
  dispose(): AppearanceExternalCssomSlotsTeardownResult;
  teardown(): AppearanceExternalCssomSlotsTeardownResult;
}

interface LoadedLink {
  readonly link: HTMLLinkElement;
  readonly sheet: CSSStyleSheet;
}

interface PendingLinkLoad {
  readonly link: HTMLLinkElement;
  readonly promise: Promise<LoadedLink>;
  cancel(error: Error): void;
}

interface SlotRecord {
  readonly link: HTMLLinkElement;
  readonly sheet: CSSStyleSheet;
  readonly role: AppearanceExternalCssomSlotRole;
  readonly baseRules: readonly CSSRule[];
  readonly baseRuleCssTexts: readonly string[];
  readonly inertDeclarations: InertDeclarationSnapshot;
  handle: AppearanceExternalCssomSlot | null;
  state: "free" | AppearanceExternalCssomSlotState | "poisoned";
  group: CSSMediaRule | null;
  groupCssText: string | null;
  css: string | null;
}

interface RootLocation {
  readonly href: string;
  readonly origin: string;
}

interface InertDeclarationSnapshot {
  readonly count: number;
  readonly names: readonly string[];
  readonly priorities: readonly string[];
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function makeError(code: AppearanceExternalCssomSlotsErrorCode, message: string): AppearanceExternalCssomSlotsError {
  return new AppearanceExternalCssomSlotsError(code, message);
}

function isAbortError(error: unknown): error is AppearanceExternalCssomSlotsError {
  return error instanceof AppearanceExternalCssomSlotsError && error.code === "aborted";
}

function ruleList(sheet: CSSStyleSheet): CSSRule[] {
  const rules: CSSRule[] = [];
  const list = sheet.cssRules;
  for (let index = 0; index < list.length; index += 1) {
    const rule = list.item(index);
    if (!rule) throw makeError("resource-drift", "A stylesheet rule disappeared while it was being inspected.");
    rules.push(rule);
  }
  return rules;
}

function ruleIndex(sheet: CSSStyleSheet, target: CSSRule): number {
  return ruleList(sheet).findIndex((rule) => rule === target);
}

function conditionText(rule: CSSRule): string | null {
  const candidate = rule as CSSMediaRule;
  return typeof candidate.conditionText === "string" ? candidate.conditionText.trim() : null;
}

function mediaChildren(rule: CSSRule): CSSRule[] {
  const candidate = rule as CSSMediaRule;
  if (!candidate.cssRules) throw makeError("asset-invalid", "The fixed slot asset has no media rule list.");
  const children: CSSRule[] = [];
  for (let index = 0; index < candidate.cssRules.length; index += 1) {
    const child = candidate.cssRules.item(index);
    if (!child) throw makeError("asset-invalid", "The fixed slot asset has an incomplete media rule.");
    children.push(child);
  }
  return children;
}

function ruleCssText(rule: CSSRule): string {
  const text = rule.cssText;
  if (typeof text !== "string") throw makeError("asset-invalid", "A stylesheet rule has no canonical CSS text.");
  return text;
}

function captureRuleCssTexts(rules: readonly CSSRule[]): readonly string[] {
  return freeze(rules.map((rule) => ruleCssText(rule)));
}

function captureInertDeclarations(rules: readonly CSSRule[]): InertDeclarationSnapshot {
  const outer = rules[0];
  if (rules.length !== 1 || !outer || conditionText(outer) !== APPEARANCE_OWNED_SLOT_MEDIA) {
    throw makeError("asset-invalid", "The fixed slot asset must contain one not-all media group.");
  }
  const inner = mediaChildren(outer);
  const styleRule = inner[0] as CSSStyleRule | undefined;
  if (!styleRule || inner.length !== 1 || styleRule.selectorText.trim() !== ":root") {
    throw makeError("asset-invalid", "The fixed slot asset does not match its inert rule contract.");
  }
  const style = styleRule.style;
  const names: string[] = [];
  const priorities: string[] = [];
  for (let index = 0; index < style.length; index += 1) {
    const name = style.item(index);
    if (!name) throw makeError("asset-invalid", "The fixed slot asset has an unnamed declaration.");
    names.push(name);
    priorities.push(style.getPropertyPriority(name));
  }
  if (
    names.length !== 1 ||
    names[0] !== APPEARANCE_INERT_PROPERTY ||
    priorities[0] !== "" ||
    style.getPropertyValue(APPEARANCE_INERT_PROPERTY).trim() !== APPEARANCE_INERT_VALUE
  ) {
    throw makeError("asset-invalid", "The fixed slot asset does not match its inert declaration contract.");
  }
  return freeze({ count: names.length, names: freeze(names), priorities: freeze(priorities) });
}

function hasExpectedInertShape(rules: readonly CSSRule[], expected: InertDeclarationSnapshot): boolean {
  try {
    const current = captureInertDeclarations(rules);
    return (
      current.count === expected.count &&
      current.names.length === expected.names.length &&
      current.names.every((name, index) => name === expected.names[index]) &&
      current.priorities.length === expected.priorities.length &&
      current.priorities.every((priority, index) => priority === expected.priorities[index])
    );
  } catch {
    return false;
  }
}

function validateInertSheet(sheet: CSSStyleSheet): readonly CSSRule[] {
  let rules: CSSRule[];
  try {
    rules = ruleList(sheet);
  } catch {
    throw makeError("asset-invalid", "The fixed slot asset cannot be read.");
  }
  try {
    const outer = rules[0];
    if (rules.length !== 1 || !outer || conditionText(outer) !== APPEARANCE_OWNED_SLOT_MEDIA) {
      throw makeError("asset-invalid", "The fixed slot asset must contain one not-all media group.");
    }
    captureInertDeclarations(rules);
    return freeze([...rules]);
  } catch (error) {
    if (error instanceof AppearanceExternalCssomSlotsError) throw error;
    throw makeError("asset-invalid", "The fixed slot asset is malformed.");
  }
}

function cssByteLength(css: string): number {
  return new TextEncoder().encode(css).byteLength;
}

function validateCss(css: string): void {
  if (typeof css !== "string") throw makeError("css-parse-failed", "Staged CSS must be a string.");
  if (cssByteLength(css) > APPEARANCE_MAX_CSS_BYTES) {
    throw makeError("css-too-large", "Staged CSS exceeds the one MiB limit.");
  }
  if (FORBIDDEN_AT_RULE.test(css)) {
    throw makeError("forbidden-at-rule", "Staged CSS cannot contain import, charset, or namespace at-rules.");
  }
}

function captureLocation(documentValue: Document): RootLocation {
  const location = documentValue.location;
  if (!location || typeof location.href !== "string" || typeof location.origin !== "string") {
    throw makeError("capability-unavailable", "The parent document has no usable same-origin location.");
  }
  let documentUrl: URL;
  let assetUrl: URL;
  try {
    documentUrl = new URL(location.href);
    assetUrl = new URL(APPEARANCE_OWNED_SLOT_PATH, documentUrl.href);
  } catch {
    throw makeError("capability-unavailable", "The parent document has no supported self URL.");
  }
  const hasCredentials = documentUrl.username !== "" || documentUrl.password !== "";
  const isHttpSelf =
    (documentUrl.protocol === "http:" || documentUrl.protocol === "https:") &&
    !hasCredentials &&
    location.origin !== "null" &&
    documentUrl.origin === location.origin &&
    assetUrl.origin === documentUrl.origin;
  const isTauriSelf =
    documentUrl.protocol === "tauri:" &&
    documentUrl.hostname === "localhost" &&
    documentUrl.port === "" &&
    !hasCredentials &&
    assetUrl.protocol === "tauri:" &&
    assetUrl.hostname === "localhost" &&
    assetUrl.port === "" &&
    assetUrl.username === "" &&
    assetUrl.password === "" &&
    assetUrl.pathname === APPEARANCE_OWNED_SLOT_PATH;
  if (!isHttpSelf && !isTauriSelf) {
    throw makeError("capability-unavailable", "The parent document is not an allowed self URL.");
  }
  return freeze({ href: assetUrl.href, origin: isTauriSelf ? "tauri://localhost" : documentUrl.origin });
}

function capturedAdoptedStyleSheets(documentValue: Document): readonly CSSStyleSheet[] {
  if (!("adoptedStyleSheets" in documentValue)) return [];
  const sheets = (documentValue as Document & { readonly adoptedStyleSheets?: readonly CSSStyleSheet[] }).adoptedStyleSheets;
  return sheets ? freeze(Array.from(sheets)) : [];
}

function ownedLinksAreContiguous(parent: Node, links: readonly HTMLLinkElement[]): boolean {
  if (links.some((link) => link.parentNode !== parent)) return false;
  for (let index = 0; index + 1 < links.length; index += 1) {
    if (links[index]!.nextSibling !== links[index + 1]) return false;
  }
  return true;
}

function removeOwnedLinks(parent: Node, links: readonly HTMLLinkElement[]): string[] {
  const failures: string[] = [];
  for (const link of links) {
    if (link.parentNode === null) continue;
    if (link.parentNode !== parent) {
      failures.push("An owned link was reparented and was left untouched.");
      continue;
    }
    try {
      parent.removeChild(link);
    } catch {
      failures.push("An owned link could not be removed.");
    }
  }
  return failures;
}

function loadedSheet(link: HTMLLinkElement): CSSStyleSheet {
  let sheet: StyleSheet | null;
  try {
    sheet = link.sheet;
  } catch {
    throw makeError("load-failed", "The stylesheet could not be read.");
  }
  if (!sheet || !("cssRules" in sheet)) throw makeError("load-failed", "The link completed without a CSS stylesheet.");
  return sheet as CSSStyleSheet;
}

function loadLink(
  parent: Node,
  documentValue: Document,
  href: string,
  signal: AbortSignal | undefined,
): PendingLinkLoad {
  if (signal?.aborted) throw makeError("aborted", "Appearance slot preparation was aborted.");
  const link = documentValue.createElement("link");
  link.rel = "stylesheet";
  link.media = APPEARANCE_OWNED_SLOT_MEDIA;
  link.href = href;

  let settled = false;
  let resolvePromise!: (value: LoadedLink) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<LoadedLink>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);

  const cleanup = (): void => {
    link.removeEventListener("load", onLoad);
    link.removeEventListener("error", onError);
  };
  const finish = (error: AppearanceExternalCssomSlotsError | null): void => {
    if (settled) return;
    if (error) {
      settled = true;
      cleanup();
      rejectPromise(error);
      return;
    }
    let sheet: CSSStyleSheet;
    try {
      sheet = loadedSheet(link);
    } catch (loadError) {
      settled = true;
      cleanup();
      rejectPromise(
        loadError instanceof AppearanceExternalCssomSlotsError
          ? loadError
          : makeError("load-failed", "The stylesheet load was invalid."),
      );
      return;
    }
    settled = true;
    cleanup();
    resolvePromise({ link, sheet });
  };
  const onLoad = (): void => {
    try {
      finish(null);
    } catch {
      finish(makeError("load-failed", "The stylesheet load was invalid."));
    }
  };
  const onError = (): void => finish(makeError("load-failed", "The fixed slot stylesheet failed to load."));

  link.addEventListener("load", onLoad, { once: true });
  link.addEventListener("error", onError, { once: true });
  try {
    parent.appendChild(link);
    const candidate = link.sheet;
    if (candidate && "cssRules" in candidate && (candidate as CSSStyleSheet).cssRules.length > 0) onLoad();
  } catch {
    finish(makeError("load-failed", "The fixed slot link could not be attached."));
  }

  return {
    link,
    promise,
    cancel(error: Error): void {
      if (settled) return;
      finish(error instanceof AppearanceExternalCssomSlotsError ? error : makeError("aborted", "Appearance slot preparation was aborted."));
    },
  };
}

function makeSlotHandle(): AppearanceExternalCssomSlot {
  return freeze({}) as AppearanceExternalCssomSlot;
}

function sameRuleSnapshot(
  beforeRules: readonly CSSRule[],
  beforeCssTexts: readonly string[],
  afterRules: readonly CSSRule[],
): boolean {
  if (beforeRules.length !== afterRules.length || beforeCssTexts.length !== afterRules.length) return false;
  for (let index = 0; index < beforeRules.length; index += 1) {
    if (beforeRules[index] !== afterRules[index] || ruleCssText(afterRules[index]!) !== beforeCssTexts[index]) return false;
  }
  return true;
}

function sheetMatchesSnapshot(
  sheet: CSSStyleSheet,
  beforeRules: readonly CSSRule[],
  beforeCssTexts: readonly string[],
): boolean {
  try {
    return sameRuleSnapshot(beforeRules, beforeCssTexts, ruleList(sheet));
  } catch {
    return false;
  }
}

function insertGroup(sheet: CSSStyleSheet, css: string): CSSMediaRule {
  let beforeRules: CSSRule[];
  let beforeCssTexts: readonly string[];
  let index: number;
  try {
    beforeRules = ruleList(sheet);
    beforeCssTexts = captureRuleCssTexts(beforeRules);
    index = sheet.insertRule(`@media all {${css}}`, beforeRules.length);
  } catch {
    throw makeError("css-parse-failed", "CSSOM rejected staged CSS.");
  }
  let rules: CSSRule[];
  try {
    rules = ruleList(sheet);
  } catch {
    throw makeError("css-parse-failed", "CSSOM did not expose the staged CSSOM group.");
  }
  try {
    const group = rules[index] as CSSMediaRule | undefined;
    if (
      !group ||
      conditionText(group) !== APPEARANCE_ACTIVE_MEDIA ||
      index !== beforeRules.length ||
      rules.length !== beforeRules.length + 1 ||
      !sameRuleSnapshot(beforeRules, beforeCssTexts, rules.slice(0, beforeRules.length))
    ) {
      throw makeError("css-parse-failed", "CSSOM did not create the expected always-matching group.");
    }
    return group;
  } catch (error) {
    if (error instanceof AppearanceExternalCssomSlotsError) throw error;
    throw makeError("css-parse-failed", "CSSOM did not create the expected always-matching group.");
  }
}

function removeRule(sheet: CSSStyleSheet, target: CSSRule): void {
  const index = ruleIndex(sheet, target);
  if (index < 0) throw makeError("resource-drift", "An owned CSSOM group is no longer present.");
  try {
    sheet.deleteRule(index);
  } catch {
    throw makeError("resource-drift", "An owned CSSOM group could not be removed.");
  }
}

function ruleShapeMatches(record: SlotRecord): boolean {
  const rules = ruleList(record.sheet);
  if (rules.length !== record.baseRules.length + (record.group ? 1 : 0)) return false;
  for (let index = 0; index < record.baseRules.length; index += 1) {
    if (rules[index] !== record.baseRules[index] || ruleCssText(rules[index]!) !== record.baseRuleCssTexts[index]) return false;
  }
  if (!hasExpectedInertShape(rules.slice(0, record.baseRules.length), record.inertDeclarations)) return false;
  if (record.group === null) return true;
  const currentGroup = rules[record.baseRules.length];
  return (
    currentGroup === record.group &&
    record.groupCssText !== null &&
    ruleCssText(currentGroup!) === record.groupCssText
  );
}

function setMediaVerified(record: SlotRecord, target: string, previous: string): void {
  let writeFailed = false;
  try {
    record.link.media = target;
  } catch {
    writeFailed = true;
  }
  let reachedTarget = false;
  try {
    reachedTarget = record.link.media === target;
  } catch {
    reachedTarget = false;
  }
  if (!writeFailed && reachedTarget) return;

  let restored = false;
  try {
    record.link.media = previous;
  } catch {
    // Readback below distinguishes a setter that throws after applying its value.
  }
  try {
    restored = record.link.media === previous;
  } catch {
    restored = false;
  }
  if (!restored) {
    record.state = "poisoned";
    throw makeError("rollback-failed", "The link media transition could not be safely rolled back.");
  }
  throw makeError("resource-drift", "The link media transition did not reach its requested state.");
}

export async function prepareAppearanceExternalCssomSlots(
  documentValue: Document,
  signal?: AbortSignal,
): Promise<AppearanceExternalCssomSlots> {
  if (!documentValue || typeof documentValue !== "object") {
    throw makeError("invalid-document", "A parent document is required.");
  }
  const parent = documentValue.head;
  if (!parent) throw makeError("capability-unavailable", "The parent document has no head element.");
  const location = captureLocation(documentValue);
  const ownedLinks: HTMLLinkElement[] = [];
  const pendingLoads: PendingLinkLoad[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancelAll = (error: Error): void => {
    for (const pending of pendingLoads) pending.cancel(error);
  };
  const onAbort = (): void => cancelAll(makeError("aborted", "Appearance slot preparation was aborted."));

  try {
    if (signal?.aborted) throw makeError("aborted", "Appearance slot preparation was aborted.");
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => cancelAll(makeError("timeout", "Appearance slot preparation timed out.")), APPEARANCE_PREPARE_TIMEOUT_MS);
    for (let index = 0; index < APPEARANCE_OWNED_SLOT_COUNT; index += 1) {
      const pending = loadLink(parent, documentValue, location.href, signal);
      ownedLinks.push(pending.link);
      pendingLoads.push(pending);
      if (signal?.aborted) {
        pending.cancel(makeError("aborted", "Appearance slot preparation was aborted."));
        throw makeError("aborted", "Appearance slot preparation was aborted.");
      }
    }
    const loaded = await Promise.all(pendingLoads.map((pending) => pending.promise));
    if (signal?.aborted) throw makeError("aborted", "Appearance slot preparation was aborted.");
    const sheets = loaded.map((entry) => entry.sheet);
    if (new Set(sheets).size !== APPEARANCE_OWNED_SLOT_COUNT) {
      throw makeError("asset-invalid", "Each owned link must expose a distinct CSS stylesheet.");
    }
    if (!ownedLinksAreContiguous(parent, ownedLinks)) {
      throw makeError("resource-drift", "The owned stylesheet block changed during preparation.");
    }
    if (capturedAdoptedStyleSheets(documentValue).length !== 0) {
      throw makeError("capability-unavailable", "The parent document has foreign adopted stylesheets.");
    }
    const records: SlotRecord[] = loaded.map(({ link, sheet }, index) => {
      const baseRules = validateInertSheet(sheet);
      const baseRuleCssTexts = captureRuleCssTexts(baseRules);
      const inertDeclarations = captureInertDeclarations(baseRules);
      if (link.disabled || sheet.disabled) {
        throw makeError("resource-drift", "An owned stylesheet started disabled.");
      }
      return {
        link,
        sheet,
        role: index < APPEARANCE_EXTERNAL_CSSOM_SLOTS_PER_ROLE ? "baseline" : "draft",
        baseRules,
        baseRuleCssTexts,
        inertDeclarations,
        handle: null,
        state: "free" as const,
        group: null,
        groupCssText: null,
        css: null,
      };
    });
    if (documentValue.head !== parent || parent.ownerDocument !== documentValue || !parent.isConnected) {
      throw makeError("resource-drift", "The bound document head changed or disconnected.");
    }
    for (const record of records) {
      if (
        record.link.href !== location.href ||
        record.link.rel !== "stylesheet" ||
        record.link.media !== APPEARANCE_OWNED_SLOT_MEDIA ||
        record.link.disabled ||
        record.sheet.disabled
      ) {
        throw makeError("resource-drift", "An owned link changed before preparation completed.");
      }
    }

    let closed = false;
    let terminalRemovalStarted = false;
    const terminalRemovedRecords = new Set<SlotRecord>();
    let terminalTeardown: AppearanceExternalCssomSlotsTeardownResult | null = null;
    const handles = new WeakMap<AppearanceExternalCssomSlot, SlotRecord>();

    const assertOpen = (): void => {
      if (closed || terminalRemovalStarted) throw makeError("closed", "Appearance CSSOM slots are closed.");
    };
    const recordFor = (resource: AppearanceExternalCssomSlot): SlotRecord => {
      const record = handles.get(resource);
      if (!record) throw makeError("invalid-resource", "The resource does not belong to this slot capability.");
      return record;
    };
    const assertRecord = (record: SlotRecord): void => {
      if (record.state === "poisoned") throw makeError("resource-drift", "The owned resource is no longer trustworthy.");
      try {
        if (documentValue.head !== parent || parent.ownerDocument !== documentValue || !parent.isConnected) {
          throw makeError("resource-drift", "The bound document head changed or disconnected.");
        }
        if (record.link.parentNode !== parent) throw makeError("resource-drift", "An owned link was reparented.");
        if (record.link.href !== location.href || record.link.rel !== "stylesheet") {
          throw makeError("resource-drift", "An owned link URL or relation changed.");
        }
        if (record.link.disabled || record.sheet.disabled) {
          throw makeError("resource-drift", "An owned stylesheet disabled state changed.");
        }
        const expectedMedia = record.state === "active" ? APPEARANCE_ACTIVE_MEDIA : APPEARANCE_OWNED_SLOT_MEDIA;
        if (record.link.media !== expectedMedia) throw makeError("resource-drift", "An owned link media state changed.");
        if (record.link.sheet !== record.sheet) throw makeError("resource-drift", "An owned link stylesheet identity changed.");
        if (!ruleShapeMatches(record)) throw makeError("resource-drift", "An owned stylesheet rule set changed.");
      } catch (error) {
        if (error instanceof AppearanceExternalCssomSlotsError) throw error;
        throw makeError("resource-drift", "An owned stylesheet rule set changed.");
      }
    };
    const assertPoolIntegrity = (): void => {
      if (documentValue.head !== parent || parent.ownerDocument !== documentValue || !parent.isConnected) {
        throw makeError("resource-drift", "The bound document head changed or disconnected.");
      }
      if (capturedAdoptedStyleSheets(documentValue).length !== 0) {
        throw makeError("resource-drift", "The parent document has foreign adopted stylesheets.");
      }
      const ownedLinks = records.map((record) => record.link);
      if (!ownedLinksAreContiguous(parent, ownedLinks)) {
        throw makeError("resource-drift", "The owned stylesheet block changed position or contiguity.");
      }
      records.forEach((record, index) => {
        const expectedRole = index < APPEARANCE_EXTERNAL_CSSOM_SLOTS_PER_ROLE ? "baseline" : "draft";
        if (record.role !== expectedRole) throw makeError("resource-drift", "An owned stylesheet role changed.");
        assertRecord(record);
      });
    };
    const stageRecord = (record: SlotRecord, css: string): void => {
      validateCss(css);
      if (record.state === "active") throw makeError("resource-active", "Stage requires a disabled resource.");
      if (record.state !== "staged") throw makeError("invalid-resource", "The resource is not acquired.");
      assertRecord(record);
      const oldGroup = record.group;
      const oldGroupCssText = record.groupCssText;
      const oldCss = record.css;
      const beforeRules = ruleList(record.sheet);
      const beforeCssTexts = captureRuleCssTexts(beforeRules);
      let oldGroupRemoved = false;
      let newGroup: CSSMediaRule | null = null;
      try {
        newGroup = insertGroup(record.sheet, css);
        if (oldGroup) {
          removeRule(record.sheet, oldGroup);
          oldGroupRemoved = true;
        }
        record.group = newGroup;
        record.groupCssText = ruleCssText(newGroup);
        record.css = css;
        assertRecord(record);
      } catch (error) {
        if (!newGroup && !sheetMatchesSnapshot(record.sheet, beforeRules, beforeCssTexts)) {
          record.state = "poisoned";
          throw makeError("rollback-failed", "CSSOM staging changed an unknown rule set.");
        }
        const rollbackErrors: string[] = [];
        if (newGroup) {
          try {
            removeRule(record.sheet, newGroup);
          } catch (rollbackError) {
            rollbackErrors.push("The new CSSOM group could not be removed.");
          }
        }
        if (oldGroup && oldCss !== null && oldGroupRemoved) {
          try {
            const restored = insertGroup(record.sheet, oldCss);
            record.group = restored;
            record.groupCssText = ruleCssText(restored);
            record.css = oldCss;
          } catch {
            rollbackErrors.push("The prior CSSOM group could not be restored.");
          }
        } else {
          record.group = oldGroup;
          record.groupCssText = oldGroupCssText;
          record.css = oldCss;
        }
        if (rollbackErrors.length === 0) {
          try {
            assertRecord(record);
          } catch {
            rollbackErrors.push("The prior CSSOM state could not be verified.");
          }
        }
        if (rollbackErrors.length > 0) {
          record.state = "poisoned";
          throw makeError("rollback-failed", `CSSOM staging rollback failed: ${rollbackErrors.join("; ")}`);
        }
        throw error;
      }
    };

    const failedDisposal = (reason: string, releasedLinks = 0): AppearanceExternalCssomSlotsTeardownResult => freeze({
      ok: false,
      releasedLinks,
      remainingOwnedLinks: records.length - releasedLinks,
      reason,
    });
    const disposePool = (): AppearanceExternalCssomSlotsTeardownResult => {
      if (terminalTeardown) return terminalTeardown;
      if (!terminalRemovalStarted) {
        try {
          assertPoolIntegrity();
        } catch {
          return failedDisposal("The owned stylesheet pool is not safe to dispose.");
        }
        if (records.some((record) => (
          record.state !== "free" ||
          record.handle !== null ||
          record.group !== null ||
          record.groupCssText !== null ||
          record.css !== null ||
          record.link.media !== APPEARANCE_OWNED_SLOT_MEDIA
        ))) {
          return failedDisposal("All owned stylesheet resources must be free and inert before disposal.");
        }
        terminalRemovalStarted = true;
      }

      const failures: string[] = [];
      for (const record of records) {
        if (terminalRemovedRecords.has(record)) {
          if (record.link.parentNode === null) continue;
          terminalRemovedRecords.delete(record);
          failures.push("An owned stylesheet link reappeared during terminal cleanup.");
          continue;
        }
        if (record.link.parentNode === null) {
          failures.push("An owned stylesheet link disappeared during terminal cleanup.");
          continue;
        }
        if (record.link.parentNode !== parent) {
          failures.push("An owned stylesheet link was reparented during terminal cleanup.");
          continue;
        }
        try {
          parent.removeChild(record.link);
        } catch {
          if (record.link.parentNode === null) terminalRemovedRecords.add(record);
          else failures.push("An owned stylesheet link could not be safely removed.");
          continue;
        }
        if (record.link.parentNode === null) terminalRemovedRecords.add(record);
        else failures.push("An owned stylesheet link could not be confirmed removed.");
      }
      const releasedLinks = terminalRemovedRecords.size;
      if (failures.length > 0 || releasedLinks !== records.length) {
        return failedDisposal(failures.join(" ") || "An owned stylesheet link remains during terminal cleanup.", releasedLinks);
      }

      try {
        closed = true;
        const result = freeze({ ok: true, releasedLinks, remainingOwnedLinks: 0 });
        terminalTeardown = result;
        for (const record of records) {
          if (record.handle) handles.delete(record.handle);
        }
        return result;
      } catch {
        // The state is already terminal once every exact owned link is gone.
        return failedDisposal("Appearance CSSOM slot closure could not be recorded.", releasedLinks);
      }
    };

    const capability: AppearanceExternalCssomSlots = {
      acquire(role: AppearanceExternalCssomSlotRole, css: string): AppearanceExternalCssomSlot {
        assertOpen();
        if (role !== "baseline" && role !== "draft") throw makeError("invalid-resource", "The resource role is invalid.");
        assertPoolIntegrity();
        const record = records.find((candidate) => candidate.role === role && candidate.state === "free" && candidate.handle === null);
        if (!record) throw makeError("pool-exhausted", `All ${role} appearance CSSOM slots are acquired.`);
        const handle = makeSlotHandle();
        record.handle = handle;
        record.state = "staged";
        handles.set(handle, record);
        let staged = false;
        try {
          stageRecord(record, css);
          staged = true;
          assertPoolIntegrity();
          return handle;
        } catch (error) {
          handles.delete(handle);
          record.handle = null;
          if (staged) record.state = "poisoned";
          else if ((record.state as SlotRecord["state"]) !== "poisoned") record.state = "free";
          throw error;
        }
      },

      stage(resource: AppearanceExternalCssomSlot, css: string): void {
        assertOpen();
        assertPoolIntegrity();
        const record = recordFor(resource);
        if (record.state === "free") throw makeError("invalid-resource", "The resource is retained for release recovery.");
        stageRecord(record, css);
        try {
          assertPoolIntegrity();
        } catch (error) {
          record.state = "poisoned";
          throw error;
        }
      },

      activate(resource: AppearanceExternalCssomSlot): void {
        assertOpen();
        assertPoolIntegrity();
        const record = recordFor(resource);
        if (record.state === "active") return;
        if (record.state === "free") throw makeError("invalid-resource", "The resource is retained for release recovery.");
        assertRecord(record);
        setMediaVerified(record, APPEARANCE_ACTIVE_MEDIA, APPEARANCE_OWNED_SLOT_MEDIA);
        record.state = "active";
        try {
          assertPoolIntegrity();
        } catch (error) {
          record.state = "poisoned";
          throw error;
        }
      },

      deactivate(resource: AppearanceExternalCssomSlot): void {
        assertOpen();
        assertPoolIntegrity();
        const record = recordFor(resource);
        if (record.state === "free") throw makeError("invalid-resource", "The resource is retained for release recovery.");
        if (record.state !== "active") return;
        assertRecord(record);
        setMediaVerified(record, APPEARANCE_OWNED_SLOT_MEDIA, APPEARANCE_ACTIVE_MEDIA);
        record.state = "staged";
        try {
          assertPoolIntegrity();
        } catch (error) {
          record.state = "poisoned";
          throw error;
        }
      },

      release(resource: AppearanceExternalCssomSlot): void {
        assertOpen();
        assertPoolIntegrity();
        const record = recordFor(resource);
        assertRecord(record);
        if (record.state === "active") {
          setMediaVerified(record, APPEARANCE_OWNED_SLOT_MEDIA, APPEARANCE_ACTIVE_MEDIA);
        }
        try {
          if (record.group) removeRule(record.sheet, record.group);
        } catch {
          record.state = "poisoned";
          throw makeError("rollback-failed", "The owned CSSOM group could not be safely released.");
        }
        record.group = null;
        record.groupCssText = null;
        record.css = null;
        record.state = "free";
        assertPoolIntegrity();
        record.handle = null;
        handles.delete(resource);
      },

      belongsToDocument(candidate: Document): boolean {
        return candidate === documentValue;
      },

      verify(): void {
        assertOpen();
        assertPoolIntegrity();
      },

      dispose: disposePool,
      teardown: disposePool,
    };
    return freeze(capability);
  } catch (error) {
    for (const pending of pendingLoads) pending.cancel(error instanceof Error ? error : new Error("Appearance slot preparation failed."));
    const cleanupFailures = removeOwnedLinks(parent, ownedLinks);
    if (cleanupFailures.length > 0) {
      throw makeError("cleanup-failed", cleanupFailures.join("; "));
    }
    if (isAbortError(error)) throw error;
    if (error instanceof AppearanceExternalCssomSlotsError) throw error;
    throw makeError("load-failed", "Appearance slot preparation failed.");
  } finally {
    if (timer !== null) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

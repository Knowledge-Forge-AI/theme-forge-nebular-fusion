import { describe, expect, it } from "vitest";
import {
  createAppearanceStylesheetOwner,
  type AppearanceStylesheetOwner,
} from "../appearance-stylesheet-owner";
import type {
  AppearanceExternalCssomSlot,
  AppearanceExternalCssomSlots,
  AppearanceExternalCssomSlotsTeardownResult,
} from "../appearance-external-cssom-slots";
import { AppearanceExternalCssomSlotsError } from "../appearance-external-cssom-slots";

class FakeNode {
  parentNode: FakeElement | null = null;
  readonly childNodes: FakeNode[] = [];
  textContent: string | null = null;
  failInsertCount = 0;

  constructor(readonly ownerDocument: FakeDocument) {}

  appendChild<T extends FakeNode>(child: T): T {
    return this.insertBefore(child, null);
  }

  insertBefore<T extends FakeNode>(child: T, anchor: FakeNode | null): T {
    if (this.failInsertCount > 0) {
      this.failInsertCount -= 1;
      throw new Error("synthetic insertion failure");
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = anchor === null ? this.childNodes.length : this.childNodes.indexOf(anchor);
    if (index < 0) throw new Error("synthetic anchor is not attached");
    this.childNodes.splice(index, 0, child);
    if (!(this instanceof FakeElement)) throw new Error("Synthetic parent must be an element");
    child.parentNode = this;
    return child;
  }

  removeChild<T extends FakeNode>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index < 0) throw new Error("synthetic child is not attached");
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
}

class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>();
  captureFailure: Error | null = null;
  readonly classList = {
    contains: (token: string): boolean => this.classTokens().includes(token),
    add: (token: string): void => {
      const tokens = this.classTokens();
      if (!tokens.includes(token)) tokens.push(token);
      this.attributes.set("class", tokens.join(" "));
    },
    remove: (token: string): void => {
      const tokens = this.classTokens().filter((entry) => entry !== token);
      if (tokens.length === 0 && this.attributes.has("class")) this.attributes.set("class", "");
      else if (tokens.length === 0) this.attributes.delete("class");
      else this.attributes.set("class", tokens.join(" "));
    },
  };

  constructor(documentValue: FakeDocument, readonly tagName: string) {
    super(documentValue);
  }

  hasAttribute(name: string): boolean {
    if (this.captureFailure) throw this.captureFailure;
    return this.attributes.has(name);
  }

  getAttribute(name: string): string | null {
    if (this.captureFailure) throw this.captureFailure;
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  private classTokens(): string[] {
    if (this.captureFailure) throw this.captureFailure;
    return (this.attributes.get("class") ?? "").split(/\s+/).filter(Boolean);
  }
}

class FakeSheet {
  css = "";

  replaceSync(source: string): void {
    this.css = source;
  }
}

class FakeDocument {
  readonly documentElement: FakeElement;
  readonly head: FakeElement;
  readonly defaultView: { CSSStyleSheet: typeof FakeSheet | typeof NoSheet };
  writeCount = 0;
  failWriteCount = 0;
  sheetWriteTransform: ((next: FakeSheet[]) => FakeSheet[]) | null = null;
  private sheets: FakeSheet[] = [];

  constructor(constructable: boolean) {
    this.defaultView = { CSSStyleSheet: constructable ? FakeSheet : NoSheet };
    this.documentElement = new FakeElement(this, "html");
    this.head = new FakeElement(this, "head");
    this.documentElement.appendChild(this.head);
  }

  get adoptedStyleSheets(): FakeSheet[] {
    return [...this.sheets];
  }

  set adoptedStyleSheets(next: readonly FakeSheet[]) {
    this.writeCount += 1;
    if (this.failWriteCount > 0) {
      this.failWriteCount -= 1;
      throw new Error("synthetic adopted-sheet failure");
    }
    const copied = [...next];
    this.sheets = this.sheetWriteTransform ? this.sheetWriteTransform(copied) : copied;
  }

  createElement(_tagName: string): FakeElement {
    return new FakeElement(this, _tagName);
  }
}

class NoSheet {}

function asDocument(value: FakeDocument): Document {
  return value as unknown as Document;
}

function styleTexts(documentValue: FakeDocument): string[] {
  return documentValue.head.childNodes.map((child) => child.textContent ?? "");
}

function sheetTexts(documentValue: FakeDocument): string[] {
  return documentValue.adoptedStyleSheets.map((sheet) => sheet.css);
}

function stageInitial(owner: AppearanceStylesheetOwner): void {
  owner.stage({ baselineCss: "base-0", draftCss: "draft-0", rootMode: "dark" }).commit();
}

class FakeExternalCssomSlots implements AppearanceExternalCssomSlots {
  readonly records = new Map<AppearanceExternalCssomSlot, { role: "baseline" | "draft"; css: string; state: "staged" | "active" }>();
  verifyFailure = false;
  releaseFailureCount = 0;
  activateFailureCount = 0;
  readonly boundDocument: Document | undefined;
  disposed = false;

  constructor(boundDocument?: Document) {
    this.boundDocument = boundDocument;
  }

  belongsToDocument(documentValue: Document): boolean {
    return this.boundDocument === undefined || this.boundDocument === documentValue;
  }

  acquire(role: "baseline" | "draft", css: string): AppearanceExternalCssomSlot {
    if (this.disposed) throw new Error("closed");
    if (css === "}" || /@import/i.test(css)) {
      throw new AppearanceExternalCssomSlotsError("css-parse-failed", "synthetic CSS rejection");
    }
    if ([...this.records.values()].filter((record) => record.role === role).length >= 2) throw new Error("pool exhausted");
    const handle = Object.freeze({}) as AppearanceExternalCssomSlot;
    this.records.set(handle, { role, css, state: "staged" });
    return handle;
  }

  stage(resource: AppearanceExternalCssomSlot, css: string): void {
    const record = this.records.get(resource);
    if (!record) throw new Error("invalid resource");
    record.css = css;
  }

  activate(resource: AppearanceExternalCssomSlot): void {
    const record = this.records.get(resource);
    if (!record) throw new Error("invalid resource");
    if (this.activateFailureCount > 0) {
      this.activateFailureCount -= 1;
      throw new AppearanceExternalCssomSlotsError("resource-drift", "synthetic activation failure");
    }
    record.state = "active";
  }

  deactivate(resource: AppearanceExternalCssomSlot): void {
    const record = this.records.get(resource);
    if (!record) throw new Error("invalid resource");
    record.state = "staged";
  }

  release(resource: AppearanceExternalCssomSlot): void {
    if (this.releaseFailureCount > 0) {
      this.releaseFailureCount -= 1;
      throw new Error("synthetic release failure");
    }
    if (!this.records.delete(resource)) throw new Error("invalid resource");
  }

  dispose(): AppearanceExternalCssomSlotsTeardownResult {
    if (this.records.size > 0) return { ok: false, releasedLinks: 0, remainingOwnedLinks: 4 };
    this.disposed = true;
    return { ok: true, releasedLinks: 4, remainingOwnedLinks: 0 };
  }

  teardown(): AppearanceExternalCssomSlotsTeardownResult {
    return this.dispose();
  }

  verify(): void {
    if (this.verifyFailure) throw new Error("synthetic slot drift");
  }

  active(role?: "baseline" | "draft"): number {
    return [...this.records.values()].filter((record) => record.state === "active" && (role === undefined || record.role === role)).length;
  }
}

describe("appearance stylesheet owner", () => {
  it("refuses the owner before any style-element or root mutation when no backend is available", () => {
    const documentValue = new FakeDocument(false);

    expect(() => createAppearanceStylesheetOwner(asDocument(documentValue), { allowStyleElementFallback: false }))
      .toThrow("Appearance stylesheet backend is unavailable");
    expect(documentValue.head.childNodes).toEqual([]);
    expect(documentValue.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("uses style elements when the adopted-sheet property is present but unusable", () => {
    for (const value of [undefined, null, {}]) {
      const documentValue = new FakeDocument(true);
      Object.defineProperty(documentValue, "adoptedStyleSheets", { configurable: true, writable: true, value });
      const owner = createAppearanceStylesheetOwner(asDocument(documentValue));
      expect(owner.stageBaseline("usable fallback", { rootMode: "light" }).commit().ok).toBe(true);
      expect(owner.snapshot().attachment).toBe("style-element");
      expect(styleTexts(documentValue)).toEqual(["usable fallback"]);
      expect(owner.teardown().ok).toBe(true);
    }
  });

  it("uses each staged input field exactly once", () => {
    const documentValue = new FakeDocument(false);
    const owner = createAppearanceStylesheetOwner(documentValue as unknown as Document);
    let baselineReads = 0;
    let draftReads = 0;
    let modeReads = 0;
    const transaction = owner.stage({
      get baselineCss() { return baselineReads++ === 0 ? "base-once" : "unexpected"; },
      get draftCss() { return draftReads++ === 0 ? "draft-once" : null; },
      get rootMode() { return modeReads++ === 0 ? "dark" : "light"; },
    });
    expect(transaction.commit().ok).toBe(true);
    expect(styleTexts(documentValue)).toEqual(["base-once", "draft-once"]);
    expect([baselineReads, draftReads, modeReads]).toEqual([1, 1, 1]);
    expect(documentValue.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("keeps a foreign root value untouched when teardown finds a pending transaction", () => {
    const documentValue = new FakeDocument(false);
    const owner = createAppearanceStylesheetOwner(documentValue as unknown as Document);
    const transaction = owner.stageBaseline("base-0", { rootMode: "dark" });
    documentValue.documentElement.setAttribute("data-theme", "outside");
    expect(owner.teardown().ok).toBe(false);
    expect(documentValue.documentElement.getAttribute("data-theme")).toBe("outside");
    expect(transaction.commit().ok).toBe(false);
  });

  it("uses a fresh fallback pair with distinct baseline and draft ordering", () => {
    const documentValue = new FakeDocument(false);
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue));

    expect(owner.snapshot().attachment).toBe("style-element");
    const transaction = owner.stage({ baselineCss: "base-0", draftCss: "draft-0", rootMode: "dark" });
    expect(styleTexts(documentValue)).toEqual(["base-0", "draft-0"]);
    expect(documentValue.head.childNodes[0]).not.toBe(documentValue.head.childNodes[1]);
    expect(documentValue.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(transaction.commit().ok).toBe(true);
    expect(transaction.commit()).toBe(transaction.commit());
    expect(owner.snapshot().pending).toBe(false);
  });

  it("selects the constructable path and preserves foreign sheets added later", () => {
    const documentValue = new FakeDocument(true);
    const foreignBefore = new FakeSheet();
    foreignBefore.replaceSync("foreign-before");
    documentValue.adoptedStyleSheets = [foreignBefore];
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue), { allowStyleElementFallback: false });

    stageInitial(owner);
    expect(owner.snapshot().attachment).toBe("constructable");
    expect(sheetTexts(documentValue)).toEqual(["foreign-before", "base-0", "draft-0"]);

    const foreignAfter = new FakeSheet();
    foreignAfter.replaceSync("foreign-after");
    documentValue.adoptedStyleSheets = [...documentValue.adoptedStyleSheets, foreignAfter];
    expect(owner.teardown().ok).toBe(true);
    expect(sheetTexts(documentValue)).toEqual(["foreign-before", "foreign-after"]);
  });

  it("restores baseline, draft, root mode, and later foreign elements on rollback", () => {
    const documentValue = new FakeDocument(false);
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue));
    stageInitial(owner);
    const transaction = owner.stage({ baselineCss: "base-1", draftCss: "draft-1", rootMode: "light" });

    const foreignAfter = documentValue.createElement("style");
    foreignAfter.textContent = "foreign-after";
    documentValue.head.appendChild(foreignAfter);
    const result = transaction.rollback();

    expect(result.ok).toBe(true);
    expect(styleTexts(documentValue)).toEqual(["base-0", "draft-0", "foreign-after"]);
    expect(documentValue.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(owner.snapshot().baselineAttached).toBe(true);
    expect(owner.snapshot().draftAttached).toBe(true);
  });

  it("preserves the prior owned appearance when fresh attachment fails", () => {
    const documentValue = new FakeDocument(false);
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue));
    stageInitial(owner);
    documentValue.head.failInsertCount = 1;

    expect(() => owner.stage({ baselineCss: "base-failed", rootMode: "light" })).toThrow();
    expect(styleTexts(documentValue)).toEqual(["base-0", "draft-0"]);
    expect(documentValue.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(owner.snapshot().pending).toBe(false);
  });

  it("releases only the owned draft and leaves foreign elements and documents alone", () => {
    const documentValue = new FakeDocument(false);
    const iframeDocument = new FakeDocument(false);
    const iframeForeign = iframeDocument.createElement("style");
    iframeForeign.textContent = "iframe-foreign";
    iframeDocument.head.appendChild(iframeForeign);
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue));
    stageInitial(owner);

    const foreign = documentValue.createElement("style");
    foreign.textContent = "foreign";
    documentValue.head.appendChild(foreign);
    owner.releaseDraft().commit();
    expect(styleTexts(documentValue)).toEqual(["base-0", "foreign"]);
    expect(owner.teardown()).toMatchObject({ ok: true, baselineReleased: true, draftReleased: false });
    expect(styleTexts(documentValue)).toEqual(["foreign"]);
    expect(styleTexts(iframeDocument)).toEqual(["iframe-foreign"]);
  });

  it("restores an exact initial root value and refuses to overwrite an external change", () => {
    const documentValue = new FakeDocument(false);
    documentValue.documentElement.setAttribute("data-theme", "initial-custom");
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue));
    owner.stageBaseline("base-0", { rootMode: "dark" }).commit();
    expect(documentValue.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(owner.teardown()).toMatchObject({ ok: true, rootRestored: true });
    expect(documentValue.documentElement.getAttribute("data-theme")).toBe("initial-custom");

    const second = new FakeDocument(false);
    const secondOwner = createAppearanceStylesheetOwner(asDocument(second));
    stageInitial(secondOwner);
    second.documentElement.setAttribute("data-theme", "outside");
    const result = secondOwner.teardown();
    expect(result.ok).toBe(false);
    expect(result.rootRestored).toBe(false);
    expect(second.documentElement.getAttribute("data-theme")).toBe("outside");
  });

  it("reconciles the dark class with root mode and preserves foreign class changes", () => {
    const documentValue = new FakeDocument(false);
    documentValue.documentElement.setAttribute("class", "foreign dark");
    documentValue.documentElement.setAttribute("data-theme", "dark");
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue));

    const transaction = owner.stageBaseline("base-0", { rootMode: "light" });
    expect(documentValue.documentElement.getAttribute("class")).toBe("foreign");
    expect(documentValue.documentElement.getAttribute("data-theme")).toBe("light");
    expect(transaction.rollback().ok).toBe(true);
    expect(documentValue.documentElement.getAttribute("class")).toBe("foreign dark");
    expect(documentValue.documentElement.getAttribute("data-theme")).toBe("dark");

    const rollbackDocument = new FakeDocument(false);
    rollbackDocument.documentElement.setAttribute("class", "foreign dark");
    const rollbackOwner = createAppearanceStylesheetOwner(asDocument(rollbackDocument));
    const rollbackTransaction = rollbackOwner.stageBaseline("base-rollback", { rootMode: "light" });
    rollbackDocument.documentElement.classList.add("outside");
    const rollbackResult = rollbackTransaction.rollback();
    expect(rollbackResult.ok).toBe(true);
    expect(rollbackResult.status).toBe("rolled-back");
    expect(rollbackDocument.documentElement.classList.contains("outside")).toBe(true);
    expect(rollbackDocument.documentElement.classList.contains("dark")).toBe(true);

    const secondDocument = new FakeDocument(false);
    secondDocument.documentElement.setAttribute("class", "foreign dark");
    const secondOwner = createAppearanceStylesheetOwner(asDocument(secondDocument));
    secondOwner.stageBaseline("base-1", { rootMode: "light" }).commit();
    secondDocument.documentElement.classList.add("outside");
    const teardown = secondOwner.teardown();
    expect(teardown.ok).toBe(true);
    expect(teardown.rootRestored).toBe(true);
    expect(secondDocument.documentElement.classList.contains("outside")).toBe(true);
    expect(secondDocument.documentElement.classList.contains("dark")).toBe(true);
  });

  it("rejects overlapping work and keeps terminal transactions idempotent", () => {
    const documentValue = new FakeDocument(false);
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue));
    const first = owner.stage({ baselineCss: "first" });
    expect(() => owner.stage({ baselineCss: "overlap" })).toThrow();
    const rolledBack = first.rollback();
    expect(rolledBack.ok).toBe(true);
    expect(first.commit()).toBe(rolledBack);

    const second = owner.stage({ baselineCss: "second" });
    const committed = second.finalize(true);
    expect(second.commit()).toBe(committed);
    expect(styleTexts(documentValue)).toEqual(["second"]);
  });

  it("marks a pending transaction stale when owner teardown closes its lifetime", () => {
    const documentValue = new FakeDocument(false);
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue));
    const transaction = owner.stage({ baselineCss: "pending" });

    expect(owner.teardown().ok).toBe(true);
    const result = transaction.commit();
    expect(result.status).toBe("stale");
    expect(transaction.rollback()).toBe(result);
  });

  it("keeps the constructable transaction finalization free of DOM writes", () => {
    const documentValue = new FakeDocument(true);
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue));
    const transaction = owner.stage({ baselineCss: "base-0" });
    const writesAfterStage = documentValue.writeCount;

    const result = transaction.finalize(true);
    expect(result.ok).toBe(true);
    expect(documentValue.writeCount).toBe(writesAfterStage);
    expect(transaction.finalize(true)).toBe(result);
  });

  it("finalizes an accepted transaction from staged metadata without live DOM reads", () => {
    const documentValue = new FakeDocument(false);
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue));
    const transaction = owner.stage({ baselineCss: "base-0", rootMode: "dark" });
    documentValue.documentElement.captureFailure = new Error("live root read should not occur");

    expect(transaction.finalize(true).ok).toBe(true);
  });

  it("reports rollback failure when owned root state no longer matches", () => {
    const documentValue = new FakeDocument(false);
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue));
    const transaction = owner.stage({ baselineCss: "base-0", rootMode: "dark" });
    documentValue.documentElement.setAttribute("data-theme", "outside");

    const result = transaction.rollback();
    expect(result.ok).toBe(false);
    expect(result.status).toBe("rollback-failed");
    expect(result.reason).toBeTruthy();
    expect(documentValue.documentElement.getAttribute("data-theme")).toBe("outside");
  });

  it("checks root drift before resource rollback and releases owned resources on teardown", () => {
    for (const constructable of [false, true]) {
      const documentValue = new FakeDocument(constructable);
      if (constructable) {
        const foreign = new FakeSheet();
        foreign.replaceSync("foreign");
        documentValue.adoptedStyleSheets = [foreign];
      } else {
        const foreign = documentValue.createElement("style");
        foreign.textContent = "foreign";
        documentValue.head.appendChild(foreign);
      }
      const owner = createAppearanceStylesheetOwner(asDocument(documentValue));
      stageInitial(owner);
      const transaction = owner.stage({ baselineCss: "base-1", rootMode: "light" });
      documentValue.documentElement.setAttribute("data-theme", "outside");

      const rollback = transaction.rollback();
      expect(rollback).toMatchObject({ ok: false, status: "rollback-failed" });
      if (constructable) {
        expect(sheetTexts(documentValue)).toEqual(["foreign", "base-1", "draft-0"]);
      } else {
        expect(styleTexts(documentValue)).toEqual(["foreign", "base-1", "draft-0"]);
      }

      const teardown = owner.teardown();
      expect(teardown).toMatchObject({
        ok: false,
        baselineReleased: true,
        draftReleased: true,
        rootRestored: false,
      });
      if (constructable) expect(sheetTexts(documentValue)).toEqual(["foreign"]);
      else expect(styleTexts(documentValue)).toEqual(["foreign"]);
      expect(documentValue.documentElement.getAttribute("data-theme")).toBe("outside");
    }
  });

  it("restores the owned root and avoids a second resource replacement after constructable rollback failure", () => {
    const documentValue = new FakeDocument(true);
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue));
    documentValue.failWriteCount = 2;

    expect(() => owner.stage({ baselineCss: "base-failed", rootMode: "dark" })).toThrow();
    expect(documentValue.writeCount).toBe(2);
    expect(documentValue.documentElement.getAttribute("data-theme")).toBe(null);
    expect(owner.teardown()).toMatchObject({ ok: false, rootRestored: true });
  });

  it("restores the owned root and releases remaining resources after style-element rollback failure", () => {
    const documentValue = new FakeDocument(false);
    const foreign = documentValue.createElement("style");
    foreign.textContent = "foreign";
    documentValue.head.appendChild(foreign);
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue));
    stageInitial(owner);
    documentValue.head.failInsertCount = 2;

    expect(() => owner.stage({ baselineCss: "base-failed", rootMode: "light" })).toThrow();
    expect(styleTexts(documentValue)).toEqual(["foreign", "draft-0"]);
    expect(documentValue.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(owner.teardown()).toMatchObject({ ok: false, baselineReleased: true, draftReleased: true, rootRestored: true });
    expect(styleTexts(documentValue)).toEqual(["foreign"]);
    expect(documentValue.documentElement.getAttribute("data-theme")).toBe(null);
  });

  it("falls back when the document has no usable sheet constructor", () => {
    const documentValue = new FakeDocument(false);
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue));
    expect(owner.snapshot().attachment).toBe("style-element");
    expect(owner.stage({ baselineCss: "fallback" }).commit().ok).toBe(true);
    expect(styleTexts(documentValue)).toEqual(["fallback"]);
  });

  it("rejects silently lost adopted-sheet identity and restores the prior list", () => {
    const documentValue = new FakeDocument(true);
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue), { allowStyleElementFallback: false });
    documentValue.sheetWriteTransform = (next) => next.slice(0, -1);

    expect(() => owner.stageBaseline("lost")).toThrow("Adopted sheet attachment failed");
    expect(documentValue.adoptedStyleSheets).toEqual([]);
    expect(owner.snapshot()).toMatchObject({ baselineAttached: false, pending: false, closed: false });
  });

  it("rejects silently inserted foreign adopted-sheet identity and restores the prior list", () => {
    const documentValue = new FakeDocument(true);
    const foreign = new FakeSheet();
    let firstWrite = true;
    documentValue.sheetWriteTransform = (next) => {
      if (!firstWrite) return next;
      firstWrite = false;
      return [foreign, ...next];
    };
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue), { allowStyleElementFallback: false });

    expect(() => owner.stageBaseline("foreign")).toThrow("Adopted sheet attachment failed");
    expect(documentValue.adoptedStyleSheets).toEqual([]);
    expect(owner.snapshot()).toMatchObject({ baselineAttached: false, pending: false, closed: false });
  });

  it("uses role-reserved external slots without moving links and retains prior handles through rollback or commit", () => {
    const documentValue = new FakeDocument(false);
    const slots = new FakeExternalCssomSlots();
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue), { externalCssomSlots: slots, allowStyleElementFallback: false });

    expect(owner.snapshot().attachment).toBe("external-cssom");
    const first = owner.stageBaseline("base-0", { rootMode: "light" });
    expect(first.commit().ok).toBe(true);
    expect(slots.active("baseline")).toBe(1);

    const rollback = owner.stageBaseline("base-1", { rootMode: "dark" });
    expect(slots.active("baseline")).toBe(1);
    expect(rollback.rollback().ok).toBe(true);
    expect(slots.active("baseline")).toBe(1);

    const commit = owner.stageBaseline("base-2", { rootMode: "dark" });
    expect(commit.commit().ok).toBe(true);
    expect(slots.active("baseline")).toBe(1);
    expect(owner.teardown().ok).toBe(true);
    expect(slots.records.size).toBe(0);
    expect(slots.disposed).toBe(false);
    expect(slots.dispose().ok).toBe(true);
  });

  it("keeps an external owner reachable when commit cleanup fails", () => {
    const documentValue = new FakeDocument(false);
    const slots = new FakeExternalCssomSlots();
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue), { externalCssomSlots: slots, allowStyleElementFallback: false });
    owner.stageBaseline("base-0").commit();
    const transaction = owner.stageBaseline("base-1");
    slots.releaseFailureCount = 2;

    expect(transaction.commit()).toMatchObject({ ok: false, status: "commit-failed" });
    expect(owner.snapshot()).toMatchObject({ closed: false, baselineAttached: true });
    expect(owner.teardown().ok).toBe(false);
    slots.releaseFailureCount = 0;
    const retry = owner.teardown();
    expect(retry.ok).toBe(true);
    expect(slots.dispose().ok).toBe(true);
  });

  it("retains the complete external handle union after root-drift rollback", () => {
    const documentValue = new FakeDocument(false);
    const slots = new FakeExternalCssomSlots(asDocument(documentValue));
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue), {
      externalCssomSlots: slots,
      allowStyleElementFallback: false,
    });
    owner.stageBaseline("base-0", { rootMode: "light" }).commit();
    const pending = owner.stageBaseline("base-1", { rootMode: "dark" });
    documentValue.documentElement.setAttribute("data-theme", "outside");

    expect(pending.rollback()).toMatchObject({ ok: false, status: "rollback-failed" });
    expect(slots.records.size).toBe(2);
    expect(owner.teardown()).toMatchObject({ ok: false, rootRestored: false });
    expect(slots.records.size).toBe(0);
    expect(slots.dispose()).toMatchObject({ ok: true, remainingOwnedLinks: 0 });
  });

  it("retains attempted activation handles when external rollback itself fails", () => {
    const documentValue = new FakeDocument(false);
    const slots = new FakeExternalCssomSlots(asDocument(documentValue));
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue), {
      externalCssomSlots: slots,
      allowStyleElementFallback: false,
    });
    owner.stageBaseline("base-0", { rootMode: "light" }).commit();
    slots.activateFailureCount = 2;

    expect(() => owner.stageBaseline("base-1", { rootMode: "dark" })).toThrow("External CSSOM");
    expect(owner.teardown().ok).toBe(true);
    expect(slots.records.size).toBe(0);
    expect(slots.dispose()).toMatchObject({ ok: true, remainingOwnedLinks: 0 });
  });

  it("maps ordinary external CSS rejection without poisoning the owner", () => {
    const documentValue = new FakeDocument(false);
    const slots = new FakeExternalCssomSlots(asDocument(documentValue));
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue), {
      externalCssomSlots: slots,
      allowStyleElementFallback: false,
    });
    owner.stageBaseline("base-0").commit();

    expect(() => owner.stageDraft("}")).toThrow("Appearance CSS was rejected");
    expect(owner.snapshot()).toMatchObject({ closed: false, baselineAttached: true, draftAttached: false });
    expect(owner.stageDraft("body { color: green; }").commit().ok).toBe(true);
    expect(owner.teardown().ok).toBe(true);
    expect(slots.dispose().ok).toBe(true);
  });

  it("rejects a pool bound to another document before root or slot mutation", () => {
    const documentValue = new FakeDocument(false);
    const otherDocument = new FakeDocument(false);
    const slots = new FakeExternalCssomSlots(asDocument(documentValue));
    expect(() => createAppearanceStylesheetOwner(asDocument(otherDocument), {
      externalCssomSlots: slots,
      allowStyleElementFallback: false,
    })).toThrow("belong to another document");
    expect(otherDocument.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(slots.records.size).toBe(0);
  });
});

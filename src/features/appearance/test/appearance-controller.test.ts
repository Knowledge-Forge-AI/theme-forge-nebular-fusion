import { describe, expect, it, vi } from "vitest";
import { createAppearanceController, type AppearanceCatalog } from "../appearance-controller";
import type {
  AppearanceExternalCssomSlot,
  AppearanceExternalCssomSlots,
  AppearanceExternalCssomSlotsTeardownResult,
} from "../appearance-external-cssom-slots";
import { AppearanceExternalCssomSlotsError } from "../appearance-external-cssom-slots";

const catalog: AppearanceCatalog = {
  defaultFamily: "nebular",
  families: [
    { id: "nebular", label: "Nebular", css: ":root { --background: #151020; }" },
    { id: "terminal-nova", label: "Terminal Nova", css: ":root { --background: #111318; }" },
  ],
};
const texts = (value: Document) => [...value.head.querySelectorAll("style")].map((element) => element.textContent);
const fixture = () => {
  const value = document.implementation.createHTMLDocument("Owned appearance fixture");
  const controller = createAppearanceController(catalog);
  return { value, controller };
};

class FakeExternalCssomSlots implements AppearanceExternalCssomSlots {
  readonly records = new Map<AppearanceExternalCssomSlot, { role: "baseline" | "draft"; state: "staged" | "active" }>();
  releaseFailureCount = 0;
  activateFailureCount = 0;
  disposed = false;

  belongsToDocument(_documentValue: Document): boolean {
    return true;
  }

  acquire(role: "baseline" | "draft", css: string): AppearanceExternalCssomSlot {
    if (this.disposed || [...this.records.values()].filter((record) => record.role === role).length >= 2) throw new Error("pool unavailable");
    if (css === "}" || /@import/i.test(css)) {
      throw new AppearanceExternalCssomSlotsError("css-parse-failed", "synthetic CSS rejection");
    }
    const handle = Object.freeze({}) as AppearanceExternalCssomSlot;
    this.records.set(handle, { role, state: "staged" });
    return handle;
  }

  stage(resource: AppearanceExternalCssomSlot, _css: string): void {
    if (!this.records.has(resource)) throw new Error("invalid resource");
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

  verify(): void {}

  dispose(): AppearanceExternalCssomSlotsTeardownResult {
    if (this.records.size > 0) return { ok: false, releasedLinks: 0, remainingOwnedLinks: 4 };
    this.disposed = true;
    return { ok: true, releasedLinks: 4, remainingOwnedLinks: 0 };
  }

  teardown(): AppearanceExternalCssomSlotsTeardownResult {
    return this.dispose();
  }
}

describe("application appearance controller", () => {
  it("retains attachment and active-draft ownership after failed teardown", () => {
    const { value, controller } = fixture();
    controller.attach(value, "dark");
    const owner = controller.registerEditor();
    controller.applyDraft(owner, controller.captureApplyEligibility(owner)!, "body { color: green; }");
    value.documentElement.setAttribute("data-theme", "foreign-value");
    expect(controller.detach().ok).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ attached: true, hasDraft: true, problem: "recovery-required" });
    expect(value.documentElement.getAttribute("data-theme")).toBe("foreign-value");
    expect(controller.change({ kind: "reset" }).reason).toBe("recovery-required");
  });

  it("coordinates constructable sheets without replacing foreign adopted sheets", () => {
    const { value, controller } = fixture();
    class Sheet {
      css = "";
      replaceSync(css: string) { this.css = css; }
    }
    const foreign = new Sheet();
    Object.defineProperty(value, "defaultView", { value: { CSSStyleSheet: Sheet }, configurable: true });
    Object.defineProperty(value, "adoptedStyleSheets", { value: [foreign], writable: true, configurable: true });
    expect(controller.attach(value, "dark").ok).toBe(true);
    expect(value.adoptedStyleSheets).toHaveLength(2);
    const owner = controller.registerEditor();
    expect(controller.applyDraft(owner, controller.captureApplyEligibility(owner)!, "draft-css").ok).toBe(true);
    expect(value.adoptedStyleSheets).toHaveLength(3);
    expect(controller.change({ kind: "reset" }).ok).toBe(true);
    expect(value.adoptedStyleSheets).toHaveLength(2);
    expect(value.adoptedStyleSheets[0]).toBe(foreign);
    expect(controller.detach().ok).toBe(true);
    expect(value.adoptedStyleSheets).toEqual([foreign]);
  });

  it("fails closed for native startup without constructable sheets and blocks preference changes until reattach", () => {
    const value = document.implementation.createHTMLDocument("Native unsupported appearance fixture");
    const saved = { version: 1 as const, mode: "light" as const, light: "terminal-nova" };
    const controller = createAppearanceController(catalog, {
      preferences: saved,
      allowStyleElementFallback: false,
      requireExternalBackend: true,
    });

    const failed = controller.attach(value, "dark");
    expect(failed).toMatchObject({ ok: false, reason: "unsupported-backend" });
    expect(controller.getSnapshot()).toMatchObject({
      attached: false,
      problem: "unsupported-backend",
      preferences: saved,
      preferenceRevision: 0,
    });
    expect(value.head.querySelectorAll("style")).toHaveLength(0);
    expect(value.documentElement.hasAttribute("data-theme")).toBe(false);

    const refused = controller.change({ kind: "set-mode-preference", preference: "dark" });
    expect(refused).toMatchObject({ ok: false, reason: "unsupported-backend" });
    expect(controller.getSnapshot()).toMatchObject({ preferences: saved, preferenceRevision: 0 });

    class Sheet {
      replaceSync(_css: string) {}
    }
    Object.defineProperty(value, "defaultView", { value: { CSSStyleSheet: Sheet }, configurable: true });
    Object.defineProperty(value, "adoptedStyleSheets", { value: [], writable: true, configurable: true });
    expect(controller.attach(value, "dark")).toMatchObject({ ok: false, reason: "unsupported-backend" });
    expect(controller.getSnapshot()).toMatchObject({ problem: "unsupported-backend", preferenceRevision: 0 });
  });

  it("requires prepared external CSSOM slots for native startup even when constructable sheets exist", () => {
    const value = document.implementation.createHTMLDocument("Native external requirement fixture");
    class Sheet {
      replaceSync(_css: string) {}
    }
    Object.defineProperty(value, "defaultView", { value: { CSSStyleSheet: Sheet }, configurable: true });
    Object.defineProperty(value, "adoptedStyleSheets", { value: [], writable: true, configurable: true });
    const controller = createAppearanceController(catalog, {
      allowStyleElementFallback: false,
      requireExternalBackend: true,
    });

    expect(controller.attach(value, "light")).toMatchObject({ ok: false, reason: "unsupported-backend" });
    expect(value.adoptedStyleSheets).toEqual([]);
    expect(value.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("reuses one prepared external pool across detach and reattach, then disposes it terminally", () => {
    const value = document.implementation.createHTMLDocument("External lifecycle fixture");
    const slots = new FakeExternalCssomSlots();
    const controller = createAppearanceController(catalog, {
      allowStyleElementFallback: false,
      requireExternalBackend: true,
      externalCssomSlots: slots,
    });

    expect(controller.attach(value, "light").ok).toBe(true);
    expect(slots.records.size).toBe(1);
    expect(controller.detach().ok).toBe(true);
    expect(slots.records.size).toBe(0);
    expect(controller.getSnapshot()).toMatchObject({ attached: false, problem: null });
    expect(controller.attach(value, "dark").ok).toBe(true);
    expect(slots.records.size).toBe(1);
    expect(controller.dispose()).toMatchObject({ ok: true, status: "closed" });
    expect(slots.disposed).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ attached: false });
    expect(controller.attach(value, "light").reason).toBe("appearance-closed");
  });

  it("rejects a cross-document external pool before claiming or mutating the second document", () => {
    const preparedDocument = document.implementation.createHTMLDocument("Prepared external document");
    const otherDocument = document.implementation.createHTMLDocument("Other external document");
    const slots = new FakeExternalCssomSlots();
    const originalBelongsToDocument = slots.belongsToDocument.bind(slots);
    slots.belongsToDocument = (value: Document) => value === preparedDocument;
    const controller = createAppearanceController(catalog, {
      allowStyleElementFallback: false,
      requireExternalBackend: true,
      externalCssomSlots: slots,
    });

    expect(controller.attach(otherDocument, "dark")).toMatchObject({ ok: false, reason: "unsupported-backend" });
    expect(controller.getSnapshot()).toMatchObject({ attached: false, problem: "unsupported-backend" });
    expect(otherDocument.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(slots.records.size).toBe(0);
    slots.belongsToDocument = originalBelongsToDocument;
  });

  it("does not poison external appearance after rejected CSS and accepts a later valid draft", () => {
    const value = document.implementation.createHTMLDocument("External CSS validation fixture");
    const slots = new FakeExternalCssomSlots();
    const controller = createAppearanceController(catalog, {
      allowStyleElementFallback: false,
      requireExternalBackend: true,
      externalCssomSlots: slots,
    });
    expect(controller.attach(value, "light").ok).toBe(true);
    const owner = controller.registerEditor();
    const eligibility = controller.captureApplyEligibility(owner)!;

    expect(controller.applyDraft(owner, eligibility, "}").ok).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ problem: "change-failed", hasDraft: false, preferenceRevision: 0 });
    expect(controller.applyDraft(owner, controller.captureApplyEligibility(owner)!, "body { color: green; }").ok).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ problem: null, hasDraft: true });
    expect(controller.detach().ok).toBe(true);
    expect(controller.dispose()).toMatchObject({ ok: true, status: "closed" });
  });

  it("recovers a retained pure draft owner after external visual release failure", () => {
    const value = document.implementation.createHTMLDocument("External draft recovery fixture");
    const slots = new FakeExternalCssomSlots();
    const controller = createAppearanceController(catalog, {
      allowStyleElementFallback: false,
      requireExternalBackend: true,
      externalCssomSlots: slots,
    });
    expect(controller.attach(value, "light").ok).toBe(true);
    const owner = controller.registerEditor();
    expect(controller.applyDraft(owner, controller.captureApplyEligibility(owner)!, "body { color: green; }").ok).toBe(true);
    slots.releaseFailureCount = 1;

    expect(controller.disposeEditor(owner)).toMatchObject({ ok: false, reason: "recovery-required" });
    expect(controller.captureApplyEligibility(owner)).not.toBeNull();
    expect(controller.getSnapshot()).toMatchObject({ attached: true, hasDraft: true, problem: "recovery-required" });
    slots.releaseFailureCount = 0;
    expect(controller.detach().ok).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ attached: false, hasDraft: false, problem: null });
    expect(controller.dispose()).toMatchObject({ ok: true, status: "closed" });
  });

  it("retries terminal disposal after a transient external cleanup exception", () => {
    const value = document.implementation.createHTMLDocument("External terminal recovery fixture");
    const slots = new FakeExternalCssomSlots();
    const controller = createAppearanceController(catalog, {
      allowStyleElementFallback: false,
      requireExternalBackend: true,
      externalCssomSlots: slots,
    });
    expect(controller.attach(value, "light").ok).toBe(true);
    slots.releaseFailureCount = 1;

    expect(controller.dispose()).toMatchObject({ ok: false, status: "failed" });
    expect(controller.getSnapshot()).toMatchObject({ attached: true, problem: "recovery-required" });
    slots.releaseFailureCount = 0;
    expect(controller.dispose()).toMatchObject({ ok: true, status: "closed" });
    expect(slots.disposed).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ attached: false, problem: null });
  });

  it("retains a failed external owner for terminal recovery without claiming attachment", () => {
    const value = document.implementation.createHTMLDocument("External detach recovery fixture");
    const slots = new FakeExternalCssomSlots();
    const controller = createAppearanceController(catalog, {
      allowStyleElementFallback: false,
      requireExternalBackend: true,
      externalCssomSlots: slots,
    });
    expect(controller.attach(value, "light").ok).toBe(true);
    slots.releaseFailureCount = 1;

    expect(controller.detach()).toMatchObject({ ok: false, reason: "recovery-required" });
    expect(controller.getSnapshot()).toMatchObject({ attached: true, problem: "recovery-required" });
    slots.releaseFailureCount = 0;
    const disposed = controller.dispose();
    expect(disposed).toMatchObject({ ok: true, status: "closed" });
    expect(slots.disposed).toBe(true);
  });

  it("closes a pure editor handle even when native attachment is unsupported", () => {
    const value = document.implementation.createHTMLDocument("Native unsupported editor fixture");
    const controller = createAppearanceController(catalog, { allowStyleElementFallback: false });
    const owner = controller.registerEditor();

    expect(controller.attach(value, "dark").reason).toBe("unsupported-backend");
    expect(controller.disposeEditor(owner)).toMatchObject({ ok: false, reason: "unsupported-backend" });
    expect(controller.captureApplyEligibility(owner)).toBeNull();
    expect(controller.getSnapshot()).toMatchObject({ problem: "unsupported-backend", hasDraft: false });
  });

  it("constructs pure state and attaches only at the explicit document lifetime boundary", () => {
    const { value, controller } = fixture();
    const initial = controller.getSnapshot();
    expect(texts(value)).toEqual([]);
    expect(controller.getSnapshot()).toBe(initial);
    expect(initial.attached).toBe(false);
    expect(controller.attach(value, "dark").ok).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ attached: true, effectiveMode: "dark", modePreference: "system" });
    expect(value.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(value.documentElement.classList.contains("dark")).toBe(true);
    expect(texts(value)).toEqual([catalog.families[0]!.css]);
    expect(controller.detach().ok).toBe(true);
  });

  it("coordinates baseline switching, draft release, and stale eligibility without editing a document", () => {
    const { value, controller } = fixture();
    controller.attach(value, "dark");
    const authored = Object.freeze({ revision: 4, bytes: "authored-theme" });
    const owner = controller.registerEditor();
    const oldToken = controller.captureApplyEligibility(owner)!;
    expect(controller.applyDraft(owner, oldToken, ":root { --primary: #123456; }").ok).toBe(true);
    expect(controller.change({ kind: "select-pair", pairId: "terminal-nova" }).ok).toBe(true);
    expect(controller.getSnapshot().hasDraft).toBe(false);
    const baseline = [...value.head.children];
    expect(controller.applyDraft(owner, oldToken, ":root { --primary: #654321; }").reason).toBe("stale-eligibility");
    expect([...value.head.children]).toEqual(baseline);
    expect(authored).toEqual({ revision: 4, bytes: "authored-theme" });
    expect(controller.detach().ok).toBe(true);
  });

  it("keeps draft identities for a repeated pair and a same-effective explicit mode", () => {
    const { value, controller } = fixture();
    controller.attach(value, "dark");
    controller.change({ kind: "select-pair", pairId: "terminal-nova" });
    const owner = controller.registerEditor();
    const token = controller.captureApplyEligibility(owner)!;
    controller.applyDraft(owner, token, ":root { --primary: #abcdef; }");
    const elements = [...value.head.children];
    const before = controller.getSnapshot();
    expect(controller.change({ kind: "select-pair", pairId: "terminal-nova" }).ok).toBe(true);
    expect(controller.getSnapshot()).toBe(before);
    expect(controller.change({ kind: "set-mode-preference", preference: "dark" }).ok).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ hasDraft: true, modePreference: "dark" });
    expect([...value.head.children]).toEqual(elements);
    expect(controller.change({ kind: "set-mode-preference", preference: "light" }).ok).toBe(true);
    expect(controller.getSnapshot().hasDraft).toBe(false);
    expect(controller.applyDraft(owner, token, "body { color: red; }").reason).toBe("stale-eligibility");
    expect(controller.detach().ok).toBe(true);
  });

  it("releases and disposes only the matching editor's draft", () => {
    const { value, controller } = fixture();
    controller.attach(value, "light");
    const first = controller.registerEditor();
    const second = controller.registerEditor();
    controller.applyDraft(first, controller.captureApplyEligibility(first)!, "body { color: green; }");
    const attached = [...value.head.children];
    const pending = controller.captureApplyEligibility(second)!;
    expect(controller.releaseDraft(second).ok).toBe(true);
    expect(controller.isDraftOwner(first)).toBe(true);
    expect([...value.head.children]).toEqual(attached);
    expect(controller.disposeEditor(second).ok).toBe(true);
    expect(controller.applyDraft(second, pending, "body { color: red; }").reason).toBe("owner-disposed");
    expect(controller.disposeEditor(first).ok).toBe(true);
    expect(texts(value)).toHaveLength(1);
    expect(controller.detach().ok).toBe(true);
  });

  it("retains the pure editor owner when visual draft release fails", () => {
    const { value, controller } = fixture();
    controller.attach(value, "light");
    const owner = controller.registerEditor();
    const eligibility = controller.captureApplyEligibility(owner)!;
    controller.applyDraft(owner, eligibility, "body { color: green; }");
    const before = [...value.head.children];
    const remove = vi.spyOn(value.head, "removeChild").mockImplementation(() => {
      throw new Error("synthetic draft release failure");
    });

    const disposed = controller.disposeEditor(owner);

    expect(disposed).toMatchObject({ ok: false, reason: "recovery-required" });
    expect(controller.captureApplyEligibility(owner)).not.toBeNull();
    expect(controller.getSnapshot()).toMatchObject({ attached: true, hasDraft: true, problem: "recovery-required" });
    expect([...value.head.children]).toEqual(before);
    expect(controller.change({ kind: "reset" }).reason).toBe("recovery-required");
    remove.mockRestore();
    expect(controller.detach().snapshot.attached).toBe(true);
  });

  it("rejects an unavailable family before any DOM mutation", () => {
    const { value, controller } = fixture();
    controller.attach(value, "light");
    const baseline = [...value.head.children];
    expect(controller.change({ kind: "select-pair", pairId: "missing" }).ok).toBe(false);
    expect(controller.getSnapshot().selection).toEqual({ kind: "application-default" });
    expect([...value.head.children]).toEqual(baseline);
    expect(controller.detach().ok).toBe(true);
  });

  it("preserves the previous appearance and state after a recoverable attachment failure", () => {
    const { value, controller } = fixture();
    controller.attach(value, "dark");
    const baseline = [...value.head.children];
    const insert = vi.spyOn(value.head, "insertBefore").mockImplementationOnce(() => { throw new Error("synthetic attachment failure"); });
    expect(controller.change({ kind: "select-pair", pairId: "terminal-nova" }).ok).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ selection: { kind: "application-default" }, problem: "change-failed" });
    expect([...value.head.children]).toEqual(baseline);
    expect(value.documentElement.getAttribute("data-theme")).toBe("dark");
    insert.mockRestore();
    expect(controller.change({ kind: "select-pair", pairId: "terminal-nova" }).ok).toBe(true);
    expect(controller.getSnapshot().problem).toBeNull();
    expect(controller.detach().ok).toBe(true);
  });

  it("latches recovery after rollback failure and refuses further appearance mutations", () => {
    const { value, controller } = fixture();
    controller.attach(value, "light");
    const insert = vi.spyOn(value.head, "insertBefore").mockImplementation(() => { throw new Error("synthetic restoration failure"); });
    expect(controller.change({ kind: "select-pair", pairId: "terminal-nova" }).ok).toBe(false);
    expect(controller.getSnapshot().problem).toBe("recovery-required");
    const calls = insert.mock.calls.length;
    expect(controller.change({ kind: "reset" }).reason).toBe("recovery-required");
    expect(insert.mock.calls).toHaveLength(calls);
    insert.mockRestore();
    expect(controller.detach().ok).toBe(false);
  });

  it("rejects reentrant actions during staging without disrupting the outer adoption", () => {
    const { value, controller } = fixture();
    controller.attach(value, "light");
    const original = value.head.insertBefore.bind(value.head);
    let nestedResult: boolean | undefined;
    const insert = vi.spyOn(value.head, "insertBefore").mockImplementation((node, child) => {
      nestedResult = controller.change({ kind: "reset" }).ok;
      return original(node, child);
    });
    expect(controller.change({ kind: "select-pair", pairId: "terminal-nova" }).ok).toBe(true);
    expect(nestedResult).toBe(false);
    expect(controller.getSnapshot().selection).toEqual({ kind: "pair-override", id: "terminal-nova" });
    insert.mockRestore();
    expect(controller.detach().ok).toBe(true);
  });

  it("queues reentrant editor disposal until the active appearance transaction completes", () => {
    const { value, controller } = fixture();
    controller.attach(value, "light");
    const owner = controller.registerEditor();
    controller.applyDraft(owner, controller.captureApplyEligibility(owner)!, "body { color: green; }");
    const original = value.head.insertBefore.bind(value.head);
    let nested: ReturnType<typeof controller.disposeEditor> | undefined;
    const insert = vi.spyOn(value.head, "insertBefore").mockImplementation((node, child) => {
      if (!nested) nested = controller.disposeEditor(owner);
      return original(node, child);
    });

    const changed = controller.change({ kind: "select-pair", pairId: "terminal-nova" });

    expect(changed.ok).toBe(true);
    expect(nested).toMatchObject({ ok: false, reason: "operation-in-progress" });
    expect(controller.captureApplyEligibility(owner)).toBeNull();
    expect(controller.getSnapshot()).toMatchObject({ hasDraft: false, problem: null });
    insert.mockRestore();
    expect(controller.detach().ok).toBe(true);
  });

  it("preserves foreign styles and independent root classes at teardown", () => {
    const { value, controller } = fixture();
    value.documentElement.className = "independent";
    const foreign = value.createElement("style");
    foreign.textContent = ".other { color: blue; }";
    value.head.appendChild(foreign);
    controller.attach(value, "dark");
    value.documentElement.classList.add("reduced-motion");
    expect(controller.detach().ok).toBe(true);
    expect(texts(value)).toEqual([foreign.textContent]);
    expect(value.documentElement.classList.contains("independent")).toBe(true);
    expect(value.documentElement.classList.contains("reduced-motion")).toBe(true);
    expect(value.documentElement.classList.contains("dark")).toBe(false);
    expect(value.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("keeps selection across a clean detach/reattach and invalidates the old draft token", () => {
    const { value, controller } = fixture();
    controller.attach(value, "dark");
    controller.change({ kind: "select-pair", pairId: "terminal-nova" });
    controller.change({ kind: "set-mode-preference", preference: "light" });
    const owner = controller.registerEditor();
    const token = controller.captureApplyEligibility(owner)!;
    controller.applyDraft(owner, token, "body { color: green; }");
    expect(controller.detach().ok).toBe(true);
    expect(controller.attach(value, "dark").ok).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ selection: { kind: "pair-override", id: "terminal-nova" }, effectiveMode: "light", hasDraft: false });
    expect(controller.applyDraft(owner, token, "body { color: green; }").reason).toBe("stale-eligibility");
    expect(controller.detach().ok).toBe(true);
  });

  it("publishes cached snapshots and isolates observer failures from completed adoption", () => {
    const { value, controller } = fixture();
    const notify = vi.fn();
    const unsubscribe = controller.subscribe(notify);
    controller.subscribe(() => { throw new Error("synthetic observer failure"); });
    expect(controller.attach(value, "light").ok).toBe(true);
    const cached = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(cached);
    const calls = notify.mock.calls.length;
    expect(controller.change({ kind: "select-application-default" }).ok).toBe(true);
    expect(notify).toHaveBeenCalledTimes(calls);
    unsubscribe();
    expect(controller.change({ kind: "set-mode-preference", preference: "dark" }).ok).toBe(true);
    expect(notify).toHaveBeenCalledTimes(calls);
    expect(controller.detach().ok).toBe(true);
  });
});

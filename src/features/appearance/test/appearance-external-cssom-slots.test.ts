import { describe, expect, it, vi } from "vitest";
import { createAppearanceStylesheetOwner } from "../appearance-stylesheet-owner";
import {
  APPEARANCE_EXTERNAL_CSSOM_MAX_CSS_BYTES,
  APPEARANCE_EXTERNAL_CSSOM_PREPARE_TIMEOUT_MS,
  prepareAppearanceExternalCssomSlots,
  type AppearanceExternalCssomSlot,
} from "../appearance-external-cssom-slots";

class FakeRuleList {
  constructor(readonly rules: FakeRule[]) {}

  get length(): number {
    return this.rules.length;
  }

  item(index: number): FakeRule | null {
    return this.rules[index] ?? null;
  }

  insert(index: number, rule: FakeRule): void {
    this.rules.splice(index, 0, rule);
  }

  remove(index: number): void {
    this.rules.splice(index, 1);
  }
}

type FakeRule = FakeMediaRule | FakeStyleRule;

class FakeStyleDeclaration {
  constructor(private readonly values: Map<string, string>) {}

  get length(): number {
    return this.values.size;
  }

  item(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  getPropertyValue(property: string): string {
    return this.values.get(property) ?? "";
  }

  setProperty(property: string, value: string): void {
    this.values.set(property, value);
  }

  getPropertyPriority(_property: string): string {
    return "";
  }

  get cssText(): string {
    return [...this.values.entries()].map(([name, value]) => `${name}: ${value};`).join(" ");
  }
}

class FakeStyleRule {
  readonly type = 1;
  readonly selectorText: string;
  readonly style: FakeStyleDeclaration;

  constructor(selectorText: string, inert: boolean) {
    this.selectorText = selectorText;
    this.style = new FakeStyleDeclaration(
      inert ? new Map([["--theme-forge-appearance-owned-slot-inert", "0"]]) : new Map(),
    );
  }

  get cssText(): string {
    return `${this.selectorText} { ${this.style.cssText} }`;
  }
}

class FakeMediaRule {
  readonly type = 4;
  readonly cssRules: FakeRuleList;

  constructor(conditionText: string, children: FakeRule[], private readonly bodyCssText: string | null = null) {
    this.conditionText = conditionText;
    this.cssRules = new FakeRuleList(children);
  }

  conditionText: string;

  get cssText(): string {
    const nested = this.cssRules.rules.map((rule) => rule.cssText).join(" ");
    const body = this.bodyCssText === null ? nested : `${this.bodyCssText}${nested}`;
    return `@media ${this.conditionText} {${body}}`;
  }
}

class FakeSheet {
  readonly cssRules: FakeRuleList;
  disabled = false;
  insertThenThrow = false;

  constructor(validAsset = true) {
    this.cssRules = new FakeRuleList([
      new FakeMediaRule(validAsset ? "not all" : "screen", [new FakeStyleRule(":root", validAsset)]),
    ]);
  }

  insertRule(source: string, index: number): number {
    if (source.includes("invalid") || source.includes("@bad")) throw new Error("synthetic CSSOM parse failure");
    const body = source.slice(source.indexOf("{") + 1, source.lastIndexOf("}"));
    const group = new FakeMediaRule("all", [], body);
    this.cssRules.insert(index, group);
    if (this.insertThenThrow) {
      this.insertThenThrow = false;
      throw new Error("synthetic CSSOM failure after mutation");
    }
    return index;
  }

  deleteRule(index: number): void {
    if (index < 0 || index >= this.cssRules.length) throw new Error("synthetic CSSOM delete failure");
    this.cssRules.remove(index);
  }
}

type FakeListener = () => void;

class FakeNode {
  parentNode: FakeHead | null = null;

  constructor(readonly ownerDocument: FakeDocument) {}

  get previousSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return index > 0 ? this.parentNode.childNodes[index - 1]! : null;
  }

  get nextSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return index >= 0 && index + 1 < this.parentNode.childNodes.length
      ? this.parentNode.childNodes[index + 1]!
      : null;
  }
}

class FakeLink extends FakeNode {
  rel = "";
  private mediaValue = "";
  disabled = false;
  href = "";
  sheet: FakeSheet | null = null;
  ignoreNextMediaSet = false;
  throwOnNextMediaSet = false;
  throwAfterMediaMutation = false;
  mediaSetFailures: boolean[] = [];
  private readonly listeners = new Map<string, Set<FakeListener>>();

  get media(): string {
    return this.mediaValue;
  }

  set media(value: string) {
    if (this.mediaSetFailures.length > 0) {
      const mutateBeforeThrow = this.mediaSetFailures.shift()!;
      if (mutateBeforeThrow) this.mediaValue = value;
      throw new Error("synthetic media setter failure");
    }
    if (this.ignoreNextMediaSet) {
      this.ignoreNextMediaSet = false;
      return;
    }
    if (this.throwOnNextMediaSet) {
      this.throwOnNextMediaSet = false;
      if (this.throwAfterMediaMutation) this.mediaValue = value;
      this.throwAfterMediaMutation = false;
      throw new Error("synthetic media setter failure");
    }
    this.mediaValue = value;
  }

  addEventListener(type: string, listener: FakeListener, _options?: unknown): void {
    const listeners = this.listeners.get(type) ?? new Set<FakeListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: FakeListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
}

class FakeForeignNode extends FakeNode {}

class FakeHead {
  readonly childNodes: FakeNode[] = [];
  isConnected = true;
  removeFailureCall: number | null = null;
  private removeCallCount = 0;

  constructor(readonly ownerDocument: FakeDocument) {}

  appendChild<T extends FakeNode>(node: T): T {
    if (node.parentNode) node.parentNode.removeChild(node);
    this.childNodes.push(node);
    node.parentNode = this;
    if (node instanceof FakeLink) this.ownerDocument.onAppend(node, this.childNodes.filter((entry) => entry instanceof FakeLink).length - 1);
    return node;
  }

  insertBefore<T extends FakeNode>(node: T, reference: FakeNode | null): T {
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = reference === null ? this.childNodes.length : this.childNodes.indexOf(reference);
    if (index < 0) throw new Error("synthetic reference is not attached");
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    if (node instanceof FakeLink) this.ownerDocument.onAppend(node, this.childNodes.filter((entry) => entry instanceof FakeLink).indexOf(node));
    return node;
  }

  removeChild<T extends FakeNode>(node: T): T {
    this.removeCallCount += 1;
    if (this.removeFailureCall === this.removeCallCount) {
      this.removeFailureCall = null;
      throw new Error("synthetic terminal removal failure");
    }
    const index = this.childNodes.indexOf(node);
    if (index < 0) throw new Error("synthetic node is not attached");
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
}

class FakeDocument {
  readonly location = { href: "https://studio.example.test/workbench", origin: "https://studio.example.test" };
  head = new FakeHead(this);
  readonly links: FakeLink[] = [];
  readonly adoptedStyleSheets: FakeSheet[] = [];
  onAppend: (link: FakeLink, index: number) => void = () => undefined;
  loadFailureIndex: number | null = null;
  neverLoad = false;
  invalidAssetIndex: number | null = null;

  createElement(_tagName: string): FakeLink {
    const link = new FakeLink(this);
    this.links.push(link);
    return link;
  }
}

function asDocument(documentValue: FakeDocument): Document {
  return documentValue as unknown as Document;
}

function configureLoader(documentValue: FakeDocument): void {
  documentValue.onAppend = (link, index) => {
    if (documentValue.neverLoad) return;
    if (documentValue.loadFailureIndex === index) {
      link.dispatch("error");
      return;
    }
    link.sheet = new FakeSheet(documentValue.invalidAssetIndex !== index);
    link.dispatch("load");
  };
}

async function preparedDocument(): Promise<{
  readonly documentValue: FakeDocument;
  readonly slots: Awaited<ReturnType<typeof prepareAppearanceExternalCssomSlots>>;
}> {
  const documentValue = new FakeDocument();
  configureLoader(documentValue);
  const slots = await prepareAppearanceExternalCssomSlots(asDocument(documentValue));
  return { documentValue, slots };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code} failure`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("appearance external CSSOM slots", () => {
  it("prepares four distinct same-origin disabled link sheets despite load-event races", async () => {
    const { documentValue, slots } = await preparedDocument();
    expect(documentValue.links).toHaveLength(4);
    expect(new Set(documentValue.links.map((link) => link.sheet)).size).toBe(4);
    for (const link of documentValue.links) {
      expect(link.rel).toBe("stylesheet");
      expect(link.media).toBe("not all");
      expect(link.href).toBe("https://studio.example.test/appearance-owned-slot.css");
    }
    expect(slots.teardown()).toMatchObject({ ok: true, releasedLinks: 4, remainingOwnedLinks: 0 });
  });

  it("keeps the prepared document identity opaque and rejects a different document", async () => {
    const { documentValue, slots } = await preparedDocument();
    expect(slots.belongsToDocument(asDocument(documentValue))).toBe(true);
    expect(slots.belongsToDocument(asDocument(new FakeDocument()))).toBe(false);
    expect(slots.teardown().ok).toBe(true);
  });

  it("allows the exact tauri self URL and rejects opaque, credentialed, or mismatched URLs", async () => {
    const tauriDocument = new FakeDocument();
    tauriDocument.location.href = "tauri://localhost/workbench";
    tauriDocument.location.origin = "null";
    configureLoader(tauriDocument);
    const tauriSlots = await prepareAppearanceExternalCssomSlots(asDocument(tauriDocument));
    expect(tauriDocument.links[0]!.href).toBe("tauri://localhost/appearance-owned-slot.css");
    tauriSlots.teardown();

    for (const [href, origin] of [
      ["file:///tmp/workbench", "null"],
      [["da", "ta:text/html,workbench"].join(""), "null"],
      ["about:blank", "null"],
      ["https://studio.example.test/workbench", "https://evil.example.test"],
      ["https://user:secret@studio.example.test/workbench", "https://studio.example.test"],
    ] as const) {
      const invalidDocument = new FakeDocument();
      invalidDocument.location.href = href;
      invalidDocument.location.origin = origin;
      configureLoader(invalidDocument);
      await expect(prepareAppearanceExternalCssomSlots(asDocument(invalidDocument))).rejects.toMatchObject({
        code: "capability-unavailable",
      });
      expect(invalidDocument.head.childNodes).toHaveLength(0);
    }
  });

  it("removes only owned links after a meaningful load failure", async () => {
    const documentValue = new FakeDocument();
    const foreign = new FakeForeignNode(documentValue);
    documentValue.head.appendChild(foreign);
    documentValue.loadFailureIndex = 1;
    configureLoader(documentValue);

    await expect(prepareAppearanceExternalCssomSlots(asDocument(documentValue))).rejects.toMatchObject({ code: "load-failed" });
    expect(documentValue.head.childNodes).toEqual([foreign]);
    expect(foreign.parentNode).toBe(documentValue.head);
  });

  it("times out the bounded preparation and preserves pre-existing nodes", async () => {
    vi.useFakeTimers();
    try {
      const documentValue = new FakeDocument();
      const foreign = new FakeForeignNode(documentValue);
      documentValue.head.appendChild(foreign);
      documentValue.neverLoad = true;
      configureLoader(documentValue);
      const pending = prepareAppearanceExternalCssomSlots(asDocument(documentValue));
      const rejection = expect(pending).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(APPEARANCE_EXTERNAL_CSSOM_PREPARE_TIMEOUT_MS);
      await rejection;
      expect(documentValue.head.childNodes).toEqual([foreign]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts preparation without removing a foreign node", async () => {
    const documentValue = new FakeDocument();
    const foreign = new FakeForeignNode(documentValue);
    documentValue.head.appendChild(foreign);
    documentValue.neverLoad = true;
    configureLoader(documentValue);
    const controller = new AbortController();
    const pending = prepareAppearanceExternalCssomSlots(asDocument(documentValue), controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(documentValue.head.childNodes).toEqual([foreign]);
  });

  it("rejects a foreign insertion during loading before publishing the capability", async () => {
    const documentValue = new FakeDocument();
    const foreign = new FakeForeignNode(documentValue);
    documentValue.onAppend = (link, index) => {
      link.sheet = new FakeSheet();
      link.dispatch("load");
      if (index === 1) documentValue.head.insertBefore(foreign, link);
    };

    await expect(prepareAppearanceExternalCssomSlots(asDocument(documentValue))).rejects.toMatchObject({ code: "resource-drift" });
    expect(documentValue.head.childNodes).toEqual([foreign]);
    expect(foreign.parentNode).toBe(documentValue.head);
  });

  it("cleans up a reentrant append abort without leaving rejected load promises", async () => {
    const documentValue = new FakeDocument();
    const controller = new AbortController();
    documentValue.onAppend = () => controller.abort();
    const pending = prepareAppearanceExternalCssomSlots(asDocument(documentValue), controller.signal);

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(documentValue.head.childNodes).toHaveLength(0);
  });

  it("rejects an invalid fixed asset before exposing the capability", async () => {
    const documentValue = new FakeDocument();
    documentValue.invalidAssetIndex = 0;
    configureLoader(documentValue);
    await expect(prepareAppearanceExternalCssomSlots(asDocument(documentValue))).rejects.toMatchObject({ code: "asset-invalid" });
    expect(documentValue.head.childNodes).toHaveLength(0);
  });

  it("stages an always-matching group while disabled and activates it explicitly", async () => {
    const { documentValue, slots } = await preparedDocument();
    const resource = slots.acquire("baseline", ".panel { color: red; }\n.button { color: blue; }");
    const link = documentValue.links[0]!;
    const sheet = link.sheet!;
    expect(link.media).toBe("not all");
    expect(sheet.cssRules).toHaveLength(2);
    expect((sheet.cssRules.item(1) as FakeMediaRule).conditionText).toBe("all");

    slots.activate(resource);
    expect(link.media).toBe("all");
    slots.deactivate(resource);
    expect(link.media).toBe("not all");
    slots.release(resource);
    slots.teardown();
  });

  it("rejects silent or throwing media setters and preserves the prior state", async () => {
    const { documentValue, slots } = await preparedDocument();
    const resource = slots.acquire("baseline", ".media-state { color: red; }");
    const link = documentValue.links[0]!;

    link.ignoreNextMediaSet = true;
    expectCode(() => slots.activate(resource), "resource-drift");
    expect(link.media).toBe("not all");

    link.throwOnNextMediaSet = true;
    link.throwAfterMediaMutation = true;
    expectCode(() => slots.activate(resource), "resource-drift");
    expect(link.media).toBe("not all");

    slots.activate(resource);
    link.ignoreNextMediaSet = true;
    expectCode(() => slots.deactivate(resource), "resource-drift");
    expect(link.media).toBe("all");

    link.throwOnNextMediaSet = true;
    link.throwAfterMediaMutation = true;
    expectCode(() => slots.deactivate(resource), "resource-drift");
    expect(link.media).toBe("all");

    slots.deactivate(resource);
    link.mediaSetFailures = [true, false];
    expectCode(() => slots.activate(resource), "rollback-failed");
    expect(link.media).toBe("all");
    expect(slots.teardown().ok).toBe(false);
  });

  it("rejects forbidden or oversized CSS without consuming a pool slot", async () => {
    const { slots } = await preparedDocument();
    for (const source of [
      "@import url(https://example.test/theme.css);",
      "@charset \"UTF-8\";",
      "@namespace svg url(http://www.w3.org/2000/svg);",
    ]) {
      expectCode(() => slots.acquire("baseline", source), "forbidden-at-rule");
    }
    expectCode(() => slots.acquire("baseline", "x".repeat(APPEARANCE_EXTERNAL_CSSOM_MAX_CSS_BYTES + 1)), "css-too-large");
    expectCode(() => slots.acquire("baseline", ".invalid { color: red; }"), "css-parse-failed");
    const resources = [0, 1].map((index) => slots.acquire("baseline", `.ok-${index} { color: red; }`));
    resources.push(...[0, 1].map((index) => slots.acquire("draft", `.ok-draft-${index} { color: red; }`)));
    expect(resources).toHaveLength(4);
    resources.forEach((resource) => slots.release(resource));
    slots.teardown();
  });

  it("enforces the four-resource pool and reuses a released link and sheet", async () => {
    const { documentValue, slots } = await preparedDocument();
    const resources = [0, 1].map((index) => slots.acquire("baseline", `.slot-${index} { color: red; }`));
    resources.push(...[0, 1].map((index) => slots.acquire("draft", `.slot-draft-${index} { color: red; }`)));
    expect(documentValue.links.map((link) => (link.sheet!.cssRules.item(1) as FakeMediaRule).cssText)).toEqual([
      expect.stringContaining(".slot-0"),
      expect.stringContaining(".slot-1"),
      expect.stringContaining(".slot-draft-0"),
      expect.stringContaining(".slot-draft-1"),
    ]);
    const firstLink = documentValue.links[0]!;
    const firstSheet = firstLink.sheet;
    expectCode(() => slots.acquire("baseline", ".fifth { color: red; }"), "pool-exhausted");
    expectCode(() => slots.acquire("draft", ".fifth-draft { color: red; }"), "pool-exhausted");

    slots.release(resources[0]!);
    const reused = slots.acquire("baseline", ".reused { color: green; }");
    expect(reused).not.toBe(resources[0]);
    expect(documentValue.links[0]!.sheet).toBe(firstSheet);
    expect((documentValue.links[0]!.sheet!.cssRules.item(1) as FakeMediaRule).cssText).toContain(".reused");
    resources.slice(1).forEach((resource) => slots.release(resource));
    slots.release(reused);
    slots.teardown();
  });

  it("keeps handles pool-private and rejects a handle from another pool", async () => {
    const first = await preparedDocument();
    const second = await preparedDocument();
    const handle = first.slots.acquire("baseline", ".first-pool { color: red; }");

    expectCode(() => second.slots.release(handle), "invalid-resource");
    first.slots.release(handle);
    expect(first.slots.dispose().ok).toBe(true);
    expect(second.slots.dispose().ok).toBe(true);
  });

  it("preserves foreign nodes on teardown and closes all actions", async () => {
    const { documentValue, slots } = await preparedDocument();
    const foreign = new FakeForeignNode(documentValue);
    documentValue.head.appendChild(foreign);
    const result = slots.teardown();
    expect(result).toMatchObject({ ok: true, releasedLinks: 4 });
    expect(documentValue.head.childNodes).toEqual([foreign]);
    expect(() => slots.acquire("baseline", ".closed { color: red; }")).toThrow();
    expect(slots.teardown()).toBe(result);
  });

  it("reports partial terminal removal truthfully and retries only exact owned links", async () => {
    const { documentValue, slots } = await preparedDocument();
    const foreign = new FakeForeignNode(documentValue);
    documentValue.head.appendChild(foreign);
    documentValue.head.removeFailureCall = 2;

    const partial = slots.dispose();
    expect(partial).toMatchObject({ ok: false, releasedLinks: 3, remainingOwnedLinks: 1 });
    expect(documentValue.head.childNodes).toHaveLength(2);
    expect(foreign.parentNode).toBe(documentValue.head);

    expect(slots.dispose()).toMatchObject({ ok: true, releasedLinks: 4, remainingOwnedLinks: 0 });
    expect(documentValue.head.childNodes).toEqual([foreign]);
    expect(foreign.parentNode).toBe(documentValue.head);
  });

  it("retains a released handle when final integrity verification fails", async () => {
    const { documentValue, slots } = await preparedDocument();
    const resource = slots.acquire("baseline", ".release-check { color: red; }");
    const sheet = documentValue.links[0]!.sheet!;
    const deleteRule = sheet.deleteRule.bind(sheet);
    sheet.deleteRule = (index: number) => {
      deleteRule(index);
      documentValue.adoptedStyleSheets.push(new FakeSheet());
    };

    expectCode(() => slots.release(resource), "resource-drift");
    expect(slots.dispose()).toMatchObject({ ok: false, releasedLinks: 0, remainingOwnedLinks: 4 });

    documentValue.adoptedStyleSheets.length = 0;
    slots.release(resource);
    expect(slots.dispose()).toMatchObject({ ok: true, releasedLinks: 4, remainingOwnedLinks: 0 });
  });

  it("keeps a retained free handle recovery-only and prevents slot aliasing", async () => {
    const { documentValue, slots } = await preparedDocument();
    const oldH1 = slots.acquire("baseline", ".old-h1 { color: red; }");
    const oldSheet = documentValue.links[0]!.sheet!;
    const deleteRule = oldSheet.deleteRule.bind(oldSheet);
    oldSheet.deleteRule = (index: number) => {
      deleteRule(index);
      documentValue.adoptedStyleSheets.push(new FakeSheet());
    };

    expectCode(() => slots.release(oldH1), "resource-drift");
    documentValue.adoptedStyleSheets.length = 0;

    expectCode(() => slots.activate(oldH1), "invalid-resource");
    expectCode(() => slots.deactivate(oldH1), "invalid-resource");
    expectCode(() => slots.stage(oldH1, ".must-not-revive { color: blue; }"), "invalid-resource");

    const newH2 = slots.acquire("baseline", ".new-h2 { color: green; }");
    const newLink = documentValue.links[1]!;
    const newSheet = newLink.sheet!;
    slots.activate(newH2);
    const newGroup = newSheet.cssRules.item(1);
    expect(newLink.media).toBe("all");
    expect(newGroup?.cssText).toContain(".new-h2");

    slots.release(oldH1);
    expect(newLink.media).toBe("all");
    expect(newSheet.cssRules.item(1)).toBe(newGroup);
    expect(newSheet.cssRules.item(1)?.cssText).toContain(".new-h2");

    slots.release(newH2);
    expect(slots.dispose()).toMatchObject({ ok: true, releasedLinks: 4, remainingOwnedLinks: 0 });
  });

  it("fails closed for foreign adopted sheets or an inserted node inside the owned block", async () => {
    const { documentValue, slots } = await preparedDocument();
    const foreignNode = new FakeForeignNode(documentValue);
    documentValue.head.insertBefore(foreignNode, documentValue.links[1]!);
    expectCode(() => slots.verify(), "resource-drift");
    expect(foreignNode.parentNode).toBe(documentValue.head);
    documentValue.head.removeChild(foreignNode);

    const foreignSheet = new FakeSheet();
    documentValue.adoptedStyleSheets.push(foreignSheet);
    expectCode(() => slots.verify(), "resource-drift");
    expect(documentValue.adoptedStyleSheets).toEqual([foreignSheet]);
    documentValue.adoptedStyleSheets.pop();
    slots.verify();
    expect(slots.dispose().ok).toBe(true);
  });

  it("refuses a pre-existing adopted stylesheet before exposing the pool", async () => {
    const documentValue = new FakeDocument();
    const foreignSheet = new FakeSheet();
    documentValue.adoptedStyleSheets.push(foreignSheet);
    configureLoader(documentValue);

    await expect(prepareAppearanceExternalCssomSlots(asDocument(documentValue))).rejects.toMatchObject({
      code: "capability-unavailable",
    });
    expect(documentValue.adoptedStyleSheets).toEqual([foreignSheet]);
    expect(documentValue.head.childNodes).toHaveLength(0);
  });

  it("keeps the pool reachable when terminal disposal has live handles", async () => {
    const { documentValue, slots } = await preparedDocument();
    const staged = slots.acquire("baseline", ".staged { color: red; }");
    expect(slots.dispose()).toMatchObject({ ok: false, releasedLinks: 0, remainingOwnedLinks: 4 });
    slots.release(staged);

    const active = slots.acquire("draft", ".active { color: blue; }");
    slots.activate(active);
    expect(slots.teardown()).toMatchObject({ ok: false, releasedLinks: 0, remainingOwnedLinks: 4 });
    slots.deactivate(active);
    slots.release(active);
    expect(slots.dispose()).toMatchObject({ ok: true, releasedLinks: 4, remainingOwnedLinks: 0 });
    expect(documentValue.head.childNodes).toHaveLength(0);
  });

  it("reports href, stylesheet, rule-set, and reparent drift without removing foreign nodes", async () => {
    const { documentValue, slots } = await preparedDocument();
    const resource = slots.acquire("baseline", ".drift { color: red; }");
    const link = documentValue.links[0]!;
    const sheet = link.sheet!;
    link.disabled = true;
    expectCode(() => slots.activate(resource), "resource-drift");
    link.disabled = false;
    sheet.disabled = true;
    expectCode(() => slots.activate(resource), "resource-drift");
    sheet.disabled = false;
    const originalHead = documentValue.head;
    documentValue.head = new FakeHead(documentValue);
    expectCode(() => slots.activate(resource), "resource-drift");
    documentValue.head = originalHead;
    originalHead.isConnected = false;
    expectCode(() => slots.activate(resource), "resource-drift");
    originalHead.isConnected = true;
    link.href = "https://other.example.test/foreign.css";
    expectCode(() => slots.activate(resource), "resource-drift");
    link.href = "https://studio.example.test/appearance-owned-slot.css";
    const originalSheet = link.sheet!;
    link.sheet = new FakeSheet();
    expectCode(() => slots.activate(resource), "resource-drift");
    link.sheet = originalSheet;
    const baseRule = sheet.cssRules.item(0) as FakeMediaRule;
    baseRule.conditionText = "screen";
    expectCode(() => slots.activate(resource), "resource-drift");
    baseRule.conditionText = "not all";
    const baseStyle = baseRule.cssRules.item(0) as FakeStyleRule;
    baseStyle.style.setProperty("--theme-forge-appearance-owned-slot-inert", "1");
    expectCode(() => slots.activate(resource), "resource-drift");
    baseStyle.style.setProperty("--theme-forge-appearance-owned-slot-inert", "0");
    const group = sheet.cssRules.item(1) as FakeMediaRule;
    group.cssRules.insert(0, new FakeStyleRule(".nested-foreign", false));
    expectCode(() => slots.activate(resource), "resource-drift");
    group.cssRules.remove(0);
    sheet.cssRules.insert(1, new FakeStyleRule(".foreign", false));
    expectCode(() => slots.activate(resource), "resource-drift");

    const foreignParent = new FakeHead(documentValue);
    foreignParent.appendChild(link);
    expectCode(() => slots.release(resource), "resource-drift");
    expect(foreignParent.childNodes).toEqual([link]);
    const result = slots.teardown();
    expect(result.ok).toBe(false);
    expect(foreignParent.childNodes).toEqual([link]);
  });

  it("keeps the prior staged group when replacement CSS fails", async () => {
    const { documentValue, slots } = await preparedDocument();
    const resource: AppearanceExternalCssomSlot = slots.acquire("baseline", ".old { color: red; }");
    const link = documentValue.links[0]!;
    const sheet = link.sheet!;
    const oldGroup = sheet.cssRules.item(1);
    expectCode(() => slots.stage(resource, ".invalid { color: blue; }"), "css-parse-failed");
    expect(sheet.cssRules.item(1)).toBe(oldGroup);
    slots.release(resource);
    slots.teardown();
  });

  it("poisons a resource when CSSOM insertion mutates before reporting failure", async () => {
    const { documentValue, slots } = await preparedDocument();
    const sheet = documentValue.links[0]!.sheet!;
    sheet.insertThenThrow = true;
    expectCode(() => slots.acquire("baseline", ".partial { color: red; }"), "rollback-failed");
    expect(sheet.cssRules).toHaveLength(2);

    const result = slots.teardown();
    expect(result).toMatchObject({ ok: false, releasedLinks: 0, remainingOwnedLinks: 4 });
    expect(documentValue.links[0]!.parentNode).toBe(documentValue.head);
  });
  it("retries real owner teardown after a retained-free release integrity failure", async () => {
    const { documentValue, slots } = await preparedDocument();
    const owner = createAppearanceStylesheetOwner(asDocument(documentValue), { externalCssomSlots: slots });
    expect(owner.stageBaseline(".owner-baseline { color: red; }").commit().ok).toBe(true);
    const sheet = documentValue.links[0]!.sheet!;
    const remove = sheet.deleteRule.bind(sheet);
    sheet.deleteRule = (index: number) => {
      remove(index);
      documentValue.adoptedStyleSheets.push(new FakeSheet());
    };

    expect(owner.teardown().ok).toBe(false);
    expect(owner.snapshot().closed).toBe(false);
    documentValue.adoptedStyleSheets.length = 0;

    // The real owner calls retryable release directly; it must not call the
    // now-forbidden deactivate operation on a retained-free handle.
    expect(owner.teardown()).toMatchObject({ ok: true, status: "closed", baselineReleased: true });
    expect(slots.dispose()).toMatchObject({ ok: true, releasedLinks: 4, remainingOwnedLinks: 0 });
  });

});

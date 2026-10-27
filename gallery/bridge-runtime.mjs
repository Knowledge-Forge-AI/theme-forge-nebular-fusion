/** Materializes the closed gallery contract. Runs only in prepared opaque frames. */
/** @typedef {{cssByteCeiling: number, diagnosticStringCeiling: number, applicationIdCeiling: number, applyKeys: readonly string[], probeKeys: readonly string[], failureCodes: readonly string[], canaryCommand: string}} BridgeContract */
/** @typedef {Record<string, unknown>} ClosedMessage */
/** @param {BridgeContract} contract @param {string} scenarioId @returns {string} */
export function createBridgeScript(contract, scenarioId) {
  return `(${galleryRuntime.toString()})(${JSON.stringify(contract)}, ${JSON.stringify(scenarioId)});`;
}

/** @param {BridgeContract} contract @param {string} scenarioId */
function galleryRuntime(contract, scenarioId) {
  /** @type {Window & Record<string, unknown>} */
  const typedWindow = /** @type {Window & Record<string, unknown>} */ (/** @type {unknown} */ (window));
  const storage = new Map();
  /** @type {Storage} */
  const memoryStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key), clear: () => storage.clear(),
    key: index => Array.from(storage.keys())[index] ?? null,
    get length() { return storage.size; },
  };
  try {
    Object.defineProperty(window, "localStorage", { value: memoryStorage });
    Object.defineProperty(window, "sessionStorage", { value: memoryStorage });
  } catch { /* Opaque-frame storage is optional; never request origin authority. */ }
  let lastRevision = -1;
  /** @param {unknown} data @param {readonly string[]} keys @returns {data is ClosedMessage} */
  const closed = (data, keys) => data !== null && typeof data === "object" && !Array.isArray(data)
    && Object.keys(data).every(key => keys.includes(key));
  /** @param {unknown} value @returns {value is number} */
  const uint = value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  document.addEventListener("click", event => {
    const eventTarget = /** @type {HTMLAnchorElement | null} */ (event.target);
    const anchor = eventTarget?.closest?.("a");
    const href = anchor?.getAttribute("href");
    if (anchor && (anchor.target === "_blank" || !href || /^(?:\/\/|[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(href.trim()) || href.includes("\\"))) {
      event.preventDefault(); event.stopPropagation();
    }
  }, true);
  window.addEventListener("message", /** @param {MessageEvent<unknown>} event */ (event) => {
    const source = event.source;
    if (source !== typedWindow.parent || source === null) return;
    const sourceWindow = /** @type {Window} */ (source);
    const data = event.data;
    if (closed(data, contract.probeKeys) && data.type === "tfsl:attempt-command") {
      // Application-owned denial canary. The command is a fixed contract literal;
      // request fields can never select a command or arguments. A reachable handle
      // fails qualification without invoking it or consuming its authority.
      let directAllowed = false, parentAllowed = false, reason = "tauri_ipc_handles_absent";
      try {
        directAllowed = Boolean(typedWindow.__TAURI_INTERNALS__ || typedWindow.__TAURI__ || typedWindow.ipc);
        if (directAllowed) reason = "native_handle_reachable";
      } catch { reason = "native_probe_failed"; }
      try {
        const typedParent = /** @type {Window & Record<string, unknown>} */ (typedWindow.parent);
        parentAllowed = Boolean(typedParent.__TAURI_INTERNALS__);
      } catch { /* Expected opaque origin denial. */ }
      sourceWindow.postMessage({ type: "tfsl:command-attempt-result", command: contract.canaryCommand,
        directAllowed, parentAllowed, reason }, "*");
      return;
    }
    if (!closed(data, contract.applyKeys) || data.type !== "tfsl:apply-theme") return;
    const revision = data.revision;
    const frameGeneration = data.frameGeneration;
    const applicationId = data.applicationId;
    const css = data.css;
    const mode = data.mode;
    if (!uint(revision) || !uint(frameGeneration) || revision < lastRevision
      || data.scenarioId !== scenarioId || typeof applicationId !== "string"
      || !applicationId.length || applicationId.length > contract.applicationIdCeiling
      || typeof css !== "string" || (mode !== "dark" && mode !== "light")) return;
    const reply = { revision, frameGeneration, scenarioId, applicationId };
    /** @param {string} code */
    const fail = code => sourceWindow.postMessage({ type: "tfsl:theme-failed", ...reply, code }, "*");
    if (new TextEncoder().encode(css).length > contract.cssByteCeiling) { fail("css-too-large"); return; }
    const previous = document.getElementById("tfsl-injected-theme");
    const previousCss = previous?.textContent ?? null;
    const previousMode = document.documentElement.dataset.theme;
    let style = previous;
    try {
      if (!style) {
        style = document.createElement("style"); style.id = "tfsl-injected-theme";
        document.head.appendChild(style);
      }
      style.textContent = css;
      document.documentElement.dataset.theme = mode;
      // A missing sheet includes CSP rejection. Do not acknowledge a rejected application.
      if (!style || !("sheet" in style) || !style.sheet) throw new Error("stylesheet unavailable");
      const computedAccent = getComputedStyle(document.documentElement).getPropertyValue("--sl-color-accent").trim().slice(0, contract.diagnosticStringCeiling);
      const link = document.querySelector(".sl-markdown-content p a");
      const renderedLinkColor = link ? getComputedStyle(link).color.slice(0, contract.diagnosticStringCeiling) : "";
      lastRevision = revision;
      sourceWindow.postMessage({ type: "tfsl:theme-applied", ...reply, computedAccent, renderedLinkColor }, "*");
    } catch {
      try {
        if (previous) previous.textContent = previousCss;
        else style?.remove();
        if (typeof previousMode === "string") document.documentElement.dataset.theme = previousMode;
        else delete document.documentElement.dataset.theme;
      } catch { /* Failure remains visible; do not claim rollback succeeded. */ }
      fail("application-failed");
    }
  });
}

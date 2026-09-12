/** Materializes the closed gallery contract. Runs only in prepared opaque frames. */
export function createBridgeScript(contract, scenarioId) {
  return `(${galleryRuntime.toString()})(${JSON.stringify(contract)}, ${JSON.stringify(scenarioId)});`;
}

function galleryRuntime(contract, scenarioId) {
  const storage = new Map();
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
  const closed = (data, keys) => data && typeof data === "object" && !Array.isArray(data)
    && Object.keys(data).every(key => keys.includes(key));
  const uint = value => Number.isSafeInteger(value) && value >= 0;
  document.addEventListener("click", event => {
    const anchor = event.target?.closest?.("a");
    const href = anchor?.getAttribute("href");
    if (anchor && (anchor.target === "_blank" || !href || /^(?:\/\/|[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(href.trim()) || href.includes("\\"))) {
      event.preventDefault(); event.stopPropagation();
    }
  }, true);
  window.addEventListener("message", event => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (closed(data, contract.probeKeys) && data.type === "tfsl:attempt-command") {
      // Application-owned denial canary. The command is a fixed contract literal;
      // request fields can never select a command or arguments. A reachable handle
      // fails qualification without invoking it or consuming its authority.
      let directAllowed = false, parentAllowed = false, reason = "tauri_ipc_handles_absent";
      try {
        directAllowed = Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__ || window.ipc);
        if (directAllowed) reason = "native_handle_reachable";
      } catch { reason = "native_probe_failed"; }
      try { parentAllowed = Boolean(window.parent.__TAURI_INTERNALS__); } catch { /* Expected opaque origin denial. */ }
      event.source.postMessage({ type: "tfsl:command-attempt-result", command: contract.canaryCommand,
        directAllowed, parentAllowed, reason }, "*");
      return;
    }
    if (!closed(data, contract.applyKeys) || data.type !== "tfsl:apply-theme"
      || !uint(data.revision) || !uint(data.frameGeneration) || data.revision < lastRevision
      || data.scenarioId !== scenarioId || typeof data.applicationId !== "string"
      || !data.applicationId.length || data.applicationId.length > contract.applicationIdCeiling
      || typeof data.css !== "string" || !["dark", "light"].includes(data.mode)) return;
    const reply = { revision: data.revision, frameGeneration: data.frameGeneration, scenarioId, applicationId: data.applicationId };
    const fail = code => event.source.postMessage({ type: "tfsl:theme-failed", ...reply, code }, "*");
    if (new TextEncoder().encode(data.css).length > contract.cssByteCeiling) { fail("css-too-large"); return; }
    const previous = document.getElementById("tfsl-injected-theme");
    const previousCss = previous?.textContent;
    const previousMode = document.documentElement.dataset.theme;
    let style = previous;
    try {
      if (!style) {
        style = document.createElement("style"); style.id = "tfsl-injected-theme";
        document.head.appendChild(style);
      }
      style.textContent = data.css;
      document.documentElement.dataset.theme = data.mode;
      // A missing sheet includes CSP rejection. Do not acknowledge a rejected application.
      if (!style.sheet) throw new Error("stylesheet unavailable");
      const computedAccent = getComputedStyle(document.documentElement).getPropertyValue("--sl-color-accent").trim().slice(0, contract.diagnosticStringCeiling);
      const link = document.querySelector(".sl-markdown-content p a");
      const renderedLinkColor = link ? getComputedStyle(link).color.slice(0, contract.diagnosticStringCeiling) : "";
      lastRevision = data.revision;
      event.source.postMessage({ type: "tfsl:theme-applied", ...reply, computedAccent, renderedLinkColor }, "*");
    } catch {
      try {
        if (previous) previous.textContent = previousCss;
        else style?.remove();
        if (previousMode === undefined) delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = previousMode;
      } catch { /* Failure remains visible; do not claim rollback succeeded. */ }
      fail("application-failed");
    }
  });
}

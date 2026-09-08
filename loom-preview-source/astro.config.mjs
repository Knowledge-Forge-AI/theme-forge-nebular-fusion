import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

const themeFile = process.env.TFSL_THEME_CSS || "./src/styles/theme.css";
const outDir = process.env.ASTRO_OUT_DIR || "./dist";
const base = process.env.ASTRO_BASE || undefined;

const isInstrumentedPreview = process.env.TFSL_INSTRUMENTED_PREVIEW === "1";

const nativeProbeScript = isInstrumentedPreview
  ? `
    if (event.data.type === "tfsl:attempt-command") {
      var cmd = "studio_theme_lab_status";
      var directAllowed = false;
      var parentAllowed = false;
      var reason = "";
      try {
        if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === "function") {
          window.__TAURI_INTERNALS__.invoke(cmd);
          directAllowed = true;
        } else if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === "function") {
          window.__TAURI__.core.invoke(cmd);
          directAllowed = true;
        } else if (window.ipc) {
          window.ipc.postMessage(cmd);
          directAllowed = true;
        } else {
          reason = "tauri_ipc_handles_absent";
        }
      } catch (err) {
        reason = String(err);
      }
      try {
        var p = window.parent;
        if (p && p.__TAURI_INTERNALS__) {
          parentAllowed = true;
        }
      } catch (err) {
        // Expected SecurityError / cross-origin restriction
      }
      try {
        if (event.source && typeof event.source.postMessage === "function") {
          event.source.postMessage({
            type: "tfsl:command-attempt-result",
            command: cmd,
            directAllowed: directAllowed,
            parentAllowed: parentAllowed,
            reason: reason
          }, event.origin || "*");
        }
      } catch (e) {}
    }`
  : "";

export default defineConfig({
  outDir,
  base,
  server: {
    host: "127.0.0.1",
  },
  integrations: [
    starlight({
      title: "Theme Forge Stellar Loom Fixture",
      description: "Starlight kitchen-sink documentation fixture for TFSL viability testing",
      customCss: [themeFile],
      head: [
        {
          tag: "script",
          content: `(function() {
  const memoryStore = {};
  const mockStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(memoryStore, k) ? memoryStore[k] : null),
    setItem: (k, v) => { memoryStore[k] = String(v); },
    removeItem: (k) => { delete memoryStore[k]; },
    clear: () => { for (const k in memoryStore) delete memoryStore[k]; },
    get length() { return Object.keys(memoryStore).length; },
    key: (i) => Object.keys(memoryStore)[i] || null,
  };
  try {
    Object.defineProperty(window, 'localStorage', { value: mockStorage, configurable: true, writable: true });
    Object.defineProperty(window, 'sessionStorage', { value: mockStorage, configurable: true, writable: true });
  } catch (e) {}
  try {
    delete window.webkit;
    delete window.ipc;
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI__;
  } catch (e) {}

  function interceptLinks(e) {
    var target = e.target;
    while (target && target.tagName !== "A") {
      target = target.parentElement;
    }
    if (target && target.tagName === "A") {
      var href = target.getAttribute("href");
      if (href && (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("//") || target.target === "_blank")) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  }
  document.addEventListener("click", interceptLinks, true);

  if (typeof MutationObserver !== "undefined") {
    var observer = new MutationObserver(function() {
      if (!document.getElementById("tfsl-injected-theme") && window.__tfslThemeSheet) {
        try {
          window.__tfslThemeSheet.replaceSync("");
        } catch (e) {}
      }
    });
    window.addEventListener("DOMContentLoaded", function() {
      if (document.head) {
        observer.observe(document.head, { childList: true });
      }
    });
    if (document.head) {
      observer.observe(document.head, { childList: true });
    }
  }

  var lastAppliedRevision = 0;
  window.addEventListener("message", function(event) {
    if (!event.data || typeof event.data !== "object") return;
    if (event.source !== window.parent) return;
    if (event.data.type === "tfsl:apply-theme") {
      var css = event.data.css;
      var mode = event.data.mode;
      var revision = typeof event.data.revision === "number" ? event.data.revision : 0;
      if (revision < lastAppliedRevision) return;
      lastAppliedRevision = revision;
      if (typeof mode === "string") {
        document.documentElement.dataset.theme = mode;
      }
      if (typeof css === "string") {
        try {
          if (typeof CSSStyleSheet !== "undefined" && "adoptedStyleSheets" in document) {
            if (!window.__tfslThemeSheet) {
              window.__tfslThemeSheet = new CSSStyleSheet();
              document.adoptedStyleSheets = [...document.adoptedStyleSheets, window.__tfslThemeSheet];
            }
            window.__tfslThemeSheet.replaceSync(css);
          }
        } catch (e) {}

        try {
          var existing = document.getElementById("tfsl-injected-theme");
          if (!existing) {
            existing = document.createElement("style");
            existing.id = "tfsl-injected-theme";
            document.head.appendChild(existing);
          }
          existing.textContent = css;
        } catch (e) {}
      }
      try {
        if (event.source && typeof event.source.postMessage === "function") {
          var computedAccent = "";
          var renderedLinkColor = "";
          try {
            computedAccent = window.getComputedStyle(document.documentElement).getPropertyValue("--sl-color-accent").trim();
            var renderedLink = document.querySelector(".sl-markdown-content p a");
            if (renderedLink) renderedLinkColor = window.getComputedStyle(renderedLink).color;
          } catch (e) {}
          event.source.postMessage({ type: "tfsl:theme-applied", revision: revision, computedAccent: computedAccent, renderedLinkColor: renderedLinkColor }, event.origin || "*");
        }
      } catch (e) {}
    }${nativeProbeScript}
  });
})();`,
        },
      ],
      sidebar: [
        {
          label: "Overview",
          items: [
            { label: "Kitchen Sink", slug: "index" },
          ],
        },
      ],
    }),
  ],
});

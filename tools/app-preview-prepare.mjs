import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryRootForStudio } from "./sidecar-common.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const studioRoot = resolve(__dirname, "..");
const repoRoot = repositoryRootForStudio(studioRoot);
const publicAppDir = resolve(studioRoot, "public/preview/app");

export async function prepareAppPreview() {
  console.log("Preparing application preview fixture in public/preview/app...");
  await mkdir(publicAppDir, { recursive: true, mode: 0o755 });

  const cssContent = `/* Upstream shadcn/ui and Tailwind v4 core tokens and reset */
:root {
  --background: #fff8f0;
  --foreground: #1c1917;
  --card: #ffffff;
  --card-foreground: #1c1917;
  --popover: #ffffff;
  --popover-foreground: #1c1917;
  --primary: #126475;
  --primary-foreground: #ffffff;
  --secondary: #e7e5e4;
  --secondary-foreground: #1c1917;
  --muted: #f5f5f4;
  --muted-foreground: #78716c;
  --accent: #ff8a3d;
  --accent-foreground: #1c1917;
  --destructive: #ef4444;
  --destructive-foreground: #ffffff;
  --border: #e7e5e4;
  --input: #e7e5e4;
  --ring: #126475;
  --radius: 0.5rem;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}

.dark, :root[data-theme="dark"] {
  --background: #111318;
  --foreground: #f2f2f2;
  --card: #181b22;
  --card-foreground: #f2f2f2;
  --popover: #181b22;
  --popover-foreground: #f2f2f2;
  --primary: #69d3e4;
  --primary-foreground: #111318;
  --secondary: #27272a;
  --secondary-foreground: #f2f2f2;
  --muted: #27272a;
  --muted-foreground: #a1a1aa;
  --accent: #ff8a3d;
  --accent-foreground: #111318;
  --destructive: #7f1d1d;
  --destructive-foreground: #f2f2f2;
  --border: #27272a;
  --input: #27272a;
  --ring: #69d3e4;
}

* {
  box-sizing: border-box;
  border-color: var(--border);
}

body {
  margin: 0;
  padding: 1.5rem;
  background-color: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: 1.5rem;
  transition: background-color 150ms ease, color 150ms ease;
}

/* Upstream shadcn/ui Card Component Styles */
[data-slot="card"] {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background-color: var(--card);
  color: var(--card-foreground);
  padding: 1.5rem;
  box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1);
  width: 100%;
  max-width: 32rem;
}

[data-slot="card-header"] {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

[data-slot="card-title"] {
  font-size: 1.25rem;
  font-weight: 600;
  line-height: 1.2;
  margin: 0;
}

[data-slot="card-description"] {
  font-size: 0.875rem;
  color: var(--muted-foreground);
  margin: 0;
}

[data-slot="card-content"] {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

[data-slot="card-footer"] {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border);
}

/* Upstream shadcn/ui Button Component Styles */
[data-slot="button"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  white-space: nowrap;
  border-radius: calc(var(--radius) - 2px);
  font-size: 0.875rem;
  font-weight: 500;
  height: 2.25rem;
  padding: 0 1rem;
  transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
  cursor: pointer;
  border: 1px solid transparent;
  outline: none;
}

[data-slot="button"]:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}

[data-slot="button"][data-variant="default"] {
  background-color: var(--primary);
  color: var(--primary-foreground);
}

[data-slot="button"][data-variant="default"]:hover {
  opacity: 0.9;
}

[data-slot="button"][data-variant="secondary"] {
  background-color: var(--secondary);
  color: var(--secondary-foreground);
}

[data-slot="button"][data-variant="secondary"]:hover {
  opacity: 0.8;
}

[data-slot="button"][data-variant="outline"] {
  border-color: var(--input);
  background-color: transparent;
  color: var(--foreground);
}

[data-slot="button"][data-variant="outline"]:hover {
  background-color: var(--muted);
  color: var(--foreground);
}

[data-slot="button"][data-variant="destructive"] {
  background-color: var(--destructive);
  color: var(--destructive-foreground);
}

[data-slot="button"][data-variant="destructive"]:hover {
  opacity: 0.9;
}

[data-slot="button"][data-variant="ghost"] {
  background-color: transparent;
  color: var(--foreground);
}

[data-slot="button"][data-variant="ghost"]:hover {
  background-color: var(--muted);
}

/* Upstream shadcn/ui Input Component Styles */
[data-slot="input"] {
  display: flex;
  height: 2.25rem;
  width: 100%;
  border-radius: calc(var(--radius) - 2px);
  border: 1px solid var(--input);
  background-color: transparent;
  padding: 0.25rem 0.75rem;
  font-size: 0.875rem;
  color: var(--foreground);
  outline: none;
  transition: border-color 150ms ease, box-shadow 150ms ease;
}

[data-slot="input"]:focus-visible {
  border-color: var(--ring);
  box-shadow: 0 0 0 1px var(--ring);
}

/* Upstream shadcn/ui Badge Component Styles */
[data-slot="badge"] {
  display: inline-flex;
  align-items: center;
  border-radius: 9999px;
  padding: 0.125rem 0.625rem;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1;
  border: 1px solid transparent;
  background-color: var(--primary);
  color: var(--primary-foreground);
}

[data-slot="badge"][data-variant="secondary"] {
  background-color: var(--secondary);
  color: var(--secondary-foreground);
}

[data-slot="badge"][data-variant="outline"] {
  border-color: var(--border);
  background-color: transparent;
  color: var(--foreground);
}

/* Upstream shadcn/ui Tabs Component Styles */
[data-slot="tabs"] {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: 100%;
}

[data-slot="tabs-list"] {
  display: inline-flex;
  height: 2.25rem;
  align-items: center;
  justify-content: flex-start;
  border-radius: calc(var(--radius) - 2px);
  background-color: var(--muted);
  padding: 0.25rem;
  color: var(--muted-foreground);
}

[data-slot="tabs-trigger"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  border-radius: calc(var(--radius) - 4px);
  padding: 0.25rem 0.75rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--muted-foreground);
  cursor: pointer;
  border: none;
  background: transparent;
  outline: none;
  transition: all 150ms ease;
}

[data-slot="tabs-trigger"][aria-selected="true"] {
  background-color: var(--card);
  color: var(--card-foreground);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

/* Consumer Override Proof (proving cascade precedence without !important) */
.consumer-override-card {
  --primary: #8b5cf6;
  --radius: 1rem;
  border: 2px dashed var(--primary);
  max-width: 100%;
}

.meta-footer {
  font-size: 0.75rem;
  color: var(--muted-foreground);
  text-align: center;
  max-width: 32rem;
}

/* Layout utility classes replacing inline styles */
.preview-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tab-content-active {
  display: block;
}

.tab-content-hidden {
  display: none;
}

.overview-description {
  font-size: 0.875rem;
  line-height: 1.5;
  margin: 0 0 1rem 0;
}

.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.form-field-group {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.form-field-label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--muted-foreground);
  display: block;
  margin-bottom: 0.25rem;
}

.override-header-title {
  margin: 0;
  font-size: 1rem;
  color: var(--primary);
}

.footer-caption {
  font-size: 0.75rem;
  color: var(--muted-foreground);
  margin-right: auto;
}
`;

  const jsContent = `// Constructable stylesheet injection (CSP compliant, no unsafe-inline required)
(function() {
  var lastAppliedRevision = -1;
  window.addEventListener("message", function(event) {
    if (event.source !== window.parent) return;
    if (!event.data || typeof event.data !== "object") return;
    if (event.data.type === "tfss:apply-theme") {
      var css = event.data.css;
      var mode = event.data.mode;
      var revision = typeof event.data.revision === "number" ? event.data.revision : 0;
      var contextId = typeof event.data.contextId === "string" ? event.data.contextId : "";
      if (revision < lastAppliedRevision) return;
      lastAppliedRevision = revision;

      if (typeof mode === "string") {
        document.documentElement.classList.toggle("dark", mode === "dark");
        document.documentElement.dataset.theme = mode;
      }

      var applied = false;
      var applyError = "";
      if (typeof css === "string") {
        try {
          if (typeof CSSStyleSheet !== "undefined" && "adoptedStyleSheets" in document) {
            if (!window.__tfssThemeSheet) {
              window.__tfssThemeSheet = new CSSStyleSheet();
              document.adoptedStyleSheets = [...document.adoptedStyleSheets, window.__tfssThemeSheet];
            }
            window.__tfssThemeSheet.replaceSync(css);
            applied = true;
          } else {
            applyError = "CSSStyleSheet.adoptedStyleSheets unsupported";
          }
        } catch (e) {
          applyError = e ? (e.message || String(e)) : "Failed to replace style sheet";
        }
      }

      if (applied && event.source && typeof event.source.postMessage === "function") {
        try {
          var computedPrimary = "";
          var computedBg = "";
          try {
            computedPrimary = window.getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
            computedBg = window.getComputedStyle(document.body).backgroundColor;
          } catch (e) {}
          event.source.postMessage({
            type: "tfss:theme-applied",
            revision: revision,
            mode: mode,
            contextId: contextId,
            computedPrimary: computedPrimary,
            computedBackground: computedBg,
          }, "*");
        } catch (e) {}
      } else if (!applied && event.source && typeof event.source.postMessage === "function") {
        try {
          event.source.postMessage({
            type: "tfss:theme-apply-failed",
            revision: revision,
            mode: mode,
            contextId: contextId,
            error: applyError || "CSS was not applied",
          }, "*");
        } catch (e) {}
      }
    }
  });

  // Tab switcher logic
  function switchTab(tabId) {
    document.querySelectorAll("[data-slot='tabs-trigger']").forEach(function(el) {
      var isSelected = el.getAttribute("data-tab-target") === tabId;
      el.setAttribute("aria-selected", isSelected ? "true" : "false");
    });
    document.querySelectorAll("[data-slot='tabs-content']").forEach(function(el) {
      var active = el.id === "content-" + tabId;
      el.classList.toggle("tab-content-active", active);
      el.classList.toggle("tab-content-hidden", !active);
    });
  }

  // Bind tab click listeners on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initTabs);
  } else {
    initTabs();
  }

  function initTabs() {
    document.querySelectorAll("[data-slot='tabs-trigger']").forEach(function(btn) {
      btn.addEventListener("click", function() {
        var target = btn.getAttribute("data-tab-target");
        if (target) {
          switchTab(target);
        }
      });
    });
  }
})();
`;

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Application Theme Live Preview — Nebular Fusion</title>
  <link rel="stylesheet" href="./app.css">
  <script src="./app.js"></script>
</head>
<body>
  <!-- Lightweight component adaptations patterned after shadcn/ui. -->
  <!-- Designed for Solar Sail Tailwind v4 token preview within Nebular Studio. -->

  <!-- Primary Application Card -->
  <div data-slot="card" id="app-preview-card">
    <div data-slot="card-header">
      <div class="preview-header-row">
        <h3 data-slot="card-title" id="card-heading">Forge Console Studio</h3>
        <span data-slot="badge" data-variant="default" id="status-badge">Solar Sail 0.1</span>
      </div>
      <p data-slot="card-description">
        Lightweight component adaptations patterned after shadcn/ui rendered with Theme Forge Solar Sail Tailwind v4 tokens.
      </p>
    </div>

    <div data-slot="card-content">
      <!-- Tabs Component -->
      <div data-slot="tabs">
        <div data-slot="tabs-list" role="tablist">
          <button data-slot="tabs-trigger" data-tab-target="overview" id="tab-overview" role="tab" aria-selected="true">Overview</button>
          <button data-slot="tabs-trigger" data-tab-target="inputs" id="tab-inputs" role="tab" aria-selected="false">Controls</button>
          <button data-slot="tabs-trigger" data-tab-target="override" id="tab-override" role="tab" aria-selected="false">Consumer Override</button>
        </div>

        <div id="content-overview" data-slot="tabs-content" class="tab-content-active">
          <p class="overview-description">
            This live frame responds to declarative profile edits compiled deterministically via Solar Sail.
            Colors, radii, and typography cascade directly into standard CSS properties.
          </p>
          <div class="button-row">
            <button data-slot="button" data-variant="default" id="btn-primary">Primary Action</button>
            <button data-slot="button" data-variant="secondary" id="btn-secondary">Secondary</button>
            <button data-slot="button" data-variant="outline" id="btn-outline">Outline</button>
            <button data-slot="button" data-variant="ghost" id="btn-ghost">Ghost</button>
            <button data-slot="button" data-variant="destructive" id="btn-destructive">Destructive</button>
          </div>
        </div>

        <div id="content-inputs" data-slot="tabs-content" class="tab-content-hidden">
          <div class="form-field-group">
            <div>
              <label for="input-search" class="form-field-label">Search Tokens</label>
              <input data-slot="input" id="input-search" type="text" placeholder="Type here to test focus ring..." />
            </div>
            <div>
              <label for="input-channel" class="form-field-label">Distribution Channel</label>
              <input data-slot="input" id="input-channel" type="text" value="Apple Silicon Developer Build" readonly />
            </div>
          </div>
        </div>

        <div id="content-override" data-slot="tabs-content" class="tab-content-hidden">
          <div data-slot="card" class="consumer-override-card" id="override-container">
            <div data-slot="card-header">
              <h4 class="override-header-title">Consumer Cascade Precedence Scope</h4>
              <p data-slot="card-description">Sets --primary: #8b5cf6 and --radius: 1rem locally without !important.</p>
            </div>
            <div data-slot="card-content">
              <button data-slot="button" data-variant="default" id="btn-overridden-primary">
                Inherits Overridden Primary
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div data-slot="card-footer">
      <span class="footer-caption">
        Interactive preview with shadcn-style component adaptations
      </span>
      <button data-slot="button" data-variant="outline" id="btn-footer-cancel">Dismiss</button>
      <button data-slot="button" data-variant="default" id="btn-footer-save">Adopt Draft</button>
    </div>
  </div>

  <div class="meta-footer">
    <span>Prebuilt preview fixture · Sandboxed iframe · Constructable stylesheet adoption · Zero external network traffic</span>
  </div>
</body>
</html>
`;

  const targetCss = resolve(publicAppDir, "app.css");
  const targetJs = resolve(publicAppDir, "app.js");
  const targetHtml = resolve(publicAppDir, "index.html");
  const targetNotice = resolve(publicAppDir, "NOTICE.md");
  const targetProvenance = resolve(publicAppDir, "provenance.json");

  const upstreamComponentPaths = [
    "packages/solar-sail/consumer-fixture/src/components/ui/button.tsx",
    "packages/solar-sail/consumer-fixture/src/components/ui/card.tsx",
    "packages/solar-sail/consumer-fixture/src/components/ui/badge.tsx",
    "packages/solar-sail/consumer-fixture/src/components/ui/input.tsx",
    "packages/solar-sail/consumer-fixture/src/components/ui/tabs.tsx",
  ];
  const upstreamComponents = upstreamComponentPaths.map((rel) => {
    const full = resolve(repoRoot, rel);
    const content = existsSync(full) ? readFileSync(full) : Buffer.from("");
    const digest = createHash("sha256").update(content).digest("hex");
    return { path: rel, sha256: digest };
  });

  const provenanceData = {
    schema: "tfss.preview-provenance-v1",
    name: "@knowledge-forge-ai/studio-app-preview",
    version: "0.1.0",
    description: "Sandboxed unprivileged preview fixture for Tailwind CSS v4 and shadcn/ui component adaptations",
    license: "MIT",
    runtimeDependencies: {},
    source: {
      fixture: "packages/solar-sail/consumer-fixture",
      components: upstreamComponents,
      patternedAfterUpstreamPackages: {
        "@radix-ui/react-slot": "1.1.2",
        "@radix-ui/react-tabs": "1.1.3",
        "class-variance-authority": "0.7.1",
        "clsx": "2.1.1",
        "tailwind-merge": "3.0.2",
      },
    },
    security: {
      sandbox: "allow-scripts",
      network: "none",
      nativeIpc: "none",
      csp: "default-src 'none'; script-src 'self' tauri://localhost; style-src 'self' tauri://localhost; font-src 'self' tauri://localhost; img-src 'self' tauri://localhost data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'",
    },
  };

  const noticeContent = `# Application Preview Fixture Notice

This unprivileged sandboxed preview fixture integrates component adaptations patterned after shadcn/ui and Radix UI primitives for live Theme Forge Solar Sail Tailwind v4 token preview within Nebular Studio.

## Upstream Components & Provenance
- Button (\`packages/solar-sail/consumer-fixture/src/components/ui/button.tsx\`): Patterned after shadcn/ui Button via Radix Slot (\`@radix-ui/react-slot@1.1.2\`) and CVA (\`class-variance-authority@0.7.1\`).
- Card (\`packages/solar-sail/consumer-fixture/src/components/ui/card.tsx\`): Patterned after shadcn/ui Card.
- Badge (\`packages/solar-sail/consumer-fixture/src/components/ui/badge.tsx\`): Patterned after shadcn/ui Badge via CVA.
- Input (\`packages/solar-sail/consumer-fixture/src/components/ui/input.tsx\`): Patterned after shadcn/ui Input.
- Tabs (\`packages/solar-sail/consumer-fixture/src/components/ui/tabs.tsx\`): Patterned after shadcn/ui Tabs via Radix Tabs (\`@radix-ui/react-tabs@1.1.3\`).

## Security & Sandboxing Invariants
- Sandboxed iframe (\`sandbox="allow-scripts"\`).
- Origin is opaque (\`null\`).
- Zero native IPC (\`connect-src 'none'\`).
- Zero external network authority.
- Constructable stylesheet adoption (no \`'unsafe-inline'\` styles required).
- Bilateral origin, context-ID and revision-bound postMessage protocol.
`;

  await writeFile(targetCss, cssContent, "utf8");
  await writeFile(targetJs, jsContent, "utf8");
  await writeFile(targetHtml, htmlContent, "utf8");
  await writeFile(targetNotice, noticeContent, "utf8");
  await writeFile(targetProvenance, JSON.stringify(provenanceData, null, 2) + "\n", "utf8");
  console.log(`Application preview fixtures and provenance written to ${publicAppDir}`);
}

if (process.argv[1] === __filename) {
  prepareAppPreview().catch((err) => {
    console.error("FATAL:", err.message);
    process.exit(1);
  });
}

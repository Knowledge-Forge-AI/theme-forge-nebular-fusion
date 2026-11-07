import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { FixtureStudioHostBridge, TauriStudioHostBridge } from "./host/studio-host-bridge";
import { TauriThemeLabBridge } from "./features/theme-lab/theme-lab-bridge";
import { TauriAppearanceSettingsBridge } from "./features/appearance/appearance-settings-bridge";
import { createAppearanceStartupSession } from "./features/appearance/appearance-bootstrap";
import { bundledAppearanceCatalog } from "./features/appearance/bundled-appearance-catalog";
import "./styles/studio.css";

async function mountStudio() {
const rootElement = document.getElementById("root");
const explicitFixtureMode = import.meta.env.DEV
  && import.meta.env.VITE_TFSB_STUDIO_FIXTURE_MODE === "true";
const hostBridge = explicitFixtureMode
  ? new FixtureStudioHostBridge()
  : new TauriStudioHostBridge();
const themeLabBridge = explicitFixtureMode
  ? new (await import("./features/theme-lab/test/mock-bridge")).MockThemeLabBridge()
  : new TauriThemeLabBridge();

if (rootElement === null) {
  throw new Error("Studio root element is unavailable");
}

// Load only the bounded native preference DTO before the first application render.
// Fixture mode does not access a real configuration directory or claim disk persistence.
const settingsBridge = explicitFixtureMode ? null : new TauriAppearanceSettingsBridge();
const startupSession = await createAppearanceStartupSession(bundledAppearanceCatalog, settingsBridge, { documentValue: document });
const { startup, appearance: appearanceController, persistence: appearancePersistence } = startupSession;
const startupMedia = typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : null;
appearanceController.attach(document, startupMedia?.matches ? "dark" : "light");

const reactRoot = createRoot(rootElement);
reactRoot.render(
  <StrictMode>
    <App hostBridge={hostBridge} themeLabBridge={themeLabBridge} appearanceController={appearanceController}
      {...(appearancePersistence ? { appearancePersistence } : {})}
      {...(startup ? { appearanceStartupStatus: startup.status } : {})} />
  </StrictMode>,
);

let terminalDisposed = false;
let reactUnmounted = false;
let onPageHide: (event: PageTransitionEvent) => void;
const disposeStudio = () => {
  if (terminalDisposed) return;
  let unmountCompleted = reactUnmounted;
  try {
    if (!reactUnmounted) {
      reactRoot.unmount();
      reactUnmounted = true;
      unmountCompleted = true;
    }
  } catch {
    // A failed unmount remains retryable; defer startup disposal until unmount completes.
    unmountCompleted = false;
  }

  let startupClosed = false;
  if (unmountCompleted) {
    try {
      startupClosed = startupSession.dispose().ok;
    } catch {
      startupClosed = false;
    }
  }
  if (unmountCompleted && startupClosed) {
    terminalDisposed = true;
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("unload", disposeStudio);
  }
};
onPageHide = (event: PageTransitionEvent) => {
  if (!event.persisted) disposeStudio();
};
window.addEventListener("pagehide", onPageHide);
window.addEventListener("unload", disposeStudio);

}
void mountStudio();

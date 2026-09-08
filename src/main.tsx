import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { FixtureStudioHostBridge, TauriStudioHostBridge } from "./host/studio-host-bridge";
import { TauriThemeLabBridge } from "./features/theme-lab/theme-lab-bridge";
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

createRoot(rootElement).render(
  <StrictMode>
    <App hostBridge={hostBridge} themeLabBridge={themeLabBridge} />
  </StrictMode>,
);

}
void mountStudio();

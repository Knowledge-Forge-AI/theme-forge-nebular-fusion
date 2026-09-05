import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { FixtureStudioHostBridge, TauriStudioHostBridge } from "./host/studio-host-bridge";
import "./styles/studio.css";

const rootElement = document.getElementById("root");
const explicitFixtureMode = import.meta.env.DEV
  && import.meta.env.VITE_TFSB_STUDIO_FIXTURE_MODE === "true";
const hostBridge = explicitFixtureMode
  ? new FixtureStudioHostBridge()
  : new TauriStudioHostBridge();

if (rootElement === null) {
  throw new Error("Studio root element is unavailable");
}

createRoot(rootElement).render(
  <StrictMode>
    <App hostBridge={hostBridge} />
  </StrictMode>,
);

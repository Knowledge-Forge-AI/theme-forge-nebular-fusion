import { fireEvent, render, screen } from "@testing-library/react";
import { App } from "../app/App";
import { FixtureStudioHostBridge } from "../host/studio-host-bridge";
import type { StudioHostBridge } from "../protocol/contracts";

const fixtureHostBridge = new FixtureStudioHostBridge();

describe("TFSB47I sidecar host workbench", () => {
  it("renders bounded diagnostics and the closed design exchange", async () => {
    render(<App hostBridge={fixtureHostBridge} />);

    expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeTruthy();
    expect(screen.getByText(/protocol 1.2 live reads/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start sidecar" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Design exchange" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import brief" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Import candidate" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/integrity is not a signature/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /provider|model|apply packet/i })).toBeNull();
  });

  it("does not expose candidate choice or plan authority before a matching brief", async () => {
    render(<App hostBridge={fixtureHostBridge} />);
    expect(await screen.findByText("No design packet loaded.")).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "preferred" })).toBeNull();
    expect(screen.queryByRole("button", { name: /load proposal/i })).toBeNull();
    expect(screen.queryByText(/plan handle|request id|session nonce/i)).toBeNull();
  });

  it("renders one bounded accessible error without silently falling back", async () => {
    const rejectedHostBridge: StudioHostBridge = {
      source: "rust-tauri",
      async getStatus() { throw new Error("raw host detail must not render"); },
      async startHost() { throw new Error("raw host detail must not render"); },
      async selectProject() { return { cancelled: true }; },
      async selectSource() { return { cancelled: true }; },
      async shutdownHost() { return undefined; },
      close() { return undefined; },
    };
    render(<App hostBridge={rejectedHostBridge} />);

    expect((await screen.findByRole("alert")).textContent).toContain("Studio host unavailable");
    expect(screen.queryByText(/raw host detail/)).toBeNull();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
  });

  it("switches destination view between Brand Workbench and Theme Lab", async () => {
    render(<App hostBridge={fixtureHostBridge} />);

    expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeTruthy();
    const themeLabBtn = screen.getByRole("button", { name: "Theme Lab" });
    fireEvent.click(themeLabBtn);

    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Diagnostics" })).toBeNull();

    const workbenchBtn = screen.getByRole("button", { name: "Brand Workbench" });
    fireEvent.click(workbenchBtn);

    expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeTruthy();
  });
});

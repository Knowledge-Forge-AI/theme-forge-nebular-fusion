import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../app/App";
import { FixtureStudioHostBridge } from "../host/studio-host-bridge";
import { MockThemeLabBridge } from "../features/theme-lab/test/mock-bridge";
import { MockAppThemeBridge } from "../features/application-theme/app-theme-bridge";
import type { StudioHostBridge, StudioHostStatus } from "../protocol/contracts";
import { createAppearanceController } from "../features/appearance/appearance-controller";
import { bundledAppearanceCatalog } from "../features/appearance/bundled-appearance-catalog";
import { StrictMode } from "react";

const fixtureHostBridge = new FixtureStudioHostBridge();

function statusWithState(base: StudioHostStatus, state: StudioHostStatus["state"]): StudioHostStatus {
  return {
    ...base,
    state,
    selectedProtocolVersion: state === "ready" ? "1.2" : null,
    serverVersion: state === "ready" ? "0.1.0" : null,
  };
}

function lifecycleBridge(
  getStatus: StudioHostBridge["getStatus"],
  startHost: StudioHostBridge["startHost"],
): StudioHostBridge {
  return {
    source: "fixture-test",
    getStatus,
    startHost,
    async selectProject() { return { cancelled: true }; },
    async selectSource() { return { cancelled: true }; },
    async shutdownHost() { return undefined; },
    close() { return undefined; },
  };
}

describe("TFSB47I sidecar host workbench", () => {
  it("changes installed appearance without changing an edited profile, preview mode, or compile count", async () => {
    const bridge = new MockAppThemeBridge();
    const compile = vi.spyOn(bridge, "pairedCompile");
    const reset = vi.spyOn(bridge, "reset");
    const save = vi.spyOn(bridge, "saveProfile");
    render(<App hostBridge={fixtureHostBridge} appThemeBridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "Application Theme" }));
    await screen.findByText("Paired theme compilation succeeded.");
    fireEvent.change(screen.getByLabelText("Primary", { exact: true }), { target: { value: "#123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit Light Palette" }));
    const inputs = () => [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".application-theme-lab input, .application-theme-lab select")].map(input => input.value);
    const before = inputs();
    const count = compile.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Application appearance", { selector: "select" }), { target: { value: "terminal-nova" } });
    fireEvent.change(screen.getByLabelText("Application display mode"), { target: { value: "dark" } });
    expect(inputs()).toEqual(before);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(screen.getByRole("heading", { name: "Design Tokens (light)" })).toBeTruthy();
    expect(screen.getByText("Unsaved Changes")).toBeTruthy();
    expect(compile).toHaveBeenCalledTimes(count);
    expect(reset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save Profile…" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0].profile?.palette.dark.primary).toBe("#123456");
  });

  it("keeps an adopted draft while its editor is hidden and releases it when appearance resets", async () => {
    const appearance = createAppearanceController(bundledAppearanceCatalog);
    const bridge = new MockAppThemeBridge();
    const { unmount } = render(<StrictMode><App hostBridge={fixtureHostBridge} appThemeBridge={bridge} appearanceController={appearance} /></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: "Application Theme" }));
    await screen.findByText("Paired theme compilation succeeded.");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My retained draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Compile Theme" }));
    await screen.findByText("Paired theme compilation succeeded.");
    fireEvent.click(screen.getByRole("button", { name: "Adopt as Draft" }));
    expect(appearance.getSnapshot().hasDraft).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Brand / System" }));
    expect(appearance.getSnapshot().hasDraft).toBe(true);
    expect(document.querySelector(".work-area-application-theme")?.hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reset appearance" }));
    expect(appearance.getSnapshot().hasDraft).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Application Theme" }));
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "My retained draft");
    expect(screen.getByText("Unsaved Changes")).toBeTruthy();
    unmount();
    expect(appearance.getSnapshot().attached).toBe(false);
  });

  it("updates the editor after a late compile while retaining the selected appearance and baseline", async () => {
    const appearance = createAppearanceController(bundledAppearanceCatalog);
    const bridge = new MockAppThemeBridge();
    const original = bridge.pairedCompile.bind(bridge);
    let finish!: () => void;
    bridge.pairedCompile = async (profile, revision) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return original(profile, revision);
    };
    render(<App hostBridge={fixtureHostBridge} appThemeBridge={bridge} appearanceController={appearance} />);
    fireEvent.click(screen.getByRole("button", { name: "Application Theme" }));
    fireEvent.change(screen.getByLabelText("Application appearance", { selector: "select" }), { target: { value: "terminal-nova" } });
    const baseline = [...document.head.querySelectorAll("style")];
    await act(async () => { finish(); });
    await screen.findByText("Paired theme compilation succeeded.");
    expect(appearance.getSnapshot().selection).toEqual({ kind: "pair-override", id: "terminal-nova" });
    expect(appearance.getSnapshot().hasDraft).toBe(false);
    expect([...document.head.querySelectorAll("style")]).toEqual(baseline);
    expect(screen.queryByText(/Adopted theme candidate as unsaved draft/)).toBeNull();
  });

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

  it("ignores a mismatched deferred lifecycle status after the start result and keeps polling", async () => {
    const base = await new FixtureStudioHostBridge().getStatus();
    const stopped = statusWithState(base, "stopped");
    const ready = statusWithState(base, "ready");
    let statusCalls = 0;
    let releaseLifecycleStatus!: (status: StudioHostStatus) => void;
    const lifecycleStatus = new Promise<StudioHostStatus>((resolve) => { releaseLifecycleStatus = resolve; });
    const bridge = lifecycleBridge(
      async () => {
        statusCalls += 1;
        if (statusCalls === 1) return stopped;
        if (statusCalls === 2) return lifecycleStatus;
        return ready;
      },
      async (onEvent) => {
        onEvent({ schemaVersion: 1, sequence: 1, state: "starting" });
        return ready;
      },
    );

    render(<App hostBridge={bridge} />);
    expect(await screen.findByText("stopped")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start sidecar" }));

    await waitFor(() => expect(screen.getByText("ready")).toBeTruthy());
    await act(async () => { releaseLifecycleStatus(stopped); });
    expect(screen.getByRole("button", { name: "Restart sidecar" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Stop sidecar" }) as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => expect(statusCalls).toBeGreaterThanOrEqual(3), { timeout: 2_500 });
    expect(screen.getByText("ready")).toBeTruthy();
  });

  it("applies a matching lifecycle crash status while the start command is unresolved", async () => {
    const base = await new FixtureStudioHostBridge().getStatus();
    const stopped = statusWithState(base, "stopped");
    const crashed = { ...statusWithState(base, "crashed"), lastReasonCode: "sidecar-crashed" };
    let statusCalls = 0;
    let releaseStart!: (status: StudioHostStatus) => void;
    const startResult = new Promise<StudioHostStatus>((resolve) => { releaseStart = resolve; });
    const bridge = lifecycleBridge(
      async () => {
        statusCalls += 1;
        return statusCalls === 1 ? stopped : crashed;
      },
      async (onEvent) => {
        onEvent({ schemaVersion: 1, sequence: 2, state: "crashed", reasonCode: "sidecar-crashed" });
        return startResult;
      },
    );

    render(<App hostBridge={bridge} />);
    expect(await screen.findByText("stopped")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start sidecar" }));
    await waitFor(() => expect(screen.getByText("crashed")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Start sidecar" })).toBeTruthy();
    await act(async () => { releaseStart(crashed); });
  });

  it("switches destination view among Brand / System, Vector / Graphics, Starlight Theme, and Application Theme", async () => {
    const mockThemeBridge = new MockThemeLabBridge();
    const mockAppThemeBridge = new MockAppThemeBridge();
    render(
      <App
        hostBridge={fixtureHostBridge}
        themeLabBridge={mockThemeBridge}
        appThemeBridge={mockAppThemeBridge}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeTruthy();

    const vectorBtn = screen.getByRole("button", { name: "Vector / Graphics" });
    fireEvent.click(vectorBtn);
    expect(await screen.findByRole("heading", { name: "Vector / Graphics" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Diagnostics" })).toBeNull();

    const starlightBtn = screen.getByRole("button", { name: "Starlight Theme" });
    fireEvent.click(starlightBtn);
    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Vector / Graphics" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Diagnostics" })).toBeNull();

    const appThemeBtn = screen.getByRole("button", { name: "Application Theme" });
    fireEvent.click(appThemeBtn);
    expect(await screen.findByRole("heading", { name: "Application Theme Lab" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Theme Lab" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Vector / Graphics" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Diagnostics" })).toBeNull();

    const brandBtn = screen.getByRole("button", { name: "Brand / System" });
    fireEvent.click(brandBtn);
    expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Application Theme Lab" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Theme Lab" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Vector / Graphics" })).toBeNull();
  });

  it("persists initialized work areas as hidden and inert preserving unsaved state", async () => {
    const mockThemeBridge = new MockThemeLabBridge();
    const { container } = render(<App hostBridge={fixtureHostBridge} themeLabBridge={mockThemeBridge} />);

    expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeTruthy();

    // Starlight Theme work area is not initialized before visit
    expect(container.querySelector(".work-area-starlight-theme")).toBeNull();

    // Switch to Starlight Theme to initialize it
    fireEvent.click(screen.getByRole("button", { name: "Starlight Theme" }));
    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    // Perform an edit in Theme Lab to create unsaved state
    const hexInput = screen.getByLabelText("Accent base hex code");
    fireEvent.change(hexInput, { target: { value: "#112233" } });
    await waitFor(() => {
      expect(screen.getByText("Theme compiled successfully")).toBeTruthy();
    });
    expect(screen.getByText(/\* Modified/)).toBeTruthy();

    // Switch to Vector / Graphics
    fireEvent.click(screen.getByRole("button", { name: "Vector / Graphics" }));
    expect(await screen.findByRole("heading", { name: "Vector / Graphics" })).toBeTruthy();

    // Verify hidden and inert attributes on inactive initialized work areas
    const brandArea = container.querySelector(".work-area-brand-system");
    const themeArea = container.querySelector(".work-area-starlight-theme");
    const vectorArea = container.querySelector(".work-area-vector-graphics");

    expect(brandArea?.hasAttribute("hidden")).toBe(true);
    expect(brandArea?.hasAttribute("inert")).toBe(true);
    expect(themeArea?.hasAttribute("hidden")).toBe(true);
    expect(themeArea?.hasAttribute("inert")).toBe(true);
    expect(vectorArea?.hasAttribute("hidden")).toBe(false);
    expect(vectorArea?.hasAttribute("inert")).toBe(false);

    // Inactive work areas are not in accessibility tree
    expect(screen.queryByRole("heading", { name: "Theme Lab" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Diagnostics" })).toBeNull();

    // Switch back to Starlight Theme and verify unsaved state is preserved
    fireEvent.click(screen.getByRole("button", { name: "Starlight Theme" }));
    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();
    const reenteredHexInput = screen.getByLabelText("Accent base hex code") as HTMLInputElement;
    expect(reenteredHexInput.value).toBe("#112233");
    expect(screen.getByText(/\* Modified/)).toBeTruthy();
  });

  it("ties theme session disposal to application lifetime and not destination switching", async () => {
    let disposeCalled = false;
    const mockThemeBridge = new MockThemeLabBridge();
    const disposingBridge = {
      ...mockThemeBridge,
      getStatus: () => mockThemeBridge.getStatus(),
      loadExample: (n: string, r?: number, s?: string) => mockThemeBridge.loadExample(n, r, s),
      compile: (r: any) => mockThemeBridge.compile(r),
      openTheme: () => mockThemeBridge.openTheme(),
      saveTheme: (r: any) => mockThemeBridge.saveTheme(r),
      dispose: async () => {
        disposeCalled = true;
      },
    };

    const { unmount } = render(<App hostBridge={fixtureHostBridge} themeLabBridge={disposingBridge} />);

    // Initialize Theme Lab
    fireEvent.click(screen.getByRole("button", { name: "Starlight Theme" }));
    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();

    // Switch between work areas
    fireEvent.click(screen.getByRole("button", { name: "Brand / System" }));
    expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeTruthy();
    expect(disposeCalled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Vector / Graphics" }));
    expect(await screen.findByRole("heading", { name: "Vector / Graphics" })).toBeTruthy();
    expect(disposeCalled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Starlight Theme" }));
    expect(await screen.findByRole("heading", { name: "Theme Lab" })).toBeTruthy();
    expect(disposeCalled).toBe(false);

    // Unmount App - disposal must now be invoked at application lifetime
    unmount();
    expect(disposeCalled).toBe(true);
  });
});

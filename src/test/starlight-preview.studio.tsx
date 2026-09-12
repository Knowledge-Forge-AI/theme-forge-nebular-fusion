import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { StarlightPreview } from "../features/theme-lab/StarlightPreview";
import { SAMPLE_THEME_V2, type ThemeSpecificationV2 } from "../features/theme-lab/v2-model";
import { BRIDGE_CONTRACT, GALLERY_BRIDGE_CSS_BYTE_CEILING, GALLERY_COVERAGE, GALLERY_SCENARIOS,
  isThemeAppliedBridgeAck, normalizeCommandAttemptResult, resolveDraftGallerySelection, validatePreSendCss } from "../features/theme-lab/gallery-contract";

function draft(): ThemeSpecificationV2 {
  const spec = structuredClone(SAMPLE_THEME_V2);
  spec.catalog = { layout: "standard", sidebar: { mode: "nested", groupIds: ["fixture"] }, pagination: {variant: "card"},
    pageTitle: {copy: "url"}, hero: {routes: []}, fontLicenses: [] };
  return spec;
}
function currentFrame() { return screen.getByTitle<HTMLIFrameElement>("Starlight Theme Preview"); }
function load() {
  const frame = currentFrame();
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  fireEvent.load(frame);
  return { frame, post };
}
function reply(frame: HTMLIFrameElement, sent: Record<string, unknown>, extra = {}) {
  const {css: _css, mode: _mode, ...correlation} = sent;
  fireEvent(window, new MessageEvent("message", { source: frame.contentWindow,
    data: { ...correlation, type: "tfsl:theme-applied", computedAccent: "#123456", ...extra } }));
}
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("closed gallery coverage", () => {
  it("has an exact finite representative for each declared structural value", () => {
    for (const [axis, values] of Object.entries(GALLERY_COVERAGE.axes)) {
      for (const value of values) {
        expect(Object.values(GALLERY_SCENARIOS).some(s => axis === "heroLayout"
          ? s.heroRoutes.some(route => route.layout === value)
          : s.structuralConfig[axis as keyof typeof s.structuralConfig] === value)).toBe(true);
      }
    }
  });
  it("selects conflicting pagination and Hero axes without claiming the other axes", () => {
    const spec = draft(); spec.catalog!.pagination.variant = "plain";
    const view = resolveDraftGallerySelection(spec, "paginationVariant");
    expect(view.scenarioId).toBe("flexoki-catalog"); expect(view.exactAxis).toBe(true);
    expect(view.unrepresented).toContain("sidebarMode");
    for (const layout of GALLERY_COVERAGE.axes.heroLayout) {
      spec.catalog!.hero.routes = [{ route: "/custom", layout, title: "Custom title", actions: [] }];
      const hero = resolveDraftGallerySelection(spec, "heroLayout");
      expect(hero.exactAxis).toBe(true); expect(hero.represented).toEqual(["heroLayout"]); expect(hero.entryPath).toContain(`hero-${layout}/index.html`);
      expect(hero.notices).toContain("arbitrary Hero content/actions/media/routes");
    }
  });
  it("does not infer catalog or code defaults from a prepared scenario", () => {
    expect(resolveDraftGallerySelection(SAMPLE_THEME_V2).exactAxis).toBe(false);
    expect(resolveDraftGallerySelection({...SAMPLE_THEME_V2, codePresentation: "consumer-default"}, "codeFrame").exactAxis).toBe(false);
  });
});
describe("gallery bridge bounds", () => {
  it("counts UTF-8 bytes below, at and above the inclusive ceiling", () => {
    for (const bytes of [GALLERY_BRIDGE_CSS_BYTE_CEILING - 1, GALLERY_BRIDGE_CSS_BYTE_CEILING, GALLERY_BRIDGE_CSS_BYTE_CEILING + 1]) {
      expect(validatePreSendCss("a".repeat(bytes)).valid).toBe(bytes <= GALLERY_BRIDGE_CSS_BYTE_CEILING);
    }
    expect(validatePreSendCss("é".repeat(GALLERY_BRIDGE_CSS_BYTE_CEILING / 2)).valid).toBe(true);
    expect(validatePreSendCss("é".repeat(GALLERY_BRIDGE_CSS_BYTE_CEILING / 2) + "é").valid).toBe(false);
  });
  it("rejects extra keys, omitted correlation, arrays and oversized diagnostics", () => {
    const ack = {type: "tfsl:theme-applied", revision: 2, frameGeneration: 1, scenarioId: "black-catalog", applicationId: "one"};
    expect(isThemeAppliedBridgeAck(ack)).toBe(true);
    for (const invalid of [{...ack, extra: true}, {...ack, applicationId: undefined}, {...ack, computedAccent: "x".repeat(129)}, [ack]]) expect(isThemeAppliedBridgeAck(invalid)).toBe(false);
    const probe = {type: "tfsl:command-attempt-result", command: "studio_theme_lab_status", directAllowed: false, parentAllowed: false, reason: "tauri_ipc_handles_absent"};
    expect(normalizeCommandAttemptResult(probe)).toEqual(probe);
    for (const invalid of [{...probe, args: {}}, {...probe, command: "arbitrary"}, {...probe, reason: "x".repeat(1024)}]) expect(normalizeCommandAttemptResult(invalid)).toBeNull();
  });
});
describe("preview application lifecycle", () => {
  it("retains last-good frame on oversize rejection and recovers", () => {
    const spec = draft();
    const {rerender} = render(<StarlightPreview gallery spec={spec} css="body {}" revision={1} mode="dark" />);
    const {frame, post} = load(); reply(frame, post.mock.calls.at(-1)![0]);
    expect(screen.getByText("Rev: 1")).toBeTruthy();
    const changed = draft(); changed.catalog!.sidebar.mode = "select";
    rerender(<StarlightPreview gallery spec={changed} css={"é".repeat(300000)} revision={2} mode="dark" />);
    expect(currentFrame()).toBe(frame); expect(post).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("512 KiB");
    rerender(<StarlightPreview gallery spec={spec} css="body {color:red}" revision={3} mode="dark" />);
    reply(frame, post.mock.calls.at(-1)![0]); expect(screen.getByText("Rev: 3")).toBeTruthy();
  });
  it("rejects same-revision replaced applications and receiver failures, then recovers", () => {
    const spec = draft(); const {rerender} = render(<StarlightPreview gallery spec={spec} css="body {}" revision={2} mode="dark" />);
    const {frame, post} = load(); const first = post.mock.calls.at(-1)![0];
    rerender(<StarlightPreview gallery spec={spec} css="body {color:red}" revision={2} mode="dark" />);
    const next = post.mock.calls.at(-1)![0]; expect(next.applicationId).not.toBe(first.applicationId);
    reply(frame, first); expect(screen.getByText("Rev: 0")).toBeTruthy();
    const {css: _css, mode: _mode, ...correlation} = next;
    fireEvent(window, new MessageEvent("message", { source: frame.contentWindow, data: {...correlation, type:"tfsl:theme-failed", code:"application-failed"} }));
    expect(screen.getByRole("alert").textContent).toContain("rejected");
    reply(frame, next); expect(screen.getByText("Rev: 0")).toBeTruthy();
    rerender(<StarlightPreview gallery spec={spec} css="body {color:blue}" revision={3} mode="dark" />);
    reply(frame, post.mock.calls.at(-1)![0]); expect(screen.getByText("Rev: 3")).toBeTruthy();
  });
  it("reports no acknowledgement, ignores late replies and recovers on reload", () => {
    vi.useFakeTimers(); render(<StarlightPreview gallery spec={draft()} css="body {}" revision={2} mode="dark" />);
    const {frame, post} = load(); const sent = post.mock.calls.at(-1)![0];
    fireEvent(window, new MessageEvent("message", {source: window, data: {type:"tfsl:theme-applied",revision:2}}));
    vi.advanceTimersByTime(BRIDGE_CONTRACT.acknowledgementTimeoutMs);
    // Trigger React's queued timer update inside its event boundary.
    fireEvent(window, new Event("resize"));
    reply(frame, sent); expect(screen.getByText("Rev: 0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", {name:"Reload"}));
    const current = load(); expect(current.frame).not.toBe(frame);
    reply(frame, sent); reply(current.frame, current.post.mock.calls.at(-1)![0]);
    expect(screen.getByText("Rev: 2")).toBeTruthy();
    expect(current.frame.getAttribute("sandbox")).toBe("allow-scripts");
  });
  it("uses the compiled snapshot for older CSS and never calls it current draft structure", () => {
    const compiled = draft(); const current = draft(); current.catalog!.sidebar.mode = "select";
    render(<StarlightPreview gallery spec={current} compiledSpec={compiled} isLastGood css="body {}" revision={1} mode="dark" />);
    const {frame, post} = load(); reply(frame, post.mock.calls.at(-1)![0]);
    expect(frame.src).toContain("black-catalog");
    expect(screen.getByRole("status").textContent).toContain("older revision");
    fireEvent.load(frame);
    reply(frame, post.mock.calls.at(-1)![0]);
    expect(screen.queryByText("Exact Full Match")).toBeNull();
  });

  it("preserves the explicit legacy-v1 acknowledgement path", () => {
    render(<StarlightPreview css="body {}" revision={2} mode="dark" />);
    const {frame, post} = load(); reply(frame, post.mock.calls.at(-1)![0]);
    expect(screen.getByText("Rev: 2")).toBeTruthy();
  });
});

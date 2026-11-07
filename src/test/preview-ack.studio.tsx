import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApplicationPreview } from "../features/application-theme/ApplicationPreview";
import type { PreviewApplicationState } from "../features/application-theme/preview-application-state";

afterEach(() => cleanup());

describe("application preview acknowledgement boundary", () => {
  it("publishes only a current, bounded applied token", () => {
    const states: PreviewApplicationState[] = [];
    render(<ApplicationPreview css=":root { --primary: #126475; }" revision={3} mode="dark" onPreviewState={state => states.push(state)} />);
    const frame = screen.getByTitle<HTMLIFrameElement>("Application Theme Live Preview");
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    const sent = post.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(sent.type).toBe("tfss:apply-theme");
    expect(sent.frameId).toEqual(expect.any(String));
    expect(String(sent.contextId)).toContain("generation:");

    fireEvent(window, new MessageEvent("message", {
      source: frame.contentWindow,
      data: { ...sent, type: "tfss:theme-applied", computedPrimary: " #126475 " },
    }));

    expect(states.at(-1)).toMatchObject({
      state: "applied",
      revision: 3,
      mode: "dark",
      frameId: sent.frameId,
      computedToken: "#126475",
    });
    expect(states.some(state => state.state === "pending")).toBe(true);
    expect("error" in (states.at(-1) ?? {})).toBe(false);
  });

  it("does not qualify an empty computed primary and reports a closed failure", () => {
    const states: PreviewApplicationState[] = [];
    render(<ApplicationPreview css=":root { --primary: #126475; }" revision={4} mode="light" onPreviewState={state => states.push(state)} />);
    const frame = screen.getByTitle<HTMLIFrameElement>("Application Theme Live Preview");
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    const sent = post.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    fireEvent(window, new MessageEvent("message", {
      source: frame.contentWindow,
      data: { ...sent, type: "tfss:theme-applied", computedPrimary: "" },
    }));

    expect(states.at(-1)).toMatchObject({ state: "failed", revision: 4, mode: "light" });
    expect(states.some(state => state.state === "applied")).toBe(false);
    expect("error" in (states.at(-1) ?? {})).toBe(false);
  });

  it("refuses a same-revision acknowledgement from the previous load", () => {
    const states: PreviewApplicationState[] = [];
    render(<ApplicationPreview css=":root { --primary: #126475; }" revision={7} mode="dark" onPreviewState={state => states.push(state)} />);
    const firstFrame = screen.getByTitle<HTMLIFrameElement>("Application Theme Live Preview");
    const firstPost = vi.spyOn(firstFrame.contentWindow!, "postMessage");
    fireEvent.load(firstFrame);
    const firstSent = firstPost.mock.calls.at(-1)?.[0] as Record<string, unknown>;

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    const secondFrame = screen.getByTitle<HTMLIFrameElement>("Application Theme Live Preview");
    const secondPost = vi.spyOn(secondFrame.contentWindow!, "postMessage");
    fireEvent.load(secondFrame);
    const secondSent = secondPost.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(secondSent.frameId).not.toBe(firstSent.frameId);
    expect(String(secondSent.contextId)).not.toBe(String(firstSent.contextId));

    fireEvent(window, new MessageEvent("message", {
      source: firstFrame.contentWindow,
      data: { ...firstSent, type: "tfss:theme-applied", computedPrimary: "#126475" },
    }));
    expect(states.at(-1)?.state).toBe("pending");

    fireEvent(window, new MessageEvent("message", {
      source: secondFrame.contentWindow,
      data: { ...secondSent, type: "tfss:theme-applied", computedPrimary: "#126475" },
    }));
    expect(states.at(-1)?.state).toBe("applied");
  });
});


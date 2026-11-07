import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect, useState } from "react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { ApplicationThemeLab } from "../features/application-theme/ApplicationThemeLab";
import { MockAppThemeBridge } from "../features/application-theme/app-theme-bridge";
import type { PairedV2AuthoringPanelProps } from "../features/application-theme/PairedV2AuthoringPanel";
import type {
  PairedV2ApplicationAppearanceCandidate,
  PairedV2NativeBridge,
  PairedV2UiSnapshot,
  PairedV2WorkflowState,
} from "../features/application-theme/paired-v2-ui-adapter";
import type { PairedV2SaveResponse } from "../features/application-theme/paired-v2-authoring-types";
import type { AppThemeOpenedDocument } from "../features/application-theme/types";
import type { PairedV2PacketBridge } from "../features/application-theme/paired-v2-packet-bridge";
import type { PairedV2NativePacketEnvelope } from "../features/application-theme/paired-v2-packets";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const SESSION_ID = "paired-v2-lab-session";
const RAW_SOURCE = "a".repeat(64);
const CANONICAL_DIGEST = "b".repeat(64);
const FULL_APPLICATION_CSS = ":root { --full-application-appearance: #123456; }";

vi.mock("../features/application-theme/PairedV2AuthoringPanel", () => ({
  PairedV2AuthoringPanel: (props: PairedV2AuthoringPanelProps) => {
    const [adoptionMessage, setAdoptionMessage] = useState<string | undefined>(undefined);
    const [authoringReady, setAuthoringReady] = useState(false);
    const detached = props.input.mode === "detached";
    const detachedProfile = eligibleV2Document().v2Profile!;
    const sessionId = props.input.capability.sessionId ?? "missing-session";
    const candidate: PairedV2ApplicationAppearanceCandidate = {
      sessionId,
      uiRevision: 1,
      rawSourceSha256: detached ? props.input.expectedRawSourceSha256 : props.input.document.rawSourceSha256,
      canonicalDigest: detached ? props.input.expectedCanonicalDigest : props.input.document.canonicalDigest,
      sourceBytesBase64: "eA==",
      profile: detached ? detachedProfile : props.input.v2Profile,
      compiledCss: FULL_APPLICATION_CSS,
    };
    const inputDocument = detached ? {
      ...eligibleV2Document(),
      rawSourceSha256: props.input.expectedRawSourceSha256,
      canonicalDigest: props.input.expectedCanonicalDigest,
    } : props.input.document;
    const pendingSaveState = {
      snapshot: {
        lifecycle: "ready",
        capability: { supported: true, sessionId },
        ...(detached
          ? {
              sourceMode: "detached",
              detachedSource: {
                schemaVersion: "tf-paired-profile-v2",
                v2Profile: detachedProfile,
                sourceBytesBase64: props.input.sourceBytesBase64,
                rawSourceSha256: props.input.expectedRawSourceSha256,
                canonicalDigest: props.input.expectedCanonicalDigest,
                verificationStatus: "verified",
                isTransformed: false,
              },
            }
          : { sourceMode: "custody", document: inputDocument }),
        pendingCompile: false,
        pendingSave: true,
        savedFrozen: false,
        canAdoptPaired: false,
        authoring: {
          sessionId,
          revision: 1,
          edits: {},
          previewAcks: { application: undefined, starlight: undefined },
        },
      },
    } as unknown as PairedV2WorkflowState;
    const settledSaveState = {
      ...pendingSaveState,
      snapshot: {
        ...pendingSaveState.snapshot,
        pendingSave: false,
        savedFrozen: true,
      },
    } as unknown as PairedV2WorkflowState;
    useEffect(() => {
      props.onWorkflowState?.({
        snapshot: {
          ...pendingSaveState.snapshot,
          pendingSave: false,
          savedFrozen: false,
          authoring: {
            ...pendingSaveState.snapshot.authoring,
            revision: 0,
          },
        },
      } as unknown as PairedV2WorkflowState);
      setAuthoringReady(true);
    }, [props.input, props.onWorkflowState]);
    const mismatchedCandidate: PairedV2ApplicationAppearanceCandidate = {
      ...candidate,
      rawSourceSha256: "f".repeat(64),
      canonicalDigest: "e".repeat(64),
    };
    const editedSnapshot = {
      lifecycle: "ready",
      capability: { supported: true, sessionId },
      document: {
        ...inputDocument,
        v2AuthoringEligible: true,
        editable: false,
      },
      pendingCompile: false,
      canAdoptPaired: true,
      authoring: {
        sessionId,
        revision: 1,
        edits: {},
        previewAcks: { application: undefined, starlight: undefined },
      },
    } as unknown as PairedV2UiSnapshot;
    const saveResult = {
      cancelled: false,
      saved: true,
      sessionId,
      uiRevision: 1,
      document: {
        documentId: inputDocument.documentId,
        rawSourceSha256: RAW_SOURCE,
        canonicalDigest: CANONICAL_DIGEST,
        displayName: "developer.saved.profile.json",
      },
    } satisfies PairedV2SaveResponse;
    const failedSaveResult = {
      cancelled: false,
      saved: false,
      sessionId,
      uiRevision: 1,
      error: { code: "SAVE_FAILED", message: "synthetic save failure" },
    } satisfies PairedV2SaveResponse;
    return (
      <section data-testid="paired-v2-authoring-panel">
        {authoringReady ? <span data-testid="paired-v2-authoring-ready">Ready to edit</span> : null}
        <span data-testid="paired-v2-session">{props.input.capability.sessionId}</span>
        <span data-testid="paired-v2-input-mode">{detached ? "detached" : "custody"}</span>
        {props.sessionUnavailableReason ? <span data-testid="paired-v2-session-unavailable">{props.sessionUnavailableReason}</span> : null}
        <button type="button" disabled={props.sessionUnavailableReason !== null && props.sessionUnavailableReason !== undefined} onClick={() => props.onEdited?.(editedSnapshot)}>Simulate v2 edit</button>
        <button type="button" disabled={props.sessionUnavailableReason !== null && props.sessionUnavailableReason !== undefined} onClick={() => {
          const outcome = props.onAdopt?.(candidate);
          if (outcome && !outcome.ok) setAdoptionMessage(outcome.message ?? "Candidate refused.");
        }}>Simulate v2 adoption</button>
        <button type="button" disabled={props.sessionUnavailableReason !== null && props.sessionUnavailableReason !== undefined} onClick={() => {
          const outcome = props.onAdopt?.(mismatchedCandidate);
          if (outcome && !outcome.ok) setAdoptionMessage(outcome.message ?? "Candidate refused.");
        }}>Simulate v2 mismatched adoption</button>
        <button type="button" disabled={props.sessionUnavailableReason !== null && props.sessionUnavailableReason !== undefined} onClick={() => props.onSaved?.(failedSaveResult)}>Simulate v2 failed save</button>
        <button type="button" disabled={props.sessionUnavailableReason !== null && props.sessionUnavailableReason !== undefined} onClick={() => {
          props.onWorkflowState?.(settledSaveState);
          props.onSaved?.(saveResult);
        }}>Simulate v2 save</button>
        <button type="button" onClick={() => props.onReopen?.()}>Simulate v2 reopen</button>
        <button type="button" onClick={() => props.onWorkflowState?.(pendingSaveState)}>Simulate pending save</button>
        <button type="button" onClick={() => props.onWorkflowState?.(settledSaveState)}>Simulate pending save settled</button>
        {adoptionMessage ? <span data-testid="paired-v2-adoption-message">{adoptionMessage}</span> : null}
      </section>
    );
  },
}));

function eligibleV2Document(): AppThemeOpenedDocument {
  return {
    documentId: "developer-document",
    displayName: "developer.profile.json",
    schemaVersion: "tf-paired-profile-v2",
    aliasResolved: false,
    verificationStatus: "verified",
    isTransformed: false,
    semantic: "validated",
    rawSourceSha256: RAW_SOURCE,
    canonicalDigest: CANONICAL_DIGEST,
    editable: false,
    v2AuthoringEligible: true,
    ownerBinding: {
      inputOrigin: "source-bytes",
      rawSourceSha256: RAW_SOURCE,
      verificationStatus: "verified",
      isTransformed: false,
      byteLength: 512,
      canonicalDigest: CANONICAL_DIGEST,
    },
    v2Profile: {
      schemaVersion: "tf-paired-profile-v2",
      name: "Developer v2",
      version: "2.0.0",
      color: {
        light: {
          canvas: "#ffffff",
          canvasText: "#111111",
          surface: "#f8f8f8",
          surfaceText: "#111111",
          elevatedSurface: "#ffffff",
          elevatedSurfaceText: "#111111",
          primaryAction: "#123456",
          primaryActionText: "#ffffff",
          secondaryAction: "#e5e7eb",
          secondaryActionText: "#111111",
          mutedSurface: "#f3f4f6",
          mutedText: "#4b5563",
          highlight: "#dbeafe",
          highlightText: "#1e3a8a",
          danger: "#fee2e2",
          dangerText: "#991b1b",
          border: "#d1d5db",
          fieldBorder: "#9ca3af",
          focus: "#2563eb",
        },
        dark: {
          canvas: "#111827",
          canvasText: "#f9fafb",
          surface: "#1f2937",
          surfaceText: "#f9fafb",
          elevatedSurface: "#374151",
          elevatedSurfaceText: "#f9fafb",
          primaryAction: "#123456",
          primaryActionText: "#ffffff",
          secondaryAction: "#374151",
          secondaryActionText: "#f9fafb",
          mutedSurface: "#1f2937",
          mutedText: "#d1d5db",
          highlight: "#1e3a8a",
          highlightText: "#dbeafe",
          danger: "#7f1d1d",
          dangerText: "#fee2e2",
          border: "#4b5563",
          fieldBorder: "#6b7280",
          focus: "#60a5fa",
        },
      },
      typography: { ui: { family: "Inter" } },
      radius: { surface: "8px" },
    },
  };
}

function makeV2Bridge(): PairedV2NativeBridge {
  return {
    compileV2: vi.fn(async () => { throw new Error("unused by the Lab wiring stub"); }),
    saveV2: vi.fn(async () => { throw new Error("unused by the Lab wiring stub"); }),
  };
}

function capabilityBridge(initialSessionId = SESSION_ID, resetSessionId = initialSessionId): MockAppThemeBridge {
  const bridge = new MockAppThemeBridge();
  const getStatus = bridge.getStatus.bind(bridge);
  const reset = bridge.reset.bind(bridge);
  let currentSessionId = initialSessionId;
  bridge.getStatus = async () => ({
    ...(await getStatus()),
    pairedV2Authoring: { supported: true, sessionId: currentSessionId },
  });
  bridge.reset = vi.fn(async () => {
    currentSessionId = resetSessionId;
    return {
      ...(await reset()),
      pairedV2Authoring: { supported: true, sessionId: currentSessionId },
    };
  });
  return bridge;
}

const PACKET_CANDIDATE: PairedV2NativePacketEnvelope = {
  kind: "tf-paired-profile-v2-candidate",
  canonicalJson: "{\"schema\":\"tf-paired-profile-v2-candidate\"}",
  digest: "d".repeat(64),
  packetDigestVerified: true,
  packet: {
    schema: "tf-paired-profile-v2-candidate",
    schemaVersion: 1,
    candidateId: "candidate-1",
    briefDigest: "e".repeat(64),
    sourceBytesBase64: "eA==",
    sourceProfileSha256: "c".repeat(64),
    sourceCanonicalDigest: "b".repeat(64),
    rationale: "Use the reviewed source bytes.",
    candidateDigest: "f".repeat(64),
  },
};

function makePacketBridge(candidate = PACKET_CANDIDATE): PairedV2PacketBridge {
  return {
    createPacket: vi.fn(async () => candidate),
    importPacket: vi.fn(async (kind) => kind === "tf-paired-profile-v2-candidate"
      ? { cancelled: false, envelope: candidate }
      : { cancelled: true }),
    exportPacket: vi.fn(async (envelope) => ({ cancelled: false, saved: true, digest: envelope.digest })),
  };
}

afterEach(() => cleanup());

describe("ApplicationThemeLab paired v2 integration boundary", () => {
  it("does not acquire a hidden native bridge for an injected v1 bridge", async () => {
    const bridge = capabilityBridge();
    bridge.openProfile = vi.fn(async () => ({ cancelled: false, document: eligibleV2Document() }));
    render(<ApplicationThemeLab bridge={bridge} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Profile…" }));
    await waitFor(() => expect(screen.getByText(/verified read-only custody/)).toBeTruthy());
    expect(screen.queryByTestId("paired-v2-authoring-panel")).toBeNull();
    expect((screen.getByRole("button", { name: "Open Profile…" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Save Original" }) as HTMLButtonElement).disabled).toBe(false);
    expect(vi.mocked(tauriInvoke)).not.toHaveBeenCalled();
  });

  it("retires current identity and prevents source actions after a confirmed custody save", async () => {
    const bridge = capabilityBridge();
    bridge.openProfile = vi.fn(async () => ({ cancelled: false, document: eligibleV2Document() }));
    render(<ApplicationThemeLab bridge={bridge} pairedV2Bridge={makeV2Bridge()} pairedV2PacketBridge={makePacketBridge()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Profile…" }));
    await screen.findByRole("heading", { name: "Brief, compare, and review" });
    await waitFor(() => expect(screen.getByText("Current verified identity supplied by the parent session")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Create brief" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Simulate v2 save" }));
    await waitFor(() => expect(screen.getByText("Last verified identity (not current)")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Create brief" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("pauses v2 source actions and identity while reopen or reset is pending", async () => {
    const bridge = capabilityBridge();
    const openedDocument = eligibleV2Document();
    let openCount = 0;
    let releaseOpen!: (response: Awaited<ReturnType<MockAppThemeBridge["openProfile"]>>) => void;
    bridge.openProfile = vi.fn(async () => {
      openCount += 1;
      if (openCount === 1) return { cancelled: false, document: openedDocument };
      return await new Promise<Awaited<ReturnType<MockAppThemeBridge["openProfile"]>>>((resolve) => {
        releaseOpen = resolve;
      });
    });
    render(<ApplicationThemeLab bridge={bridge} pairedV2Bridge={makeV2Bridge()} pairedV2PacketBridge={makePacketBridge()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Profile…" }));
    await screen.findByTestId("paired-v2-authoring-panel");
    await waitFor(() => expect(screen.getByText("Current verified identity supplied by the parent session")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Simulate v2 reopen" }));
    await waitFor(() => expect(screen.getByTestId("paired-v2-session-unavailable").textContent).toContain("source is changing"));
    expect((screen.getByRole("button", { name: "Simulate v2 save" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Create brief" }) as HTMLButtonElement).disabled).toBe(true);
    releaseOpen({ cancelled: true });
    await waitFor(() => expect(screen.getByText(/Open profile cancelled/)).toBeTruthy());

    cleanup();
    const resetBridge = capabilityBridge();
    resetBridge.openProfile = vi.fn(async () => ({ cancelled: false, document: openedDocument }));
    const originalReset = resetBridge.reset.bind(resetBridge);
    let releaseReset!: () => void;
    resetBridge.reset = vi.fn(async () => {
      await new Promise<void>((resolve) => { releaseReset = resolve; });
      return await originalReset();
    });
    render(<ApplicationThemeLab bridge={resetBridge} pairedV2Bridge={makeV2Bridge()} pairedV2PacketBridge={makePacketBridge()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Profile…" }));
    await screen.findByTestId("paired-v2-authoring-panel");
    await waitFor(() => expect(screen.getByText("Current verified identity supplied by the parent session")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Reset editor profile" }));
    await waitFor(() => expect(screen.getByTestId("paired-v2-session-unavailable").textContent).toContain("source is changing"));
    expect((screen.getByRole("button", { name: "Simulate v2 save" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Create brief" }) as HTMLButtonElement).disabled).toBe(true);
    releaseReset();
    await screen.findByText("Built-in Profile");
  });

  it("refreshes status after a cancelled reopen and invalidates only current v2 authority", async () => {
    const bridge = capabilityBridge();
    const openedDocument = eligibleV2Document();
    let openCount = 0;
    bridge.openProfile = vi.fn(async () => {
      openCount += 1;
      return openCount === 1 ? { cancelled: false, document: openedDocument } : { cancelled: true };
    });
    const getStatus = bridge.getStatus;
    let statusCalls = 0;
    bridge.getStatus = vi.fn(async () => {
      statusCalls += 1;
      return getStatus();
    });
    render(<ApplicationThemeLab bridge={bridge} pairedV2Bridge={makeV2Bridge()} pairedV2PacketBridge={makePacketBridge()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Profile…" }));
    await screen.findByTestId("paired-v2-authoring-panel");
    await waitFor(() => expect(screen.getByText("Current verified identity supplied by the parent session")).toBeTruthy());
    const callsBeforeCancelledReopen = statusCalls;
    fireEvent.click(screen.getByRole("button", { name: "Simulate v2 reopen" }));
    await waitFor(() => expect(bridge.openProfile).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("paired-v2-session-unavailable")).toBeTruthy());
    expect(statusCalls).toBeGreaterThan(callsBeforeCancelledReopen);
    expect(screen.getByText("Last verified identity (not current)")).toBeTruthy();
    expect(screen.getByTestId("paired-v2-input-mode").textContent).toBe("custody");
  });

  it("wires an explicit v2 bridge through edit, full-appearance adoption, save, and reopen", async () => {
    const bridge = capabilityBridge();
    const openedDocument = eligibleV2Document();
    const openProfile = vi.fn(async () => ({ cancelled: false, document: openedDocument }));
    bridge.openProfile = openProfile;
    const pairedV2Bridge = makeV2Bridge();
    render(<ApplicationThemeLab bridge={bridge} pairedV2Bridge={pairedV2Bridge} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Profile…" }));
    const panel = await screen.findByTestId("paired-v2-authoring-panel");
    await screen.findByTestId("paired-v2-authoring-ready");
    expect(screen.getByTestId("paired-v2-session").textContent).toBe(SESSION_ID);

    fireEvent.click(screen.getByRole("button", { name: "Simulate v2 edit" }));
    expect(screen.getByText("Unsaved Changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Simulate v2 failed save" }));
    expect(screen.getByText("Unsaved Changes")).toBeTruthy();

    const baselineStyles = [...globalThis.document.head.querySelectorAll("style")];
    fireEvent.click(screen.getByRole("button", { name: "Simulate v2 adoption" }));
    expect(screen.getByText(/Adopted paired v2 application appearance/)).toBeTruthy();
    expect([...globalThis.document.head.querySelectorAll("style")]).toHaveLength(baselineStyles.length + 1);
    expect([...globalThis.document.head.querySelectorAll("style")].some((style) => style.textContent?.includes(FULL_APPLICATION_CSS))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Simulate v2 save" }));
    expect(screen.queryByText("Unsaved Changes")).toBeNull();
    expect(screen.getByText("Adopted Draft")).toBeTruthy();

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Simulate v2 reopen" }));
    await waitFor(() => expect(openProfile).toHaveBeenCalledTimes(2));
    expect(panel).toBeTruthy();
    confirm.mockRestore();
  });

  it("requires dirty-session confirmation before candidate reset and preserves mismatch refusal", async () => {
    const bridge = capabilityBridge();
    bridge.openProfile = vi.fn(async () => ({ cancelled: false, document: eligibleV2Document() }));
    const packetBridge = makePacketBridge();
    render(<ApplicationThemeLab bridge={bridge} pairedV2Bridge={makeV2Bridge()} pairedV2PacketBridge={packetBridge} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Profile…" }));
    await screen.findByRole("heading", { name: "Brief, compare, and review" });
    fireEvent.click(screen.getByRole("button", { name: "Simulate v2 edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Import candidate" }));
    await screen.findByText(/Candidate imported for inspection/);

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Select candidate" }));
    await waitFor(() => expect(screen.getByText(/selection cancelled/)).toBeTruthy());
    expect(bridge.reset).not.toHaveBeenCalled();
    expect(screen.getByTestId("paired-v2-input-mode").textContent).toBe("custody");

    fireEvent.click(screen.getByRole("button", { name: "Simulate v2 mismatched adoption" }));
    expect(screen.getByTestId("paired-v2-adoption-message").textContent).toMatch(/no longer current/);
    confirm.mockRestore();
  });

  it("blocks selection during a pending save and retains packet feedback across fresh detached selection", async () => {
    const bridge = capabilityBridge(SESSION_ID, "paired-v2-fresh-session");
    bridge.openProfile = vi.fn(async () => ({ cancelled: false, document: eligibleV2Document() }));
    const packetBridge = makePacketBridge();
    render(<ApplicationThemeLab bridge={bridge} pairedV2Bridge={makeV2Bridge()} pairedV2PacketBridge={packetBridge} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Profile…" }));
    await screen.findByRole("heading", { name: "Brief, compare, and review" });
    fireEvent.click(screen.getByRole("button", { name: "Import candidate" }));
    await screen.findByText(/Candidate imported for inspection/);
    const comment = screen.getByLabelText("Comment") as HTMLTextAreaElement;
    fireEvent.change(comment, { target: { value: "retain this review context" } });

    fireEvent.click(screen.getByRole("button", { name: "Simulate pending save" }));
    expect((screen.getByRole("button", { name: "Select candidate" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Open Profile…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reset editor profile" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save Original" }) as HTMLButtonElement).disabled).toBe(true);
    expect(bridge.reset).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Simulate v2 edit" }));
    // Pending-save remains the authoritative disable reason; selection cannot reset a live save.
    expect((screen.getByRole("button", { name: "Select candidate" }) as HTMLButtonElement).disabled).toBe(true);
    expect(comment.value).toBe("retain this review context");

    // A confirmed save clears the busy gate; reopen then uses a fresh detached capability.
    fireEvent.click(screen.getByRole("button", { name: "Simulate pending save settled" }));
    fireEvent.click(screen.getByRole("button", { name: "Simulate v2 reopen" }));
    await waitFor(() => expect(bridge.openProfile).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Select candidate" }));
    await waitFor(() => expect(screen.getByTestId("paired-v2-input-mode").textContent).toBe("detached"));
    expect(bridge.reset).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("paired-v2-session").textContent).toBe("paired-v2-fresh-session");
    expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("retain this review context");
    expect(screen.getByText(/Candidate selected\. Verifying its exact source bytes/)).toBeTruthy();
  });

  it("rejects a late open reply after a newer reset generation wins", async () => {
    const bridge = capabilityBridge();
    let resolveOpen!: (response: Awaited<ReturnType<MockAppThemeBridge["openProfile"]>>) => void;
    const deferredOpen = new Promise<Awaited<ReturnType<MockAppThemeBridge["openProfile"]>>>((resolve) => {
      resolveOpen = resolve;
    });
    bridge.openProfile = vi.fn(async () => deferredOpen);
    render(<ApplicationThemeLab bridge={bridge} pairedV2Bridge={makeV2Bridge()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Profile…" }));
    await waitFor(() => expect(bridge.openProfile).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Reset editor profile" }));
    await waitFor(() => expect(bridge.reset).toHaveBeenCalledTimes(1));

    resolveOpen({ cancelled: false, document: eligibleV2Document() });
    await Promise.resolve();
    expect(screen.queryByText("developer.profile.json")).toBeNull();
    expect(screen.getByText("Built-in Profile")).toBeTruthy();
  });
});

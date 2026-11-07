import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  PairedV2CompileResponse,
  PairedV2MappingReport,
  PairedV2SaveResponse,
  PairedV2SuccessfulCompileResponse,
} from "../paired-v2-authoring-types";
import {
  PairedV2AuthoringPanel,
  type PairedV2AuthoringPanelProps,
} from "../PairedV2AuthoringPanel";
import type {
  PairedV2ApplicationAppearanceCandidate,
  PairedV2DetachedOpenInput,
  PairedV2NativeBridge,
  PairedV2OpenInput,
} from "../paired-v2-ui-adapter";
import type { PreviewApplicationState } from "../preview-application-state";
import type { PairedProfileV2Document } from "../types";

type MockPreviewProps = {
  readonly css?: string;
  readonly revision: number;
  readonly mode: "dark" | "light";
  readonly requireCorrelatedAck?: boolean;
  readonly onPreviewState?: (state: PreviewApplicationState) => void;
};

function MockPreview({
  kind,
  css,
  revision,
  mode,
  requireCorrelatedAck,
  onPreviewState,
}: MockPreviewProps & { readonly kind: "application" | "starlight" }) {
  const [generation, setGeneration] = useState(0);
  const [previousFrameId, setPreviousFrameId] = useState<string | undefined>(undefined);
  const frameId = `${kind}-frame-${revision}-${generation}`;
  const emit = (state: PreviewApplicationState["state"], nextFrameId = frameId) => {
    onPreviewState?.({ state, revision, mode, frameId: nextFrameId });
  };
  return (
    <section data-testid={`${kind}-preview`} data-css={css} data-require-correlated={String(requireCorrelatedAck ?? false)}>
      <button type="button" onClick={() => emit("pending")}>Pending {kind}</button>
      <button type="button" onClick={() => emit("applied")}>Acknowledge {kind}</button>
      <button type="button" onClick={() => {
        const nextGeneration = generation + 1;
        setPreviousFrameId(frameId);
        setGeneration(nextGeneration);
        emit("pending", `${kind}-frame-${revision}-${nextGeneration}`);
      }}>Reload {kind}</button>
      <button type="button" disabled={previousFrameId === undefined} onClick={() => {
        if (previousFrameId !== undefined) emit("applied", previousFrameId);
      }}>Stale acknowledge {kind}</button>
      <button type="button" onClick={() => emit("failed")}>Fail {kind}</button>
    </section>
  );
}

vi.mock("../ApplicationPreview", () => ({
  ApplicationPreview: (props: MockPreviewProps) => <MockPreview kind="application" {...props} />,
}));

vi.mock("../../theme-lab/StarlightPreview", () => ({
  StarlightPreview: (props: MockPreviewProps) => <MockPreview kind="starlight" {...props} />,
}));

const SESSION = "paired-v2-panel-session";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const SOURCE = "eA==";
const FULL_APPLICATION_CSS = ":root { --native-application-palette: #123456; }";
const EXTENSION_ONLY_CSS = ":root { --extension-only: #123456; }";

const PROFILE = {
  schemaVersion: "tf-paired-profile-v2",
  name: "developer",
  version: "0.1.0",
  color: {
    light: { primaryAction: "#abcdef" },
    dark: { primaryAction: "#123456" },
  },
  typography: { ui: { family: "system-ui" } },
  radius: { surface: "8px" },
} as PairedProfileV2Document;

function openInput(
  sessionId = SESSION,
  documentId = "developer-document",
  profile: PairedProfileV2Document = PROFILE,
): PairedV2OpenInput {
  return {
    capability: { supported: true, sessionId },
    document: {
      documentId,
      displayName: "developer.profile.json",
      schemaVersion: "tf-paired-profile-v2",
      v2AuthoringEligible: true,
      editable: false,
      verificationStatus: "verified",
      isTransformed: false,
      semantic: "validated",
      rawSourceSha256: HASH_A,
      canonicalDigest: HASH_B,
      ownerBinding: {
        inputOrigin: "source-bytes",
        rawSourceSha256: HASH_A,
        verificationStatus: "verified",
        isTransformed: false,
        byteLength: 4734,
        canonicalDigest: HASH_B,
      },
    },
    v2Profile: profile,
  };
}

const CUSTOM_SOURCE_PROFILE = {
  ...PROFILE,
  typography: { ui: { family: "Inter" } },
} as PairedProfileV2Document;

const SPARSE_SOURCE_PROFILE = {
  ...PROFILE,
  typography: undefined,
  radius: undefined,
} as unknown as PairedProfileV2Document;

function detachedInput(sessionId = SESSION): PairedV2DetachedOpenInput {
  return {
    mode: "detached",
    capability: { supported: true, sessionId },
    sourceBytesBase64: SOURCE,
    expectedRawSourceSha256: HASH_A,
    expectedCanonicalDigest: HASH_B,
  };
}

function mappingReport(target: "solar-sail" | "stellar-loom"): PairedV2MappingReport {
  return {
    schema: "tf-paired-mapping-report-v2",
    target,
    profileName: "developer",
    profileVersion: "0.1.0",
    sourceSha256: HASH_B,
    sourceVerification: "source-bytes",
    canonicalDigest: HASH_C,
    adapter: { name: "paired-v2", version: "0.2.0" },
    compiler: { name: target, version: "0.3.0" },
    options: {},
    entries: [{ sourcePath: "color.dark.primaryAction", classification: "consumed", reason: "Mapped by adapter" }],
    groups: [{ group: "color", applicable: true, reason: "Supported subset" }],
    defaults: [],
    summary: {
      totalSemanticLeaves: 1,
      consumed: 1,
      normalized: 0,
      overridden: 0,
      targetSpecific: 1,
      unsupported: 1,
      generatedDefaultsCount: 0,
    },
    digest: HASH_A,
  };
}

function compileReply(sessionId = SESSION, uiRevision = 1): PairedV2CompileResponse {
  return {
    status: "partial",
    valid: true,
    uiRevision,
    sessionId,
    draft: {
      profile: PROFILE,
      sourceBytesBase64: SOURCE,
      rawSourceSha256: HASH_B,
      canonicalDigest: HASH_C,
      baselineRawSourceSha256: HASH_A,
      baselineCanonicalDigest: HASH_B,
      verificationStatus: "transformed",
      isTransformed: true,
      parentSourceSha256: HASH_A,
    },
    solarSail: {
      valid: true,
      compiledCss: ":root { --solar: #123456; }",
      diagnostics: [],
      mappingReport: mappingReport("solar-sail"),
      sourceProfileSha256: HASH_B,
      canonicalDigest: HASH_C,
    },
    stellarLoom: {
      valid: true,
      compiledCss: ":root { --loom: #123456; }",
      diagnostics: [],
      mappingReport: mappingReport("stellar-loom"),
      sourceProfileSha256: HASH_B,
      canonicalDigest: HASH_C,
    },
    applicationExtension: {
      valid: true,
      compiledCss: EXTENSION_ONLY_CSS,
      diagnostics: [],
      mappingReport: {
        schema: "theme-forge.application-appearance-extension.v1",
        entries: [{ sourcePath: "radius.surface", target: "--tf-radius-surface", value: "8px" }],
        scope: "Supplementary application-only roles",
      },
      sourceProfileSha256: HASH_B,
      canonicalDigest: HASH_C,
    },
    applicationAppearance: {
      valid: true,
      compiledCss: FULL_APPLICATION_CSS,
      sourceProfileSha256: HASH_B,
      canonicalDigest: HASH_C,
    },
    diagnostics: [],
  };
}

function verifiedDetachedReply(sessionId = SESSION): PairedV2CompileResponse {
  const base = compileReply(sessionId, 0) as PairedV2SuccessfulCompileResponse;
  const { parentSourceSha256: _parentSourceSha256, ...baseDraft } = base.draft;
  return {
    ...base,
    status: "success",
    draft: {
      ...baseDraft,
      sourceBytesBase64: SOURCE,
      rawSourceSha256: HASH_A,
      canonicalDigest: HASH_B,
      baselineRawSourceSha256: HASH_A,
      baselineCanonicalDigest: HASH_B,
      verificationStatus: "verified",
      isTransformed: false,
    },
    solarSail: {
      ...base.solarSail,
      sourceProfileSha256: HASH_A,
      canonicalDigest: HASH_B,
      mappingReport: { ...base.solarSail.mappingReport, sourceSha256: HASH_A, canonicalDigest: HASH_B },
    },
    stellarLoom: {
      ...base.stellarLoom,
      sourceProfileSha256: HASH_A,
      canonicalDigest: HASH_B,
      mappingReport: { ...base.stellarLoom.mappingReport, sourceSha256: HASH_A, canonicalDigest: HASH_B },
    },
    applicationExtension: {
      ...base.applicationExtension,
      sourceProfileSha256: HASH_A,
      canonicalDigest: HASH_B,
    },
    applicationAppearance: {
      ...base.applicationAppearance,
      sourceProfileSha256: HASH_A,
      canonicalDigest: HASH_B,
    },
  };
}

function savedReply(sessionId = SESSION, uiRevision = 1, documentId = "developer-document"): PairedV2SaveResponse {
  return {
    cancelled: false,
    saved: true,
    sessionId,
    uiRevision,
    document: {
      documentId,
      rawSourceSha256: HASH_B,
      canonicalDigest: HASH_C,
      displayName: "developer.edited.profile.json",
    },
  };
}

function makeBridge() {
  const compileV2 = vi.fn(async (request: Parameters<PairedV2NativeBridge["compileV2"]>[0]) => compileReply(request.sessionId, request.uiRevision));
  const saveV2 = vi.fn(async (request: Parameters<PairedV2NativeBridge["saveV2"]>[0]) => savedReply(request.sessionId, request.uiRevision, request.documentId));
  return { bridge: { compileV2, saveV2 } as PairedV2NativeBridge, compileV2, saveV2 };
}

function renderPanel(
  bridge: PairedV2NativeBridge,
  overrides: Partial<PairedV2AuthoringPanelProps> = {},
) {
  return render(
    <PairedV2AuthoringPanel
      input={openInput()}
      bridge={bridge}
      onAdopt={() => ({ ok: true, message: "Applied to the application draft." })}
      {...overrides}
    />
  );
}

afterEach(() => cleanup());

describe("PairedV2AuthoringPanel", () => {
  it("keeps unsupported sources honest and does not fall back to the v1 editor", async () => {
    const { bridge, compileV2 } = makeBridge();
    renderPanel(bridge, { input: { ...openInput(), capability: { supported: false, sessionId: SESSION } } });

    expect(await screen.findByText("Editing is unavailable for this source.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Compile" })).toBeNull();
    expect(compileV2).not.toHaveBeenCalled();
  });

  it("recreates its adapter across StrictMode cleanup and remount", async () => {
    const { bridge, compileV2 } = makeBridge();
    render(
      <StrictMode>
        <PairedV2AuthoringPanel
          input={openInput()}
          bridge={bridge}
          onAdopt={() => ({ ok: true })}
        />
      </StrictMode>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Compile" }));
    expect(await screen.findByText("Review the compiled result")).toBeTruthy();
    expect(compileV2).toHaveBeenCalledTimes(1);
  });

  it("validates only edited fields when the source owns a custom interface family", async () => {
    const { bridge, compileV2 } = makeBridge();
    renderPanel(bridge, { input: openInput(SESSION, "custom-document", CUSTOM_SOURCE_PROFILE) });

    const color = await screen.findByRole("textbox", { name: "Primary action color" });
    fireEvent.change(color, { target: { value: "#654321" } });
    expect((screen.getByRole("button", { name: "Compile" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Compile" }));
    expect(await screen.findByText("Review the compiled result")).toBeTruthy();
    expect(compileV2).toHaveBeenCalledTimes(1);
  });

  it("keeps absent optional typography and radius fields native-owned", async () => {
    const { bridge, compileV2 } = makeBridge();
    renderPanel(bridge, { input: openInput(SESSION, "sparse-document", SPARSE_SOURCE_PROFILE) });

    const color = await screen.findByRole("textbox", { name: "Primary action color" });
    fireEvent.change(color, { target: { value: "#654321" } });
    expect((screen.getByRole("button", { name: "Compile" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Compile" }));
    expect(await screen.findByText("Review the compiled result")).toBeTruthy();
    expect(compileV2).toHaveBeenCalledTimes(1);
  });

  it("uses local buffers for empty-in-progress edits and reports an edited snapshot", async () => {
    const { bridge } = makeBridge();
    const onEdited = vi.fn();
    renderPanel(bridge, { onEdited });

    const color = await screen.findByRole("textbox", { name: "Primary action color" });
    fireEvent.change(color, { target: { value: "" } });
    expect((screen.getByRole("button", { name: "Compile" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(color, { target: { value: "#654321" } });
    expect(onEdited).toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Compile" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("blocks application-extension values outside the closed transport slice", async () => {
    const { bridge, compileV2 } = makeBridge();
    renderPanel(bridge);

    const family = await screen.findByRole("textbox", { name: "Interface font family" });
    fireEvent.change(family, { target: { value: "Inter" } });
    expect(screen.getAllByText(/Use system-ui, monospace, sans-serif, or serif/i)).toHaveLength(2);
    expect((screen.getByRole("button", { name: "Compile" }) as HTMLButtonElement).disabled).toBe(true);
    expect(compileV2).not.toHaveBeenCalled();

    fireEvent.change(family, { target: { value: "monospace" } });
    const radius = screen.getByRole("textbox", { name: "Surface radius" });
    fireEvent.change(radius, { target: { value: "8" } });
    expect(screen.getAllByText(/Use a surface radius with px, rem, or em units/i)).toHaveLength(2);
    expect((screen.getByRole("button", { name: "Compile" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("invalidates a compiled candidate when the focused color leaves the closed grammar", async () => {
    const { bridge } = makeBridge();
    const workflowStates: Array<{
      readonly acceptedCompile?: { readonly uiRevision: number };
      readonly snapshot: {
        readonly canAdoptPaired: boolean;
        readonly authoring?: { readonly revision: number };
      };
    }> = [];
    renderPanel(bridge, { onWorkflowState: (state) => workflowStates.push(state) });

    fireEvent.click(await screen.findByRole("button", { name: "Compile" }));
    expect(await screen.findByText("Review the compiled result")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pending application" }));
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge application" }));
    fireEvent.click(screen.getByRole("button", { name: "Pending starlight" }));
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge starlight" }));
    expect((screen.getByRole("button", { name: "Apply to application" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(screen.getByRole("textbox", { name: "Primary action color" }), {
      target: { value: "#123456789" },
    });

    expect(screen.getAllByText(/bounded color value/i)).toHaveLength(2);
    await waitFor(() => {
      expect(screen.queryByText("Review the compiled result")).toBeNull();
      expect((screen.getByRole("button", { name: "Compile" }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "Save profile" }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "Save as…" }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "Apply to application" }) as HTMLButtonElement).disabled).toBe(true);
    });
    const latestWorkflow = workflowStates.at(-1);
    expect(latestWorkflow?.snapshot.canAdoptPaired).toBe(false);
    expect(
      latestWorkflow?.acceptedCompile === undefined ||
      latestWorkflow.snapshot.authoring?.revision !== latestWorkflow.acceptedCompile.uiRevision,
    ).toBe(true);
  });

  it("renders both previews, requires current strong ACKs, and adopts full application CSS", async () => {
    const { bridge } = makeBridge();
    const onAdopt = vi.fn((candidate: PairedV2ApplicationAppearanceCandidate) => {
      expect(candidate.compiledCss).toBe(FULL_APPLICATION_CSS);
      return { ok: true, message: "Applied current draft." };
    });
    renderPanel(bridge, { onAdopt });

    fireEvent.click(await screen.findByRole("button", { name: "Compile" }));
    expect(await screen.findByText("Review the compiled result")).toBeTruthy();
    expect(screen.getByTestId("application-preview").getAttribute("data-css")).toBe(":root { --solar: #123456; }");
    expect(screen.getByTestId("starlight-preview").getAttribute("data-css")).toBe(":root { --loom: #123456; }");
    expect(screen.getByTestId("starlight-preview").getAttribute("data-require-correlated")).toBe("true");
    expect((screen.getByRole("button", { name: "Apply to application" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Pending application" }));
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge application" }));
    fireEvent.click(screen.getByRole("button", { name: "Pending starlight" }));
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge starlight" }));
    expect((screen.getByRole("button", { name: "Apply to application" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Fail application" }));
    expect((screen.getByRole("button", { name: "Apply to application" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Pending application" }));
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge application" }));
    expect((screen.getByRole("button", { name: "Apply to application" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Apply to application" }));
    expect(onAdopt).toHaveBeenCalledWith(expect.objectContaining({ compiledCss: FULL_APPLICATION_CSS }));
    expect(onAdopt.mock.calls[0]?.[0].compiledCss).not.toBe(EXTENSION_ONLY_CSS);
    expect(screen.getAllByText("Unsupported")).toHaveLength(2);
    expect(screen.getByText(/application-only roles are reported separately/i)).toBeTruthy();
    expect(screen.getByText(/Starlight retains the template code frame, copy, and syntax presentation/i)).toBeTruthy();
  });

  it("invalidates adoption after reload and freezes the source after a confirmed save", async () => {
    const { bridge, saveV2 } = makeBridge();
    const onSaved = vi.fn();
    const onReopen = vi.fn();
    renderPanel(bridge, { onSaved, onReopen });

    fireEvent.click(await screen.findByRole("button", { name: "Compile" }));
    expect(await screen.findByText("Review the compiled result")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pending application" }));
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge application" }));
    fireEvent.click(screen.getByRole("button", { name: "Pending starlight" }));
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge starlight" }));
    expect((screen.getByRole("button", { name: "Apply to application" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Reload application" }));
    expect((screen.getByRole("button", { name: "Apply to application" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Stale acknowledge application" }));
    expect((screen.getByRole("button", { name: "Apply to application" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge application" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload starlight" }));
    expect((screen.getByRole("button", { name: "Apply to application" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(saveV2).toHaveBeenCalledWith(expect.objectContaining({ saveMode: "edited" })));
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ saved: true }));
    expect(screen.getByText(/Reopen the saved profile to continue editing/i)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Primary action color" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Compile" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Apply to application" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(onReopen).toHaveBeenCalledTimes(1);
  });

  it("keeps Reopen disabled until a pending native save settles", async () => {
    const { bridge } = makeBridge();
    let resolveSave!: (response: PairedV2SaveResponse) => void;
    const saveV2 = vi.fn(() => new Promise<PairedV2SaveResponse>((resolve) => { resolveSave = resolve; }));
    const onReopen = vi.fn();
    renderPanel({ ...bridge, saveV2 }, { onReopen });

    fireEvent.click(await screen.findByRole("button", { name: "Compile" }));
    await screen.findByText("Review the compiled result");
    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
    await waitFor(() => expect(saveV2).toHaveBeenCalled());
    expect((screen.getByRole("button", { name: "Reopen" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(onReopen).not.toHaveBeenCalled();

    resolveSave({
      cancelled: false,
      saved: true,
      sessionId: SESSION,
      uiRevision: 0,
      document: {
        documentId: "pending-saved-document",
        rawSourceSha256: HASH_B,
        canonicalDigest: HASH_C,
        displayName: "pending-saved-document.profile.json",
      },
    });
    await screen.findByText(/Reopen the saved profile to continue editing/i);
    expect((screen.getByRole("button", { name: "Reopen" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the verified context readonly when the parent retires the native session", async () => {
    const { bridge } = makeBridge();
    const onReopen = vi.fn();
    const workflowStates: Array<{ readonly acceptedCompile?: unknown }> = [];
    renderPanel(bridge, {
      onReopen,
      sessionUnavailableReason: "Native v2 session was retired; reopen the source to continue.",
      onWorkflowState: (state) => workflowStates.push(state),
    });

    expect(await screen.findByText(/Native v2 session was retired/i)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Primary action color" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Compile" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Apply to application" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save as…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reopen" }) as HTMLButtonElement).disabled).toBe(false);
    expect(workflowStates.every((state) => state.acceptedCompile === undefined)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(onReopen).toHaveBeenCalledTimes(1);
  });

  it("discloses a stale native compile without opening a preview", async () => {
    const staleResponse: PairedV2CompileResponse = {
      status: "stale",
      valid: false,
      uiRevision: 0,
      sessionId: SESSION,
      solarSail: null,
      stellarLoom: null,
      applicationExtension: null,
      applicationAppearance: null,
      diagnostics: [],
    };
    const compileV2 = vi.fn(async () => staleResponse);
    const saveV2 = vi.fn(async (request: Parameters<PairedV2NativeBridge["saveV2"]>[0]) => savedReply(request.sessionId, request.uiRevision, request.documentId));
    renderPanel({ compileV2, saveV2 });

    fireEvent.click(await screen.findByRole("button", { name: "Compile" }));
    expect(await screen.findByText("This compile was superseded by a newer edit.")).toBeTruthy();
    expect(screen.queryByText("Review the compiled result")).toBeNull();
    expect(screen.queryByTestId("application-preview")).toBeNull();
  });

  it("routes Save as through the explicit new-document mode", async () => {
    const { bridge, saveV2 } = makeBridge();
    renderPanel(bridge);

    fireEvent.click(await screen.findByRole("button", { name: "Compile" }));
    await screen.findByText("Review the compiled result");
    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
    await waitFor(() => expect(saveV2).toHaveBeenCalledWith(expect.objectContaining({ saveMode: "new-document" })));
    expect(await screen.findByText(/Reopen the saved profile to continue editing/i)).toBeTruthy();
  });

  it("ignores a late compile reply after unmount", async () => {
    let resolveCompile: ((response: PairedV2CompileResponse) => void) | undefined;
    const compileV2 = vi.fn(() => new Promise<PairedV2CompileResponse>((resolve) => { resolveCompile = resolve; }));
    const saveV2 = vi.fn(async (request: Parameters<PairedV2NativeBridge["saveV2"]>[0]) => savedReply(request.sessionId, request.uiRevision, request.documentId));
    const { unmount } = renderPanel({ compileV2, saveV2 });

    fireEvent.click(await screen.findByRole("button", { name: "Compile" }));
    unmount();
    resolveCompile?.(compileReply());
    await waitFor(() => expect(compileV2).toHaveBeenCalledTimes(1));
  });

  it("verifies a detached candidate without fabricating custody and exposes pending workflow state", async () => {
    const compileV2 = vi.fn()
      .mockResolvedValueOnce(verifiedDetachedReply("detached-session"))
      .mockResolvedValue(compileReply("detached-session", 1));
    let resolveSave!: (response: PairedV2SaveResponse) => void;
    const saveV2 = vi.fn(() => new Promise<PairedV2SaveResponse>((resolve) => { resolveSave = resolve; }));
    const workflowStates: Array<{ readonly snapshot: { readonly pendingCompile: boolean; readonly pendingSave: boolean } }> = [];
    renderPanel({ compileV2, saveV2 }, {
      input: detachedInput("detached-session"),
      onWorkflowState: (state) => workflowStates.push({ snapshot: state.snapshot }),
    });

    expect(await screen.findByText(/Detached source verified/i)).toBeTruthy();
    expect(screen.getByText(/Detached verified bytes/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save profile" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save as…" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
    await waitFor(() => expect(saveV2).toHaveBeenCalledWith(expect.objectContaining({ saveMode: "new-document" })));
    expect(saveV2).toHaveBeenCalledWith(expect.not.objectContaining({ documentId: expect.any(String) }));
    await waitFor(() => expect(workflowStates.some((state) => state.snapshot.pendingSave)).toBe(true));
    resolveSave({
      cancelled: false,
      saved: true,
      sessionId: "detached-session",
      uiRevision: 0,
      document: {
        documentId: "detached-saved-document",
        rawSourceSha256: HASH_A,
        canonicalDigest: HASH_B,
        displayName: "detached-saved-document.profile.json",
      },
    });
    expect(await screen.findByText(/Reopen the saved profile to continue editing/i)).toBeTruthy();
    expect(screen.getByText(/no document custody/i)).toBeTruthy();
  });
});


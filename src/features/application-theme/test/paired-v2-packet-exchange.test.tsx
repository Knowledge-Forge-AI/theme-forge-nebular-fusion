import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PairedV2PacketExchange,
  type PairedV2PacketExchangeProps,
} from "../PairedV2PacketExchange";
import type {
  PairedV2PacketBridge,
} from "../paired-v2-packet-bridge";
import type { PairedV2NativePacketEnvelope } from "../paired-v2-packets";

const BRIEF_KIND = "tf-paired-profile-v2-brief" as const;
const CANDIDATE_KIND = "tf-paired-profile-v2-candidate" as const;
const REVIEW_KIND = "tf-paired-profile-v2-review" as const;
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
type PairedV2PacketKind = PairedV2NativePacketEnvelope["kind"];

const SOURCE = {
  profileName: "developer",
  profileVersion: "0.1.0",
  rawSourceSha256: DIGEST_A,
  canonicalDigest: DIGEST_B,
  editablePaths: ["color.*", "typography.*", "radius.*"],
  allowedModes: ["light", "dark"] as const,
};

const ELIGIBLE = {
  sourceBytesBase64: "eA==",
  sourceProfileSha256: DIGEST_C,
  sourceCanonicalDigest: DIGEST_A,
  verificationStatus: "verified" as const,
  isTransformed: false,
};

type CreateRequest = Parameters<PairedV2PacketBridge["createPacket"]>[0];
type RawCreateRequest = {
  readonly kind: PairedV2PacketKind;
  readonly input: Record<string, unknown>;
};

function digestFor(index: number): string {
  return `${index.toString(16).padStart(2, "0")}${"d".repeat(62)}`;
}

function packetDigestField(kind: PairedV2PacketKind): string {
  if (kind === BRIEF_KIND) return "briefDigest";
  if (kind === CANDIDATE_KIND) return "candidateDigest";
  return "reviewDigest";
}

function makeEnvelope(
  kind: PairedV2PacketKind,
  overrides: Record<string, unknown> = {},
  digest = DIGEST_C,
  packetDigestVerified = true,
): PairedV2NativePacketEnvelope {
  const packet: Record<string, unknown> = {
    schema: kind,
    schemaVersion: 1,
    [packetDigestField(kind)]: digest,
    ...overrides,
  };
  return {
    kind,
    canonicalJson: JSON.stringify(packet),
    digest,
    packetDigestVerified,
    packet,
  } as unknown as PairedV2NativePacketEnvelope;
}

function reviewEnvelope(candidateDigest: string, briefDigest = DIGEST_C): PairedV2NativePacketEnvelope {
  return makeEnvelope(REVIEW_KIND, {
    reviewId: "review-imported",
    briefDigest,
    candidateDigests: [candidateDigest],
    dispositions: [{ candidateDigest, disposition: "revise", comment: "Review this candidate" }],
    overallDisposition: "revise",
    summary: "Imported for inspection",
  }, DIGEST_B);
}

function mismatchedCandidateEnvelope(candidateDigest = DIGEST_C): PairedV2NativePacketEnvelope {
  return makeEnvelope(CANDIDATE_KIND, {
    candidateId: "foreign-candidate",
    briefDigest: DIGEST_A,
    sourceBytesBase64: "eA==",
    sourceProfileSha256: DIGEST_A,
    sourceCanonicalDigest: DIGEST_B,
    rationale: "This candidate deliberately references a different brief.",
  }, candidateDigest);
}

function makeBridge() {
  let sequence = 1;
  const importQueue: PairedV2NativePacketEnvelope[] = [];
  const createPacket = vi.fn(async (request: CreateRequest) => {
    const raw = request as unknown as RawCreateRequest;
    const digest = digestFor(sequence++);
    const input = { ...raw.input, [packetDigestField(raw.kind)]: digest };
    return makeEnvelope(raw.kind, input, digest);
  });
  const importPacket = vi.fn(async (kind: PairedV2PacketKind) => {
    const index = importQueue.findIndex((entry) => entry.kind === kind);
    if (index < 0) return { cancelled: true };
    const [envelope] = importQueue.splice(index, 1);
    if (envelope === undefined) return { cancelled: true };
    return { cancelled: false, envelope };
  });
  const exportPacket = vi.fn(async () => ({ cancelled: false, saved: true, digest: DIGEST_A }));
  const bridge = { createPacket, importPacket, exportPacket } as PairedV2PacketBridge;
  return { bridge, createPacket, importPacket, exportPacket, importQueue };
}

function renderExchange(
  bridge: PairedV2PacketBridge,
  overrides: Partial<PairedV2PacketExchangeProps> = {},
) {
  const onSelectCandidate = vi.fn(async () => ({ accepted: true, message: "Selected by parent" }));
  const result = render(
    <PairedV2PacketExchange
      bridge={bridge}
      sourceIdentity={SOURCE}
      currentSourceIdentity={SOURCE}
      eligibleCurrentCompile={ELIGIBLE}
      onSelectCandidate={onSelectCandidate}
      {...overrides}
    />,
  );
  return { ...result, onSelectCandidate };
}

async function createBrief(bridge: PairedV2PacketBridge) {
  const rendered = renderExchange(bridge);
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Compare appearance" } });
  fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Keep the source boundary clear" } });
  fireEvent.click(screen.getByRole("button", { name: "Create brief" }));
  await waitFor(() => expect(screen.getByText(/Brief created and retained/)).toBeTruthy());
  return rendered;
}

afterEach(() => cleanup());

describe("PairedV2PacketExchange", () => {
  it("creates a native brief from human context and retains canonical bytes for export", async () => {
    const { bridge, createPacket, exportPacket } = makeBridge();
    renderExchange(bridge);
    fireEvent.change(screen.getByLabelText("Brief ID"), { target: { value: "brief-ui" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Compare appearance" } });
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Keep the source boundary clear" } });
    fireEvent.change(screen.getByLabelText(/Acceptance criteria/), { target: { value: "Keep light readable\nKeep dark readable" } });
    fireEvent.change(screen.getByLabelText(/Prohibited changes/), { target: { value: "Do not change ownership" } });
    fireEvent.click(screen.getByRole("button", { name: "Create brief" }));
    await waitFor(() => expect(createPacket).toHaveBeenCalledTimes(1));
    const request = createPacket.mock.calls[0]?.[0] as unknown as RawCreateRequest;
    expect(request.kind).toBe(BRIEF_KIND);
    expect(request.input).toMatchObject({ title: "Compare appearance", goal: "Keep the source boundary clear" });
    expect(screen.getByText(/Retained canonical JSON/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export brief" }));
    await waitFor(() => expect(exportPacket).toHaveBeenCalledWith(expect.objectContaining({ kind: BRIEF_KIND, packetDigestVerified: true })));
  });

  it("keeps cancelled import non-mutating and labels integrity separately from source verification", async () => {
    const { bridge, importPacket } = makeBridge();
    await createBrief(bridge);
    fireEvent.click(screen.getByRole("button", { name: "Import brief" }));
    await waitFor(() => expect(screen.getByText(/Import cancelled/)).toBeTruthy());
    expect(importPacket).toHaveBeenCalledWith(BRIEF_KIND);
    expect(screen.getByText(/source verification is separate/)).toBeTruthy();
    expect(screen.getByText(/Retained canonical JSON/)).toBeTruthy();
  });

  it("labels a retained identity as historical and disables new briefs without a current source", () => {
    const { bridge } = makeBridge();
    renderExchange(bridge, { currentSourceIdentity: null });
    expect(screen.getByRole("heading", { name: "Last verified identity (not current)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create brief" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/no current source identity/)).toBeTruthy();
  });

  it("labels an active brief when its raw and canonical identities differ from the current source", async () => {
    const { bridge, importQueue } = makeBridge();
    importQueue.push(makeEnvelope(BRIEF_KIND, {
      briefId: "historical-brief",
      title: "Historical brief",
      goal: "Compare historical source identity",
      profileName: SOURCE.profileName,
      profileVersion: SOURCE.profileVersion,
      sourceProfileSha256: DIGEST_A,
      sourceCanonicalDigest: DIGEST_B,
      editablePaths: SOURCE.editablePaths,
      allowedModes: SOURCE.allowedModes,
      acceptanceCriteria: [],
      prohibitedChanges: [],
    }, DIGEST_C));
    renderExchange(bridge, {
      currentSourceIdentity: { ...SOURCE, rawSourceSha256: DIGEST_C, canonicalDigest: DIGEST_A },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import brief" }));
    await waitFor(() => expect(screen.getByText(/Active brief source differs from current source: raw and canonical identity mismatch/)).toBeTruthy());
  });

  it("allows at most eight staged candidates and only enables creation from the supplied accepted compile", async () => {
    const { bridge } = makeBridge();
    await createBrief(bridge);
    const createButton = screen.getByRole("button", { name: "Create candidate" });
    for (let index = 0; index < 8; index += 1) {
      fireEvent.change(screen.getByLabelText("Rationale"), { target: { value: `Rationale ${index}` } });
      fireEvent.click(createButton);
      await waitFor(() => expect(screen.getByText(`${index + 1}/8 staged`)).toBeTruthy());
    }
    expect(createButton.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/8\/8 staged/)).toBeTruthy();
    cleanup();
    const secondBridge = makeBridge();
    renderExchange(secondBridge.bridge, { eligibleCurrentCompile: undefined });
    expect(screen.getByRole("button", { name: "Create candidate" }).hasAttribute("disabled")).toBe(true);
  });

  it("retains candidate feedback while an explicit parent selection is pending", async () => {
    const { bridge } = makeBridge();
    await createBrief(bridge);
    fireEvent.change(screen.getByLabelText("Rationale"), { target: { value: "Candidate rationale" } });
    fireEvent.click(screen.getByRole("button", { name: "Create candidate" }));
    await waitFor(() => expect(screen.getByText(/1\/8 staged/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Keep this review note" } });
    fireEvent.change(screen.getByLabelText("Disposition"), { target: { value: "approve" } });
    let finish: ((result: { accepted: boolean; message: string }) => void) | undefined;
    const onSelectCandidate = vi.fn(() => new Promise<{ accepted: boolean; message: string }>((resolve) => { finish = resolve; }));
    cleanup();
    renderExchange(bridge, { onSelectCandidate });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Compare appearance" } });
    fireEvent.click(screen.getByRole("button", { name: "Create brief" }));
    await waitFor(() => expect(screen.getByText(/Brief created and retained/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Rationale"), { target: { value: "Candidate rationale" } });
    fireEvent.click(screen.getByRole("button", { name: "Create candidate" }));
    await waitFor(() => expect(screen.getByText(/1\/8 staged/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Keep this review note" } });
    fireEvent.change(screen.getByLabelText("Disposition"), { target: { value: "approve" } });
    fireEvent.click(screen.getByRole("button", { name: "Select candidate" }));
    expect(screen.getByRole("button", { name: "Select candidate" }).hasAttribute("disabled")).toBe(true);
    expect(onSelectCandidate).toHaveBeenCalledWith(expect.objectContaining({ kind: CANDIDATE_KIND }), expect.objectContaining({ feedback: expect.any(Object) }));
    finish?.({ accepted: true, message: "Selection complete" });
    await waitFor(() => expect(screen.getByText("Candidate requested for verification by the parent session.")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Candidate requested for verification" })).toBeTruthy();
    expect(screen.getByDisplayValue("Keep this review note")).toBeTruthy();
  });

  it("does not begin candidate selection while another packet action is busy", async () => {
    const { bridge } = makeBridge();
    let finishExport: ((result: { cancelled: boolean; saved: boolean; digest: string }) => void) | undefined;
    bridge.exportPacket = vi.fn(() => new Promise<{ cancelled: boolean; saved: boolean; digest: string }>((resolve) => {
      finishExport = resolve;
    }));
    const { onSelectCandidate } = await createBrief(bridge);
    fireEvent.click(screen.getByRole("button", { name: "Create candidate" }));
    await waitFor(() => expect(screen.getByText(/1\/8 staged/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Export candidate" }));
    await waitFor(() => expect(screen.getByText("Working")).toBeTruthy());
    const selectButton = screen.getByRole("button", { name: "Select candidate" });
    expect(selectButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(selectButton);
    expect(onSelectCandidate).not.toHaveBeenCalled();
    finishExport?.({ cancelled: false, saved: true, digest: DIGEST_A });
    await waitFor(() => expect(screen.getByText(/Candidate exported/)).toBeTruthy());
  });

  it("blocks selection while a save is pending and does not auto-select on review approval", async () => {
    const { bridge } = makeBridge();
    renderExchange(bridge, { pendingSave: true });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Compare appearance" } });
    fireEvent.click(screen.getByRole("button", { name: "Create brief" }));
    await waitFor(() => expect(screen.getByText(/Brief created and retained/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create candidate" }));
    await waitFor(() => expect(screen.getByText(/1\/8 staged/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Select candidate" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Approval here never adopts/)).toBeTruthy();
  });

  it("creates a review over an exact referenced subset with per-candidate feedback", async () => {
    const { bridge, createPacket } = makeBridge();
    await createBrief(bridge);
    for (let index = 0; index < 2; index += 1) {
      fireEvent.change(screen.getByLabelText("Rationale"), { target: { value: `Rationale ${index}` } });
      fireEvent.click(screen.getByRole("button", { name: "Create candidate" }));
      await waitFor(() => expect(screen.getByText(`${index + 1}/8 staged`)).toBeTruthy());
    }
    const firstComment = screen.getAllByLabelText("Comment")[0];
    const firstDisposition = screen.getAllByLabelText("Disposition")[0];
    const secondInclude = screen.getAllByLabelText(/Include this candidate/)[1];
    if (!firstComment || !firstDisposition || !secondInclude) {
      throw new Error("Expected both staged candidate feedback controls");
    }
    fireEvent.change(firstComment, { target: { value: "Approve this one" } });
    fireEvent.change(firstDisposition, { target: { value: "approve" } });
    fireEvent.click(secondInclude);
    fireEvent.change(screen.getByLabelText("Overall disposition"), { target: { value: "approve" } });
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "The selected candidate meets the brief." } });
    fireEvent.click(screen.getByRole("button", { name: "Create review" }));
    await waitFor(() => expect(createPacket).toHaveBeenCalledTimes(4));
    const request = createPacket.mock.calls[3]?.[0] as unknown as RawCreateRequest;
    expect(request.kind).toBe(REVIEW_KIND);
    expect(request.input.candidateDigests).toHaveLength(1);
    expect(request.input.overallDisposition).toBe("approve");
    expect(request.input.summary).toBe("The selected candidate meets the brief.");
    expect(screen.getByText(/Review created with explicit human dispositions/)).toBeTruthy();
  });

  it("refuses review creation when an included candidate references a different brief", async () => {
    const { bridge, createPacket, importQueue } = makeBridge();
    await createBrief(bridge);
    importQueue.push(mismatchedCandidateEnvelope());
    fireEvent.click(screen.getByRole("button", { name: "Import candidate" }));
    await waitFor(() => expect(screen.getByText(/Candidate imported for inspection/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Overall disposition"), { target: { value: "revise" } });
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Reject mismatched association." } });
    fireEvent.click(screen.getByRole("button", { name: "Create review" }));
    await waitFor(() => expect(screen.getByText("Review refused: every candidate must reference the active brief.")).toBeTruthy());
    expect(createPacket).toHaveBeenCalledTimes(1);
  });

  it("labels imported reviews with candidate brief association mismatches as inspection-only", async () => {
    const { bridge, importQueue } = makeBridge();
    await createBrief(bridge);
    importQueue.push(mismatchedCandidateEnvelope());
    fireEvent.click(screen.getByRole("button", { name: "Import candidate" }));
    await waitFor(() => expect(screen.getByText(/Candidate imported for inspection/)).toBeTruthy());
    importQueue.push(reviewEnvelope(DIGEST_C, digestFor(1)));
    fireEvent.click(screen.getByRole("button", { name: "Import review" }));
    await waitFor(() => expect(screen.getByText(/candidate brief associations differ/)).toBeTruthy());
  });

  it("keeps an imported review inspection-only when a referenced candidate is missing", async () => {
    const { bridge, importQueue } = makeBridge();
    await createBrief(bridge);
    importQueue.push(reviewEnvelope("f".repeat(64), digestFor(1)));
    fireEvent.click(screen.getByRole("button", { name: "Import review" }));
    await waitFor(() => expect(screen.getByText(/inspection-only: candidate references are incomplete/)).toBeTruthy());
    expect(screen.getByText(/1 missing/)).toBeTruthy();
  });

  it("accepts an imported review only as an exact association when its brief and candidate subset are present", async () => {
    const { bridge, importQueue } = makeBridge();
    await createBrief(bridge);
    fireEvent.click(screen.getByRole("button", { name: "Create candidate" }));
    await waitFor(() => expect(screen.getByText(/1\/8 staged/)).toBeTruthy());
    importQueue.push(reviewEnvelope(digestFor(2), digestFor(1)));
    fireEvent.click(screen.getByRole("button", { name: "Import review" }));
    await waitFor(() => expect(screen.getByText(/exact staged brief and candidate subset/)).toBeTruthy());
  });

  it("refuses malformed native envelopes without retaining them", async () => {
    const { bridge, createPacket } = makeBridge();
    createPacket.mockResolvedValueOnce(makeEnvelope(BRIEF_KIND, {}, DIGEST_A, false));
    renderExchange(bridge);
    fireEvent.click(screen.getByRole("button", { name: "Create brief" }));
    await waitFor(() => expect(screen.getByText(/brief could not be created/)).toBeTruthy());
    expect(screen.queryByText(/Retained canonical JSON/)).toBeNull();
  });

  it("preserves retained packet state when export is cancelled", async () => {
    const { bridge, exportPacket } = makeBridge();
    await createBrief(bridge);
    exportPacket.mockResolvedValueOnce({ cancelled: true, saved: false, digest: DIGEST_A });
    fireEvent.click(screen.getByRole("button", { name: "Export brief" }));
    await waitFor(() => expect(screen.getByText(/export cancelled/)).toBeTruthy());
    expect(screen.getByText(/Retained canonical JSON/)).toBeTruthy();
  });
});


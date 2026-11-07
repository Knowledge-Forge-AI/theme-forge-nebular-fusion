import { describe, expect, it, vi } from "vitest";
import {
  PAIRED_V2_PACKET_COMMAND,
  PairedV2PacketBridgeError,
  type PairedV2PacketInvoke,
  type PairedV2PacketTransport,
  TauriPairedV2PacketBridge,
} from "../paired-v2-packet-bridge";
import type {
  PairedV2BriefPacket,
  PairedV2CandidatePacket,
  PairedV2NativePacketEnvelope,
  PairedV2PacketCreateRequest,
  PairedV2ReviewPacket,
} from "../paired-v2-packets";
import type { ThemePacketExportResponse, ThemePacketImportResponse } from "../../theme-lab/types";

const BRIEF_DIGEST = "a".repeat(64);
const SOURCE_DIGEST = "b".repeat(64);
const CANONICAL_DIGEST = "c".repeat(64);
const CANDIDATE_DIGEST = "d".repeat(64);
const REVIEW_DIGEST = "e".repeat(64);

function briefPacket(): PairedV2BriefPacket {
  return {
    schema: "tf-paired-profile-v2-brief",
    schemaVersion: 1,
    briefId: "developer-brief",
    title: "Developer focused edit",
    goal: "Edit a bounded set of profile values.",
    profileName: "developer",
    profileVersion: "0.1.0",
    sourceProfileSha256: SOURCE_DIGEST,
    sourceCanonicalDigest: CANONICAL_DIGEST,
    editablePaths: ["color.*", "typography.*", "radius.*"],
    allowedModes: ["light", "dark"],
    acceptanceCriteria: ["Preserve all untouched fields."],
    prohibitedChanges: ["Do not edit targetOverrides."],
    briefDigest: BRIEF_DIGEST,
  };
}

function candidatePacket(): PairedV2CandidatePacket {
  return {
    schema: "tf-paired-profile-v2-candidate",
    schemaVersion: 1,
    candidateId: "developer-candidate",
    briefDigest: BRIEF_DIGEST,
    sourceBytesBase64: "eA==",
    sourceProfileSha256: SOURCE_DIGEST,
    sourceCanonicalDigest: CANONICAL_DIGEST,
    rationale: "Human design context only; native compile must rebind the source.",
    candidateDigest: CANDIDATE_DIGEST,
  };
}

function reviewPacket(): PairedV2ReviewPacket {
  return {
    schema: "tf-paired-profile-v2-review",
    schemaVersion: 1,
    reviewId: "developer-review",
    briefDigest: BRIEF_DIGEST,
    candidateDigests: [CANDIDATE_DIGEST],
    dispositions: [{ candidateDigest: CANDIDATE_DIGEST, disposition: "revise" }],
    overallDisposition: "revise",
    summary: "Revise after source re-verification.",
    reviewDigest: REVIEW_DIGEST,
  };
}

function createRequest(packet: PairedV2BriefPacket | PairedV2CandidatePacket | PairedV2ReviewPacket): PairedV2PacketCreateRequest {
  const digest = packet.schema === "tf-paired-profile-v2-brief"
    ? "briefDigest"
    : packet.schema === "tf-paired-profile-v2-candidate"
      ? "candidateDigest"
      : "reviewDigest";
  const input = { ...packet } as Record<string, unknown>;
  delete input[digest];
  return { kind: packet.schema, input } as PairedV2PacketCreateRequest;
}

function envelope(packet: PairedV2BriefPacket | PairedV2CandidatePacket | PairedV2ReviewPacket): PairedV2NativePacketEnvelope {
  const digest = packet.schema === "tf-paired-profile-v2-brief"
    ? packet.briefDigest
    : packet.schema === "tf-paired-profile-v2-candidate"
      ? packet.candidateDigest
      : packet.reviewDigest;
  return {
    kind: packet.schema,
    canonicalJson: JSON.stringify(packet),
    digest,
    packetDigestVerified: true,
    packet,
  };
}

function invokeReply(reply: unknown): { invoke: PairedV2PacketInvoke; calls: { command: string; args: { request: unknown } }[] } {
  const calls: { command: string; args: { request: unknown } }[] = [];
  const invoke: PairedV2PacketInvoke = async (command, args) => {
    calls.push({ command, args });
    return reply as never;
  };
  return { invoke, calls };
}

function packetTransport(
  importResponse: ThemePacketImportResponse = { cancelled: true },
  exportResponse: ThemePacketExportResponse = { cancelled: true, saved: false },
): PairedV2PacketTransport {
  return {
    importPacket: vi.fn(async () => importResponse),
    exportPacket: vi.fn(async () => exportResponse),
  };
}

describe("paired v2 packet bridge", () => {
  it("creates each closed packet kind through the dedicated command with explicit invoke DI", async () => {
    const packets = [briefPacket(), candidatePacket(), reviewPacket()];
    const replies = packets.map(envelope);
    let index = 0;
    const calls: { command: string; args: { request: unknown } }[] = [];
    const invoke: PairedV2PacketInvoke = async (command, args) => {
      calls.push({ command, args });
      return replies[index++] as never;
    };
    const bridge = new TauriPairedV2PacketBridge(invoke, packetTransport());

    for (const packet of packets) {
      const result = await bridge.createPacket(createRequest(packet));
      expect(result.kind).toBe(packet.schema);
      expect(result.packetDigestVerified).toBe(true);
    }
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.command === PAIRED_V2_PACKET_COMMAND)).toBe(true);
    expect(calls[0]?.args.request).toMatchObject({ kind: "tf-paired-profile-v2-brief" });
    expect((calls[0]?.args.request as { input: Record<string, unknown> }).input).not.toHaveProperty("briefDigest");
  });

  it("rejects unknown create fields before invocation and hides invocation failures", async () => {
    const injected = invokeReply(envelope(candidatePacket()));
    const bridge = new TauriPairedV2PacketBridge(injected.invoke, packetTransport());
    const invalid = {
      ...createRequest(candidatePacket()),
      input: { ...createRequest(candidatePacket()).input, unexpected: true },
    } as unknown as PairedV2PacketCreateRequest;
    await expect(bridge.createPacket(invalid)).rejects.toMatchObject({ code: "invalid-request" });
    expect(injected.calls).toHaveLength(0);

    const failingInvoke: PairedV2PacketInvoke = async () => { throw new Error("native private detail"); };
    await expect(new TauriPairedV2PacketBridge(failingInvoke, packetTransport()).createPacket(createRequest(candidatePacket())))
      .rejects.toMatchObject({ code: "native-rejected" });
  });

  it("imports with the exact paired expectedKind and retains both native identity field sets", async () => {
    const packet = candidatePacket();
    const paired = envelope(packet);
    const transport = packetTransport({
      cancelled: false,
      packet: packet as unknown as Record<string, unknown>,
      canonicalJson: paired.canonicalJson,
      kind: paired.kind,
      digest: paired.digest,
      pairedV2: paired,
    });
    const bridge = new TauriPairedV2PacketBridge(invokeReply(paired).invoke, transport);
    const result = await bridge.importPacket(packet.schema);
    expect(result).toEqual({ cancelled: false, envelope: paired });
    expect(transport.importPacket).toHaveBeenCalledWith({ expectedKind: packet.schema });
  });

  it("keeps cancellation separate and refuses import identity drift or missing paired envelope", async () => {
    const cancelled = new TauriPairedV2PacketBridge(invokeReply(undefined).invoke, packetTransport({ cancelled: true }));
    await expect(cancelled.importPacket("tf-paired-profile-v2-brief")).resolves.toEqual({ cancelled: true });

    const packet = candidatePacket();
    const paired = envelope(packet);
    const drifted = packetTransport({
      cancelled: false,
      canonicalJson: paired.canonicalJson,
      kind: paired.kind,
      digest: "f".repeat(64),
      pairedV2: paired,
    });
    await expect(new TauriPairedV2PacketBridge(invokeReply(undefined).invoke, drifted).importPacket(packet.schema))
      .rejects.toMatchObject({ code: "invalid-response" });

    const noEnvelope = packetTransport({ cancelled: false, canonicalJson: paired.canonicalJson, kind: paired.kind, digest: paired.digest });
    await expect(new TauriPairedV2PacketBridge(invokeReply(undefined).invoke, noEnvelope).importPacket(packet.schema))
      .rejects.toMatchObject({ code: "native-rejected" });
  });

  it("exports retained native canonical bytes through the existing picker bridge", async () => {
    const paired = envelope(candidatePacket());
    const transport = packetTransport({ cancelled: true }, {
      cancelled: false,
      saved: true,
      digest: paired.digest,
      pairedV2: paired,
    });
    const bridge = new TauriPairedV2PacketBridge(invokeReply(undefined).invoke, transport);
    await expect(bridge.exportPacket(paired)).resolves.toEqual({ cancelled: false, saved: true, digest: paired.digest });
    expect(transport.exportPacket).toHaveBeenCalledWith({
      packetJson: paired.canonicalJson,
      defaultName: "theme.paired-v2-candidate.json",
      expectedKind: paired.kind,
    });
  });

  it("rejects export canonical-byte or digest drift and preserves closed cancellation", async () => {
    const paired = envelope(reviewPacket());
    const cancelledTransport = packetTransport(undefined, { cancelled: true, saved: false });
    await expect(new TauriPairedV2PacketBridge(invokeReply(undefined).invoke, cancelledTransport).exportPacket(paired))
      .resolves.toEqual({ cancelled: true, saved: false });

    const drifted = packetTransport(undefined, {
      cancelled: false,
      saved: true,
      digest: paired.digest,
      pairedV2: { ...paired, canonicalJson: JSON.stringify({ ...paired.packet, summary: "drift" }) },
    });
    await expect(new TauriPairedV2PacketBridge(invokeReply(undefined).invoke, drifted).exportPacket(paired))
      .rejects.toMatchObject({ code: "invalid-response" });

    const digestDrift = packetTransport(undefined, {
      cancelled: false,
      saved: true,
      digest: "f".repeat(64),
      pairedV2: paired,
    });
    await expect(new TauriPairedV2PacketBridge(invokeReply(undefined).invoke, digestDrift).exportPacket(paired))
      .rejects.toMatchObject({ code: "invalid-response" });
  });

  it("does not turn packet self-integrity into profile or custody authority", async () => {
    const paired = envelope(candidatePacket());
    const bridge = new TauriPairedV2PacketBridge(invokeReply(paired).invoke, packetTransport());
    const result = await bridge.createPacket(createRequest(candidatePacket()));
    expect(result).toHaveProperty("packetDigestVerified", true);
    expect(result).not.toHaveProperty("profileVerified");
    expect(result).not.toHaveProperty("sourceCustodyVerified");
  });
});

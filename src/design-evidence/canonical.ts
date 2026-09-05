import type { DesignEvidencePacket, PacketKind } from "./types";

const domains = { brief: "tfsb.design-brief-v1\n", candidate: "tfsb.design-candidate-v1\n", review: "tfsb.design-review-v1\n" } as const;
export function packetKind(packet: DesignEvidencePacket): PacketKind { return packet.schema === "tfsb.design-brief" ? "brief" : packet.schema === "tfsb.design-candidate" ? "candidate" : "review"; }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sortJson(child)])); return value; }
export function canonicalPacketJson(value: unknown): string { return `${JSON.stringify(sortJson(value), null, 2)}\n`; }
export async function computePacketDigest(packet: DesignEvidencePacket): Promise<`sha256:${string}`> {
  const kind = packetKind(packet); const field = kind === "brief" ? "briefDigest" : kind === "candidate" ? "candidateDigest" : "reviewDigest";
  const projection = Object.fromEntries(Object.entries(packet).filter(([key]) => key !== field));
  const bytes = new TextEncoder().encode(`${domains[kind]}${canonicalPacketJson(projection)}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
export async function validatePacketDigest(packet: DesignEvidencePacket): Promise<void> { const actual = packet.schema === "tfsb.design-brief" ? packet.briefDigest : packet.schema === "tfsb.design-candidate" ? packet.candidateDigest : packet.reviewDigest; if (await computePacketDigest(packet) !== actual) throw new Error("Packet digest is invalid."); }

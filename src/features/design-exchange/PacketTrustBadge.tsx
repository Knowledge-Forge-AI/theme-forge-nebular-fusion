import type { PacketTrustState } from "../../design-evidence/types";

const labels: Record<PacketTrustState, string> = {
  "local-current": "Local current",
  "context-matched-external": "Context matched external",
  "self-consistent-external": "Self-consistent external",
  "context-stale": "Context stale",
  "context-mismatch": "Context mismatch",
  invalid: "Invalid",
};
export function PacketTrustBadge({ state }: { readonly state: PacketTrustState }) { return <span className={`packet-trust trust-${state}`}><span aria-hidden="true">{state === "invalid" || state.includes("mismatch") || state.includes("stale") ? "!" : "✓"}</span> {labels[state]}</span>; }

import { useEffect, useState } from "react";
import type { Proposal } from "../../design-evidence/types";
import type { RecipeGraph } from "../../brand-read/StudioBrandReadClient";
import type { StudioBrandPlanStartRequest } from "../../brand-plans/contracts";

export function DerivePlanForm({ projectHandle, graph, disabled, prefill, onCreate }: { readonly projectHandle: string; readonly graph: RecipeGraph; readonly disabled: boolean; readonly prefill?: Extract<Proposal, { readonly kind: "derive" }> | undefined; readonly onCreate: (request: StudioBrandPlanStartRequest) => void }) {
  const [all, setAll] = useState(true); const [selected, setSelected] = useState<readonly string[]>([]);
  useEffect(() => { if (!prefill) return; setAll(prefill.selection.kind === "all"); setSelected(prefill.selection.kind === "recipes" ? prefill.selection.recipeIds.filter((id) => graph.nodes.some((node) => node.recipeId === id)) : []); }, [prefill, graph]);
  const toggle = (recipeId: string) => setSelected((current) => current.includes(recipeId) ? current.filter((id) => id !== recipeId) : [...current, recipeId].sort());
  return <fieldset disabled={disabled}><legend>Create a typed derive plan</legend><label><input type="radio" name="derive-scope" checked={all} onChange={() => setAll(true)} /> All recipes</label><label><input type="radio" name="derive-scope" checked={!all} onChange={() => setAll(false)} /> Explicit recipe IDs</label>{!all ? <ul>{graph.nodes.map((node) => <li key={node.recipeId}><label><input type="checkbox" checked={selected.includes(node.recipeId)} onChange={() => toggle(node.recipeId)} /> <code>{node.recipeId}</code> → <code>{node.targetAsset}</code></label></li>)}</ul> : null}<button type="button" disabled={!all && selected.length === 0} onClick={() => onCreate({ kind: "create-derive", projectHandle, selection: all ? { kind: "all" } : { kind: "recipes", recipeIds: selected } })}>Review derive plan</button></fieldset>;
}

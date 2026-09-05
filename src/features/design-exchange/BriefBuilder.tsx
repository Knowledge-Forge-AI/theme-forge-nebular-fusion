import { useMemo, useRef, useState } from "react";
import type { VisualTarget } from "../../brand-read/StudioBrandReadClient";
import type { Material, ProposalKind } from "../../design-evidence/types";

export interface BriefTargetOption {
  readonly key: string;
  readonly label: string;
  readonly target: VisualTarget;
  readonly assetId: string;
  readonly purpose: string;
}

export interface BriefRenderTuple {
  readonly width: number;
  readonly height: number;
  readonly background: string;
}

export interface BriefDraftInput {
  readonly briefId: string;
  readonly title: string;
  readonly objective: string;
  readonly projectLabel?: string;
  readonly targets: readonly { readonly option: BriefTargetOption; readonly visualTuples: readonly BriefRenderTuple[] }[];
  readonly allowedProposalKinds: readonly ProposalKind[];
  readonly requiredTokenIds: readonly string[];
  readonly requiredRecipeIds: readonly string[];
  readonly qaProfileIds: readonly string[];
  readonly renderTuples: readonly BriefRenderTuple[];
  readonly acceptanceCriteria: readonly string[];
  readonly prohibitedChanges: readonly string[];
  readonly material?: Material;
}

const proposalKinds: readonly ProposalKind[] = ["consumer-install", "consumer-sync", "derive", "evidence-only", "export", "qa-baseline"];
const splitLines = (value: string): readonly string[] => value.split("\n").map((line) => line.trim()).filter(Boolean);
const toggle = (values: readonly string[], value: string): readonly string[] => values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value].sort();
const validBackground = (value: string): boolean => value === "transparent" || /^#[0-9A-F]{8}$/u.test(value) || /^token:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value);

export function BriefBuilder({ ready, targetOptions, tokenIds, recipeIds, qaProfileIds, busy, onCreate }: {
  readonly ready: boolean;
  readonly targetOptions: readonly BriefTargetOption[];
  readonly tokenIds: readonly string[];
  readonly recipeIds: readonly string[];
  readonly qaProfileIds: readonly string[];
  readonly busy: boolean;
  readonly onCreate: (input: BriefDraftInput) => void;
}) {
  const [briefId, setBriefId] = useState(""); const [title, setTitle] = useState(""); const [objective, setObjective] = useState(""); const [projectLabel, setProjectLabel] = useState("");
  const [targets, setTargets] = useState<readonly string[]>([]); const [visualSelections, setVisualSelections] = useState<Readonly<Record<string, readonly string[]>>>({}); const [allowed, setAllowed] = useState<readonly string[]>([]); const [tokens, setTokens] = useState<readonly string[]>([]); const [recipes, setRecipes] = useState<readonly string[]>([]); const [profiles, setProfiles] = useState<readonly string[]>([]);
  const tupleSequence = useRef(1);
  const [renderTuples, setRenderTuples] = useState<readonly { readonly id: string; readonly tuple: BriefRenderTuple }[]>([{ id: "render-1", tuple: { width: 256, height: 256, background: "transparent" } }]);
  const [acceptance, setAcceptance] = useState(""); const [prohibited, setProhibited] = useState(""); const [materialEnabled, setMaterialEnabled] = useState(false); const [materialKind, setMaterialKind] = useState<Material["kind"]>("user-supplied"); const [materialIdentifier, setMaterialIdentifier] = useState(""); const [materialDigest, setMaterialDigest] = useState(""); const [licenseExpression, setLicenseExpression] = useState("");
  const criteria = splitLines(acceptance), prohibitedChanges = splitLines(prohibited);
  const attachmentCount = Object.values(visualSelections).reduce((total, values) => total + values.length, 0);
  const validTuples = renderTuples.length >= 1 && renderTuples.length <= 16 && renderTuples.every(({ tuple: { width, height, background } }) => Number.isInteger(width) && Number.isInteger(height) && width >= 16 && width <= 1_024 && height >= 16 && height <= 1_024 && validBackground(background));
  const materialValid = !materialEnabled || (/^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/u.test(materialIdentifier) && /^sha256:[0-9a-f]{64}$/u.test(materialDigest) && (!licenseExpression || new TextEncoder().encode(licenseExpression).byteLength <= 256));
  const canCreate = ready && !busy && /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/u.test(briefId) && title.length > 0 && objective.length > 0 && targets.length >= 1 && targets.length <= 32 && attachmentCount <= 8 && allowed.length > 0 && validTuples && criteria.length >= 1 && criteria.length <= 64 && prohibitedChanges.length <= 64 && materialValid;
  const selected = useMemo(() => targets.map((key) => targetOptions.find((option) => option.key === key)).filter((option): option is BriefTargetOption => option !== undefined), [targetOptions, targets]);
  const clearTupleSelections = (tupleId: string) => setVisualSelections((current) => Object.fromEntries(Object.entries(current).map(([key, ids]) => [key, ids.filter((id) => id !== tupleId)])));
  const updateTuple = (index: number, field: "width" | "height" | "background", value: string) => {
    const tupleId = renderTuples[index]?.id; if (!tupleId) return;
    clearTupleSelections(tupleId);
    setRenderTuples((current) => current.map((entry, itemIndex) => itemIndex === index ? { ...entry, tuple: { ...entry.tuple, [field]: field === "background" ? value : Number(value) } } : entry));
  };
  const toggleVisual = (targetKey: string, tupleId: string) => setVisualSelections((current) => ({ ...current, [targetKey]: toggle(current[targetKey] ?? [], tupleId) }));
  const submit = () => {
    if (!canCreate) return;
    onCreate({
      briefId, title, objective, ...(projectLabel ? { projectLabel } : {}),
      targets: selected.map((option) => ({ option, visualTuples: (visualSelections[option.key] ?? []).map((tupleId) => renderTuples.find(({ id }) => id === tupleId)?.tuple).filter((tuple): tuple is BriefRenderTuple => tuple !== undefined) })),
      allowedProposalKinds: allowed as readonly ProposalKind[], requiredTokenIds: tokens, requiredRecipeIds: recipes, qaProfileIds: profiles, renderTuples: renderTuples.map(({ tuple }) => tuple), acceptanceCriteria: criteria, prohibitedChanges,
      ...(materialEnabled ? { material: { kind: materialKind, identifier: materialIdentifier, digest: materialDigest as Material["digest"], ...(licenseExpression ? { licenseExpression } : {}) } } : {}),
    });
  };
  if (!ready) return <article className="panel brief-builder"><h3>Create brief from selected live evidence</h3><p>Start the host and open one branded project.</p></article>;
  return <article className="panel brief-builder"><h3>Create brief from selected live evidence</h3>
    <label>Public brief ID <input value={briefId} onChange={(event) => setBriefId(event.target.value)} /></label><label>Title <input maxLength={512} value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>Objective <textarea maxLength={4096} value={objective} onChange={(event) => setObjective(event.target.value)} /></label><label>Optional public project label <input maxLength={256} value={projectLabel} onChange={(event) => setProjectLabel(event.target.value)} /></label>
    <fieldset><legend>Live targets (choose 1–32; none are preselected)</legend>{targetOptions.map((option) => <div key={option.key} className="target-choice"><label><input type="checkbox" checked={targets.includes(option.key)} onChange={() => { setTargets((current) => toggle(current, option.key)); if (targets.includes(option.key)) setVisualSelections((current) => { const next = { ...current }; delete next[option.key]; return next; }); }} />{option.label}</label>{targets.includes(option.key) ? <fieldset><legend>Explicit visual attachments for {option.label}</legend>{renderTuples.map(({ id, tuple }, index) => <label key={id}><input type="checkbox" checked={(visualSelections[option.key] ?? []).includes(id)} disabled={attachmentCount >= 8 && !(visualSelections[option.key] ?? []).includes(id)} onChange={() => toggleVisual(option.key, id)} />{`Attach ${option.label} with render tuple ${index + 1} (${tuple.width}×${tuple.height} ${tuple.background})`}</label>)}</fieldset> : null}</div>)}</fieldset>
    <fieldset><legend>Allowed proposal kinds</legend>{proposalKinds.map((kind) => <label key={kind}><input type="checkbox" checked={allowed.includes(kind)} onChange={() => setAllowed((current) => toggle(current, kind))} />{kind}</label>)}</fieldset>
    <fieldset><legend>Required token IDs</legend>{tokenIds.map((token) => <label key={token}><input type="checkbox" checked={tokens.includes(token)} onChange={() => setTokens((current) => toggle(current, token))} />{token}</label>)}</fieldset>
    <fieldset><legend>Required recipe IDs</legend>{recipeIds.map((recipe) => <label key={recipe}><input type="checkbox" checked={recipes.includes(recipe)} onChange={() => setRecipes((current) => toggle(current, recipe))} />{recipe}</label>)}</fieldset>
    <fieldset><legend>QA profile IDs</legend>{qaProfileIds.map((profile) => <label key={profile}><input type="checkbox" checked={profiles.includes(profile)} onChange={() => setProfiles((current) => toggle(current, profile))} />{profile}</label>)}</fieldset>
    <fieldset><legend>Render tuples (1–16; attachments are explicit)</legend>{renderTuples.map(({ id, tuple }, index) => <div className="coordinate-grid" key={id}><label>Width<input aria-label={`Render ${index + 1} width`} type="number" min="16" max="1024" value={tuple.width} onChange={(event) => updateTuple(index, "width", event.target.value)} /></label><label>Height<input aria-label={`Render ${index + 1} height`} type="number" min="16" max="1024" value={tuple.height} onChange={(event) => updateTuple(index, "height", event.target.value)} /></label><label>Background<input aria-label={`Render ${index + 1} background`} value={tuple.background} onChange={(event) => updateTuple(index, "background", event.target.value)} /></label><button type="button" disabled={renderTuples.length === 1} onClick={() => { clearTupleSelections(id); setRenderTuples((current) => current.filter((entry) => entry.id !== id)); }}>Remove render tuple {index + 1}</button></div>)}<button type="button" disabled={renderTuples.length >= 16} onClick={() => { tupleSequence.current += 1; setRenderTuples((current) => [...current, { id: `render-${tupleSequence.current}`, tuple: { width: 256, height: 256, background: "transparent" } }]); }}>Add render tuple</button><p>{attachmentCount} of 8 visual attachments selected.</p></fieldset>
    <label>Acceptance criteria (one per line, 1–64)<textarea value={acceptance} onChange={(event) => setAcceptance(event.target.value)} /></label><label>Prohibited changes (one per line, 0–64)<textarea value={prohibited} onChange={(event) => setProhibited(event.target.value)} /></label>
    <fieldset><legend>Optional material provenance</legend><label><input type="checkbox" checked={materialEnabled} onChange={(event) => setMaterialEnabled(event.target.checked)} />Include one provenance record</label>{materialEnabled ? <><label>Kind<select value={materialKind} onChange={(event) => setMaterialKind(event.target.value as Material["kind"])}><option>user-supplied</option><option>tfsb-rendered</option><option>third-party</option><option>external-claim</option></select></label><label>Identifier<input value={materialIdentifier} onChange={(event) => setMaterialIdentifier(event.target.value)} /></label><label>Digest<input value={materialDigest} onChange={(event) => setMaterialDigest(event.target.value)} /></label><label>License expression<input maxLength={256} value={licenseExpression} onChange={(event) => setLicenseExpression(event.target.value)} /></label></> : null}</fieldset>
    {!validTuples ? <p role="alert">Every render tuple needs a 16–1024 size and a canonical background.</p> : null}<button type="button" disabled={!canCreate} onClick={submit}>Create and export brief</button>
  </article>;
}

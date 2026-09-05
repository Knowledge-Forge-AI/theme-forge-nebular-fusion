import type { DiffChange, DiffValue, SemanticDiff, VisualTarget } from "../../brand-read/StudioBrandReadClient";
import type { SelectedEvidence } from "./workbench-state";

function object(value: DiffValue | null): { readonly [key: string]: DiffValue } | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as { readonly [key: string]: DiffValue } : null;
}

function directString(value: DiffValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function visualCandidate(change: DiffChange): { readonly target: VisualTarget; readonly assetId: string; readonly label: string } | null {
  const before = object(change.before);
  const after = object(change.after);
  if (!before || !after) return null;
  const beforeAsset = directString(before.assetId ?? before.asset);
  const afterAsset = directString(after.assetId ?? after.asset);
  if (!beforeAsset || beforeAsset !== afterAsset) return null;
  const family = directString(before.family);
  const role = directString(before.role);
  const variant = directString(before.variant);
  if (family && family === directString(after.family) && role && role === directString(after.role) && variant && variant === directString(after.variant)) {
    return { target: { kind: "binding", family, role, variant }, assetId: beforeAsset, label: `${family}/${role}/${variant}` };
  }
  return { target: { kind: "asset", assetId: beforeAsset }, assetId: beforeAsset, label: beforeAsset };
}

function selectedCandidate(candidate: NonNullable<ReturnType<typeof visualCandidate>>): SelectedEvidence {
  const base = { label: candidate.label, assetId: candidate.assetId, width: 256, height: 256, background: "transparent" } as const;
  return candidate.target.kind === "asset"
    ? { ...base, kind: "brand-diff-asset", target: candidate.target }
    : { ...base, kind: "brand-diff-binding", target: candidate.target };
}

function isCandidateSelected(selection: SelectedEvidence, candidate: NonNullable<ReturnType<typeof visualCandidate>>): boolean {
  if (candidate.target.kind === "asset") {
    return selection.kind === "brand-diff-asset" && selection.target.assetId === candidate.target.assetId && selection.label === candidate.label;
  }
  return selection.kind === "brand-diff-binding"
    && selection.target.family === candidate.target.family
    && selection.target.role === candidate.target.role
    && selection.target.variant === candidate.target.variant
    && selection.label === candidate.label;
}

function ChangeList({
  title,
  changes,
  selection,
  onSelect,
  visual = false,
}: {
  readonly title: string;
  readonly changes: readonly DiffChange[];
  readonly selection: SelectedEvidence;
  readonly onSelect: (selection: SelectedEvidence) => void;
  readonly visual?: boolean;
}) {
  return (
    <section className="diff-subsection" aria-labelledby={`diff-${title}`}>
      <h5 id={`diff-${title}`}>{title}</h5>
      {changes.length === 0 ? (
        <p>No changes.</p>
      ) : (
        <ul>
          {changes.map((change) => {
            const candidate = visual ? visualCandidate(change) : null;
            const selected = candidate ? isCandidateSelected(selection, candidate) : false;
            return (
              <li key={change.id}>
                <strong>{change.change}</strong> <code>{change.id}</code>
                {candidate ? (
                  <label>
                    <input
                      type="radio"
                      name="diff-visual-target"
                      checked={Boolean(selected)}
                      onChange={() => onSelect(selectedCandidate(candidate))}
                    /> Compare exact {candidate.target.kind}
                  </label>
                ) : null}
                <details>
                  <summary>Complete validated before/after values</summary>
                  <pre><code>{JSON.stringify({ before: change.before, after: change.after }, null, 2)}</code></pre>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function SemanticDiffView({
  data,
  selection,
  onSelect,
}: {
  readonly data: SemanticDiff;
  readonly selection: SelectedEvidence;
  readonly onSelect: (selection: SelectedEvidence) => void;
}) {
  const diff = data.diff;
  return (
    <div className="domain-view semantic-diff-view">
      <dl className="summary-grid">
        <div><dt>Status</dt><dd>{diff.status}</dd></div>
        <div><dt>Before</dt><dd><code>{diff.beforeDigest}</code></dd></div>
        <div><dt>After</dt><dd><code>{diff.afterDigest}</code></dd></div>
        <div><dt>Result digest</dt><dd><code>{diff.resultDigest}</code></dd></div>
        <div><dt>Before binding digest</dt><dd><code>{data.beforeBindingDigest}</code></dd></div>
        <div><dt>After binding digest</dt><dd><code>{data.afterBindingDigest}</code></dd></div>
        <div><dt>Visual comparison</dt><dd>{data.visualDiff.available ? "Available for proven targets" : "Unavailable"}</dd></div>
      </dl>

      <section className="diff-section" aria-labelledby="diff-section-inventory">
        <h4 id="diff-section-inventory">Inventory</h4>
        <ChangeList title="inventory-families" changes={diff.inventory.families} selection={selection} onSelect={onSelect} visual={data.visualDiff.available} />
        <ChangeList title="inventory-roles" changes={diff.inventory.roles} selection={selection} onSelect={onSelect} visual={data.visualDiff.available} />
        <ChangeList title="inventory-variants" changes={diff.inventory.variants} selection={selection} onSelect={onSelect} visual={data.visualDiff.available} />
        <ChangeList title="inventory-requirements" changes={diff.inventory.requirements} selection={selection} onSelect={onSelect} visual={data.visualDiff.available} />
        {diff.inventory.completeness ? (
          <ChangeList title="inventory-completeness" changes={[diff.inventory.completeness]} selection={selection} onSelect={onSelect} />
        ) : null}
      </section>

      <section className="diff-section" aria-labelledby="diff-section-bindings">
        <h4 id="diff-section-bindings">Bindings</h4>
        <ChangeList title="bindings" changes={diff.bindings.records} selection={selection} onSelect={onSelect} visual={data.visualDiff.available} />
      </section>

      <section className="diff-section" aria-labelledby="diff-section-tokens">
        <h4 id="diff-section-tokens">Tokens</h4>
        <ChangeList title="tokens" changes={diff.tokens.records} selection={selection} onSelect={onSelect} />
      </section>

      <section className="diff-section" aria-labelledby="diff-section-recipes">
        <h4 id="diff-section-recipes">Recipes</h4>
        <ChangeList title="recipes" changes={diff.recipes.records} selection={selection} onSelect={onSelect} />
        <div className="diff-affected">
          <p>Affected targets: {diff.recipes.affectedTargets.length}</p>
          {diff.recipes.affectedTargets.length > 0 ? (
            <details>
              <summary>Complete list of affected recipe targets ({diff.recipes.affectedTargets.length})</summary>
              <ul>
                {diff.recipes.affectedTargets.map((target) => (
                  <li key={target}><code>{target}</code></li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </section>

      <section className="diff-section" aria-labelledby="diff-section-derived">
        <h4 id="diff-section-derived">Derived</h4>
        <ChangeList title="derived" changes={diff.derived.records} selection={selection} onSelect={onSelect} visual={data.visualDiff.available} />
      </section>

      <section className="diff-section" aria-labelledby="diff-section-geometry">
        <h4 id="diff-section-geometry">Geometry</h4>
        <ChangeList title="geometry" changes={diff.geometry.records} selection={selection} onSelect={onSelect} />
        <p>Typed geometry changed: {String(diff.geometry.canonicalTypedGeometryChanged)}. Equivalence claim: <strong>{diff.geometry.equivalenceClaim}</strong>.</p>
      </section>

      <section className="diff-section" aria-labelledby="diff-section-qa-impact">
        <h4 id="diff-section-qa-impact">QA Impact</h4>
        <ChangeList title="qaImpact-profiles" changes={diff.qaImpact.profiles} selection={selection} onSelect={onSelect} />
        <ChangeList title="qaImpact-cases" changes={diff.qaImpact.cases} selection={selection} onSelect={onSelect} />
        <div className="diff-affected">
          <p>Affected QA cases: {diff.qaImpact.affectedCases.length}</p>
          {diff.qaImpact.affectedCases.length > 0 ? (
            <details>
              <summary>Complete list of affected QA cases ({diff.qaImpact.affectedCases.length})</summary>
              <ul>
                {diff.qaImpact.affectedCases.map((caseId) => (
                  <li key={caseId}><code>{caseId}</code></li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </section>

      <section className="diff-section" aria-labelledby="diff-section-package-legal">
        <h4 id="diff-section-package-legal">Package and Legal</h4>
        <p>Bundle relevant changes: <strong>{String(diff.packageAndLegal.bundleRelevantChanged)}</strong></p>
        {diff.packageAndLegal.package ? (
          <ChangeList title="package" changes={[diff.packageAndLegal.package]} selection={selection} onSelect={onSelect} />
        ) : null}
        <ChangeList title="companions" changes={diff.packageAndLegal.companions} selection={selection} onSelect={onSelect} />
      </section>

      <section className="diff-section" aria-labelledby="diff-section-consumer-profiles">
        <h4 id="diff-section-consumer-profiles">Consumer Profiles</h4>
        <ChangeList title="consumerProfiles" changes={diff.consumerProfiles.records} selection={selection} onSelect={onSelect} />
        <p>{diff.consumerProfiles.beforeState} → {diff.consumerProfiles.afterState} · {diff.consumerProfiles.status}</p>
      </section>

      <section className="diff-section" aria-labelledby="diff-section-exports">
        <h4 id="diff-section-exports">Exports</h4>
        <ChangeList title="exports" changes={diff.exports.records} selection={selection} onSelect={onSelect} />
        <p>{diff.exports.beforeState} → {diff.exports.afterState} · {diff.exports.status}</p>
      </section>
    </div>
  );
}

import type { QaJsonValue, QaProfile, QaProfilePage, QaResult } from "../../brand-read/StudioBrandReadClient";
import type { SelectedEvidence } from "./workbench-state";

function measurementText(value: Readonly<Record<string, QaJsonValue>>): string {
  return JSON.stringify(value);
}

export function QaView({
  profiles,
  profile,
  result,
  selection,
  onProfile,
  onSelect,
}: {
  readonly profiles: QaProfilePage;
  readonly profile: QaProfile | null;
  readonly result: QaResult | null;
  readonly selection: SelectedEvidence;
  readonly onProfile: (profileId: string | null) => void;
  readonly onSelect: (selection: SelectedEvidence) => void;
}) {
  return (
    <div className="domain-view qa-view">
      <label className="profile-picker">
        QA profile{" "}
        <select
          value={profile?.profile.id ?? ""}
          onChange={(event) => onProfile(event.target.value || null)}
        >
          <option value="">Select a profile</option>
          {profiles.page.items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.id} · {item.caseCount} cases
            </option>
          ))}
        </select>
      </label>

      {profile ? (
        <>
          <dl className="summary-grid">
            <div><dt>Policy</dt><dd>{profile.profile.renderer}</dd></div>
            <div><dt>Formats</dt><dd>{profile.profile.formats.join(", ")}</dd></div>
            <div><dt>QA digest</dt><dd><code>{profile.qaDigest}</code></dd></div>
            <div><dt>Brand system</dt><dd><code>{profile.brandSystemDigest}</code></dd></div>
            <div><dt>Resolved targets</dt><dd>{profile.resolvedTargetCount}</dd></div>
            <div><dt>Evaluations</dt><dd>{profile.evaluationCount}</dd></div>
            <div><dt>Raster</dt><dd>{profile.raster.available ? "Available" : "Unavailable"}</dd></div>
          </dl>

          <section className="qa-baselines-section" aria-labelledby="qa-baselines-heading">
            <h4 id="qa-baselines-heading">Baselines ({profile.baselines.length})</h4>
            {profile.baselines.length === 0 ? (
              <p>No baselines registered for this profile.</p>
            ) : (
              <details>
                <summary>Complete baseline digest records ({profile.baselines.length})</summary>
                <ul>
                  {profile.baselines.map((baseline) => (
                    <li key={baseline.caseId}>
                      <code>{baseline.caseId}</code>: {baseline.digest ? <code>{baseline.digest}</code> : "no digest"}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <h4>Cases</h4>
          <ul className="qa-case-list">
            {profile.cases.map((item) => {
              const baseline = item.kind === "baseline";
              const selected = selection.kind === "qa-baseline-case"
                && selection.profileId === profile.profile.id
                && selection.caseId === item.id;
              const label = "asset" in item && item.asset
                ? `asset ${item.asset}`
                : ["family" in item ? item.family : undefined, "role" in item ? item.role : undefined, "variant" in item ? item.variant : undefined].filter(Boolean).join("/") || "profile-owned target";
              return (
                <li key={item.id}>
                  <div><code>{item.id}</code> · {item.kind} · {label}</div>
                  {baseline ? (
                    <label>
                      <input
                        type="radio"
                        name="qa-baseline-target"
                        checked={selected}
                        onChange={() => onSelect({
                          kind: "qa-baseline-case",
                          label: `QA ${profile.profile.id}/${item.id}`,
                          profileId: profile.profile.id,
                          caseId: item.id,
                          assetId: label,
                          width: item.sizes[0]?.[0] ?? 16,
                          height: item.sizes[0]?.[1] ?? 16,
                          background: item.backgrounds[0] ?? "transparent",
                        })}
                      /> Select exact baseline case
                    </label>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="empty-state">Select one profile to read its exact policy, cases, and result.</p>
      )}

      {result ? (
        <section aria-labelledby="qa-current-result">
          <h4 id="qa-current-result">Current result: {result.status}</h4>
          <dl className="count-grid">
            {Object.entries(result.counts).map(([label, count]) => (
              <div key={label}><dt>{label}</dt><dd>{count}</dd></div>
            ))}
          </dl>
          <ul className="qa-result-list">
            {result.results.map((item) => (
              <li key={item.caseId}>
                <h5>{item.caseId}: {item.status}</h5>
                <p>{item.kind} · {item.capability}{item.capabilityRequired ? " (required)" : " (optional)"}</p>
                {Object.keys(item.measurements).length ? (
                  <details>
                    <summary>Complete case measurements</summary>
                    <code>{measurementText(item.measurements)}</code>
                  </details>
                ) : null}
                {item.diagnostics.map((diagnostic, index) => (
                  <p key={`${diagnostic.code}-${index}`}>
                    <strong>{diagnostic.code}</strong>: {diagnostic.message}{diagnostic.location ? ` (${diagnostic.location})` : ""}
                  </p>
                ))}
                <ul>
                  {item.evaluations.map((evaluation, index) => (
                    <li key={`${evaluation.target.assetId}-${index}`}>
                      {evaluation.target.assetId}: {evaluation.status}
                      {evaluation.width ? ` · ${evaluation.width}×${evaluation.height} · ${evaluation.background}` : ""}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

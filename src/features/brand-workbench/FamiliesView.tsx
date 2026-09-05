import type { FamilyPage } from "../../brand-read/StudioBrandReadClient";
import type { SelectedEvidence } from "./workbench-state";

export function FamiliesView({
  data,
  selection,
  onSelect,
}: {
  readonly data: FamilyPage;
  readonly selection: SelectedEvidence;
  readonly onSelect: (selection: SelectedEvidence) => void;
}) {
  if (data.page.count === 0) return <p className="empty-state">No families are available on this page.</p>;

  return (
    <div className="domain-view families-view">
      <p className="page-summary">
        Page contains {data.page.count} of up to {data.page.size} records. View digest: <code>{data.viewDigest}</code>
      </p>
      {data.page.items.map((family) => (
        <section className="domain-card" key={family.id} aria-labelledby={`family-${family.id}`}>
          <h4 id={`family-${family.id}`}>{family.name}</h4>
          <p><code>{family.id}</code> · {family.complete ? "Complete" : "Incomplete"}</p>
          <dl className="summary-grid">
            <div><dt>Required roles</dt><dd>{family.requiredRoles.join(", ") || "None"}</dd></div>
            <div><dt>Optional roles</dt><dd>{family.optionalRoles.join(", ") || "None"}</dd></div>
          </dl>

          <h5>Variants</h5>
          <ul className="semantic-list">
            {family.variants.map((variant) => (
              <li key={variant.id}>
                <code>{variant.id}</code> · {variant.colorMode}, {variant.scale}, {variant.status} · surfaces {variant.backgrounds.join(", ")}{variant.minimumWidthPx ? ` · min ${variant.minimumWidthPx}×${variant.minimumHeightPx ?? "any"}` : ""}
              </li>
            ))}
          </ul>

          <h5>Constrained requirements</h5>
          {family.requirements.length ? (
            <ul className="semantic-list">
              {family.requirements.map((requirement, index) => (
                <li key={`${requirement.role}-${index}`}>
                  <code>{requirement.role}</code>
                  {requirement.background ? ` · ${requirement.background}` : ""}
                  {requirement.colorMode ? ` · ${requirement.colorMode}` : ""}
                  {requirement.scale ? ` · ${requirement.scale}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p>None.</p>
          )}

          <h5>Explicit bindings</h5>
          <table>
            <caption>{family.id} bindings</caption>
            <thead>
              <tr>
                <th scope="col">Target</th>
                <th scope="col">Asset</th>
                <th scope="col">Authority/state</th>
                <th scope="col">Visual target</th>
              </tr>
            </thead>
            <tbody>
              {family.bindings.map((binding) => {
                const bindingKey = `${binding.family}/${binding.role}/${binding.variant}`;
                const assetLabel = `Asset ${binding.asset} (${bindingKey})`;
                const assetSelected = selection.kind === "project-asset"
                  && selection.target.assetId === binding.asset
                  && selection.label === assetLabel;
                const bindingSelected = selection.kind === "project-binding"
                  && selection.target.family === binding.family
                  && selection.target.role === binding.role
                  && selection.target.variant === binding.variant;

                return (
                  <tr key={`${bindingKey}/${binding.asset}`}>
                    <th scope="row"><code>{bindingKey}</code></th>
                    <td><code>{binding.asset}</code></td>
                    <td>{binding.authority}{binding.derivedState ? ` · ${binding.derivedState}` : " · current"}</td>
                    <td>
                      <label>
                        <input
                          type="radio"
                          name="family-visual-target"
                          checked={assetSelected}
                          onChange={() => onSelect({
                            kind: "project-asset",
                            label: assetLabel,
                            assetId: binding.asset,
                            target: { kind: "asset", assetId: binding.asset },
                            width: 256,
                            height: 256,
                            background: "transparent",
                          })}
                        /> Asset
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="family-visual-target"
                          checked={bindingSelected}
                          onChange={() => onSelect({
                            kind: "project-binding",
                            label: bindingKey,
                            assetId: binding.asset,
                            target: { kind: "binding", family: binding.family, role: binding.role, variant: binding.variant },
                            width: 256,
                            height: 256,
                            background: "transparent",
                          })}
                        /> Binding
                      </label>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

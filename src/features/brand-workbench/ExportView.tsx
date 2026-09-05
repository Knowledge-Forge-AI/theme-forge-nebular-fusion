import type { ExportCapability, ExportStatusPage, VisualTarget } from "../../brand-read/StudioBrandReadClient";
import type { SelectedEvidence } from "./workbench-state";

export function ExportView({
  capability,
  status,
  selection,
  onSelect,
}: {
  readonly capability: ExportCapability;
  readonly status: ExportStatusPage;
  readonly selection: SelectedEvidence;
  readonly onSelect: (selection: SelectedEvidence) => void;
}) {
  return (
    <div className="domain-view export-view">
      <h4>Fixed raster capability</h4>
      {capability.available ? (
        <dl className="summary-grid">
          <div><dt>Adapter</dt><dd>{capability.adapterId}</dd></div>
          <div><dt>Renderer</dt><dd>{capability.rendererPackage} {capability.rendererVersion}</dd></div>
          <div><dt>Build digest</dt><dd><code>{capability.rendererBuildDigest}</code></dd></div>
          <div><dt>Qualification</dt><dd><code>{capability.qualificationId}</code></dd></div>
          <div><dt>Platform</dt><dd>{capability.platformClaim}; Node {capability.nodeMajor}</dd></div>
        </dl>
      ) : (
        <p className="empty-state">The exact qualified raster adapter is unavailable.</p>
      )}

      <h4>Profiles and outputs</h4>
      {status.page.count === 0 ? (
        <p className="empty-state">No export outputs are declared.</p>
      ) : (
        <table>
          <caption>Existing export output status</caption>
          <thead>
            <tr>
              <th scope="col">Output</th>
              <th scope="col">Selector/destination</th>
              <th scope="col">Configuration</th>
              <th scope="col">Ownership and digests</th>
              <th scope="col">Visual target</th>
            </tr>
          </thead>
          <tbody>
            {status.page.items.map((output) => {
              const selector = output.assetId
                ? `asset ${output.assetId}`
                : output.binding
                  ? `${output.binding.family}/${output.binding.role}/${output.binding.variant}`
                  : "unresolved";
              const target: VisualTarget | null = output.assetId
                ? { kind: "asset", assetId: output.assetId }
                : output.binding
                  ? { kind: "binding", ...output.binding }
                  : null;
              const selectable = target && output.width && output.height && output.canonicalAssetDigest && output.svgDigest;
              const selected = selection.kind === "export-output-target"
                && selection.profileId === output.profileId
                && selection.outputId === output.outputId;
              return (
                <tr key={`${output.profileId}/${output.outputId}`}>
                  <th scope="row"><code>{output.profileId}/{output.outputId}</code></th>
                  <td>{selector}<br /><code>{output.destination}</code></td>
                  <td>
                    {output.width ?? "?"}×{output.height ?? "?"}; {output.purpose ? `purpose: ${output.purpose}` : "default purpose"}; {output.background ? `background: ${output.background}` : "default background"}; alpha: {output.alpha ?? "default"}
                  </td>
                  <td>
                    {output.state}
                    <details>
                      <summary>Complete digests</summary>
                      <code>{JSON.stringify({
                        canonicalAssetDigest: output.canonicalAssetDigest,
                        svgDigest: output.svgDigest,
                        profileDigest: output.profileDigest,
                        outputConfigDigest: output.outputConfigDigest,
                        pngDigest: output.pngDigest,
                        decodedPixelDigest: output.decodedPixelDigest,
                        receiptDigest: output.receiptDigest,
                      })}</code>
                    </details>
                  </td>
                  <td>
                    {selectable ? (
                      <label>
                        <input
                          type="radio"
                          name="export-visual-target"
                          checked={selected}
                          onChange={() => onSelect({
                            kind: "export-output-target",
                            label: `${output.profileId}/${output.outputId}`,
                            profileId: output.profileId,
                            outputId: output.outputId,
                            assetId: output.assetId ?? selector,
                            target,
                            width: output.width ?? 16,
                            height: output.height ?? 16,
                            background: output.background ?? "transparent",
                            output,
                          })}
                        /> Select exact output
                      </label>
                    ) : "Not renderable"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

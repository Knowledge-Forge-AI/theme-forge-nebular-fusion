import type { BrandStatus } from "../../brand-read/StudioBrandReadClient";

export function OverviewView({ status }: { readonly status: BrandStatus }) {
  if (!status.present) return <p className="empty-state">This project has no declared brand system. Raster capability is {status.raster.available ? "available" : "unavailable"}.</p>;
  return <div className="domain-view overview-view">
    <dl className="summary-grid"><div><dt>Brand digest</dt><dd><code>{status.brandDigest}</code></dd></div><div><dt>System digest</dt><dd><code>{status.brandSystemDigest ?? "Unavailable"}</code></dd></div><div><dt>Completeness</dt><dd>{status.completeness.satisfied ? "Complete" : "Incomplete"}</dd></div><div><dt>Raster</dt><dd>{status.raster.available ? "Available" : "Unavailable"}</dd></div></dl>
    <h4>Domain availability</h4><table><caption>Brand domain states and exact digests</caption><thead><tr><th scope="col">Domain</th><th scope="col">State</th><th scope="col">Digest</th></tr></thead><tbody>{status.domains.map((domain) => <tr key={domain.domain}><th scope="row">{domain.domain}</th><td>{domain.state}</td><td><code>{domain.digest ?? "None"}</code></td></tr>)}</tbody></table>
    <h4>Inventory counts</h4><dl className="count-grid">{Object.entries(status.counts).map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl>
    <h4>Derived state</h4><dl className="count-grid">{Object.entries(status.derived).map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl>
    <h4>Operational summaries</h4><ul className="semantic-list"><li>QA: {status.counts.qaProfiles} profiles, {status.counts.qaCases} cases, {status.counts.qaBaselines} baselines</li><li>Consumer lock: {status.consumerLock.status}; {status.consumerLock.packages} packages, {status.consumerLock.profiles} profiles, {status.consumerLock.mappings} mappings</li><li>Exports: {status.export.outputs} outputs and {status.export.receipts} receipts</li><li>Completeness counts: {status.completeness.familyCount} families, {status.completeness.variantCount} variants, {status.completeness.bindingCount} bindings, {status.completeness.requirementCount} requirements</li></ul>
  </div>;
}

import { useEffect, useMemo, useState } from "react";
import type { ConsumerProfilePage } from "../../brand-read/StudioBrandReadClient";
import type { StudioBrandPlanStartRequest } from "../../brand-plans/contracts";
import type { StudioSourceOpen } from "../../protocol/contracts";
import type { Proposal } from "../../design-evidence/types";

export function ConsumerPlanForm({ projectHandle, profiles, sources, selectedSourceHandles, disabled, prefill, onSourceSelection, onCreate }: { readonly projectHandle: string; readonly profiles: ConsumerProfilePage; readonly sources: readonly StudioSourceOpen[]; readonly selectedSourceHandles: readonly string[]; readonly disabled: boolean; readonly prefill?: Extract<Proposal, { readonly kind: "consumer-install" | "consumer-sync" }> | undefined; readonly onSourceSelection: (handles: readonly string[]) => void; readonly onCreate: (request: StudioBrandPlanStartRequest) => void }) {
  const [operation, setOperation] = useState<"install" | "sync">("install"); const [profileIds, setProfileIds] = useState<readonly string[]>([]); const [values, setValues] = useState<Readonly<Record<string, string>>>({}); const [reuseLock, setReuseLock] = useState(true);
  const selectedProfiles = useMemo(() => profiles.page.items.filter((profile) => profileIds.includes(profile.qualifiedProfileId)), [profiles, profileIds]);
  useEffect(() => { setValues({}); }, [profileIds.join("\0")]);
  useEffect(() => {
    if (!prefill) return;
    setOperation(prefill.kind === "consumer-install" ? "install" : "sync");
    setReuseLock(prefill.kind === "consumer-sync" && prefill.profileIds === undefined);
    const handles = prefill.sourcePackages.map((identity) => sources.find((source) => source.packageId === identity.packageId && source.brandVersion === identity.brandVersion && source.brandSystemDigest === identity.brandSystemDigest)?.sourceHandle).filter((value): value is string => Boolean(value));
    onSourceSelection(handles);
    setProfileIds(prefill.profileIds?.filter((id) => profiles.page.items.some((profile) => profile.qualifiedProfileId === id)) ?? []);
    setValues(Object.fromEntries((prefill.parameters ?? []).flatMap((parameter) => parameter.values.map((value) => [`${parameter.profileId}\0${value.parameter}`, value.value]))));
  }, [prefill, profiles, sources, onSourceSelection]);
  const toggle = (values: readonly string[], value: string) => values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value].sort();
  const parameters = selectedProfiles.flatMap((item) => item.profile.parameters.map((parameter) => ({ profileId: item.qualifiedProfileId, parameter })));
  const complete = parameters.every(({ profileId, parameter }) => Boolean(values[`${profileId}\0${parameter.id}`]));
  const create = () => {
    const parameters = selectedProfiles.map((profile) => ({ profileId: profile.qualifiedProfileId, values: profile.profile.parameters.map((parameter) => ({ parameter: parameter.id, value: values[`${profile.qualifiedProfileId}\0${parameter.id}`]! })) }));
    if (operation === "install") onCreate({ kind: "create-consumer-install", projectHandle, sourceHandles: selectedSourceHandles, profileIds, parameters });
    else onCreate({ kind: "create-consumer-sync", projectHandle, sourceHandles: selectedSourceHandles, ...(reuseLock ? {} : { profileIds, parameters }) });
  };
  return <fieldset disabled={disabled}><legend>Create a typed consumer plan</legend><label>Operation <select value={operation} onChange={(event) => setOperation(event.target.value as "install" | "sync")}><option value="install">Install</option><option value="sync">Sync</option></select></label>{operation === "sync" ? <label><input type="checkbox" checked={reuseLock} onChange={(event) => setReuseLock(event.target.checked)} /> Reuse exact lock profile and parameter selection</label> : null}<h5>Verified sources (1–8)</h5><ul>{sources.map((source) => <li key={source.sourceHandle}><label><input type="checkbox" checked={selectedSourceHandles.includes(source.sourceHandle)} onChange={() => onSourceSelection(toggle(selectedSourceHandles, source.sourceHandle))} /> {source.packageId ?? source.authorityKind} · {source.authorityKind}</label></li>)}</ul>{operation === "install" || !reuseLock ? <><h5>Qualified profiles</h5><ul>{profiles.page.items.map((profile) => <li key={profile.qualifiedProfileId}><label><input type="checkbox" checked={profileIds.includes(profile.qualifiedProfileId)} onChange={() => setProfileIds(toggle(profileIds, profile.qualifiedProfileId))} /> <code>{profile.qualifiedProfileId}</code></label></li>)}</ul>{parameters.map(({ profileId, parameter }) => <label key={`${profileId}/${parameter.id}`}>{profileId} / {parameter.id} <select value={values[`${profileId}\0${parameter.id}`] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [`${profileId}\0${parameter.id}`]: event.target.value }))}><option value="">Choose an allowed value</option>{parameter.values.map((value) => <option key={value}>{value}</option>)}</select></label>)}</> : null}<button type="button" disabled={selectedSourceHandles.length === 0 || selectedSourceHandles.length > 8 || ((operation === "install" || !reuseLock) && (profileIds.length === 0 || !complete))} onClick={create}>Review consumer {operation} plan</button></fieldset>;
}

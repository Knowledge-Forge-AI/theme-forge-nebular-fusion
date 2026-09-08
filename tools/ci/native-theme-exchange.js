// Included only by the explicitly instrumented native-smoke host.
// Drives the real component; packet creation and file selection stay host-owned.
window.__runThemeExchangeSmoke = async ({ results, waitFor, sleep }) => {
  const button = (label) => [...document.querySelectorAll("button")].find((el) => (el.textContent.trim() === label || (label === "Design Exchange" && el.textContent.trim().startsWith("Design Exchange ("))));
  const click = async (label) => (await waitFor(() => button(label), `exchange_button_${label}`)).click();
  const set = async (selector, value) => {
    const el = await waitFor(() => document.querySelector(selector), `exchange_control_${selector}`);
    const prototype = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(50);
  };
  const status = (text) => waitFor(() => document.body.textContent.includes(text), `exchange_status_${text}`);
  const scenario = window.__TFSB_EXCHANGE_SCENARIO__;
  const candidateIds = scenario?.candidateIds ?? ["native-alternative-a", "native-alternative-b"];
  const preferred = scenario?.preferredIndex ?? 1;
  const preferredId = candidateIds[preferred];
  const rgb = (hex) => hex.slice(1).match(/../g).map(pair => parseInt(pair, 16)).join(", ");
  const snapshotDraft = async () => {
    await click("CSS & Descriptor");
    const descriptor = JSON.parse(document.querySelector('[aria-label="Theme descriptor JSON"]').value);
    await click("Design Exchange");
    return descriptor.inputDigest;
  };
  if (scenario) {
    await click("Open…");
    await status("Discard Unsaved Changes?");
    await click("Discard & Proceed");
    await status("Opened baseline.theme.json");
    results.steps.push("exchange_nova_baseline_opened");
  }
  await click("Design Exchange");
  await status("No design candidates imported yet");
  results.steps.push("exchange_starts_empty");
  await set("#brief-id-input", scenario?.briefId ?? "native-exchange-brief");
  await set("#brief-title-input", scenario?.title ?? "Native human exchange");
  await set("#brief-goal-input", scenario?.goal ?? "Compare two accent alternatives using local compilation");
  await set("#brief-allowed-fields", scenario?.allowedFields ?? "colors.dark.accent.base, colors.dark.neutrals.textAccent");
  if (scenario) {
    await set("#brief-acceptance-criteria", scenario.acceptance);
    await set("#brief-prohibited-changes", scenario.prohibited);
    const template = [...document.querySelectorAll("label")].find(el => el.textContent.includes("Allow page title frame template"))?.querySelector("input");
    if (!template.checked) template.click();
  }
  const exportedDraftDigest = await snapshotDraft();
  await click("Export Brief…");
  await status("Exported brief");
  results.steps.push("exchange_brief_exported");
  // The instrumented launcher creates alternatives from the just-exported brief.
  await waitFor(() => window.__TFSB_EXCHANGE_READY__ === true, "exchange_alternatives_ready");
  await click("Import Packet…");
  await status("Design Candidates (1)");
  await click("Import Packet…");
  await status("Design Candidates (2)");
  if (document.querySelector('.candidate-chip[aria-selected="true"]')) throw new Error("Import selected a candidate implicitly");
  if (await snapshotDraft() !== exportedDraftDigest) throw new Error("Import replaced the working draft");
  results.steps.push("exchange_two_alternatives_imported");
  const choose = async (id) => {
    const tab = await waitFor(() => [...document.querySelectorAll(".candidate-chip")].find((el) => el.textContent.includes(id)), `select_${id}`);
    tab.click();
    await sleep(50);
  };
  const comparison = [];
  if (scenario) {
    for (let index = 0; index < candidateIds.length; index++) {
      await choose(candidateIds[index]);
      await click("Preview Candidate");
      await status(`Previewing ${candidateIds[index]}`);
      await waitFor(() => document.querySelector("iframe.preview-iframe")?.dataset.computedAccent?.includes(rgb(scenario.accents[index])) || document.querySelector("iframe.preview-iframe")?.dataset.computedAccent?.includes(scenario.accents[index].slice(1)), `nova_preview_${index}`);
      const frame = document.querySelector("iframe.preview-iframe");
      await waitFor(() => document.querySelector("iframe.preview-iframe")?.dataset.renderedLinkColor?.includes(rgb(scenario.linkColors[index])), `nova_link_${index}`);
      const diagnostics = [...document.querySelectorAll('[aria-label="Locally compiled candidate contrast diagnostics"] li')].map(el => el.textContent);
      if (diagnostics.length !== 6 || !diagnostics.every(text => text.includes("pass"))) throw new Error("Missing real local candidate diagnostics");
      if (!document.body.textContent.includes("Claimed Provenance:")) throw new Error("Sender provenance not distinguished");
      comparison.push({ candidateId: candidateIds[index], accent: frame.dataset.computedAccent, link: frame.dataset.renderedLinkColor, diagnostics });
      await set('[aria-label="Annotation field path"]', "typography.bodyFont");
      await set('[aria-label="Annotation comment"]', index === preferred ? "Compact sans hierarchy preferred after installed light/dark comparison" : "Spacious serif alternative retained for editorial comparison");
      await click("Add Annotation");
      await set("#candidate-disposition-select", index === preferred ? "preferred" : "deferred");
      await set("#candidate-disposition-comment", index === preferred ? "Provisional technical-documentation selection" : "Useful editorial alternative; less terminal character");
      await click("Restore Draft Preview");
    }
    results.steps.push("exchange_both_nova_candidates_verified_previewed");
    // Make a genuine unsaved replacement after the brief has been bound.
    await click("Palette");
    await set('input[aria-label="Accent base hex code"]', "#ee9955");
    await click("Compile");
    await waitFor(() => document.querySelector("iframe.preview-iframe")?.dataset.computedAccent?.includes("ee9955") || document.querySelector("iframe.preview-iframe")?.dataset.computedAccent?.includes("238, 153, 85"), "nova_dirty_draft_compiled");
    await click("Design Exchange");
  }
  await choose(preferredId);
  const before = document.querySelector("iframe.preview-iframe")?.dataset.computedAccent;
  const beforeLinkColor = document.querySelector("iframe.preview-iframe")?.dataset.renderedLinkColor;
  await click("Preview Candidate");
  await status(`Previewing ${preferredId}`);
  await waitFor(() => {
    const accent = document.querySelector("iframe.preview-iframe")?.dataset.computedAccent;
    return accent && accent !== before && (accent.includes((scenario?.accents[preferred] ?? "#d946ef").slice(1)) || accent.includes(rgb(scenario?.accents[preferred] ?? "#d946ef")));
  }, "exchange_candidate_rendered");
  results.measurements.exchange = { comparison, beforeAccent: before, candidateAccent: document.querySelector("iframe.preview-iframe").dataset.computedAccent };
  const afterLinkColor = document.querySelector("iframe.preview-iframe")?.dataset.renderedLinkColor;
  results.measurements.exchange.renderedLink = { selector: ".sl-markdown-content p a", beforeColor: beforeLinkColor, afterColor: afterLinkColor };
  if (!beforeLinkColor || !afterLinkColor || (!scenario && beforeLinkColor === afterLinkColor)) throw new Error("Rendered Starlight link did not change color");
  if (scenario && afterLinkColor !== `rgb(${rgb(scenario.linkColors[preferred])})`) throw new Error("Rendered Starlight link does not match the selected candidate");
  results.steps.push("exchange_real_candidate_preview");
  await click("Restore Draft Preview");
  await waitFor(() => document.querySelector("iframe.preview-iframe")?.dataset.computedAccent === before, "exchange_draft_preview_restored");
  results.steps.push("exchange_draft_preview_restored");
  await click("Preview Candidate");
  await status(`Previewing ${preferredId}`);
  await set('[aria-label="Annotation field path"]', "colors.dark.accent.base");
  await set('[aria-label="Annotation comment"]', "Compared this accent in the local preview");
  await click("Add Annotation");
  await set("#candidate-disposition-select", "preferred");
  await set("#candidate-disposition-comment", "Selected after local comparison");
  await set("#review-id-input", scenario ? "terminal-nova-design-review" : "native-exchange-review");
  await set("#overall-disposition-select", "preferred");
  const selectedDigest = document.querySelector(".candidate-detail-card .digest-tag").textContent;
  await set("#overall-candidate-select", selectedDigest);
  await set("#review-summary-text", scenario ? "Forge Console provisionally preferred after both installed designs and local previews; no final aesthetic approval claimed." : "Prefer the second alternative after local inspection");
  const reviewControls = () => Object.fromEntries(["review-id-input", "overall-disposition-select", "overall-candidate-select", "review-summary-text"].map(id => [id, document.getElementById(id).value]));
  const candidateControls = () => ({ disposition: document.querySelector("#candidate-disposition-select").value, comment: document.querySelector("#candidate-disposition-comment").value, annotations: [...document.querySelectorAll(".annotation-item")].map(el => el.textContent) });
  const expectedReview = reviewControls();
  const expectedCandidates = {};
  for (const id of candidateIds) { await choose(id); expectedCandidates[id] = candidateControls(); }
  await choose(preferredId);
  await click("Export Review…");
  await status("Exported review");
  results.steps.push("exchange_review_exported");
  const dirtyDigest = await snapshotDraft();
  await set("#candidate-disposition-comment", "temporary edit");
  await set("#review-id-input", "temporary-review");
  await set("#review-summary-text", "temporary summary");
  await set("#overall-disposition-select", "no-decision");
  for (const id of candidateIds) {
    await choose(id);
    await set("#candidate-disposition-select", "needs-revision");
    await set("#candidate-disposition-comment", "temporary candidate");
    const remove = [...document.querySelectorAll(".annotation-item button")];
    for (const button of remove) button.click();
  }
  await click("Import Packet…");
  await waitFor(() => document.querySelector("#candidate-disposition-comment")?.value === "Selected after local comparison", "exchange_review_restored");
  if (!document.querySelector('.candidate-chip[aria-selected="true"]')?.textContent.includes(preferredId)) throw new Error("Review restored the wrong candidate selection");
  await status("Compared this accent in the local preview");
  if (JSON.stringify(reviewControls()) !== JSON.stringify(expectedReview)) throw new Error("Incomplete review control restoration");
  for (const id of candidateIds) {
    await choose(id);
    if (JSON.stringify(candidateControls()) !== JSON.stringify(expectedCandidates[id])) throw new Error(`Incomplete candidate restoration: ${id}`);
  }
  await choose(preferredId);
  results.measurements.exchange.reviewRestoration = { controls: expectedReview, candidates: expectedCandidates, selectedCandidate: preferredId };
  results.steps.push("exchange_review_reimport_restored");
  // Re-verification remains mandatory after replacing review controls.
  if (button("Restore Draft Preview")) await click("Restore Draft Preview");
  await click("Preview Candidate");
  await status(`Previewing ${preferredId}`);
  await click("Use as Draft");
  await status("Discard Unsaved Changes?");
  await click("Cancel");
  await status("* Modified");
  if (await snapshotDraft() !== dirtyDigest) throw new Error("Cancelled adoption replaced the draft");
  results.steps.push("exchange_dirty_adoption_cancelled");
  await click("Use as Draft");
  await click("Discard & Adopt");
  await status("Adopted candidate");
  await status("* Modified");
  results.steps.push("exchange_candidate_adopted_unsaved");
  await click("CSS & Descriptor");
  const descriptor = JSON.parse(document.querySelector('[aria-label="Theme descriptor JSON"]').value);
  const css = document.querySelector('[aria-label="Compiled CSS output"]').value;
  const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(css));
  const cssDigest = [...new Uint8Array(digestBytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (descriptor.outputDigest !== cssDigest) throw new Error("Adopted CSS digest mismatch");
  results.measurements.exchange.themeDigest = `sha256:${descriptor.inputDigest}`;
  results.measurements.exchange.cssDigest = cssDigest;
  await click("Save");
  await waitFor(() => !document.body.textContent.includes("* Modified"), "exchange_saved");
  results.steps.push("exchange_adopted_specification_saved");
};

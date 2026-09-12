// Injected only by the native-smoke feature; no production bridge extensions.
(async () => {
  const result={schema:"tfsb.native-scene-workbench-smoke-v1",runtime:"macOS-WKWebView",status:"running",steps:[],measurements:{}};
  const wait=async(fn,label)=>{const deadline=Date.now()+20000;while(Date.now()<deadline){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,100));}throw new Error(label);};
  const invoke=(name,request)=>window.__TAURI_INTERNALS__.invoke(name,{request});
  const tab=name=>Array.from(document.querySelectorAll("nav.destination-nav button")).find(b=>b.textContent.trim()===name);
  try {
    (await wait(()=>tab("Vector / Graphics"),"vector navigation unavailable")).click();
    await wait(()=>{const image=document.querySelector('[data-testid="inert-blob-img"]');return image?.complete&&image.naturalWidth>0&&image.src.startsWith("blob:");},"engine preview failed to load");
    const before=await invoke("studio_scene_status",{});
    result.steps.push("react-create-rust-burst-webview-preview");
    result.measurements.initial={sessionId:before.sessionId,revision:before.revision,draftInputDigest:before.draftInputDigest,svgDigest:before.compiledSvgDigest};
    const area=document.querySelector('.work-area[data-destination="vector-graphics"]');
    const layers=Array.from(area.querySelectorAll("button")).find(b=>b.textContent.trim().startsWith("Layers"));
    if(!layers)throw new Error("layers navigation missing");layers.click();
    const add=await wait(()=>area.querySelector('[aria-label="Add Layer"]')||area.querySelector('[aria-label="Add Rect"]'),"rect insertion control missing");
    add.click();
    const after=await wait(async()=>{const s=await invoke("studio_scene_status",{});return s.revision>before.revision?s:null;},"typed edit not acknowledged");
    let rejected=false;
    try{await invoke("studio_scene_compile",{expected:{sessionId:before.sessionId,revision:before.revision,draftInputDigest:before.draftInputDigest}});}catch{rejected=true;}
    if(!rejected)throw new Error("stale compile accepted");
    result.steps.push("react-edit-monotonic-revision","stale-native-compile-rejected");
    tab("Brand / System").click();
    await wait(()=>area.hidden&&area.inert,"inactive vector area is not hidden/inert");
    tab("Starlight Theme").click();
    await wait(()=>document.querySelector('.work-area:not([hidden]) .theme-lab-workspace'),"theme area unavailable");
    tab("Vector / Graphics").click();
    await wait(()=>!area.hidden&&!area.inert,"vector return unavailable");
    const restored=await invoke("studio_scene_status",{});
    if(restored.sessionId!==after.sessionId||restored.revision!==after.revision||!restored.dirty)throw new Error("unsaved scene lost during work-area switch");
    result.steps.push("three-work-area-unsaved-persistence");
    result.measurements.edited={revision:restored.revision,dirty:restored.dirty};
    result.status="pass";
  }catch(error){result.status="fail";result.error=error instanceof Error?error.message:"native scene smoke failed";}
  window.__TFSB_SMOKE_RESULT__=JSON.stringify(result);
})();

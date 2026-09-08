import { useEffect, useState } from "react";
import type { ThemeVisualRecord } from "./types";

export function SenderEvidenceImage({ evidence, candidateDigest }: { evidence: ThemeVisualRecord; candidateDigest: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    setUrl(undefined);
    if (evidence.presence !== "included" || !evidence.bytesBase64 || evidence.bytesBase64.length > 8 * 1024 * 1024) return;
    let objectUrl: string | undefined;
    try {
      const bytes = Uint8Array.from(atob(evidence.bytesBase64), (character) => character.charCodeAt(0));
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
      setUrl(objectUrl);
    } catch {
      setUrl(undefined);
    }
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [evidence, candidateDigest]);
  return url
    ? <img src={url} alt={`Sender-supplied evidence for ${evidence.fixtureId ?? "candidate"} in ${evidence.mode ?? "unknown"} mode`} width={evidence.width} height={evidence.height} />
    : <span>Optional sender image unavailable</span>;
}

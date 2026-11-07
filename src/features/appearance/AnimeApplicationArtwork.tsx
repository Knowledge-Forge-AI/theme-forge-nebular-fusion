import { useState } from "react";

const ANIME_ARTWORK_SOURCE = "/appearance-artwork/anime/cartographer-v2.png";

export interface AnimeApplicationArtworkProps {
  readonly visible: boolean;
}

/** Decorative application chrome only; appearance controls remain authoritative. */
export function AnimeApplicationArtwork({ visible }: AnimeApplicationArtworkProps) {
  const [imageFailed, setImageFailed] = useState(false);
  if (!visible) return null;

  return (
    <div
      className="anime-application-artwork"
      data-artwork-state={imageFailed ? "fallback" : "image"}
      data-testid="anime-application-artwork"
    >
      <span className="anime-application-artwork__label">Anime family · decorative artwork</span>
      <img
        className="anime-application-artwork__image"
        data-testid="anime-application-artwork-image"
        src={ANIME_ARTWORK_SOURCE}
        alt=""
        onError={() => setImageFailed(true)}
      />
      <p className="anime-application-artwork__fallback" data-testid="anime-application-artwork-fallback">
        Decorative artwork unavailable; appearance controls remain available.
      </p>
    </div>
  );
}

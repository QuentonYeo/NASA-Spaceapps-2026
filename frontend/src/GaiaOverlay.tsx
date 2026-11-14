import { useEffect, useState } from 'react';
import type { GaiaCatalogue, SkyQuery } from './api/frames';
import { projectGaia } from './state/gaiaProjection';

interface OverlayProps {
  catalogue: GaiaCatalogue;
  query: SkyQuery;
  observedAt: string;
  image: string;
  side: number;
}

export function GaiaMarkers({ catalogue, query, observedAt, image, side }: OverlayProps) {
  const [mask, setMask] = useState<{ image: string; bytes: Uint8ClampedArray }>();
  useEffect(() => {
    const preview = new Image();
    preview.onload = () => {
      if (preview.naturalWidth !== side || preview.naturalHeight !== side) return;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = side;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(preview, 0, 0);
      setMask({ image, bytes: context.getImageData(0, 0, side, side).data });
    };
    preview.src = image;
    return () => { preview.onload = null; };
  }, [image, side]);

  if (mask?.image !== image) return null;
  return <svg className="gaia-markers" viewBox={`0 0 ${side} ${side}`} aria-label="Gaia DR3 catalogue positions" role="img">
    {catalogue.sources.map((source) => {
      const point = projectGaia(source, query, observedAt, side);
      if (!point || !mask.bytes[4 * (Math.floor(point.y) * side + Math.floor(point.x)) + 3]) return null;
      return <circle key={source.sourceId} cx={point.x} cy={point.y} r={Math.max(1, side * 0.012)}>
        <title>{`Gaia DR3 ${source.sourceId} · G ${source.gMagnitude.toFixed(2)}`}</title>
      </circle>;
    })}
  </svg>;
}

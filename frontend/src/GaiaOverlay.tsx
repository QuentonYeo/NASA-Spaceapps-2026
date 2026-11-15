import { useEffect, useState } from 'react';
import type { GaiaCatalogue, SkyQuery } from './api/frames';
import { FrameMarker } from './components/FrameMarker';
import { projectGaia } from './state/gaiaProjection';

interface OverlayProps {
  catalogue: GaiaCatalogue;
  query: SkyQuery;
  observedAt: string;
  image: string;
  side: number;
  showLabels: boolean;
  showDetails: boolean;
  onInspect: () => void;
}

export function GaiaMarkers({ catalogue, query, observedAt, image, side, showLabels, showDetails, onInspect }: OverlayProps) {
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
  const markers = catalogue.sources.flatMap((source, index) => {
    const point = projectGaia(source, query, observedAt, side);
    const label = `G${index + 1}`;
    if (!point || !mask.bytes[4 * (Math.floor(point.y) * side + Math.floor(point.x)) + 3]) return [];
    return [{ ...point, label, id: source.sourceId,
      title: `${label} · Gaia DR3 ${source.sourceId} · G magnitude ${source.gMagnitude.toFixed(2)}` }];
  });

  return <>
    {showDetails ? markers.map(({ x, y, id, label }) => <FrameMarker key={id}
      label={`Gaia ${label}`} kind="Reference star" enabled onInspect={onInspect} className="gaia-hover-marker"
      style={{ left: `${100 * x / side}%`, top: `${100 * y / side}%` }} />)
      : <svg className="gaia-markers" viewBox={`0 0 ${side} ${side}`} aria-label="Gaia DR3 catalogue positions" role="img">
        {markers.map(({ x, y, id, title }) => <circle key={id} cx={x} cy={y} r={Math.max(1, side * 0.012)}>
          <title>{title}</title>
        </circle>)}
      </svg>}
    {showLabels && <div className="gaia-labels">
      {markers.map(({ x, y, id, label, title }) => <span key={id} title={title}
        className={x > side * 0.75 ? 'gaia-label gaia-label-left' : 'gaia-label'}
        style={{ left: `${100 * x / side}%`, top: `${100 * y / side}%` }}>
        {label}
      </span>)}
    </div>}
  </>;
}

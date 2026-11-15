import { useEffect, useRef, useState } from 'react';
import type { PointerEvent, ReactNode } from 'react';
import type { Frame } from '../api/frames';
import { cachedRegionProjection, loadRegionProjection, regionProjectionKey } from '../api/regionProjection';
import type { Circle, Region } from '../api/regions';
import type { useFingerprint } from '../state/useFingerprint';

type RegionExplorer = Pick<ReturnType<typeof useFingerprint>, 'selection' | 'commit'> & { result: { region: Region } | null; region?: Region };
export function RegionImage({ frame, zoom, explorer, sequenceId, overlay, showBackground = true, clickToSelect = !showBackground, onRegionSelected }: { frame: Frame; zoom: string; explorer: RegionExplorer; sequenceId?: string; overlay?: ReactNode; showBackground?: boolean; clickToSelect?: boolean; onRegionSelected?: () => void }) {
  const width = frame.grid?.width, height = frame.grid?.height;
  const [draft, setDraft] = useState<Circle | null>(null);
  const start = useRef<Circle | null>(null);
  const [projection, setProjection] = useState<{ key: string; rings: number[][][] | null; error: string } | null>(null);
  const region = explorer.region ?? explorer.result?.region;
  const reference = explorer.selection?.referenceFrameId === frame.id;
  const projectionKey = sequenceId && region ? regionProjectionKey(sequenceId, frame.id, region) : '';
  const rings = cachedRegionProjection(projectionKey) ?? (projection?.key === projectionKey ? projection.rings : null);
  const projectionError = projection?.key === projectionKey ? projection.error : '';
  useEffect(() => {
    if (!sequenceId || !region || reference) return;
    let current = true;
    loadRegionProjection(sequenceId, frame.id, region)
      .then(rings => { if (current) setProjection({ key: projectionKey, rings, error: '' }) })
      .catch(() => { if (current) setProjection({ key: projectionKey, rings: null, error: 'Region overlay unavailable on this frame.' }) });
    return () => { current = false };
  }, [sequenceId, frame.id, region, reference, projectionKey]);
  function point(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(width! - 1, (e.clientX - rect.left) / rect.width * width! - .5)),
      y: Math.max(0, Math.min(height! - 1, (e.clientY - rect.top) / rect.height * height! - .5)) };
  }
  const circle = draft ?? (reference ? explorer.selection?.circle : null);
  return <><div className="native-image" style={{ width: `min(${zoom === 'fit' ? '90cqw' : `${(width ?? 29) * Number(zoom)}px`}, 90cqw, ${85 * (width ?? 1) / (height ?? 1)}cqh)`, aspectRatio: `${width ?? 1}/${height ?? 1}` }}>
    <img src={frame.imageData!} alt={`SPHEREx ${frame.detector} observation at ${frame.observedAtUtc}`} draggable={false} />
    {width && height && <svg viewBox={`0 0 ${width} ${height}`} aria-label="Draw circular region on native image" role="img"
      onPointerDown={e => { if (e.button !== 0 || (frame.scienceStatus && frame.scienceStatus !== 'retained')) return; e.currentTarget.setPointerCapture(e.pointerId); const p = { ...point(e), radiusPixels: 0 }; start.current = p; setDraft(p) }}
      onPointerMove={e => { if (start.current) { const p = point(e); setDraft({ ...start.current, radiusPixels: Math.hypot(p.x - start.current.x, p.y - start.current.y) }) } }}
      onPointerUp={e => { if (!start.current) return; const p = point(e); const c = { ...start.current, radiusPixels: Math.hypot(p.x - start.current.x, p.y - start.current.y) }; start.current = null; setDraft(null); if (c.radiusPixels >= .1) { explorer.commit(frame.id, c); onRegionSelected?.() } else if (clickToSelect) { explorer.commit(frame.id, { ...c, radiusPixels: 2 }); onRegionSelected?.() } }}
      onPointerCancel={() => { start.current = null; setDraft(null) }}>
      {circle && (showBackground ? [circle.radiusPixels, circle.innerRadiusPixels ?? circle.radiusPixels * 2, circle.outerRadiusPixels ?? circle.radiusPixels * 3] : [circle.radiusPixels]).map((r, i) => <circle key={i} cx={circle.x + .5} cy={circle.y + .5} r={r} className={i ? 'annulus' : 'aperture'} />)}
      {!draft && !reference && rings?.slice(0, showBackground ? 3 : 1).map((ring, i) => <polygon key={i} points={ring.map(p => p.join(',')).join(' ')} className={i ? 'annulus' : 'aperture'} />)}
      {/* Catalogue markers share native image edge coordinates; marker gestures must not draw a region. */}
      {overlay && <g onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()}>{overlay}</g>}
    </svg>}
  </div>{explorer.selection && !reference && !rings && !projectionError && <p className="overlay-note" role="status">Positioning selected sky region on this observation...</p>}{projectionError && <p className="overlay-note">{projectionError}</p>}</>;
}

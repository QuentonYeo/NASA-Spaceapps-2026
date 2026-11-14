import { useEffect, useRef, useState } from 'react';
import type { PointerEvent, ReactNode } from 'react';
import type { Frame } from '../api/frames';
import { plotDomain } from '../api/spectra';
import type { Circle, Sample, Spectrum } from '../api/spectra';
import type { useSpectrum } from '../state/useSpectrum';

type Explorer = ReturnType<typeof useSpectrum>;
const groupColor = (id: number) => ['#a4e7d2', '#f7bb77', '#b9acff', '#ff9cb5', '#82c9ff'][id % 5];
const number = (n: number | null | undefined) => n == null ? 'Unavailable' : n.toPrecision(4);

export function RegionControls({ explorer, frame }: { explorer: Explorer; frame?: Frame }) {
  const circle = explorer.selection?.circle;
  const [draft, setDraft] = useState<Circle | null>(circle ?? null);
  function apply() {
    if (!draft || !explorer.selection) return;
    if (![draft.x, draft.y, draft.radiusPixels].every(Number.isFinite) || draft.radiusPixels <= 0 ||
      (draft.innerRadiusPixels != null && (draft.innerRadiusPixels <= draft.radiusPixels || draft.outerRadiusPixels! <= draft.innerRadiusPixels))) return;
    explorer.commit(explorer.selection.referenceFrameId, draft);
  }
  return <section className="region-controls"><h2>Region spectrum</h2>
    <p className="hint">Drag from centre to edge on the image. Release to extract the same sky region across observations. Pixel centres are zero-based.</p>
    {frame?.grid && <button className="primary" onClick={() => explorer.commit(frame.id, { x: (frame.grid!.width - 1) / 2, y: (frame.grid!.height - 1) / 2, radiusPixels: Math.max(.5, Math.min(frame.grid!.width, frame.grid!.height) / 8) })}>Use circle at image centre</button>}
    {draft && <form onSubmit={e => { e.preventDefault(); apply() }}>
      {(['x', 'y', 'radiusPixels'] as const).map(key => <label key={key}>{key === 'radiusPixels' ? 'Radius (native pixels)' : `Centre ${key} (native pixels)`}
        <input type="number" step="any" required min={key === 'radiusPixels' ? .1 : 0} value={Number.isFinite(draft[key]) ? draft[key] : ''} onChange={e => setDraft({ ...draft, [key]: e.target.value === '' ? NaN : Number(e.target.value) })} /></label>)}
      <label>Custom background annulus<input type="checkbox" checked={draft.innerRadiusPixels != null} onChange={e => setDraft({ ...draft, innerRadiusPixels: e.target.checked ? draft.radiusPixels * 2 : undefined, outerRadiusPixels: e.target.checked ? draft.radiusPixels * 3 : undefined })} /></label>
      {draft.innerRadiusPixels != null && (['innerRadiusPixels', 'outerRadiusPixels'] as const).map(key => <label key={key}>{key === 'innerRadiusPixels' ? 'Inner' : 'Outer'} radius (pixels)<input required type="number" step="any" min={key === 'innerRadiusPixels' ? draft.radiusPixels + .01 : draft.innerRadiusPixels! + .01} value={draft[key]} onChange={e => setDraft({ ...draft, [key]: Number(e.target.value) })} /></label>)}
      <button className="primary" type="submit">Apply region</button>
    </form>}
    <p className="hint">Background-corrected mean brightness. Default background annulus: 2–3× aperture radius. Discovery covers the query centre only.</p>
    <p className="hint">Extraction rejects all flagged pixels, including SOURCE flags. Coverage uses pixel centres; uncertainty assumes independent noise.</p>
    {frame?.scienceStatus && frame.scienceStatus !== 'retained' && <p className="error">{frame.scienceStatus === 'retention_limit' ? 'Science retention limit reached for this frame; preview remains available.' : 'Science data unavailable for this frame.'}</p>}
    {explorer.selection && <p className="hint">Reference frame: {explorer.selection.referenceFrameId}</p>}
  </section>;
}

export function RegionImage({ frame, zoom, explorer, sequenceId, overlay }: { frame: Frame; zoom: string; explorer: Explorer; sequenceId?: string; overlay?: ReactNode }) {
  const width = frame.grid?.width, height = frame.grid?.height;
  const [draft, setDraft] = useState<Circle | null>(null);
  const start = useRef<Circle | null>(null);
  const [projection, setProjection] = useState<{ region: Spectrum['region']; rings: number[][][] | null; error: string } | null>(null);
  const region = explorer.result?.region;
  const reference = explorer.selection?.referenceFrameId === frame.id;
  const rings = projection?.region === region ? projection?.rings : null;
  const projectionError = projection?.region === region ? projection?.error : '';
  useEffect(() => {
    if (!sequenceId || !region || reference) return;
    const controller = new AbortController();
    fetch(`/api/frames/${encodeURIComponent(sequenceId)}/frames/${encodeURIComponent(frame.id)}/projection`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(region), signal: controller.signal,
    }).then(async response => { if (!response.ok) throw new Error(); return response.json() })
      .then(data => { if (!controller.signal.aborted) setProjection({ region, rings: data.rings, error: '' }) })
      .catch(() => { if (!controller.signal.aborted) setProjection({ region, rings: null, error: 'Region overlay unavailable on this frame.' }) });
    return () => controller.abort();
  }, [sequenceId, frame.id, region, reference]);
  function point(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(width! - 1, (e.clientX - rect.left) / rect.width * width! - .5)),
      y: Math.max(0, Math.min(height! - 1, (e.clientY - rect.top) / rect.height * height! - .5)) };
  }
  const circle = draft ?? (reference ? explorer.selection?.circle : null);
  return <><div className="native-image" style={{ width: `min(${zoom === 'fit' ? '90cqw' : `${(width ?? 29) * Number(zoom)}px`}, 90cqw, ${85 * (width ?? 1) / (height ?? 1)}cqh)`, aspectRatio: `${width ?? 1}/${height ?? 1}` }}>
    <img src={frame.imageData!} alt={`SPHEREx ${frame.detector} observation at ${frame.observedAtUtc}`} draggable={false} />
    {width && height && <svg viewBox={`0 0 ${width} ${height}`} aria-label="Draw circular region on native image" role="img"
      onPointerDown={e => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); const p = { ...point(e), radiusPixels: 0 }; start.current = p; setDraft(p) }}
      onPointerMove={e => { if (start.current) { const p = point(e); setDraft({ ...start.current, radiusPixels: Math.hypot(p.x - start.current.x, p.y - start.current.y) }) } }}
      onPointerUp={e => { if (!start.current) return; const p = point(e); const c = { ...start.current, radiusPixels: Math.hypot(p.x - start.current.x, p.y - start.current.y) }; start.current = null; setDraft(null); if (c.radiusPixels >= .1) explorer.commit(frame.id, c) }}
      onPointerCancel={() => { start.current = null; setDraft(null) }}>
      {circle && [circle.radiusPixels, circle.innerRadiusPixels ?? circle.radiusPixels * 2, circle.outerRadiusPixels ?? circle.radiusPixels * 3].map((r, i) => <circle key={i} cx={circle.x + .5} cy={circle.y + .5} r={r} className={i ? 'annulus' : 'aperture'} />)}
      {!draft && !reference && rings?.map((ring, i) => <polygon key={i} points={ring.map(p => p.join(',')).join(' ')} className={i ? 'annulus' : 'aperture'} />)}
      {/* Catalogue markers share native image edge coordinates; marker gestures must not draw a region. */}
      {overlay && <g onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()}>{overlay}</g>}
    </svg>}
  </div>{projectionError && <p className="overlay-note">{projectionError}</p>}</>;
}

export function SpectrumPanel({ explorer, groups, setGroups, selectedId, onSelect }: {
  explorer: Explorer; groups: number[]; setGroups: (g: number[]) => void; selectedId?: string; onSelect: (id: string) => void;
}) {
  const [hover, setHover] = useState<Sample | null>(null);
  const samples = explorer.result?.samples.filter(s => groups.includes(s.observationGroupId)) ?? [];
  const units = [...new Set(samples.filter(s => s.value != null).map(s => s.unit))];
  const domain = plotDomain(units.length <= 1 ? samples : []);
  const x = (v: number) => 65 + (v - domain.x[0]) / (domain.x[1] - domain.x[0]) * 395;
  const y = (v: number) => 265 - (v - domain.y[0]) / (domain.y[1] - domain.y[0]) * 235;
  return <section className="panel spectrum-panel" aria-label="Region spectrum"><h2>Spectrum</h2>
    {explorer.selection?.hostName && <p className="hint">Host/system spectrum: {explorer.selection.hostName}. The aperture includes unresolved light within the selected sky region.</p>}
    <label>Observation group<select aria-label="Observation group" value={groups[0] ?? ''} onChange={e => setGroups([Number(e.target.value)])}><option value="" disabled>Choose group</option>{explorer.groups.map(g => <option value={g} key={g}>Group {g + 1}</option>)}</select></label>
    <details><summary>Compare observation groups</summary>{explorer.groups.map(g => <label key={g} style={{ color: groupColor(g) }}><input type="checkbox" checked={groups.includes(g)} onChange={e => setGroups(e.target.checked ? [...groups, g].sort((a,b) => a-b) : groups.filter(id => id !== g))} />Group {g + 1}</label>)}</details>
    <p className="hint">Groups use a ten-day-gap heuristic; they are not verified flyby passes.</p>
    <div role="status" aria-live="polite">{explorer.busy ? 'Extracting updated measurements…' : explorer.result ? `${samples.length} measurements · ${explorer.result.pendingFrames} exposures pending` : 'Draw a region to extract a spectrum.'}</div>
    {explorer.error && <p className="error" role="alert">{explorer.error} <button onClick={explorer.retry}>Retry extraction</button></p>}
    {units.length > 1 && <p className="error">Mixed brightness units cannot share this axis. See measurements.</p>}
    {domain.valid.length > 0 ? <svg className="spectrum-plot" viewBox="0 0 490 330" role="img" aria-label={`Spectrum: wavelength in micrometres versus background-corrected mean brightness in ${units[0]}`}>
      <path d="M65 30V265H460" fill="none" stroke="#91a1b5" />
      <line x1="65" x2="460" y1={y(0)} y2={y(0)} stroke="#536273" strokeDasharray="3 4" />
      {[0, .5, 1].map(t => { const xv = domain.x[0] + t * (domain.x[1] - domain.x[0]); const yv = domain.y[0] + t * (domain.y[1] - domain.y[0]); return <g key={t}><text x={x(xv)} y="285" textAnchor="middle">{number(xv)}</text><text x="60" y={y(yv)} textAnchor="end">{number(yv)}</text></g> })}
      <text x="260" y="316" textAnchor="middle">Wavelength (µm)</text><text transform="translate(14 150) rotate(-90)" textAnchor="middle">Mean brightness ({units[0]})</text>
      {domain.valid.map(s => { const px = x(s.wavelengthUm!), py = y(s.value!); const range = s.wavelengthRangeUm ?? (s.bandwidthUm != null ? [s.wavelengthUm! - s.bandwidthUm / 2, s.wavelengthUm! + s.bandwidthUm / 2] : null); return <g key={s.frameId} style={{ color: groupColor(s.observationGroupId) }}>
        {range && <line x1={x(range[0])} x2={x(range[1])} y1={py} y2={py} stroke="currentColor" />}
        {s.uncertainty != null && <path d={`M${px} ${y(s.value! - s.uncertainty)}V${y(s.value! + s.uncertainty)} M${px-3} ${y(s.value! - s.uncertainty)}h6 M${px-3} ${y(s.value! + s.uncertainty)}h6`} stroke="currentColor" />}
        <circle cx={px} cy={py} r={s.frameId === selectedId ? 7 : 4} fill={s.status === 'partial' ? '#111a27' : 'currentColor'} stroke={s.frameId === selectedId ? 'white' : 'currentColor'} strokeWidth="2" role="button" tabIndex={0}
          aria-label={`Select measurement ${s.frameId}, group ${s.observationGroupId + 1}, ${s.value} ${s.unit}`} onClick={() => onSelect(s.frameId)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(s.frameId) } }} onMouseEnter={() => setHover(s)} onFocus={() => setHover(s)}><title>{sampleDescription(s)}</title></circle>
      </g> })}
    </svg> : explorer.result && <p className="hint">No plottable measurements in the selected groups. Missing wavelength, unavailable science, and quality failures remain in the table.</p>}
    {hover && samples.includes(hover) && <p className="sample-detail">{sampleDescription(hover)}</p>}
    {groups.map(g => <p className="hint" key={g} style={{ color: groupColor(g) }}>● Group {g + 1} · {samples.filter(s => s.observationGroupId === g).map(s => s.observedAtUtc.slice(0,10)).sort().filter((_,i,a) => i === 0 || i === a.length-1).join(' – ')}</p>)}
    <p className="hint">Vertical bars: reported uncertainty. Horizontal bars: reported wavelength range/bandwidth. Open points: partial quality. Negative values are retained.</p>
    {explorer.result && <><p className="hint">{explorer.result.uncertaintyNote}</p><p className="hint">{explorer.result.processingVersion} · {explorer.result.regionMapping}</p></>}
  </section>;
}

function sampleDescription(s: Sample) {
  return `Group ${s.observationGroupId + 1} · ${s.observedAtUtc} · ${number(s.wavelengthUm)} µm · ${number(s.value)} ± ${number(s.uncertainty)} ${s.unit} · bandwidth ${number(s.bandwidthUm)} µm · coverage ${number(s.coverage)} · ${s.status} · ${s.reasons.join(', ')}`;
}
export function Measurements({ result, groups, selectedId, onSelect }: { result: Spectrum | null; groups: number[]; selectedId?: string; onSelect: (id: string) => void }) {
  return <details className="panel measurements"><summary>Measurements {result ? `(${result.samples.filter(s => groups.includes(s.observationGroupId)).length})` : ''}</summary><div className="table-scroll"><table><caption>Background-corrected mean surface brightness; unavailable values are never replaced by zero.</caption><thead><tr>{['Frame / UTC', 'Group', 'Wavelength / bandwidth (µm)', 'Brightness (MJy/sr)', 'Uncertainty (MJy/sr)', 'Coverage / background', 'Pixels / background', 'Quality / reasons', 'Provenance'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{result?.samples.filter(s => groups.includes(s.observationGroupId)).map(s => <tr key={s.frameId} aria-selected={selectedId === s.frameId}><td><button onClick={() => onSelect(s.frameId)}>{s.frameId}</button><br />{s.observedAtUtc}</td><td>{s.observationGroupId + 1}</td><td>{number(s.wavelengthUm)} / {number(s.bandwidthUm)}<br />{s.wavelengthRangeUm?.map(number).join(' – ')}</td><td>{number(s.value)} {s.unit}</td><td>{number(s.uncertainty)}</td><td>{number(s.coverage)} / {number(s.backgroundCoverage)}</td><td>{s.sourcePixels ?? '—'} / {s.backgroundPixels ?? '—'}</td><td>{s.status}: {s.reasons.join(', ')}<br />{typeof s.qualityPolicy === 'string' ? s.qualityPolicy : JSON.stringify(s.qualityPolicy)}</td><td>{s.sourceFitsUrl && <a href={s.sourceFitsUrl} target="_blank" rel="noreferrer">Source FITS</a>}</td></tr>)}</tbody></table></div></details>;
}

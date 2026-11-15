import { useState } from 'react';
import type { Frame } from '../api/frames';
import type { Channel } from '../api/fingerprints';
import type { useFingerprint } from '../state/useFingerprint';
import './FingerprintExplorer.css';

type Explorer = ReturnType<typeof useFingerprint>;
const format = (n: number | null) => n == null ? 'Unavailable' : n.toPrecision(4);

export function FingerprintControls({ explorer, frame, onRegionUpdated }: { explorer: Explorer; frame?: Frame; onRegionUpdated?: () => void }) {
  const unavailable = !frame?.grid || (!!frame.scienceStatus && frame.scienceStatus !== 'retained');
  const [inner, setInner] = useState(explorer.selection?.circle.innerRadiusPixels ?? (explorer.selection?.circle.radiusPixels ?? 2)*2);
  const [outer, setOuter] = useState(explorer.selection?.circle.outerRadiusPixels ?? (explorer.selection?.circle.radiusPixels ?? 2)*3);
  const [radius, setRadius] = useState(explorer.selection?.circle.radiusPixels ?? 2);
  const validRadii = [radius,inner,outer].every(Number.isFinite) && radius > 0 && inner > radius && outer > inner;
  return <section className="region-controls"><h2>Select a sky region</h2>
    <p className="hint">Click a source in the native FOV image, or drag a circle for an extended region. The selection stays at the same sky location across 102 cube channels.</p>
    <form onSubmit={e => { e.preventDefault(); if (explorer.selection && validRadii) { explorer.commit(explorer.selection.referenceFrameId, { ...explorer.selection.circle, radiusPixels: radius, innerRadiusPixels: inner, outerRadiusPixels: outer }); onRegionUpdated?.() } }}>
      <label>Selection radius (native image pixels)<input aria-label="Selection radius" disabled={!explorer.selection} type="number" required min="0.1" step="any" value={Number.isFinite(radius) ? radius : ''} onChange={e => setRadius(e.target.value === '' ? NaN : Number(e.target.value))} /></label>
      <label>Background inner radius (native pixels)<input aria-label="Background inner radius" disabled={!explorer.selection} type="number" required min={radius+.01} step="any" value={Number.isFinite(inner) ? inner : ''} onChange={e => setInner(e.target.value === '' ? NaN : Number(e.target.value))} /></label>
      <label>Background outer radius (native pixels)<input aria-label="Background outer radius" disabled={!explorer.selection} type="number" required min={inner+.01} step="any" value={Number.isFinite(outer) ? outer : ''} onChange={e => setOuter(e.target.value === '' ? NaN : Number(e.target.value))} /></label>
      <button className="primary" disabled={!explorer.selection} type="submit">Update sky region</button>
    </form>
    {unavailable && frame && <p className="error">Select a native image with retained coordinates. Start a new FOV query if the sequence expired or reached its science limit.</p>}
    <p className="hint">Dashed rings show the background annulus. Radii use the original reference image pixels. The default annulus spans 2 to 3 times the aperture radius.</p>
    <p className="hint">This reads a small, cached region from a separate FITS cube. Your loaded images remain available. The cube is coarser than the native images.</p>
    <p className="hint">Stationary sky regions only. A moving planet needs tracked exposure measurements. Exoplanet-host selections include unresolved system light.</p>
    <p className="hint selected-centre">{explorer.region ? <>Selected sky centre: {explorer.region.ra.toFixed(6)}°, {explorer.region.dec.toFixed(6)}° · radius {explorer.region.radiusArcsec.toFixed(1)}″; background {explorer.region.innerArcsec.toFixed(1)}–{explorer.region.outerArcsec.toFixed(1)}″</> : <>Select a region to show its sky centre and radius.</>}</p>
  </section>;
}

function FingerprintPlot({ channels, selected, choose, references, observationWavelength }: {
  observationWavelength?: number | null;
  channels: Channel[]; selected: number; choose: (channel: number) => void;
  references: { name: string; wavelengthUm: number }[];
}) {
  const values = channels.filter(c => c.value !== null);
  if (!values.length) return <p className="hint">No usable channels at this position. Try a larger region or another location.</p>;
  const minX = Math.min(...channels.map(c => c.minUm));
  const maxX = Math.max(...channels.map(c => c.maxUm));
  const minY = Math.min(0, ...values.map(c => c.value!));
  const maxY = Math.max(0, ...values.map(c => c.value!));
  const pad = Math.max((maxY-minY)*.12, .001);
  const x = (v: number) => 65+(v-minX)/(maxX-minX)*395;
  const y = (v: number) => 265-(v-(minY-pad))/(maxY-minY+2*pad)*230;
  const path = channels.map((c, i) => {
    if (c.value == null) return '';
    return `${i > 0 && channels[i-1].value !== null ? 'L' : 'M'}${x(c.wavelengthUm)} ${y(c.value)}`;
  }).join(' ');
  return <svg className="spectrum-plot" viewBox="0 0 490 335" role="img" aria-label="102-channel location fingerprint">
    <path d="M65 30V265H460" fill="none" stroke="#91a1b5" />
    <line x1="65" x2="460" y1={y(0)} y2={y(0)} stroke="#536273" strokeDasharray="3 4" />
    {references.filter(r => r.wavelengthUm >= minX && r.wavelengthUm <= maxX).map(r => <g key={r.name}>
      <line x1={x(r.wavelengthUm)} x2={x(r.wavelengthUm)} y1="30" y2="265" stroke="#f7bb77" opacity=".5" strokeDasharray="3 4" />
      <text transform={`translate(${x(r.wavelengthUm)-3} 43) rotate(-90)`} textAnchor="end">{r.name}<title>{`${r.name}: approximate reference at ${r.wavelengthUm} micrometres; not a detection`}</title></text>
    </g>)}
    {observationWavelength != null && observationWavelength >= minX && observationWavelength <= maxX && <line x1={x(observationWavelength)} x2={x(observationWavelength)} y1="30" y2="265" stroke="#82c9ff" strokeWidth="2"><title>{`Displayed observation wavelength at query centre: ${observationWavelength.toFixed(3)} micrometres`}</title></line>}
    <path d={path} fill="none" stroke="#a4e7d2" strokeWidth="1" />
    {values.map(c => <circle key={c.channel} cx={x(c.wavelengthUm)} cy={y(c.value!)} r={c.channel === selected ? 5 : 2.5} fill="#a4e7d2" stroke={c.channel === selected ? 'white' : 'none'} role="button" tabIndex={0}
      aria-label={`Show channel ${c.channel}`} onClick={() => choose(c.channel)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(c.channel) } }}><title>{`Channel ${c.channel} · ${c.wavelengthUm.toFixed(3)} µm · ${format(c.value)} mJy · ${c.pixels} accepted pixels`}</title></circle>)}
    {[0,.5,1].map(t => <g key={t}><text x={x(minX+t*(maxX-minX))} y="286" textAnchor="middle">{format(minX+t*(maxX-minX))}</text><text x="60" y={y(minY+t*(maxY-minY))} textAnchor="end">{format(minY+t*(maxY-minY))}</text></g>)}
    <text x="260" y="317" textAnchor="middle">Observed wavelength (µm)</text>
    <text transform="translate(14 150) rotate(-90)" textAnchor="middle">Background-subtracted flux (mJy)</text>
  </svg>;
}

export function FingerprintPanel({ explorer, frame, frames, onSelect, onSelectRegion, onExploreMoving, movingLinkLabel }: {
  explorer: Explorer; frame?: Frame; frames: Frame[]; onSelect: (id: string) => void;
  onSelectRegion?: () => void; onExploreMoving?: () => void;
  movingLinkLabel?: string;
}) {
  const [referencesEnabled, setReferencesEnabled] = useState(true);
  const result = explorer.result;
  const channel = result?.channels.find(c => c.channel === explorer.selectedChannel);
  const downloaded = explorer.status?.downloadedBytes;
  const total = explorer.status?.totalBytes;
  return <section id="stationary-region-spectrum" className="panel spectrum-panel fingerprint-panel" aria-label="Spectral composition explorer">
    <div className="section-heading"><h2>Region spectrum</h2><span className="tag">QUICK LOOK</span></div>
    {!explorer.selection && <><p className="hint">Select a location within your FOV to inspect its wavelength channels and reference features.</p>
      {onSelectRegion && <button className="text-button" onClick={onSelectRegion}>Select a stationary region in the image</button>}</>}
    {onExploreMoving && <p className="analysis-crosslink"><span>Looking for motion?</span><button className="text-button" onClick={onExploreMoving}>{movingLinkLabel ?? 'Go to moving-candidate analysis'}</button></p>}
    {explorer.busy && <div role="status" aria-live="polite"><p>{explorer.status?.message ?? 'Resolving selected sky location…'}</p>
      {downloaded != null && <><progress aria-label="Cube download" max={total ?? Math.max(downloaded,1)} value={downloaded} /><p>{(downloaded/1024**2).toFixed(1)} MiB{total ? ` / ${(total/1024**2).toFixed(1)} MiB` : ''}</p></>}
      <p className="hint">Reading the selected region across 102 channels. The loaded observations remain available while the mosaic spectrum loads.</p></div>}
    {explorer.error && <p className="error" role="alert">{explorer.error} <button onClick={explorer.retry}>Retry cube loading</button></p>}
    {result && <>
      <p role="status">{result.usableChannels} usable / {result.totalChannels} channels · fixed sky region</p>
      <p className="hint">Combined epochs · uncertainty unavailable · reference overlays are not chemical detections.</p>
      <FingerprintPlot channels={result.channels} selected={explorer.selectedChannel} choose={explorer.setChannel} references={referencesEnabled ? result.references : []} observationWavelength={frame?.wavelengthUm} />
      <p className="hint">Background-subtracted aperture flux across combined epochs. Browsing observations keeps this sky region fixed.</p>
      <p className="hint observation-link">{frame ? <>Displayed observation: group {(frame.observationGroupId ?? frame.visit) + 1} · {frame.wavelengthUm?.toFixed(3) ?? 'unknown'} µm at query centre (blue marker).</> : 'Load observations to link them to this spectrum.'}</p>
      <label>Channel<input aria-label="Spectral channel" disabled={!result.usableChannels} type="range" min="1" max="102" value={explorer.selectedChannel} onChange={e => explorer.setChannel(Number(e.target.value))} /></label>
      <details><summary>Channel coverage (102 slots)</summary>
      <div className="channel-grid" aria-label="Channel coverage">{Array.from({length:6},(_,i) => <div key={i}><span>D{i+1}</span>{result.channels.filter(c => c.detector === i+1).map(c => <button key={c.channel} disabled={c.value === null} aria-label={`Channel ${c.channel}, ${c.wavelengthUm.toFixed(3)} micrometres`} aria-pressed={c.channel === explorer.selectedChannel} title={c.reason || `${c.wavelengthUm.toFixed(3)} µm`} onClick={() => explorer.setChannel(c.channel)}>{c.subchannel}</button>)}</div>)}</div>
      <p className="hint">Disabled slots are missing measurements, never zero. DR1 channels 51 and 52 are intentionally blank.</p></details>
      {channel && <p className="hint">Selected channel {channel.channel} · {channel.wavelengthUm.toFixed(3)} µm · {channel.reason || `${channel.pixels} accepted pixels`}</p>}
      <details><summary>Loaded observations in this channel</summary>
        <p className="hint">Matches use wavelength at the query centre, not the selected aperture. Spatial wavelength variation can change the wavelength at the selected aperture.</p>
        {channel && frames.filter(f => f.wavelengthUm != null && f.wavelengthUm >= channel.minUm && f.wavelengthUm <= channel.maxUm).map(f => <button className="linked-observation" key={f.id} aria-pressed={f.id === frame?.id} onClick={() => onSelect(f.id)}>Group {(f.observationGroupId ?? f.visit) + 1} · {f.observedAtUtc} · {f.wavelengthUm!.toFixed(3)} µm</button>)}
        {channel && !frames.some(f => f.wavelengthUm != null && f.wavelengthUm >= channel.minUm && f.wavelengthUm <= channel.maxUm) && <p className="hint">No loaded observation at this channel's wavelength.</p>}
      </details>
      <label><input type="checkbox" role="switch" aria-label="Composition references" checked={referencesEnabled} onChange={e => setReferencesEnabled(e.target.checked)} />Composition references <span>{referencesEnabled ? 'Enabled' : 'Disabled'}</span></label>
      <p className="hint">Reference positions are educational markers, not chemical detections.</p>
    </>}
  </section>;
}

export function ChannelMeasurements({ explorer, open = false }: { explorer: Explorer; open?: boolean }) {
  const result = explorer.result;
  function download() {
    if (!result) return;
    const fields = ['channel','detector','wavelengthUm','minUm','maxUm','value','apertureFluxMjy','backgroundFluxMjy','backgroundMeanMJySr','apertureAreaPixels','backgroundPixels','backgroundCoverage','pixels','coverage','flagsOr','reason'] as const;
    const csv = [['unit','processingVersion',...fields].join(','), ...result.channels.map(c => [JSON.stringify(result.unit),JSON.stringify(result.processingVersion),...fields.map(k => JSON.stringify(c[k] ?? ''))].join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
    const a = document.createElement('a'); a.href=url; a.download='spherex-location-channels.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  return <details className="panel measurements" open={open}><summary>Channel measurements {result ? `(${result.totalChannels} slots)` : ''}</summary>
    {!result && <p className="hint">Choose a stationary sky region in the Spectrum view to load channel measurements.</p>}
    {result && <><button onClick={download}>Export channel CSV</button><p className="hint">Fractional aperture sum minus a 3-sigma-clipped annulus background, converted to mJy. No uncertainty is supplied by this cube; missing values remain empty.</p></>}
    <div className="table-scroll"><table><caption>Location-based channels, not one point per exposure</caption><thead><tr>{['Channel','Detector / subchannel','Wavelength (µm)','Channel edges (µm)','Flux (mJy)','Pixels / coverage','Background pixels / coverage','Background (mJy)','Flags OR','Quality'].map(name => <th key={name}>{name}</th>)}</tr></thead><tbody>{result?.channels.map(c => <tr key={c.channel} aria-selected={c.channel === explorer.selectedChannel}><td><button disabled={c.value === null} onClick={() => explorer.setChannel(c.channel)}>{c.channel}</button></td><td>{c.detector} / {c.subchannel}</td><td>{format(c.wavelengthUm)}</td><td>{format(c.minUm)}–{format(c.maxUm)}</td><td>{format(c.value)}</td><td>{c.pixels} / {Math.round(c.coverage*100)}%</td><td>{c.backgroundPixels} / {Math.round(c.backgroundCoverage*100)}%</td><td>{format(c.backgroundFluxMjy)}</td><td>{c.flagsOr}</td><td>{c.reason || 'Quick-look; uncertainty unavailable'}</td></tr>)}</tbody></table></div>
  </details>;
}

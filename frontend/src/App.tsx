import { useState } from 'react';
import type { FormEvent } from 'react';
import { useFrames } from './state/useFrames';
import './App.css';

function App() {
  const sequence = useFrames();
  const [inputs, setInputs] = useState({ ra: '133.79513', dec: '-7.24515', fov: '0.05' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [validation, setValidation] = useState('');
  const [zoom, setZoom] = useState('4');
  const ready = sequence.frames.filter((frame) => frame.status === 'ready' && frame.imageData);
  const failed = sequence.frames.filter((frame) => frame.status === 'failed');
  const foundIndex = ready.findIndex((frame) => frame.id === selectedId);
  const index = foundIndex < 0 ? 0 : foundIndex;
  const selected = ready[index];
  const progress = sequence.page?.progress;
  const finished = (progress?.ready ?? 0) + (progress?.failed ?? 0);
  const status = sequence.paused ? 'paused' : sequence.busy ? sequence.page?.status ?? 'submitting' : sequence.page && ['queued', 'discovering', 'running'].includes(sequence.page.status) ? 'paused' : sequence.page?.status ?? 'idle';

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = { ra: Number(inputs.ra), dec: Number(inputs.dec), fov: Number(inputs.fov) };
    if (Object.values(inputs).some((value) => !value.trim()) ||
        !Object.values(query).every(Number.isFinite) || query.ra < 0 || query.ra >= 360 ||
        query.dec < -90 || query.dec > 90 || query.fov <= 0 || query.fov > 1) {
      setValidation('Enter RA from 0 to <360, Dec from -90 to 90, and FOV from >0 to 1 degree.');
      return;
    }
    setValidation(''); setSelectedId(null);
    void sequence.start(query);
  }

  function move(next: number) {
    const frame = ready[Math.max(0, Math.min(ready.length - 1, next))];
    if (frame) setSelectedId(frame.id);
  }

  return <main className="shell">
    <header className="masthead">
      <div className="brand"><span className="orbit" aria-hidden="true">✳</span> SPHEREx <span> / SKY BLINK</span></div>
      <span className="tag">OBSERVATION VIEWER</span>
    </header>
    <section className="intro"><p className="eyebrow">A PATCH OF SKY. MANY MOMENTS.</p>
      <h1>Explore the infrared sky.</h1>
      <p>Choose a location and step through its SPHEREx observations as they arrive.</p>
    </section>
    <div className="workspace">
      <aside className="panel controls">
        <div className="section-heading"><span className="eyebrow">01 / LOCATION</span><span className="tag">ICRS · DEGREES</span></div>
        <h2>Where shall we look?</h2>
        <form onSubmit={submit}>
          <label htmlFor="ra">Right ascension <span>RA</span></label>
          <input id="ra" type="number" step="any" min="0" max="359.999999999" required value={inputs.ra}
            onChange={(e) => setInputs({ ...inputs, ra: e.target.value })} />
          <label htmlFor="dec">Declination <span>DEC</span></label>
          <input id="dec" type="number" step="any" min="-90" max="90" required value={inputs.dec}
            onChange={(e) => setInputs({ ...inputs, dec: e.target.value })} />
          <label htmlFor="fov">Field of view <span>FOV</span></label>
          <input id="fov" type="number" step="any" min="0.000001" max="1" required value={inputs.fov}
            onChange={(e) => setInputs({ ...inputs, fov: e.target.value })} />
          <p className="hint">Square side length · {Number(inputs.fov) > 0 ? (Number(inputs.fov) * 60).toFixed(2) : '\u2014'} arcmin</p>
          <button className="primary" type="submit">{sequence.busy ? 'Start new query' : 'Find observations'} <span aria-hidden="true">↗</span></button>
          {validation && <p className="error" role="alert">{validation}</p>}
        </form>
        <button className="preset" onClick={() => setInputs({ ra: '133.79513', dec: '-7.24515', fov: '0.05' })}>
          <span>EXAMPLE TARGET</span><strong>WISE 0855−0714 <span aria-hidden="true">↗</span></strong>
        </button>
        <button className="preset" onClick={() => setInputs({ ra: '210.80227', dec: '54.34895', fov: '0.1' })}>
          <span>TUTORIAL TARGET</span><strong>M101 / Pinwheel galaxy</strong>
        </button>
        <div className="progress-block" role="status" aria-live="polite">
          <div className="section-heading"><span className="eyebrow">SEQUENCE STATUS</span><span className={sequence.busy ? 'status active' : 'status'}>{status}</span></div>
          <progress aria-label="Frames processed" max={progress?.total || 1} value={finished} />
          <div className="stats"><span><b>{progress?.ready ?? 0}</b> ready</span><span><b>{progress?.failed ?? 0}</b> failed</span><span><b>{progress?.total ?? 0}</b> total</span></div>
          {sequence.notice && <p className="hint">{sequence.notice}</p>}
          {sequence.page && sequence.page.remaining > 0 && <p className="hint">{sequence.page.scheduledCount} of {progress?.total} exposures requested. {sequence.page.remaining} not downloaded yet.</p>}
          {sequence.busy && <button className="text-button" disabled={!sequence.resumable} onClick={sequence.stop}>Stop loading</button>}
          {!sequence.busy && sequence.resumable && <button className="primary" onClick={() => void sequence.resume()}>Resume loading</button>}
          {sequence.error && <p className="error" role="alert">{sequence.error}</p>}
          {sequence.page?.status === 'completed' && progress?.total === 0 && <p>No observations cover this location.</p>}
        </div>
      </aside>
      <section className="panel viewer-panel" aria-label="Frame viewer">
        <div className="viewer-heading"><div><p className="eyebrow">02 / OBSERVATIONS</p><h2>{selected ? `Visit ${selected.visit + 1}` : 'Your window into the sky'}</h2></div><span className="tag">{ready.length ? `${index + 1} / ${ready.length}` : 'NO FRAMES YET'}</span></div>
        <label className="zoom-control">Display size
          <select value={zoom} onChange={(event) => setZoom(event.target.value)}>
            <option value="1">Native / 1 pixel = 1 px</option><option value="4">4x pixels</option><option value="fit">Fit viewer</option>
          </select>
        </label>
        <div className="image-stage" tabIndex={0} aria-label="Observation image; use left and right arrows to change frames"
          onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); move(index + (e.key === 'ArrowRight' ? 1 : -1)) } }}>
          {selected ? <img style={zoom === 'fit' ? { width: 'auto', height: '85%' } : {
            width: (selected.grid?.width ?? 29) * Number(zoom), height: 'auto',
          }} src={selected.imageData!} alt={`SPHEREx ${selected.detector} observation at ${selected.observedAtUtc}`} /> :
            <div className="empty-state"><span className="crosshair" aria-hidden="true">+</span><h3>{sequence.busy ? 'Listening for the first frame' : 'Start with a sky location'}</h3><p>{sequence.busy ? 'Images will appear here while the rest load.' : 'Enter coordinates or use the example target, then find observations.'}</p></div>}
          <span className="stage-label">SPHEREx / INFRARED</span><span className="stage-label right">{selected?.grid ? `${selected.grid.width} × ${selected.grid.height} PX` : 'AWAITING SIGNAL'}</span>
        </div>
        <div className="navigation"><button aria-label="Previous frame" disabled={!selected || index === 0} onClick={() => move(index - 1)}>← Previous</button>
          <input type="range" aria-label="Selected frame" min="0" max={Math.max(0, ready.length - 1)} value={index} disabled={ready.length < 2} onChange={(e) => move(Number(e.target.value))} />
          <button aria-label="Next frame" disabled={!selected || index >= ready.length - 1} onClick={() => move(index + 1)}>Next →</button></div>
        {selected && <dl className="metadata"><div><dt>OBSERVED · UTC</dt><dd>{selected.observedAtUtc.replace('T', ' ').replace('Z', '')}</dd></div><div><dt>DETECTOR</dt><dd>{selected.detector}</dd></div><div><dt>RELEASE</dt><dd>{selected.release}</dd></div></dl>}
        <p className="preview-note">Native pixels are preserved; enlarging adds no detail. Previews are unaligned · contrast varies per frame. Frames are ordered by observation time.</p>
      </section>
    </div>
    {ready.length > 0 && <section className="panel filmstrip-panel"><div className="section-heading"><h2>Observation timeline</h2><span className="tag">{ready.length} LOADED</span></div>
      <div className="filmstrip">{ready.map((frame, i) => <button key={frame.id} aria-label={`Select frame ${i + 1}, ${frame.detector}, ${frame.observedAtUtc}`} aria-pressed={selected?.id === frame.id} onClick={() => setSelectedId(frame.id)}>
        <img src={frame.imageData!} alt="" loading="lazy" /><span>{String(i + 1).padStart(2, '0')} · V{frame.visit + 1}</span><small>{frame.observedAtUtc.slice(0, 10)}</small></button>)}</div>
    </section>}
    {failed.length > 0 && <details className="panel failures"><summary>{failed.length} frames could not be loaded</summary><ul>{failed.map((frame) => <li key={frame.id}><strong>{frame.detector} · {frame.observedAtUtc}</strong><p>{frame.error?.message ?? 'Frame unavailable.'}</p></li>)}</ul></details>}
    <footer><span>SPHEREx Sky Blink</span><span>NASA Space Apps 2026 · Archive data via backend</span></footer>
  </main>
}
export default App;

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useFrames } from './state/useFrames';
import type { Frame } from './api/frames';
import './App.css';

function App() {
  const sequence = useFrames();
  const [inputs, setInputs] = useState({ ra: '133.79513', dec: '-7.24515', fov: '0.05' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [validation, setValidation] = useState('');
  const [zoom, setZoom] = useState('4');
  const [contrast, setContrast] = useState('shared');
  const [blinkMode, setBlinkMode] = useState(false);
  const [appendedIds, setAppendedIds] = useState<string[] | null>(null);
  const [candidateId, setCandidateId] = useState('');
  const [playing, setPlaying] = useState(false);
  const [blinkIndex, setBlinkIndex] = useState(0);

  function preview(frame: Frame) {
    return (contrast === 'shared' ? frame.sharedImageData : null) ?? frame.imageData ?? undefined;
  }
  const ready = sequence.frames.filter((frame) => frame.status === 'ready' && frame.imageData);
  const failed = sequence.frames.filter((frame) => frame.status === 'failed');
  const foundIndex = ready.findIndex((frame) => frame.id === selectedId);
  const index = foundIndex < 0 ? 0 : foundIndex;
  const selected = ready[index];
  const aligned = ready.filter((frame) => frame.alignedImageData && frame.alignedGrid && frame.sharedDisplay);
  const reference = aligned.find((frame) => frame.id === selected?.id) ?? aligned[0];
  const comparisons = reference && aligned.filter((frame) => frame.id !== reference.id &&
    frame.detector === reference.detector && frame.release === reference.release &&
    frame.sharedDisplay?.vmin === reference.sharedDisplay?.vmin &&
    frame.sharedDisplay?.vmax === reference.sharedDisplay?.vmax &&
    frame.observedAtUtc !== reference.observedAtUtc);
  const wavelengthDistance = (frame: Frame) => frame.wavelengthUm == null || reference?.wavelengthUm == null
    ? Infinity : Math.abs(frame.wavelengthUm - reference.wavelengthUm);
  const closest = comparisons?.reduce<Frame | undefined>((best, frame) =>
    !best || wavelengthDistance(frame) < wavelengthDistance(best) ? frame : best, undefined);
  const chosenIds = appendedIds ?? (closest ? [closest.id] : []);
  const blinkFrames = reference ? [reference, ...chosenIds.flatMap((id) =>
    comparisons?.filter((frame) => frame.id === id) ?? [])] : [];
  const candidates = comparisons?.filter((frame) => !chosenIds.includes(frame.id)) ?? [];
  const candidate = candidates.find((frame) => frame.id === candidateId) ?? candidates[0];
  const blinkCount = blinkFrames.length;
  const activeIndex = Math.min(blinkIndex, Math.max(0, blinkCount - 1));
  const visible = blinkMode ? blinkFrames[activeIndex] : selected;
  const visibleGrid = blinkMode ? visible?.alignedGrid : visible?.grid;

  useEffect(() => {
    if (!blinkMode || !playing || blinkCount < 2) return;
    const timer = window.setInterval(() => setBlinkIndex((current) => (current + 1) % blinkCount), 650);
    return () => window.clearInterval(timer);
  }, [blinkMode, playing, blinkCount]);

  function resetBlink() {
    setPlaying(false);
    setBlinkIndex(0);
    setAppendedIds(null);
    setCandidateId('');
  }

  function showBlinkFrame(next: number) {
    if (!reference) return;
    setSelectedId(reference.id);
    setAppendedIds(chosenIds);
    setPlaying(false);
    setBlinkIndex((next + blinkCount) % blinkCount);
  }

  function selectFrame(id: string) {
    setSelectedId(id);
    resetBlink();
  }

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
    resetBlink();
    void sequence.start(query);
  }

  function move(next: number) {
    const frame = ready[Math.max(0, Math.min(ready.length - 1, next))];
    if (frame) selectFrame(frame.id);
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
        <div className="viewer-controls">
        <label className="zoom-control">Display size
          <select value={zoom} onChange={(event) => setZoom(event.target.value)}>
            <option value="1">Native / 1 pixel = 1 px</option><option value="4">4x pixels</option><option value="fit">Fit viewer</option>
          </select>
        </label>
        <label className="zoom-control">View
          <select aria-label="View" value={blinkMode ? 'blink' : 'browse'} onChange={(event) => {
            setBlinkMode(event.target.value === 'blink');
            resetBlink();
            if (reference) setSelectedId(reference.id);
          }}>
            <option value="browse">Browse observations</option>
            <option value="blink">Aligned blink</option>
          </select>
        </label>
        {!blinkMode && <label className="zoom-control">Contrast
          <select value={contrast} onChange={(event) => setContrast(event.target.value)}>
            <option value="shared">Locked by detector</option>
            <option value="auto">Auto per frame</option>
          </select>
        </label>}
        </div>
        {blinkMode && reference && <div className="viewer-controls">
          <label className="zoom-control">Reference frame
            <select aria-label="Reference frame" value={reference.id} onChange={(event) => selectFrame(event.target.value)}>
              {aligned.map((frame) => <option key={frame.id} value={frame.id}>{frame.observedAtUtc} · {frame.detector}{frame.wavelengthUm != null ? ` · ${frame.wavelengthUm.toFixed(3)} µm` : ''}</option>)}
            </select>
          </label>
          <label className="zoom-control">Frame to add
            <select aria-label="Frame to add" value={candidate?.id ?? ''} disabled={!candidate}
              onChange={(event) => setCandidateId(event.target.value)}>
              {!candidate && <option value="">No more compatible frames loaded</option>}
              {candidates.map((frame) => <option key={frame.id} value={frame.id}>{frame.observedAtUtc}{frame.wavelengthUm != null ? ` · ${frame.wavelengthUm.toFixed(3)} µm` : ''}</option>)}
            </select>
          </label>
          <button className="text-button" disabled={!candidate} onClick={() => {
            if (!candidate) return;
            setSelectedId(reference.id);
            setAppendedIds([...chosenIds, candidate.id]);
            setCandidateId('');
          }}>Add frame</button>
        </div>}
        <div className="image-stage" tabIndex={0} aria-label={blinkMode ? 'Aligned observation image; use left and right arrows to switch frames' : 'Observation image; use left and right arrows to change frames'}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            if (blinkMode) {
              showBlinkFrame(activeIndex + (event.key === 'ArrowRight' ? 1 : -1));
            } else {
              move(index + (event.key === 'ArrowRight' ? 1 : -1));
            }
          }}>
          {visible ? <img style={zoom === 'fit' ? { width: 'auto', height: '85%' } : {
            width: (visibleGrid?.width ?? 29) * Number(zoom), height: 'auto',
          }} src={blinkMode ? visible.alignedImageData ?? undefined : preview(visible)} alt={`SPHEREx ${visible.detector} observation at ${visible.observedAtUtc}`} /> :
            <div className="empty-state"><span className="crosshair" aria-hidden="true">+</span><h3>{blinkMode && ready.length ? 'No aligned frames available' : sequence.busy ? 'Listening for the first frame' : 'Start with a sky location'}</h3><p>{sequence.busy ? 'Images will appear here while the rest load.' : 'Enter coordinates or use the example target, then find observations.'}</p></div>}
          <span className="stage-label">{blinkMode && visible ? `FRAME ${activeIndex + 1} / ${blinkCount}` : 'SPHEREx / INFRARED'}</span><span className="stage-label right">{visibleGrid ? `${visibleGrid.width} × ${visibleGrid.height} PX` : 'AWAITING SIGNAL'}</span>
        </div>
        {blinkMode ? <>
          <div className="navigation blink-navigation">
            <button disabled={blinkCount < 2} onClick={() => showBlinkFrame(activeIndex - 1)}>← Previous</button>
            <button disabled={blinkCount < 2} onClick={() => {
              if (!playing && reference) {
                setSelectedId(reference.id);
                setAppendedIds(chosenIds);
              }
              setPlaying(!playing);
            }}>{playing ? 'Pause blink' : 'Play blink'}</button>
            <button disabled={blinkCount < 2} onClick={() => showBlinkFrame(activeIndex + 1)}>Next →</button>
          </div>
          {blinkCount > 0 && <div className="blink-table-scroll" role="region" aria-label="Selected frame comparison" tabIndex={0}>
            <table className="blink-table">
              <caption>Selected frame comparison</caption>
              <thead><tr>
                <th scope="col">Frame</th><th scope="col">Observed (UTC)</th><th scope="col">Visit</th>
                <th scope="col">Detector</th><th scope="col">Release</th><th scope="col">Wavelength at target (µm)</th>
                <th scope="col">Actions</th>
              </tr></thead>
              <tbody>{blinkFrames.map((frame, position) => <tr key={frame.id} className={position === activeIndex ? 'active-frame' : undefined}>
              <th scope="row">
              <button aria-pressed={position === activeIndex} onClick={() => showBlinkFrame(position)}>
                {position === 0 ? '1 · Reference' : position + 1}
              </button>
              </th>
              <td>{frame.observedAtUtc.replace('T', ' ').replace('Z', '')}</td>
              <td>{frame.visit + 1}</td><td>{frame.detector}</td><td>{frame.release}</td>
              <td>{frame.wavelengthUm?.toFixed(3) ?? 'Unavailable'}</td>
              <td>{position > 0 && <button aria-label={`Remove frame ${position + 1}`} onClick={() => {
                showBlinkFrame(position === activeIndex ? 0 : activeIndex - Number(position < activeIndex));
                setAppendedIds(chosenIds.filter((id) => id !== frame.id));
              }}>Remove</button>}</td>
              </tr>)}</tbody>
            </table>
          </div>}
        </> : <div className="navigation"><button aria-label="Previous frame" disabled={!selected || index === 0} onClick={() => move(index - 1)}>← Previous</button>
          <input type="range" aria-label="Selected frame" min="0" max={Math.max(0, ready.length - 1)} value={index} disabled={ready.length < 2} onChange={(e) => move(Number(e.target.value))} />
          <button aria-label="Next frame" disabled={!selected || index >= ready.length - 1} onClick={() => move(index + 1)}>Next →</button></div>}
        {!blinkMode && visible && <dl className="metadata"><div><dt>OBSERVED · UTC</dt><dd>{visible.observedAtUtc.replace('T', ' ').replace('Z', '')}</dd></div><div><dt>DETECTOR</dt><dd>{visible.detector}</dd></div><div><dt>RELEASE</dt><dd>{visible.release}</dd></div>{visible.wavelengthUm != null && <div><dt>WAVELENGTH AT TARGET</dt><dd>{visible.wavelengthUm.toFixed(3)} µm</dd></div>}</dl>}
        <p className="preview-note">{blinkMode
          ? 'North up · 6.15 arcsec/pixel · shared contrast. Frames play in the order shown. The first comparison defaults to the closest available wavelength from the same detector.'
          : (contrast === 'shared'
          ? selected && !selected.sharedImageData
            ? 'Locked contrast is unavailable for this frame. Showing auto contrast.'
            : 'Contrast stays fixed within a detector. Brightness can still change with wavelength.'
          : 'Each frame has its own brightness scale.') + ' Previews are unaligned.'}</p>
      </section>
    </div>
    {ready.length > 0 && <section className="panel filmstrip-panel"><div className="section-heading"><h2>Observation timeline</h2><span className="tag">{ready.length} LOADED</span></div>
      <div className="filmstrip">{ready.map((frame, i) => <button key={frame.id} aria-label={`Select frame ${i + 1}, ${frame.detector}, ${frame.observedAtUtc}`} aria-pressed={(blinkMode ? reference : selected)?.id === frame.id} disabled={blinkMode && !frame.alignedImageData} onClick={() => selectFrame(frame.id)}>
        <img src={preview(frame)} alt="" loading="lazy" /><span>{String(i + 1).padStart(2, '0')} · V{frame.visit + 1}</span><small>{frame.observedAtUtc.slice(0, 10)}</small></button>)}</div>
    </section>}
    {failed.length > 0 && <details className="panel failures"><summary>{failed.length} frames could not be loaded</summary><ul>{failed.map((frame) => <li key={frame.id}><strong>{frame.detector} · {frame.observedAtUtc}</strong><p>{frame.error?.message ?? 'Frame unavailable.'}</p></li>)}</ul></details>}
    <footer><span>SPHEREx Sky Blink</span><span>NASA Space Apps 2026 · Archive data via backend</span></footer>
  </main>
}
export default App;

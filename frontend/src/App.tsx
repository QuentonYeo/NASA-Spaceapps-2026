import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useFingerprint } from './state/useFingerprint';
import { RegionImage } from './components/RegionImage';
import { FingerprintControls, FingerprintPanel, ChannelMeasurements } from './components/FingerprintExplorer';
import { loadRegionProjection } from './api/regionProjection';
import { useFrames } from './state/useFrames';
import type { Frame } from './api/frames';
import { GaiaMarkers } from './GaiaOverlay';
import { arosaPosition } from './state/arosaValidation';
import { useGaiaCatalogue } from './state/useGaiaCatalogue';
import { Home } from './Home';
import { examples, fields } from './state/validationExamples';
import './App.css';
import './components/SpectralExplorer.css';

function currentMode() {
  return window.location.hash === '#validate' ? 'validate' : window.location.hash === '#explore' ? 'explore' : 'home';
}


function App() {
  const sequence = useFrames();
  const [mode, setMode] = useState(currentMode);
  const [exampleId, setExampleId] = useState(() =>
    examples.find((example) => example.exposureIds[0] === sequence.query?.exposureIds?.[0])?.id ?? 'arosa');
  const example = examples.find((item) => item.id === exampleId) ?? examples[0];
  const [detector, setDetector] = useState(sequence.query?.detector ?? '');
  const activeExample = examples.find((item) => item.exposureIds[0] === sequence.query?.exposureIds?.[0]);
  const showResults = mode === 'validate' ? !!activeExample : !activeExample;
  useEffect(() => {
    function updateMode() { setMode(currentMode()); }
    window.addEventListener('hashchange', updateMode);
    return () => window.removeEventListener('hashchange', updateMode);
  }, []);

  const [inputs, setInputs] = useState(() => sequence.query
    ? { ra: String(sequence.query.ra), dec: String(sequence.query.dec), fov: String(sequence.query.fov) }
    : fields[1].inputs);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [validation, setValidation] = useState('');
  const [zoom, setZoom] = useState(sequence.query?.exposureIds ? 'fit' : '4');
  const [tab, setTab] = useState('image');
  const [contrast, setContrast] = useState('shared');
  const [blinkMode, setBlinkMode] = useState(!!sequence.query?.exposureIds);
  const [showArosa, setShowArosa] = useState(true);
  const [gaiaLabels, setGaiaLabels] = useState(false);
  const gaia = useGaiaCatalogue(mode !== 'home' && showResults && blinkMode ? sequence.page?.sequenceId : undefined);
  const [appendedIds, setAppendedIds] = useState<string[] | null>(null);
  const [candidateId, setCandidateId] = useState('');
  const [playing, setPlaying] = useState(false);
  const [blinkIndex, setBlinkIndex] = useState(0);

  function preview(frame: Frame) {
    return (contrast === 'shared' ? frame.sharedImageData : null) ?? frame.imageData ?? undefined;
  }
  const frames = showResults ? sequence.frames : [];
  const spectrumSequenceId = mode === 'explore' && showResults ? sequence.page?.sequenceId : undefined;
  const explorer = useFingerprint(spectrumSequenceId, frames);
  const ready = frames.filter((frame) => frame.status === 'ready' && frame.imageData);
  const failed = frames.filter((frame) => frame.status === 'failed');
  const foundIndex = ready.findIndex((frame) => frame.id === selectedId);
  const index = foundIndex < 0 ? 0 : foundIndex;
  const unavailableSelection = failed.find(frame => frame.id === selectedId);
  const selected = unavailableSelection ? undefined : ready[index];
  const aligned = ready.filter((frame) => frame.alignedImageData && frame.alignedGrid && frame.sharedDisplay);
  const reference = aligned.find((frame) => frame.id === (selectedId ?? activeExample?.pair[0])) ?? aligned[0];
  const comparisons = reference && aligned.filter((frame) => frame.id !== reference.id &&
    frame.detector === reference.detector && frame.release === reference.release &&
    frame.sharedDisplay?.vmin === reference.sharedDisplay?.vmin &&
    frame.sharedDisplay?.vmax === reference.sharedDisplay?.vmax &&
    frame.observedAtUtc !== reference.observedAtUtc);
  const wavelengthDistance = (frame: Frame) => frame.wavelengthUm == null || reference?.wavelengthUm == null
    ? Infinity : Math.abs(frame.wavelengthUm - reference.wavelengthUm);
  const closest = comparisons?.reduce<Frame | undefined>((best, frame) =>
    !best || wavelengthDistance(frame) < wavelengthDistance(best) ? frame : best, undefined);
  const defaultComparison = comparisons?.find((frame) => frame.id === activeExample?.pair[1]) ?? closest;
  const chosenIds = appendedIds ?? (defaultComparison ? [defaultComparison.id] : []);
  const blinkFrames = reference ? [reference, ...chosenIds.flatMap((id) =>
    comparisons?.filter((frame) => frame.id === id) ?? [])] : [];
  const candidates = comparisons?.filter((frame) => !chosenIds.includes(frame.id)) ?? [];
  const candidate = candidates.find((frame) => frame.id === candidateId) ?? candidates[0];
  const blinkCount = blinkFrames.length;
  const activeIndex = Math.min(blinkIndex, Math.max(0, blinkCount - 1));
  const visible = blinkMode ? blinkFrames[activeIndex] : selected;
  const visibleGrid = blinkMode ? visible?.alignedGrid : visible?.grid;
  const showArosaControl = blinkMode && blinkFrames.some((frame) => arosaPosition(frame, sequence.query));
  const arosa = blinkMode && showArosa && visible ? arosaPosition(visible, sequence.query) : null;

  useEffect(() => {
    if (!blinkMode || !playing || blinkCount < 2) return;
    const timer = window.setInterval(() => setBlinkIndex((current) => (current + 1) % blinkCount), 650);
    return () => window.clearInterval(timer);
  }, [blinkMode, playing, blinkCount]);

  const previousFrameId = ready[index - 1]?.id;
  const nextFrameId = ready[index + 1]?.id;
  useEffect(() => {
    const region = explorer.region;
    if (!spectrumSequenceId || !region) return;
    for (const id of [previousFrameId, nextFrameId]) {
      if (id && id !== explorer.selection?.referenceFrameId) void loadRegionProjection(spectrumSequenceId, id, region).catch(() => {});
    }
  }, [spectrumSequenceId, explorer.region, explorer.selection?.referenceFrameId, previousFrameId, nextFrameId]);

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

  const progress = showResults ? sequence.page?.progress : undefined;
  const finished = (progress?.ready ?? 0) + (progress?.failed ?? 0);
  const missingPreferredFrame = mode === 'validate' && activeExample &&
    ['completed', 'partial', 'failed'].includes(sequence.page?.status ?? '') &&
    activeExample.pair.some((id) => !aligned.some((frame) => frame.id === id));
  const status = sequence.paused ? 'paused' : sequence.busy ? sequence.page?.status ?? 'submitting' : sequence.page && ['queued', 'discovering', 'running'].includes(sequence.page.status) ? 'paused' : sequence.page?.status ?? 'idle';

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const searchInputs = mode === 'validate' ? example.inputs : inputs;
    const query = { ra: Number(searchInputs.ra), dec: Number(searchInputs.dec), fov: Number(searchInputs.fov) };
    if (Object.values(searchInputs).some((value) => !value.trim()) ||
        !Object.values(query).every(Number.isFinite) || query.ra < 0 || query.ra >= 360 ||
        query.dec < -90 || query.dec > 90 || query.fov <= 0 || query.fov > 1) {
      setValidation('Enter RA from 0 to <360, Dec from -90 to 90, and FOV from >0 to 1 degree.');
      return;
    }
    setValidation(''); setSelectedId(null);
    resetBlink();
    if (mode === 'validate') {
      setBlinkMode(true);
      setZoom('fit');
      setShowArosa(true);
      gaia.toggle(true);
      void sequence.start({ ...query, exposureIds: example.exposureIds });
    } else {
      void sequence.start({ ...query, detector: detector || undefined, manualBatches: true },
        ready.length > 0 && ready.every(frame => frame.scienceStatus === 'unavailable'));
    }
  }

  function move(next: number) {
    const frame = ready[Math.max(0, Math.min(ready.length - 1, next))];
    if (frame) selectFrame(frame.id);
  }

  if (mode === 'home') return <Home />;

  return <main className="shell workflow-shell" data-tab={mode === 'explore' ? tab : undefined}>
    <header className="masthead">
      <div className="brand"><span className="orbit" aria-hidden="true">✳</span> SPHEREx <span> / SKY BLINK</span></div>
      <nav className="workspace-nav" aria-label="Workflows">
        <a href="#home">Home</a>
        <a href="#validate" aria-current={mode === 'validate' ? 'page' : undefined}>Validate</a>
        <a href="#explore" aria-current={mode === 'explore' ? 'page' : undefined}>Explore</a>
      </nav>
    </header>
    <section className="intro workflow-intro">
      <h1>{mode === 'validate' ? 'Validate a known object' : 'Explore for movement'}</h1>
      <p>{mode === 'validate'
        ? 'Open a prepared comparison and see how known motion looks in SPHEREx.'
        : 'Choose a sky field and compare observations at different times.'}</p>
    </section>
    {mode === 'explore' && <div className="mobile-tabs" role="tablist" aria-label="Explorer views">{['image', 'spectrum', 'measurements'].map(name => <button key={name} role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>{name[0].toUpperCase() + name.slice(1)}</button>)}</div>}
    <div className={mode === 'explore' ? 'workspace spectral-workspace' : 'workspace'}>
      <aside className="panel controls">
        <h2>{mode === 'validate' ? 'Choose an example' : 'Search a field'}</h2>
        <form onSubmit={submit}>
          {mode === 'validate' ? <>
            <label htmlFor="example">Validation example</label>
            <select id="example" value={exampleId} onChange={(event) => setExampleId(event.target.value)}>
              {examples.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <p className="example-purpose">{example.purpose}</p>
            <dl className="example-coordinates">
              <div><dt>RA</dt><dd>{example.inputs.ra}°</dd></div>
              <div><dt>Dec</dt><dd>{example.inputs.dec}°</dd></div>
              <div><dt>Field of view</dt><dd>{example.inputs.fov}°</dd></div>
            </dl>
          </> : <>
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
          <label htmlFor="detector">Detector</label>
          <select id="detector" value={detector} onChange={(event) => setDetector(event.target.value)}>
            <option value="">All detectors</option>
            {['D1', 'D2', 'D3', 'D4', 'D5', 'D6'].map((band) => <option key={band}>{band}</option>)}
          </select>
          </>}
          <button className="primary" type="submit">{showResults && sequence.busy ? 'Start new search' : 'Start'} <span aria-hidden="true">↗</span></button>
          {validation && <p className="error" role="alert">{validation}</p>}
        </form>
        {mode === 'explore' && <section className="suggested-fields" aria-label="Suggested fields">
          <h3>Suggested fields</h3>
          {fields.map((field) => <button className="preset" key={field.name} onClick={() => setInputs(field.inputs)}>
            <strong>{field.name}</strong><span>{field.reason}</span>
          </button>)}
        </section>}
        {showResults && <div className="progress-block" role="status" aria-live="polite">
          <div className="section-heading"><span className="eyebrow">OBSERVATION STATUS</span><span className={sequence.busy ? 'status active' : 'status'}>{status}</span></div>
          <progress aria-label="Frames processed" max={progress?.total || 1} value={finished} />
          <div className="stats"><span><b>{progress?.ready ?? 0}</b> ready</span><span><b>{progress?.failed ?? 0}</b> failed</span><span><b>{progress?.total ?? 0}</b> total</span></div>
          {sequence.notice && <p className="hint">{sequence.notice}</p>}
          {sequence.page && sequence.page.remaining > 0 && <p className="hint">{sequence.page.scheduledCount} of {progress?.total} exposures requested. {sequence.page.remaining} not requested yet.</p>}
          {sequence.busy && <button className="text-button" disabled={!sequence.resumable} onClick={sequence.stop}>Stop loading</button>}
          {!sequence.busy && sequence.resumable && <button className="primary" onClick={() => void sequence.resume()}>{sequence.paused ? 'Resume loading' : 'Load next batch'}</button>}
          {sequence.error && <p className="error" role="alert">{sequence.error}</p>}
          {missingPreferredFrame && <p className="hint">
            The documented pair is incomplete. The viewer uses available aligned frames.
            {sequence.page?.status === 'partial' || sequence.page?.status === 'failed' ? ' Select Start to retry.' : ''}
          </p>}
          {sequence.page?.status === 'completed' && progress?.total === 0 && <p>No observations cover this location.</p>}
        </div>}
        {mode === 'explore' && (blinkMode ? <p className="hint">Aligned blink uses a different display grid. <button onClick={() => { setBlinkMode(false); resetBlink() }}>Return to native image for region selection</button></p> : <FingerprintControls key={JSON.stringify(explorer.selection)} explorer={explorer} frame={selected} />)}
      </aside>
      <section className="panel viewer-panel" aria-label="Frame viewer">
        <div className="viewer-heading"><div><p className="eyebrow">{mode === 'validate' && activeExample ? activeExample.name : 'OBSERVATIONS'}</p><h2>{selected ? `Visit ${selected.visit + 1}` : 'Your window into the sky'}</h2></div><span className="tag">{ready.length ? `${index + 1} / ${ready.length}` : 'NO FRAMES YET'}</span></div>
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
        {blinkMode && reference && <div className="gaia-controls">
          <label><input type="checkbox" checked={gaia.enabled} onChange={(event) => gaia.toggle(event.target.checked)} /> Gaia reference stars</label>
          {gaia.enabled && !!gaia.catalogue?.sources.length && <label>
            <input type="checkbox" checked={gaiaLabels} onChange={(event) => setGaiaLabels(event.target.checked)} /> Show Gaia labels
          </label>}
          {showArosaControl && <label>
            <input type="checkbox" checked={showArosa} onChange={(event) => setShowArosa(event.target.checked)} /> Show Arosa trajectory
          </label>}
          {gaia.enabled && <span role="status">
            {gaia.loading ? 'Looking up Gaia DR3 sources…' : gaia.error
              ? gaia.error + ' Toggle off and on to retry.'
              : gaia.catalogue?.sources.length === 0 ? 'No catalogue sources found in this field.'
              : gaia.catalogue?.limited ? 'Showing the brightest catalogue matches in this field.' : ''}
          </span>}
        </div>}
        <div className={blinkMode ? "image-stage aligned-stage" : "image-stage"} tabIndex={0} aria-label={blinkMode ? 'Aligned observation image; use left and right arrows to switch frames' : 'Observation image; use left and right arrows to change frames'}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            if (blinkMode) {
              showBlinkFrame(activeIndex + (event.key === 'ArrowRight' ? 1 : -1));
            } else {
              move(index + (event.key === 'ArrowRight' ? 1 : -1));
            }
          }}>
          {mode === 'explore' && !blinkMode && selected ? <RegionImage key={selected.id} frame={{ ...selected, imageData: preview(selected) ?? selected.imageData }} zoom={zoom} explorer={explorer} sequenceId={spectrumSequenceId} showBackground clickToSelect /> : mode === 'explore' && !blinkMode && unavailableSelection ? <div className="empty-state" role="status"><h3>Selected frame unavailable</h3><p>{unavailableSelection.error?.message ?? 'Preview could not be loaded.'}</p></div> : blinkMode && visible?.alignedImageData && visibleGrid ? <div className="aligned-image"
            style={{ width: zoom === 'fit' ? 'min(90%, 85cqh)' : `min(90%, ${visibleGrid.width * Number(zoom)}px)` }}>
            <img src={visible.alignedImageData} alt={`SPHEREx ${visible.detector} observation at ${visible.observedAtUtc}`} />
            {gaia.enabled && gaia.catalogue && sequence.query && <GaiaMarkers catalogue={gaia.catalogue}
              query={sequence.query} observedAt={visible.observedAtUtc} image={visible.alignedImageData}
              side={visibleGrid.width} showLabels={gaiaLabels} />}
            {arosa && <>
              <svg className="arosa-track" viewBox={`0 0 ${visibleGrid.width} ${visibleGrid.height}`} aria-hidden="true">
                <line x1={arosa.start.x} y1={arosa.start.y} x2={arosa.end.x} y2={arosa.end.y} />
              </svg>
              <span className={arosa.verified ? 'arosa-marker' : 'arosa-marker arosa-estimated'} role="img"
                aria-label={arosa.verified ? 'Arosa position checked in this exposure' : 'Estimated Arosa position'}
                style={{ left: `${100 * arosa.x / visibleGrid.width}%`, top: `${100 * arosa.y / visibleGrid.height}%` }}>
                <span className={arosa.x > visibleGrid.width / 2 ? 'arosa-label-left' : undefined}>
                  {arosa.verified ? 'Arosa' : 'Arosa (est.)'}
                </span>
              </span>
            </>}
          </div> : visible ? <img style={zoom === 'fit' ? { width: 'auto', height: '85%' } : {
            width: (visibleGrid?.width ?? 29) * Number(zoom), height: 'auto',
          }} src={preview(visible)} alt={`SPHEREx ${visible.detector} observation at ${visible.observedAtUtc}`} /> :
            <div className="empty-state"><span className="crosshair" aria-hidden="true">+</span><h3>{blinkMode && ready.length ? 'No aligned frames available' : sequence.busy ? 'Listening for the first frame' : 'Start with a sky location'}</h3><p>{sequence.busy ? 'Images will appear here while the rest load.' : 'Choose a field or example and select Start.'}</p></div>}
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
      {mode === 'explore' && <FingerprintPanel explorer={explorer} frame={selected} frames={ready} onSelect={id => { setBlinkMode(false); selectFrame(id); setTab('image') }} />}
    </div>
    {ready.length > 0 && <section className="panel filmstrip-panel"><div className="section-heading"><h2>Observation timeline</h2><span className="tag">{ready.length} LOADED</span></div>
      <div className="filmstrip">{ready.map((frame, i) => <button key={frame.id} aria-label={`Select frame ${i + 1}, ${frame.detector}, ${frame.observedAtUtc}`} aria-pressed={(blinkMode ? reference : selected)?.id === frame.id} disabled={blinkMode && !frame.alignedImageData} onClick={() => selectFrame(frame.id)}>
        <img src={preview(frame)} alt="" loading="lazy" /><span>{String(i + 1).padStart(2, '0')} · V{frame.visit + 1}</span><small>{frame.observedAtUtc.slice(0, 10)}</small></button>)}</div>
    </section>}
    {mode === 'explore' && <ChannelMeasurements explorer={explorer} />}
    {failed.length > 0 && <details className="panel failures"><summary>{failed.length} frames could not be loaded</summary><ul>{failed.map((frame) => <li key={frame.id}><strong>{frame.detector} · {frame.observedAtUtc}</strong><p>{frame.error?.message ?? 'Frame unavailable.'}</p></li>)}</ul></details>}
    <footer><span>SPHEREx Sky Blink</span><span>NASA Space Apps 2026 · Archive data via backend</span></footer>
  </main>
}
export default App;

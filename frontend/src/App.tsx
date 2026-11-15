import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useFingerprint } from './state/useFingerprint';
import { RegionImage } from './components/RegionImage';
import { FingerprintControls, FingerprintPanel, ChannelMeasurements } from './components/FingerprintExplorer';
import { loadRegionProjection } from './api/regionProjection';
import { useFrames } from './state/useFrames';
import type { Frame, MotionCandidate } from './api/frames';
import { GaiaMarkers } from './GaiaOverlay';
import { arosaPosition } from './state/arosaValidation';
import { vestaPosition } from './state/vestaValidation';
import { useGaiaCatalogue } from './state/useGaiaCatalogue';
import { useAutoObservation } from './state/useAutoObservation';
import { MovingCandidates } from './MovingCandidates';
import { MovingCandidateAnalysis } from './MovingCandidateAnalysis';
import { Home } from './Home';
import { AlignedPreview } from './components/AlignedPreview';
import { LightCurve } from './components/LightCurve';
import type { LightCurvePoint } from './components/LightCurve';
import { FrameMarker } from './components/FrameMarker';
import { ObservationFields } from './ObservationFields';
import { examples, fields, preloadedValidationSequence } from './state/validationExamples';
import './App.css';
import './components/SpectralExplorer.css';

function currentMode() {
  return window.location.hash === '#validate' ? 'validate' : window.location.hash === '#explore' ? 'explore' : 'home';
}


function BrightnessFootprint({ point, aligned }: { point: LightCurvePoint; aligned: boolean }) {
  return <svg className="brightness-footprint" viewBox="0 0 100 100" preserveAspectRatio="none"
    role="img" aria-label="Pixels used for the brightness measurement">
    <title>Cyan pixels contributed to the measurement. The dark core is excluded.</title>
    {point.pixels.map((pixel, index) => {
      const corners = aligned ? pixel.aligned : pixel.native;
      return corners && <polygon key={index}
        points={corners.map(([x, y]) => `${x * 100},${y * 100}`).join(' ')}
        fillOpacity={0.14 + pixel.weight * 0.26} vectorEffect="non-scaling-stroke" />;
    })}
  </svg>;
}

function App() {
  const sequence = useFrames();
  const imageStage = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState(currentMode);
  const activeExample = examples.find((item) => item.id === sequence.validationExampleId)
    ?? (sequence.query?.exposureIds?.[0]
      ? examples.find((item) => item.exposureIds?.[0] === sequence.query?.exposureIds?.[0])
      : undefined);
  const [exampleId, setExampleId] = useState(activeExample?.id ?? examples[0].id);
  const example = examples.find((item) => item.id === exampleId) ?? examples[0];
  const [detector, setDetector] = useState(sequence.query?.detector ?? '');
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
  const [zoom, setZoom] = useState(activeExample ? 'fit' : '4');
  const [analysisRadius, setAnalysisRadius] = useState(2.5);
  const [analysisRequest, setAnalysisRequest] = useState(0);
  const [tab, setTab] = useState('image');
  const [contrast, setContrast] = useState('shared');
  const [reviewContrast, setReviewContrast] = useState('auto');
  const [blinkMode, setBlinkMode] = useState(!!activeExample);
  const [showTrajectory, setShowTrajectory] = useState(true);
  const [gaiaLabels, setGaiaLabels] = useState(false);
  const gaia = useGaiaCatalogue(mode !== 'home' && showResults && blinkMode ? sequence.page?.sequenceId : undefined);
  const [appendedIds, setAppendedIds] = useState<string[] | null>(null);
  const [candidateId, setCandidateId] = useState('');
  const [playing, setPlaying] = useState(false);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [blinkIndex, setBlinkIndex] = useState(0);
  const [brightness, setBrightness] = useState<{ key: string; points: LightCurvePoint[] }>();

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
  const reference = aligned.find((frame) => frame.id === (selectedId ?? activeExample?.blinkIds[0])) ?? aligned[0];
  const comparisons = reference && aligned.filter((frame) => frame.id !== reference.id &&
    frame.detector === reference.detector && frame.release === reference.release &&
    frame.sharedDisplay?.vmin === reference.sharedDisplay?.vmin &&
    frame.sharedDisplay?.vmax === reference.sharedDisplay?.vmax &&
    frame.observedAtUtc !== reference.observedAtUtc);
  const wavelengthDistance = (frame: Frame) => frame.wavelengthUm == null || reference?.wavelengthUm == null
    ? Infinity : Math.abs(frame.wavelengthUm - reference.wavelengthUm);
  const closest = comparisons?.reduce<Frame | undefined>((best, frame) =>
    !best || wavelengthDistance(frame) < wavelengthDistance(best) ? frame : best, undefined);
  const preferredIds = activeExample?.blinkIds.filter((id) => comparisons?.some((frame) => frame.id === id)) ?? [];
  const defaultIds = preferredIds.length ? preferredIds : closest ? [closest.id] : [];
  const chosenIds = appendedIds ?? defaultIds;
  const blinkFrames = reference ? [reference, ...chosenIds.flatMap((id) =>
    comparisons?.filter((frame) => frame.id === id) ?? [])] : [];
  const candidates = comparisons?.filter((frame) => !chosenIds.includes(frame.id)) ?? [];
  const candidate = candidates.find((frame) => frame.id === candidateId) ?? candidates[0];
  const blinkCount = blinkFrames.length;
  const activeIndex = Math.min(blinkIndex, Math.max(0, blinkCount - 1));
  const visible = blinkMode ? blinkFrames[activeIndex] : selected;
  const downloadComplete = (sequence.page?.status === 'completed' || sequence.page?.status === 'partial')
    && !sequence.busy && !sequence.page.hasMore;
  const canAnalyze = showResults && downloadComplete && !!ready.length;
  const missingFits = canAnalyze && ready.some((frame) => frame.scienceStatus === 'unavailable');

  function reloadAnalysisField() {
    if (!sequence.query) return;
    resetBlink();
    void sequence.start(sequence.query, true, activeExample?.id);
  }
  const observation = useAutoObservation(canAnalyze ? sequence.page?.sequenceId : undefined);
  const motion = canAnalyze && observation.result?.status === 'completed' ? observation.result : null;
  const activeTrack = motion?.candidates.find((candidate) => candidate.id === reviewId);
  const timelineFrames = activeTrack ? blinkFrames : ready;
  const autoContrastSequence = activeTrack && reviewContrast === 'auto' ? sequence.page?.sequenceId : undefined;
  const reviewRank = activeTrack ? motion!.candidates.findIndex((candidate) => candidate.id === activeTrack.id) + 1 : 0;
  function alignedAutoUrl(frame: Frame) {
    return autoContrastSequence && frame.scienceStatus === 'retained'
      ? `/api/frames/${encodeURIComponent(autoContrastSequence)}/frames/${encodeURIComponent(frame.id)}/aligned-auto.png`
      : undefined;
  }
  const measured = blinkMode && activeTrack?.detections.find((point) => point.frameId === visible?.id);
  const visibleGrid = blinkMode ? visible?.alignedGrid : visible?.grid;
  const lightCurveKey = `${activeExample?.id}:${sequence.page?.sequenceId}`;
  const brightnessPoint = mode === 'validate' && brightness?.key === lightCurveKey
    ? brightness.points.find(point => point.frameId === visible?.id) : undefined;
  function trajectoryFor(frame: Frame) {
    const vesta = vestaPosition(frame, sequence.query);
    if (vesta) return { ...vesta, name: 'Vesta' };
    const arosa = arosaPosition(frame, sequence.query);
    return arosa ? { ...arosa, name: 'Arosa', path: [arosa.start, arosa.end] } : null;
  }

  const trajectoryName = blinkMode ? blinkFrames.map(trajectoryFor).find(Boolean)?.name : undefined;
  const trajectory = blinkMode && showTrajectory && visible ? trajectoryFor(visible) : null;

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
    setReviewId(null);
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

  function showTimelineFrame(frame: Frame) {
    const position = blinkMode ? blinkFrames.findIndex((item) => item.id === frame.id) : -1;
    if (position >= 0) {
      showBlinkFrame(position);
    } else {
      if (blinkMode && !aligned.some((item) => item.id === frame.id)) setBlinkMode(false);
      selectFrame(frame.id);
    }
  }

  function reviewCandidate(track: MotionCandidate) {
    const [first, ...remaining] = track.detections;
    resetBlink();
    setReviewId(track.id);
    setAnalysisRequest(0);
    setReviewContrast('auto');
    setSelectedId(first.frameId);
    setAppendedIds(remaining.map((point) => point.frameId));
    setBlinkMode(true);
    setZoom('fit');
  }

  function openCandidateAnalysis() {
    setAnalysisRequest((request) => request + 1);
    window.setTimeout(() => document.getElementById('moving-candidate-analysis')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }

  function viewStationarySpectrum() {
    setTab('spectrum');
    window.setTimeout(() => document.getElementById('stationary-region-spectrum')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }

  function selectStationaryRegion() {
    setBlinkMode(false);
    resetBlink();
    setTab('image');
    window.setTimeout(() => document.getElementById('observation-image')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
  }

  function viewMovingAnalysis() {
    setTab('image');
    if (activeTrack) {
      window.setTimeout(() => document.getElementById('moving-candidate-analysis')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
    } else {
      const panel = document.getElementById('auto-observation');
      if (panel instanceof HTMLDetailsElement) panel.open = true;
      window.setTimeout(() => panel?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
    }
  }

  function leaveCandidateReview() {
    setBlinkMode(false);
    resetBlink();
    setTab('image');
  }

  function selectFrame(id: string) {
    setSelectedId(id);
    resetBlink();
  }

  const progress = showResults ? sequence.page?.progress : undefined;
  const finished = (progress?.ready ?? 0) + (progress?.failed ?? 0);
  const missingPreferredFrame = mode === 'validate' && activeExample &&
    ['completed', 'partial', 'failed'].includes(sequence.page?.status ?? '') &&
    activeExample.blinkIds.some((id) => !aligned.some((frame) => frame.id === id));
  const status = sequence.paused ? 'paused' : sequence.busy ? sequence.page?.status ?? 'submitting' : sequence.page && ['queued', 'discovering', 'running'].includes(sequence.page.status) ? 'paused' : sequence.page?.status ?? 'idle';

  function startValidation(item: (typeof examples)[number]) {
    setValidation('');
    setSelectedId(null);
    setExampleId(item.id);
    resetBlink();
    setBlinkMode(true);
    setZoom('fit');
    setShowTrajectory(true);
    gaia.toggle(true);
    if (mode === 'home') {
      setMode('validate');
      window.location.assign('#validate');
    }
    const { ra, dec, fov } = item.inputs;
    void sequence.start({ ra: Number(ra), dec: Number(dec), fov: Number(fov),
      exposureIds: item.exposureIds }, false, item.id, preloadedValidationSequence(item.id));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === 'validate') {
      startValidation(example);
      return;
    }

    const query = { ra: Number(inputs.ra), dec: Number(inputs.dec), fov: Number(inputs.fov) };
    if (Object.values(inputs).some((value) => !value.trim()) ||
        !Object.values(query).every(Number.isFinite) || query.ra < 0 || query.ra >= 360 ||
        query.dec < -90 || query.dec > 90 || query.fov <= 0 || query.fov > 1) {
      setValidation('Enter RA from 0 to <360, Dec from -90 to 90, and FOV from >0 to 1 degree.');
      return;
    }
    setValidation('');
    setSelectedId(null);
    resetBlink();
    if (mode === 'home') {
      setDetector('');
      setBlinkMode(false);
      setTab('image');
      setMode('explore');
      window.location.assign('#explore');
    }
    void sequence.start({ ...query, detector: mode === 'home' ? undefined : detector || undefined },
      ready.length > 0 && ready.every(frame => frame.scienceStatus === 'unavailable'));
  }

  function move(next: number) {
    const frame = ready[Math.max(0, Math.min(ready.length - 1, next))];
    if (frame) selectFrame(frame.id);
  }

  if (mode === 'home') return <Home inputs={inputs} setInputs={setInputs} validation={validation}
    onObserve={submit} onValidate={startValidation} />;

  return <main className="shell workflow-shell" data-tab={mode === 'explore' ? tab : undefined}>
    <header className="masthead">
      <div className="brand"><span className="orbit" aria-hidden="true">✳</span> Sifting Skies <span> / SPHEREx</span></div>
      <nav className="workspace-nav" aria-label="Workflows">
        <a href="#home">Home</a>
        <a href="#validate" aria-current={mode === 'validate' ? 'page' : undefined}>Validate</a>
        <a href="#explore" aria-current={mode === 'explore' ? 'page' : undefined}>Explore</a>
      </nav>
    </header>
    <section className="intro workflow-intro">
      {mode === 'validate' && activeExample && <p>Validate a known object</p>}
      <h1>{mode === 'validate' ? activeExample?.name ?? 'Validate a known object' : 'Explore for movement'}</h1>
      <p>{mode === 'validate'
        ? 'Compare SPHEREx observations of a known object across dates.'
        : 'Choose a sky field and compare observations at different times.'}</p>
    </section>
    {mode === 'explore' && <div className="mobile-tabs" role="tablist" aria-label="Explorer views">{['image', 'spectrum', 'measurements'].map(name => <button key={name} role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>{name[0].toUpperCase() + name.slice(1)}</button>)}</div>}
    <div className={`workspace frame-workspace${mode === 'explore' ? ' spectral-workspace' : ''}`}>
      <section className="panel viewer-panel" aria-label="Frame viewer">
        <section className="frames-timeline" aria-label="Frames timeline">
          <div className="section-heading">
            <h2>Frames timeline</h2>
            <span className="tag">{timelineFrames.length} frames</span>
            {activeTrack && <button className="text-button" onClick={resetBlink}>Show all frames</button>}
          </div>
          {timelineFrames.length > 0 && <div className="filmstrip">
            {timelineFrames.map((frame, i) => <button key={frame.id}
              aria-label={`Show frame ${i + 1}, ${frame.detector}, ${frame.observedAtUtc}`}
              aria-pressed={visible?.id === frame.id}
              onClick={() => showTimelineFrame(frame)}>
              {blinkMode && frame.alignedImageData
                ? <AlignedPreview key={alignedAutoUrl(frame) ?? frame.id} autoUrl={alignedAutoUrl(frame)}
                    lockedUrl={frame.alignedImageData} alt="" thumbnail />
                : <img src={preview(frame)} alt="" loading="lazy" />}
              <span>{i + 1} · {frame.detector.replace('SPHEREx-', '')}</span>
              <small>{frame.observedAtUtc.slice(0, 10)}</small>
            </button>)}
          </div>}
        {blinkMode ? <div className="navigation blink-navigation">
            <button disabled={blinkCount < 2} onClick={() => showBlinkFrame(activeIndex - 1)}>← Previous</button>
            <button disabled={blinkCount < 2} onClick={() => {
              if (!playing && reference && mode !== 'validate') {
                setSelectedId(reference.id);
                setAppendedIds(chosenIds);
              }
              setPlaying(!playing);
            }}>{playing ? 'Pause blink' : 'Play blink'}</button>
            <button disabled={blinkCount < 2} onClick={() => showBlinkFrame(activeIndex + 1)}>Next →</button>
          </div>
         : <div className="navigation"><button aria-label="Previous frame" disabled={!selected || index === 0} onClick={() => move(index - 1)}>← Previous</button>
          <input type="range" aria-label="Selected frame" min="0" max={Math.max(0, ready.length - 1)} value={index} disabled={ready.length < 2} onChange={(e) => move(Number(e.target.value))} />
          <button aria-label="Next frame" disabled={!selected || index >= ready.length - 1} onClick={() => move(index + 1)}>Next →</button></div>}
        {showResults && sequence.query && <div className="progress-block" role="status" aria-live="polite">
          <div className="section-heading"><span className="eyebrow">Download status</span><span className={sequence.busy ? 'status active' : 'status'}>{status}</span></div>
          <progress aria-label="Frames processed" max={progress?.total || 1} value={finished} />
          <div className="stats"><span><b>{progress?.ready ?? 0}</b> ready</span><span><b>{progress?.failed ?? 0}</b> failed</span><span><b>{progress?.total ?? 0}</b> total</span></div>
          {sequence.notice && <p className="hint">{sequence.notice}</p>}
          {sequence.page && sequence.page.remaining > 0 && <p className="hint">{sequence.page.scheduledCount} of {progress?.total} exposures requested. {sequence.page.remaining} not requested yet.</p>}
          {sequence.busy && <button className="text-button" disabled={!sequence.resumable} onClick={sequence.stop}>Stop loading</button>}
          {!sequence.busy && sequence.resumable && <button className="primary" onClick={() => void sequence.resume()}>Resume loading</button>}
          {sequence.error && <p className="error" role="alert">{sequence.error}</p>}
          {missingPreferredFrame && <p className="hint">
            The documented comparison is incomplete. The viewer uses available aligned frames.
            {sequence.page?.status === 'partial' || sequence.page?.status === 'failed' ? ' Select Start to retry.' : ''}
          </p>}
          {sequence.page?.status === 'completed' && progress?.total === 0 && <p>No observations cover this location.</p>}
        </div>}
        </section>
        {showResults && sequence.query && <section id="auto-observation" className="auto-observation" aria-labelledby="auto-observation-heading">
          <div className="section-heading">
            <h3 id="auto-observation-heading">Auto observation</h3>
            <button className="primary" disabled={!canAnalyze || observation.pending ||
              !observation.result?.availableFrames || observation.result.status === 'running'}
              onClick={() => { setReviewId(null); void observation.start(); }}>
              {motion ? 'Run auto observation again' : 'Start auto observation'}
            </button>
          </div>
          {!downloadComplete && !sequence.error && <p>Available after the frame downloads finish.</p>}
          {downloadComplete && !ready.length && <p>No frames are available for analysis.</p>}
          {observation.pending && <p role="status">Checking analysis status…</p>}
          {observation.error && <>
            <p role="alert">{observation.error}</p>
            <button className="text-button" onClick={() => void observation.reconnect()}>Check status</button>
          </>}
          {observation.result?.status === 'running' && <div role="status">
            <p>Analyzing {observation.result.processedFrames} of {observation.result.availableFrames} frames…</p>
            <progress aria-label="Frames analyzed" max={observation.result.availableFrames} value={observation.result.processedFrames} />
          </div>}
          {observation.result?.status === 'failed' && <p role="alert">{observation.result.error}</p>}
          {observation.result && observation.result.availableFrames < observation.result.readyFrames && (
            <p>{observation.result.availableFrames} of {observation.result.readyFrames} downloaded frames have retained FITS data and aligned previews for analysis.</p>
          )}
          {missingFits && <p role="status">
            This saved search is missing some FITS data. A search of the available frames can miss real motion.
            {' '}<button className="text-button" onClick={reloadAnalysisField}>Reload field for analysis</button>
          </p>}
          {motion && <MovingCandidates search={motion} activeId={reviewId} onReview={reviewCandidate} />}
        </section>}
        {mode === 'validate' && (activeExample?.id === 'rw-aur' || activeExample?.id === 'r-dra') &&
          <LightCurve key={lightCurveKey} onMeasured={points => setBrightness({ key: lightCurveKey, points })}
            sequenceId={canAnalyze ? sequence.page?.sequenceId : undefined} outerWings={activeExample.id === 'r-dra'}
            selectedId={visible?.id} onSelect={(frameId, reveal) => {
              const frame = ready.find(item => item.id === frameId);
              if (!frame) return;
              showTimelineFrame(frame);
              if (reveal) imageStage.current?.scrollIntoView({ block: 'center' });
            }} />}
        <div ref={imageStage} className={blinkMode || brightnessPoint ? "image-stage aligned-stage" : "image-stage"} tabIndex={0} aria-label={blinkMode ? 'Aligned observation image; use left and right arrows to switch frames' : 'Observation image; use left and right arrows to change frames'}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            if (blinkMode) {
              showBlinkFrame(activeIndex + (event.key === 'ArrowRight' ? 1 : -1));
            } else {
              move(index + (event.key === 'ArrowRight' ? 1 : -1));
            }
          }}>
          {mode === 'explore' && !blinkMode && selected ? <div id="observation-image"><RegionImage key={selected.id} frame={{ ...selected, imageData: preview(selected) ?? selected.imageData }} zoom={zoom} explorer={explorer} sequenceId={spectrumSequenceId} showBackground clickToSelect onRegionSelected={viewStationarySpectrum} /></div> : mode === 'explore' && !blinkMode && unavailableSelection ? <div className="empty-state" role="status"><h3>Selected frame unavailable</h3><p>{unavailableSelection.error?.message ?? 'Preview could not be loaded.'}</p></div> : blinkMode && visible?.alignedImageData && visibleGrid ? <div className="aligned-image"
            style={{ width: zoom === 'fit' ? 'min(90%, 85cqh)' : `min(90%, ${visibleGrid.width * Number(zoom)}px)` }}>
            <AlignedPreview key={alignedAutoUrl(visible) ?? visible.id} autoUrl={alignedAutoUrl(visible)}
              lockedUrl={visible.alignedImageData} alt={`SPHEREx ${visible.detector} observation at ${visible.observedAtUtc}`}
              showFallback={!!autoContrastSequence} />
            {gaia.enabled && gaia.catalogue && sequence.query && <GaiaMarkers key={visible.id} catalogue={gaia.catalogue}
              query={sequence.query} observedAt={visible.observedAtUtc} image={visible.alignedImageData}
              side={visibleGrid.width} showLabels={gaiaLabels} showDetails={downloadComplete} onInspect={() => setPlaying(false)} />}
            {brightnessPoint && <BrightnessFootprint point={brightnessPoint} aligned />}
            {measured && <FrameMarker key={`candidate-${visible.id}`} className="motion-marker" label="Measured candidate position"
              kind="Motion candidate" enabled={downloadComplete} onInspect={() => setPlaying(false)}
              clickHint="Click to view aperture measurements" onClickAction={openCandidateAnalysis}
              style={{ left: `${100 * measured.x / visibleGrid.width}%`, top: `${100 * measured.y / visibleGrid.height}%` }}>
              <span>Candidate</span>
            </FrameMarker>}
            {measured && <svg className="candidate-aperture-overlay" viewBox={`0 0 ${visibleGrid.width} ${visibleGrid.height}`} aria-hidden="true">
              <circle cx={measured.x} cy={measured.y} r={analysisRadius} />
            </svg>}
            {trajectory && !activeTrack && <>
              <svg className="arosa-track" viewBox={`0 0 ${visibleGrid.width} ${visibleGrid.height}`} aria-hidden="true">
                <polyline points={trajectory.path.map(({ x, y }) => `${x},${y}`).join(' ')} />
              </svg>
              <FrameMarker key={`${trajectory.name}-${visible.id}`} className={trajectory.verified ? 'arosa-marker' : 'arosa-marker arosa-estimated'}
                label={trajectory.verified ? `${trajectory.name} position checked in this exposure` : `Estimated ${trajectory.name} position`}
                kind="Known object" enabled={downloadComplete} onInspect={() => setPlaying(false)}
                style={{ left: `${100 * trajectory.x / visibleGrid.width}%`, top: `${100 * trajectory.y / visibleGrid.height}%` }}>
                <span className={trajectory.x > visibleGrid.width / 2 ? 'arosa-label-left' : undefined}>
                  {trajectory.name}{!trajectory.verified && ' (est.)'}
                </span>
              </FrameMarker>
            </>}
          </div> : visible && brightnessPoint && visibleGrid ? <div className="aligned-image"
            style={{ width: zoom === 'fit'
              ? `min(90%, calc(85cqh * ${visibleGrid.width / visibleGrid.height}))`
              : `min(90%, ${visibleGrid.width * Number(zoom)}px)` }}>
            <img src={preview(visible)} alt={`SPHEREx ${visible.detector} observation at ${visible.observedAtUtc}`} />
            <BrightnessFootprint point={brightnessPoint} aligned={false} />
          </div> : visible ? <img style={zoom === 'fit' ? { width: 'auto', height: '85%' } : {
            width: (visibleGrid?.width ?? 29) * Number(zoom), height: 'auto',
          }} src={preview(visible)} alt={`SPHEREx ${visible.detector} observation at ${visible.observedAtUtc}`} /> :
            <div className="empty-state"><span className="crosshair" aria-hidden="true">+</span><h3>{blinkMode && ready.length ? 'No aligned frames available' : sequence.busy ? 'Listening for the first frame' : 'Start with a sky location'}</h3><p>{sequence.busy ? 'Images will appear here while the rest load.' : 'Choose a field or example and select Start.'}</p></div>}
          <span className="stage-label">{blinkMode && visible ? `FRAME ${activeIndex + 1} / ${blinkCount}` : 'SPHEREx / INFRARED'}</span><span className="stage-label right">{visibleGrid ? `${visibleGrid.width} × ${visibleGrid.height} PX` : 'AWAITING SIGNAL'}</span>
        </div>
        <section className="frame-metadata" aria-label="Frame metadata">
          <h2>Frame metadata</h2>
          {!visible && <p className="hint">Frame details appear as images load.</p>}
          {blinkCount > 0 && <div className="blink-table-scroll" role="region" aria-label="Selected frame comparison" tabIndex={0}>
            <table className="blink-table">
              <caption>Selected frame comparison</caption>
              <thead><tr>
                <th scope="col">Frame</th><th scope="col">Observed (UTC)</th><th scope="col">Visit</th>
                <th scope="col">Detector</th><th scope="col">Release</th><th scope="col">Wavelength at target (µm)</th>
                {activeTrack && <><th scope="col">Measured RA / Dec</th><th scope="col">Peak S/N</th></>}
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
              {activeTrack && (() => {
                const point = activeTrack.detections.find((entry) => entry.frameId === frame.id);
                return <><td>{point ? `${point.ra.toFixed(5)}°, ${point.dec.toFixed(5)}°` : '—'}</td>
                  <td>{point ? point.signalToNoise.toFixed(1) : '—'}</td></>;
              })()}
              <td>{position > 0 && <button aria-label={`Remove frame ${position + 1}`} onClick={() => {
                showBlinkFrame(position === activeIndex ? 0 : activeIndex - Number(position < activeIndex));
                setAppendedIds(chosenIds.filter((id) => id !== frame.id));
              }}>Remove</button>}</td>
              </tr>)}</tbody>
            </table>
          </div>}
        {!blinkMode && visible && <dl className="metadata"><div><dt>OBSERVED · UTC</dt><dd>{visible.observedAtUtc.replace('T', ' ').replace('Z', '')}</dd></div><div><dt>DETECTOR</dt><dd>{visible.detector}</dd></div><div><dt>RELEASE</dt><dd>{visible.release}</dd></div>{visible.wavelengthUm != null && <div><dt>WAVELENGTH AT TARGET</dt><dd>{visible.wavelengthUm.toFixed(3)} µm</dd></div>}</dl>}
        <p className="preview-note">{blinkMode
          ? `North up · 6.15 arcsec/pixel · ${autoContrastSequence ? 'auto contrast per frame' : 'locked contrast'}. Frames play in the order shown. The first comparison defaults to the closest available wavelength from the same detector.`
          : (contrast === 'shared'
          ? selected && !selected.sharedImageData
            ? 'Locked contrast is unavailable for this frame. Showing auto contrast.'
            : 'Contrast stays fixed within a detector. Brightness can still change with wavelength.'
          : 'Each frame has its own brightness scale.') + ' Previews are unaligned.'}</p>
        </section>
        {activeTrack && <section className="candidate-review-state" aria-label="Verify candidate">
          <h3>Verify candidate {reviewRank}</h3>
          <p>{activeTrack.detector} · {activeTrack.detections.length} measured positions · {activeTrack.displacementArcsec.toFixed(0)}″ over {activeTrack.elapsedHours.toFixed(1)} h.</p>
          <p>The violet markers follow measured positions. Validate is the separate workflow for prepared known-object examples.</p>
          <button className="text-button" onClick={leaveCandidateReview}>Return to observations</button>
        </section>}
        {activeTrack && spectrumSequenceId && <MovingCandidateAnalysis key={activeTrack.id} sequenceId={spectrumSequenceId} candidate={activeTrack} radius={analysisRadius} onRadiusChange={setAnalysisRadius} autoMeasureRequest={analysisRequest} onViewStationarySpectrum={viewStationarySpectrum} />}
        <details className="frame-settings">
          <summary>Frame display and blink settings</summary>
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
        {blinkMode && activeTrack && <label className="zoom-control">Candidate contrast
          <select value={reviewContrast} onChange={(event) => setReviewContrast(event.target.value)}>
            <option value="auto">Auto per frame</option>
            <option value="locked">Locked by detector</option>
          </select>
        </label>}
        {!blinkMode && <label className="zoom-control">Contrast
          <select value={contrast} onChange={(event) => setContrast(event.target.value)}>
            <option value="shared">Locked by detector</option>
            <option value="auto">Auto per frame</option>
          </select>
        </label>}
        </div>
        {blinkMode && reference && !activeTrack && <div className="viewer-controls">
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
          {trajectoryName && <label>
            <input type="checkbox" checked={showTrajectory} onChange={(event) => setShowTrajectory(event.target.checked)} /> Show {trajectoryName} trajectory
          </label>}
          {gaia.enabled && <span role="status">
            {gaia.loading ? 'Looking up Gaia DR3 sources…' : gaia.error
              ? gaia.error + ' Toggle off and on to retry.'
              : gaia.catalogue?.sources.length === 0 ? 'No catalogue sources found in this field.'
              : gaia.catalogue?.limited ? 'Showing the brightest catalogue matches in this field.' : ''}
          </span>}
        </div>}
        </details>
      </section>
      <details className="panel controls observation-settings" open={!showResults || !sequence.query}>
        <summary>{mode === 'validate' ? 'Validation settings' : 'Observation settings'}</summary>
        <h2>{mode === 'validate' ? 'Choose an example' : 'Search a field'}</h2>
        <form onSubmit={submit}>
          {mode === 'validate' ? <>
            <label htmlFor="example">Validation example</label>
            <select id="example" value={exampleId} onChange={(event) => setExampleId(event.target.value)}>
              {examples.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <p className="example-purpose">{example.purpose}</p>
            {!example.exposureIds && <p className="hint">
              Searches the archive by field. Choose frames with similar wavelengths for comparison.
            </p>}
            <dl className="example-coordinates">
              <div><dt>RA</dt><dd>{example.inputs.ra}°</dd></div>
              <div><dt>Dec</dt><dd>{example.inputs.dec}°</dd></div>
              <div><dt>Field of view</dt><dd>{example.inputs.fov}°</dd></div>
            </dl>
          </> : <>
          <ObservationFields inputs={inputs} setInputs={setInputs} />
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
        {mode === 'explore' && (blinkMode ? <p className="hint">Aligned blink uses a different display grid. <button onClick={selectStationaryRegion}>Return to native image for region selection</button></p> : <FingerprintControls key={JSON.stringify(explorer.selection)} explorer={explorer} frame={selected} onRegionUpdated={viewStationarySpectrum} />)}
      </details>
      {mode === 'explore' && <FingerprintPanel explorer={explorer} frame={selected} frames={ready} onSelect={id => { setBlinkMode(false); selectFrame(id); setTab('image') }} onSelectRegion={selectStationaryRegion} onExploreMoving={viewMovingAnalysis} movingLinkLabel={activeTrack ? 'Go to moving-candidate analysis' : 'Go to Auto observation'} />}
    </div>
    {mode === 'explore' && <ChannelMeasurements explorer={explorer} open={tab === 'measurements'} />}
    {failed.length > 0 && <details className="panel failures"><summary>{failed.length} frames could not be loaded</summary><ul>{failed.map((frame) => <li key={frame.id}><strong>{frame.detector} · {frame.observedAtUtc}</strong><p>{frame.error?.message ?? 'Frame unavailable.'}</p></li>)}</ul></details>}
    <footer><span>Sifting Skies</span><span>NASA Space Apps 2026 · Archive data via backend</span></footer>
  </main>
}
export default App;

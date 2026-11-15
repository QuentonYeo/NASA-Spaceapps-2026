import { FrameMetadata } from './components/FrameMetadata';
import { AnalysisTabs } from './components/AnalysisTabs';
import type { AnalysisView } from './components/AnalysisTabs';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useFingerprint } from './state/useFingerprint';
import { RegionImage } from './components/RegionImage';
import { SaveKnownObject } from './components/SaveKnownObject';
import { readSavedKnownObjects, savedObjectKeyPrefix, savedValidationExample } from './state/savedKnownObjects';
import { FingerprintPanel, ChannelMeasurements } from './components/FingerprintExplorer';
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
import type { ValidationExample } from './state/validationExamples';
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
  const [savedObjects, setSavedObjects] = useState(readSavedKnownObjects);
  const knownObjects = [...savedObjects.map(savedValidationExample), ...examples];
  const activeExample = knownObjects.find((item) => item.id === sequence.validationExampleId)
    ?? (sequence.query?.exposureIds?.[0]
      ? examples.find((item) => item.exposureIds?.[0] === sequence.query?.exposureIds?.[0])
      : undefined);
  const [detector, setDetector] = useState(sequence.query?.detector ?? '');
  const [includeQr3, setIncludeQr3] = useState(() => sequence.query?.collections?.includes('spherex_qr3') ?? false);
  const showResults = mode === 'validate' ? !!activeExample : !activeExample;
  useEffect(() => {
    function updateMode() { setMode(currentMode()); }
    window.addEventListener('hashchange', updateMode);
    return () => window.removeEventListener('hashchange', updateMode);
  }, []);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(savedObjectKeyPrefix)) setSavedObjects(readSavedKnownObjects());
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  const [inputs, setInputs] = useState(() => sequence.query
    ? { ra: String(sequence.query.ra), dec: String(sequence.query.dec), fov: String(sequence.query.fov) }
    : (fields.find(field => field.id === 'wise-0855') ?? fields[0]).inputs);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [validation, setValidation] = useState('');
  const [zoom, setZoom] = useState(activeExample ? 'fit' : '4');
  const [analysisRadius, setAnalysisRadius] = useState(2.5);
  const [analysisRequest, setAnalysisRequest] = useState(0);
  const [analysisView, setAnalysisView] = useState<AnalysisView>('static');
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
  const reviewedTrack = motion?.candidates.find((candidate) => candidate.id === reviewId);
  const activeTrack = analysisView === 'motion' ? reviewedTrack : undefined;
  const timelineFrames = activeTrack ? blinkFrames : ready;
  const timelineIndex = timelineFrames.findIndex((frame) => frame.id === visible?.id);
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
  const brightnessPoint = analysisView === 'static' && mode === 'validate' && brightness?.key === lightCurveKey
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

  type ViewerState = { selectedId: string | null; blinkMode: boolean; appendedIds: string[] | null;
    blinkIndex: number; candidateId: string; zoom: string; contrast: string };
  const viewStates = useRef<Partial<Record<AnalysisView, ViewerState>>>({});
  const viewSequence = useRef(sequence.page?.sequenceId);
  useEffect(() => {
    if (viewSequence.current !== sequence.page?.sequenceId) {
      viewStates.current = {};
      viewSequence.current = sequence.page?.sequenceId;
    }
  }, [sequence.page?.sequenceId]);

  function changeAnalysisView(next: AnalysisView) {
    if (next === analysisView) return;
    viewStates.current[analysisView] = { selectedId, blinkMode, appendedIds, blinkIndex, candidateId, zoom, contrast };
    const saved = viewStates.current[next];
    setPlaying(false);
    setSelectedId(saved?.selectedId ?? selectedId);
    setBlinkMode(saved?.blinkMode ?? (mode === 'validate' || next === 'motion'));
    setAppendedIds(saved?.appendedIds ?? null);
    setBlinkIndex(saved?.blinkIndex ?? 0);
    setCandidateId(saved?.candidateId ?? '');
    setZoom(saved?.zoom ?? 'fit');
    setContrast(saved?.contrast ?? 'shared');
    setAnalysisView(next);
  }

  function resetBlink(clearReview = true) {
    if (clearReview) setReviewId(null);
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
    setBlinkIndex(next);
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
    changeAnalysisView('motion');
    const [first, ...remaining] = track.detections;
    resetBlink();
    setReviewId(track.id);
    setAnalysisRequest(0);
    setAnalysisRadius(2.5);
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
    changeAnalysisView('static');
    setBlinkMode(false);
    setPlaying(false);
    window.setTimeout(() => document.getElementById('stationary-region-spectrum')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }

  function selectStationaryRegion() {
    changeAnalysisView('static');
    setBlinkMode(false);
    setPlaying(false);
    window.setTimeout(() => document.getElementById('observation-image')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
  }

  function viewMovingAnalysis() {
    changeAnalysisView('motion');
    if (reviewedTrack) {
      const [first, ...remaining] = reviewedTrack.detections;
      setSelectedId(first.frameId);
      setAppendedIds(remaining.map(point => point.frameId));
      setBlinkMode(true);
      setPlaying(false);
      setBlinkIndex(0);
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
  }

  function selectFrame(id: string) {
    setSelectedId(id);
    if (!blinkMode && activeTrack) setPlaying(false);
    else resetBlink(analysisView === 'motion');
  }

  const progress = showResults ? sequence.page?.progress : undefined;
  const finished = (progress?.ready ?? 0) + (progress?.failed ?? 0);
  const missingPreferredFrame = mode === 'validate' && activeExample &&
    ['completed', 'partial', 'failed'].includes(sequence.page?.status ?? '') &&
    activeExample.blinkIds.some((id) => !aligned.some((frame) => frame.id === id));
  const status = sequence.paused ? 'paused' : sequence.busy ? sequence.page?.status ?? 'submitting' : sequence.page && ['queued', 'discovering', 'running'].includes(sequence.page.status) ? 'paused' : sequence.page?.status ?? 'idle';

  function startValidation(item: ValidationExample) {
    setValidation('');
    setSelectedId(null);
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
      exposureIds: item.exposureIds, collections: item.collections, detector: item.detector,
    }, false, item.id, preloadedValidationSequence(item.id));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

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
      setMode('explore');
      window.location.assign('#explore');
    }
    void sequence.start({
      ...query,
      detector: mode === 'home' ? undefined : detector || undefined,
      collections: includeQr3 ? ['spherex_dr1', 'spherex_qr3'] : ['spherex_dr1'],
    },
      ready.length > 0 && ready.every(frame => frame.scienceStatus === 'unavailable'));
  }

  function showTimelineIndex(next: number) {
    const frame = timelineFrames[next];
    if (frame) showTimelineFrame(frame);
  }

  function toggleBlinkPlayback() {
    if (!playing && reference && mode !== 'validate') {
      setSelectedId(reference.id);
      setAppendedIds(chosenIds);
    }
    setPlaying(!playing);
  }

  if (mode === 'home') return <Home knownObjects={knownObjects} inputs={inputs} setInputs={setInputs} validation={validation}
    includeQr3={includeQr3} setIncludeQr3={setIncludeQr3} onObserve={submit} onValidate={startValidation} />;

  const downloadStatus = (
    showResults && sequence.query && <div className="progress-block" role="status" aria-live="polite">
      <div className="section-heading"><span className="eyebrow">Download status</span><span className={sequence.busy ? 'status active' : 'status'}>{status}</span></div>
      <progress aria-label="Frames processed" max={progress?.total || 1} value={finished} />
      <div className="stats"><span><b>{progress?.ready ?? 0}</b> ready</span><span><b>{progress?.failed ?? 0}</b> failed</span><span><b>{progress?.total ?? 0}</b> total</span></div>
      {mode === 'explore' && sequence.query.collections && <p className="hint">
        IRSA releases searched: {sequence.query.collections.map(collection => collection.slice('spherex_'.length).toUpperCase()).join(' and ')}
      </p>}
      {sequence.notice && <p className="hint">{sequence.notice}</p>}
      {sequence.page?.dataSource === "demo_cache" && <p className="hint">Prepared demo cache - observations loaded from local disk.</p>}
      {mode === "explore" && sequence.page?.inventoryScope === "known_object" && <p className="hint">Showing the saved known-object exposures for this exact field. Additional archive observations may exist. <button className="text-button" onClick={reloadAnalysisField}>Search full archive field</button></p>}
      {sequence.page && sequence.page.remaining > 0 && <p className="hint">{sequence.page.scheduledCount} of {progress?.total} exposures requested. {sequence.page.remaining} not requested yet.</p>}
      {sequence.busy && <button className="text-button" disabled={!sequence.resumable} onClick={sequence.stop}>Stop loading</button>}
      {!sequence.busy && sequence.resumable && <button className="primary" onClick={() => void sequence.resume()}>Resume loading</button>}
      {sequence.error && <p className="error" role="alert">{sequence.error}</p>}
      {mode === 'validate' && activeExample && !sequence.busy &&
        (sequence.error || sequence.page?.status === 'failed' || sequence.page?.status === 'partial') &&
        <button className="text-button" onClick={() => startValidation(activeExample)}>Retry validation</button>}
      {missingPreferredFrame && <p className="hint">
        The documented comparison is incomplete. The viewer uses available aligned frames.
      </p>}
      {sequence.page?.status === 'completed' && progress?.total === 0 && <p>No observations cover this location.</p>}
    </div>
  );

  const autoObservation = (
    showResults && sequence.query && <section id="auto-observation" className="auto-observation" aria-labelledby="auto-observation-heading">
      <div className="analysis-heading">
        <div>
          <h2 id="auto-observation-heading">Auto observation</h2>
          <p>Scan aligned exposures for moving objects and review the frames behind each candidate.</p>
        </div>
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
    </section>
  );

  const observationSettings = (
    <details className="panel controls observation-settings" open>
        <summary>Observation settings</summary>
        <h2>Search a field</h2>
        <form onSubmit={submit}>
          <ObservationFields inputs={inputs} setInputs={setInputs} />
          <label htmlFor="detector">Detector</label>
          <select id="detector" value={detector} onChange={(event) => setDetector(event.target.value)}>
            <option value="">All detectors</option>
            {['D1', 'D2', 'D3', 'D4', 'D5', 'D6'].map((band) => <option key={band}>{band}</option>)}
          </select>
          <label className="release-option">
            <input type="checkbox" checked={includeQr3} onChange={event => setIncludeQr3(event.target.checked)} />
            Include QR3 spectral images
          </label>
          <button className="primary" type="submit">{showResults && sequence.busy ? 'Start new search' : 'Start'} <span aria-hidden="true">↗</span></button>
          {validation && <p className="error" role="alert">{validation}</p>}
        </form>
        <section className="suggested-fields" aria-label="Suggested fields">
          <h3>Suggested fields</h3>
          <p className="hint">Choose a known field, then select Start. Saved observations are available at these exact coordinates and field of view.</p>
          <div className="suggested-field-grid">{fields.map((field) => <button className="preset" key={field.name} onClick={() => setInputs(field.inputs)}>
            <strong>{field.name}</strong><span>{field.reason}</span>
            <span className="preset-cache">Saved observations available</span>
          </button>)}</div>
        </section>
      </details>
  );

  return <main className="shell workflow-shell">
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
    <div className={`analysis-layout${mode === 'explore' ? ' has-sidebar' : ''}`}>
      {mode === 'explore' && <aside className="observation-sidebar" aria-label="Observation settings">{observationSettings}</aside>}
      <div className="analysis-main">
      <AnalysisTabs value={analysisView} onChange={changeAnalysisView} />
      <div id="analysis-workspace" role="tabpanel" aria-labelledby={`analysis-tab-${analysisView}`} tabIndex={0}>

    <div className="observation-tools">
      {analysisView === 'motion' && autoObservation}
      {mode === 'validate' && (activeExample?.id === 'rw-aur' || activeExample?.id === 'r-dra') &&
        <div hidden={analysisView !== 'static'}><LightCurve key={lightCurveKey} onMeasured={points => setBrightness({ key: lightCurveKey, points })}
          sequenceId={canAnalyze ? sequence.page?.sequenceId : undefined} outerWings={activeExample.id === 'r-dra'}
          selectedId={visible?.id} onSelect={(frameId, reveal) => {
            const frame = ready.find(item => item.id === frameId);
            if (!frame) return;
            showTimelineFrame(frame);
            if (reveal) imageStage.current?.scrollIntoView({ block: 'center' });
          }} /></div>}
      {downloadStatus}
    </div>
    <div className="workspace frame-workspace">
      <section className="panel viewer-panel" aria-label="Frame viewer">
        <section className="frames-timeline" aria-label="Frames timeline">
          <div className="section-heading">
            <h2>Frames timeline</h2>
            <div className="timeline-actions">
              <span className="tag">{timelineFrames.length} frames</span>
              {activeTrack && <button className="text-button" onClick={() => resetBlink()}>Show all frames</button>}
              {blinkMode && blinkCount > 1 && <button className="blink-playback" onClick={toggleBlinkPlayback}>
                {playing ? 'Pause blink' : `Play blink · ${blinkCount} frames`}
              </button>}
            </div>
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
          <div className="navigation">
            <button aria-label="Previous frame" disabled={timelineIndex < 1}
              onClick={() => showTimelineIndex(timelineIndex - 1)}>← Previous</button>
            {!blinkMode && <input type="range" aria-label="Selected frame" min="0"
              max={Math.max(0, timelineFrames.length - 1)} value={Math.max(0, timelineIndex)}
              disabled={timelineFrames.length < 2} onChange={(event) => showTimelineIndex(Number(event.target.value))} />}
            <button aria-label="Next frame" disabled={timelineIndex >= timelineFrames.length - 1}
              onClick={() => showTimelineIndex(timelineIndex + 1)}>Next →</button>
          </div>
        </section>
        <div id="observation-image" ref={imageStage} className={blinkMode || brightnessPoint ? "image-stage aligned-stage" : "image-stage"} tabIndex={0} aria-label={blinkMode ? 'Aligned observation image; use left and right arrows to switch frames' : 'Observation image; use left and right arrows to change frames'}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            showTimelineIndex(timelineIndex + (event.key === 'ArrowRight' ? 1 : -1));
          }}>
          {analysisView === 'static' && mode === 'explore' && !blinkMode && selected ? <RegionImage key={selected.id} frame={{ ...selected, imageData: preview(selected) ?? selected.imageData }} zoom={zoom} explorer={explorer} sequenceId={spectrumSequenceId} showBackground clickToSelect onRegionSelected={viewStationarySpectrum} onReload={reloadAnalysisField} loading={sequence.busy} /> : mode === 'explore' && !blinkMode && unavailableSelection ? <div className="empty-state" role="status"><h3>Selected frame unavailable</h3><p>{unavailableSelection.error?.message ?? 'Preview could not be loaded.'}</p></div> : blinkMode && visible?.alignedImageData && visibleGrid ? <div className="aligned-image"
            style={{ width: zoom === 'fit' ? 'min(90%, 85cqh)' : `min(90%, ${visibleGrid.width * Number(zoom)}px)` }}>
            <AlignedPreview key={`preview:${alignedAutoUrl(visible) ?? visible.id}`} autoUrl={alignedAutoUrl(visible)}
              lockedUrl={visible.alignedImageData} alt={`SPHEREx ${visible.detector} observation at ${visible.observedAtUtc}`}
              showFallback={!!autoContrastSequence} />
            {gaia.enabled && gaia.catalogue && sequence.query && <GaiaMarkers key={`gaia:${visible.id}`} catalogue={gaia.catalogue}
              query={sequence.query} observedAt={visible.observedAtUtc} image={visible.alignedImageData}
              side={visibleGrid.width} showLabels={gaiaLabels} showDetails={downloadComplete} onInspect={() => setPlaying(false)} />}
            {brightnessPoint && <BrightnessFootprint point={brightnessPoint} aligned />}
            {mode === 'validate' && activeExample?.radiusArcsec && <svg className="saved-region-outline"
              viewBox={`0 0 ${visibleGrid.width} ${visibleGrid.height}`} aria-hidden="true">
              <circle cx={visibleGrid.width / 2} cy={visibleGrid.height / 2} r={activeExample.radiusArcsec / 6.15} />
            </svg>}
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
            <div className="empty-state"><span className="sky-placeholder-icon" aria-hidden="true" /><h3>{blinkMode && ready.length ? 'No aligned frames available' : sequence.busy ? 'Listening for the first frame' : 'Start with a sky location'}</h3><p>{sequence.busy ? 'Images will appear here while the rest load.' : mode === 'validate' ? <a href="#home">Choose a known object on Home.</a> : 'Choose a field and select Start.'}</p></div>}
          <span className="stage-label">{timelineIndex >= 0 ? `FRAME ${timelineIndex + 1} / ${timelineFrames.length}` : 'SPHEREx / INFRARED'}</span><span className="stage-label right">{visibleGrid ? `${visibleGrid.width} × ${visibleGrid.height} PX` : 'AWAITING SIGNAL'}</span>
        </div>
        {analysisView === 'static' && mode === 'explore' && !blinkMode && selected && selected.scienceStatus === 'retained' &&
          (explorer.selection?.referenceFrameId === selected.id ? <SaveKnownObject
            key={JSON.stringify(explorer.selection)} frame={selected} selection={explorer.selection}
            onSaved={() => setSavedObjects(readSavedKnownObjects())} />
            : <p className="preview-note">Click or drag a circle on the image to save a sky region as a known object.</p>)}
        <section className="frame-metadata" aria-label="Frame metadata">
          <FrameMetadata frame={visible} detection={measured || undefined} />
          {blinkMode && !activeTrack && visible && reference && visible.id !== reference.id && <button className="text-button" onClick={() => {
            showBlinkFrame(0);
            setAppendedIds(chosenIds.filter(id => id !== visible.id));
          }}>Remove current frame from blink</button>}
        <p className="preview-note">{blinkMode
          ? `North up · 6.15 arcsec/pixel · ${autoContrastSequence ? 'auto contrast per frame' : 'locked contrast'}. Playback follows the selected blink sequence. The first comparison defaults to the closest available wavelength from the same detector.`
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
        {reviewedTrack && spectrumSequenceId && <div hidden={analysisView !== 'motion'}><MovingCandidateAnalysis key={reviewedTrack.id} sequenceId={spectrumSequenceId} candidate={reviewedTrack} radius={analysisRadius} onRadiusChange={setAnalysisRadius} autoMeasureRequest={analysisRequest} onViewStationarySpectrum={viewStationarySpectrum} automatic={motion?.measurements?.[reviewedTrack.id]} /></div>}
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
      {analysisView === 'static' && mode === 'explore' && <FingerprintPanel explorer={explorer} frame={selected} frames={ready} onSelect={id => { setBlinkMode(false); selectFrame(id); }} onSelectRegion={selectStationaryRegion} onExploreMoving={viewMovingAnalysis} movingLinkLabel={reviewedTrack ? 'Go to moving-candidate analysis' : 'Go to Auto observation'} />}
    </div>
    {analysisView === 'static' && mode === 'explore' && <ChannelMeasurements explorer={explorer} />}
    {failed.length > 0 && <details className="panel failures"><summary>{failed.length} frames could not be loaded</summary><ul>{failed.map((frame) => <li key={frame.id}><strong>{frame.detector} · {frame.observedAtUtc}</strong><p>{frame.error?.message ?? 'Frame unavailable.'}</p></li>)}</ul></details>}
      </div>
      </div>
    </div>
    <footer><span>Sifting Skies</span><span>NASA Space Apps 2026 · Archive data via backend</span></footer>
  </main>
}
export default App;

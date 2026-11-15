import { useCallback, useEffect, useRef, useState } from 'react';
import type { MotionCandidate, MotionPhotometryResult } from './api/frames';
import { fetchMotionPhotometry, RequestError } from './api/frames';

const number = (value?: number | null, digits = 4) => value == null || !Number.isFinite(value) ? 'Unavailable' : value.toPrecision(digits);

function FluxTimePlot({ result }: { result: MotionPhotometryResult }) {
  const rows = result.measurements.filter(row => row.fluxMjy != null && row.status !== 'unavailable')
    .sort((a, b) => Date.parse(a.observedAtUtc) - Date.parse(b.observedAtUtc));
  if (!rows.length) return <p className="hint">No usable aperture measurements are available to plot.</p>;
  const times = rows.map(row => Date.parse(row.observedAtUtc));
  const fluxes = rows.map(row => row.fluxMjy!);
  const t0 = Math.min(...times), t1 = Math.max(...times);
  const f0 = Math.min(0, ...fluxes), f1 = Math.max(0, ...fluxes);
  const x = (time: number) => 42 + (time - t0) / Math.max(1, t1 - t0) * 380;
  const y = (flux: number) => 190 - (flux - f0) / Math.max(1e-9, f1 - f0) * 150;
  return <svg className="motion-flux-plot" viewBox="0 0 460 235" role="img" aria-label="Quick-look candidate aperture flux versus observation time">
    <path d="M42 20V190H422" fill="none" stroke="#91a1b5" />
    <line x1="42" x2="422" y1={y(0)} y2={y(0)} stroke="#536273" strokeDasharray="3 4" />
    {rows.map((row, index) => <g key={row.frameId}>
      {row.uncertaintyMjy != null && <line x1={x(times[index])} x2={x(times[index])} y1={y(fluxes[index] + row.uncertaintyMjy)} y2={y(fluxes[index] - row.uncertaintyMjy)} stroke="#a4e7d2" />}
      <circle cx={x(times[index])} cy={y(fluxes[index])} r="4" fill={row.status === 'partial' ? '#f7bb77' : '#a4e7d2'}><title>{`${row.observedAtUtc}: ${number(row.fluxMjy)} mJy, ${number(row.wavelengthUm, 3)} µm`}</title></circle>
    </g>)}
    <text x="230" y="220" textAnchor="middle">Observation time (UTC)</text>
    <text transform="translate(13 112) rotate(-90)" textAnchor="middle">Aperture flux (mJy)</text>
    <text x="39" y="28" textAnchor="end">{number(f1, 3)}</text><text x="39" y="190" textAnchor="end">{number(f0, 3)}</text>
    <text x="42" y="205">{new Date(t0).toISOString().slice(0, 10)}</text><text x="422" y="205" textAnchor="end">{new Date(t1).toISOString().slice(0, 10)}</text>
    {rows.length === 1 && <text x="230" y="48" textAnchor="middle">One sample; no time trend can be assessed.</text>}
  </svg>;
}

function FluxWavelengthPlot({ result }: { result: MotionPhotometryResult }) {
  const rows = result.measurements.filter(row => row.fluxMjy != null && row.wavelengthUm != null && row.status !== 'unavailable');
  if (!rows.length) return <p className="hint">No local wavelength samples are available to plot.</p>;
  const wavelengths = rows.map(row => row.wavelengthUm!);
  const fluxes = rows.map(row => row.fluxMjy!);
  const spread = Math.max(0.004, (Math.max(...wavelengths) - Math.min(...wavelengths)) * 0.12);
  const low = Math.min(...wavelengths) - spread, high = Math.max(...wavelengths) + spread;
  const f0 = Math.min(0, ...fluxes), f1 = Math.max(0, ...fluxes);
  const x = (wave: number) => 52 + (wave - low) / (high - low) * 370;
  const y = (flux: number) => 190 - (flux - f0) / Math.max(1e-9, f1 - f0) * 150;
  return <svg className="motion-flux-plot" viewBox="0 0 460 235" role="img" aria-label="Sparse moving-candidate aperture flux samples versus local wavelength">
    <path d="M52 20V190H422" fill="none" stroke="#91a1b5" />
    <line x1="52" x2="422" y1={y(0)} y2={y(0)} stroke="#536273" strokeDasharray="3 4" />
    {rows.map((row, index) => <g key={row.frameId}>
      {row.uncertaintyMjy != null && <line x1={x(wavelengths[index])} x2={x(wavelengths[index])} y1={y(fluxes[index] + row.uncertaintyMjy)} y2={y(fluxes[index] - row.uncertaintyMjy)} stroke="#a4e7d2" />}
      <circle cx={x(wavelengths[index])} cy={y(fluxes[index])} r="4" fill={row.status === 'partial' ? '#f7bb77' : '#a4e7d2'}><title>{`${number(row.wavelengthUm, 4)} µm at ${row.observedAtUtc}: ${number(row.fluxMjy)} mJy`}</title></circle>
    </g>)}
    <text x="237" y="220" textAnchor="middle">Local wavelength (µm)</text>
    <text transform="translate(13 112) rotate(-90)" textAnchor="middle">Aperture flux (mJy)</text>
    <text x="49" y="28" textAnchor="end">{number(f1, 3)}</text><text x="49" y="190" textAnchor="end">{number(f0, 3)}</text>
    <text x="52" y="205">{number(low, 4)}</text><text x="422" y="205" textAnchor="end">{number(high, 4)}</text>
    {rows.length < 4 && <text x="237" y="48" textAnchor="middle">Sparse samples; not a reconstructed spectrum.</text>}
  </svg>;
}

export function MovingCandidateAnalysis({ sequenceId, candidate, radius, onRadiusChange, autoMeasureRequest = 0, onViewStationarySpectrum }: {
  sequenceId: string; candidate: MotionCandidate; radius: number; onRadiusChange: (radius: number) => void; autoMeasureRequest?: number; onViewStationarySpectrum?: () => void;
}) {
  const [result, setResult] = useState<MotionPhotometryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const lastAutoMeasureRequest = useRef(0);
  useEffect(() => () => controller.current?.abort(), []);

  const measure = useCallback(async () => {
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setLoading(true); setError(''); setResult(null);
    try {
      setResult(await fetchMotionPhotometry(sequenceId, candidate, radius, active.signal));
    } catch (reason) {
      if (!active.signal.aborted) setError(reason instanceof RequestError ? reason.message : 'Could not measure this candidate.');
    } finally {
      if (!active.signal.aborted) setLoading(false);
    }
  }, [sequenceId, candidate, radius]);

  useEffect(() => {
    if (autoMeasureRequest <= 0 || autoMeasureRequest === lastAutoMeasureRequest.current) return;
    lastAutoMeasureRequest.current = autoMeasureRequest;
    void measure();
  }, [autoMeasureRequest, measure]);

  function download() {
    if (!result) return;
    const fields = ['candidateId','processingVersion','frameId','sourceFitsUrl','observedAtUtc','detector','release','status','ra','dec','detectionSnr','wavelengthUm','bandwidthUm','fluxMjy','uncertaintyMjy','signalToNoise','backgroundMjySr','radiusPixels','apertureCoverage','aperturePixels','backgroundPixels','flagsOr','reason','quality'];
    const csv = [fields.join(','), ...result.measurements.map(row => fields.map(key => JSON.stringify(
      key === 'candidateId' ? result.candidateId : key === 'processingVersion' ? result.processingVersion : (row as unknown as Record<string, unknown>)[key] ?? '')).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const link = document.createElement('a'); link.href = url; link.download = `candidate-${candidate.id}-measurements.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <section id="moving-candidate-analysis" className="motion-analysis" aria-label="Moving candidate measurements">
    <div className="analysis-panel-heading"><h4>Analyze moving candidate</h4>{onViewStationarySpectrum && <button className="text-button" onClick={onViewStationarySpectrum}>View stationary-region spectrum</button>}</div>
    <p className="hint">Measure the marked position in each supporting native frame. These are quick-look exposure measurements, not the stationary 102-channel mosaic spectrum.</p>
    <div className="motion-analysis-controls">
      <label>Aperture radius (native pixels)
        <input type="number" min="0.5" max="8" step="0.5" value={Number.isFinite(radius) ? radius : ''} onChange={event => {
          onRadiusChange(event.target.value === '' ? NaN : Number(event.target.value)); setResult(null); setError('');
        }} />
      </label>
      <button className="primary" disabled={loading || !Number.isFinite(radius) || radius < .5 || radius > 8} onClick={() => void measure()}>
        {loading ? 'Measuring…' : result ? 'Measure again' : 'Measure candidate'}
      </button>
    </div>
    {loading && <p role="status">Loading native science when needed and measuring candidate positions…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {result && <>
      <p role="status">{result.measurements.filter(row => row.status !== 'unavailable').length} of {result.measurements.length} positions measured · {result.method}.</p>
      <p className="hint">Uncertainty is an approximate statistical estimate shown only when a usable FITS variance plane is present; it excludes correlated noise and calibration systematics. Flux-versus-wavelength coverage may be sparse because this candidate was linked in one detector.</p>
      <FluxTimePlot result={result} />
      <FluxWavelengthPlot result={result} />
      <button className="text-button" onClick={download}>Export measurement CSV</button>
      <div className="table-scroll motion-measurement-scroll"><table className="motion-measurement-table">
        <caption>Per-exposure quick-look measurements</caption>
        <thead><tr><th>UTC</th><th>Detector</th><th>λ / bandwidth (µm)</th><th>Flux (mJy)</th><th>Uncertainty</th><th>Peak / flux S/N</th><th>Coverage</th><th>Quality</th></tr></thead>
        <tbody>{result.measurements.map(row => <tr key={row.frameId}>
          <td>{row.observedAtUtc.replace('T', ' ').replace('Z', '')}</td><td>{row.detector} · {row.release}</td>
          <td>{number(row.wavelengthUm, 3)} / {number(row.bandwidthUm, 3)}</td>
          <td>{number(row.fluxMjy)}</td><td>{number(row.uncertaintyMjy)}</td><td>{number(row.detectionSnr, 3)} / {number(row.signalToNoise, 3)}</td>
          <td>{row.apertureCoverage == null ? '—' : `${Math.round(row.apertureCoverage * 100)}%`}</td>
          <td>{row.reason ?? row.quality ?? row.status}</td>
        </tr>)}</tbody>
      </table></div>
      <p className="hint">This first pass uses an exact-fraction circular aperture, a clipped local-median annulus, and local WCS pixel area. It is not PSF matched and does not establish a detection or physical spectrum.</p>
    </>}
  </section>;
}

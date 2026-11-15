import { fluxBounds, usableUncertainty, measurementStats, fluxDifference } from './measurementStats';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CandidateMeasurement, MotionCandidate, MotionPhotometryResult } from './api/frames';
import { fetchMotionPhotometry, RequestError } from './api/frames';

const number = (value?: number | null, digits = 4) => value == null || !Number.isFinite(value) ? 'Unavailable' : value.toPrecision(digits);

function FluxWavelengthPlot({ result }: { result: MotionPhotometryResult }) {
  const rows = result.measurements.filter(row => row.fluxMjy != null && Number.isFinite(row.fluxMjy) && row.wavelengthUm != null && Number.isFinite(row.wavelengthUm) && row.status !== 'unavailable');
  if (!rows.length) return <p className="hint">No local wavelength samples are available to plot.</p>;
  const wavelengths = rows.map(row => row.wavelengthUm!);
  const fluxes = rows.map(row => row.fluxMjy!);
  const spread = Math.max(0.004, (Math.max(...wavelengths) - Math.min(...wavelengths)) * 0.12);
  const low = Math.min(...wavelengths) - spread, high = Math.max(...wavelengths) + spread;
  const [f0, f1] = fluxBounds(rows.map(row => ({ fluxMjy: row.fluxMjy })));
  const x = (wave: number) => 52 + (wave - low) / (high - low) * 370;
  const y = (flux: number) => 190 - (flux - f0) / Math.max(1e-9, f1 - f0) * 150;
  return <svg className="motion-flux-plot" viewBox="0 0 460 235" role="img" aria-label="Sparse moving-candidate aperture flux samples versus local wavelength">
    <path d="M52 20V190H422" fill="none" stroke="var(--chart-axis)" />
    {f0 <= 0 && f1 >= 0 && <line x1="52" x2="422" y1={y(0)} y2={y(0)} stroke="var(--chart-grid)" strokeDasharray="3 4" />}
    {rows.map((row, index) => <g key={row.frameId}>
      <circle cx={x(wavelengths[index])} cy={y(fluxes[index])} r="4" fill={row.status === 'partial' ? 'var(--warning)' : 'var(--accent)'}><title>{`${number(row.wavelengthUm, 4)} µm at ${row.observedAtUtc}: ${number(row.fluxMjy)} mJy; ${usableUncertainty(row.uncertaintyMjy) == null ? "uncertainty unavailable" : `+/- ${number(row.uncertaintyMjy)} mJy (1 sigma)`}`}</title></circle>

    </g>)}
    <text x="237" y="220" textAnchor="middle">Local wavelength (µm)</text>
    <text transform="translate(13 112) rotate(-90)" textAnchor="middle">Aperture flux (mJy)</text>
    <text x="49" y="28" textAnchor="end">{number(f1, 3)}</text><text x="49" y="190" textAnchor="end">{number(f0, 3)}</text>
    <text x="52" y="205">{number(low, 4)}</text><text x="422" y="205" textAnchor="end">{number(high, 4)}</text>
  </svg>;
}

export function MeasurementSummary({ result }: { result: MotionPhotometryResult }) {
  const rows = result.measurements.filter(row => row.status !== 'unavailable' && row.fluxMjy != null && Number.isFinite(row.fluxMjy));
  const stats = measurementStats(rows);
  const fit = stats.fit;
  return <aside className="measurement-summary" aria-label="Automated analysis summary">
    <h5>Automated analysis summary</h5>
    <dl className="measurement-metrics">
      <div><dt>Usable exposures</dt><dd>{stats.count} <span>/ {result.measurements.length}</span></dd></div>
      <div><dt>Wavelength range</dt><dd>{stats.wavelengthRange ? `${number(stats.wavelengthRange[0])} to ${number(stats.wavelengthRange[1])} microns` : 'Unavailable'}</dd></div>
      <div><dt>Median flux</dt><dd>{number(stats.median)} <span>mJy</span></dd></div>
      <div><dt>Strongest |flux S/N|</dt><dd>{number(stats.strongestSnr)}</dd></div>
    </dl>
    {fit ? <>
      <div className="measurement-fit-heading">Constant-flux fit <span>{fit.count} exposures</span></div>
      <dl className="measurement-metrics">
        <div className="measurement-metric-wide"><dt>Weighted flux</dt><dd>{number(fit.mean)} +/- {number(fit.uncertainty)} <span>mJy</span></dd></div>
        <div><dt>Chi-square</dt><dd>{number(fit.chiSquare)}</dd></div>
        <div><dt>Reduced chi-square</dt><dd>{number(fit.reduced)}</dd></div>
      </dl>
    </> : <p className="hint">Constant-flux fit unavailable: no usable uncertainties.</p>}
    <p className="hint">The fit and differences assume independent statistical errors. High reduced chi-square indicates inconsistency with constant flux under these errors; wavelength differences and omitted correlated noise and calibration systematics can also explain it. This does not establish intrinsic variability. At least two usable uncertainties are needed for reduced chi-square.</p>
    {rows.length > 1 && <section className="measurement-comparisons" aria-label="Pairwise flux differences">
      <h6>Pairwise flux differences</h6>
      <p className="hint">Observation numbers match the measurements below. Differences are second minus first; significance assumes independent errors.</p>
      <div className="table-scroll"><table className="measurement-comparison-table"><caption>Flux difference with 1-sigma uncertainty</caption>
        <thead><tr><th>Observations</th><th>Difference (mJy)</th><th>Significance</th></tr></thead>
        <tbody>{rows.flatMap((a, i) => rows.slice(i + 1).map(b => {
          const diff = fluxDifference(a, b)!;
          const first = result.measurements.indexOf(a) + 1;
          const second = result.measurements.indexOf(b) + 1;
          return <tr key={`${a.frameId}/${b.frameId}`}><td title={`${b.observedAtUtc} minus ${a.observedAtUtc}`}>#{second} minus #{first}</td><td>{number(diff.difference)} <span>+/- {number(diff.uncertainty)}</span></td><td>{diff.significance == null ? 'Unavailable' : `${number(diff.significance, 3)} sigma`}</td></tr>;
        }))}</tbody>
      </table></div>
    </section>}
  </aside>;
}

export function MovingCandidateAnalysis({ sequenceId, candidate, radius, onRadiusChange, autoMeasureRequest = 0, onViewStationarySpectrum, automatic }: {
  sequenceId: string; candidate: MotionCandidate; radius: number; onRadiusChange: (radius: number) => void; autoMeasureRequest?: number; onViewStationarySpectrum?: () => void;
  automatic?: CandidateMeasurement;
}) {
  const [manualResult, setResult] = useState<MotionPhotometryResult | null>(null);
  const result = manualResult ?? (radius === 2.5 ? automatic?.result : undefined);
  const autoPending = radius === 2.5 && (automatic?.status === 'queued' || automatic?.status === 'running');
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
    if (autoPending || result) return;
    void measure();
  }, [autoMeasureRequest, measure, autoPending, result]);

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
        <input type="number" disabled={loading} min="0.5" max="8" step="0.5" value={Number.isFinite(radius) ? radius : ''} onChange={event => {
          onRadiusChange(event.target.value === '' ? NaN : Number(event.target.value)); setResult(null); setError('');
        }} />
      </label>
      <button className="primary" disabled={loading || autoPending || !Number.isFinite(radius) || radius < .5 || radius > 8} onClick={() => void measure()}>
        {loading ? 'Measuring…' : result ? 'Measure again' : 'Measure candidate'}
      </button>
    </div>
    {autoPending && <p role="status">{automatic?.status === 'queued' ? 'Queued for automatic measurement.' : 'Automatically measuring this candidate…'}</p>}
    {radius === 2.5 && automatic?.status === 'failed' && !result && !loading && <p role="alert">{automatic.error}</p>}
    {loading && <p role="status">Loading native science when needed and measuring candidate positions…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {result && <>
      <p role="status">{result.measurements.filter(row => row.status !== 'unavailable').length} of {result.measurements.length} positions measured · {result.method}.</p>
      <div className="motion-analysis-overview">
        <div className="motion-analysis-graph"><FluxWavelengthPlot result={result} /></div>
        <MeasurementSummary result={result} />
      </div>
      <button className="text-button" onClick={download}>Export measurement CSV</button>
      <div className="table-scroll motion-measurement-scroll"><table className="motion-measurement-table">
        <caption>Per-exposure quick-look measurements</caption>
        <thead><tr><th>#</th><th>UTC</th><th>Detector</th><th>λ / bandwidth (µm)</th><th>Flux (mJy)</th><th>Uncertainty</th><th>Peak / flux S/N</th><th>Coverage</th></tr></thead>
        <tbody>{result.measurements.map((row, index) => <tr key={row.frameId}>
          <td>{index + 1}</td><td>{row.observedAtUtc.replace('T', ' ').replace('Z', '')}</td><td>{row.detector} · {row.release}</td>
          <td>{number(row.wavelengthUm, 3)} / {number(row.bandwidthUm, 3)}</td>
          <td>{number(row.fluxMjy)}</td><td>{number(row.uncertaintyMjy)}</td><td>{number(row.detectionSnr, 3)} / {number(row.signalToNoise, 3)}</td>
          <td>{row.apertureCoverage == null ? '—' : `${Math.round(row.apertureCoverage * 100)}%`}</td>

        </tr>)}</tbody>
      </table></div>
      <p className="hint">This first pass uses an exact-fraction circular aperture, a clipped local-median annulus, and local WCS pixel area. It is not PSF matched and does not establish a detection or physical spectrum.</p>
    </>}
  </section>;
}

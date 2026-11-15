import { fluxBounds, usableUncertainty } from '../measurementStats';
import { useEffect, useRef, useState } from 'react';

export interface LightCurvePoint {
  frameId: string;
  observedAtUtc: string;
  detector: string;
  wavelengthUm: number;
  fluxMjy: number;
  uncertaintyMjy?: number | null;
  pixels: {
    weight: number;
    native: [number, number][];
    aligned: [number, number][] | null;
  }[];
}

interface Measurements {
  points: LightCurvePoint[];
  readyFrames: number;
  skipped: Record<string, number>;
}

interface Props {
  sequenceId?: string;
  outerWings: boolean;
  selectedId?: string;
  onSelect: (frameId: string, reveal?: boolean) => void;
  onMeasured: (points: LightCurvePoint[]) => void;
}

const dateLabel = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);
const numericLabel = (value: number) => Number(value.toPrecision(4)).toString();

function groupsByWavelength(points: LightCurvePoint[]) {
  const groups = new Map<string, LightCurvePoint[]>();
  for (const point of points) {
    const bin = Math.floor(Math.log(point.wavelengthUm) / Math.log(1.02));
    const key = `${point.detector}/${bin}`;
    const group = groups.get(key);
    if (group) group.push(point);
    else groups.set(key, [point]);
  }
  return Array.from(groups, ([id, points]) => {
    const minimum = Math.min(...points.map(point => point.wavelengthUm));
    const maximum = Math.max(...points.map(point => point.wavelengthUm));
    const dates = new Set(points.map(point => point.observedAtUtc.slice(0, 10))).size;
    return { id, points, dates, minimum, maximum, detector: points[0].detector.replace('SPHEREx-', '') };
  }).sort((a, b) => b.dates - a.dates || b.points.length - a.points.length || a.minimum - b.minimum);
}

export function FluxChart({ points, selectedId }: { points: LightCurvePoint[]; selectedId?: string }) {
  const times = points.map(point => Date.parse(point.observedAtUtc));
  const t0 = times[0];
  const t1 = times[times.length - 1];
  const [low, high] = fluxBounds(points.map(point => ({ fluxMjy: point.fluxMjy })));
  const x = (time: number) => t0 === t1 ? 345 : 74 + 542 * (time - t0) / (t1 - t0);
  const y = (flux: number) => 192 - 169 * (flux - low) / (high - low);

  return <svg className="light-curve-chart" viewBox="0 0 632 226" role="img"
    aria-label="Scatter plot of background-subtracted wing flux in millijanskys by observation date">
    <title>Wing flux over time</title>
    {[low, (low + high) / 2, high].map(flux => <g key={flux}>
      <line x1="68" x2="622" y1={y(flux)} y2={y(flux)} />
      <text x="64" y={y(flux) + 4} textAnchor="end">{numericLabel(flux)}</text>
    </g>)}
    <text x="5" y="13">mJy</text>
    <text x="68" y="215">{dateLabel(t0)}</text>
    {t1 !== t0 && <text x="622" y="215" textAnchor="end">{dateLabel(t1)}</text>}
    {points.map((point, index) => {
      const sigma = usableUncertainty(point.uncertaintyMjy);
      const cx = x(times[index]);
      const selected = point.frameId === selectedId;
      return <g key={point.frameId}>
        <circle cx={cx} cy={y(point.fluxMjy)} r={selected ? 6 : 4} className={selected ? 'selected' : undefined}>
          <title>{`${point.observedAtUtc} | ${numericLabel(point.fluxMjy)} mJy | ${sigma == null ? "Uncertainty unavailable" : `+/- ${numericLabel(sigma)} mJy (1 sigma)`} | ${point.wavelengthUm.toFixed(3)} microns`}</title>
        </circle>
      </g>;
    })}
  </svg>;
}

export function LightCurve({ sequenceId, outerWings, selectedId, onSelect, onMeasured }: Props) {
  const [measurements, setMeasurements] = useState<Measurements>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [groupId, setGroupId] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function measure() {
    if (!sequenceId) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError('');
    try {
      const url = `/api/frames/${encodeURIComponent(sequenceId)}/light-curve?outer_wings=${outerWings}`;
      const response = await fetch(url, { signal: controller.signal, cache: 'reload' });
      if (!response.ok) throw new Error('Could not measure brightness in this observation.');
      const result: Measurements = await response.json();
      if (!controller.signal.aborted) {
        setMeasurements(result);
        onMeasured(result.points);
        const groups = groupsByWavelength(result.points);
        const group = groups.find(item => item.id === groupId) ?? groups[0];
        if (group && !group.points.some(point => point.frameId === selectedId)) {
          onSelect(group.points[0].frameId);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not measure brightness.');
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  const groups = measurements ? groupsByWavelength(measurements.points) : [];
  const group = groups.find(item => item.id === groupId) ?? groups[0];
  const currentPoint = group?.points.find(point => point.frameId === selectedId) ?? group?.points[0];

  return <section className="auto-observation light-curve" aria-labelledby="light-curve-heading">
    <div className="section-heading">
      <h3 id="light-curve-heading">Brightness over time</h3>
      <button className="primary" disabled={!sequenceId || pending} onClick={() => void measure()}>
        {pending ? 'Measuring…' : 'Measure brightness'}
      </button>
    </div>
    <p>Each point sums selected pixels in a ring around the star and subtracts the local background. Wavelength groups collect comparable exposures.</p>
    {!sequenceId && <p>Available after the frames finish loading.</p>}
    {pending && <p role="status">Measuring saved FITS exposures…</p>}
    {error && <p role="alert">{error}</p>}
    {measurements && <>
      <p role="status">{measurements.points.length} of {measurements.readyFrames} frames yielded usable measurements.</p>
      {!!Object.keys(measurements.skipped).length && <details>
        <summary>Why frames were skipped</summary>
        <ul>{Object.entries(measurements.skipped).map(([reason, count]) => <li key={reason}>{reason} · {count}</li>)}</ul>
      </details>}
      {group && <>
        <label className="zoom-control">Wavelength group
          <select value={group.id} onChange={event => {
            const next = groups.find(item => item.id === event.target.value);
            if (!next) return;
            setGroupId(next.id);
            if (!next.points.some(point => point.frameId === selectedId)) onSelect(next.points[0].frameId);
          }}>
            {groups.map(item => <option key={item.id} value={item.id}>
              {item.detector} · {item.minimum.toFixed(3)}–{item.maximum.toFixed(3)} µm · {item.points.length} frames
            </option>)}
          </select>
        </label>
        {currentPoint && <button className="text-button" onClick={() => onSelect(currentPoint.frameId, true)}>
          Show measured pixels on frame
        </button>}
        {group.dates < 2 && <p>Only one observing date in this group.</p>}
        <FluxChart points={group.points} selectedId={selectedId} />
        <p>The cyan overlay on the frame shows the pixels used for wing flux. The core is outside the measurement.</p>
        <p>Statistical uncertainties from usable FITS variance include the background mean and remain available in point tooltips. Missing uncertainty is unavailable, not zero. Correlated noise and calibration systematics are excluded.</p>
        <p>Wing flux is a relative brightness check. Differences in focus, wavelength and detector response can also affect the values.</p>
        <details>
          <summary>Frame measurements</summary>
          <ul>{group.points.map(point => <li key={point.frameId}>
            <button className="text-button" onClick={() => onSelect(point.frameId, true)}>{point.observedAtUtc}</button>
            {' · '}{point.wavelengthUm.toFixed(3)} µm · {numericLabel(point.fluxMjy)} mJy
          </li>)}</ul>
        </details>
      </>}
    </>}
  </section>;
}

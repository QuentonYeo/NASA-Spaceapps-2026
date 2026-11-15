import { useEffect, useRef, useState } from 'react';

export interface LightCurvePoint {
  frameId: string;
  observedAtUtc: string;
  detector: string;
  wavelengthUm: number;
  fluxMjy: number;
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

type WavelengthGroup = ReturnType<typeof groupsByWavelength>[number];

function groupLabel(group: WavelengthGroup) {
  const minimum = group.minimum.toFixed(3);
  const maximum = group.maximum.toFixed(3);
  const range = minimum === maximum ? minimum : `${minimum}–${maximum}`;
  return `${range} µm · ${group.detector} · ${group.dates} ${group.dates === 1 ? 'date' : 'dates'}`;
}

function FluxChart({ points, selectedId }: { points: LightCurvePoint[]; selectedId?: string }) {
  const times = points.map(point => Date.parse(point.observedAtUtc));
  const t0 = times[0];
  const t1 = times[times.length - 1];
  const fluxes = points.map(point => point.fluxMjy);
  const min = Math.min(...fluxes);
  const max = Math.max(...fluxes);
  const padding = (max - min) * .08 || Math.max(1, Math.abs(max) * .08);
  const low = min - padding;
  const high = max + padding;
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
    {points.map((point, index) => <circle key={point.frameId}
      cx={x(times[index])} cy={y(point.fluxMjy)} r={point.frameId === selectedId ? 6 : 4}
      className={point.frameId === selectedId ? 'selected' : undefined}>
      <title>{point.observedAtUtc} · {numericLabel(point.fluxMjy)} mJy · {point.wavelengthUm.toFixed(3)} µm</title>
    </circle>)}
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
    <div className="analysis-heading">
      <div>
        <h2 id="light-curve-heading">Brightness over time</h2>
        <p>Compare the star’s brightness across dates at similar wavelengths. Each point uses light from a ring around the star, with the local sky background subtracted.</p>
      </div>
      <button className="primary" disabled={!sequenceId || pending} onClick={() => void measure()}>
        {pending ? 'Measuring…' : 'Measure brightness'}
      </button>
    </div>
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
        <div className="wavelength-selector">
          <label htmlFor="light-curve-wavelength">Compare at</label>
          <select id="light-curve-wavelength" value={group.id} onChange={event => {
            const next = groups.find(item => item.id === event.target.value);
            if (!next) return;
            setGroupId(next.id);
            if (!next.points.some(point => point.frameId === selectedId)) onSelect(next.points[0].frameId);
          }}>
            {groups.map(item => <option key={item.id} value={item.id}>{groupLabel(item)}</option>)}
          </select>
        </div>
        {currentPoint && <button className="text-button" onClick={() => onSelect(currentPoint.frameId, true)}>
          Show measured pixels on frame
        </button>}
        {group.dates < 2 && <p>This group has one observing date. Comparing brightness over time requires at least two dates.</p>}
        <div className="light-curve-plot">
          <FluxChart points={group.points} selectedId={selectedId} />
        </div>
        <p>The cyan overlay on the frame shows the pixels used for wing flux. The core is outside the measurement.</p>
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

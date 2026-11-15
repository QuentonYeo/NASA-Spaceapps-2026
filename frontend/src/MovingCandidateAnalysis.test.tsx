import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { MovingCandidateAnalysis, MeasurementSummary } from './MovingCandidateAnalysis';
import type { MotionCandidate, MotionPhotometryResult } from './api/frames';

const candidate: MotionCandidate = { id: 'two', detector: 'D6', detections: [], displacementArcsec: 3, elapsedHours: 1, residualPixels: 0, score: 12 };
const result: MotionPhotometryResult = { candidateId: 'two', radiusPixels: 2.5, unit: 'mJy', method: 'aperture', processingVersion: 'v1', measurements: [
  { frameId: 'frame-two', observedAtUtc: '2025-08-05T00:00:00Z', detector: 'D6', release: 'dr1', status: 'measured', fluxMjy: 42, wavelengthUm: 4.7 },
] };

it('shows automatic measurements on selection without a manual request', () => {
  const html = renderToStaticMarkup(<MovingCandidateAnalysis sequenceId="sequence" candidate={candidate} radius={2.5} onRadiusChange={() => {}} automatic={{ status: 'completed', result }} />);
  expect(html).toContain('Per-exposure quick-look measurements');
  expect(html).toContain('42.00');
  expect(html).toContain('Export measurement CSV');
});

it('keeps default queued status separate from a custom aperture measurement', () => {
  const queued = renderToStaticMarkup(<MovingCandidateAnalysis sequenceId="sequence" candidate={candidate} radius={2.5} onRadiusChange={() => {}} automatic={{ status: 'queued' }} />);
  expect(queued).toContain('Queued for automatic measurement.');
  const custom = renderToStaticMarkup(<MovingCandidateAnalysis sequenceId="sequence" candidate={candidate} radius={3} onRadiusChange={() => {}} automatic={{ status: 'completed', result }} />);
  expect(custom).not.toContain('Per-exposure quick-look measurements');
});

it('shows the summary and removes the quality column without restoring the time plot', () => {
  const html = renderToStaticMarkup(<MovingCandidateAnalysis sequenceId="sequence" candidate={candidate} radius={2.5} onRadiusChange={() => {}} automatic={{ status: 'completed', result }} />);
  expect(html).toContain('Automated analysis summary');
  expect(html).toContain('Constant-flux fit unavailable');
  expect(html).not.toContain('<th>Quality</th>');
  expect(html).not.toContain('Sparse samples; not a reconstructed spectrum.');
  expect(html).not.toContain('versus observation time');
});

it('reports weighted fits and all pairwise differences with unknown errors unavailable', () => {
  const measurements: MotionPhotometryResult = { ...result, measurements: [
    { ...result.measurements[0], frameId: 'a', fluxMjy: 2, uncertaintyMjy: 1 },
    { ...result.measurements[0], frameId: 'b', fluxMjy: 6, uncertaintyMjy: 2 },
    { ...result.measurements[0], frameId: 'c', fluxMjy: 10, uncertaintyMjy: null },
  ] };
  const html = renderToStaticMarkup(<MeasurementSummary result={measurements} />);
  expect(html).toContain('2.800'); expect(html).toContain('3.200');
  expect(html).not.toContain('Degrees of freedom');
  expect(html).toContain('Pairwise flux differences');
  expect(html).not.toContain('<details>');
  expect(html).toContain('#2 minus #1');
  expect(html).toContain('#3 minus #2');
  expect(html).not.toContain('minus 1 fitted mean');
  expect(html.match(/<tr>/g)).toHaveLength(4);
  expect(html).toContain('Unavailable'); expect(html).toContain('does not establish intrinsic variability');
});
it('places the styled summary after the graph without error bars and retains uncertainty values', () => {
  const measurements = { ...result, measurements: [{ ...result.measurements[0], fluxMjy: 2, uncertaintyMjy: 100 }] };
  const html = renderToStaticMarkup(<MovingCandidateAnalysis sequenceId="sequence" candidate={candidate} radius={2.5} onRadiusChange={() => {}} automatic={{ status: 'completed', result: measurements }} />);
  expect(html).toContain('motion-analysis-overview');
  expect(html).toContain('measurement-metrics');
  expect(html.indexOf('class="motion-analysis-graph"')).toBeLessThan(html.indexOf('class="measurement-summary"'));
  expect(html).not.toContain('motion-flux-error');
  expect(html).not.toContain('Vertical capped bars');
  expect(html).toContain('+/- 100.0 mJy');
  expect(html).toContain('<th>Uncertainty</th>');
  expect(html).not.toContain('Uncertainty is an approximate statistical estimate shown only');
});

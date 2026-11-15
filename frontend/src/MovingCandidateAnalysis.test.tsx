import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { MovingCandidateAnalysis } from './MovingCandidateAnalysis';
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

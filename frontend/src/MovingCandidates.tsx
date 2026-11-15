import type { MotionCandidate, ObservationAnalysis } from './api/frames';

interface Props {
  search: ObservationAnalysis;
  activeId: string | null;
  onReview: (candidate: MotionCandidate) => void;
}

export function MovingCandidates({ search, activeId, onReview }: Props) {
  return <section className="moving-candidates" aria-label="Motion candidates">
    <h3>Motion candidates</h3>
    <p role="status">
      {!search.comparable
        ? `Not enough usable, comparable exposures in the ${search.analyzedFrames} analyzed frames.`
        : search.candidates.length
          ? `${search.candidates.length} candidates · ${search.analyzedFrames} frames analyzed`
          : `No candidate tracks in ${search.analyzedFrames} analyzed frames.`}
    </p>
    {!!search?.candidates.length && <ol>
      {search.candidates.map((candidate, index) => <li key={candidate.id}>
        <button type="button" aria-pressed={activeId === candidate.id} onClick={() => onReview(candidate)}>
          <strong>Candidate {index + 1}</strong>
          <span>{candidate.detector} · {candidate.detections.length} positions · {candidate.displacementArcsec.toFixed(0)}″ over {candidate.elapsedHours.toFixed(1)} h</span>
        </button>
      </li>)}
    </ol>}
  </section>;
}

import type { Frame, MotionDetection } from '../api/frames';

export function FrameMetadata({ frame, detection }: { frame?: Frame; detection?: MotionDetection }) {
  if (!frame) return <p className="hint">Frame details appear as images load.</p>;
  return <dl className="metadata" aria-label="Current frame metadata">
    <div><dt>Observed (UTC)</dt><dd>{frame.observedAtUtc.replace('T', ' ').replace('Z', '')}</dd></div>
    <div><dt>Detector</dt><dd>{frame.detector}</dd></div>
    <div><dt>Release</dt><dd>{frame.release}</dd></div>
    <div><dt>Wavelength at target</dt><dd>{frame.wavelengthUm == null ? 'Unavailable' : `${frame.wavelengthUm.toFixed(3)} microns`}</dd></div>
    <div><dt>Visit</dt><dd>{frame.visit + 1}</dd></div>
    {detection && <>
      <div><dt>Measured RA / Dec</dt><dd>{detection.ra.toFixed(5)}, {detection.dec.toFixed(5)} degrees</dd></div>
      <div><dt>Peak S/N</dt><dd>{detection.signalToNoise.toFixed(1)}</dd></div>
    </>}
  </dl>;
}

import { useEffect, useState } from 'react';
import type { Frame } from '../api/frames';
import { extractSpectrum } from '../api/spectra';
import type { Circle, Spectrum } from '../api/spectra';

export function useSpectrum(sequenceId: string | undefined, frames: Frame[]) {
  const [storedSelection, setSelection] = useState<{ sequenceId: string; referenceFrameId: string; circle: Circle; hostName?: string } | null>(null);
  const selection = storedSelection?.sequenceId === sequenceId ? storedSelection : null;
  const [result, setResult] = useState<Spectrum | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  // All known groups are extracted together. Group selection and frame navigation are display-only.
  const groups = [...new Set(frames.map(f => f.observationGroupId ?? f.visit))].sort((a, b) => a - b);
  const exposureKey = frames.map(f => `${f.id}:${f.status}`).sort().join('|');
  const groupKey = groups.join(',');
  useEffect(() => {
    if (!sequenceId || !selection) return;
    const controller = new AbortController();
    // Synchronize request status with this abortable backend extraction.
    // oxlint-disable-next-line react/set-state-in-effect
    setBusy(true); setError('');
    extractSpectrum(sequenceId, selection.referenceFrameId, selection.circle, groupKey.split(',').filter(Boolean).map(Number), controller.signal)
      .then(data => { if (!controller.signal.aborted) setResult(data) })
      .catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Spectrum request failed.') })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) });
    return () => controller.abort();
  }, [sequenceId, selection, exposureKey, groupKey, retry]);
  function commit(referenceFrameId: string, circle: Circle, hostName?: string) {
    if (!sequenceId) return;
    setResult(null); setSelection({ sequenceId, referenceFrameId, circle, hostName });
  }
  return { selection, result: selection ? result : null, error: selection ? error : '', busy: !!selection && busy, groups, commit, retry: () => setRetry(n => n + 1) };
}

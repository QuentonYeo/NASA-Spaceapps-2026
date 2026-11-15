import { useEffect, useState } from 'react';
import type { Frame } from '../api/frames';
import type { Circle, Region, RegionSelection } from '../api/regions';
import { cubeRequest, cubeRoot, startFingerprint } from '../api/fingerprints';
import type { FingerprintStatus } from '../api/fingerprints';

export function useFingerprint(sequenceId: string | undefined, frames: Frame[]) {
  const [storedSelection, setSelection] = useState<RegionSelection | null>(null);
  const selection = storedSelection?.sequenceId === sequenceId ? storedSelection : null;
  const [stored, setStatus] = useState<{ selection: typeof storedSelection; status: FingerprintStatus } | null>(null);
  const status = stored?.selection === selection ? stored.status : null;
  const [failure, setFailure] = useState<{ selection: typeof storedSelection; message: string } | null>(null);
  const [retryCount, setRetry] = useState(0);
  const [requestedChannel, setRequestedChannel] = useState(63);
  const result = status?.result ?? null;
  const [resolved, setResolved] = useState<{ selection: typeof storedSelection; region: Region } | null>(null);
  const region = resolved?.selection === selection ? resolved.region : result?.region;
  const selectedChannel = result?.channels.find(c => c.channel === requestedChannel && c.value !== null)?.channel
    ?? result?.channels.find(c => c.value !== null)?.channel ?? requestedChannel;
  function setChannel(channel: number) {
    if (!result) { setRequestedChannel(channel); return }
    const usable = result.channels.filter(c => c.value !== null);
    const chosen = usable.reduce<typeof usable[number] | undefined>((best, candidate) =>
      !best || Math.abs(candidate.channel - channel) < Math.abs(best.channel - channel) ? candidate : best, undefined);
    if (chosen) setRequestedChannel(chosen.channel);
  }
  useEffect(() => {
    if (!sequenceId || !selection) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: unknown) => {
      if (!controller.signal.aborted) setFailure({ selection, message: error instanceof Error ? error.message : 'Could not load cube channels.' });
    };
    async function poll(id: string) {
      try {
        const data = await cubeRequest<FingerprintStatus>(`${cubeRoot(sequenceId!)}/${id}`, controller.signal);
        if (controller.signal.aborted) return;
        setStatus({ selection, status: data });
        if (data.status === 'loading') timer = setTimeout(() => void poll(id), 1000);
      } catch (error) { fail(error) }
    }
    startFingerprint(sequenceId, selection.referenceFrameId, selection.circle, controller.signal, retryCount > 0)
      .then(data => { if (!controller.signal.aborted) { setResolved({ selection, region: data.region }); void poll(data.analysisId) } }).catch(fail);
    return () => { controller.abort(); clearTimeout(timer) };
  }, [sequenceId, selection, retryCount]);
  function commit(referenceFrameId: string, circle: Circle, hostName?: string) {
    if (!sequenceId) return;
    const frame = frames.find(frame => frame.id === referenceFrameId);
    if (frame?.scienceStatus && frame.scienceStatus !== 'retained') return;
    if (selection?.referenceFrameId === referenceFrameId && JSON.stringify(selection.circle) === JSON.stringify(circle)) return;
    setFailure(null); setRetry(0); setRequestedChannel(63);
    setSelection({ sequenceId, referenceFrameId, circle, hostName });
  }
  return { selection, region, result, status, selectedChannel, setChannel, commit,
    busy: !!selection && (!status || status.status === 'loading') && failure?.selection !== selection,
    error: failure?.selection === selection ? failure.message : status?.error ?? '',
    retry: () => { setFailure(null); setRetry(n => n+1) } };
}

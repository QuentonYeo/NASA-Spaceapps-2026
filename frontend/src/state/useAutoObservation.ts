import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAutoObservation, wait } from '../api/frames';
import type { ObservationAnalysis } from '../api/frames';

export function useAutoObservation(sequenceId?: string) {
  const controller = useRef<AbortController | null>(null);
  const [entry, setEntry] = useState<{ id: string; result?: ObservationAnalysis; pending?: boolean; error?: string }>();
  const current = entry?.id === sequenceId ? entry : undefined;

  const run = useCallback(async (start: boolean) => {
    if (!sequenceId) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const { signal } = request;
    try {
      let result = await fetchAutoObservation(sequenceId, signal, start);
      while (!signal.aborted) {
        setEntry({ id: sequenceId, result });
        if (result.status !== 'running') return;
        await wait(1000, signal);
        result = await fetchAutoObservation(sequenceId, signal);
      }
    } catch (error) {
      if (!signal.aborted) setEntry({ id: sequenceId,
        error: error instanceof Error ? error.message : 'Could not check motion analysis.',
      });
    }
  }, [sequenceId]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active && sequenceId) void run(false);
    });
    return () => {
      active = false;
      controller.current?.abort();
    };
  }, [sequenceId, run]);

  return { result: current?.result, pending: !!sequenceId && (!current || current.pending), error: current?.error,
    start: () => {
      if (sequenceId) setEntry({ id: sequenceId, pending: true });
      return run(true);
    }, reconnect: () => run(false) };
}

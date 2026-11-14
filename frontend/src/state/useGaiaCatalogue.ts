import { useEffect, useState } from 'react';
import { getGaiaCatalogue } from '../api/frames';
import type { GaiaCatalogue } from '../api/frames';

export function useGaiaCatalogue(sequenceId?: string) {
  const [enabled, setEnabled] = useState(false);
  const [result, setResult] = useState<{ id: string; catalogue?: GaiaCatalogue; error?: string }>();
  const current = result?.id === sequenceId ? result : undefined;

  useEffect(() => {
    if (!enabled || !sequenceId || current) return;
    const controller = new AbortController();
    void getGaiaCatalogue(sequenceId, controller.signal).then(
      (catalogue) => { if (!controller.signal.aborted) setResult({ id: sequenceId, catalogue }); },
      (error: unknown) => {
        if (!controller.signal.aborted) setResult({
          id: sequenceId,
          error: error instanceof Error ? error.message : 'Could not load Gaia reference stars.',
        });
      },
    );
    return () => controller.abort();
  }, [enabled, sequenceId, current]);

  function toggle(value: boolean) {
    if (value && current?.error) setResult(undefined);
    setEnabled(value);
  }

  return { enabled, toggle, catalogue: current?.catalogue, error: current?.error,
    loading: enabled && !!sequenceId && !current };
}

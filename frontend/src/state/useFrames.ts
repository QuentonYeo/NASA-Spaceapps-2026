import { useEffect, useRef, useState } from 'react';
import { pollSequence, requestBatch, startSequence } from '../api/frames';
import type { Frame, SequencePage, SkyQuery } from '../api/frames';

export function useFrames() {
  const cursor = useRef(0);
  const session = useRef<{ sequenceId: string; pollUrl: string } | null>(null);
  const [resumable, setResumable] = useState(false);
  const [paused, setPaused] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [page, setPage] = useState<SequencePage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState<SkyQuery | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  function receive(next: SequencePage) {
    cursor.current = next.nextCursor;
    setPage(next); setNotice('');
    setFrames((existing) => {
      const merged = new Map(existing.map((frame) => [frame.id, frame]));
      for (const frame of next.frames) merged.set(frame.id, frame);
      return [...merged.values()].sort((a, b) => a.observedAtUtc.localeCompare(b.observedAtUtc) || a.id.localeCompare(b.id));
    });
    if (next.error) setError(next.error.message);
  }

  async function run(input?: SkyQuery) {
    if (!input && !session.current) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setError(''); setBusy(true); setPaused(false);
    if (input) {
      cursor.current = 0; session.current = null; setResumable(false);
      setFrames([]); setPage(null); setQuery(input);
    }
    setNotice(input ? 'Discovering exposures...' : 'Resuming image loading...');
    try {
      if (input) {
        const accepted = await startSequence(input, current.signal);
        if (current.signal.aborted) return;
        session.current = accepted;
        setResumable(true);
      }
      const active = session.current!;
      while (!current.signal.aborted) {
        const latest = await pollSequence(active.pollUrl, current.signal, receive, setNotice, cursor.current);
        if (current.signal.aborted || !latest) return;
        if (latest.status !== 'awaiting_more') {
          setResumable(false);
          return;
        }
        setNotice('Requesting the next image batch...');
        await requestBatch(active.sequenceId, latest.scheduledCount, current.signal);
      }
    } catch (caught) {
      if (!current.signal.aborted) {
        setError(caught instanceof Error ? caught.message : 'The request failed. Please try again.');
        setNotice('');
      }
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  }

  const start = (input: SkyQuery) => run(input);
  const resume = () => run();

  function stop() {
    controller.current?.abort(); setBusy(false); setPaused(true);
    setNotice('Stopped. Images are kept; the current backend batch may finish. Resume to continue.');
  }
  return { frames, page, busy, error, notice, query, start, stop, resume, resumable, paused };
}

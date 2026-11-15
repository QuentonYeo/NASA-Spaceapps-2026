import { useCallback, useEffect, useRef, useState } from 'react';
import { RequestError, pollSequence, requestBatch, startSequence } from '../api/frames';
import type { Frame, SequencePage, SkyQuery } from '../api/frames';

const storageKey = 'spherex-active-search';
type SavedSearch = { sequenceId: string; pollUrl: string; query: SkyQuery; paused: boolean; validationExampleId?: string };

function readSearch(): SavedSearch | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as SavedSearch | null;
    if (!saved || typeof saved.sequenceId !== 'string' ||
        !/^[-\w]+$/.test(saved.sequenceId) || saved.pollUrl !== `/api/frames/${saved.sequenceId}` ||
        ![saved.query.ra, saved.query.dec, saved.query.fov].every(Number.isFinite)) return null;
    return saved;
  } catch {
    return null;
  }
}

function saveSearch(search: SavedSearch | null) {
  try {
    if (search) sessionStorage.setItem(storageKey, JSON.stringify(search));
    else sessionStorage.removeItem(storageKey);
  } catch {
    // Searching remains available when browser storage is unavailable.
  }
}

export function useFrames() {
  const [requestGroup] = useState(() => {
    try {
      const id = sessionStorage.getItem("spherex-search-group") ?? crypto.randomUUID();
      sessionStorage.setItem("spherex-search-group", id);
      return id;
    } catch { return crypto.randomUUID(); }
  });
  const cursor = useRef(0);
  const lastStatus = useRef<SequencePage["status"] | null>(null);
  const [saved] = useState(readSearch);
  const session = useRef(saved);
  const [resumable, setResumable] = useState(false);
  const [paused, setPaused] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [page, setPage] = useState<SequencePage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState<SkyQuery | null>(saved?.query ?? null);
  const [validationExampleId, setValidationExampleId] = useState(saved?.validationExampleId);
  const receive = useCallback((next: SequencePage) => {
    cursor.current = next.nextCursor;
    lastStatus.current = next.status;
    setPage(next); setNotice('');
    setFrames((existing) => {
      const merged = new Map(existing.map((frame) => [frame.id, frame]));
      for (const frame of next.frames) merged.set(frame.id, frame);
      return [...merged.values()].sort((a, b) => a.observedAtUtc.localeCompare(b.observedAtUtc) || a.id.localeCompare(b.id));
    });
    if (next.error) setError(next.error.message);
  }, []);

  const run = useCallback(async (input?: SkyQuery, restoring = false, restart = false, exampleId?: string, preloadedId?: string) => {
    if (!input && !session.current) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    const existing = session.current;
    const sameQuery = !!(!restart && input && existing && lastStatus.current !== 'failed' && lastStatus.current !== 'partial' && input.ra === existing.query.ra &&
      input.dec === existing.query.dec && input.fov === existing.query.fov &&
      input.findMovers === existing.query.findMovers && input.detector === existing.query.detector &&
      JSON.stringify(input.collections) === JSON.stringify(existing.query.collections) &&
      JSON.stringify(input.exposureIds) === JSON.stringify(existing.query.exposureIds));
    const activeExampleId = input ? exampleId : existing?.validationExampleId;
    setValidationExampleId(activeExampleId);
    const newSearch = sameQuery ? undefined : input;
    const restorePaused = restoring && !!existing?.paused;
    setError(''); setBusy(true); setPaused(restorePaused);
    if (newSearch) {
      saveSearch(null);
      cursor.current = 0; lastStatus.current = null; session.current = null; setResumable(false);
      setFrames([]); setPage(null); setQuery(newSearch);
    }
    setNotice(newSearch && !preloadedId ? 'Discovering exposures...' : 'Reconnecting to the existing search...');
    try {
      if (newSearch) {
        const accepted = preloadedId
          ? { sequenceId: preloadedId, pollUrl: `/api/frames/${preloadedId}` }
          : await startSequence({ ...newSearch, requestGroup, refresh: restart }, current.signal);
        if (current.signal.aborted) return;
        session.current = { ...accepted, query: newSearch, paused: false };
        setResumable(true);
      }
      const active = { ...session.current!, paused: restorePaused, validationExampleId: activeExampleId };
      session.current = active;
      setResumable(true);
      saveSearch(active);
      while (!current.signal.aborted) {
        const latest = await pollSequence(active.pollUrl, current.signal, receive, setNotice, cursor.current);
        if (current.signal.aborted || !latest) return;
        if (latest.status !== 'awaiting_more') {
          setResumable(false);
          return;
        }
        if (restorePaused) return;
        setNotice('Requesting the next image batch...');
        await requestBatch(active.sequenceId, latest.scheduledCount, current.signal);
      }
    } catch (caught) {
      if (!current.signal.aborted) {
        if (caught instanceof RequestError && (caught.status === 404 || caught.status === 410)) {
          session.current = null;
          saveSearch(null);
          setResumable(false);
          setPaused(false);
          setNotice('');
          if (preloadedId && newSearch) return 'preload-expired';
          setError('The previous search expired. Select Start to reload this view.');
          return;
        }
        setError(caught instanceof Error ? caught.message : 'The request failed. Please try again.');
        setNotice('');
      }
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  }, [receive, requestGroup]);

  useEffect(() => {
    if (saved) void run(undefined, true);
    return () => controller.current?.abort();
  }, [run, saved]);

  async function start(input: SkyQuery, restart = false, exampleId?: string, preloadedId?: string) {
    const result = await run(input, false, restart, exampleId, preloadedId);
    if (result === 'preload-expired') await run(input, false, restart, exampleId);
  }
  const resume = () => run();

  function stop() {
    controller.current?.abort(); setBusy(false); setPaused(true);
    if (session.current) {
      session.current = { ...session.current, paused: true };
      saveSearch(session.current);
    }
    setNotice('Stopped. Images are kept; the current backend batch may finish. Resume to continue.');
  }
  return { frames, page, busy, error, notice, query, validationExampleId, start, stop, resume, resumable, paused };
}

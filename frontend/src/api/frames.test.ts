import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollSequence, startSequence } from './frames';

const page = (overrides = {}) => ({
  sequenceId: 'test', status: 'running', nextCursor: 1, hasMore: false, pollAfterSeconds: 1,
  progress: { total: 2, ready: 1, failed: 0 }, frames: [], error: null, ...overrides,
});
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() });

describe('backend polling', () => {
  it('posts a query once without automatically retrying job creation', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ error: { message: 'Busy', retryable: true } }, 503));
    vi.stubGlobal('fetch', fetch);
    await expect(startSequence({ ra: 1, dec: 2, fov: .05 }, new AbortController().signal)).rejects.toThrow('Busy');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].body).toBe('{"ra":1,"dec":2,"fov":0.05}');
  });

  it('honors the cursor and drains remaining pages after completion', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(page({ status: 'completed', hasMore: true, nextCursor: 10 })))
      .mockResolvedValueOnce(json(page({ status: 'completed', nextCursor: 12 })));
    vi.stubGlobal('fetch', fetch);
    const onPage = vi.fn();
    const run = pollSequence('/api/frames/test', new AbortController().signal, onPage);
    await vi.runAllTimersAsync(); await run;
    expect(fetch.mock.calls.map((call) => call[0])).toEqual(['/api/frames/test?after=0', '/api/frames/test?after=10']);
    expect(onPage).toHaveBeenCalledTimes(2);
  });

  it('continues when no frames are ready and respects polling delay', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(json(page({ nextCursor: 0, pollAfterSeconds: 2 })))
      .mockResolvedValueOnce(json(page({ status: 'completed' })));
    vi.stubGlobal('fetch', fetch);
    const run = pollSequence('/api/frames/test', new AbortController().signal, vi.fn());
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await run;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries transient poll failures at the same cursor', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(json({ error: { message: 'Busy', retryable: true, retryAfterSeconds: 2 } }, 503))
      .mockResolvedValueOnce(json(page({ status: 'partial' })));
    vi.stubGlobal('fetch', fetch);
    const notice = vi.fn();
    const run = pollSequence('/api/frames/test', new AbortController().signal, vi.fn(), notice);
    await vi.runAllTimersAsync(); await run;
    expect(fetch.mock.calls.map((call) => call[0])).toEqual(['/api/frames/test?after=0', '/api/frames/test?after=0']);
    expect(notice).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale response after the query is aborted', async () => {
    const controller = new AbortController();
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolve = done })));
    const onPage = vi.fn();
    const run = pollSequence('/api/frames/test', controller.signal, onPage);
    controller.abort(); resolve(json(page({ status: 'completed' })));
    await run;
    expect(onPage).not.toHaveBeenCalled();
  });

  it('surfaces an expired sequence instead of creating another job', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: { message: 'Sequence expired', retryable: false } }, 410)));
    await expect(pollSequence('/api/frames/test', new AbortController().signal, vi.fn())).rejects.toThrow('Sequence expired');
  });
});


it('stops at a batch boundary and resumes from the prior completion cursor', async () => {
  const fetch = vi.fn().mockResolvedValue(json(page({ status: 'awaiting_more', nextCursor: 12 })));
  vi.stubGlobal('fetch', fetch);
  await pollSequence('/api/frames/test', new AbortController().signal, vi.fn(), vi.fn(), 10);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe('/api/frames/test?after=10');
});

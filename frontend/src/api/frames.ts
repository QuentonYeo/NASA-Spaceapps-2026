export interface SkyQuery { ra: number; dec: number; fov: number }
export interface ApiError { code: string; message: string; retryable: boolean; retryAfterSeconds: number | null }
export interface Frame {
  id: string; visit: number; observedAtUtc: string; release: string; detector: string;
  status: 'ready' | 'failed'; imageData: string | null;
  grid: { width: number; height: number; orientation: string } | null;
  error: ApiError | null;
}
export interface SequencePage {
  sequenceId: string; status: 'queued' | 'discovering' | 'running' | 'awaiting_more' | 'completed' | 'partial' | 'failed';
  scheduledCount: number; remaining: number; batchSize: number;
  nextCursor: number; hasMore: boolean; pollAfterSeconds: number;
  progress: { total: number; ready: number; failed: number };
  frames: Frame[]; error: ApiError | null;
}
interface Accepted { sequenceId: string; pollUrl: string; pollAfterSeconds: number }

export class RequestError extends Error {
  readonly retryable: boolean;
  readonly retryAfter: number;
  constructor(message: string, retryable = false, retryAfter = 1) {
    super(message); this.retryable = retryable; this.retryAfter = retryAfter;
  }
}

async function request<T>(url: string, signal: AbortSignal, body?: SkyQuery | { after: number }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new RequestError('Cannot reach the backend. Check that it is running on port 8000.', true);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new RequestError(data?.error?.message ?? `Backend request failed (${response.status}).`,
      data?.error?.retryable ?? response.status >= 500,
      data?.error?.retryAfterSeconds ?? 1);
  }
  if (!data) throw new RequestError('The backend returned an invalid response.');
  return data as T;
}

export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const abort = () => { clearTimeout(timer); reject(signal.reason) };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function pollSequence(
  pollUrl: string, signal: AbortSignal, onPage: (page: SequencePage) => void,
  onRetry: (message: string) => void = () => {}, initialCursor = 0,
) {
  let cursor = initialCursor;
  let failures = 0;
  while (!signal.aborted) {
    let page: SequencePage;
    try {
      page = await request<SequencePage>(`${pollUrl}?after=${cursor}`, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      if (!(error instanceof RequestError) || !error.retryable || ++failures > 3) throw error;
      onRetry(`${error.message} Retrying polling (${failures}/3)...`);
      await wait(Math.max(1, error.retryAfter) * 1000, signal);
      continue;
    }
    if (signal.aborted) return;
    failures = 0;
    onPage(page);
    cursor = page.nextCursor;
    // A terminal job may still have several pages of results to drain.
    if (['awaiting_more', 'completed', 'partial', 'failed'].includes(page.status) && !page.hasMore) return page;
    await wait(page.hasMore ? 0 : Math.max(1, page.pollAfterSeconds) * 1000, signal);
  }
}

export async function startSequence(query: SkyQuery, signal: AbortSignal): Promise<Accepted> {
  return request<Accepted>('/api/frames', signal, query);
}

export async function requestBatch(sequenceId: string, after: number, signal: AbortSignal): Promise<Accepted> {
  return request<Accepted>(`/api/frames/${sequenceId}/batches`, signal, { after });
}

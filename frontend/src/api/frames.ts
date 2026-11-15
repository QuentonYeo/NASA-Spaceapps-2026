export interface SkyQuery {
  ra: number; dec: number; fov: number;
  exposureIds?: string[];
  detector?: string;
  findMovers?: boolean;
}
export interface ApiError { code: string; message: string; retryable: boolean; retryAfterSeconds: number | null }
export interface Frame {
  id: string; visit: number; observationGroupId?: number; observedAtUtc: string; release: string; detector: string;
  scienceStatus?: 'retained' | 'retention_limit' | 'unavailable';
  status: 'ready' | 'failed'; imageData: string | null;
  sharedImageData?: string | null;
  sharedDisplay?: { vmin: number; vmax: number } | null;
  alignedImageData?: string | null;
  alignedGrid?: { width: number; height: number; orientation: string } | null;
  wavelengthUm?: number | null;
  grid: { width: number; height: number; orientation: string } | null;
  error: ApiError | null;
}
export interface MotionDetection {
  frameId: string; observedAtUtc: string; x: number; y: number; ra: number; dec: number; signalToNoise: number;
}
export interface MotionCandidate {
  id: string; detector: string; detections: MotionDetection[]; displacementArcsec: number;
  elapsedHours: number; residualPixels: number; score: number;
}
export interface MotionSearch {
  analyzedFrames: number; comparable: boolean; candidates: MotionCandidate[];
}
export interface ObservationAnalysis extends MotionSearch {
  status: 'idle' | 'running' | 'completed' | 'failed';
  readyFrames: number; availableFrames: number; processedFrames: number; error: string | null;
}

export interface SequencePage {
  sequenceId: string; status: 'queued' | 'discovering' | 'running' | 'awaiting_more' | 'completed' | 'partial' | 'failed';
  scheduledCount: number; remaining: number; batchSize: number;
  nextCursor: number; hasMore: boolean; pollAfterSeconds: number;
  progress: { total: number; ready: number; failed: number };
  motion?: MotionSearch | null;
  frames: Frame[]; error: ApiError | null;
}
interface Accepted { sequenceId: string; pollUrl: string; pollAfterSeconds: number }

export class RequestError extends Error {
  readonly retryable: boolean;
  readonly retryAfter: number;
  readonly status?: number;
  constructor(message: string, retryable = false, retryAfter = 1, status?: number) {
    super(message); this.retryable = retryable; this.retryAfter = retryAfter; this.status = status;
  }
}

async function request<T>(url: string, signal: AbortSignal, body?: SkyQuery | { after: number }, method = body ? 'POST' : 'GET'): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
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
      data?.error?.retryAfterSeconds ?? 1, response.status);
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
  const { ra, dec, fov, exposureIds, detector, findMovers } = query;
  return request<Accepted>('/api/frames', signal, { ra, dec, fov, exposureIds, detector, findMovers });
}

export async function requestBatch(sequenceId: string, after: number, signal: AbortSignal): Promise<Accepted> {
  return request<Accepted>(`/api/frames/${sequenceId}/batches`, signal, { after });
}

export interface GaiaSource {
  sourceId: string;
  ra: number;
  dec: number;
  refEpoch: number;
  pmRa: number | null;
  pmDec: number | null;
  gMagnitude: number;
}

export interface GaiaCatalogue { sources: GaiaSource[]; limited: boolean }

export function getGaiaCatalogue(sequenceId: string, signal: AbortSignal) {
  return request<GaiaCatalogue>(`/api/frames/${encodeURIComponent(sequenceId)}/gaia`, signal);
}

export function fetchAutoObservation(sequenceId: string, signal: AbortSignal, start = false) {
  return request<ObservationAnalysis>(`/api/frames/${encodeURIComponent(sequenceId)}/auto-observation${start ? '?rerun=true' : ''}`,
    signal, undefined, start ? 'POST' : 'GET');
}

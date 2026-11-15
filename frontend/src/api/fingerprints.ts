import type { Circle, Region } from './regions';

export interface Channel {
  channel: number; detector: number; subchannel: number; wavelengthUm: number; minUm: number; maxUm: number;
  apertureFluxMjy: number | null; backgroundFluxMjy: number | null; backgroundMeanMJySr: number | null;
  apertureAreaPixels: number; backgroundPixels: number; backgroundCoverage: number;
  value: number | null; uncertainty: null; pixels: number; coveredPixels: number; coverage: number; flagsOr: number; reason: string;
}
export interface Fingerprint {
  region: Region; channels: Channel[]; usableChannels: number; totalChannels: number; unit: 'mJy'; product: string; processingVersion: string;
  provenance: { tile: number; url: string; diskCacheHit: boolean }[];
  references: { name: string; wavelengthUm: number; sourceUrl: string; status: string }[];
  limitations: string[]; qualityPolicy: string; combinedEpochs: boolean; uncertaintyAvailable: boolean; elapsedSeconds: number;
}
export interface FingerprintStatus {
  analysisId: string; status: 'loading' | 'ready' | 'failed'; message: string;
  downloadedBytes: number | null; totalBytes: number | null; error: string | null; result: Fingerprint | null;
}
export async function cubeRequest<T>(url: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: body ? 'POST' : 'GET', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error?.message ?? `Channel request failed (${response.status})`);
  return data as T;
}
export const cubeRoot = (sequence: string) => `/api/frames/${encodeURIComponent(sequence)}/fingerprints`;
export const startFingerprint = (sequence: string, referenceFrameId: string, circle: Circle, signal: AbortSignal, retry = false) =>
  cubeRequest<{ analysisId: string; status: string; region: Region }>(cubeRoot(sequence), signal, { referenceFrameId, circle, retry });

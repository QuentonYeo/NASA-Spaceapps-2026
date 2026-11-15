import type { Region } from './regions';

type Rings = number[][][];
type Entry = { pending: Promise<Rings>; rings?: Rings };
const cache = new Map<string, Entry>();
export const regionProjectionKey = (sequence: string, frame: string, region: Region) =>
  JSON.stringify([sequence, frame, region.ra, region.dec, region.radiusArcsec, region.innerArcsec, region.outerArcsec]);
export const cachedRegionProjection = (key: string) => cache.get(key)?.rings;

// Share small WCS projections across navigation and neighbour prefetches.
export function loadRegionProjection(sequence: string, frame: string, region: Region): Promise<Rings> {
  const key = regionProjectionKey(sequence, frame, region);
  const existing = cache.get(key);
  if (existing) return existing.pending;
  const entry: Entry = { pending: Promise.resolve([]) };
  entry.pending = fetch(`/api/frames/${encodeURIComponent(sequence)}/frames/${encodeURIComponent(frame)}/projection`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(region),
    signal: AbortSignal.timeout(20_000),
  }).then(async response => {
    if (!response.ok) throw new Error('Region overlay unavailable on this frame.');
    const data = await response.json();
    entry.rings = data.rings;
    return data.rings as Rings;
  }).catch(error => {
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  });
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(key, entry);
  return entry.pending;
}

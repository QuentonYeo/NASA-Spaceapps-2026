import type { Frame } from '../api/frames';
import type { Region } from '../api/regions';
import type { ValidationExample } from './validationExamples';

export const savedObjectKeyPrefix = 'spherex-known-object:';
export const savedObjectNameLimit = 80;

interface SavedKnownObject {
  id: string;
  name: string;
  ra: number;
  dec: number;
  radiusArcsec: number;
  frameId: string;
  release: string;
  detector: string;
}

export function readSavedKnownObjects(): SavedKnownObject[] {
  try {
    const objects: SavedKnownObject[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(savedObjectKeyPrefix)) continue;
      try {
        const item = JSON.parse(localStorage.getItem(key) ?? 'null') as SavedKnownObject | null;
        if (item && key === savedObjectKeyPrefix + item.id && typeof item.name === 'string' &&
            item.name.trim() && item.name.length <= savedObjectNameLimit &&
            Number.isFinite(item.ra) && item.ra >= 0 && item.ra < 360 &&
            Number.isFinite(item.dec) && item.dec >= -90 && item.dec <= 90 &&
            item.radiusArcsec > 0 && item.radiusArcsec <= 1800 && Number.isFinite(item.radiusArcsec) &&
            typeof item.frameId === 'string' && item.frameId && typeof item.release === 'string' &&
            typeof item.detector === 'string') {
          objects.push(item);
        }
      } catch {
        // A damaged entry should not hide the other saved objects.
      }
    }
    return objects;
  } catch {
    return [];
  }
}

export function saveKnownObject(name: string, region: Region, frame: Pick<Frame, 'id' | 'release' | 'detector'>) {
  const id = `saved-${crypto.randomUUID()}`;
  const { ra, dec, radiusArcsec } = region;
  const item: SavedKnownObject = {
    id, name, ra, dec, radiusArcsec, frameId: frame.id, release: frame.release, detector: frame.detector,
  };
  try {
    localStorage.setItem(savedObjectKeyPrefix + id, JSON.stringify(item));
  } catch {
    throw new Error('This browser could not save the object. Check that site storage is available.');
  }
}

export function savedValidationExample(item: SavedKnownObject): ValidationExample {
  const { id, name, ra, dec, radiusArcsec, frameId, release } = item;
  return {
    id, name, radiusArcsec,
    purpose: 'Saved sky region',
    inputs: { ra: String(ra), dec: String(dec), fov: String(Math.max(0.02, radiusArcsec / 1800)) },
    // Prefer the source exposure when present while retaining other comparable observations.
    blinkIds: [frameId],
    collections: release === 'spherex_dr1' || release === 'spherex_qr3' ? [release] : undefined,
    detector: /^(SPHEREx-)?D[1-6]$/.test(item.detector) ? item.detector.replace('SPHEREx-', '') : undefined,
  };
}

import { afterEach, expect, it, vi } from 'vitest';
import { readSavedKnownObjects, savedObjectKeyPrefix, savedValidationExample, saveKnownObject } from './savedKnownObjects';

afterEach(() => vi.unstubAllGlobals());

it('saves a native-circle target and restores it as a comparable validation search', () => {
  const entries = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() { return entries.size; },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
  });
  entries.set(savedObjectKeyPrefix + 'broken', '{');
  saveKnownObject('Ring near M101', { ra: 210.8, dec: 54.3, radiusArcsec: 90, innerArcsec: 180, outerArcsec: 270 },
    { id: 'source/one', release: 'spherex_qr3', detector: 'SPHEREx-D2' });
  const saved = readSavedKnownObjects();
  expect(saved).toHaveLength(1);
  expect(savedValidationExample(saved[0])).toMatchObject({
    name: 'Ring near M101', radiusArcsec: 90,
    inputs: { ra: '210.8', dec: '54.3', fov: '0.05' },
    blinkIds: ['source/one'], collections: ['spherex_qr3'], detector: 'D2',
  });
});

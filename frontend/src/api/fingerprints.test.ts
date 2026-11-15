import { afterEach, expect, it, vi } from 'vitest';
import { startFingerprint } from './fingerprints';

afterEach(() => vi.unstubAllGlobals());
it('requests channels at the selected native FOV region without resubmitting a sky search', async () => {
  const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({analysisId:'cube'})}); vi.stubGlobal('fetch',fetcher);
  await startFingerprint('fov/one','frame/native',{x:12,y:13,radiusPixels:2},new AbortController().signal);
  expect(fetcher.mock.calls[0][0]).toBe('/api/frames/fov%2Fone/fingerprints');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({referenceFrameId:'frame/native',circle:{x:12,y:13,radiusPixels:2},retry:false});
});

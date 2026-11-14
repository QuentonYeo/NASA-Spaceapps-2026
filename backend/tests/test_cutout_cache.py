import io

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from app.domain.models import Exposure, Region
from app.services.cutout_cache import CutoutCache
from app.services.rendering import FitsRenderer, PIXEL_SCALE_DEG


class ArchiveCutouts:
    def __init__(self):
        self.requests = []

    def fetch(self, exposure, region):
        self.requests.append((exposure.id, region))
        side = round(region.fov / PIXEL_SCALE_DEG)
        wcs = WCS(naxis=2)
        wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
        wcs.wcs.crval = [region.ra, region.dec]
        wcs.wcs.crpix = [(side + 1) / 2] * 2
        wcs.wcs.cdelt = [-PIXEL_SCALE_DEG, PIXEL_SCALE_DEG]
        data = np.arange(side * side, dtype=float).reshape(side, side)
        output = io.BytesIO()
        fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(
            data, wcs.to_header(), name="IMAGE")]).writeto(output)
        return output.getvalue()


def test_cutout_cache_reuses_exposure_for_covered_views():
    source = ArchiveCutouts()
    cache = CutoutCache(100_000)
    renderer = FitsRenderer()
    exposure = Exposure("archive-id", "https://example.test/exposure.fits", 0, "", "dr1", "D3")
    wide = Region(210, 54, 21 * PIXEL_SCALE_DEG)
    nearby = Region(210.003, 54, 9 * PIXEL_SCALE_DEG)
    outside = Region(211, 54, 9 * PIXEL_SCALE_DEG)
    wider = Region(210, 54, 25 * PIXEL_SCALE_DEG)

    original = cache.prepare(exposure, wide, source, renderer)
    same = cache.prepare(exposure, wide, source, renderer)
    cropped = cache.prepare(exposure, nearby, source, renderer)
    assert source.requests == [(exposure.id, wide)]
    np.testing.assert_array_equal(same.data, original.data)
    assert cropped.data.shape[0] < original.data.shape[0]
    preview = renderer.preview(cropped, cropped.limits)
    assert preview["alignedGrid"] == {"width": 9, "height": 9, "orientation": "north-up"}
    cache.prepare(exposure, outside, source, renderer)
    cache.prepare(exposure, wider, source, renderer)
    assert source.requests == [(exposure.id, region) for region in (wide, outside, wider)]


def test_cutout_cache_evicts_oldest_exposure_within_byte_budget():
    source = ArchiveCutouts()
    cache = CutoutCache(9000)
    renderer = FitsRenderer()
    region = Region(210, 54, 9 * PIXEL_SCALE_DEG)
    a = Exposure("a", "https://example.test/a.fits", 0, "", "dr1", "D3")
    b = Exposure("b", "https://example.test/b.fits", 0, "", "dr1", "D3")
    for exposure in (a, b, a):
        cache.prepare(exposure, region, source, renderer)
    assert [key for key, _ in source.requests] == ["a", "b", "a"]
    assert 0 < cache.size <= cache.max_bytes

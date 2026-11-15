import io

import numpy as np
import pytest
from astropy import units as u
from astropy.io import fits
from astropy.wcs import WCS
from photutils.aperture import CircularAnnulus

from app.domain.models import Region
from app.services.light_curve import measure_exposure


def test_wing_flux_excludes_core_subtracts_background_and_rejects_flagged_wing(monkeypatch):
    monkeypatch.setattr("app.services.light_curve.local_wavelength", lambda *_: 4.5)
    region = Region(76.956542, 30.401417, .06)
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crpix = [16, 16]
    wcs.wcs.crval = [region.ra, region.dec]
    scale = 6.15 / 3600
    wcs.wcs.cdelt = [-scale, scale]
    header = wcs.to_header()
    header["BUNIT"] = "MJy / sr"
    geometry = (31, 31)
    weights = CircularAnnulus((15, 15), r_in=2.5, r_out=4.5).to_mask(method="exact").to_image(geometry)
    data = np.full(geometry, 10.0)
    data[weights > 0] += 3
    data[15, 15] = 1e6
    flags = np.zeros(geometry, dtype=np.int32)
    flags[15, 15] = 1

    def cutout():
        quality = fits.ImageHDU(flags, name="FLAGS")
        quality.header["MSKN0000"] = "OVERFLOW"
        stream = io.BytesIO()
        fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(data, header, name="IMAGE"), quality]).writeto(stream)
        return stream.getvalue()

    point, reason = measure_exposure(cutout(), region)
    factor = scale**2 * (u.deg**2).to(u.sr) * 1e9
    assert reason is None
    assert point["fluxMjy"] == pytest.approx(3 * np.pi * (4.5**2 - 2.5**2) * factor)
    assert point["wavelengthUm"] == 4.5
    assert point["uncertaintyMjy"] is None
    footprint = point["pixels"]
    assert len(footprint) == np.count_nonzero(weights >= 1e-10)
    assert sum(pixel["weight"] for pixel in footprint) == pytest.approx(weights.sum())
    assert all(len(pixel["aligned"]) == 4 for pixel in footprint)
    assert not any(min(x for x, _ in pixel["native"]) < .5 < max(x for x, _ in pixel["native"])
                   and min(y for _, y in pixel["native"]) < .5 < max(y for _, y in pixel["native"])
                   for pixel in footprint)
    flags[15, 19] = 1
    assert measure_exposure(cutout(), region) == (None, "Masked or saturated wing pixels")


@pytest.mark.parametrize("variance_case", ["valid", "missing", "shape", "source_nan", "background_zero", "irrelevant_nan"])
def test_variance_propagation_includes_fractional_weights_and_clipped_background(monkeypatch, variance_case):
    monkeypatch.setattr("app.services.light_curve.local_wavelength", lambda *_: 4.5)
    region = Region(76.956542, 30.401417, .06)
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crpix = [16, 16]
    wcs.wcs.crval = [region.ra, region.dec]
    wcs.wcs.cdelt = [-6.15 / 3600, 6.15 / 3600]
    header = wcs.to_header()
    header["BUNIT"] = "MJy / sr"
    shape = (31, 31)
    x, y = wcs.world_to_pixel_values(region.ra, region.dec)
    weights = CircularAnnulus((x, y), r_in=2.5, r_out=4.5).to_mask(method="exact").to_image(shape)
    weights[weights < 1e-10] = 0
    sky = CircularAnnulus((x, y), r_in=6, r_out=9).to_mask(method="center").to_image(shape) > 0
    data = np.full(shape, 10.)
    data[weights > 0] += 3
    outlier = tuple(np.argwhere(sky)[0])
    data[outlier] = 1e6
    variance = np.full(shape, 4.)
    # Clipped background values must not contribute variance.
    variance[outlier] = np.nan
    if variance_case == "source_nan":
        variance[tuple(np.argwhere(weights > 0)[0])] = np.nan
    if variance_case == "background_zero":
        variance[tuple(np.argwhere(sky)[1])] = 0
    if variance_case == "irrelevant_nan":
        variance[15, 15] = np.nan
    quality = fits.ImageHDU(np.zeros(shape, dtype=np.int32), name="FLAGS")
    quality.header["MSKN0000"] = "OVERFLOW"
    hdus = [fits.PrimaryHDU(), fits.ImageHDU(data, header, name="IMAGE"), quality]
    if variance_case != "missing":
        hdus.append(fits.ImageHDU(variance[:2] if variance_case == "shape" else variance, name="VARIANCE"))
    stream = io.BytesIO()
    fits.HDUList(hdus).writeto(stream)
    point, reason = measure_exposure(stream.getvalue(), region)
    assert reason is None
    if variance_case in ("valid", "irrelevant_nan"):
        factor = (6.15 / 3600)**2 * (u.deg**2).to(u.sr) * 1e9
        expected = np.sqrt(4 * np.sum(weights**2) + weights.sum()**2 * 4 / (sky.sum() - 1)) * factor
        assert point["uncertaintyMjy"] == pytest.approx(expected)
    else:
        assert point["uncertaintyMjy"] is None

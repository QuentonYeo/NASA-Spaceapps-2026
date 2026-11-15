import io
import json

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from app.services.motion_photometry import measure_position


def measurement(x=15, invalid=False):
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ['RA---TAN', 'DEC--TAN']
    wcs.wcs.crval = [100, 20]
    wcs.wcs.crpix = [16, 16]
    wcs.wcs.cdelt = [-6.15 / 3600, 6.15 / 3600]
    header = wcs.to_header()
    header['BUNIT'] = 'MJy/sr'
    image = np.ones((31, 31))
    image[15, x] = 10
    if invalid:
        image[15, x + 1] = np.nan
    stream = io.BytesIO()
    fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(image, header, name='IMAGE')]).writeto(stream)
    position = wcs.pixel_to_world(x, 15)
    return measure_position(stream.getvalue(), position.ra.deg, position.dec.deg, 2.5)


def test_nan_pixel_is_excluded_without_poisoning_flux():
    result = measurement(invalid=True)
    assert result['fluxMjy'] == pytest.approx(measurement()['fluxMjy'])
    assert 0 < result['apertureCoverage'] < 1
    json.dumps(result, allow_nan=False)


def test_edge_coverage_counts_the_missing_aperture_area():
    result = measurement(x=0)
    assert .5 < result['apertureCoverage'] < .7
    assert result['status'] == 'partial'
    assert measurement()['apertureCoverage'] == pytest.approx(1)

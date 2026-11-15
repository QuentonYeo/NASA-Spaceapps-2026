import httpx

from app.domain.models import Region
from scripts.prepare_demos import query_demo_gaia


def test_recovered_science_rebuilds_the_displayed_native_grid():
    import io
    from types import SimpleNamespace
    import numpy as np
    from astropy.io import fits
    from app.domain.models import Exposure
    from app.services.jobs import Job
    from app.services.rendering import FitsRenderer, PIXEL_SCALE_DEG, query_grid
    from scripts.prepare_demos import match_science_preview

    region = Region(100, -20, 21 * PIXEL_SCALE_DEG)
    wcs, side = query_grid(region)
    header = wcs.to_header()
    header['BUNIT'] = 'MJy/sr'
    stream = io.BytesIO()
    fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(np.arange(side**2).reshape(side, side), header, name='IMAGE')]).writeto(stream)
    exposure = Exposure('frame', 'https://example.test/frame.fits', 60000, '', 'dr1', 'D6')
    old = {'id': 'frame', 'status': 'ready', 'grid': {'width': 29, 'height': 29}}
    job = Job('demo', region)
    result = match_science_preview(SimpleNamespace(renderer=FitsRenderer()), job, exposure, old, stream.getvalue())
    assert result['grid']['width'] == side
    assert result['alignedGrid']['width'] == side
    assert result['sciencePreviewMatched'] is True
    assert old['grid']['width'] == 29


def test_preparation_gaia_mirror_preserves_epoch_and_proper_motion_fields(monkeypatch):
    def unavailable(region):
        raise RuntimeError('ESA unavailable')

    monkeypatch.setattr('scripts.prepare_demos.query_gaia', unavailable)
    requests = []

    def mirror(url, *, params, timeout):
        requests.append(params)
        return httpx.Response(200, request=httpx.Request('GET', url), text=(
            '# Gaia DR3 ICRS epoch 2016.0\n'
            'Source\tRA_ICRS\tDE_ICRS\tpmRA\tpmDE\tGmag\n'
            ' \tdeg\tdeg\tmas/yr\tmas/yr\tmag\n'
            '------\t-------\t-------\t------\t------\t-----\n'
            '12345\t100.125\t-20.5\t12.25\t-8.75\t9.5\n'
            '67890\t100.25\t-20.75\t \t \t10.5\n'
        ))

    monkeypatch.setattr('scripts.prepare_demos.httpx.get', mirror)
    result = query_demo_gaia(Region(100, -20, .1))
    assert len(result['sources']) == 2
    assert result['sources'][0] == {'sourceId': '12345', 'ra': 100.125, 'dec': -20.5,
                                    'refEpoch': 2016.0, 'gMagnitude': 9.5,
                                    'pmRa': 12.25, 'pmDec': -8.75}
    assert result['sources'][1]['pmRa'] is None
    assert result['sources'][1]['pmDec'] is None
    assert result['provenance']['catalogue'] == 'Gaia DR3 I/355/gaiadr3'
    assert requests[0]['-source'] == 'I/355/gaiadr3'
    assert requests[0]['-sort'] == 'Gmag'

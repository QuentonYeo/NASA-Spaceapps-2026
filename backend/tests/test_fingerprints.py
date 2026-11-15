import io
import time
from threading import Event, RLock
from types import SimpleNamespace

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS
from fastapi.testclient import TestClient

from app.domain.models import Region
from app.main import create_app
from app.services.fingerprints import CubeCache, Fingerprints, fingerprint
from app.services.jobs import Job, LocalJobs
from app.services.native_regions import Aperture


def cube_file(path, bad=False):
    w = WCS(naxis=3)
    w.wcs.crpix = [16, 16, 1]
    w.wcs.crval = [60.8109955,51.3404038,.75]
    w.wcs.cdelt = [-4/3600,4/3600,.04]
    w.wcs.ctype = ['RA---TAN','DEC--TAN','WAVE']
    w.wcs.cunit = ['deg','deg','um']
    header=w.to_header(); header['BUNIT']='MJy/sr'; header['BLANKCH']='D3:17,D4:01'
    image=np.broadcast_to(np.arange(102,dtype=np.float32)[:,None,None]+1,(102,32,32)).copy()
    hits=np.ones(image.shape,dtype=np.int32)
    flags=np.full(image.shape,1<<21,dtype=np.int32)
    flags[:,15,15] |= 1<<2
    image[:,15,15] = 100000
    if bad:
        hits[:]=0
    image[[50,51]]=np.nan; hits[[50,51]]=0
    table=fits.BinTableHDU.from_columns([
        fits.Column(name='DETECTOR',format='I',array=np.repeat(np.arange(1,7),17)),
        fits.Column(name='SUBCHAN',format='I',array=np.tile(np.arange(1,18),6)),
        *[fits.Column(name=name,format='E',unit='um',array=np.linspace(.75,5,102)+offset)
          for name,offset in [('WAVELENGTH',0),('WL_MIN',-.01),('WL_MAX',.01)]]] ,name='SPECTRAL_CHANNELS')
    fh=fits.Header(); fh['MSKN0021']='SOURCE'; fh['MSKN0002']='SUR_ERROR'
    fits.HDUList([fits.PrimaryHDU(),fits.ImageHDU(image,header,name='IMAGE'),
        fits.ImageHDU(hits,name='NHITS'),fits.ImageHDU(flags,fh,name='FLAGS'),table]).writeto(path)
    native=WCS(naxis=2); native.wcs.crpix=[16,16]; native.wcs.crval=[60.8109955,51.3404038]
    native.wcs.cdelt=[-4/3600,4/3600]; native.wcs.ctype=['RA---TAN','DEC--TAN']
    out=io.BytesIO(); fits.HDUList([fits.PrimaryHDU(),fits.ImageHDU(np.ones((32,32)),native.to_header(),name='IMAGE')]).writeto(out)
    return out.getvalue()


class LocalCache:
    def __init__(self,path): self.path=path; self.lock=RLock(); self.calls=[]
    def get(self,tile,progress):
        assert tile==445
        self.calls.append(tile)
        return self.path,'https://irsa.ipac.caltech.edu/synthetic-fixture',True


def region():
    return Aperture(ra=60.8109955,dec=51.3404038,radiusArcsec=12,innerArcsec=24,outerArcsec=36)


def test_real_extraction_shapes_quality_and_missing_channels(tmp_path):
    path=tmp_path/'cube.fits'; cube_file(path)
    result=fingerprint(region(),LocalCache(path),lambda *args:None)
    assert len(result['channels'])==102
    assert result['usableChannels']==100
    assert [c['channel'] for c in result['channels'] if c['value'] is None]==[51,52]
    first=result['channels'][0]
    assert first['value']==pytest.approx(0, abs=1e-12) # Uniform background cancels; bad source pixel excluded.
    assert first['apertureFluxMjy'] == pytest.approx(first['backgroundFluxMjy'])
    assert first['backgroundMeanMJySr'] == pytest.approx(1)
    assert result['unit'] == 'mJy'
    assert first['pixels']>1
    assert first['coverage']<=1
    assert result['uncertaintyAvailable'] is False
    assert all(c['uncertainty'] is None for c in result['channels'])
    assert all(r['status']=='reference-only' for r in result['references'])


def test_no_coverage_is_null_not_zero(tmp_path):
    path=tmp_path/'empty.fits'; cube_file(path,bad=True)
    result=fingerprint(region(),LocalCache(path),lambda *args:None)
    assert result['usableChannels']==0
    assert all(c['value'] is None and c['reason'] for c in result['channels'])


def test_calibrated_column_units_and_channel_order(tmp_path):
    path = tmp_path / 'units.fits'
    cube_file(path)
    with fits.open(path, mode='update') as hdus:
        table = hdus['SPECTRAL_CHANNELS']
        table.data['WL_MIN'] *= 1000
        table.columns['WL_MIN'].unit = 'nm'
    result = fingerprint(region(), LocalCache(path), lambda *args: None)
    assert result['channels'][0]['minUm'] == pytest.approx(.74)
    with fits.open(path, mode='update') as hdus:
        hdus['SPECTRAL_CHANNELS'].data['SUBCHAN'][0] = 2
    with pytest.raises(ValueError, match='ordering'):
        fingerprint(region(), LocalCache(path), lambda *args: None)


def test_analysis_coalesces_requests_and_scopes_to_sequence():
    entered,release=Event(),Event(); calls=[]
    def worker(reg,cache,progress):
        calls.append(reg); entered.set(); release.wait(3)
        return {'channels': []}
    service=Fingerprints(worker=worker)
    try:
        first=service.start('one',region()); assert entered.wait(1)
        duplicate=service.start('one',region())
        assert first['analysisId']==duplicate['analysisId'] and len(calls)==1
        from app.domain.errors import AppError
        with pytest.raises(AppError): service.get(first['analysisId'],'different')
        release.set()
        for _ in range(100):
            if service.get(first['analysisId'],'one')['status']=='ready': break
            time.sleep(.01)
        assert service.get(first['analysisId'],'one')['status']=='ready'
        assert len(calls)==1
    finally:
        release.set(); service.close()


def test_failed_acquisition_retry(tmp_path):
    calls=[]
    def worker(*args):
        calls.append(1)
        if len(calls)==1: raise ValueError('Upstream unavailable')
        return {'channels': []}
    service=Fingerprints(worker=worker)
    try:
        key=service.start('one',region())['analysisId']
        for _ in range(100):
            if service.get(key,'one')['status']=='failed': break
            time.sleep(.01)
        assert 'Upstream unavailable' in service.get(key,'one')['error']
        service.start('one',region(),retry=True)
        for _ in range(100):
            if service.get(key,'one')['status']=='ready': break
            time.sleep(.01)
        assert service.get(key,'one')['status']=='ready' and len(calls)==2
    finally: service.close()


def test_fov_linked_api_and_region_scoping(tmp_path):
    path=tmp_path/'cube.fits'; native=cube_file(path)
    jobs=LocalJobs(); job=Job('fov',Region(60.8109955,51.3404038,.05)); job.science['frame/0']=native; jobs.add(job)
    service=Fingerprints(cache=LocalCache(path))
    try:
        with TestClient(create_app(SimpleNamespace(jobs=jobs),fingerprints=service)) as client:
            body={'referenceFrameId':'frame/0','circle':{'x':15,'y':15,'radiusPixels':3}}
            response=client.post('/api/frames/fov/fingerprints',json=body)
            assert response.status_code==202,response.text
            assert client.post('/api/frames/fov/spectra', json={}).status_code == 404
            accepted_region=response.json()['region']
            assert accepted_region['radiusArcsec'] > 0
            assert client.post('/api/frames/fov/frames/frame%2F0/projection', json=accepted_region).status_code == 200
            key=response.json()['analysisId']
            for _ in range(100):
                response=client.get(f'/api/frames/fov/fingerprints/{key}')
                if response.json()['status']!='loading': break
                time.sleep(.01)
            assert response.json()['status']=='ready',response.text
            assert response.json()['result']['region'] == accepted_region
            assert response.json()['result']['usableChannels']==100
            body['referenceFrameId']='unloaded'
            assert client.post('/api/frames/fov/fingerprints',json=body).status_code==409
            assert client.get(f'/api/frames/other/fingerprints/{key}').status_code==404
            assert len(service.cache.calls)==1 # No separate image acquisition.
    finally: jobs.close()


def test_remote_ranges_match_local_and_cache_without_full_download(tmp_path):
    import httpx
    from app.services.fingerprints import RangeFile, _patch
    path=tmp_path/'fixture.fits'; cube_file(path)
    payload=path.read_bytes(); requests=[]
    def respond(request):
        bounds=request.headers['range'].removeprefix('bytes=').split('-')
        start,end=map(int,bounds); requests.append((start,end))
        return httpx.Response(206,headers={'content-range':f'bytes {start}-{end}/{len(payload)}'},content=payload[start:end+1])
    cache=CubeCache(tmp_path/'ranges',client=httpx.Client(transport=httpx.MockTransport(respond)))
    # Metadata reads use a seekable remote stream; patch test uses production dimensions.
    with fits.open(path) as local:
        image=local['IMAGE'].data
        expanded=np.zeros((102,512,512),dtype=np.float32); expanded[:,:32,:32]=image
        local['IMAGE'].data=expanded
        for name in ('NHITS','FLAGS'):
            data=np.zeros((102,512,512),dtype=np.int32); data[:,:32,:32]=local[name].data
            local[name].data=data
        out=io.BytesIO(); local.writeto(out); payload=out.getvalue()
    try:
        for repeat in range(2):
            source=RangeFile(cache,445,lambda *args:None)
            with fits.open(source,memmap=False) as hdus:
                patch=_patch(hdus,'IMAGE',slice(None),14,19,14,19)
                assert np.array_equal(patch,image[:,14:19,14:19],equal_nan=True)
            if repeat==0: count=len(requests)
        assert len(requests)==count
        assert sum(end-start+1 for start,end in requests)<2_000_000
    finally: cache.close()


def test_range_rejects_full_response_and_missing_tile(tmp_path):
    import httpx
    from app.domain.errors import AppError
    from app.services.fingerprints import RangeFile
    for status, message in [(200,'honor'),(206,'honor'),(404,'not available')]:
        cache=CubeCache(tmp_path,client=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(status,content=b'wrong'))))
        try:
            with pytest.raises(AppError,match=message): RangeFile(cache,445,lambda *args:None).read_at(0,2880)
            assert not list(tmp_path.glob('*.range'))
        finally: cache.close()


def test_finished_analysis_expires_on_read():
    from app.domain.errors import AppError
    service = Fingerprints(worker=lambda *args: {'channels': []})
    try:
        key = service.start('one', region())['analysisId']
        for _ in range(100):
            if service.get(key, 'one')['status'] == 'ready': break
            time.sleep(.01)
        service.items[key]['updated'] = time.monotonic() - 1801
        with pytest.raises(AppError, match='expired'):
            service.get(key, 'one')
    finally: service.close()


def test_matches_tutorial_photutils_flux_with_fractional_pixels_clipping_and_negative_flux(tmp_path):
    from astropy import units as u
    from astropy.coordinates import SkyCoord
    from astropy.stats import SigmaClip
    from photutils.aperture import ApertureStats, CircularAperture, CircularAnnulus, aperture_photometry
    path=tmp_path/'tutorial.fits'; cube_file(path)
    with fits.open(path, mode='update') as hdus:
        wcs=WCS(hdus['IMAGE'].header, fobj=hdus).celestial
        coord=wcs.pixel_to_world(15.27,14.63)
        x,y=wcs.world_to_pixel(coord)
        c0,c1,c2=wcs.pixel_to_world([x,x+1,x],[y,y,y+1])
        a,b=c0.spherical_offsets_to(c1); c,d=c0.spherical_offsets_to(c2)
        solid_angle=abs(a*d-c*b).to_value(u.sr)
        scale=np.sqrt(abs(a*d-c*b)).to_value(u.arcsec)
        reg=Aperture(ra=coord.ra.deg,dec=coord.dec.deg,radiusArcsec=2.35*scale,innerArcsec=5.2*scale,outerArcsec=9.7*scale)
        yy,xx=np.indices((32,32))
        profile=np.exp(-((xx-x)**2+(yy-y)**2)/2)
        for channel in range(102):
            hdus['IMAGE'].data[channel]=10+.01*xx+.003*yy+(channel+1)*profile*(1 if channel%2==0 else -1)
            hdus['IMAGE'].data[channel,15,23]=1e6 # Unflagged background outlier must be clipped.
        hdus['IMAGE'].data[[50,51]]=np.nan
        hdus['FLAGS'].data[:]=0
    result=fingerprint(reg,LocalCache(path),lambda *args:None)
    aperture=CircularAperture((x,y),r=2.35)
    annulus=CircularAnnulus((x,y),r_in=5.2,r_out=9.7)
    with fits.open(path) as hdus:
        for i,channel in enumerate(result['channels']):
            if i in (50,51):
                assert channel['value'] is None
                continue
            image=hdus['IMAGE'].data[i]
            background=ApertureStats(image,annulus,sigma_clip=SigmaClip(sigma=3,maxiters=10)).mean
            total=aperture_photometry(image,aperture)['aperture_sum'][0]
            expected=(total-background*aperture.area_overlap(image))*solid_angle*1e9
            assert channel['value']==pytest.approx(expected,rel=1e-8,abs=1e-10)
            assert channel['backgroundMeanMJySr']==pytest.approx(background,rel=1e-8)
            assert channel['apertureAreaPixels']==pytest.approx(np.pi*2.35**2,rel=1e-8)
    assert result['channels'][1]['value'] < 0


def test_missing_background_is_unavailable_not_an_unsubtracted_source(tmp_path):
    path=tmp_path/'no-background.fits'; cube_file(path)
    with fits.open(path, mode='update') as hdus:
        yy,xx=np.indices((32,32))
        hdus['NHITS'].data[:,np.hypot(xx-15,yy-15)>4]=0
    result=fingerprint(region(),LocalCache(path),lambda *args:None)
    assert result['channels'][0]['pixels'] > 0
    assert result['channels'][0]['backgroundPixels'] == 0
    assert result['channels'][0]['value'] is None
    assert 'background annulus' in result['channels'][0]['reason']


def test_rejects_millijansky_surface_brightness_as_megajansky(tmp_path):
    path=tmp_path/'wrong-unit.fits'; cube_file(path)
    with fits.open(path,mode='update') as hdus:
        hdus['IMAGE'].header['BUNIT']='mJy/sr'
    with pytest.raises(ValueError,match='brightness units'):
        fingerprint(region(),LocalCache(path),lambda *args:None)


def test_annulus_and_fractional_aperture_are_not_double_counted_across_tile_seam(tmp_path):
    from astropy import units as u
    from astropy.coordinates import ICRS
    from astropy_healpix import HEALPix
    from photutils.aperture import ApertureStats, CircularAperture, CircularAnnulus, aperture_photometry
    from astropy.stats import SigmaClip
    hp=HEALPix(nside=32,order='nested',frame=ICRS())
    vertices=hp.boundaries_skycoord([445],step=1)[0]
    first,second=vertices[0],vertices[1]
    center=first.directional_offset_by(first.position_angle(second),first.separation(second)/2)
    reg=Aperture(ra=center.ra.deg,dec=center.dec.deg,radiusArcsec=12,innerArcsec=24,outerArcsec=36)
    path=tmp_path/'seam.fits'; cube_file(path)
    with fits.open(path,mode='update') as hdus:
        hdus['IMAGE'].header['CRVAL1']=reg.ra; hdus['IMAGE'].header['CRVAL2']=reg.dec
        yy,xx=np.indices((32,32))
        hdus['IMAGE'].data[:]=5+np.exp(-((xx-15.3)**2+(yy-15.1)**2)/2)*3
        hdus['IMAGE'].data[[50,51]]=np.nan
        hdus['FLAGS'].data[:]=0
    class SeamCache:
        def get(self,tile,progress): return path,f'synthetic:{tile}',True
    result=fingerprint(reg,SeamCache(),lambda *args:None)
    assert len(result['provenance'])==2
    with fits.open(path) as hdus:
        wcs=WCS(hdus['IMAGE'].header,fobj=hdus).celestial
        x,y=wcs.world_to_pixel(center)
        # The two files intentionally repeat a common grid at a HEALPix seam.
        # Only one owner per native pixel may contribute to the measurement.
        scale=4.0
        aperture=CircularAperture((x,y),r=reg.radiusArcsec/scale)
        annulus=CircularAnnulus((x,y),r_in=reg.innerArcsec/scale,r_out=reg.outerArcsec/scale)
        image=hdus['IMAGE'].data[0]
        bkg=ApertureStats(image,annulus,sigma_clip=SigmaClip(sigma=3,maxiters=10)).mean
        expected=(aperture_photometry(image,aperture)['aperture_sum'][0]-bkg*aperture.area_overlap(image))*(scale**2)*(u.arcsec**2).to(u.sr)*1e9
    assert result['channels'][0]['value']==pytest.approx(expected,rel=1e-6)
    assert result['channels'][0]['coverage']==pytest.approx(1,abs=1e-6)

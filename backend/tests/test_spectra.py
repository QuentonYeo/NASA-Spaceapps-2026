import io
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS
from app.services.spectra import Aperture, extract


def science(offset=0, flagged=False, spectral=True):
    w=WCS(naxis=2)
    w.wcs.crpix=[21+offset,21];w.wcs.crval=[359.999,-7]
    w.wcs.cdelt=[-1/3600,1/3600];w.wcs.ctype=['RA---TAN','DEC--TAN']
    h=w.to_header();h['BUNIT']='MJy/sr'
    if spectral:
        for axis,value in ((1,2.),(2,.1)):
            for key,val in [('CTYPE','WAVE'),('CUNIT','um'),('CRPIX',1),('CRVAL',value),('CDELT',.001)]:
                h[f'{key}{axis}W']=val
    yy,xx=np.indices((41,41));source=(xx-20-offset)**2+(yy-20)**2<=16
    image=np.full((41,41),12.);image[source]+=5
    hdus=fits.HDUList([fits.PrimaryHDU(),fits.ImageHDU(image,h,name='IMAGE'),
        fits.ImageHDU(np.full(image.shape,int(flagged),dtype=np.int32),name='FLAGS'),
        fits.ImageHDU(np.full(image.shape,4.),name='VARIANCE'),fits.ImageHDU(np.full(image.shape,2.),name='ZODI')])
    out=io.BytesIO();hdus.writeto(out);return out.getvalue()


def region(**changes):
    return Aperture(**(dict(ra=359.999,dec=-7,radiusArcsec=4.1,innerArcsec=8,outerArcsec=12)|changes))


def test_native_measurement():
    r=extract(science(),region())
    assert r['status'] in {'ok','partial'}
    assert r['value']==pytest.approx(5)
    assert r['uncertainty']==pytest.approx(np.sqrt(4/r['sourcePixels']+4/r['backgroundPixels']))
    shifted=extract(science(offset=5),region())
    assert shifted['value']==pytest.approx(r['value'])
    assert shifted['wavelengthUm']>r['wavelengthUm']


def test_missing_data_not_fabricated():
    for data,aperture in [(science(flagged=True),region()),(science(),region(ra=180)),(science(spectral=False),region())]:
        r=extract(data,aperture)
        assert r['status']=='unavailable' and r['value'] is None


def test_validation():
    with pytest.raises(ValueError):region(innerArcsec=2)


def test_s3_preserves_science_and_alternate_wcs():
    from app.services.irsa.s3_cutouts import S3Cutouts
    from app.domain.models import Exposure, Region
    from app.services.spectra import wavelength_at
    data=science()
    with fits.open(io.BytesIO(data)) as hdus:
        hdus[0].header['VERSION']='test-pipeline'
        hdus.append(fits.BinTableHDU.from_columns([fits.Column(name='dummy',format='D',array=[1.])],name='WCS-WAVE'))
        stream=io.BytesIO();hdus.writeto(stream);data=stream.getvalue()
    class FS:
        def open(self,*args):return io.BytesIO(data)
    exposure=Exposure('test','https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/test.fits',60000,'date','dr1','D1')
    result=S3Cutouts(filesystem=FS()).fetch(exposure,Region(359.999,-7,10/3600))
    with fits.open(io.BytesIO(result)) as cropped, fits.open(io.BytesIO(data)) as original:
        assert all(name in cropped for name in ('IMAGE','FLAGS','VARIANCE','ZODI','WCS-WAVE'))
        assert cropped[0].header['VERSION']=='test-pipeline'
        assert cropped['IMAGE'].data.shape==(10,10)
        x,y=WCS(cropped['IMAGE'].header).celestial.world_to_pixel_values(359.999,-7)
        ox,oy=WCS(original['IMAGE'].header).celestial.world_to_pixel_values(359.999,-7)
        assert wavelength_at(cropped,x,y)==pytest.approx(wavelength_at(original,ox,oy))
        assert cropped['IMAGE'].header['BUNIT']=='MJy/sr'


def test_sequence_cache_group_reuse_and_scoping(monkeypatch):
    import hashlib
    from app.services.jobs import Job
    from app.domain.models import Region, Exposure
    from app.services import spectra
    data=science()
    job=Job('sequence-one',Region(359.999,-7,.01))
    for i,group in enumerate((0,1)):
        name=f'archive/frame/{i}'
        job.exposures.append((Exposure(name,'https://archive/test',60000+i,'2026-01-01','dr1','D1'),group))
        job.results.append(dict(id=name,visit=group,observedAtUtc='2026-01-01',sourceFitsUrl='https://archive/test'))
        job.science[name]=data;job.science_versions[name]=hashlib.sha256(data).hexdigest()
    calls=[]
    original=spectra.extract
    def recording(*args):
        calls.append(1);return original(*args)
    monkeypatch.setattr(spectra,'extract',recording)
    query=spectra.SpectrumQuery(sequenceId=job.id,referenceFrameId='archive/frame/0',
        circle=dict(x=20,y=20,radiusPixels=4.1,innerRadiusPixels=8,outerRadiusPixels=12),observationGroupIds=[0,1])
    first=spectra.sequence_spectrum(job,query)
    assert len(first['samples'])==2 and len(calls)==2 and first['pendingFrames']==0
    again=spectra.sequence_spectrum(job,query.model_copy(update={'observationGroupIds':[1]}))
    assert again['cacheHits']==1 and len(calls)==2
    assert again['processingVersion']==spectra.PROCESSING_VERSION
    assert again['region']['ra']==pytest.approx(359.999)
    changed=query.model_copy(update={'circle':spectra.NativeCircle(x=19,y=20,radiusPixels=4.1)})
    spectra.sequence_spectrum(job,changed)
    assert len(calls)==4
    from app.domain.errors import AppError
    for bad in [query.model_copy(update={'sequenceId':'other'}),query.model_copy(update={'referenceFrameId':'other'}),query.model_copy(update={'observationGroupIds':[99]})]:
        with pytest.raises(AppError):spectra.sequence_spectrum(job,bad)


def test_api_contract_and_slash_frame_ids():
    from types import SimpleNamespace
    from fastapi.testclient import TestClient
    from app.main import create_app
    from app.services.jobs import Job, LocalJobs
    from app.domain.models import Region, Exposure
    jobs=LocalJobs()
    job=Job('sequence',Region(359.999,-7,.01))
    name='archive/frame/0'
    job.science[name]=science()
    job.exposures=[(Exposure(name,'https://archive/test',60000,'2026-01-01','dr1','D1'),0)]
    job.results=[dict(id=name,visit=0,observedAtUtc='2026-01-01',sourceFitsUrl='https://archive/test')]
    jobs.add(job)
    try:
        with TestClient(create_app(SimpleNamespace(jobs=jobs))) as client:
            payload=dict(sequenceId='sequence',referenceFrameId=name,circle=dict(x=20,y=20,radiusPixels=4.1),observationGroupIds=[0])
            response=client.post('/api/frames/sequence/spectra',json=payload)
            assert response.status_code==200,response.text
            result=response.json()
            assert result['circle']['innerRadiusPixels']==8.2
            assert len(result['samples'][0]['wavelengthRangeUm'])==2
            assert client.post('/api/frames/sequence/frames/archive%2Fframe%2F0/coordinate',json={'x':20,'y':20}).status_code==200
            assert client.post('/api/frames/sequence/frames/archive%2Fframe%2F0/projection',json=result['region']).status_code==200
            assert client.post('/api/frames/missing/spectra',json=payload).status_code==404
            payload['sequenceId']='different'
            assert client.post('/api/frames/sequence/spectra',json=payload).status_code==422
    finally:jobs.close()


def test_real_tabular_wavelength_survives_s3_crop():
    from app.services.irsa.s3_cutouts import S3Cutouts
    from app.domain.models import Exposure, Region
    from app.services.spectra import wavelength_at
    with fits.open(io.BytesIO(science())) as hdus:
        table=np.array([(np.linspace(2,3,41),np.linspace(.1,.2,41))],dtype=[('WAVE',float,(41,)),('BAND',float,(41,))])
        hdus.append(fits.BinTableHDU(table,name='WCS-WAVE'))
        header=hdus['IMAGE'].header
        for axis,column in ((1,'WAVE'),(2,'BAND')):
            header[f'CTYPE{axis}W']='WAVE-TAB'
            header[f'CRVAL{axis}W']=1
            header[f'CDELT{axis}W']=1
            header[f'PS{axis}_0W']='WCS-WAVE'
            header[f'PS{axis}_1W']=column
            header[f'PV{axis}_1W']=1
        output=io.BytesIO();hdus.writeto(output);data=output.getvalue()
        expected=wavelength_at(hdus,20.,20.)
        assert expected==pytest.approx((2.5,.15))
    class FS:
        def open(self,*args):return io.BytesIO(data)
    frame=Exposure('test','https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/test.fits',60000,'date','dr1','D1')
    cropped=S3Cutouts(filesystem=FS()).fetch(frame,Region(359.999,-7,10/3600))
    with fits.open(io.BytesIO(cropped)) as hdus:
        x,y=WCS(hdus['IMAGE'].header).celestial.world_to_pixel_values(359.999,-7)
        assert wavelength_at(hdus,x,y)==pytest.approx(expected)
    measurement=extract(data,region())
    assert measurement['wavelengthUm']==pytest.approx(2.5)


def test_progressive_downloads_only_extract_new_samples(monkeypatch):
    from app.services.jobs import Job
    from app.domain.models import Region, Exposure
    from app.services import spectra
    job=Job('progressive',Region(359.999,-7,.01))
    exposure=lambda name:Exposure(name,'https://archive/test',60000,'2026-01-01','dr1','D1')
    job.exposures=[(exposure('a'),0),(exposure('b'),0)]
    frame=lambda name:dict(id=name,visit=0,observedAtUtc='2026-01-01',sourceFitsUrl='https://archive/test')
    job.results=[frame('a')];job.science['a']=science();job.science_versions['a']='version1'
    query=spectra.SpectrumQuery(referenceFrameId='a',circle=dict(x=20,y=20,radiusPixels=4),observationGroupIds=[0])
    calls=[];original=spectra.extract
    def recording(*args):calls.append(1);return original(*args)
    monkeypatch.setattr(spectra,'extract',recording)
    first=spectra.sequence_spectrum(job,query)
    assert first['pendingFrames']==1 and len(calls)==1
    job.results.append(frame('b'));job.science['b']=science();job.science_versions['b']='version1'
    second=spectra.sequence_spectrum(job,query)
    assert second['pendingFrames']==0 and second['cacheHits']==1 and len(calls)==2
    job.science_versions['b']='version2'
    third=spectra.sequence_spectrum(job,query)
    assert third['cacheHits']==1 and len(calls)==3
    monkeypatch.setattr(spectra,'PROCESSING_VERSION','changed-processing')
    fourth=spectra.sequence_spectrum(job,query)
    assert fourth['cacheHits']==0 and len(calls)==5


def test_aligned_display_keeps_native_science_and_spectrum_reference():
    from app.domain.models import Exposure, Region
    from app.services.frames import FramesService
    from app.services.jobs import Job, LocalJobs
    from app.services.rendering import FitsRenderer
    from app.services.spectra import SpectrumQuery, sequence_spectrum
    data=science()
    class Cutouts:
        def fetch(self,*args):return data
    jobs=LocalJobs()
    try:
        service=FramesService(None,Cutouts(),FitsRenderer(),jobs)
        job=Job('native-and-aligned',Region(359.999,-7,.01))
        exposure=Exposure('native','https://archive/test',60000,'2026-01-01','dr1','D1')
        job.exposures=[(exposure,0)]
        frame=service._frame(job,exposure,0)
        job.results=[frame]
        assert frame['status']=='ready'
        assert frame['scienceStatus']=='retained'
        assert job.science['native']==data
        assert frame['grid']==dict(width=41,height=41,orientation='native')
        assert frame['alignedGrid']['orientation']=='north-up'
        assert frame['alignedGrid']['width']!=41
        assert frame['alignedImageData'] and frame['sharedImageData']
        query=SpectrumQuery(referenceFrameId='native',circle=dict(x=20,y=20,radiusPixels=4.1,innerRadiusPixels=8,outerRadiusPixels=12),observationGroupIds=[0])
        result=sequence_spectrum(job,query)
        assert result['samples'][0]['value']==pytest.approx(5)
        assert result['region']['ra']==pytest.approx(359.999)
        # Rendering/navigation is display work; measurement and reference stay native.
        service.renderer.preview(service.renderer.prepare(data,job.region))
        assert sequence_spectrum(job,query)['cacheHits']==1
        assert job.science['native']==data
    finally:jobs.close()

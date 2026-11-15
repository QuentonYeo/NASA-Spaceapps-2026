import io
import numpy as np
import pytest
from astropy import units as u
from astropy.io import fits
from astropy.wcs import WCS
from app.services.native_regions import compact_science
from app.services.wcs import spectral_wcs


def wavelength_at(hdus, x, y):
    return tuple(value.to_value(u.um) for value in spectral_wcs(hdus).pixel_to_world(x, y))


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


def test_compact_science_removes_only_unused_psf_tables():
    data = science()
    with fits.open(io.BytesIO(data)) as hdus:
        hdus['FLAGS'].header['MSKN0021'] = 'SOURCE'
        hdus.append(fits.ImageHDU(np.ones((100, 100)), name='EPSF'))
        stream = io.BytesIO(); hdus.writeto(stream)
    compact = compact_science(stream.getvalue())
    assert len(compact) < len(stream.getvalue())
    with fits.open(io.BytesIO(compact)) as hdus:
        assert 'EPSF' not in hdus
        assert hdus['FLAGS'].header['MSKN0021'] == 'SOURCE'
        assert all(name in hdus for name in ('IMAGE', 'FLAGS', 'VARIANCE', 'ZODI'))
    with fits.open(io.BytesIO(data)) as original, fits.open(io.BytesIO(compact)) as retained:
        for name in ('IMAGE','FLAGS','VARIANCE','ZODI'):
            np.testing.assert_array_equal(retained[name].data, original[name].data)


def test_s3_preserves_science_and_alternate_wcs():
    from app.services.irsa.s3_cutouts import S3Cutouts
    from app.domain.models import Exposure, Region
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


def test_real_tabular_wavelength_survives_s3_crop():
    from app.services.irsa.s3_cutouts import S3Cutouts
    from app.domain.models import Exposure, Region
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


def test_spectral_wcs_excludes_sky_sip_before_construction(caplog):
    import logging
    from app.services.wcs import spectral_wcs
    with fits.open(io.BytesIO(science())) as hdus:
        header=hdus['IMAGE'].header
        for axis in (1,2): header[f'CTYPE{axis}'] += '-SIP'
        for key in ('A_ORDER','B_ORDER','AP_ORDER','BP_ORDER'): header[key]=2
        header['A_2_0']=.01; header['B_0_2']=.02
        header['AP_2_0']=-.01; header['BP_0_2']=-.02
        original=header.copy()
        with caplog.at_level(logging.INFO,logger='astropy'):
            spectral=spectral_wcs(hdus)
            wave,band=wavelength_at(hdus,25,23)
        assert spectral.sip is None
        assert wave==pytest.approx(2.025) and band==pytest.approx(.123)
        assert 'Inconsistent SIP' not in caplog.text
        assert header==original
        celestial=WCS(header).celestial
        assert celestial.sip is not None
        with fits.open(io.BytesIO(science())) as plain:
            linear=WCS(plain['IMAGE'].header).celestial
        assert not np.allclose(celestial.pixel_to_world_values(30,30),linear.pixel_to_world_values(30,30),rtol=0,atol=1e-6)

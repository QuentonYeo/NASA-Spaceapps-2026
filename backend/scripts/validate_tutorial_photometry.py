"""Offline comparison with the IRSA tutorial at its sample position and 5/40/60 pixel radii.

Run from backend: python -m scripts.validate_tutorial_photometry path/to/Npix445_cube.fits
Reads only the supplied local file and prints a comparison summary; never downloads.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.stats import SigmaClip
from astropy.wcs import WCS
from photutils.aperture import ApertureStats, CircularAperture, CircularAnnulus, aperture_photometry

from app.schemas.fingerprints import FingerprintResult
from app.services.fingerprints import BASE_URL, fingerprint
from app.services.native_regions import Aperture


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cube', type=Path, help='Local order-5 Npix445 FITS cube used by the IRSA tutorial')
    path=parser.parse_args().cube.resolve(strict=True)
    center=SkyCoord(60.8109955,51.3404038,unit='deg')
    with fits.open(path,memmap=True) as hdus:
        wcs=WCS(hdus['IMAGE'].header,fobj=hdus).celestial
        x,y=wcs.world_to_pixel(center)
        points=wcs.pixel_to_world([x,x+1,x],[y,y,y+1])
        a,b=points[0].spherical_offsets_to(points[1]); c,d=points[0].spherical_offsets_to(points[2])
        pixel_area=abs(a*d-c*b)
        scale=np.sqrt(pixel_area).to_value(u.arcsec)
        factor=pixel_area.to_value(u.sr)*1e9
        region=Aperture(ra=center.ra.deg,dec=center.dec.deg,radiusArcsec=5*scale,innerArcsec=40*scale,outerArcsec=60*scale)
        aperture=CircularAperture((x,y),r=5)
        annulus=CircularAnnulus((x,y),r_in=40,r_out=60)
        allowed=sum(1 << int(k[4:]) for k in hdus['FLAGS'].header if k.startswith('MSKN') and hdus['FLAGS'].header[k] in {'SOURCE','FULLSAMPLE'})
        expected=[]; unmasked=[]
        for i in range(102):
            if i in (50,51):
                expected.append(None); unmasked.append(None); continue
            image=hdus['IMAGE'].data[i]
            invalid=~(np.isfinite(image)&(hdus['NHITS'].data[i]>0)&((hdus['FLAGS'].data[i]&~allowed)==0))
            background=ApertureStats(image,annulus,mask=invalid,sigma_clip=SigmaClip(sigma=3,maxiters=10)).mean
            total=aperture_photometry(image,aperture,mask=invalid)['aperture_sum'][0]
            expected.append(float((total-background*aperture.area_overlap(image,mask=invalid))*factor))
            plain_background=ApertureStats(image,annulus,sigma_clip=SigmaClip(sigma=3,maxiters=10)).mean
            plain_sum=aperture_photometry(image,aperture)['aperture_sum'][0]
            unmasked.append(float((plain_sum-plain_background*aperture.area_overlap(image))*factor))

    class Cache:
        def get(self,tile,progress):
            if tile!=445: raise AssertionError(f'Unexpected offline tile {tile}')
            return path,f'{BASE_URL}/Dir0/Npix445_cube.fits',True

    result=fingerprint(region,Cache(),lambda *args:None)
    FingerprintResult.model_validate(result)
    actual=[c['value'] for c in result['channels']]
    comparisons=[(a,b) for a,b in zip(actual,expected) if a is not None and b is not None]
    assert len(comparisons)==100
    assert all((a is None)==(b is None) for a,b in zip(actual,expected))
    if not np.allclose(*np.array(comparisons).T,rtol=1e-8,atol=1e-8):
        print('Largest differences:', sorted([(abs(a-b),i+1,a,b,result['channels'][i]['backgroundMeanMJySr']) for i,(a,b) in enumerate(zip(actual,expected)) if a is not None and b is not None],reverse=True)[:5])
        raise AssertionError('Tutorial reference mismatch')
    print(json.dumps(dict(processingVersion=result['processingVersion'], unit=result['unit'],
        comparedChannels=len(comparisons), networkRequests=0,
        maxAbsoluteDifferenceMjy=max(abs(a-b) for a,b in comparisons),
        maxDifferenceFromUnmaskedTutorialMjy=max(abs(a-b) for a,b in zip(actual,unmasked) if a is not None and b is not None)), indent=2))

if __name__=='__main__': main()

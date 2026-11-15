"""Stationary-location quick-look fingerprints from official DR1 FITS cubes."""
import hashlib
import io
import json
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import RLock

import httpx
import numpy as np
from astropy import units as u
from astropy.stats import SigmaClip
from photutils.aperture import CircularAperture, CircularAnnulus
from astropy.coordinates import ICRS, SkyCoord
from astropy.io import fits
from astropy.wcs import WCS
from astropy_healpix import HEALPix

from app.domain.errors import AppError
from app.services.native_regions import Aperture
from app.services.irsa.retries import read_with_retries

RELEASE = "dr1-hips_20261026"
BASE_URL = "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/hips5_cube/hips_20261026/Norder5"
PROCESSING_VERSION = "tutorial-aperture-mjy-v1"
PIXEL_ARCSEC = 12.9
REFERENCES = [
    {"name": "Hydrogen Pa-alpha", "wavelengthUm": 1.875},
    {"name": "Hydrogen Br-gamma", "wavelengthUm": 2.166},
    {"name": "Water ice", "wavelengthUm": 3.05, "sourceUrl": "https://doi.org/10.1088/0004-637X/773/1/30"},
    {"name": "CO2 ice", "wavelengthUm": 4.27, "sourceUrl": "https://doi.org/10.1051/0004-6361/202451505"},
    {"name": "PAH band", "wavelengthUm": 3.30},
    {"name": "Hydrogen Br-alpha", "wavelengthUm": 4.052},
    {"name": "CO band", "wavelengthUm": 4.67},
]
REFERENCE_URL = "https://caltech-ipac.github.io/irsa-tutorials/spherex-hipscube/"


class RangeFile(io.RawIOBase):
    """Seekable FITS metadata reader; data patches use independent read_at calls."""
    def __init__(self, cache, tile, progress):
        self.cache, self.tile, self.progress = cache, tile, progress
        self.position = 0
        self.size_path = cache.directory / f"{RELEASE}-{tile}.size"
        self.size = int(self.size_path.read_text()) if self.size_path.exists() else None
        self.hit = True
        self.url = f"{BASE_URL}/Dir{tile//10000*10000}/Npix{tile}_cube.fits"
        self.received = 0
        self.end = time.monotonic() + 120

    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.position
    def seek(self, offset, whence=0):
        if whence == 2:
            if self.size is None: self.read_at(0,2880)
            self.position = self.size + offset
            return self.position
        self.position = offset if whence == 0 else self.position + offset
        return self.position

    def read(self, size=-1):
        if size < 0:
            raise io.UnsupportedOperation("Full cube reads are disabled")
        if self.size is not None:
            size = max(0,min(size,self.size-self.position))
        data = self.read_at(self.position, size)
        self.position += len(data)
        return data

    def read_at(self, start, size):
        if size == 0: return b""
        if size > 2 * 1024**2:
            raise ValueError("Cube range exceeds the 2 MiB request limit")
        key = self.cache.directory / f"{RELEASE}-{self.tile}-{start}-{size}.range"
        with self.cache.lock:
            if self.size is not None and key.exists():
                data = key.read_bytes()
                if len(data) == size:
                    key.touch()
                    return data
                key.unlink()
        self.hit = False
        def fetch(remaining):
            if time.monotonic() >= self.end:
                raise AppError("ARCHIVE_TIMEOUT", "Cube patch retrieval timed out.", 504, True)
            with self.cache.client.stream("GET", self.url, headers={"Range": f"bytes={start}-{start+size-1}"},
                                          timeout=min(25, remaining, max(.1, self.end-time.monotonic()))) as response:
                if response.status_code == 404:
                    raise AppError("CUBE_TILE_MISSING", f"Cube tile {self.tile} is not available in this release.", 404)
                response.raise_for_status()
                expected = f"bytes {start}-{start+size-1}/"
                if response.status_code != 206 or not response.headers.get("content-range", "").startswith(expected):
                    raise AppError("CUBE_RANGE_UNSUPPORTED", "Archive did not honor a bounded cube range request.", 502)
                total = int(response.headers["content-range"].split("/")[1])
                if self.size is not None and self.size != total:
                    raise ValueError("Cube size changed within an immutable release")
                self.size = total
                chunks, received = [], 0
                for chunk in response.iter_bytes(64*1024):
                    received += len(chunk)
                    if received > size:
                        raise ValueError("Archive returned more bytes than requested")
                    chunks.append(chunk)
                if received != size: raise httpx.ReadError("Incomplete cube range")
                return b"".join(chunks)
        data = read_with_retries(fetch, deadline=max(.1, self.end-time.monotonic()))
        with self.cache.lock:
            self.cache.directory.mkdir(parents=True, exist_ok=True)
            self.size_path.write_text(str(self.size))
            files = sorted(self.cache.directory.glob("*.range"), key=lambda p: p.stat().st_mtime)
            current = sum(p.stat().st_size for p in files)
            for old in files:
                if current + size <= self.cache.budget: break
                current -= old.stat().st_size
                old.unlink()
            if size <= self.cache.budget:
                temporary = key.with_suffix(".part")
                temporary.write_bytes(data)
                temporary.replace(key)
            self.received += size
            self.progress(f"Reading cube patch from tile {self.tile}", self.received, None)
        return data


class CubeCache:
    """Bounded persistent range cache; existing complete tiles are still reusable."""
    def __init__(self, directory=None, budget=1024**3, client=None):
        self.directory = Path(directory or os.getenv("SPHEREX_CUBE_CACHE", Path(__file__).resolve().parents[2] / ".cache" / "spherex-cubes"))
        self.budget, self.lock = budget, RLock()
        self.client = client or httpx.Client(limits=httpx.Limits(max_connections=12), follow_redirects=False)

    def close(self): self.client.close()

    def get(self, tile, progress):
        path = self.directory / f"{RELEASE}-Npix{tile}.fits"
        url = f"{BASE_URL}/Dir{tile//10000*10000}/Npix{tile}_cube.fits"
        if path.exists(): return path, url, True
        return RangeFile(self, tile, progress), url, False


def _patch(hdus, name, channels, y0, y1, x0, x1):
    hdu = hdus[name]
    source = hdus._file._file
    if not isinstance(source, RangeFile):
        return np.array(hdu.section[channels, y0:y1, x0:x1], copy=True)
    if hdu.shape != (102, 512, 512) or hdu.header['BITPIX'] not in (-32, 32):
        raise ValueError("Unsupported remote cube layout")
    dtype = np.dtype('>f4' if hdu.header['BITPIX'] == -32 else '>i4')
    offset = hdu.fileinfo()['datLoc']
    indices = list(range(102))[channels] if isinstance(channels, slice) else [channels]
    def read(channel):
        # One contiguous row strip per channel, rather than one request per row.
        data = source.read_at(offset + (channel*512*512+y0*512)*4, (y1-y0)*512*4)
        raw = np.frombuffer(data, dtype=dtype).reshape(y1-y0,512)[:,x0:x1].copy()
        scale, zero = hdu.header.get('BSCALE',1), hdu.header.get('BZERO',0)
        if zero == 2**31 and scale == 1 and dtype.kind == 'i':
            raw = (raw.astype(np.int64)+zero).astype(np.uint32)
        elif scale != 1 or zero != 0:
            raw = raw.astype(np.float64)*scale+zero
        if 'BLANK' in hdu.header:
            mask = np.frombuffer(data,dtype=dtype).reshape(y1-y0,512)[:,x0:x1] == hdu.header['BLANK']
            raw = raw.astype(float); raw[mask] = np.nan
        return raw
    with ThreadPoolExecutor(max_workers=12) as pool:
        result = np.stack(list(pool.map(read,indices)))
    return result if isinstance(channels,slice) else result[0]


def _blank_indices(hdus):
    text = str(hdus[0].header.get("BLANKCH", hdus["IMAGE"].header.get("BLANKCH", "D3:17,D4:01")))
    result = set()
    for item in text.split(","):
        detector, channel = item.strip().removeprefix("D").split(":")
        result.add((int(detector)-1)*17+int(channel)-1)
    return result


def _valid(hdus, values, hits, flags):
    allowed = sum(1 << int(key[4:]) for key in hdus["FLAGS"].header
                  if key.startswith("MSKN") and hdus["FLAGS"].header[key] in {"SOURCE", "FULLSAMPLE"})
    return np.isfinite(values) & (hits > 0) & ((flags & ~allowed) == 0)


def _aperture_geometry(wcs, shape, region):
    """Tutorial geometry: pixel-plane circles scaled by local sky solid angle."""
    center = SkyCoord(region.ra, region.dec, unit="deg")
    cx, cy = map(float, wcs.world_to_pixel(center))
    sample = wcs.pixel_to_world([cx, cx+1, cx], [cy, cy, cy+1])
    east1, north1 = sample[0].spherical_offsets_to(sample[1])
    east2, north2 = sample[0].spherical_offsets_to(sample[2])
    area_arcsec2 = abs((east1*north2-east2*north1).to_value(u.arcsec**2))
    if not np.isfinite([cx, cy, area_arcsec2]).all() or area_arcsec2 <= 0:
        raise ValueError("Cannot determine local cube pixel solid angle")
    scale = math.sqrt(area_arcsec2)
    outer = region.outerArcsec/scale
    x0, x1 = max(0, math.floor(cx-outer-1)), min(shape[1], math.ceil(cx+outer+1))
    y0, y1 = max(0, math.floor(cy-outer-1)), min(shape[0], math.ceil(cy+outer+1))
    if x1 <= x0 or y1 <= y0:
        return None
    patch_shape = (y1-y0, x1-x0)
    position = (cx-x0, cy-y0)
    source = CircularAperture(position, r=region.radiusArcsec/scale).to_mask(method="exact").to_image(patch_shape)
    background = CircularAnnulus(position, r_in=region.innerArcsec/scale, r_out=outer).to_mask(method="center").to_image(patch_shape)
    if source is None: source = np.zeros(patch_shape)
    if background is None: background = np.zeros(patch_shape)
    return (x0, x1, y0, y1), source, background > 0, area_arcsec2


def fingerprint(region, cache, progress):
    """Tutorial-style aperture flux and clipped local background, in mJy."""
    began = time.perf_counter()
    center = SkyCoord(region.ra, region.dec, unit="deg")
    healpix = HEALPix(nside=32, order="nested", frame=ICRS())
    # Include the background annulus and boundary pixels.
    tiles = sorted(map(int, healpix.cone_search_skycoord(center, (region.outerArcsec+2*PIXEL_ARCSEC)*u.arcsec)))
    if len(tiles) > 9:
        raise ValueError("Region intersects too many cube tiles; select a smaller region")
    sums, count, covered = np.zeros(102), np.zeros(102, dtype=int), np.zeros(102, dtype=int)
    source_area, source_solid_angle = np.zeros(102), np.zeros(102)
    annulus_values = [[] for _ in range(102)]
    annulus_areas = [[] for _ in range(102)]
    flags_or = np.zeros(102, dtype=np.int64)
    channels, blank, provenance = None, set(), []
    for index, tile in enumerate(tiles):
        path, url, hit = cache.get(tile, progress)
        progress(f"Reading channels from tile {tile} ({index+1}/{len(tiles)})", None, None)
        with fits.open(path, memmap=not isinstance(path, RangeFile), lazy_load_hdus=True) as hdus:
            header = hdus["IMAGE"].header
            if u.Unit(header.get("BUNIT", "")) != u.MJy/u.sr:
                raise ValueError("Unsupported cube brightness units")
            native_wcs = WCS(header, fobj=hdus).celestial
            native_shape = hdus["IMAGE"].shape[1:]
            table = hdus["SPECTRAL_CHANNELS"].data
            columns = {name: np.array(table[name], copy=True) for name in ("DETECTOR", "SUBCHAN", "WAVELENGTH", "WL_MIN", "WL_MAX")}
            for name in ("WAVELENGTH", "WL_MIN", "WL_MAX"):
                column_index = table.names.index(name)+1
                unit = u.Unit(hdus["SPECTRAL_CHANNELS"].header[f"TUNIT{column_index}"])
                columns[name] = (columns[name]*unit).to_value(u.um)
            if any(values.shape != (102,) for values in columns.values()):
                raise ValueError("Cube must define exactly 102 spectral channels")
            if not (np.array_equal(columns['DETECTOR'], np.repeat(np.arange(1, 7), 17))
                    and np.array_equal(columns['SUBCHAN'], np.tile(np.arange(1, 18), 6))):
                raise ValueError("Unsupported cube channel ordering")
            if any(not np.isfinite(columns[name]).all() for name in ('WAVELENGTH', 'WL_MIN', 'WL_MAX')) or not np.all(
                    (columns['WL_MIN'] <= columns['WAVELENGTH']) & (columns['WAVELENGTH'] <= columns['WL_MAX'])
                    & (columns['WL_MIN'] > 0) & (columns['WL_MIN'] < columns['WL_MAX'])):
                raise ValueError("Invalid calibrated cube wavelengths")
            if channels is not None and any(not np.allclose(channels[k], columns[k]) for k in channels):
                raise ValueError("Cube tiles have incompatible channel definitions")
            channels = columns
            blank.update(_blank_indices(hdus))
            geometry = _aperture_geometry(native_wcs, native_shape, region)
            if geometry is not None:
                (x0,x1,y0,y1), weights, annulus, pixel_area = geometry
                yy,xx = np.indices(weights.shape)
                positions = native_wcs.pixel_to_world(xx+x0, yy+y0)
                owner = healpix.skycoord_to_healpix(positions) == tile
                weights = weights * owner
                annulus &= owner
                aperture = weights > 0
                values,hits,flags = [_patch(hdus,name,slice(None),y0,y1,x0,x1) for name in ("IMAGE","NHITS","FLAGS")]
                valid = _valid(hdus, values, hits, flags)
                accepted = valid & aperture[None,:,:]
                weighted_area = (accepted*weights).sum(axis=(1,2))
                # MJy/sr * pixel solid angle -> mJy, using the tutorial's local scale.
                mjy_per_pixel = pixel_area * (u.arcsec**2).to(u.sr) * 1e9
                sums += (np.where(accepted,values,0)*weights).sum(axis=(1,2),dtype=float)*mjy_per_pixel
                source_area += weighted_area
                source_solid_angle += weighted_area*mjy_per_pixel
                count += accepted.sum(axis=(1,2))
                covered += (np.isfinite(values)&(hits>0)&aperture[None,:,:]).sum(axis=(1,2))
                if aperture.any():
                    flags_or |= np.bitwise_or.reduce(flags[:,aperture].astype(np.int64),axis=1)
                for channel in range(102):
                    selected = values[channel][valid[channel] & annulus]
                    annulus_values[channel].append(selected)
                    annulus_areas[channel].append(np.full(selected.size, pixel_area))
            provenance.append({"tile":tile,"url":url,"diskCacheHit":path.hit if isinstance(path,RangeFile) else hit})
    fluxes=np.full(102,np.nan)
    records=[]
    clip = SigmaClip(sigma=3.0, maxiters=10)
    for i in range(102):
        background = np.concatenate(annulus_values[i]) if annulus_values[i] else np.array([])
        areas = np.concatenate(annulus_areas[i]) if annulus_areas[i] else np.array([])
        clipped = clip(background, masked=True)
        kept = ~np.ma.getmaskarray(clipped)
        background_count = int(kept.sum())
        background_mean = float(background[kept].mean(dtype=np.float64)) if background_count else None
        background_flux = background_mean*source_solid_angle[i] if background_mean is not None else None
        coverage = min(1., float(source_solid_angle[i]/(1e9*(u.arcsec**2).to(u.sr)*np.pi*region.radiusArcsec**2)))
        background_coverage = min(1., float(areas[kept].sum()/(np.pi*(region.outerArcsec**2-region.innerArcsec**2))))
        reason = ""
        if i in blank:
            reason = "Intentional blank DR1 channel"
        elif count[i] == 0:
            reason = "No accepted aperture pixels"
        elif not background_count:
            reason = "No accepted background annulus pixels; enlarge or move the background annulus"
        else:
            fluxes[i] = sums[i]-background_flux
            if coverage < .95 or background_coverage < .95:
                reason = "Partial aperture or clipped background coverage; flux is not corrected for missing area"
        records.append(dict(channel=i+1,detector=int(channels["DETECTOR"][i]),subchannel=int(channels["SUBCHAN"][i]),
            wavelengthUm=float(channels["WAVELENGTH"][i]),minUm=float(channels["WL_MIN"][i]),maxUm=float(channels["WL_MAX"][i]),
            value=float(fluxes[i]) if np.isfinite(fluxes[i]) else None,uncertainty=None,
            apertureFluxMjy=float(sums[i]) if count[i] else None, backgroundFluxMjy=background_flux,
            backgroundMeanMJySr=background_mean, apertureAreaPixels=float(source_area[i]),
            backgroundPixels=background_count, backgroundCoverage=background_coverage,
            pixels=int(count[i]),coveredPixels=int(covered[i]),coverage=coverage,flagsOr=int(flags_or[i]),reason=reason))
    return dict(region=region.model_dump(),channels=records,usableChannels=int(np.isfinite(fluxes).sum()),totalChannels=102,
        unit="mJy",processingVersion=PROCESSING_VERSION,product=RELEASE,provenance=provenance,combinedEpochs=True,uncertaintyAvailable=False,
        qualityPolicy="Finite data and NHITS>0; SOURCE/FULLSAMPLE permitted, other flags rejected in aperture and annulus. Exact fractional circular aperture weights; annulus pixel-centre mean clipped at 3 sigma for up to 10 iterations. Background scales to accepted aperture area. Local WCS solid angle converts to mJy.",
        references=[{"sourceUrl":REFERENCE_URL,**r,"status":"reference-only"} for r in REFERENCES],
        limitations=["Visualization only; use IRSA spectrophotometry for scientific source measurements", "Combined observations, not a simultaneous spectrum; moving and variable targets are unsupported", "No variance extension: uncertainty and detection significance unavailable", "Known cube striping near spectral features; reference alignment alone is not a detection", "No PSF or aperture correction; incomplete coverage underestimates total aperture flux", "Tutorial pixel-plane circular aperture geometry; sky-circle overlays are approximate on distorted grids", "Quality masking and multi-tile ownership extend the tutorial; sigma clipping pools annulus samples across tiles"],
        elapsedSeconds=time.perf_counter()-began)


class Fingerprints:
    def __init__(self, cache=None, worker=None):
        self.cache=cache or CubeCache()
        self.worker=worker or fingerprint
        self.lock=RLock()
        self.items={}
        self.pool=ThreadPoolExecutor(max_workers=2,thread_name_prefix="cube")

    def close(self):
        self.pool.shutdown(wait=True,cancel_futures=True)
        if hasattr(self.cache, "close"): self.cache.close()

    def start(self, sequence_id, region, retry=False):
        key=hashlib.sha256(json.dumps([sequence_id,RELEASE,PROCESSING_VERSION,region.model_dump()],sort_keys=True).encode()).hexdigest()[:32]
        with self.lock:
            for old in list(self.items):
                item=self.items[old]
                if item['status'] in {'ready','failed'} and time.monotonic()-item['updated']>1800:
                    del self.items[old]
            existing=self.items.get(key)
            if existing and not (retry and existing['status']=='failed'):
                return {"analysisId":key,"status":existing['status']}
            if sum(i['status']=='loading' for i in self.items.values())>=4:
                raise AppError("CUBE_CAPACITY", "Cube acquisition is busy; retry shortly.",503,True,5)
            if len(self.items)>=12:
                finished=[k for k,i in self.items.items() if i['status']!='loading']
                if finished:
                    del self.items[min(finished,key=lambda k:self.items[k]['updated'])]
                else:
                    raise AppError("CUBE_CAPACITY","Cube analysis capacity reached.",503,True,5)
            self.items[key]=dict(status='loading',message='Locating FITS cube tiles',downloadedBytes=None,totalBytes=None,updated=time.monotonic(),result=None,error=None,sequenceId=sequence_id)
        self.pool.submit(self._run,key,region)
        return {"analysisId":key,"status":"loading"}

    def _run(self,key,region):
        def progress(message,received,total):
            with self.lock:
                self.items[key].update(message=message,downloadedBytes=received,totalBytes=total,updated=time.monotonic())
        try:
            result=self.worker(region,self.cache,progress)
            with self.lock:
                self.items[key].update(status='ready',message='Fingerprint ready',result=result,updated=time.monotonic())
        except Exception as exc:
            import logging
            logging.getLogger(__name__).exception("Cube fingerprint failed")
            with self.lock:
                self.items[key].update(status='failed',message='Cube data unavailable',error=str(exc),updated=time.monotonic())

    def _get(self,key,sequence_id):
        item=self.items.get(key)
        if item is not None and item['status'] in {'ready', 'failed'} and time.monotonic() - item['updated'] > 1800:
            del self.items[key]
            item = None
        if item is None or item['sequenceId']!=sequence_id:
            raise AppError("FINGERPRINT_NOT_FOUND","Fingerprint expired or does not belong to this field.",404)
        return item

    def get(self,key,sequence_id):
        with self.lock:
            item=self._get(key,sequence_id)
            return {"analysisId":key,**{k:item[k] for k in ('status','message','downloadedBytes','totalBytes','result','error')}}

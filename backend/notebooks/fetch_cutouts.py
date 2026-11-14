"""Step 3: pull cutouts fast. Two ways, benchmarked against each other.

Run:  uv run python notebooks/fetch_cutouts.py   (from backend/)

Based on the IRSA "SPHEREx Cutouts" tutorial (cutout service + thread pool)
and the "Source Discovery Tool" tutorial (anonymous S3 reads), plus our own
S3 partial-read approach.

A) IRSA cutout service: GET <file url>?center=<ra>,<dec>d&size=<deg>
   + simple; IRSA does the slicing.
   - every cutout carries the full EPSF table: a 3' cutout is ~4 MB, of which
     ~3.9 MB is PSF data we don't need for blinking.
   - IRSA is shared: under load it returns HTTP 503 "Server busy, retry
     later" as a plain-text body. Check the status or astropy will fail with a
     confusing "No SIMPLE card found".

B) S3 partial reads: open the full frame lazily from the public bucket and
   read only the header + the pixel box we need via `.section[...]`.
   + skips the EPSF bytes, no load on IRSA's servers.
   - many small HTTP range requests; slow with default settings. A bigger
     read block (below) fixes most of it.

Measured from Australia, 8 frames, 3' box (Nov 2026):
   cutout service, 8 threads   ~12 s (plus ten 503 retries along the way)
   S3 defaults, 8 threads      ~130 s
   S3 512 KB blockcache        ~13 s
The S3 bucket is in us-east-1. A backend hosted there should be much faster
via S3; re-run this benchmark from the deploy host before choosing.
"""

import io
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import numpy as np
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS

from find_frames import cutout_url, s3_path
from read_cutout import (
    PIXEL_SCALE_ARCSEC,
    Cutout,
    flag_bits,
    parse_cutout,
    wavelength_at,
)

# IRSA is a shared public service: keep parallel requests modest.
MAX_WORKERS = 8

# s3fs options. Without a larger block, astropy issues one tiny range request
# per image row, which is very slow over long distances.
S3_OPTIONS = {
    "anon": True,
    "default_block_size": 512 * 1024,
    "default_cache_type": "blockcache",
}


def fetch_via_cutout_service(
    uri: str, coord: SkyCoord, size: u.Quantity, retries: int = 6
) -> fits.HDUList:
    """Method A. Returns the cutout MEF held in memory."""
    url = cutout_url(uri, coord, size)
    for attempt in range(retries):
        response = httpx.get(url, timeout=120, follow_redirects=True)
        if response.status_code != 503:
            break
        time.sleep(2**attempt)  # back off: 1, 2, 4, 8 ... seconds
    response.raise_for_status()
    return fits.open(io.BytesIO(response.content))


def fetch_via_s3(uri: str, coord: SkyCoord, size: u.Quantity) -> Cutout:
    """Method B. Reads only the headers and the pixel box around `coord`."""
    with fits.open(s3_path(uri), use_fsspec=True, fsspec_kwargs=S3_OPTIONS) as hdul:
        header = hdul["IMAGE"].header
        full_wcs = WCS(header)
        x, y = full_wcs.world_to_pixel(coord)

        # Pixel box around the target, clipped to the detector edge
        # (targets near an edge get a smaller cutout).
        half = int(np.ceil(size.to_value(u.arcsec) / PIXEL_SCALE_ARCSEC / 2))
        ny, nx = header["NAXIS2"], header["NAXIS1"]
        x0, x1 = max(int(x) - half, 0), min(int(x) + half + 1, nx)
        y0, y1 = max(int(y) - half, 0), min(int(y) + half + 1, ny)

        def box(ext):
            return hdul[ext].section[y0:y1, x0:x1]

        # Wavelength comes from the full-frame pixel position.
        wavelength, bandwidth = wavelength_at(hdul, x, y)
        return Cutout(
            detector=int(header["DETECTOR"]),
            mjd=float(header["MJD-AVG"]),
            version=hdul[0].header.get("VERSION", ""),
            image=box("IMAGE"),
            flags=box("FLAGS"),
            flag_bits=flag_bits(hdul["FLAGS"].header),
            variance=box("VARIANCE"),
            zodi=box("ZODI"),
            wcs=full_wcs[y0:y1, x0:x1],  # slicing a WCS shifts its reference pixel
            wavelength_um=float(wavelength.value),
            bandwidth_um=float(bandwidth.value),
            psf_fwhm_arcsec=float(header["PSF_FWHM"]),
        )


def fetch_many(
    uris, coord: SkyCoord, size: u.Quantity, method: str = "cutout"
) -> list[Cutout]:
    """Fetch many frames in parallel with bounded concurrency.

    Threads suit this work: it is network-bound, so the GIL is not the
    bottleneck. In the FastAPI app, run this in a thread pool (or use async
    httpx with a semaphore) so the event loop is never blocked.
    """

    def one(uri):
        if method == "s3":
            return fetch_via_s3(uri, coord, size)
        return parse_cutout(fetch_via_cutout_service(uri, coord, size), coord)

    with ThreadPoolExecutor(MAX_WORKERS) as pool:
        return list(pool.map(one, uris))


if __name__ == "__main__":
    from astropy.table import Table

    from find_frames import OUTPUT_DIR

    target = SkyCoord(133.79513, -7.24515, unit="deg")
    size = 3 * u.arcmin
    uris = list(Table.read(OUTPUT_DIR / "frames_wise0855.ecsv")["uri"][:8])

    hdul = fetch_via_cutout_service(uris[0], target, size)
    nbytes = sum(hdu.filebytes() for hdu in hdul)
    epsf_bytes = hdul["EPSF"].filebytes()
    print(f"one cutout: {nbytes / 1e6:.2f} MB, of which EPSF {epsf_bytes / 1e6:.2f} MB")

    for method in ("cutout", "s3"):
        start = time.perf_counter()
        cutouts = fetch_many(uris, target, size, method)
        print(
            f"{method:6s} {len(cutouts)} frames in {time.perf_counter() - start:.1f} s"
        )

    # Both methods should agree on the science values.
    a = parse_cutout(fetch_via_cutout_service(uris[0], target, size), target)
    b = fetch_via_s3(uris[0], target, size)
    print(f"wavelength: cutout {a.wavelength_um:.4f} um, s3 {b.wavelength_um:.4f} um")
    print(
        f"target pixel value: cutout {a.image[a.wcs.world_to_array_index(target)]:.4f}, "
        f"s3 {b.image[b.wcs.world_to_array_index(target)]:.4f}"
    )

"""Step 2: what is inside a SPHEREx spectral image, and what we keep.

Run:  uv run python notebooks/read_cutout.py   (from backend/)

Based on the IRSA "SPHEREx Intro" and "SPHEREx PSF" tutorials. Skips the
Firefly viewer and the ePSF deep dive.

Every spectral image (full frame or cutout) is a multi-extension FITS file:
  0 PRIMARY   no data; VERSION keyword (pipeline version, e.g. '7.0.5')
  1 IMAGE     surface brightness, MJy/sr, float32. Zodi NOT subtracted.
  2 FLAGS     int32 bitmask per pixel (bit names are in this header)
  3 VARIANCE  (MJy/sr)^2 per pixel -> noise for significance maps
  4 ZODI      zodiacal background model, MJy/sr -> subtract before differencing
  5 EPSF      PSF table: 441-451 rows of 33x33 oversampled PSFs (~3.9 MB!)
  6 WCS-WAVE  lookup table for the per-pixel wavelength

Full frames are 2040x2040 pixels at 6.15"/pixel. A 3' cutout is ~29x29.
The useful header keywords live on IMAGE: DETECTOR (1-6), MJD-AVG, DATE-AVG,
PSF_FWHM (arcsec), BUNIT.
"""

import logging
from dataclasses import dataclass

import numpy as np
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS

# Opening the spectral WCS 'W' logs a long SIP INFO notice every time
# (expected, see wavelength_at). Silence it, as the IRSA tutorials do.
logging.getLogger("astropy").setLevel(logging.ERROR)

PIXEL_SCALE_ARCSEC = 6.15

# FLAGS bit names, from the MSKNnnnn keywords in the FLAGS header (DR1):
#   0 TRANSIENT  1 OVERFLOW  2 SUR_ERROR  6 NONFUNC  7 DICHROIC  9 MISSING_DATA
#  10 HOT  11 COLD  12 FULLSAMPLE  14 PHANMISS  15 NONLINEAR  17 PERSIST
#  19 OUTLIER  20 CROSSTALK  21 SOURCE  22 GHOST  23 GHOST_FPA  24 GHOST_EXT
#  25 STREAK  26 BLOOM  27 SNOWBALL  28 HALO
# Meanings: Table 16 of the Explanatory Supplement
# https://irsa.ipac.caltech.edu/data/SPHEREx/docs/SPHEREx_Expsupp.pdf
#
# Pixels with any of these set become NaN. [DECIDE] the final list. Deliberately
# NOT masked:
# - SOURCE: marks pixels on known sources, which is exactly what we look at.
# - TRANSIENT / OUTLIER: a moving asteroid can trip these. Masking them could
#   erase the very objects we want to find.
# - FULLSAMPLE, DICHROIC, PHANMISS: informational / mild.
BAD_FLAGS = {
    "SUR_ERROR", "NONFUNC", "MISSING_DATA", "HOT", "COLD", "NONLINEAR",
    "PERSIST", "CROSSTALK", "GHOST", "GHOST_FPA", "GHOST_EXT", "STREAK",
    "BLOOM", "SNOWBALL", "HALO",
}


@dataclass
class Cutout:
    """Everything the app needs from one frame at one position."""
    detector: int
    mjd: float                  # mid-exposure, UTC
    version: str
    image: np.ndarray           # MJy/sr, zodi NOT subtracted
    flags: np.ndarray
    flag_bits: dict[str, int]   # {'HOT': 10, ...} from this frame's FLAGS header
    variance: np.ndarray
    zodi: np.ndarray
    wcs: WCS                    # celestial WCS of these pixels
    wavelength_um: float        # at the target position
    bandwidth_um: float
    psf_fwhm_arcsec: float


def flag_bits(flags_header: fits.Header) -> dict[str, int]:
    """{'HOT': 10, ...} read from the FLAGS header, so we never hard-code bit numbers."""
    return {flags_header[key]: int(key[4:]) for key in flags_header["MSKN*"]}


def bad_pixel_mask(flags: np.ndarray, bits: dict[str, int], bad=BAD_FLAGS) -> np.ndarray:
    """True where any bad flag bit is set."""
    bad_bits = sum(1 << bits[name] for name in bad if name in bits)
    return (flags & bad_bits) != 0


def wavelength_at(hdul: fits.HDUList, x: float, y: float) -> tuple[u.Quantity, u.Quantity]:
    """Wavelength and bandwidth at pixel (x, y), from the alternate WCS 'W'.

    SPHEREx uses linear variable filters, so wavelength changes across the
    detector: a star's brightness differs between frames simply because it
    landed at a different wavelength. Always compare frames at similar
    wavelengths (see align_diff.py).

    `fobj=hdul` is required: WCS 'W' points at the WCS-WAVE lookup table.
    SIP distortion must be switched off for this WCS (wavelength depends on the
    detector/filter, not the telescope optics).
    """
    spectral_wcs = WCS(hdul["IMAGE"].header, fobj=hdul, key="W")
    spectral_wcs.sip = None
    wavelength, bandwidth = spectral_wcs.pixel_to_world(x, y)
    return wavelength.to(u.um), bandwidth.to(u.um)


def parse_cutout(hdul: fits.HDUList, coord: SkyCoord) -> Cutout:
    """Turn a cutout MEF (from the IRSA cutout service) into a Cutout."""
    header = hdul["IMAGE"].header
    wcs = WCS(header)
    x, y = wcs.world_to_pixel(coord)
    wavelength, bandwidth = wavelength_at(hdul, x, y)
    return Cutout(
        detector=int(header["DETECTOR"]),
        mjd=float(header["MJD-AVG"]),
        version=hdul[0].header.get("VERSION", ""),
        image=hdul["IMAGE"].data,
        flags=hdul["FLAGS"].data,
        flag_bits=flag_bits(hdul["FLAGS"].header),
        variance=hdul["VARIANCE"].data,
        zodi=hdul["ZODI"].data,
        wcs=wcs,
        wavelength_um=float(wavelength.value),
        bandwidth_um=float(bandwidth.value),
        psf_fwhm_arcsec=float(header["PSF_FWHM"]),
    )


if __name__ == "__main__":
    from astropy.table import Table

    from fetch_cutouts import fetch_via_cutout_service
    from find_frames import OUTPUT_DIR

    target = SkyCoord(133.79513, -7.24515, unit="deg")
    frames = Table.read(OUTPUT_DIR / "frames_wise0855.ecsv")

    hdul = fetch_via_cutout_service(frames["uri"][0], target, 3 * u.arcmin)
    hdul.info()

    cutout = parse_cutout(hdul, target)
    print("flag bits:", cutout.flag_bits)
    bad = bad_pixel_mask(cutout.flags, cutout.flag_bits)
    print(f"detector D{cutout.detector}  MJD {cutout.mjd:.4f}  version {cutout.version}")
    print(f"wavelength at target {cutout.wavelength_um:.3f} um "
          f"(bandwidth {cutout.bandwidth_um:.3f} um)")
    print(f"PSF FWHM {cutout.psf_fwhm_arcsec:.2f}\"  image {cutout.image.shape}  "
          f"bad pixels {bad.sum()} / {bad.size}")

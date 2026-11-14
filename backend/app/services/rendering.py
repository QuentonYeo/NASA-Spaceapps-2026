"""Build display previews from calibrated FITS cutouts."""
import base64
import io
import logging
from dataclasses import dataclass, replace

import numpy as np
from astropy import units as u
from astropy.io import fits
from astropy.wcs import WCS, WcsError
from PIL import Image
from reproject import reproject_interp

from app.domain.errors import AppError
from app.domain.models import Region

logger = logging.getLogger(__name__)
PIXEL_SCALE_DEG = 6.15 / 3600

# Instrument artifacts identified in the cutout investigation. Keep flags that
# can mark genuine sources or transient signals.
BAD_FLAGS = {
    "SUR_ERROR", "NONFUNC", "MISSING_DATA", "HOT", "COLD", "NONLINEAR",
    "PERSIST", "CROSSTALK", "GHOST", "GHOST_FPA", "GHOST_EXT", "STREAK",
    "BLOOM", "SNOWBALL", "HALO",
}


@dataclass(frozen=True)
class PreviewPixels:
    data: np.ndarray
    valid: np.ndarray
    limits: tuple[float, float]
    unit: str
    wavelength_um: float | None
    wcs: WCS | None
    region: Region | None


def align_to_query(pixels: PreviewPixels) -> PreviewPixels | None:
    if pixels.wcs is None or pixels.region is None:
        return None
    region = pixels.region
    side = max(1, round(region.fov / PIXEL_SCALE_DEG))
    grid = WCS(naxis=2)
    grid.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    grid.wcs.radesys = "ICRS"
    grid.wcs.crval = [region.ra, region.dec]
    grid.wcs.crpix = [(side + 1) / 2] * 2
    grid.wcs.cdelt = [-PIXEL_SCALE_DEG, PIXEL_SCALE_DEG]

    # Interpolate calibrated values and leave gaps wherever the interpolation
    # needs a masked or uncovered input pixel.
    data, footprint = reproject_interp(
        (np.where(pixels.valid, pixels.data, np.nan), pixels.wcs),
        grid,
        shape_out=(side, side),
        order="bilinear",
    )
    valid = np.isfinite(data) & (footprint > 0)
    if not valid.any():
        return None
    # FITS y increases northward. PNG row zero is the top of the image.
    return replace(pixels, data=data[::-1], valid=valid[::-1], wcs=grid)


def local_wavelength(hdus: fits.HDUList, region: Region) -> float | None:
    header = hdus["IMAGE"].header
    if "WCS-WAVE" not in hdus:
        return None
    try:
        x, y = WCS(header).celestial.world_to_pixel_values(region.ra, region.dec)
        height, width = hdus["IMAGE"].shape
        if not (-0.5 <= x < width - 0.5 and -0.5 <= y < height - 0.5):
            return None
        spectral = WCS(header, fobj=hdus, key="W")
        spectral.sip = None
        wavelength, _ = spectral.pixel_to_world(x, y)
        value = float(wavelength.to_value(u.um))
        return value if np.isfinite(value) and value > 0 else None
    except (WcsError, AttributeError, KeyError, TypeError, ValueError):
        return None


class FitsRenderer:
    def prepare(self, cutout: bytes, region: Region | None = None) -> PreviewPixels:
        try:
            with fits.open(io.BytesIO(cutout), memmap=False) as hdus:
                image = hdus["IMAGE"]
                data = np.array(image.data, dtype=float)
                if data.ndim != 2 or not data.size:
                    raise ValueError("Expected a two-dimensional image")
                valid = np.isfinite(data)
                if "FLAGS" in hdus:
                    flags = hdus["FLAGS"]
                    if flags.shape == data.shape:
                        bits = {
                            int(key[4:]) for key in flags.header
                            if key.startswith("MSKN") and key[4:].isdigit()
                            and int(key[4:]) < 32 and flags.header[key] in BAD_FLAGS
                        }
                        mask = sum(1 << bit for bit in bits)
                        valid &= (flags.data.astype(np.uint32) & mask) == 0
                if "VARIANCE" in hdus and hdus["VARIANCE"].shape == data.shape:
                    variance = hdus["VARIANCE"].data
                    valid &= np.isfinite(variance) & (variance > 0)
                unit = str(image.header.get("BUNIT", "")).strip()
                wavelength = local_wavelength(hdus, region) if region else None
                wcs = None
                if region is not None:
                    try:
                        candidate = WCS(image.header).celestial
                        if candidate.has_celestial:
                            wcs = candidate
                    except (WcsError, ValueError):
                        logger.debug("No usable celestial WCS for aligned preview", exc_info=True)
            if not valid.any():
                raise ValueError("No valid pixels")
            low, high = np.percentile(data[valid], [0.5, 99.5])
            return PreviewPixels(data, valid, (float(low), float(high)), unit, wavelength, wcs, region)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise AppError("CUTOUT_INVALID", "The archive cutout could not be rendered.") from exc

    def render(self, cutout: bytes) -> dict:
        return self.preview(self.prepare(cutout))

    def preview(self, pixels: PreviewPixels, shared: tuple[float, float] | None = None) -> dict:
        image, display = self._encode(pixels, pixels.limits, "per-frame")
        shared_image, shared_display = None, None
        if shared is not None:
            if shared == pixels.limits:
                shared_image, shared_display = image, {**display, "scope": "shared"}
            else:
                shared_image, shared_display = self._encode(pixels, shared, "shared")
        aligned_image, aligned_grid = None, None
        if shared is not None and pixels.wcs is not None:
            try:
                aligned = align_to_query(pixels)
                if aligned is not None:
                    aligned_image, _ = self._encode(aligned, shared, "shared")
                    height, width = aligned.data.shape
                    aligned_grid = {"width": width, "height": height, "orientation": "north-up"}
            except (WcsError, ValueError, TypeError):
                logger.debug("Could not reproject cutout for aligned preview", exc_info=True)
        return {"alignedImageData": aligned_image, "alignedGrid": aligned_grid,
                "imageData": image, "display": display, "sharedImageData": shared_image,
                "sharedDisplay": shared_display, "wavelengthUm": pixels.wavelength_um,
                "grid": {"width": pixels.data.shape[1], "height": pixels.data.shape[0],
                         "orientation": "native"}}

    @staticmethod
    def _encode(pixels: PreviewPixels, limits: tuple[float, float], scope: str) -> tuple[str, dict]:
        low, high = limits
        normalized = np.clip((np.where(pixels.valid, pixels.data, low) - low) / max(high - low, 1e-12), 0, 1)
        gray = (np.arcsinh(10 * normalized) / np.arcsinh(10) * 255).astype(np.uint8)
        rgba = np.stack([gray, gray, gray, pixels.valid.astype(np.uint8) * 255], axis=-1)
        output = io.BytesIO()
        Image.fromarray(rgba).save(output, format="PNG")
        return ("data:image/png;base64," + base64.b64encode(output.getvalue()).decode(),
                {"stretch": "asinh", "vmin": low, "vmax": high, "scope": scope, "aligned": False})

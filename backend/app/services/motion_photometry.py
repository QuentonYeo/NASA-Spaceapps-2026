"""Quick-look aperture measurements at moving-source positions in native frames."""
import io

import numpy as np
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS, WcsError
from photutils.aperture import CircularAnnulus, CircularAperture

from app.services.rendering import BAD_FLAGS
from app.services.wcs import spectral_wcs


def _clipped_median(values: np.ndarray) -> tuple[float, np.ndarray]:
    keep = np.isfinite(values)
    for _ in range(10):
        sample = values[keep]
        if sample.size < 5:
            break
        median = float(np.median(sample))
        sigma = 1.4826 * float(np.median(np.abs(sample - median)))
        if not np.isfinite(sigma) or sigma <= 0:
            break
        revised = keep & (np.abs(values - median) <= 3 * sigma)
        if revised.sum() == keep.sum():
            break
        keep = revised
    sample = values[keep]
    return (float(np.median(sample)) if sample.size else float("nan"), keep)


def measure_position(cutout: bytes, ra: float, dec: float, radius_pixels: float) -> dict:
    """Measure a small circular aperture and local annulus on one native image.

    Results are quick-look aperture photometry, not PSF-matched catalog fluxes.
    Statistical uncertainty is returned only when the FITS variance plane exists.
    """
    with fits.open(io.BytesIO(cutout), memmap=False) as hdus:
        image = hdus["IMAGE"]
        data = np.asarray(image.data, dtype=float)
        if data.ndim != 2 or not data.size:
            raise ValueError("Expected a two-dimensional native IMAGE plane")
        unit = str(image.header.get("BUNIT", "")).replace(" ", "").lower()
        if "mjy" not in unit or "sr" not in unit:
            raise ValueError(f"Unsupported image unit: {image.header.get('BUNIT', 'unknown')}")

        wcs = WCS(image.header).celestial
        x, y = map(float, wcs.world_to_pixel(SkyCoord(ra, dec, unit="deg")))
        if not np.isfinite([x, y]).all():
            raise ValueError("Candidate position cannot be projected onto the native image")
        if not (-0.5 <= x < data.shape[1] - 0.5 and -0.5 <= y < data.shape[0] - 0.5):
            raise ValueError("Candidate position falls outside this native cutout")

        center = wcs.pixel_to_world(x, y)
        nearby = wcs.pixel_to_world([x, x + 1, x], [y, y, y + 1])
        east1, north1 = center.spherical_offsets_to(nearby[1])
        east2, north2 = center.spherical_offsets_to(nearby[2])
        area_arcsec2 = abs((east1 * north2 - east2 * north1).to_value(u.arcsec**2))
        if not np.isfinite(area_arcsec2) or area_arcsec2 <= 0:
            raise ValueError("Native pixel solid angle is unavailable")
        area_sr = area_arcsec2 * (np.pi / (180 * 3600)) ** 2

        radius = radius_pixels
        outer = 3 * radius
        x0, x1 = max(0, int(np.floor(x - outer - 1))), min(data.shape[1], int(np.ceil(x + outer + 1)))
        y0, y1 = max(0, int(np.floor(y - outer - 1))), min(data.shape[0], int(np.ceil(y + outer + 1)))
        patch_shape = (y1 - y0, x1 - x0)
        position = (x - x0, y - y0)
        aperture = CircularAperture(position, r=radius).to_mask(method="exact").to_image(patch_shape)
        annulus_image = CircularAnnulus(position, r_in=2 * radius, r_out=outer).to_mask(method="center").to_image(patch_shape)
        if annulus_image is None:
            raise ValueError("Local background annulus falls outside this cutout")
        annulus = annulus_image > 0
        patch = data[y0:y1, x0:x1]
        valid = np.isfinite(patch)
        flags = None
        if "FLAGS" in hdus and hdus["FLAGS"].shape == data.shape:
            flag_header = hdus["FLAGS"].header
            bad_bits = [int(key[4:]) for key in flag_header
                        if key.startswith("MSKN") and key[4:].isdigit()
                        and int(key[4:]) < 32 and flag_header[key] in BAD_FLAGS]
            bad_mask = sum(1 << bit for bit in bad_bits)
            flags = np.asarray(hdus["FLAGS"].data[y0:y1, x0:x1], dtype=np.uint32)
            valid &= (flags & bad_mask) == 0

        variance = None
        if "VARIANCE" in hdus and hdus["VARIANCE"].shape == data.shape:
            variance = np.asarray(hdus["VARIANCE"].data[y0:y1, x0:x1], dtype=float)
            valid &= np.isfinite(variance) & (variance > 0)

        bg_values = patch[annulus & valid]
        background, clipped = _clipped_median(bg_values)
        if not np.isfinite(background) or clipped.sum() < 5:
            raise ValueError("Too few valid background pixels around the candidate")
        aperture_weights = np.where(valid, aperture, 0.0)
        accepted_area = float(aperture_weights.sum())
        total_area = float(np.pi * radius**2)
        if accepted_area <= 0 or total_area <= 0:
            raise ValueError("No valid pixels in the candidate aperture")

        flux_scale = area_sr * 1e9  # MJy/sr × sr → MJy → mJy
        net_surface_brightness = float(np.sum(aperture_weights * np.where(valid, patch, 0.0)) - background * accepted_area)
        flux_mjy = net_surface_brightness * flux_scale
        uncertainty_mjy = None
        if variance is not None:
            source_variance = float(np.sum(np.where(valid, variance, 0) * aperture**2))
            annulus_variance = variance[annulus & valid][clipped]
            background_variance = float(np.sum(annulus_variance) / max(1, annulus_variance.size) ** 2)
            uncertainty_mjy = float(np.sqrt(max(0.0, source_variance + accepted_area**2 * background_variance)) * flux_scale)

        wavelength_um = bandwidth_um = None
        if "WCS-WAVE" in hdus:
            try:
                wavelength, bandwidth = spectral_wcs(hdus).pixel_to_world(x, y)
                wavelength_um = float(wavelength.to_value(u.um))
                bandwidth_um = float(bandwidth.to_value(u.um))
                if not np.isfinite(wavelength_um) or wavelength_um <= 0:
                    wavelength_um = None
                if not np.isfinite(bandwidth_um) or bandwidth_um <= 0:
                    bandwidth_um = None
            except (WcsError, AttributeError, KeyError, TypeError, ValueError):
                pass

        source_flags = int(np.bitwise_or.reduce(flags[aperture > 0], initial=np.uint32(0))) if flags is not None else None
        coverage = min(1.0, accepted_area / total_area)
        return {
            "status": "measured" if coverage >= 0.7 else "partial",
            "ra": float(ra), "dec": float(dec), "pixelX": x, "pixelY": y,
            "wavelengthUm": wavelength_um, "bandwidthUm": bandwidth_um,
            "fluxMjy": flux_mjy, "uncertaintyMjy": uncertainty_mjy,
            "signalToNoise": flux_mjy / uncertainty_mjy if uncertainty_mjy and uncertainty_mjy > 0 else None,
            "backgroundMjySr": background, "radiusPixels": radius,
            "apertureCoverage": coverage, "aperturePixels": int(np.count_nonzero((aperture > 0) & valid)),
            "backgroundPixels": int(clipped.sum()), "flagsOr": source_flags,
            "quality": "Quick-look aperture photometry; variance-plane uncertainty omits correlated-noise and calibration systematics."
                       + (" Partial aperture coverage." if coverage < 0.7 else ""),
        }

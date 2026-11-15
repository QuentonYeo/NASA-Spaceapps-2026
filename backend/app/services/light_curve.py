"""Fixed-position aperture photometry on individual native exposures."""
from collections import Counter
import io

import numpy as np
from astropy import units as u
from astropy.io import fits
from astropy.stats import sigma_clip
from astropy.wcs import WCS, WcsError
from astropy.wcs.utils import proj_plane_pixel_area
from photutils.aperture import CircularAnnulus

from app.domain.models import Region
from app.services.jobs import Job
from app.services.rendering import BAD_FLAGS, local_wavelength, query_grid


INNER_WINGS = ((2.5, 4.5), (6, 9))
OUTER_WINGS = ((6.5, 8.5), (10, 13))
REJECT_FLAGS = BAD_FLAGS | {"OVERFLOW", "SATURATED", "SATURATION", "DICHROIC", "PHANMISS", "OUTLIER"}


def measured_pixels(weights: np.ndarray, wcs: WCS, region: Region) -> list[dict]:
    """Return the footprint of each weighted native pixel in both preview grids."""
    rows, columns = np.nonzero(weights > 0)
    dx = np.array([-.5, .5, .5, -.5])
    dy = np.array([-.5, -.5, .5, .5])
    corners_x = columns[:, None] + dx
    corners_y = rows[:, None] + dy
    aligned_grid, side = query_grid(region)
    aligned_x, aligned_y = aligned_grid.world_to_pixel(wcs.pixel_to_world(corners_x, corners_y))
    height, width = weights.shape
    native = np.stack(((corners_x + .5) / width, (corners_y + .5) / height), axis=-1)
    # The aligned PNG reverses the FITS y axis.
    aligned = np.stack(((aligned_x + .5) / side, 1 - (aligned_y + .5) / side), axis=-1)
    return [
        {"weight": float(weight), "native": native_pixel.round(6).tolist(),
         "aligned": aligned_pixel.round(6).tolist() if np.isfinite(aligned_pixel).all() else None}
        for weight, native_pixel, aligned_pixel in zip(weights[rows, columns], native, aligned, strict=True)
    ]


def measure_exposure(cutout: bytes, region: Region, *, outer_wings: bool = False) -> tuple[dict | None, str | None]:
    source_radii, background_radii = OUTER_WINGS if outer_wings else INNER_WINGS
    with fits.open(io.BytesIO(cutout), memmap=False) as hdus:
        image = hdus["IMAGE"]
        data = np.asarray(image.data, dtype=float)
        if data.ndim != 2 or u.Unit(image.header.get("BUNIT", "")) != u.MJy / u.sr:
            return None, "Unsupported image units or geometry"
        wavelength = local_wavelength(hdus, region)
        if wavelength is None:
            return None, "Missing local wavelength"
        wcs = WCS(image.header).celestial
        x, y = map(float, wcs.world_to_pixel_values(region.ra, region.dec))
        if not np.isfinite([x, y]).all():
            return None, "Invalid sky position"
        height, width = data.shape
        if min(x + .5, y + .5, width - .5 - x, height - .5 - y) < source_radii[1]:
            return None, "Aperture outside the image"

        valid = np.isfinite(data)
        if "FLAGS" not in hdus or hdus["FLAGS"].shape != data.shape:
            return None, "Missing pixel quality flags"
        flags = hdus["FLAGS"]
        defined = {
            int(key[4:]): str(flags.header[key]).strip().upper()
            for key in flags.header
            if key.startswith("MSKN") and key[4:].isdigit() and 0 <= int(key[4:]) < 32
        }
        if not defined:
            return None, "Missing pixel quality flag definitions"
        flagged = flags.data.astype(np.uint32)
        rejected = sum(1 << bit for bit, name in defined.items() if name in REJECT_FLAGS)
        valid &= (flagged & rejected) == 0
        aperture = CircularAnnulus((x, y), r_in=source_radii[0], r_out=source_radii[1])
        weights = aperture.to_mask(method="exact").to_image(data.shape)
        # Discard numerical overlap at pixels that only touch the aperture.
        weights[weights < 1e-10] = 0
        source = weights > 0
        if not valid[source].all():
            return None, "Masked or saturated wing pixels"

        annulus = CircularAnnulus((x, y), r_in=background_radii[0], r_out=background_radii[1])
        sky = annulus.to_mask(method="center").to_image(data.shape) > 0
        samples = data[sky & valid]
        samples = sigma_clip(samples, sigma=3, maxiters=5).compressed()
        if samples.size < 20:
            return None, "Insufficient background pixels"

        pixel_area = float(proj_plane_pixel_area(wcs))
        if not np.isfinite(pixel_area) or pixel_area <= 0:
            return None, "Invalid pixel area"
        factor = pixel_area * (u.deg**2).to(u.sr) * 1e9
        background = float(np.mean(samples))
        flux = float(np.dot(weights[source], data[source] - background) * factor)
        if not np.isfinite(flux):
            return None, "Invalid aperture flux"
        return {
            "fluxMjy": flux, "wavelengthUm": wavelength,
            "pixels": measured_pixels(weights, wcs, region),
        }, None


def measure_light_curve(job: Job, *, outer_wings: bool = False) -> dict:
    with job.lock:
        frames = [frame for frame in job.results if frame["status"] == "ready"]
    points = []
    skipped = Counter()
    for frame in frames:
        cutout = job.science_cutout(frame["id"])
        if cutout is None:
            skipped["FITS unavailable"] += 1
            continue
        try:
            measurement, reason = measure_exposure(cutout, job.region, outer_wings=outer_wings)
        except (OSError, ValueError, KeyError, TypeError, WcsError):
            measurement, reason = None, "Invalid FITS or sky coordinates"
        if measurement is None:
            skipped[reason] += 1
        else:
            points.append({
                "frameId": frame["id"], "observedAtUtc": frame["observedAtUtc"],
                "detector": frame["detector"], **measurement,
            })
    points.sort(key=lambda point: (point["observedAtUtc"], point["frameId"]))
    return {"points": points, "readyFrames": len(frames), "skipped": dict(skipped)}

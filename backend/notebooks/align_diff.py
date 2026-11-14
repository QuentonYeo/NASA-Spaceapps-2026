"""Step 4: put frames on one pixel grid, then difference like with like.

Run:  uv run python notebooks/align_diff.py   (from backend/)

Based on the IRSA "Source Discovery Tool" tutorial (reproject + subtract +
mask) and "SPHEREx Mosaic" (reproject onto a SPHEREx grid). Replaces its
`sep` background with a simple sigma-clipped median, and adds the
noise-normalised difference from our plan.

Every frame is reprojected onto ONE grid centred on the target (north up,
6.15"/pixel). Then blinking, stacking and differencing are just array maths,
and the browser can overlay every PNG with the same WCS.

The grid's pixel origin is TOP-LEFT (row 0 = north edge), as the shared
contract requires. So array[y, x], the PNG pixel and a Detection's (xPx, yPx)
are all the same numbers, with no flipping anywhere.
"""

import numpy as np
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.stats import sigma_clipped_stats
from astropy.wcs import WCS
from reproject import reproject_interp

from read_cutout import PIXEL_SCALE_ARCSEC, Cutout, bad_pixel_mask

# Frames are only compared when their wavelengths at the target differ by less
# than this. [DECIDE] the value: the bandwidth is ~0.04 um at 4.7 um (D6), and
# ~0.06 um at 2.4 um (D3).
MAX_DWAVE_UM = 0.05


def target_grid(coord: SkyCoord, fov: u.Quantity) -> tuple[WCS, tuple[int, int]]:
    """A north-up TAN grid centred on `coord` with SPHEREx-sized pixels, origin top-left."""
    n = (
        int(np.ceil(fov.to_value(u.arcsec) / PIXEL_SCALE_ARCSEC)) | 1
    )  # odd: target on a pixel centre
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [coord.ra.deg, coord.dec.deg]
    wcs.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]  # FITS pixels are 1-based
    wcs.wcs.cdelt = [
        -PIXEL_SCALE_ARCSEC / 3600,
        -PIXEL_SCALE_ARCSEC / 3600,
    ]  # RA increases to the left; Dec decreases down the rows (top-left origin)
    return wcs, (n, n)


def align(cutout: Cutout, grid: WCS, shape) -> tuple[np.ndarray, np.ndarray]:
    """Clean one frame and reproject it onto `grid`. Returns (image, variance).

    1. Subtract the zodi model: zodiacal light changes between visits and
       would otherwise dominate every difference image.
    2. Subtract any remaining local background (sigma-clipped median).
    3. Bad pixels -> NaN.
    4. Reproject. `reproject_interp` takes milliseconds on ~30x30 cutouts.
       `reproject_exact` conserves flux but is much slower; use it for
       photometry, not for blinking. Interpolation grows each NaN slightly.
    """
    image = cutout.image - cutout.zodi
    _, median, _ = sigma_clipped_stats(image)
    image = image - median

    bad = bad_pixel_mask(cutout.flags, cutout.flag_bits)
    image = np.where(bad, np.nan, image)
    variance = np.where(bad, np.nan, cutout.variance)

    image, _ = reproject_interp((image, cutout.wcs), grid, shape_out=shape)
    variance, _ = reproject_interp((variance, cutout.wcs), grid, shape_out=shape)
    return image, variance


def closest_pair(
    cutouts_a: list[Cutout], cutouts_b: list[Cutout], max_dwave_um: float = MAX_DWAVE_UM
):
    """Indexes (i, j) of the frames from two visits with the closest wavelength.

    Like with like: same detector is assumed by the caller. Returns None if no
    pair is within `max_dwave_um`. Otherwise the difference image would light
    up every star just because of the colour change.
    """
    dwave = np.abs(
        np.subtract.outer(
            [c.wavelength_um for c in cutouts_a], [c.wavelength_um for c in cutouts_b]
        )
    )
    i, j = np.unravel_index(np.argmin(dwave), dwave.shape)
    return (i, j) if dwave[i, j] <= max_dwave_um else None


def significance(image_a, var_a, image_b, var_b) -> np.ndarray:
    """(B - A) / sqrt(varA + varB): change in units of the noise (sigma).

    |value| > ~5 is a real change. A mover shows as a +/- pair (dipole).
    PSF matching (Phase 3) and blob detection come later.
    """
    return (image_b - image_a) / np.sqrt(var_a + var_b)


if __name__ == "__main__":
    from astropy.table import Table

    from fetch_cutouts import fetch_many
    from find_frames import OUTPUT_DIR

    # The challenge coordinates for WISE 0855 date from ~2010 (AllWISE). It
    # moves ~8"/yr west, so by 2025-26 it is ~2' west of this point: outside
    # a 3' box. Fast movers need their position propagated to each frame's
    # date (Phase 4, known objects). Here we just use a wider field.
    target = SkyCoord(133.79513, -7.24515, unit="deg")
    fov = 6 * u.arcmin
    frames = Table.read(OUTPUT_DIR / "frames_wise0855.ecsv")

    # WISE 0855 is a very cold brown dwarf: nearly invisible below 3 um,
    # bright near 4.5 um. So use D6 (4.42-5.00 um), first and last visits.
    first, last = frames["visit"].min(), frames["visit"].max()
    d6 = frames[frames["detector"] == "SPHEREx-D6"]
    rows_a, rows_b = d6[d6["visit"] == first], d6[d6["visit"] == last]

    # S3 avoids loading IRSA's cutout servers (see fetch_cutouts.py).
    cutouts_a = fetch_many(list(rows_a["url"]), target, fov, method="s3")
    cutouts_b = fetch_many(list(rows_b["url"]), target, fov, method="s3")
    print(
        f"visit {first}: {len(cutouts_a)} frames, visit {last}: {len(cutouts_b)} frames"
    )

    pair = closest_pair(cutouts_a, cutouts_b)
    if pair is None:
        raise SystemExit(f"no frame pair within {MAX_DWAVE_UM} um")
    a, b = cutouts_a[pair[0]], cutouts_b[pair[1]]
    print(
        f"pair: {a.wavelength_um:.3f} um (MJD {a.mjd:.1f}) vs "
        f"{b.wavelength_um:.3f} um (MJD {b.mjd:.1f})"
    )

    grid, shape = target_grid(target, fov)
    image_a, var_a = align(a, grid, shape)
    image_b, var_b = align(b, grid, shape)
    sig = significance(image_a, var_a, image_b, var_b)

    # Strongest changes in the field. A mover shows as a +/- pair. In our run
    # (Nov 2026) the top pixels were a dip in ONE frame (an artifact), and
    # WISE 0855 itself was below ~3 sigma in single 5 um frames. Hence the
    # plan's Phase 3: stack each visit and require a change in >= 2 frames.
    print(f"grid {shape}; |sig| > 5 in {(np.abs(sig) > 5).sum()} px. Strongest:")
    for k in np.argsort(np.nan_to_num(np.abs(sig)).ravel())[::-1][:5]:
        y, x = np.unravel_index(k, shape)
        sky = grid.pixel_to_world(x, y)
        print(
            f"  pixel ({x}, {y})  {sig[y, x]:+.1f} sigma  "
            f"RA {sky.ra.deg:.4f} Dec {sky.dec.deg:.4f}  A {image_a[y, x]:+.3f}  B {image_b[y, x]:+.3f}"
        )

    # Keep the aligned frames for render_png.py.
    aligned = [align(c, grid, shape)[0] for c in cutouts_a + cutouts_b]
    np.savez_compressed(
        OUTPUT_DIR / "aligned_wise0855_d6.npz",
        frames=np.array(aligned),
        mjd=[c.mjd for c in cutouts_a + cutouts_b],
        wavelength_um=[c.wavelength_um for c in cutouts_a + cutouts_b],
        significance=sig,
        grid_header=grid.to_header_string(),
    )
    print(f"saved {OUTPUT_DIR / 'aligned_wise0855_d6.npz'}")

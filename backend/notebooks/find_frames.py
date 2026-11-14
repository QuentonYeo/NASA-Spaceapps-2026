"""Step 1: find every SPHEREx frame that covers a sky position.

Run:  uv run python notebooks/find_frames.py   (from backend/)

Based on the IRSA "SPHEREx Intro" and "SPHEREx Cutouts" tutorials, cut down to
what the `resolve` and `discover` services need.

Two ways to search IRSA:
- SIA (`Irsa.query_sia`): simple, returns ~50 standard ObsCore columns
  including `cloud_access` (the S3 path). Lags new data by ~1 day.
- TAP (`Irsa.query_tap`) with ADQL against the `spherex.*` tables: we pick only
  the columns we need, it sees new data immediately, and we can join/filter
  freely. We use TAP.

Measured for WISE 0855 (Nov 2026): 258 frames, 6 detectors, 4 visits, ~8 s.
That latency is why frame lists must be cached (short TTL, data arrives weekly).
"""

from pathlib import Path

import numpy as np
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.table import Table
from astroquery.ipac.irsa import Irsa

# The release is configuration, never hard-coded deeper in the code.
# Available spectral-image collections: spherex_dr1, spherex_dr1_deep,
# spherex_qr3, spherex_qr3_deep. DR1 reprocesses QR3 into one uniform dataset,
# so we query only DR1 to avoid duplicate frames. (List them live with
# `Irsa.list_collections(servicetype='SIA', filter='spherex')`.)
COLLECTIONS = ("spherex_dr1",)

# A new "visit" starts when consecutive frames are more than this many days
# apart. Visits are bursts of exposures over a few days, ~6 months apart.
VISIT_GAP_DAYS = 10

OUTPUT_DIR = Path(__file__).parent / "output"


def resolve(name: str) -> SkyCoord:
    """Object name -> ICRS position, via CDS Sesame. Cache results in the app."""
    return SkyCoord.from_name(name)


def find_frames(coord: SkyCoord, collections=COLLECTIONS) -> Table:
    """Return one row per SPHEREx spectral image whose footprint contains `coord`.

    Tables (from TAP_SCHEMA):
    - spherex.plane       one row per image: footprint (`poly`), times, detector
    - spherex.artifact    the file for each plane: `uri` (path on IRSA)
    - spherex.observation the collection the image belongs to
    """
    ra, dec = coord.icrs.ra.deg, coord.icrs.dec.deg
    collection_list = ", ".join(f"'{c}'" for c in collections)
    # IRSA's ADQL parser rejects SQL "--" comments, so notes go here:
    # - frame_id: stable ID, e.g. ivo://irsa.ipac/spherex_dr1?2025W19_1B_0116_1/D3
    # - detector: 'SPHEREx-D1' .. 'SPHEREx-D6'
    # - wave_min_m / wave_max_m: range of the WHOLE detector in metres, not
    #   the wavelength at our target (that needs the file, see read_cutout.py)
    query = f"""
    SELECT
        a.uri,
        p.obs_publisher_did   AS frame_id,
        p.energy_bandpassname AS detector,
        p.time_bounds_lower   AS mjd_start,
        p.time_bounds_upper   AS mjd_end,
        p.energy_bounds_lower AS wave_min_m,
        p.energy_bounds_upper AS wave_max_m,
        p.provenance_version  AS version,
        o.collection
    FROM spherex.artifact a
    JOIN spherex.plane p       ON a.planeid = p.planeid
    JOIN spherex.observation o ON p.obsid = o.obsid
    WHERE 1 = CONTAINS(POINT('ICRS', {ra}, {dec}), p.poly)
      AND o.collection IN ({collection_list})
    ORDER BY p.time_bounds_lower
    """
    return Irsa.query_tap(query).to_table()


def add_visits(frames: Table, gap_days: float = VISIT_GAP_DAYS) -> Table:
    """Label frames with a visit number (0, 1, 2, ...). Frames must be time-sorted."""
    mjd = np.asarray(frames["mjd_start"], dtype=float)  # TAP columns come back masked
    new_visit = np.diff(mjd, prepend=mjd[0]) > gap_days
    frames["visit"] = np.cumsum(new_visit)
    return frames


def cutout_url(uri: str, coord: SkyCoord, size: u.Quantity) -> str:
    """IRSA cutout service URL: the file URL plus ?center=<ra>,<dec>d&size=<deg>."""
    return (
        f"https://irsa.ipac.caltech.edu/{uri}"
        f"?center={coord.ra.deg},{coord.dec.deg}d&size={size.to_value(u.deg)}"
    )


def s3_path(uri: str) -> str:
    """Same file in the public AWS bucket (anonymous access, us-east-1).

    The TAP `uri` and the S3 key share a suffix:
      ibe/data/spherex/dr1/level2/...fits  ->  s3://nasa-irsa-spherex/dr1/level2/...fits
    (Checked against SIA's `cloud_access` column.)
    """
    return "s3://nasa-irsa-spherex/" + uri.removeprefix("ibe/data/spherex/")


if __name__ == "__main__":
    # WISE 0855-0714, coordinates from the challenge page.
    target = SkyCoord(133.79513, -7.24515, unit="deg")

    frames = add_visits(find_frames(target))
    print(f"{len(frames)} frames")

    # Frames per visit and detector: like-with-like comparisons happen
    # within one detector, so this tells us how many usable pairs exist.
    summary = frames.group_by(["visit", "detector"])
    for key, group in zip(summary.groups.keys, summary.groups):
        print(
            f"visit {key['visit']}  {key['detector']}  {len(group):3d} frames  "
            f"MJD {group['mjd_start'].min():.1f}-{group['mjd_start'].max():.1f}"
        )

    # Save for the next scripts so they don't re-query IRSA.
    OUTPUT_DIR.mkdir(exist_ok=True)
    out = OUTPUT_DIR / "frames_wise0855.ecsv"
    frames.write(out, overwrite=True)
    print(f"saved {out}")

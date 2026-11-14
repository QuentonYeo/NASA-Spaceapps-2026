"""Small on-demand reference catalogue for the aligned viewer."""
import csv
import math

import httpx

from app.domain.errors import AppError
from app.domain.models import Region

TAP_URL = "https://gea.esac.esa.int/tap-server/tap/sync"
SOURCE_LIMIT = 150
MOTION_MARGIN_DEG = 0.03


def query_gaia(region: Region) -> dict:
    radius = region.fov / math.sqrt(2) + MOTION_MARGIN_DEG
    query = f"""
        SELECT TOP {SOURCE_LIMIT + 1}
            source_id, ra, dec, ref_epoch, pmra, pmdec, phot_g_mean_mag
        FROM gaiadr3.gaia_source
        WHERE 1 = CONTAINS(POINT('ICRS', ra, dec),
                          CIRCLE('ICRS', {region.ra}, {region.dec}, {radius}))
          AND phot_g_mean_mag IS NOT NULL
        ORDER BY phot_g_mean_mag, source_id
    """
    try:
        response = httpx.post(TAP_URL, data={
            "REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query,
        }, timeout=12)
        response.raise_for_status()
        reader = csv.DictReader(response.text.splitlines())
        if not reader.fieldnames or "source_id" not in reader.fieldnames:
            raise ValueError("Missing Gaia CSV columns")
        sources = []
        for row in reader:
            source = {
                "sourceId": row["source_id"],
                "ra": float(row["ra"]), "dec": float(row["dec"]),
                "refEpoch": float(row["ref_epoch"]),
                "gMagnitude": float(row["phot_g_mean_mag"]),
            }
            for output, column in (("pmRa", "pmra"), ("pmDec", "pmdec")):
                value = float(row[column]) if row[column] else math.nan
                source[output] = value if math.isfinite(value) else None
            if all(math.isfinite(source[key]) for key in ("ra", "dec", "refEpoch", "gMagnitude")):
                sources.append(source)
        return {"sources": sources[:SOURCE_LIMIT], "limited": len(sources) > SOURCE_LIMIT}
    except (httpx.HTTPError, KeyError, TypeError, ValueError, csv.Error) as exc:
        raise AppError("GAIA_UNAVAILABLE", "Gaia reference stars are temporarily unavailable.", 502, True) from exc

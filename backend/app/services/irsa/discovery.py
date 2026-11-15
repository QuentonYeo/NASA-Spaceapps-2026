import math
import time
import requests
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.time import Time
from pyvo.dal.sia2 import SIA2Query
from app.domain.errors import AppError
from app.domain.models import Exposure, Region
from app.services.irsa.retries import read_with_retries


IRSA_SIA_ENDPOINT = "https://irsa.ipac.caltech.edu/SIA"


class DeadlineSession(requests.Session):
    def __init__(self, remaining):
        super().__init__()
        self.end = time.monotonic() + remaining

    def request(self, method, url, **kwargs):
        remaining = self.end - time.monotonic()
        if remaining <= 0:
            raise requests.Timeout("Archive deadline exceeded")
        kwargs["timeout"] = min(25, remaining)
        return super().request(method, url, **kwargs)


class IrsaArchive:
    def __init__(self, collections=("spherex_dr1",)):
        self.collections = collections

    def discover(self, region: Region, *, collections: tuple[str, ...] | None = None) -> list[Exposure]:
        coord = SkyCoord(region.ra, region.dec, unit="deg")

        def query(remaining):
            # IRSA publishes this query URL directly. Avoid a separate capabilities
            # request, which can fail even while exposure searches are working.
            with DeadlineSession(remaining) as session:
                return [
                    SIA2Query(IRSA_SIA_ENDPOINT, pos=(coord, 1 * u.arcsec),
                              collection=collection, session=session).execute().to_table()
                    for collection in dict.fromkeys(collections or self.collections)
                ]

        try:
            tables = read_with_retries(query)
        except AppError as exc:
            raise AppError(exc.code, f"IRSA exposure lookup failed. {exc.message}",
                           exc.status, exc.retryable, exc.retry_after) from exc
        result = []
        try:
            for table in tables:
                for row in table:
                    mjd = float(row["t_min"])
                    if not math.isfinite(mjd):
                        raise ValueError("Invalid observation time")
                    observed = Time(mjd, format="mjd", scale="utc").isot + "Z"
                    result.append(Exposure(str(row["obs_publisher_did"]), str(row["access_url"]),
                        mjd, observed, str(row["obs_collection"]), str(row["energy_bandpassname"])))
        except (ValueError, TypeError, KeyError) as exc:
            raise AppError("ARCHIVE_RESPONSE_INVALID", "The archive returned invalid frame metadata.") from exc
        return result

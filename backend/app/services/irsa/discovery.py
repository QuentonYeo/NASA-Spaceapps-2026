import math
import time
import requests
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.time import Time
from astroquery.ipac.irsa import IrsaClass
from app.domain.errors import AppError
from app.domain.models import Exposure, Region
from app.services.irsa.retries import read_with_retries


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

    def discover(self, region: Region) -> list[Exposure]:
        # A separate client per operation avoids shared timeout/session mutations.
        def query(remaining):
            client = IrsaClass()
            client._session.close()
            client._session = DeadlineSession(remaining)
            coord = SkyCoord(region.ra, region.dec, unit="deg")
            try:
                return [client.query_sia(pos=(coord, 1 * u.arcsec), collection=c)
                        for c in self.collections]
            finally:
                client._session.close()
        tables = read_with_retries(query)
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

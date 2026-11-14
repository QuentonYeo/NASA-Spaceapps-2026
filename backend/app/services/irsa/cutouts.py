import time
import httpx
from app.domain.errors import AppError
from app.domain.models import Exposure, Region
from app.services.irsa.retries import read_with_retries


class IrsaCutouts:
    def __init__(self, max_bytes=32 * 1024 * 1024, *, client=None, connections=8):
        self.max_bytes = max_bytes
        self._owns_client = client is None
        self.client = client or httpx.Client(
            limits=httpx.Limits(max_connections=connections,
                               max_keepalive_connections=connections, keepalive_expiry=5),
            follow_redirects=False)

    def close(self):
        if self._owns_client:
            self.client.close()

    def fetch(self, exposure: Exposure, region: Region) -> bytes:
        # Only fetch the expected archive host, even if bad metadata is returned.
        url = httpx.URL(exposure.url)
        if url.scheme != "https" or url.host != "irsa.ipac.caltech.edu":
            raise AppError("ARCHIVE_RESPONSE_INVALID", "The archive returned an invalid source URL.")
        def download(remaining):
            end = time.monotonic() + remaining
            params = {"center": f"{region.ra},{region.dec}d", "size": str(region.fov)}
            timeout = httpx.Timeout(connect=min(10, remaining), read=min(25, remaining),
                                    write=min(10, remaining), pool=min(5, remaining))
            with self.client.stream("GET", url, params=params, timeout=timeout) as response:
                response.raise_for_status()
                chunks, size = [], 0
                for chunk in response.iter_bytes():
                    if time.monotonic() >= end:
                        raise httpx.ReadTimeout("Cutout deadline exceeded")
                    size += len(chunk)
                    if size > self.max_bytes:
                        raise AppError("CUTOUT_TOO_LARGE", "The archive cutout exceeds the size limit.")
                    chunks.append(chunk)
                return b"".join(chunks)
        return read_with_retries(download)

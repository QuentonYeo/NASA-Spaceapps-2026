"""Anonymous S3 range reads; returns a small IMAGE-only FITS for preview rendering."""
import io
import math
import httpx
import numpy as np
import s3fs
from astropy.io import fits
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales
from botocore.exceptions import BotoCoreError, ClientError
from app.domain.errors import AppError
from app.domain.models import Exposure, Region


class S3Cutouts:
    def __init__(self, *, filesystem=None, connections=8):
        # Botocore owns retries here; do not nest the HTTP retry policy around it.
        self.fs = filesystem or s3fs.S3FileSystem(
            anon=True, skip_instance_cache=True,
            default_block_size=512 * 1024, default_cache_type="blockcache",
            client_kwargs={"region_name": "us-east-1"},
            config_kwargs={"connect_timeout": 10, "read_timeout": 25,
                           "max_pool_connections": connections,
                           "retries": {"mode": "standard", "total_max_attempts": 3}})

    def close(self):
        # s3fs uses an async session with its own synchronous finalizer.
        if getattr(self.fs, "_s3", None) is not None:
            self.fs.close_session(self.fs.loop, self.fs._s3)

    def fetch(self, exposure: Exposure, region: Region) -> bytes:
        url = httpx.URL(exposure.url)
        prefix = "/ibe/data/spherex/"
        if url.scheme != "https" or url.host != "irsa.ipac.caltech.edu" or not url.path.startswith(prefix):
            raise AppError("ARCHIVE_RESPONSE_INVALID", "The archive returned an invalid S3 source URL.")
        key = "nasa-irsa-spherex/" + url.path.removeprefix(prefix)
        try:
            with self.fs.open(key, "rb") as remote:
                with fits.open(remote, memmap=False, lazy_load_hdus=True) as hdus:
                    hdu = hdus["IMAGE"]
                    image_header = hdu.header
                    wcs = WCS(hdu.header).celestial
                    x, y = wcs.world_to_pixel_values(region.ra, region.dec)
                    if not np.isfinite([x, y]).all():
                        raise ValueError("Invalid center")
                    scales = np.abs(proj_plane_pixel_scales(wcs))
                    width, height = [max(1, int(round(region.fov / s))) for s in scales]
                    if max(width, height) > 2048:
                        raise AppError("CUTOUT_TOO_LARGE", "Requested cutout exceeds the pixel limit.")
                    ny, nx = hdu.shape
                    x0, y0 = math.ceil(x - width / 2), math.ceil(y - height / 2)
                    x1, y1 = min(nx, x0 + width), min(ny, y0 + height)
                    x0, y0 = max(0, x0), max(0, y0)
                    if x1 <= x0 or y1 <= y0:
                        raise ValueError("No coverage at requested center")
                    # .section performs range reads, unlike .data which loads the entire image.
                    data = np.array(hdu.section[y0:y1, x0:x1], copy=True)
                    header = wcs.slice((slice(y0, y1), slice(x0, x1))).to_header(relax=True)
                    if "BUNIT" in image_header:
                        header["BUNIT"] = image_header["BUNIT"]
                    output = io.BytesIO()
                    fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(data, header, name="IMAGE")]).writeto(output)
                    return output.getvalue()
        except AppError:
            raise
        except ClientError as exc:
            status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)
            transient = status in {429, 500, 502, 503, 504}
            raise AppError("ARCHIVE_UNAVAILABLE" if transient else "ARCHIVE_ERROR",
                           "S3 cutout retrieval failed.", 503 if transient else 502, transient,
                           5 if transient else None) from exc
        except (TimeoutError, BotoCoreError) as exc:
            raise AppError("ARCHIVE_TIMEOUT", "S3 cutout retrieval timed out or disconnected.", 504, True, 5) from exc
        except (OSError, ValueError, KeyError) as exc:
            raise AppError("CUTOUT_INVALID", "S3 cutout could not be read.") from exc

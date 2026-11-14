import base64
import io
import time

import httpx
import numpy as np
import pytest
from astropy.io import fits
from fastapi.testclient import TestClient
from PIL import Image
from pyvo.dal.exceptions import DALServiceError

from app.domain.errors import AppError
from app.domain.models import Exposure, Region
from app.main import create_app
from app.services.frames import FramesService
from app.services.irsa.cutouts import IrsaCutouts
from app.services.irsa.retries import read_with_retries, retry_after
from app.services.jobs import LocalJobs
from app.services.rendering import FitsRenderer


def exposure(id="one", mjd=60000):
    return Exposure(id, "https://irsa.ipac.caltech.edu/ibe/data/test.fits", mjd,
                    "2023-02-25T00:00:00Z", "spherex_dr1", "SPHEREx-D3")


def cutout():
    output = io.BytesIO()
    fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(
        np.array([[1., 2.], [3., np.nan]]), name="IMAGE")]).writeto(output)
    return output.getvalue()


class Archive:
    def __init__(self, frames):
        self.frames = frames
    def discover(self, region):
        return self.frames


class Cutouts:
    def fetch(self, frame, region):
        if frame.id == "bad":
            raise AppError("ARCHIVE_UNAVAILABLE", "Archive busy", 503, True, 5)
        return cutout()


@pytest.fixture
def service():
    jobs = LocalJobs()
    service = FramesService(Archive([]), Cutouts(), FitsRenderer(), jobs)
    yield service
    jobs.close()


def completed(service, id):
    # Bounded wait only for local executor scheduling; never contacts IRSA.
    for _ in range(200):
        page = service.poll(id, 0)
        if page["status"] in {"completed", "partial", "failed"}:
            return page
        time.sleep(.005)
    pytest.fail("Local job did not finish")


def test_end_to_end_polling_dedup_visits_and_partial_failure(service):
    service.archive = Archive([exposure("one"), exposure("one"),
        exposure("two", 60010), exposure("bad", 60021)])
    with TestClient(create_app(service)) as client:
        response = client.post("/api/frames", json={"ra": 133.79513, "dec": -7.24515, "fov": .05})
        assert response.status_code == 202
        id = response.json()["sequenceId"]
        completed(service, id)
        response = client.get(response.headers["location"])
        assert response.status_code == 200
        page = response.json()
        assert page["status"] == "partial"
        assert page["progress"] == {"total": 3, "ready": 2, "failed": 1}
        frames = {f["id"]: f for f in page["frames"]}
        assert frames["one"]["visit"] == frames["two"]["visit"] == 0
        assert frames["bad"]["visit"] == 1
        assert frames["bad"]["error"]["retryable"]
        assert frames["one"]["imageData"].startswith("data:image/png;base64,")
        assert client.get(f"/api/frames/{id}?after={page['nextCursor']}").json()["frames"] == []
        assert client.get(f"/api/frames/{id}").json()["frames"] == page["frames"]
        assert client.get(f"/api/frames/{id}?after=100").status_code == 400


@pytest.mark.parametrize("body", [
    {}, {"ra": 360, "dec": 0, "fov": .1}, {"ra": 0, "dec": -91, "fov": .1},
    {"ra": 0, "dec": 0, "fov": 0}, {"ra": 0, "dec": 0, "fov": 2},
    {"ra": "NaN", "dec": 0, "fov": .1}, {"ra": 0, "dec": 0, "fov": .1, "extra": 1}])
def test_invalid_requests(service, body):
    with TestClient(create_app(service)) as client:
        response = client.post("/api/frames", json=body)
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "VALIDATION_ERROR"


def test_empty_limit_and_discovery_failure(service):
    region = Region(0, 0, .1)
    assert completed(service, service.start(region)["sequenceId"])["status"] == "completed"
    service.max_frames = 1
    service.archive = Archive([exposure("one"), exposure("two")])
    assert completed(service, service.start(region)["sequenceId"])["error"]["code"] == "FRAME_LIMIT_EXCEEDED"
    class Broken:
        def discover(self, region):
            raise AppError("ARCHIVE_UNAVAILABLE", "Busy", 503, True)
    service.archive = Broken()
    assert completed(service, service.start(region)["sequenceId"])["error"]["code"] == "ARCHIVE_UNAVAILABLE"


def test_capacity_expiry_and_missing(service):
    with TestClient(create_app(service)) as client:
        assert client.get("/api/frames/missing").status_code == 404
        service.jobs.max_jobs = 0
        response = client.post("/api/frames", json={"ra": 0, "dec": 0, "fov": .1})
        assert response.status_code == 503
        assert response.headers["retry-after"] == "30"
        service.jobs.max_jobs = 8
        id = service.start(Region(0, 0, .1))["sequenceId"]
        completed(service, id)
        service.jobs.get(id).finished = time.monotonic() - 2000
        assert client.get(f"/api/frames/{id}").status_code == 410


def http_error(status, headers=None):
    response = httpx.Response(status, headers=headers, request=httpx.Request("GET", "https://example.org"))
    return httpx.HTTPStatusError("upstream", request=response.request, response=response)


@pytest.mark.parametrize("status", [429, 502, 503, 504])
def test_retry_statuses_recover(status):
    calls, sleeps = [], []
    def operation(remaining):
        calls.append(remaining)
        if len(calls) < 3:
            raise http_error(status)
        return "ok"
    assert read_with_retries(operation, sleep=sleeps.append, jitter=lambda: 0) == "ok"
    assert sleeps == [1, 2]


def test_retry_after_exhaustion_and_permanent_error():
    calls, sleeps = [], []
    def busy(remaining):
        calls.append(1)
        raise http_error(503, {"Retry-After": "2"})
    with pytest.raises(AppError) as error:
        read_with_retries(busy, sleep=sleeps.append)
    assert len(calls) == 3 and sleeps == [2, 2]
    assert error.value.status == 503
    calls.clear()
    with pytest.raises(AppError):
        read_with_retries(busy, deadline=1, sleep=sleeps.append)
    assert len(calls) == 1
    def permanent(remaining):
        raise http_error(404)
    with pytest.raises(AppError) as error:
        read_with_retries(permanent, sleep=lambda _: pytest.fail("Should not retry"))
    assert error.value.status == 502 and not error.value.retryable
    assert retry_after("invalid") is None
    assert retry_after("Wed, 21 Oct 2015 07:28:00 GMT") == 0


def test_timeout_and_wrapped_sia_error():
    def timeout(remaining):
        raise httpx.ReadTimeout("read")
    with pytest.raises(AppError) as error:
        read_with_retries(timeout, sleep=lambda _: None)
    assert error.value.status == 504
    def wrapped(remaining):
        raise DALServiceError("Server busy", code=503)
    with pytest.raises(AppError) as error:
        read_with_retries(wrapped, sleep=lambda _: None)
    assert error.value.status == 503


def test_renderer_transparency_and_invalid_fits():
    result = FitsRenderer().render(cutout())
    png = base64.b64decode(result["imageData"].split(",", 1)[1])
    image = Image.open(io.BytesIO(png))
    assert image.size == (2, 2)
    assert image.getpixel((1, 1))[3] == 0
    assert not result["display"]["aligned"]
    with pytest.raises(AppError):
        FitsRenderer().render(b"Server busy")


def test_cutout_location_and_retry(monkeypatch):
    requests = []
    def handler(request):
        requests.append(request)
        if len(requests) == 1:
            return httpx.Response(503, headers={"Retry-After": "0"})
        return httpx.Response(200, content=cutout())
    original = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kwargs: original(
        transport=httpx.MockTransport(handler), **kwargs))
    payload = IrsaCutouts().fetch(exposure(), Region(133, -7, .05))
    assert payload.startswith(b"SIMPLE")
    assert requests[-1].url.params["center"] == "133,-7d"
    assert requests[-1].url.params["size"] == "0.05"
    with pytest.raises(AppError):
        IrsaCutouts(max_bytes=1).fetch(exposure(), Region(0, 0, .1))


def test_paginated_results(service):
    service.archive = Archive([exposure(str(i)) for i in range(12)])
    id = service.start(Region(0, 0, .1))["sequenceId"]
    page = completed(service, id)
    assert len(page["frames"]) == 10 and page["hasMore"]
    last = service.poll(id, page["nextCursor"])
    assert len(last["frames"]) == 2 and not last["hasMore"]


def test_pooled_client_timeouts_and_reuse():
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(200, content=cutout())
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        provider = IrsaCutouts(client=client)
        for _ in range(2):
            assert provider.fetch(exposure(), Region(0, 0, .05)).startswith(b"SIMPLE")
        provider.close()
        assert not client.is_closed  # Injected clients remain caller-owned.
    assert len(requests) == 2
    assert requests[0].extensions["timeout"] == {"connect": 10, "read": 25, "write": 10, "pool": 5}


def test_pool_exhaustion_is_local_capacity():
    def exhausted(remaining):
        raise httpx.PoolTimeout("All connections busy")
    with pytest.raises(AppError) as error:
        read_with_retries(exhausted, sleep=lambda _: pytest.fail("Do not retry local contention"))
    assert error.value.code == "CUTOUT_CAPACITY_REACHED"


def test_s3_range_cutout_and_source_validation():
    from astropy.wcs import WCS
    from app.services.irsa.s3_cutouts import S3Cutouts
    wcs = WCS(naxis=2)
    wcs.wcs.crpix = [51, 51]
    wcs.wcs.cdelt = [-.001, .001]
    wcs.wcs.crval = [133, -7]
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    source = io.BytesIO()
    fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(
        np.arange(10000).reshape(100, 100), wcs.to_header(), name="IMAGE")]).writeto(source)
    class Filesystem:
        def open(self, key, mode):
            assert key == "nasa-irsa-spherex/dr1/level2/test.fits"
            return io.BytesIO(source.getvalue())
    provider = S3Cutouts(filesystem=Filesystem())
    frame = Exposure("s3", "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/test.fits",
                     60000, "2023-02-25T00:00:00Z", "spherex_dr1", "SPHEREx-D3")
    data = provider.fetch(frame, Region(133, -7, .01))
    with fits.open(io.BytesIO(data)) as result:
        assert result["IMAGE"].data.shape == (10, 10)
        assert np.array_equal(result["IMAGE"].data, np.arange(10000).reshape(100, 100)[45:55, 45:55])
    assert FitsRenderer().render(data)["grid"]["width"] == 10
    with pytest.raises(AppError):
        provider.fetch(exposure(), Region(133, -7, .01))


def test_explicit_batches_do_not_prefetch_or_duplicate(service):
    service.batch_size = 2
    service.archive = Archive([exposure(str(i), 60000 + i * 11) for i in range(5)])
    fetched = []
    class RecordingCutouts:
        def fetch(self, frame, region):
            fetched.append(frame.id)
            return cutout()
    service.cutouts = RecordingCutouts()
    def wait_batch(id):
        for _ in range(200):
            result = service.poll(id, 0)
            if result["status"] in {"awaiting_more", "completed"}:
                return result
            time.sleep(.005)
        pytest.fail("Batch did not finish")
    with TestClient(create_app(service)) as client:
        accepted = client.post("/api/frames", json={"ra": 0, "dec": 0, "fov": .05}).json()
        id = accepted["sequenceId"]
        first = wait_batch(id)
        assert first["status"] == "awaiting_more" and len(fetched) == 2
        assert first["scheduledCount"] == 2 and first["remaining"] == 3
        url = f"/api/frames/{id}/batches"
        assert client.post(url, json={"after": 3}).status_code == 409
        assert client.post(url, json={"after": 2}).status_code == 202
        assert client.post(url, json={"after": 2}).status_code == 202
        second = wait_batch(id)
        assert second["scheduledCount"] == 4 and len(fetched) == 4
        assert client.post(url, json={"after": 4}).status_code == 202
        final = wait_batch(id)
        assert final["status"] == "completed" and len(fetched) == 5
        assert final["remaining"] == 0 and len(set(fetched)) == 5
        assert sorted(f["visit"] for f in final["frames"]) == [0, 1, 2, 3, 4]
        assert client.post(url, json={"after": 5}).status_code == 409


def test_aligned_preview_registers_shifted_exposures_and_preserves_mask():
    from astropy.wcs import WCS

    region = Region(210.8, 54.3, 9 * 6.15 / 3600)
    renderer = FitsRenderer()
    aligned = []
    for shift in (0, 2):
        wcs = WCS(naxis=2)
        wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
        wcs.wcs.crval = [region.ra, region.dec]
        wcs.wcs.crpix = [5 + shift, 5]
        wcs.wcs.cdelt = [-6.15 / 3600, 6.15 / 3600]
        data = np.zeros((9, 9))
        data[2, 4 + shift] = 10
        data[5, 3 + shift] = np.nan
        output = io.BytesIO()
        fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(data, wcs.to_header(), name="IMAGE")]).writeto(output)
        preview = renderer.preview(renderer.prepare(output.getvalue(), region), (0, 10))
        assert preview["alignedGrid"] == {"width": 9, "height": 9, "orientation": "north-up"}
        png = base64.b64decode(preview["alignedImageData"].split(",", 1)[1])
        aligned.append(np.array(Image.open(io.BytesIO(png))))
    for image in aligned:
        assert np.unravel_index(image[:, :, 0].argmax(), (9, 9)) == (6, 4)
        assert image[3, 3, 3] == 0
    assert aligned[1][4, 8, 3] == 0

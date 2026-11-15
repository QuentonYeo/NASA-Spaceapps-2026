import numpy as np
import pytest

from app.domain.models import Exposure, Region
from app.services.movers import detect_spots, link_tracks, prioritize_exposures
from app.services.rendering import PIXEL_SCALE_DEG, PreviewPixels, query_grid


def exposure(index, elapsed):
    return Exposure(f"frame-{index}", "", 60000 + elapsed, f"epoch-{index}", "spherex_dr1", "SPHEREx-D6")


@pytest.mark.parametrize("moves", [True, False])
def test_fits_detector_distinguishes_moving_and_stationary_sources(moves):
    side = 51
    region = Region(10, 5, side * PIXEL_SCALE_DEG)
    grid, _ = query_grid(region)
    rows, cols = np.indices((side, side))
    rng = np.random.default_rng(42)
    frames = []
    for index, shift in enumerate((0, 6, 12) if moves else (0, 0, 0)):
        data = rng.normal(0, .1, (side, side))
        data += 8 * np.exp(-((cols - 14 - shift) ** 2 + (rows - 23) ** 2) / 2)
        data += 10 * np.exp(-((cols - 35) ** 2 + (rows - 33) ** 2) / 2)
        valid = np.ones_like(data, dtype=bool)
        valid[21:23, 12 + shift:15 + shift] = False
        data[10, 10 + shift] = 99
        valid[10, 10 + shift] = False
        pixels = PreviewPixels(data, valid, (0, 10), "MJy/sr", 4.7, grid, region,
                               variance=np.full_like(data, .01))
        frames.append(detect_spots(exposure(index, index / 2), pixels, region))

    tracks, comparable = link_tracks(frames, region)
    assert comparable
    if moves:
        assert len(tracks) == 1
        assert tracks[0]["displacementArcsec"] == pytest.approx(73.8)
        assert [p["frameId"] for p in tracks[0]["detections"]] == ["frame-0", "frame-1", "frame-2"]
    else:
        assert tracks == []


def test_prioritization_skips_near_duplicate_times():
    rows = [(exposure(i, dt), 0) for i, dt in enumerate((0, .001, .5, 1))]
    assert [item[0].id for item in prioritize_exposures(rows)] == [
        "frame-0", "frame-2", "frame-3", "frame-1",
    ]


def test_auto_observation_links_all_downloaded_batches_without_refetching(tmp_path):
    import io
    import time
    from dataclasses import replace

    from astropy.io import fits
    from fastapi.testclient import TestClient
    from app.main import create_app
    from app.services.frames import FramesService
    from app.services.jobs import LocalJobs
    from app.services.rendering import FitsRenderer
    from app.services.search_cache import SearchCache

    region = Region(10, 5, 51 * PIXEL_SCALE_DEG)
    grid, _ = query_grid(region)

    class Archive:
        def discover(self, requested):
            return [exposure(i, i / 2) for i in range(3)]

    class Cutouts:
        requests = []

        def fetch(self, frame, requested):
            self.requests.append(frame.id)
            rows, cols = np.indices((51, 51))
            offset = 6 * int(frame.id[-1])
            data = np.random.default_rng(42).normal(0, .1, (51, 51))
            data += 8 * np.exp(-((cols - 14 - offset) ** 2 + (rows - 23) ** 2) / 2)
            output = io.BytesIO()
            fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(data, grid.to_header(), name="IMAGE")]).writeto(output)
            return output.getvalue()

    class Renderer(FitsRenderer):
        def prepare(self, *args, **kwargs):
            return replace(super().prepare(*args, **kwargs), wavelength_um=4.7)

    cache = SearchCache(tmp_path / "searches.db", 4_000_000, 3600)
    jobs = LocalJobs(search_cache=cache)
    cutouts = Cutouts()
    service = FramesService(Archive(), cutouts, Renderer(), jobs, batch_size=1)
    try:
        with TestClient(create_app(service)) as client:
            result = client.post("/api/frames", json={"ra": region.ra, "dec": region.dec, "fov": region.fov})
            sequence_id = result.json()["sequenceId"]
            url = f"/api/frames/{sequence_id}"
            analysis_url = url + "/auto-observation"

            def wait_for(path, status):
                for _ in range(200):
                    state = client.get(path).json()
                    if state["status"] == status:
                        return state
                    time.sleep(.005)
                pytest.fail(f"{status} not reached: {state['status']}")

            wait_for(url, "awaiting_more")
            assert client.post(analysis_url).status_code == 409
            for offset in (1, 2):
                assert client.post(url + "/batches", json={"after": offset}).status_code == 202
                wait_for(url, "awaiting_more" if offset == 1 else "completed")
            restored = cache.load(sequence_id)
            assert restored is not None and len(restored.science) == 3
            jobs.items[sequence_id] = restored
            assert client.get(analysis_url).json()["status"] == "idle"
            assert client.post(analysis_url).status_code == 202
            result = wait_for(analysis_url, "completed")
            assert result["readyFrames"] == result["availableFrames"] == result["analyzedFrames"] == 3
            assert len(result["candidates"]) == 1
            assert client.post(analysis_url).json() == result
            assert client.post(analysis_url + "?rerun=true").json()["status"] == "running"
            assert wait_for(analysis_url, "completed") == result
            assert cutouts.requests == ["frame-0", "frame-1", "frame-2"]
        assert cache.load(sequence_id).observation == result
    finally:
        jobs.close()

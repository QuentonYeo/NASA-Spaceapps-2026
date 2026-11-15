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
                               np.full_like(data, .01))
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

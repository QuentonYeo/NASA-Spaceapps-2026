"""Bounded first-pass detection on calibrated, individual SPHEREx exposures."""
from bisect import bisect_left, bisect_right
from collections import defaultdict
from dataclasses import dataclass
from math import hypot

import numpy as np
from scipy.ndimage import convolve, maximum_filter, median_filter
from scipy.spatial import cKDTree

from app.domain.models import Exposure, Region
from app.services.rendering import PIXEL_SCALE_DEG, PreviewPixels, query_grid

MAX_SOURCES = 24
MIN_GAP_DAYS = 0.5 / 24
MAX_SPAN_DAYS = 2
LINK_RADIUS = 1.6


def prioritize_exposures(exposures: list[tuple[Exposure, int]]) -> list[tuple[Exposure, int]]:
    """Put comparable, well-spaced triples first using only archive metadata."""
    groups = defaultdict(list)
    for item in exposures:
        exposure, _ = item
        group = groups[(exposure.release, exposure.detector)]
        if not group or exposure.mjd - group[-1][0].mjd >= MIN_GAP_DAYS:
            group.append(item)
    triples = []
    for group in groups.values():
        for triple in zip(group, group[1:], group[2:]):
            a, b, c = (item[0].mjd for item in triple)
            if c - a <= MAX_SPAN_DAYS:
                # Prefer a spread of about a day and similar time between samples.
                cost = abs((c - a) - 1.0) + abs((b - a) - (c - b))
                triples.append((cost, triple[0][0].id, triple))
    ordered = {}
    for _, _, triple in sorted(triples):
        if any(item[0].id in ordered for item in triple):
            continue
        ordered.update((item[0].id, item) for item in triple)
    for item in exposures:
        ordered.setdefault(item[0].id, item)
    return list(ordered.values())


@dataclass(frozen=True)
class Spots:
    exposure: Exposure
    wavelength: float
    xy: np.ndarray
    snr: np.ndarray


def detect_spots(exposure: Exposure, pixels: PreviewPixels, region: Region) -> Spots | None:
    if pixels.wcs is None or pixels.wavelength_um is None or min(pixels.data.shape) < 7:
        return None
    valid = pixels.valid
    filled = np.where(valid, pixels.data, np.median(pixels.data[valid]))
    residual = filled - median_filter(filled, size=9)
    noise = max(1e-10, float(1.4826 * np.median(np.abs(residual[valid] - np.median(residual[valid])))))
    uncertainty = noise if pixels.variance is None else np.sqrt(np.maximum(
        np.where(valid, pixels.variance, 0), noise ** 2,
    ))
    snr_map = residual / uncertainty
    # A usable peak can sit near masked pixels, but needs enough surrounding
    # data to estimate its background. The peak itself must remain unmasked.
    neighbors = convolve(valid.astype(np.uint8), np.ones((5, 5), dtype=np.uint8),
                         mode="constant", cval=0)
    peaks = valid & (neighbors >= 15) & (snr_map >= 6)
    peaks &= residual == maximum_filter(residual, size=5)
    rows, cols = np.nonzero(peaks)
    order = np.argsort(-snr_map[rows, cols], kind="stable")[:MAX_SOURCES]
    rows, cols = rows[order], cols[order]
    grid, side = query_grid(region)
    x, y = grid.world_to_pixel(pixels.wcs.pixel_to_world(cols, rows))
    xy = np.column_stack((x + .5, side - .5 - y))
    inside = np.isfinite(xy).all(axis=1) & (xy >= 0).all(axis=1) & (xy < side).all(axis=1)
    return Spots(exposure, pixels.wavelength_um, xy[inside], snr_map[rows, cols][inside])


def link_tracks(spots: list[Spots], region: Region, *, limit: int | None = 10) -> tuple[list[dict], bool]:
    groups = defaultdict(list)
    for entry in sorted(spots, key=lambda entry: (entry.exposure.mjd, entry.exposure.id)):
        groups[(entry.exposure.release, entry.exposure.detector)].append(entry)
    ranked = []
    eligible = False
    grid, side = query_grid(region)
    for group in groups.values():
        trees = [cKDTree(frame.xy) for frame in group]
        times = [frame.exposure.mjd for frame in group]
        moving = []
        for index, frame in enumerate(group):
            matches = np.zeros(len(frame.xy), dtype=bool)
            for j, tree in enumerate(trees):
                gap = abs(times[index] - times[j])
                waves = (frame.wavelength, group[j].wavelength)
                if MIN_GAP_DAYS <= gap <= MAX_SPAN_DAYS and max(waves) <= 1.15 * min(waves):
                    matches |= tree.query(frame.xy)[0] <= LINK_RADIUS
            moving.append(~matches)

        def comparable_triples():
            for a, t0 in enumerate(times):
                first_middle = bisect_left(times, t0 + MIN_GAP_DAYS, a + 1)
                stop = bisect_right(times, t0 + MAX_SPAN_DAYS, first_middle)
                for b in range(first_middle, stop - 1):
                    first_last = bisect_left(times, times[b] + MIN_GAP_DAYS, b + 1, stop)
                    for c in range(first_last, stop):
                        waves = [group[i].wavelength for i in (a, b, c)]
                        if max(waves) <= 1.15 * min(waves):
                            yield a, b, c

        for a, b, c in comparable_triples():
            eligible = True
            if not all(moving[i].any() for i in (a, b, c)):
                continue
            first, middle, last = (group[i] for i in (a, b, c))
            t0, t1, t2 = (times[i] for i in (a, b, c))
            fraction = (t1 - t0) / (t2 - t0)
            endpoints = np.flatnonzero(moving[c])
            for i in np.flatnonzero(moving[a]):
                start = first.xy[i]
                ends = last.xy[endpoints]
                estimates = start + fraction * (ends - start)
                for j, endpoint in zip(trees[b].query_ball_point(estimates, LINK_RADIUS), endpoints):
                    finish = last.xy[endpoint]
                    displacement = hypot(*(finish - start))
                    if displacement < 3:
                        continue
                    prediction = start + fraction * (finish - start)
                    matches = [k for k in j if moving[b][k]]
                    if not matches:
                        continue
                    mid = min(matches, key=lambda k: hypot(*(middle.xy[k] - prediction)))
                    residual = hypot(*(middle.xy[mid] - prediction))
                    detections = []
                    for entry, spot in ((first, i), (middle, mid), (last, endpoint)):
                        x, y = map(float, entry.xy[spot])
                        detections.append({
                            "frameId": entry.exposure.id, "observedAtUtc": entry.exposure.observed_at,
                            "x": x, "y": y,
                            "signalToNoise": float(entry.snr[spot]),
                        })
                    strength = min(detection["signalToNoise"] for detection in detections)
                    ranked.append({
                        "detector": first.exposure.detector, "detections": detections,
                        "displacementArcsec": displacement * PIXEL_SCALE_DEG * 3600,
                        "elapsedHours": (t2 - t0) * 24, "residualPixels": residual,
                        "score": float(np.log1p(strength) / (1 + residual)),
                    })

    selected = []
    used = set()
    accepted_positions = []
    for track in sorted(ranked, key=lambda track: track["score"], reverse=True):
        keys = {(point["frameId"], point["x"], point["y"]) for point in track["detections"]}
        positions = {point["frameId"]: (point["x"], point["y"]) for point in track["detections"]}
        if keys & used or any(
            sum(hypot(positions[key][0] - other[key][0], positions[key][1] - other[key][1]) <= 4
                for key in positions.keys() & other.keys()) >= 2
            for other in accepted_positions
        ):
            continue
        used.update(keys)
        accepted_positions.append(positions)
        for point in track["detections"]:
            sky = grid.pixel_to_world(point["x"] - .5, side - .5 - point["y"])
            point.update(ra=float(sky.ra.deg), dec=float(sky.dec.deg))
        selected.append(track)
        if limit is not None and len(selected) >= limit:
            break
    return selected, eligible

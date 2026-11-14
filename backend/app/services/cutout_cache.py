"""Bounded, process-local cache of archive FITS cutouts."""
from collections import OrderedDict
from threading import Lock

from app.domain.errors import AppError
from app.domain.models import Exposure, Region
from app.services.interfaces import Cutouts, Renderer
from app.services.rendering import CutoutCoverageMiss, PreviewPixels


class CutoutCache:
    def __init__(self, max_bytes: int):
        if max_bytes < 0:
            raise ValueError("Cutout cache size must be nonnegative")
        self.max_bytes = max_bytes
        self.size = 0
        self.entries: OrderedDict[tuple[str, str, Region], bytes] = OrderedDict()
        self.lock = Lock()
        # Bound lock storage while serializing fetches for the same exposure.
        self.fetch_locks = [Lock() for _ in range(64)]

    def prepare(self, exposure: Exposure, region: Region,
                cutouts: Cutouts, renderer: Renderer) -> PreviewPixels:
        if not self.max_bytes:
            return renderer.prepare(cutouts.fetch(exposure, region), region)

        exposure_key = (exposure.release, exposure.id)
        exact_key = (*exposure_key, region)
        with self.fetch_locks[hash(exposure_key) % len(self.fetch_locks)]:
            with self.lock:
                exact = self.entries.get(exact_key)
                candidates = [] if exact is not None else [
                    (key, data) for key, data in reversed(self.entries.items())
                    if key[:2] == exposure_key and key[2].fov >= region.fov
                ]
            if exact is not None:
                candidates = [(exact_key, exact)]

            for key, data in candidates:
                try:
                    pixels = renderer.prepare(data, region, crop_cached=True) if key != exact_key else renderer.prepare(data, region)
                except (CutoutCoverageMiss, AppError):
                    continue
                with self.lock:
                    if key in self.entries:
                        self.entries.move_to_end(key)
                return pixels

            data = cutouts.fetch(exposure, region)
            pixels = renderer.prepare(data, region)
            if len(data) <= self.max_bytes:
                with self.lock:
                    self.size -= len(self.entries.pop(exact_key, b""))
                    while self.size + len(data) > self.max_bytes:
                        _, evicted = self.entries.popitem(last=False)
                        self.size -= len(evicted)
                    self.entries[exact_key] = data
                    self.size += len(data)
            return pixels

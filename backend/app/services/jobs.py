from __future__ import annotations
"""Bounded, process-local job storage. Replace for multi-worker deployment."""
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from threading import Lock, RLock
from typing import TYPE_CHECKING
from app.domain.errors import AppError
from app.domain.models import Exposure, Region


if TYPE_CHECKING:
    from app.services.search_cache import SearchCache


@dataclass
class Job:
    id: str
    region: Region
    created: float = field(default_factory=time.monotonic)
    finished: float | None = None
    status: str = "queued"
    total: int = 0
    results: list[dict] = field(default_factory=list)
    science: dict[str, bytes] = field(default_factory=dict)
    science_bytes: int = 0
    science_versions: dict[str, str] = field(default_factory=dict)
    measurement_cache: dict[tuple, dict] = field(default_factory=dict)
    extraction_lock: RLock = field(default_factory=RLock)
    exposures: list[tuple[Exposure, int]] = field(default_factory=list)
    scheduled: int = 0
    display_limits: dict[tuple[str, str, str], tuple[float, float]] = field(default_factory=dict)
    gaia_catalogue: dict | None = None
    gaia_lock: Lock = field(default_factory=Lock)
    error: dict | None = None
    lock: RLock = field(default_factory=RLock)


class LocalJobs:
    def __init__(self, max_jobs=8, ttl=1800, workers=2, search_cache: SearchCache | None = None):
        self.max_jobs, self.ttl = max_jobs, ttl
        self.search_cache = search_cache
        self.lock = RLock()
        self.items: dict[str, Job] = {}
        self.executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="frames")

    def add(self, job: Job):
        with self.lock:
            now = time.monotonic()
            for key, existing in list(self.items.items()):
                if existing.finished is not None and now - existing.finished > self.ttl:
                    del self.items[key]
            if len(self.items) >= self.max_jobs:
                raise AppError("JOB_CAPACITY_REACHED", "The server is at capacity. Please try again later.", 503, True, 30)
            self.items[job.id] = job

    def checkpoint(self, job: Job):
        if self.search_cache is not None and job.status in {"awaiting_more", "completed", "partial"}:
            self.search_cache.save(job)

    def get(self, sequence_id: str) -> Job:
        with self.lock:
            job = self.items.get(sequence_id)
            now = time.monotonic()
            expired = job is not None and job.finished is not None and now - job.finished > self.ttl
            if job is not None and not expired:
                return job
            if expired:
                del self.items[sequence_id]
            restored = self.search_cache.load(sequence_id) if self.search_cache is not None else None
            if restored is not None:
                for key, existing in list(self.items.items()):
                    if existing.finished is not None and now - existing.finished > self.ttl:
                        del self.items[key]
                if len(self.items) >= self.max_jobs:
                    # Finished searches can still be replayed without an active slot.
                    if restored.status != "awaiting_more":
                        return restored
                    raise AppError("JOB_CAPACITY_REACHED", "The server is at capacity. Please try again later.", 503, True, 30)
                self.items[sequence_id] = restored
                return restored
            if expired:
                raise AppError("SEQUENCE_EXPIRED", "The sequence has expired. Submit the query again.", 410)
            raise AppError("SEQUENCE_NOT_FOUND", "The sequence was not found or has expired.", 404)

    def close(self):
        self.executor.shutdown(wait=True, cancel_futures=True)

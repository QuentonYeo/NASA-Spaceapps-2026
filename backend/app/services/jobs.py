from __future__ import annotations
"""Expiring, process-local job storage. Replace for multi-worker deployment."""
import gzip
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from threading import Event, Lock, RLock, Thread
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
    data_source: str = "archive"
    inventory_scope: str = "archive"
    requested_exposure_ids: list[str] | None = None
    request_key: tuple | None = None
    request_group: str | None = None
    queued_at: float = field(default_factory=time.monotonic)
    cancelled: Event = field(default_factory=Event)
    future: Future | None = None
    total: int = 0
    results: list[dict] = field(default_factory=list)
    science: dict[str, bytes] = field(default_factory=dict)
    science_bytes: int = 0
    exposures: list[tuple[Exposure, int]] = field(default_factory=list)
    scheduled: int = 0
    display_limits: dict[tuple[str, str, str], tuple[float, float]] = field(default_factory=dict)
    motion: dict | None = None
    observation: dict | None = None
    measurement_lock: RLock = field(default_factory=RLock)
    automatic_measurements_running: bool = False
    gaia_catalogue: dict | None = None
    gaia_lock: Lock = field(default_factory=Lock)
    error: dict | None = None
    lock: RLock = field(default_factory=RLock)

    def science_cutout(self, frame_id: str) -> bytes | None:
        with self.lock:
            compressed = self.science.get(frame_id)
        return gzip.decompress(compressed) if compressed is not None else None


class LocalJobs:
    def __init__(self, max_jobs=None, ttl=120, workers=2, search_cache: SearchCache | None = None):
        self.max_jobs, self.ttl = max_jobs, ttl
        self.search_cache = search_cache
        self.lock = RLock()
        self.items: dict[str, Job] = {}
        self.executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="frames")
        self.measurement_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="measurements")
        self._closed = Event()
        self._reaper = Thread(target=self._expire_idle, name="job-cleanup", daemon=True)
        self._reaper.start()

    def _expire_idle(self):
        while not self._closed.wait(min(1, max(0.1, self.ttl))):
            with self.lock:
                now = time.monotonic()
                for key, job in list(self.items.items()):
                    if job.status == "queued" and now - job.queued_at > 15:
                        self.cancel(job, "SEARCH_QUEUE_TIMEOUT", "Search waited over 15 seconds for a worker. Please retry.")
                    if job.finished is not None and now - job.finished > self.ttl:
                        del self.items[key]


    def cancel(self, job: Job, code="SEARCH_SUPERSEDED", message="Replaced by a newer search from this tab."):
        with job.lock:
            job.cancelled.set()
            if job.future is not None:
                job.future.cancel()
            job.status = "failed"
            job.error = AppError(code, message, 409, code == "SEARCH_QUEUE_TIMEOUT", 1).payload()
            job.finished = time.monotonic()

    def add(self, job: Job):
        with self.lock:
            now = time.monotonic()
            for key, existing in list(self.items.items()):
                if existing.finished is not None and now - existing.finished > self.ttl:
                    del self.items[key]
            if self.max_jobs is not None and len(self.items) >= self.max_jobs:
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
                if self.max_jobs is not None and len(self.items) >= self.max_jobs:
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
        self._closed.set()
        self._reaper.join()
        self.executor.shutdown(wait=True, cancel_futures=True)
        self.measurement_executor.shutdown(wait=True, cancel_futures=True)

"""Bounded, process-local job storage. Replace for multi-worker deployment."""
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from threading import RLock
from app.domain.errors import AppError
from app.domain.models import Exposure, Region


@dataclass
class Job:
    id: str
    region: Region
    created: float = field(default_factory=time.monotonic)
    finished: float | None = None
    status: str = "queued"
    total: int = 0
    results: list[dict] = field(default_factory=list)
    exposures: list[tuple[Exposure, int]] = field(default_factory=list)
    scheduled: int = 0
    error: dict | None = None
    lock: RLock = field(default_factory=RLock)


class LocalJobs:
    def __init__(self, max_jobs=8, ttl=1800, workers=2):
        self.max_jobs, self.ttl = max_jobs, ttl
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

    def get(self, sequence_id: str) -> Job:
        with self.lock:
            job = self.items.get(sequence_id)
            if job is None:
                raise AppError("SEQUENCE_NOT_FOUND", "The sequence was not found or has expired.", 404)
            if job.finished is not None and time.monotonic() - job.finished > self.ttl:
                del self.items[sequence_id]
                raise AppError("SEQUENCE_EXPIRED", "The sequence has expired. Submit the query again.", 410)
            return job

    def close(self):
        self.executor.shutdown(wait=True, cancel_futures=True)

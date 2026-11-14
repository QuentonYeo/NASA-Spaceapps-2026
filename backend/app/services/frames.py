import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from uuid import uuid4
from app.domain.errors import AppError
from app.domain.models import Region
from app.services.interfaces import Archive, Cutouts, Renderer
from app.services.jobs import Job, LocalJobs

logger = logging.getLogger(__name__)


class FramesService:
    def __init__(self, archive: Archive, cutouts: Cutouts, renderer: Renderer,
                 jobs: LocalJobs, *, max_frames=300, visit_gap_days=10, cutout_workers=4, batch_size=12):
        self.archive, self.cutouts, self.renderer, self.jobs = archive, cutouts, renderer, jobs
        self.max_frames, self.visit_gap_days = max_frames, visit_gap_days
        self.cutout_workers = cutout_workers
        self.batch_size = batch_size
        if batch_size < 1:
            raise ValueError("batch_size must be positive")

    def start(self, region: Region) -> dict:
        job = Job(str(uuid4()), region)
        self.jobs.add(job)
        self.jobs.executor.submit(self._run, job)
        return {"sequenceId": job.id, "status": "queued",
                "pollUrl": f"/api/frames/{job.id}", "pollAfterSeconds": 1}

    def _run(self, job: Job):
        try:
            with job.lock:
                job.status = "discovering"
            exposures = sorted({f.id: f for f in self.archive.discover(job.region)}.values(), key=lambda f: (f.mjd, f.id))
            if len(exposures) > self.max_frames:
                raise AppError("FRAME_LIMIT_EXCEEDED", f"Found {len(exposures)} frames; limit is {self.max_frames}. No frames were truncated.", 422)
            visit, previous = 0, None
            grouped = []
            for exposure in exposures:
                if previous is not None and exposure.mjd - previous > self.visit_gap_days:
                    visit += 1
                previous = exposure.mjd
                grouped.append((exposure, visit))
            with job.lock:
                job.total = len(grouped)
                job.exposures = grouped
                job.scheduled = min(self.batch_size, job.total)
            self._run_batch(job, 0)
        except AppError as exc:
            with job.lock:
                job.status, job.error = "failed", exc.payload()
        except Exception:
            logger.exception("Sequence %s failed", job.id)
            with job.lock:
                job.status = "failed"
                job.error = AppError("INTERNAL_ERROR", "The sequence could not be completed.", 500).payload()
        finally:
            with job.lock:
                if job.status not in {"queued", "running", "discovering"}:
                    job.finished = time.monotonic()

    def next_batch(self, sequence_id: str, after: int) -> dict:
        job = self.jobs.get(sequence_id)
        with job.lock:
            # A repeated POST for an already reserved offset is idempotent.
            if after < job.scheduled:
                return self._accepted(job)
            if after != job.scheduled or job.status != "awaiting_more":
                raise AppError("BATCH_NOT_AVAILABLE", "The next batch is not available at this offset.", 409)
            start = job.scheduled
            job.scheduled = min(start + self.batch_size, job.total)
            job.status, job.finished = "queued", None
            self.jobs.executor.submit(self._run_batch, job, start)
            return self._accepted(job)

    @staticmethod
    def _accepted(job: Job) -> dict:
        return {"sequenceId": job.id, "status": job.status,
                "pollUrl": f"/api/frames/{job.id}", "pollAfterSeconds": 1}

    def _run_batch(self, job: Job, start: int):
        try:
            with job.lock:
                job.status = "running"
                exposures = job.exposures[start:job.scheduled]
            with ThreadPoolExecutor(max_workers=self.cutout_workers) as pool:
                futures = [pool.submit(self._frame, exposure, job.region, visit)
                           for exposure, visit in exposures]
                for future in as_completed(futures):
                    result = future.result()
                    with job.lock:
                        job.results.append(result)
            with job.lock:
                failed = sum(r["status"] == "failed" for r in job.results)
                job.status = ("awaiting_more" if job.scheduled < job.total else
                              "completed" if not failed else
                              "failed" if failed == job.total else "partial")
        except Exception:
            logger.exception("Sequence batch %s failed", job.id)
            with job.lock:
                job.status = "failed"
                job.error = AppError("INTERNAL_ERROR", "The image batch could not be completed.", 500).payload()
        finally:
            with job.lock:
                job.finished = time.monotonic()

    def _frame(self, exposure, region, visit):
        result = {"id": exposure.id, "visit": visit, "observedAtUtc": exposure.observed_at,
                  "release": exposure.release, "detector": exposure.detector, "wavelengthUm": None,
                  "sourceFitsUrl": exposure.url, "previewUrl": None, "coverage": None,
                  "status": "ready", "imageData": None, "grid": None, "display": None, "error": None}
        try:
            result.update(self.renderer.render(self.cutouts.fetch(exposure, region)))
        except AppError as exc:
            result.update(status="failed", error=exc.payload())
        except Exception:
            logger.exception("Frame %s failed", exposure.id)
            result.update(status="failed", error=AppError("FRAME_ERROR", "The frame could not be prepared.", 500).payload())
        return result

    def poll(self, sequence_id: str, after: int) -> dict:
        job = self.jobs.get(sequence_id)
        with job.lock:
            if after > len(job.results):
                raise AppError("INVALID_CURSOR", "Cursor exceeds the available results.", 400)
            batch = job.results[after:after + 10]
            ready = sum(r["status"] == "ready" for r in job.results)
            return {"sequenceId": job.id, "centerRaDeg": job.region.ra,
                    "centerDecDeg": job.region.dec, "fovDeg": job.region.fov, "grid": None,
                    "status": job.status, "nextCursor": after + len(batch),
                    "hasMore": after + len(batch) < len(job.results), "pollAfterSeconds": 1,
                    "scheduledCount": job.scheduled, "remaining": job.total - job.scheduled,
                    "batchSize": self.batch_size,
                    "progress": {"total": job.total, "ready": ready, "failed": len(job.results) - ready},
                    "frames": batch, "error": job.error}

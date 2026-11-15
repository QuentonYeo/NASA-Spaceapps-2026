import gzip
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from uuid import uuid4
from app.domain.errors import AppError
from app.domain.models import Exposure, Region
from app.services.cutout_cache import CutoutCache
from app.services.gaia import query_gaia
from app.services.interfaces import Archive, Cutouts, Renderer
from app.services.jobs import Job, LocalJobs
from app.services.movers import detect_spots, link_tracks, prioritize_exposures
from app.services.native_regions import compact_science
from app.services.motion_photometry import measure_position

logger = logging.getLogger(__name__)


class FramesService:
    def __init__(self, archive: Archive, cutouts: Cutouts, renderer: Renderer,
                 jobs: LocalJobs, *, max_frames=300, visit_gap_days=10, cutout_workers=4, batch_size=12, cutout_cache: CutoutCache | None = None, max_science_bytes=128 * 1024 * 1024):
        self.archive, self.cutouts, self.renderer, self.jobs = archive, cutouts, renderer, jobs
        self.max_frames, self.visit_gap_days = max_frames, visit_gap_days
        self.cutout_workers = cutout_workers
        self.batch_size = batch_size
        self.cutout_cache = cutout_cache
        self.max_science_bytes = max_science_bytes
        if batch_size < 1:
            raise ValueError("batch_size must be positive")

    def start(self, region: Region, *, exposure_ids: list[str] | None = None, detector: str | None = None, find_movers: bool = False, refresh: bool = False, request_group: str | None = None) -> dict:
        key = (region, tuple(sorted(exposure_ids or [])), detector, find_movers, request_group)
        with self.jobs.lock:
            if not refresh:
                existing = next((job for job in self.jobs.items.values()
                                 if job.request_key == key and job.status in {"queued", "discovering", "running"}), None)
                if existing is not None:
                    return self._accepted(existing)
            if request_group:
                for previous in list(self.jobs.items.values()):
                    if (previous.request_group == request_group and
                            (previous.status in {"queued", "discovering", "running", "awaiting_more"}
                             or previous.automatic_measurements_running)):
                        self.jobs.cancel(previous)
            job = Job(str(uuid4()), region, requested_exposure_ids=exposure_ids, request_key=key, request_group=request_group)
            if find_movers:
                job.motion = {"analyzedFrames": 0, "comparable": False, "candidates": []}
            self.jobs.add(job)
            job.future = self.jobs.executor.submit(self._run, job, frozenset(exposure_ids or ()), detector)
            return {"sequenceId": job.id, "status": "queued",
                    "pollUrl": f"/api/frames/{job.id}", "pollAfterSeconds": 1}

    def _run(self, job: Job, exposure_ids: frozenset[str], detector: str | None):
        try:
            if job.cancelled.is_set():
                return
            if time.monotonic() - job.queued_at > 15:
                raise AppError("SEARCH_QUEUE_TIMEOUT", "Search waited over 15 seconds for a worker. Please retry.", 503, True, 1)
            with job.lock:
                job.status = "discovering"
            exposures = sorted({f.id: f for f in self.archive.discover(job.region)}.values(), key=lambda f: (f.mjd, f.id))
            if job.cancelled.is_set():
                return
            if exposure_ids:
                exposures = [frame for frame in exposures if frame.id in exposure_ids]
                if len(exposures) != len(exposure_ids):
                    raise AppError("EXAMPLE_NOT_COVERED", "Some selected exposures do not cover these coordinates. Try the example coordinates or switch to Explore.", 422)
            if detector:
                exposures = [frame for frame in exposures if frame.detector == f"SPHEREx-{detector}"]
            if len(exposures) > self.max_frames:
                raise AppError("FRAME_LIMIT_EXCEEDED", f"Found {len(exposures)} frames; limit is {self.max_frames}. No frames were truncated.", 422)
            visit, previous = 0, None
            grouped = []
            for exposure in exposures:
                if previous is not None and exposure.mjd - previous > self.visit_gap_days:
                    visit += 1
                previous = exposure.mjd
                grouped.append((exposure, visit))
            if job.motion is not None:
                grouped = prioritize_exposures(grouped)
            with job.lock:
                job.total = len(grouped)
                job.exposures = grouped
                job.scheduled = min(self._batch_limit(job), job.total)
            self._run_batch(job, 0)
        except AppError as exc:
            with job.lock:
                job.status, job.error = "failed", exc.payload()
                job.finished = time.monotonic()
        except Exception:
            logger.exception("Sequence %s failed", job.id)
            with job.lock:
                job.status = "failed"
                job.error = AppError("INTERNAL_ERROR", "The sequence could not be completed.", 500).payload()
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
            job.scheduled = min(start + self._batch_limit(job), job.total)
            job.status, job.finished = "queued", None
            job.queued_at = time.monotonic()
            job.future = self.jobs.executor.submit(self._run_batch, job, start)
            return self._accepted(job)

    @staticmethod
    def _accepted(job: Job) -> dict:
        return {"sequenceId": job.id, "status": job.status,
                "pollUrl": f"/api/frames/{job.id}", "pollAfterSeconds": 1}

    def _batch_limit(self, job: Job) -> int:
        if job.motion is None:
            return self.batch_size
        # Keep exposure triples together regardless of the regular preview batch size.
        return 12

    def _run_batch(self, job: Job, start: int):
        try:
            with job.lock:
                if job.cancelled.is_set():
                    return
                job.status = "running"
                exposures = job.exposures[start:job.scheduled]
            spots = []
            with ThreadPoolExecutor(max_workers=self.cutout_workers) as pool:
                futures = [pool.submit(self._frame, job, exposure, visit)
                           for exposure, visit in exposures]
                for future in as_completed(futures):
                    result, detected = future.result()
                    if job.cancelled.is_set():
                        return
                    if detected is not None:
                        spots.append(detected)
                    with job.lock:
                        job.results.append(result)
            if job.motion is not None:
                tracks, comparable = link_tracks(spots, job.region)
                with job.lock:
                    existing = job.motion
                    candidates = existing["candidates"] + [
                        {**track, "id": f"{start + 1}-{index}"} for index, track in enumerate(tracks, 1)
                    ]
                    job.motion = {
                        "analyzedFrames": existing["analyzedFrames"] + len(spots),
                        "comparable": existing["comparable"] or comparable,
                        "candidates": sorted(candidates, key=lambda track: track["score"], reverse=True),
                    }
            with job.lock:
                failed = sum(r["status"] == "failed" for r in job.results)
                job.status = ("awaiting_more" if job.scheduled < job.total else
                              "completed" if not failed else
                              "failed" if failed == job.total else "partial")
                self.jobs.checkpoint(job)
                job.finished = time.monotonic()
        except Exception:
            logger.exception("Sequence batch %s failed", job.id)
            with job.lock:
                job.status = "failed"
                job.error = AppError("INTERNAL_ERROR", "The image batch could not be completed.", 500).payload()
                job.finished = time.monotonic()

    def _frame(self, job, exposure, visit):
        result = {"id": exposure.id, "visit": visit, "observationGroupId": visit, "observedAtUtc": exposure.observed_at,
                  "release": exposure.release, "detector": exposure.detector, "wavelengthUm": None,
                  "sourceFitsUrl": exposure.url, "previewUrl": None, "coverage": None,
                  "scienceStatus": "unavailable", "status": "ready", "imageData": None, "grid": None, "display": None, "error": None}
        detected = None
        try:
            if job.cancelled.is_set():
                raise AppError("SEARCH_SUPERSEDED", "Replaced by a newer search.", 409)
            # Retain native science before producing any display-only reprojection.
            if self.cutout_cache is None:
                cutout = self.cutouts.fetch(exposure, job.region)
                pixels = self.renderer.prepare(cutout, job.region)
            else:
                pixels = self.cutout_cache.prepare(exposure, job.region, self.cutouts, self.renderer)
                cutout = pixels.native_fits
            science = gzip.compress(compact_science(cutout), compresslevel=1)
            with job.lock:
                if job.science_bytes + len(science) <= self.max_science_bytes:
                    job.science[exposure.id] = science
                    job.science_bytes += len(science)
                    result["scienceStatus"] = "retained"
                else:
                    result["scienceStatus"] = "retention_limit"
            group = (exposure.release, exposure.detector, pixels.unit)
            with job.lock:
                if pixels.limits[1] > pixels.limits[0]:
                    job.display_limits.setdefault(group, pixels.limits)
                shared = job.display_limits.get(group)
            result.update(self.renderer.preview(pixels, shared))
            if job.motion is not None and result.get("alignedImageData"):
                try:
                    detected = detect_spots(exposure, pixels, job.region)
                except (ValueError, TypeError, RuntimeError):
                    logger.warning("Source analysis unavailable for frame %s", exposure.id, exc_info=True)
        except AppError as exc:
            result.update(status="failed", error=exc.payload())
        except Exception:
            logger.exception("Frame %s failed", exposure.id)
            result.update(status="failed", error=AppError("FRAME_ERROR", "The frame could not be prepared.", 500).payload())
        return result, detected

    def science_for_analysis(self, job: Job, exposure: Exposure) -> bytes:
        """Return native science for a follow-up measurement, reacquiring an evicted cutout if needed."""
        existing = job.science_cutout(exposure.id)
        if existing is not None:
            return existing

        if self.cutout_cache is None:
            pixels = self.renderer.prepare(self.cutouts.fetch(exposure, job.region), job.region)
        else:
            pixels = self.cutout_cache.prepare(exposure, job.region, self.cutouts, self.renderer)
        native = pixels.native_fits
        compressed = gzip.compress(compact_science(native), compresslevel=1)
        with job.lock:
            if exposure.id not in job.science and job.science_bytes + len(compressed) <= self.max_science_bytes:
                job.science[exposure.id] = compressed
                job.science_bytes += len(compressed)
        return native

    def auto_observation(self, sequence_id: str, *, start: bool = False, rerun: bool = False) -> dict:
        job = self.jobs.get(sequence_id)
        with job.lock:
            if job.observation is not None:
                previous = job.observation["status"]
                if not start or previous == "running" or (previous == "completed" and not rerun):
                    self._ensure_candidate_measurements(job)
                    return job.observation
            ready_count = sum(frame["status"] == "ready" for frame in job.results)
            aligned_ids = {frame["id"] for frame in job.results if frame.get("alignedImageData")}
            frames = [exposure for exposure, _ in job.exposures
                      if exposure.id in job.science and exposure.id in aligned_ids]
            status = {"status": "idle", "readyFrames": ready_count, "availableFrames": len(frames),
                      "processedFrames": 0, "analyzedFrames": 0, "comparable": False,
                      "candidates": [], "error": None}
            if not start:
                return status
            if job.status not in {"completed", "partial"}:
                raise AppError("OBSERVATION_NOT_READY", "Wait for the frame downloads to finish.", 409)
            if not frames:
                raise AppError("SCIENCE_UNAVAILABLE", "Analysis needs retained FITS data. Select Start to reload this field.", 409)
            job.observation = {**status, "status": "running"}
            job.finished = None
            self.jobs.executor.submit(self._analyze_observation, job, frames)
            return job.observation

    def _analyze_observation(self, job: Job, frames: list[Exposure]):
        spots = []
        try:
            for index, exposure in enumerate(frames, 1):
                try:
                    cutout = job.science_cutout(exposure.id)
                    if cutout is not None:
                        detected = detect_spots(exposure, self.renderer.prepare(cutout, job.region), job.region)
                        if detected is not None:
                            spots.append(detected)
                except (AppError, OSError, ValueError, TypeError, RuntimeError):
                    logger.warning("Source analysis unavailable for frame %s", exposure.id, exc_info=True)
                with job.lock:
                    job.observation = {**job.observation, "processedFrames": index, "analyzedFrames": len(spots)}

            tracks, comparable = link_tracks(spots, job.region, limit=None)
            with job.lock:
                job.observation = {
                    **job.observation, "status": "completed", "comparable": comparable,
                    "candidates": [{**track, "id": str(index)} for index, track in enumerate(tracks, 1)],
                }
                job.finished = time.monotonic()
                self.jobs.checkpoint(job)
                self._ensure_candidate_measurements(job)
        except Exception:
            logger.exception("Auto observation failed for sequence %s", job.id)
            with job.lock:
                job.observation = {**job.observation, "status": "failed",
                                   "error": "Motion analysis could not finish. Try Auto observation again."}
                job.finished = time.monotonic()

    def measure_candidate(self, job: Job, candidate_id: str, radius: float = 2.5) -> dict:
        """Serialize follow-up requests per search and reuse the automatic default result."""
        with job.measurement_lock:
            analysis = job.observation or {}
            if analysis.get("status") != "completed":
                raise AppError("MOTION_ANALYSIS_NOT_READY", "Wait for Auto observation to finish before measuring a candidate.", 409)
            candidate = next((item for item in analysis.get("candidates", []) if item["id"] == candidate_id), None)
            if candidate is None:
                raise AppError("CANDIDATE_NOT_FOUND", "This candidate is not part of the completed motion analysis.", 404)
            if len(candidate["detections"]) > 10:
                raise AppError("CANDIDATE_TOO_LARGE", "This candidate has too many supporting frames to measure at once.", 422)
            cached = analysis.get("measurements", {}).get(candidate_id, {})
            if (radius == 2.5 and cached.get("status") == "completed"
                    and all(row["status"] != "unavailable" for row in cached["result"]["measurements"])):
                return cached["result"]
            exposures = {exposure.id: exposure for exposure, _ in job.exposures}
            rows = []
            for point in candidate["detections"]:
                if job.cancelled.is_set():
                    raise AppError("SEARCH_SUPERSEDED", "Replaced by a newer search.", 409)
                exposure = exposures.get(point["frameId"])
                if exposure is None:
                    raise AppError("UNKNOWN_FRAME", "A candidate position does not belong to this sequence.", 422)
                row = {"frameId": point["frameId"], "observedAtUtc": exposure.observed_at,
                       "detector": exposure.detector, "release": exposure.release,
                       "sourceFitsUrl": exposure.url, "ra": point["ra"], "dec": point["dec"],
                       "detectionSnr": point["signalToNoise"]}
                try:
                    cutout = self.science_for_analysis(job, exposure)
                    rows.append({**row, **measure_position(cutout, point["ra"], point["dec"], radius)})
                except (AppError, OSError, KeyError, TypeError, ValueError) as exc:
                    rows.append({**row, "status": "unavailable", "reason": str(exc)})
                except Exception:
                    logger.warning("Candidate measurement unavailable for frame %s", exposure.id, exc_info=True)
                    rows.append({**row, "status": "unavailable", "reason": "Native science could not be loaded or measured for this frame."})
            result = {"candidateId": candidate_id, "unit": "mJy", "processingVersion": "moving-aperture-quicklook-v1",
                      "method": "native circular aperture with local clipped-median background",
                      "radiusPixels": radius, "measurements": rows}
            if not job.automatic_measurements_running:
                if radius == 2.5:
                    with job.lock:
                        job.observation = {**job.observation, "measurements": {
                            **job.observation.get("measurements", {}), candidate_id: {
                                "status": "completed" if any(row["status"] != "unavailable" for row in rows) else "failed",
                                "result": result,
                            },
                        }}
                self.jobs.checkpoint(job)
            return result

    def _ensure_candidate_measurements(self, job: Job):
        with job.lock:
            if (job.observation or {}).get("status") != "completed" or job.automatic_measurements_running:
                return
            entries = dict(job.observation.get("measurements", {}))
            pending = [candidate["id"] for candidate in job.observation["candidates"]
                       if entries.get(candidate["id"], {}).get("status") not in {"completed", "failed"}]
            if not pending:
                return
            for candidate_id in pending:
                entries[candidate_id] = {"status": "queued"}
            job.observation = {**job.observation, "measurements": entries}
            job.automatic_measurements_running = True
            job.finished = None
            self.jobs.measurement_executor.submit(self._measure_candidates, job, pending)

    def _measure_candidates(self, job: Job, candidate_ids: list[str]):
        try:
            for candidate_id in candidate_ids:
                if job.cancelled.is_set():
                    break
                self._measurement_state(job, candidate_id, {"status": "running"})
                try:
                    result = self.measure_candidate(job, candidate_id)
                    usable = any(row["status"] != "unavailable" for row in result["measurements"])
                    entry = {"status": "completed" if usable else "failed", "result": result}
                    if not usable:
                        entry["error"] = "No usable measurements. Select Measure candidate to retry."
                except Exception:
                    logger.exception("Automatic measurement failed for candidate %s", candidate_id)
                    entry = {"status": "failed", "error": "Automatic measurement failed. Select Measure candidate to retry."}
                self._measurement_state(job, candidate_id, entry)
        finally:
            with job.lock:
                job.automatic_measurements_running = False
                job.finished = time.monotonic()
                self.jobs.checkpoint(job)

    def _measurement_state(self, job: Job, candidate_id: str, entry: dict):
        with job.lock:
            job.observation = {**job.observation, "measurements": {
                **job.observation.get("measurements", {}), candidate_id: entry,
            }}
            # Persist once when the measurement run finishes, rather than rewriting
            # every preview for each queued/running/completed candidate update.

    def gaia_sources(self, sequence_id: str) -> dict:
        job = self.jobs.get(sequence_id)
        with job.gaia_lock:
            if job.gaia_catalogue is None:
                job.gaia_catalogue = query_gaia(job.region)
            return job.gaia_catalogue

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
                    "batchSize": self._batch_limit(job),
                    "motion": job.motion,
                    "progress": {"total": job.total, "ready": ready, "failed": len(job.results) - ready},
                    "frames": batch, "error": job.error}

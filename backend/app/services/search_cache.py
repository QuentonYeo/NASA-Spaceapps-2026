"""Disk checkpoints for replaying completed image batches after a restart."""
import gzip
import json
import logging
import sqlite3
import time
from contextlib import closing
from dataclasses import asdict
from pathlib import Path
from threading import Lock

from app.domain.models import Exposure, Region

logger = logging.getLogger(__name__)


class SearchCache:
    def __init__(self, path: Path, max_bytes: int, ttl: int):
        self.path, self.max_bytes, self.ttl = path, max_bytes, ttl
        self.lock = Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.lock, self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS checkpoints (
                id TEXT PRIMARY KEY, saved REAL NOT NULL, payload BLOB NOT NULL
            )""")
            self.prune(db, time.time())

    def connect(self):
        # The caller closes each connection after its transaction.
        return closing(sqlite3.connect(self.path))

    def prune(self, db, now):
        db.execute("DELETE FROM checkpoints WHERE saved < ?", (now - self.ttl,))
        size = db.execute("SELECT coalesce(sum(length(payload)), 0) FROM checkpoints").fetchone()[0]
        while size > self.max_bytes:
            oldest, length = db.execute(
                "SELECT id, length(payload) FROM checkpoints ORDER BY saved, id LIMIT 1"
            ).fetchone()
            db.execute("DELETE FROM checkpoints WHERE id = ?", (oldest,))
            size -= length
        db.commit()

    def save(self, job):
        try:
            payload = gzip.compress(json.dumps({
                "region": asdict(job.region), "status": job.status, "total": job.total,
                "results": job.results, "scheduled": job.scheduled, "motion": job.motion,
                "observation": job.observation if (job.observation or {}).get("status") == "completed" else None,
                "exposures": [(asdict(exposure), visit) for exposure, visit in job.exposures],
                "display_limits": [[*group, *limits] for group, limits in job.display_limits.items()],
            }, separators=(",", ":")).encode(), compresslevel=1)
            if len(payload) > self.max_bytes:
                return
            with self.lock, self.connect() as db:
                now = time.time()
                db.execute("INSERT OR REPLACE INTO checkpoints VALUES (?, ?, ?)", (job.id, now, payload))
                self.prune(db, now)
        except (OSError, sqlite3.Error, ValueError, TypeError):
            logger.warning("Could not save search checkpoint", exc_info=True)

    def load(self, sequence_id):
        try:
            with self.lock, self.connect() as db:
                row = db.execute("SELECT payload FROM checkpoints WHERE id = ? AND saved >= ?",
                                 (sequence_id, time.time() - self.ttl)).fetchone()
            if row is None:
                return None
            data = json.loads(gzip.decompress(row[0]))
            from app.services.jobs import Job
            return Job(
                sequence_id, Region(**data["region"]), finished=time.monotonic(),
                status=data["status"], total=data["total"],
                results=[{**frame, "scienceStatus": "unavailable"} for frame in data["results"]],
                scheduled=data["scheduled"], motion=data.get("motion"), observation=data.get("observation"),
                exposures=[(Exposure(**exposure), visit) for exposure, visit in data["exposures"]],
                display_limits={(release, detector, unit): (low, high)
                                for release, detector, unit, low, high in data["display_limits"]},
            )
        except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
            logger.warning("Could not restore search checkpoint", exc_info=True)
            return None

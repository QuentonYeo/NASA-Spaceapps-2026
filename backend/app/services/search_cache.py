"""Disk checkpoints for previews and retained native FITS cutouts."""
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
    def __init__(self, path: Path, max_bytes: int, ttl: int, *, science_max_bytes: int = 1024 ** 3):
        self.path, self.max_bytes, self.ttl = path, max_bytes, ttl
        self.science_max_bytes = science_max_bytes
        self.lock = Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.lock, self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS checkpoints (
                id TEXT PRIMARY KEY, saved REAL NOT NULL, payload BLOB NOT NULL
            )""")
            db.execute("""CREATE TABLE IF NOT EXISTS checkpoint_science (
                sequence_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
                frame_id TEXT NOT NULL, payload BLOB NOT NULL,
                PRIMARY KEY (sequence_id, frame_id)
            )""")
            self.prune(db, time.time())

    def connect(self):
        # The caller closes each connection after its transaction.
        connection = sqlite3.connect(self.path)
        connection.execute("PRAGMA foreign_keys = ON")
        return closing(connection)

    def prune(self, db, now):
        db.execute("DELETE FROM checkpoints WHERE saved < ?", (now - self.ttl,))
        size = db.execute("SELECT coalesce(sum(length(payload)), 0) FROM checkpoints").fetchone()[0]
        while size > self.max_bytes:
            oldest, length = db.execute(
                "SELECT id, length(payload) FROM checkpoints ORDER BY saved, id LIMIT 1"
            ).fetchone()
            db.execute("DELETE FROM checkpoints WHERE id = ?", (oldest,))
            size -= length

        science = db.execute("""
            SELECT sequence_id, sum(length(checkpoint_science.payload))
            FROM checkpoint_science JOIN checkpoints ON checkpoints.id = sequence_id
            GROUP BY sequence_id ORDER BY checkpoints.saved, sequence_id
        """).fetchall()
        science_size = sum(length for _, length in science)
        for sequence_id, length in science:
            if science_size <= self.science_max_bytes:
                break
            db.execute("DELETE FROM checkpoint_science WHERE sequence_id = ?", (sequence_id,))
            science_size -= length
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
                db.execute("""
                    INSERT INTO checkpoints VALUES (?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET saved = excluded.saved, payload = excluded.payload
                """, (job.id, now, payload))
                if 0 < job.science_bytes <= self.science_max_bytes:
                    saved = {row[0] for row in db.execute(
                        "SELECT frame_id FROM checkpoint_science WHERE sequence_id = ?", (job.id,),
                    )}
                    db.executemany("INSERT INTO checkpoint_science VALUES (?, ?, ?)", (
                        (job.id, frame_id, data) for frame_id, data in job.science.items()
                        if frame_id not in saved
                    ))
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
                science = dict(db.execute("""
                    SELECT frame_id, payload FROM checkpoint_science WHERE sequence_id = ?
                """, (sequence_id,)))
            data = json.loads(gzip.decompress(row[0]))
            from app.services.jobs import Job
            return Job(
                sequence_id, Region(**data["region"]), finished=time.monotonic(),
                status=data["status"], total=data["total"],
                results=[{
                    **frame,
                    "scienceStatus": "retained" if frame["id"] in science else
                    "retention_limit" if frame.get("scienceStatus") == "retention_limit" else "unavailable",
                } for frame in data["results"]],
                science=science, science_bytes=sum(map(len, science.values())),
                scheduled=data["scheduled"], motion=data.get("motion"), observation=data.get("observation"),
                exposures=[(Exposure(**exposure), visit) for exposure, visit in data["exposures"]],
                display_limits={(release, detector, unit): (low, high)
                                for release, detector, unit, low, high in data["display_limits"]},
            )
        except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
            logger.warning("Could not restore search checkpoint", exc_info=True)
            return None

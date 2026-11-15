from app.domain.models import Region
from app.services.jobs import Job, LocalJobs


def test_default_storage_accepts_more_than_eight_jobs():
    jobs = LocalJobs()
    try:
        for index in range(12):
            jobs.add(Job(str(index), Region(1, 2, .05)))
        assert len(jobs.items) == 12
        assert jobs.ttl == 120
    finally:
        jobs.close()


def test_completed_jobs_expire_but_active_jobs_remain(monkeypatch):
    jobs = LocalJobs()
    try:
        monkeypatch.setattr("app.services.jobs.time.monotonic", lambda: 1000)
        jobs.add(Job("finished", Region(1, 2, .05), finished=879, status="completed"))
        jobs.add(Job("active", Region(1, 2, .05)))
        assert "finished" not in jobs.items
        assert jobs.get("active").id == "active"
    finally:
        jobs.close()


def test_idle_cleanup_runs_without_new_requests():
    from threading import Event
    import time
    jobs = LocalJobs(ttl=0.01)
    try:
        jobs.add(Job("idle", Region(1, 2, .05), finished=time.monotonic(), status="completed"))
        deadline = time.monotonic() + 2
        while "idle" in jobs.items and time.monotonic() < deadline:
            Event().wait(0.02)
        assert "idle" not in jobs.items
    finally:
        jobs.close()


def test_duplicate_inflight_search_uses_existing_job():
    from threading import Event
    from types import SimpleNamespace
    from app.services.frames import FramesService
    started, release = Event(), Event()
    calls = []
    def discover(region):
        calls.append(region)
        started.set()
        assert release.wait(2)
        return []
    jobs = LocalJobs()
    service = FramesService(SimpleNamespace(discover=discover), None, None, jobs)
    try:
        first = service.start(Region(1, 2, .05))
        assert started.wait(2)
        second = service.start(Region(1, 2, .05))
        assert first["sequenceId"] == second["sequenceId"]
        assert len(calls) == 1
    finally:
        release.set()
        jobs.close()


def test_queued_search_expires_before_archive_access():
    from app.services.frames import FramesService
    import time
    jobs = LocalJobs()
    try:
        job = Job("old", Region(1, 2, .05), queued_at=time.monotonic() - 16)
        FramesService(None, None, None, jobs)._run(job, frozenset(), None)
        assert job.status == "failed"
        assert job.error["code"] == "SEARCH_QUEUE_TIMEOUT"
    finally:
        jobs.close()


def test_new_query_replaces_same_tab_but_not_other_tabs():
    from threading import Event
    from types import SimpleNamespace
    from app.services.frames import FramesService
    release = Event()
    def discover(region):
        assert release.wait(3)
        return []
    jobs = LocalJobs(workers=1)
    service = FramesService(SimpleNamespace(discover=discover), None, None, jobs)
    try:
        first = service.start(Region(1, 2, .05), request_group="tab-a")
        other = service.start(Region(3, 2, .05), request_group="tab-b")
        newer = service.start(Region(4, 2, .05), request_group="tab-a")
        assert jobs.get(first["sequenceId"]).cancelled.is_set()
        assert not jobs.get(other["sequenceId"]).cancelled.is_set()
        assert not jobs.get(newer["sequenceId"]).cancelled.is_set()
    finally:
        release.set()
        jobs.close()


def test_cleanup_expires_waiting_work_at_fifteen_seconds():
    from threading import Event
    import time
    jobs = LocalJobs(ttl=.01)
    try:
        job = Job("queued", Region(1, 2, .05), queued_at=time.monotonic() - 16)
        jobs.add(job)
        assert job.cancelled.wait(2)
        assert job.error["code"] == "SEARCH_QUEUE_TIMEOUT"
        assert job.status == "failed"
    finally:
        jobs.close()

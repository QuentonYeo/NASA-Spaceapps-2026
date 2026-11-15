from threading import Event

from app.domain.models import Exposure, Region
from app.services.frames import FramesService
from app.services.jobs import Job, LocalJobs


def test_completed_search_measures_each_candidate_once_and_reuses_default(monkeypatch):
    started, release = Event(), Event()
    calls = []
    jobs = LocalJobs()
    service = FramesService(None, None, None, jobs)
    job = Job('sequence', Region(100, 20, .05), status='completed')
    job.exposures = [(Exposure(name, 'https://example.test/' + name, 60000, '2023-02-25T00:00:00Z', 'dr1', 'D6'), 0)
                     for name in ('one', 'two')]
    job.observation = {'status': 'completed', 'candidates': [
        {'id': name, 'detections': [{'frameId': name, 'ra': 100, 'dec': 20, 'signalToNoise': 15}]}
        for name in ('one', 'two')]}
    jobs.add(job)
    monkeypatch.setattr(service, 'science_for_analysis', lambda job, exposure: exposure.id)

    def measure(data, ra, dec, radius):
        calls.append((data, radius))
        started.set()
        assert release.wait(5)
        return {'status': 'measured', 'fluxMjy': 12}

    monkeypatch.setattr('app.services.frames.measure_position', measure)
    try:
        service.auto_observation(job.id)
        assert started.wait(5)
        state = service.auto_observation(job.id)
        assert state['measurements']['one']['status'] == 'running'
        assert state['measurements']['two']['status'] == 'queued'
        service.auto_observation(job.id)  # polling must not enqueue a duplicate worker
        release.set()
        jobs.executor.submit(lambda: None).result(timeout=5)
        # Wait for the measurement worker, including its final state publication.
        with job.measurement_lock:
            pass
    finally:
        release.set()
        jobs.close()
    assert calls == [('one', 2.5), ('two', 2.5)]
    entries = job.observation['measurements']
    assert all(item['status'] == 'completed' for item in entries.values())
    assert entries['one']['result']['candidateId'] == 'one'
    assert entries['two']['result']['measurements'][0]['frameId'] == 'two'
    assert service.measure_candidate(job, 'one') == entries['one']['result']
    assert calls == [('one', 2.5), ('two', 2.5)]
    service.measure_candidate(job, 'one', 3)
    assert calls[-1] == ('one', 3)


def test_interrupted_saved_measurements_resume_and_empty_results_are_retryable(monkeypatch):
    jobs = LocalJobs()
    service = FramesService(None, None, None, jobs)
    job = Job('restored', Region(100, 20, .05), status='completed')
    job.observation = {'status': 'completed', 'candidates': [{'id': 'one'}],
                       'measurements': {'one': {'status': 'running'}}}
    jobs.add(job)
    calls = []

    def measure(job, candidate):
        calls.append(candidate)
        return {'measurements': [{'status': 'unavailable'}]}

    monkeypatch.setattr(service, 'measure_candidate', measure)
    service.auto_observation(job.id)
    jobs.close()
    assert calls == ['one']
    assert job.observation['measurements']['one']['status'] == 'failed'
    assert not job.automatic_measurements_running

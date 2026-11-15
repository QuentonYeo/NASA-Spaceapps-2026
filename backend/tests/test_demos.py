import gzip
from types import SimpleNamespace

from app.services.demos import DemoStore, demo_queries, saved_searches
from app.services.frames import FramesService
from app.services.jobs import Job, LocalJobs
from app.domain.models import Exposure


def demo_job(query):
    exposures = [Exposure(key, 'https://example.test/file.fits', 60000 + i, '2025-08-01T00:00:00Z', 'spherex_dr1', 'D6')
                 for i, key in enumerate(query['exposure_ids'])]
    science = {e.id: gzip.compress(b'science') for e in exposures}
    return Job('prepared', query['region'], status='completed', total=len(exposures), scheduled=len(exposures),
               exposures=[(e, 0) for e in exposures], science=science,
               science_bytes=sum(map(len, science.values())), gaia_catalogue={'sources': [], 'limited': False},
               results=[{'id': e.id, 'status': 'ready', 'alignedImageData': 'png'} for e in exposures])


def test_exact_demo_replays_offline_but_custom_search_uses_live_route(tmp_path):
    query = demo_queries()[0]
    store = DemoStore(tmp_path)
    original = demo_job(query)
    store.save(query['id'], original)
    discovery = []
    jobs = LocalJobs()
    service = FramesService(SimpleNamespace(discover=lambda region: discovery.append(region) or []),
                            None, None, jobs, demo_store=store)
    try:
        first = service.start(query['region'], exposure_ids=query['exposure_ids'])
        second = service.start(query['region'], exposure_ids=query['exposure_ids'])
        assert first['sequenceId'] != second['sequenceId']
        assert service.poll(first['sequenceId'], 0)['dataSource'] == 'demo_cache'
        assert not discovery
        job = jobs.get(first['sequenceId'])
        assert job.science_cutout(query['exposure_ids'][0]) == b'science'
        assert job.gaia_catalogue == original.gaia_catalogue
        live = service.start(query['region'], exposure_ids=query['exposure_ids'][:1])
        jobs.executor.submit(lambda: None).result(timeout=3)
        assert discovery == [query['region']]
        assert service.poll(live['sequenceId'], 0)['dataSource'] == 'archive'
        refresh = service.start(query['region'], exposure_ids=query['exposure_ids'], refresh=True)
        jobs.executor.submit(lambda: None).result(timeout=3)
        assert service.poll(refresh['sequenceId'], 0)['dataSource'] == 'archive'
        assert len(discovery) == 2
    finally:
        jobs.close()


def test_incomplete_demo_is_never_served_as_complete(tmp_path):
    query = demo_queries()[0]
    store = DemoStore(tmp_path)
    job = demo_job(query)
    job.results.pop()
    store.save(query['id'], job)
    assert store.replay(query['region'], query['exposure_ids'], None, False) is None


def test_import_can_extract_known_exposures_from_larger_checkpoint(tmp_path):
    from app.services.search_cache import SearchCache
    query = demo_queries()[0]
    job = demo_job(query)
    extra = Exposure('other', 'https://example.test/other.fits', 60010, '', 'spherex_dr1', 'D6')
    job.exposures.append((extra, 0))
    job.results.append({'id': extra.id, 'status': 'ready', 'alignedImageData': 'png'})
    job.total += 1
    job.scheduled += 1
    cache = SearchCache(tmp_path / 'searches.sqlite3', 10**6, 3600)
    cache.save(job)
    subset = saved_searches(cache, query)[0]
    assert subset.total == len(query['exposure_ids'])
    assert {frame['id'] for frame in subset.results} == set(query['exposure_ids'])
    assert {exposure.id for exposure, _ in subset.exposures} == set(query['exposure_ids'])


def test_preparation_reuses_complete_saved_data_without_remote_calls(tmp_path):
    from app.services.search_cache import SearchCache
    from scripts.prepare_demos import prepare
    query = demo_queries()[0]
    cache = SearchCache(tmp_path / 'saved.sqlite3', 10**6, 3600)
    cache.save(demo_job(query))
    store = DemoStore(tmp_path / 'demos')
    # No service methods are available: a complete saved demo needs no network.
    result = prepare(query, store, SimpleNamespace(), cache)
    assert result is not None
    assert store.load(query['id']).science_cutout(query['exposure_ids'][0]) == b'science'


def test_bundled_known_objects_support_exact_explore_queries_without_network(tmp_path):
    import hashlib
    from pathlib import Path
    from app.services.demos import ROOT, DemoCutouts
    bundled = ROOT / 'demo' / 'known-objects' / 'frames.sqlite3'
    before = hashlib.sha256(bundled.read_bytes()).hexdigest()
    store = DemoStore(tmp_path / 'empty', bundled_path=bundled)
    total = 0
    for query in demo_queries():
        if query['id'] not in store.bundled_ids:
            continue
        job = store.replay(query['region'], None, None, False)
        assert job is not None, query['id']
        assert job.status == 'completed'
        assert len(job.science) == job.total == len(job.results)
        assert all(frame['scienceStatus'] == 'retained' for frame in job.results)
        total += job.total
        assert job.inventory_scope == ('known_object' if query['exposure_ids'] else 'archive')
    assert total == 1256
    assert hashlib.sha256(bundled.read_bytes()).hexdigest() == before

    query = demo_queries()[0]
    job = store.replay(query['region'], None, 'D6', False)
    assert job.total == 3
    assert store.replay(query['region'], None, 'D1', False) is None
    exposure = job.exposures[0][0]
    calls = []
    remote = SimpleNamespace(fetch=lambda *args: calls.append(args) or b'remote')
    provider = DemoCutouts(remote, store)
    assert provider.fetch(exposure, query['region']) == job.science_cutout(exposure.id)
    assert not calls
    from dataclasses import replace
    changed = replace(query['region'], ra=query['region'].ra + .00001)
    assert store.replay(changed, None, None, False) is None
    assert provider.fetch(exposure, changed) == b'remote'
    assert len(calls) == 1


def test_live_refresh_reuses_bundled_fits_and_discovers_full_inventory(tmp_path):
    from app.services.demos import ROOT, DemoCutouts
    from app.services.rendering import FitsRenderer
    store = DemoStore(tmp_path, bundled_path=ROOT / 'demo' / 'known-objects' / 'frames.sqlite3')
    query = demo_queries()[0]
    cached = store.bundled_load('vesta')
    discovery = []
    archive = SimpleNamespace(discover=lambda region: discovery.append(region) or [e for e, _ in cached.exposures])
    def unexpected_download(*args):
        raise AssertionError('Bundled FITS must be reused')
    cutouts = DemoCutouts(SimpleNamespace(fetch=unexpected_download), store)
    jobs = LocalJobs()
    try:
        service = FramesService(archive, cutouts, FitsRenderer(), jobs, demo_store=store)
        accepted = service.start(query['region'], refresh=True)
        jobs.get(accepted['sequenceId']).future.result(timeout=10)
        job = jobs.get(accepted['sequenceId'])
        assert job.status == 'completed'
        assert job.data_source == 'archive'
        assert len(job.science) == len(job.results) == 3
        assert discovery == [query['region']]
    finally:
        jobs.close()

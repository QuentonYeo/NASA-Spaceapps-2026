"""Pinned, explicitly prepared demo searches, separate from the expiring search cache."""
import gzip
import json
import os
import sqlite3
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

from app.domain.models import Region
from app.services.search_cache import SearchCache

ROOT = Path(__file__).resolve().parents[3]


def demo_queries():
    catalog = json.loads((ROOT / 'shared' / 'demo-examples.json').read_text(encoding='utf-8'))
    return [{**item, 'region': Region(**{key: float(value) for key, value in item['inputs'].items()}),
             'exposure_ids': ['ivo://irsa.ipac/spherex_dr1?' + key for key in item.get('exposureIds', [])]}
            for group in ('examples', 'fields') for item in catalog[group]]


def matches(job, query):
    if job.region != query['region']:
        return False
    if query['exposure_ids']:
        return {e.id for e, _ in job.exposures} == set(query['exposure_ids'])
    # Legacy checkpoints predate explicit filter provenance. Only a full-field
    # inventory can seed a suggested field; never promote a two-frame example.
    return not job.requested_exposure_ids and len(job.exposures) > 12


class DemoStore:
    def __init__(self, directory=None, *, bundled_path=None):
        self.directory = Path(directory or os.getenv('DEMO_CACHE_PATH', str(ROOT / 'backend' / '.cache' / 'demos')))
        # Explicit directories stay isolated (preparation/tests); app defaults also
        # read the tracked snapshot without copying, pruning or changing it.
        self.bundled_path = (Path(bundled_path) if bundled_path is not None else
                             ROOT / 'demo' / 'known-objects' / 'frames.sqlite3' if directory is None else None)
        self.additional = ROOT / 'demo' / 'additional-observations' if directory is None else None
        self.bundled_ids = {}
        self.bundled_cache = None
        if self.bundled_path is not None and self.bundled_path.is_file():
            index = self.bundled_path.with_name('frontend.env')
            if index.is_file():
                self.bundled_ids = json.loads(index.read_text(encoding='utf-8').strip().partition('=')[2])
                self.bundled_cache = SearchCache(self.bundled_path, 2**40, 10**12,
                                                science_max_bytes=2**40, read_only=True)

    def bundled_load(self, name):
        key = self.bundled_ids.get(name)
        job = self.bundled_cache.load(key) if key and self.bundled_cache is not None else None
        if job is None and self.additional is not None and name in {q['id'] for q in demo_queries()}:
            path = self.additional / 'prepared-fields' / (name + '.sqlite3')
            if path.is_file():
                job = SearchCache(path, 2**40, 10**12, read_only=True).load('demo-' + name)
        if job is not None and job.gaia_catalogue is None:
            path = ROOT / 'demo' / 'known-objects' / 'gaia' / (name + '.json')
            if path.is_file():
                job.gaia_catalogue = json.loads(path.read_text(encoding='utf-8'))
        return job

    def cutout(self, exposure, region):
        if self.bundled_cache is not None:
            keys = [self.bundled_ids[item['id']] for item in demo_queries()
                    if item['region'] == region and item['id'] in self.bundled_ids]
            with self.bundled_cache.connect() as db:
                for key in keys:
                    row = db.execute('SELECT payload FROM checkpoint_science WHERE sequence_id=? AND frame_id=?',
                                     (key, exposure.id)).fetchone()
                    if row is not None:
                        return gzip.decompress(row[0])
        path = self.additional / 'cutouts.sqlite3' if self.additional is not None else None
        if path is not None and path.is_file():
            with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as db:
                row = db.execute('SELECT payload FROM cutouts WHERE ra=? AND dec=? AND fov=? AND frame_id=?',
                                 (region.ra, region.dec, region.fov, exposure.id)).fetchone()
                if row is not None:
                    return gzip.decompress(row[0])
        return None

    def _cache(self, name):
        if name not in {query['id'] for query in demo_queries()}:
            raise ValueError('Unknown demo')
        # One bounded catalog entry per DB; ordinary search eviction never touches it.
        return SearchCache(self.directory / (name + '.sqlite3'), 2**40, 10**12, science_max_bytes=2**40)

    def load(self, name):
        if not (self.directory / (name + '.sqlite3')).is_file():
            return self.bundled_load(name)
        return self._cache(name).load('demo-' + name)

    def save(self, name, job):
        self._cache(name).save(replace(job, id='demo-' + name))

    def replay(self, region, exposure_ids, detector, find_movers):
        if find_movers:
            return None
        queries = [item for item in demo_queries() if item['region'] == region and
                   (not exposure_ids or set(item['exposure_ids']) == set(exposure_ids))]
        # Prefer an actual full-field snapshot over a curated exposure subset.
        queries.sort(key=lambda item: bool(item['exposure_ids']))
        for query in queries:
            job = self.load(query['id'])
            if job is None or not preview_ready(job) or len(job.science) < job.total:
                job = self.bundled_load(query['id']) or job
            if job is None or not matches(job, query) or not preview_ready(job):
                continue
            if detector:
                exposures = [(e, visit) for e, visit in job.exposures
                             if e.detector.removeprefix('SPHEREx-') == detector]
                if not exposures:
                    continue
                ids = {e.id for e, _ in exposures}
                job.exposures = exposures
                job.results = [frame for frame in job.results if frame['id'] in ids]
                job.science = {key: value for key, value in job.science.items() if key in ids}
                job.science_bytes = sum(map(len, job.science.values()))
                job.total = job.scheduled = len(exposures)
                job.observation = job.motion = None
            job.id = str(uuid4())
            job.data_source = 'demo_cache'
            if query['exposure_ids']:
                job.requested_exposure_ids = query['exposure_ids']
                if not exposure_ids:
                    job.inventory_scope = 'known_object'
            return job
        return None


class DemoCutouts:
    """Exact-region native FITS reuse on the live route, including refreshes."""
    def __init__(self, remote, store):
        self.remote, self.store = remote, store

    def fetch(self, exposure, region):
        cached = self.store.cutout(exposure, region)
        return cached if cached is not None else self.remote.fetch(exposure, region)

    def close(self):
        self.remote.close()


def preview_ready(job):
    return (job.total > 0 and job.scheduled == job.total and len(job.results) == job.total and
            len({frame['id'] for frame in job.results}) == job.total and
            all(frame['status'] == 'ready' and frame.get('alignedImageData') for frame in job.results))


def saved_searches(cache, query):
    if cache is None or not cache.path.exists():
        return []
    with sqlite3.connect(cache.path) as db:
        keys = [row[0] for row in db.execute('SELECT id FROM checkpoints ORDER BY saved DESC')]
    results = []
    wanted = set(query['exposure_ids'])
    for key in keys:
        job = cache.load(key)
        if job is None or job.region != query['region']:
            continue
        if wanted and wanted.issubset({e.id for e, _ in job.exposures}):
            science = {key: value for key, value in job.science.items() if key in wanted}
            frames = [frame for frame in job.results if frame['id'] in wanted]
            job = replace(job, exposures=[entry for entry in job.exposures if entry[0].id in wanted],
                          results=frames, total=len(wanted), scheduled=len(wanted),
                          science=science, science_bytes=sum(map(len, science.values())),
                          observation=None, motion=None, requested_exposure_ids=sorted(wanted))
            job.status = 'completed' if preview_ready(job) else 'partial'
        if matches(job, query):
            results.append(job)
    return results

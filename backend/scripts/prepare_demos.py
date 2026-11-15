"""Prepare pinned demo searches; reruns reuse every successful frame and FITS cutout."""
import argparse
import csv
import gzip
import math
import os
import sqlite3
from pathlib import Path
import time

import httpx

from app.services.demos import DemoStore, demo_queries, preview_ready, saved_searches
from app.services.frames import FramesService
from app.services.irsa.discovery import IrsaArchive
from app.services.irsa.cutouts import IrsaCutouts
from app.services.irsa.s3_cutouts import S3Cutouts
from app.services.jobs import Job, LocalJobs
from app.services.rendering import FitsRenderer
from app.services.search_cache import SearchCache
from app.services.native_regions import compact_science
from app.services.gaia import MOTION_MARGIN_DEG, SOURCE_LIMIT, query_gaia


def query_demo_gaia(region):
    """Prepare the same Gaia DR3 reference data, with a catalogue mirror fallback."""
    try:
        result = query_gaia(region)
        return {**result, 'provenance': {'catalogue': 'Gaia DR3', 'provider': 'ESA Gaia TAP',
                                       'referenceEpoch': 2016.0}}
    except Exception:
        radius_arcmin = (region.fov / math.sqrt(2) + MOTION_MARGIN_DEG) * 60
        url = 'https://vizier.cfa.harvard.edu/viz-bin/asu-tsv'
        response = httpx.get(url, params={
            '-source': 'I/355/gaiadr3', '-c': f'{region.ra} {region.dec}',
            '-c.r': str(radius_arcmin), '-c.u': 'arcmin',
            '-out': 'Source,RA_ICRS,DE_ICRS,pmRA,pmDE,Gmag', '-sort': 'Gmag',
            '-out.max': str(SOURCE_LIMIT + 1),
        }, timeout=20)
        response.raise_for_status()
        rows = [line for line in response.text.splitlines() if line.strip() and not line.startswith('#')]
        if not rows or rows[0].split('\t') != ['Source', 'RA_ICRS', 'DE_ICRS', 'pmRA', 'pmDE', 'Gmag']:
            raise ValueError('The Gaia mirror returned unexpected columns')
        sources = []
        for row in csv.DictReader(rows, delimiter='\t'):
            if not row['Source'].strip().isdigit():
                continue  # VizieR includes unit and separator rows below the header.
            try:
                source = {'sourceId': row['Source'].strip(), 'ra': float(row['RA_ICRS']),
                          'dec': float(row['DE_ICRS']), 'refEpoch': 2016.0,
                          'gMagnitude': float(row['Gmag'])}
                for output, column in (('pmRa', 'pmRA'), ('pmDec', 'pmDE')):
                    value = float(row[column]) if row[column].strip() else math.nan
                    source[output] = value if math.isfinite(value) else None
                if all(math.isfinite(source[key]) for key in ('ra', 'dec', 'gMagnitude')):
                    sources.append(source)
            except (ValueError, TypeError):
                continue
        return {'sources': sources[:SOURCE_LIMIT], 'limited': len(sources) > SOURCE_LIMIT,
                'provenance': {'catalogue': 'Gaia DR3 I/355/gaiadr3',
                               'provider': 'CDS VizieR Harvard mirror', 'url': str(response.url),
                               'referenceEpoch': 2016.0}}


class SavedCutouts:
    """Reuse retained FITS, including covered larger cutouts, before remote reads."""
    def __init__(self, cache, remote):
        self.remote = remote
        self.science = {}
        if cache is not None:
            with sqlite3.connect(cache.path) as db:
                for frame_id, payload in db.execute('SELECT frame_id, payload FROM checkpoint_science'):
                    self.science.setdefault(frame_id, []).append(payload)

    def fetch(self, exposure, region):
        for payload in self.science.get(exposure.id, []):
            try:
                return FitsRenderer().prepare(gzip.decompress(payload), region, crop_cached=True).native_fits
            except Exception:
                continue
        return self.remote.fetch(exposure, region)


def summary(query, job):
    if job is None:
        return f"{query['id']}: not prepared"
    return (f"{query['id']}: {sum(f['status'] == 'ready' for f in job.results)}/{job.total} previews, "
            f"{len(job.science)}/{job.total} science FITS, Gaia {'cached' if job.gaia_catalogue is not None else 'missing'}, "
            f"playback {'ready' if preview_ready(job) else 'incomplete'}")


def match_science_preview(service, job, exposure, frame, data):
    """Keep newly retained science and its native/aligned display grids identical."""
    pixels = service.renderer.prepare(data, job.region)
    group = (exposure.release, exposure.detector, pixels.unit)
    shared = job.display_limits.setdefault(group, pixels.limits)
    return {**frame, **service.renderer.preview(pixels, shared),
            'scienceStatus': 'retained', 'sciencePreviewMatched': True}


def prepare(query, store, service, existing, *, import_only=False, deadline=None):
    candidates = [job for job in [store.load(query['id']), *saved_searches(existing, query)] if job is not None]
    job = max(candidates, key=lambda item: (sum(f['status'] == 'ready' for f in item.results), len(item.science))) if candidates else None
    if job is None:
        if import_only:
            return None
        exposures = sorted(service.archive.discover(query['region']), key=lambda e: (e.mjd, e.id))
        if query['exposure_ids']:
            exposures = [e for e in exposures if e.id in query['exposure_ids']]
            if {e.id for e in exposures} != set(query['exposure_ids']):
                raise ValueError('The archive did not return all required demo exposures')
        if len(exposures) > service.max_frames:
            raise ValueError('Demo exceeds the frame limit')
        job = Job('preparing-' + query['id'], query['region'], status='partial', total=len(exposures),
                  exposures=[(e, 0) for e in exposures], scheduled=len(exposures),
                  requested_exposure_ids=query['exposure_ids'] or None)
        visit, previous = 0, None
        for i, exposure in enumerate(exposures):
            if previous is not None and exposure.mjd - previous > service.visit_gap_days:
                visit += 1
            job.exposures[i] = exposure, visit
            previous = exposure.mjd
    store.save(query['id'], job)
    if import_only:
        return job
    if job.gaia_catalogue is None:
        try:
            job.gaia_catalogue = query_demo_gaia(job.region)
            store.save(query['id'], job)
        except Exception as exc:
            print(f"{query['id']}: Gaia unavailable: {exc}", flush=True)
    results = {frame['id']: frame for frame in job.results}
    for exposure, visit in job.exposures:
        if deadline is not None and time.monotonic() >= deadline:
            break
        frame = results.get(exposure.id)
        if frame and frame['status'] == 'ready' and exposure.id in job.science and frame.get('sciencePreviewMatched'):
            continue
        print(f"{query['id']}: loading {exposure.id}", flush=True)
        if frame and frame['status'] == 'ready':
            try:
                data = service.science_for_analysis(job, exposure)
                if exposure.id not in job.science:
                    packed = gzip.compress(compact_science(data), compresslevel=1)
                    job.science[exposure.id] = packed
                    job.science_bytes += len(packed)
                results[exposure.id] = match_science_preview(service, job, exposure, frame, data)
            except Exception as exc:
                print(f"{query['id']}: science unavailable: {exc}", flush=True)
        else:
            results[exposure.id], _ = service._frame(job, exposure, visit)
            if results[exposure.id]['status'] == 'ready' and exposure.id in job.science:
                results[exposure.id]['sciencePreviewMatched'] = True
        job.results = [results[e.id] for e, _ in job.exposures if e.id in results]
        job.scheduled = job.total
        job.status = 'completed' if preview_ready(job) else 'partial'
        store.save(query['id'], job)
    store.save(query['id'], job)
    return job


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--only', nargs='+', choices=[item['id'] for item in demo_queries()])
    parser.add_argument('--import-only', action='store_true', help='Reuse saved data without archive requests')
    parser.add_argument('--status', action='store_true')
    parser.add_argument('--provider', choices=['irsa', 's3'], default=os.getenv('CUTOUT_PROVIDER', 'irsa'))
    parser.add_argument('--max-seconds', type=int, default=600, help='Stop between frames after this budget; rerun to resume')
    args = parser.parse_args()
    store = DemoStore()
    queries = [query for query in demo_queries() if not args.only or query['id'] in args.only]
    if args.status:
        for query in queries:
            print(summary(query, store.load(query['id'])), flush=True)
        return
    path = Path(os.getenv('SEARCH_CACHE_PATH', str(Path.home() / '.cache' / 'spherex-sky-blink' / 'searches-v1.sqlite3')))
    existing = SearchCache(path, 2**40, 10**12, science_max_bytes=2**40) if path.exists() else None
    jobs = LocalJobs()
    provider = S3Cutouts(connections=2) if args.provider == 's3' else IrsaCutouts(connections=2)
    service = FramesService(IrsaArchive(), SavedCutouts(existing, provider), FitsRenderer(), jobs, cutout_workers=1, max_science_bytes=2**30)
    deadline = time.monotonic() + args.max_seconds
    try:
        for query in queries:
            if not args.import_only and time.monotonic() >= deadline:
                break
            try:
                job = prepare(query, store, service, existing, import_only=args.import_only, deadline=deadline)
                print(summary(query, job), flush=True)
            except Exception as exc:
                print(f"{query['id']}: preparation failed: {exc}", flush=True)
    finally:
        jobs.close()
        provider.close()


if __name__ == '__main__':
    main()

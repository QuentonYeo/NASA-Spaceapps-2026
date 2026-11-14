# Backend API

Run locally from `backend/` (Docker is not required):

```sh
uv sync
uv run uvicorn app.main:app --reload
```

Open http://localhost:8000/docs to submit and inspect requests.
Use one Uvicorn worker: jobs and previews are process-local and are lost on restart.
Reloading source also restarts the process. Completed jobs expire after 30 minutes.

## Frames workflow

Submit `POST /api/frames` with JSON:

```json
{"ra": 133.79513, "dec": -7.24515, "fov": 0.05}
```

All inputs are degrees (ICRS); FOV is the square cutout side length, up to 1 degree.
Returns HTTP 202 with `sequenceId`, `pollUrl`, and `pollAfterSeconds`.
Poll `GET {pollUrl}?after=0`, then use each response's `nextCursor` as `after`.
Respect `pollAfterSeconds` and continue until status is terminal **and** `hasMore`
is false. Polling stops at `awaiting_more`, `completed`, `partial`, or `failed` once
`hasMore` is false. `awaiting_more` means the batch is finished, not the sequence.
Even after completion, more than ten results require multiple polls.
A cursor is an offset into an append-only completion log, not an observation index.
Repeating a cursor returns the same frames; merge results by frame ID and sort by
`observedAtUtc` for playback. Results may arrive out of time order.

The first request discovers all metadata but downloads only `FRAME_BATCH_SIZE`
exposures (default 12). At `awaiting_more`, `remaining` reports exposures not yet
requested. POST `/api/frames/{sequenceId}/batches` with `{"after": scheduledCount}`
to schedule the next batch, then resume polling from the previous `nextCursor`.
`scheduledCount` is the exposure reservation offset; `nextCursor` is the completion
log offset. They are not interchangeable. Repeating an already reserved batch offset
is idempotent. A future offset or an unavailable batch returns 409. Visits are
computed across the full discovered list, so batch boundaries do not create visits.
Jobs awaiting more input expire after the normal retention interval.

Each ready frame contains `imageData`, a complete `data:image/png;base64,...` value
that can be assigned directly to an image element's `src`. No image download route
or direct frontend archive access is needed. Failed frames contain a structured
`error`; discovery failures appear as a sequence-level `error`. POST acceptance is
not a guarantee of successful discovery. HTTP-level errors use the same error
shape. `Retry-After` is provided where applicable. Responses are not HTTP-cached.

Discovery includes exposures covering the center, not guaranteed full-square
coverage. Stable archive IDs remove duplicates. DR1 is queried by default; a visit
starts when the gap between consecutive exposures exceeds 10 days. Visits group
frames and never discard distinct exposures. The 300-frame limit fails the job
explicitly rather than truncating it.

These are **native-grid, unaligned discovery previews**, with transparent non-finite
pixels and per-frame percentile/asinh contrast. Each frame reports its dimensions
and display limits. They are not aligned or comparable photometric products; they
do not yet apply documented science flag masks, shared contrast, zodiacal subtraction,
local wavelength extraction, or difference processing. Sequence `grid`, coverage,
and local wavelength remain null. `sourceFitsUrl` is provenance, not an instruction
for the frontend to fetch it. FITS data is discarded after rendering; encoded PNGs
are retained with the job until expiry. No astronomical processing is imported
from the exploratory notebooks.

## Configuration

Environment variables read at app startup:

| Variable | Default | Purpose |
| --- | --- | --- |
| `IRSA_COLLECTIONS` | `spherex_dr1` | Comma-separated archive collections |
| `FRAME_BATCH_SIZE` | `12` | Exposures retrieved per explicit batch |
| `MAX_FRAMES` | `300` | Maximum unique exposures per sequence |
| `VISIT_GAP_DAYS` | `10` | Consecutive-frame gap defining a new visit |
| `CUTOUT_WORKERS` | `4` | Concurrent cutouts per running job |
| `MAX_JOBS` | `8` | Maximum retained jobs, including queued and completed |
| `JOB_TTL_SECONDS` | `1800` | Retention after completion |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated frontend origins |

Two sequence jobs execute concurrently; pending jobs are bounded by MAX_JOBS.
At capacity POST returns 503. Retryable archive reads use at most three attempts,
exponential backoff plus jitter, Retry-After, a 90-second retry budget and bounded
network timeouts. The budget is checked between operations/chunks; an in-flight
blocking read can run until its network timeout. Exhausted frame failures do not
stop other frames. Retry logic is in IRSA adapters, not routers.

This executor/store is for local development. Before multi-worker deployment,
replace it with shared persistent job storage and a worker queue. There is no
cross-job request cache, cancellation endpoint, or durable recovery yet.

## Tests

```sh
uv run pytest -q
```

Tests exercise the HTTP contract and complete background workflow with fake archive
access, plus real synthetic FITS rendering and mocked HTTP retries. They never call
IRSA and need no Docker, credentials, or external services.

Optional live adapter smoke check (one real cutout, no bulk job):

```sh
uv run python -m scripts.smoke_frames
```

## Dependencies

The router depends on the `Frames` protocol. `FramesService` coordinates discovery,
cutouts, rendering and jobs. Archive/cutout/renderer protocols and domain models
have no FastAPI dependency. `main.py` wires concrete implementations, and
`exception_handlers.py` owns HTTP error mapping. Job storage/execution is currently
a concrete local implementation; extract a storage protocol when adding a second
implementation rather than introducing unused abstraction now.

## Cutout providers and connection pooling

IRSA cutouts remain the default. To try anonymous S3 range reads in PowerShell:

```powershell
$env:CUTOUT_PROVIDER = "s3"
uv run uvicorn app.main:app --reload
```

Use `CUTOUT_PROVIDER=irsa` to switch back. Both providers return the same inline
PNG API contract. S3 reads only the spatial IMAGE section needed for the preview;
it does not fetch the PSF extension or process variance/flags. Native pixel boxes
may differ slightly at boundaries from IRSA cutouts. Neither provider aligns images.

IRSA uses one thread-safe HTTPX client per app with a connection pool sized for both
running jobs. Idle connections expire after five seconds. Connect/write timeout is
10 seconds, read inactivity timeout 25 seconds, and pool wait timeout five seconds
(all capped by the retry budget). Reuse does not eliminate upstream read timeouts;
transport errors still use bounded retries. Local pool exhaustion is reported as
`CUTOUT_CAPACITY_REACHED`, rather than attributing it to IRSA. Streams close on every
attempt and the client closes after workers drain during shutdown.

S3 uses a shared s3fs filesystem with 512 KiB block caching, 10-second connect and
25-second read timeouts. Botocore uses standard retries with at most three attempts
per S3 request; no outer retry loop is added. Unlike the IRSA provider, this bounds
each range request, not the entire multi-range cutout. Keep S3 experimental until
latency/error rates have been measured for the deployment region.

Compare a small real sample (downloads from public IRSA/S3):

```sh
uv run python -m scripts.benchmark_cutouts --count 8 --workers 4
```

This runs fresh IRSA clients, pooled IRSA, then S3 on the same exposures. Fixed
ordering and upstream caches make it indicative rather than a controlled benchmark.
`fitsBytes` is the returned FITS payload size, **not** measured S3 network traffic.

Initial local sample (eight WISE 0855 exposures, four workers): fresh IRSA 46.97 s,
pooled IRSA 16.41 s, S3 6.26 s. All rendered successfully. These are one-run results,
not a guarantee; fixed ordering, remote caching, and network variability affect them.

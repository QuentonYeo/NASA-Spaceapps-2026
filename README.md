# Sifting Skies

NASA Space Apps 2026: [Planet X and SPHEREx](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/).
Explore SPHEREx infrared observations to compare the same patch of sky across dates,
review possible moving objects, and measure selected sources. The Python backend
finds observations, retrieves FITS cutouts and runs measurements; the React frontend
provides the image viewer and analysis tools.

## What you can do

Start at Home and choose one of the app's workflows:

| Workflow | What it does |
| --- | --- |
| **Validate a known object** | Open curated examples, including Vesta, Arosa, M101 and Barnard's Star. Compare exposures with aligned blinking, Gaia reference stars and available object overlays. RW Aurigae and R Draconis also have a **Brightness over time** stellar measurement. |
| **Explore for movement** | Search by sky coordinates and field size, optionally filter by detector, then review exposures as they arrive. Use the timeline and autoplay to browse the sequence. |
| **Static analysis** | Select a stationary sky region on a native image and view its 102-channel mosaic spectrum and channel measurements. Save a selected region as a Known Object in this browser. |
| **Object detection & measurements** | Run Auto observation on retained FITS exposures to rank possible moving tracks. Review a candidate's supporting frames, measure its moving-position aperture flux, and inspect the automated measurement summary and pairwise flux comparisons. |

The Static analysis and Object detection & measurements views share the same loaded
frames. A moving-candidate flux-versus-wavelength plot is a sparse set of per-exposure
measurements; it is not a reconstructed spectrum. The stationary region spectrum is a
separate 102-channel mosaic product. See the [feature guides](features/viewer-workflows.html)
for more details and limitations.

## Prerequisites

- [uv](https://docs.astral.sh/uv/) for Python dependencies; the backend requires Python 3.13+.
- Node.js 22.12+ and npm (or a newer supported Node LTS).
- Internet access for dependency installation and live archive requests.

Docker, AWS credentials and manual Python virtual-environment activation are not required.
Run the commands below from the repository root unless a different directory is shown.

## Quick start

Requirements: Python 3.13 or newer, [uv](https://docs.astral.sh/uv/), and Node.js
22.12 or newer with npm. Internet access is needed to install dependencies and for
live archive requests. Docker and AWS credentials are not required. Run these from
the repository root:

```powershell
cd backend; uv sync
cd ../frontend; npm ci
```

Start the backend and frontend in separate terminals. Backend (from the repository
root):

```sh
cd backend
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Frontend (from the repository root):

```sh
cd frontend
npm run dev
```

Open **http://localhost:5173**. Vite proxies API requests to the backend at
**http://127.0.0.1:8000**; interactive API documentation is at
**http://127.0.0.1:8000/docs**. Stop either server with Ctrl+C.

The backend uses IRSA cutouts by default. An optional anonymous S3 range-read
provider is available with `CUTOUT_PROVIDER=s3` (PowerShell:
`$env:CUTOUT_PROVIDER = "s3"`). Discovery still uses IRSA. Restart the backend after
changing this setting. More backend settings are in
[backend/README.md](backend/README.md).

## Try the viewer

The [Known Objects frame cache](demo/known-objects/README.md) includes prepared
sequences for the Home examples. Demo and spectrum cache data are packaged in the
repository and connected/restored by the backend automatically; no cache setup script
is needed for normal app startup. Uncached observations, tiles or ranges may still
require internet access.

1. Keep the default WISE 0855 coordinates or choose the M101 tutorial preset.
2. Select **Find observations**. RA, Dec and the square field-of-view side length
   are in degrees; for example, `0.05` degrees is 3 arcminutes.
3. Images appear progressively. The backend retrieves 12 exposures per batch by
   default, and the frontend automatically requests subsequent batches and polls
   until all frames have results.
4. Browse with Previous/Next, the slider, thumbnails, or arrow keys while the
   image viewer is focused. Native, 4x and fit options control display size.
5. **Stop loading** pauses polling and prevents further batch requests.
   **Resume loading** continues the same sequence without losing received images.
   An already running backend batch may finish while stopped.

Live requests can take time, especially for locations with many exposures. These
are native-grid previews with per-frame contrast; masking, alignment and scientific
image processing are still separate work. Enlarging the previews adds no detail.

Jobs and images are stored in the backend process. Use a single Uvicorn worker.
Restarting the backend (including automatic reload after a code edit) loses jobs;
submit a new query afterward. Inactive finished batches expire after 30 minutes.
The frontend's current sequence also resets when its page is refreshed.

## Tests and checks

Backend tests (no live archive access):

```powershell
cd backend
uv run pytest -q
```

Frontend unit tests, lint and production build:

```powershell
cd frontend
npm test
npm run lint
npm run build
```

Browser tests (desktop/mobile Chromium; mock API responses, no backend needed):

```powershell
cd frontend
npm run test:e2e
```

Playwright starts Vite automatically, or reuses an existing server on port 5173.
Use `npm run test:e2e:ui` for the interactive runner and
`npm run test:e2e:report` to inspect screenshots and results.

Optional live archive check (discovers exposures, retrieves and renders one cutout):

```powershell
cd backend
uv run python -m scripts.smoke_frames
```

## Project layout

```text
backend/
  app/
    main.py                 App setup and dependency wiring
    exception_handlers.py   HTTP error mapping
    routers/                HTTP endpoints
    schemas/                API request and response models
    domain/                 Framework-independent models and errors
    services/               Frame workflow, archive adapters, rendering and jobs
  notebooks/                Standalone tutorial experiments; not runtime dependencies
  scripts/                  Live smoke check and cutout benchmark
  tests/                    Backend tests
frontend/
  src/
    api/                    Typed backend client and polling
    state/                  Sequence state and stop/resume handling
    App.tsx                 Basic observation viewer
  e2e/                      Playwright browser checks
project-planning/
  weekend-plan.html         Workstream plan and local progress tracker
```

## Updating dependencies

After pulling changes, run `uv sync` in `backend/` and `npm ci` in `frontend/`.
Add dependencies through the package manager and commit the corresponding lockfile:

```powershell
# From backend/
uv add <package>
uv add --dev <test-package>

# From frontend/
npm install <package>
npm install --save-dev <test-package>
```

See [backend/README.md](backend/README.md) and [frontend/README.md](frontend/README.md)
for API details, configuration and browser-testing notes.

Additional cached data: [spectrum cube/range cache](demo/spectrum-cache/README.md) and [additional observations](demo/additional-observations/README.md). The backend uses the immutable FITS snapshots directly and restores the packaged spectrum cache into a writable directory on first spectrum use. Missing spectrum tiles/ranges still require IRSA.

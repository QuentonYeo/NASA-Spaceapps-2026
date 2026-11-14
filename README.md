# SPHEREx Sky Blink

NASA Space Apps 2026: [Planet X and SPHEREx](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/).
Enter a sky location and browse SPHEREx observations. The Python backend discovers
exposures, retrieves cutouts and renders previews. The React frontend displays the
returned images and polls for progress.

## Prerequisites

- [uv](https://docs.astral.sh/uv/) for Python dependencies; the backend requires Python 3.13+.
- Node.js 22.12+ and npm (or a newer supported Node LTS).
- Internet access for dependency installation and live archive requests.

Docker, AWS credentials and manual Python virtual-environment activation are not required.
Run the commands below from the repository root unless a different directory is shown.

## First-time setup

```powershell
cd backend
uv sync
cd ../frontend
npm ci
```

For browser tests, also install Chromium once from `frontend/`:

```powershell
npx playwright install chromium
```

## Run locally

Use two terminals, both starting at the repository root.

**Terminal 1 - backend:**

```powershell
cd backend
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

The backend defaults to IRSA cutouts. To try S3 range reads instead, set the provider
before starting the server. S3 access is anonymous; discovery still uses IRSA.

PowerShell:

```powershell
cd backend
$env:CUTOUT_PROVIDER = "s3"
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

macOS/Linux shell:

```sh
cd backend
CUTOUT_PROVIDER=s3 uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Use `CUTOUT_PROVIDER=irsa` to switch back. Restart the backend after changing
configuration. Additional settings, including batch size and concurrency, are
listed in [backend/README.md](backend/README.md).

**Terminal 2 - frontend:**

```powershell
cd frontend
npm run dev
```

Open the Local URL printed by Vite, normally **http://localhost:5173**.
The frontend development server proxies `/api` to `http://127.0.0.1:8000`.
API documentation is available at **http://127.0.0.1:8000/docs**.
Stop either process with Ctrl+C in its terminal.

## Try the viewer

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

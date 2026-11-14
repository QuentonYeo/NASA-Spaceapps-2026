# NASA-Spaceapps-2026

SPHEREx Sky Blink — NASA Space Apps 2026, challenge
["Planet X and SPHEREx"](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/).
Enter a sky position and blink through SPHEREx images of it to spot things that
move or change.

## Layout

```
backend/            Python (uv). FastAPI app, astronomy services, notebooks
├─ app/
│  ├─ routers/      HTTP endpoints
│  └─ services/     one module per service (resolve, discover, cutouts, ...)
├─ notebooks/       data spikes and API exploration; spherex_tutorials.md links the IRSA tutorials
├─ scripts/         one-off scripts (e.g. precomputing demo targets)
└─ tests/
frontend/           React + TypeScript (Vite)
└─ src/
   ├─ api/          client for our backend
   ├─ components/   UI components
   └─ state/        app state, synced to the URL
```

The backend handles all the astronomy and data access. The frontend only
displays images, markers, and plots it gets from the backend.

## Prerequisites

- [uv](https://docs.astral.sh/uv/) (installs Python 3.13 for you if needed)
- Node.js 22+ and npm

## Setup

```sh
cd backend && uv sync        # creates backend/.venv from uv.lock
cd ../frontend && npm install
```

## Running

Backend and frontend run as separate processes, each in its own terminal.

```sh
# Python shell / scripts in the backend environment
cd backend && uv run python

# Notebooks
cd backend && uv run --with jupyter jupyter lab

# Frontend dev server (http://localhost:5173)
cd frontend && npm run dev
```

## Adding dependencies

Always add through the package manager so the lockfile stays in sync, and
commit the lockfile with the change.

```sh
cd backend && uv add <package>          # updates pyproject.toml + uv.lock
cd frontend && npm install <package>    # updates package.json + package-lock.json
```

After pulling changes from someone else, re-run `uv sync` and `npm install`.

## Checks

```sh
cd backend && uv run pytest              # after `uv add --dev pytest`
cd frontend && npm run lint && npm run build
```

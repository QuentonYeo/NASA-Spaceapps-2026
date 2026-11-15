# Known Objects frame cache

`frames.sqlite3` contains the 1,256 preloaded SPHEREx frames and their sequence
metadata for all eight Known Objects presets. Git downloads it with the repo.

Run the project's [first-time setup](../../README.md#first-time-setup), then use
the commands below from the repository root. They use a separate writable
database for the demo and leave the repository copy available for reuse.

## Backend terminal

On macOS or Linux:

```sh
mkdir -p backend/.cache
cp demo/known-objects/frames.sqlite3 backend/.cache/known-objects.sqlite3
cd backend
SEARCH_CACHE_PATH=.cache/known-objects.sqlite3 SEARCH_CACHE_TTL_SECONDS=315360000 \
  uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

On Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force backend/.cache | Out-Null
Copy-Item demo/known-objects/frames.sqlite3 backend/.cache/known-objects.sqlite3
cd backend
$env:SEARCH_CACHE_PATH = ".cache/known-objects.sqlite3"
$env:SEARCH_CACHE_TTL_SECONDS = "315360000"
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

The extended cache lifetime keeps the bundled sequences available past the
backend's usual seven-day expiry.

## Frontend terminal

On macOS or Linux:

```sh
cp demo/known-objects/frontend.env frontend/.env.preloaded.local
cd frontend
npm run dev -- --mode preloaded
```

On Windows PowerShell:

```powershell
Copy-Item demo/known-objects/frontend.env frontend/.env.preloaded.local
cd frontend
npm run dev -- --mode preloaded
```

Open the URL printed by Vite, go to **Known Objects**, and select a preset.

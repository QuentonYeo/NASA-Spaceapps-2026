# Known Objects frame cache

`frames.sqlite3` contains the 1,256 preloaded SPHEREx frames and their sequence
metadata for all eight Known Objects presets. Git downloads it with the repo.

The backend now reads this database **read only by default**. Run the normal
backend and frontend startup commands; selecting an exact preset region in Known
Objects or Explore automatically reuses the saved frames and native FITS. No
copy or frontend environment mode is needed. The native FITS are gzip-compressed
inside `checkpoint_science`, and all 1,256 frames have them.

Curated presets (Vesta, Arosa, M101 and Barnard's Star) contain selected exposures.
Explore labels those subsets and offers **Search full archive field** for the full
inventory. That live search reuses bundled FITS for matching exposure IDs and
exact regions. Changed coordinates/FOV fall back to archive loading. Spectrum
mosaic cubes and Gaia catalogues are separate data dependencies.

The optional commands below retain the original setup for explicitly using a
writable copy and fixed preloaded sequence IDs. They are unnecessary for normal
startup with automatic bundle reuse.

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

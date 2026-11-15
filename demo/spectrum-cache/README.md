# Bundled spectrum cache

This snapshot contains 5,102 existing local cache files (about 445 MiB restored):
one complete SPHEREx DR1 HiPS FITS cube plus cached byte ranges and size metadata.
It is a snapshot of previously read regions, not complete all-sky spectrum data.
An uncached region or byte range can still require an archive request.

The data is gzip-compressed into parts smaller than 48 MiB so no individual
repository file exceeds GitHub's normal file-size limit. `manifest.json` records
SHA-256 hashes and sizes for every part and restored file.

The app verifies and restores these files into the writable spectrum cache on its
first spectrum request. It never modifies these repository assets. Subsequent
requests use the normal disk cache. `SPHEREX_CUBE_CACHE` can choose a different
writable destination. Explicit custom cache instances used by tests remain
isolated from the bundle.

To restore manually from `backend/`:

```sh
uv run python -c "from app.services.bundled_spectrum import restore; print(restore('.cache/spherex-cubes'))"
```

To regenerate this snapshot from the current local cache:

```sh
uv run python -m scripts.package_spectrum_cache
```

The source is the public IRSA SPHEREx DR1 HiPS release `hips_20261026`.
See `app/services/fingerprints.py` for the upstream URL and photometry behavior.

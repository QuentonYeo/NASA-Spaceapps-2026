# SPHEREx tutorials (IRSA)

Relevant IRSA tutorial pages, in suggested reading order.

| Tutorial | Plan phase | Why it's relevant |
|---|---|---|
| [Introduction to SPHEREx Spectral Images](https://caltech-ipac.github.io/irsa-tutorials/spherex-intro/) | 1 | SIA search, collection names, MEF extensions, per-pixel wavelength, flags |
| [Download SPHEREx Spectral Image cutouts](https://caltech-ipac.github.io/irsa-tutorials/spherex-cutouts/) | 1, 2 | TAP query for images at a position, cutout URLs, parallel fetching |
| [SPHEREx PSF](https://caltech-ipac.github.io/irsa-tutorials/spherex-psf/) | 1, 3 | TAP + cutout pattern, cutout-to-parent pixel mapping, ePSF extension |
| [SPHEREx Source Discovery Tool demo](https://caltech-ipac.github.io/irsa-tutorials/spherex-source-discovery-tool-demo/) | 1, 7 | Anonymous S3 reads, background removal, reprojection, aperture photometry |
| [SPHEREx Mosaic Cubes](https://caltech-ipac.github.io/irsa-tutorials/spherex-mosaic/) | 5, 6 | Reprojecting onto a SPHEREx grid, building a band map (PAH 3.3 µm) |
| [SPHEREx HiPS All-Sky Mosaic Cubes](https://caltech-ipac.github.io/irsa-tutorials/spherex-hipscube/) | 6 | DR1 all-sky cube, FITS tile layout, per-channel access |

Source notebooks: https://github.com/Caltech-IPAC/irsa-tutorials/tree/main/tutorials/spherex

## Our scripts (image pull → PNG)

The tutorials, cut down to what the blink viewer needs. Run in order from
`backend/`; each saves its output to `notebooks/output/` (gitignored) for the
next one. Defaults use WISE 0855.

| Script | Service | What it shows |
|---|---|---|
| `find_frames.py` | resolve, discover | TAP query for frames at a position, grouping into visits, S3 path mapping |
| `read_cutout.py` | — | What's in a frame: extensions, per-pixel wavelength, flag bits and which to mask |
| `fetch_cutouts.py` | cutouts | Cutout service vs S3 partial reads, with timings; 503 retry; bounded concurrency |
| `align_diff.py` | align, diffmask | Common grid, zodi/background removal, like-with-like pair, significance map |
| `render_png.py` | render | Shared stretch, transparent bad pixels, diverging diff colours, tiny PNGs |

Needs: `astropy astroquery numpy matplotlib httpx s3fs reproject`.

Not covered yet: ePSF (PSF tutorial, Phase 3 PSF matching), HiPS cube
(Phase 6 molecule maps), aperture photometry (Phase 7 spectrum).

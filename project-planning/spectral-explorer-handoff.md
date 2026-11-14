# Spectral-only explorer rebase handoff

Branch `feature/spectral-explorer` is rebased onto pinned upstream
`0a614dd8b5cba83f6b8bbea92938a8c69ed90b93` (aligned blink).
Only the matching region backend is required; there are no mandatory catalogue
imports, files, requests, hook calls or components. No dependencies or lockfiles changed.

## Preservation and ownership

Old tip `4a33163f4615d53a6038feb7871279c924c28f94` is preserved by backup ref
`backup/spectral-explorer-before-aligned-rebase-20261114`.
The original four untracked catalogue test copies remain preserved in Git stash
`spectral-explorer-catalogue-test-copies-before-rebase`.
Latest catalogue-owned test copies and the optional aligned/catalogue App bridge
and browser case are preserved outside the repository in the temporary directory
`spectral-explorer-overlay-bridge-before-spectral-only-20261114`.
None of these catalogue files is staged or included in this branch.
The overlay owner has the exact backup location for a future optional bridge.

Explorer owns App integration, spectra client/hook/components/tests and feature
HTML. Backend science/extraction/cache remain region-spectra owned. The coordinator
owns final temporary integration and serialized local-main merges. This worktree
never changes main or pushes.

## Aligned/native behavior

Upstream aligned blink comparison eligibility, closest-wavelength default,
reference selection, add/remove, navigation, playback and contrast are preserved.
Native browse uses native IMAGE grid for drawing and WCS-projected aperture rings.
Aligned images have no drawing handlers or native overlays; controls explain how
to return to native selection. Switching modes never extracts. Selecting a spectrum
measurement stops/exits blink and selects its contributing native frame. Native
locked contrast and auto contrast both use the original native grid.

## Validation and dependencies

Checks are run with all four catalogue source files absent from `frontend/src`:
11 unit tests, clean lint, production build and 20 passing desktop/mobile browser cases.
Production JS is 251.99 kB (78.70 kB gzip). Browser
fixtures explicitly distinguish native 30x20 and aligned 48x36 grids, verify
aligned pointer gestures do not extract, and measurement selection exits playback
to the native source without extracting. Existing tests cover native geometry,
progressive exposures, stale requests, groups, missing science and viewer flow.

Backend dependency: region-spectra tip `368e008e6cd2aefbab8888839c9898ec2ce84bec`.
It retains original FITS before upstream preview preparation; native imageData/grid
and alignedImageData/alignedGrid coexist. Spectra and ring projection always use
native IMAGE WCS. Request/response contract is unchanged, documented in
`frontend/README.md` and `features/spectral-explorer.html`.

Limits remain query-centre-only discovery, bounded retained FITS, conservative
rejection of all nonzero FLAGS including SOURCE, approximate pixel-centre coverage
and local-scale circle mapping, independent-noise uncertainties, and SVG without
zoom/pan/export. Live science calibration is not validated by frontend fixtures.

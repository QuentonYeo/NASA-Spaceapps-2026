# Additional locally cached observations

`cutouts.sqlite3` preserves 222 native FITS cutouts beyond the pushed Known
Objects snapshot. Rows are keyed by exact RA, Dec, FOV, and exposure ID and retain
the public archive exposure metadata and gzip-compressed FITS bytes. Live cutout
loading reuses these files read only when those keys match.

The `prepared-fields/` snapshots preserve the older local Pinwheel field and
0.05-degree WISE field previews, Gaia data, and available analysis. These are
distinct from the complete Known Objects presets:

- Pinwheel has 144 of 246 previews and no retained FITS in that prepared snapshot.
- The older WISE field has 258 previews but no retained FITS in its prepared
  snapshot; additional native cutouts are available in `cutouts.sqlite3`.

These snapshots do not claim full archive completeness. Missing science or
previews still require archive loading. The complete Known Objects WISE preset
uses a different, 0.12-degree region and already includes all 258 native FITS.

Saved Gaia catalogues for six original regions are tracked under
`demo/known-objects/gaia/`. Their stored provenance identifies the catalogue
provider. Catalogue names are matched to their original exact preset regions;
the smaller WISE catalogue is not applied to the larger Known Objects field.

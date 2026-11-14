# Region spectra backend handoff

Frontend annotation and explorer integration belongs to the separate spectral-explorer
branch. This branch implements the backend contract; existing previews are preserved.
A reference native-pixel circle is frozen to an ICRS sky circle using the geometric
mean of local reference pixel scales. This approximation and the authoritative
sky aperture are returned explicitly. Measurements never depend on viewer navigation.

`POST /api/frames/{sequenceId}/spectra` accepts:

```json
{"sequenceId":"same-as-url","referenceFrameId":"archive-frame-id","circle":{"x":14,"y":14,"radiusPixels":2,"innerRadiusPixels":4,"outerRadiusPixels":6},"observationGroupIds":[0]}
```

The response is a snapshot of completed downloads, including unavailable results,
pending count, provenance, observation time, quality policy, usable source/background
counts and approximate coverage. Discovery is **query-centre-only**, not complete
FOV discovery. No missing exposures or wavelength samples are synthesized. Download
more batches and extract again to include later arrivals.

Science FITS bytes are retained in the process-local job (same TTL as previews),
up to 128 MiB per sequence. `scienceStatus` on each preview reports retention;
exceeding the budget preserves previews and produces an unavailable spectral result.
Restarting the server loses sequences. Both providers preserve available science
planes across the requested FOV, clipped to native detector coverage. Missing planes
or unsupported units/spectral WCS produce unavailable measurements. S3 preserves
alternate CRPIX shifts and the WCS-WAVE table without shifting table values.

The estimator is mean(IMAGE - ZODI) in the aperture minus the annulus mean,
in MJy/sr. Every nonzero FLAGS pixel is excluded in this conservative first policy,
including SOURCE. Independent variance propagates as sum(var)/N^2 for each mean;
calibration, correlated noise, and background-model systematics are excluded.
No aperture correction, PSF fitting, integrated source flux, cube, elemental
identification, or abundance inference is provided. Regions use pixel-centre
inclusion rather than fractional weights; coverage uses local pixel area and can
be approximate for tiny circles or distorted WCS. Wavelength/bandwidth are means
of local spectral WCS coordinates over accepted aperture pixels; the wavelength
range is included rather than treating a wide region as monochromatic.

Companion POST endpoints `/frames/{frameId}/coordinate` and
`/frames/{frameId}/projection` convert native preview pixels to sky coordinates
and return native boundary polygons. PNG row zero corresponds to FITS array row
zero; do not invert the displayed y coordinate.

The optional body `sequenceId` must match the URL. `referenceFrameId` and selected
group IDs must belong to the same sequence; unavailable reference science returns
409. Annulus radii may both be omitted to use 2x/3x aperture radius. Supply both to
customize them. Group IDs are zero based. `visit` remains a compatibility alias;
new frame metadata includes `observationGroupId`.

Response `region` has ra/dec (degrees), radiusArcsec/innerArcsec/outerArcsec.
`pendingFrames` is an integer count of selected discovered exposures not completed.
Measurements may be ok, partial, or unavailable. Value, uncertainty, wavelengthUm,
bandwidthUm, wavelengthRangeUm (two-number array), coverage, backgroundCoverage,
sourcePixels, backgroundPixels and mjd are nullable. Observation UTC always falls
back to discovery time if DATE-AVG is absent. All available samples include frame
and observation group IDs and archive provenance. Unavailable samples carry reasons.

Caches are process-local, expire with the sequence, and hold up to 2048 exposure
measurements per job. Keys include resolved region, fixed quality/background
settings, exposure ID, retained FITS SHA-256 and processing version. Group selection
is independent of those keys, so switching groups reuses measurements. `cacheHits`
and `processingVersion` are returned for inspection. RePOST on progressive downloads
to add new measurements; navigation and local group filtering require no request.

## Aligned blink integration

Rebased onto pinned upstream `0a614dd8b5cba83f6b8bbea92938a8c69ed90b93`.
The frame service retains original native FITS before calling the upstream
prepare/preview pipeline. Native `imageData/grid`, shared-scale previews, and
`alignedImageData/alignedGrid` are all preserved. Extraction and coordinate/ring
projection always use native IMAGE WCS; the API contract above is unchanged.
Catalogue overlays and spectral circles must use a native image, or be hidden
when displaying aligned previews. Aligned pixels must never be sent as native
extraction coordinates. The sky region remains independent of frame navigation.

Synthetic regression coverage verifies that aligned previews coexist with
unchanged retained bytes, native frame dimensions, extraction and cache reuse.
Feature behavior and limitations are also documented in
[Region spectra backend](../features/region-spectra.html).

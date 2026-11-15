# Moving-object and spectrum analysis workflow

**Status:** Proposed feature plan
**Updated:** 15 November 2026

## Goal

Make the path from a moving-source candidate to inspectable scientific measurements clear and reproducible. A user should be able to find or detect a candidate, verify that its signal moves through the observations, and then analyze measurements at the candidate's positions.

The proposed moving-object workflow has three stages within Explore:

1. **Detect** finds candidate tracks. The existing Auto observation pass is the starting point.
2. **Verify** reviews a selected candidate in the existing blink viewer. The measured-position marker and supporting frames already exist.
3. **Analyze** measures a selected target. It offers two distinct target types:
   - **Moving candidate:** follow its measured or predicted positions through individual SPHEREx exposures.
   - **Stationary sky region:** use the existing 102-channel all-sky mosaic spectrum.

**Validate** is the existing, separate workflow for prepared known-object examples. It is not another name for Verify and is not being replaced by the candidate-review stage.

The stationary mosaic result must not be described as a spectrum of a moving object. For moving candidates, measurements from individual exposures are irregular samples at local wavelengths, not necessarily a contiguous or calibrated spectrum.

## Current implementation

- Auto observation detects local peaks in retained native FITS frames, estimates local background and SNR, and links compatible peaks into candidate tracks.
- Candidate review opens the supporting frames in Aligned Blink and draws a violet circle at each measured position.
- Track summaries show detector, detection count, displacement, and elapsed time.
- Verify includes a per-candidate quick-look measurement panel below the blink image and comparison table. It measures each recorded candidate position in its supporting native FITS frame and shows aperture flux versus time, sparse flux-versus-wavelength samples, a quality table, and CSV export.
- In Verify, clicking the violet measured-position marker scrolls to that panel and starts the measurement; hovering keeps the compact marker hint.
- If a supporting science cutout is no longer retained in memory or the saved search cache, measurement reloads that exposure from the archive on demand.
- The stationary-region spectrum selects a native-image sky position and measures a separate, combined-epoch 102-channel HiPS mosaic.
- The moving-candidate measurement is linked to backend-generated candidate IDs and positions. Arbitrary image-click photometry, target-centered stacking, known-object cross-match, and PSF-matched moving-source photometry are not implemented.

## Current Explore layout

Detect, Verify, and Analyze are workflow stages inside the existing **Explore** page; they are not three new global navigation tabs. **Validate** remains the separate known-object workflow.

- **Desktop:** Explore uses a full-width vertical workspace. The viewer presents the timeline, image/blink controls, frame metadata and comparison table; Verify measurements follow below. Observation settings, stationary region controls and the 102-channel Region spectrum remain available in the same page, followed by the channel table.
- **Mobile:** Image, Spectrum and Measurements tabs switch between the viewer/Verify workflow, the stationary mosaic plot, and its channel table. The tabs are hidden on desktop. Selecting or updating a stationary sky region opens Spectrum.
- Selecting a candidate enters Verify in the viewer. The moving-candidate panel stays inline below blink review. Links between the moving-target panel and stationary-region spectrum make the two targets reachable without merging their apertures or results.

Keep this layout. The inline relationship and responsive access are implemented; gather user feedback before considering a separate Analyze route or replacing the existing navigation.

## Delivery status

- **Stage 1 — Candidate Verify handoff: implemented for user review.** Candidate selection is labelled Verify, identifies the selected candidate and blink position, and provides a return to native observations. Validate remains clearly labelled for prepared examples. This stage does not add new measurements.
- **Stage 2 — Moving-candidate quick-look: implemented for user review.** Verify can measure aperture flux at each detected position in retained native FITS frames and display flux-versus-time and sparse flux-versus-local-wavelength plots, a measurement table, and CSV export. See the limitations and measurement semantics below.
- **Stage 3 — Analysis navigation and responsive layout: implemented for user review.** Cross-links move between moving-candidate measurements and the separate stationary-region spectrum. Mobile Image, Spectrum and Measurements tabs switch the workspace view; region selection opens the spectrum.
- **Next — Known-object path search and advanced methods:** begin after the user reviews the first three stages.

## Proposed user journey

### 1. Detect

Retain the current field search and Auto observation entry point. Make the search mode explicit in the UI: **Search this field for motion**. On completion, each candidate row should summarize why it ranked, and link directly to Verify.

Future search inputs can include a known object name, orbital elements, or an ephemeris/time range. These inputs search for observations intersecting the object's predicted path, rather than only querying one fixed sky coordinate. Show the ephemeris source, time range, predicted uncertainty, and whether a result is a prediction match or a blind detection.

### 2. Verify

Keep the current Aligned Blink behavior and improve the evidence around it:

- Preserve the violet measured-position marker, candidate trajectory, time, detector, and SNR for every supporting exposure.
- Add controls to step through only the candidate's detections and to return to the full observation sequence.
- Show nearby stationary sources or a user-selected control region for comparison.
- Show frame quality and coverage at the marker: masked/invalid pixels, local background, and whether the position falls within usable image data.
- Allow a user to accept, reject, or leave a candidate unreviewed, with an optional note. Keep user assessment separate from algorithm rank.
- Let the user switch to a native-frame cutout when pixel-level flags, local wavelength, or photometry need inspection.

The marker is the measured location. If an ephemeris is available, draw the predicted position separately and report the measured-minus-predicted residual. Never silently substitute one for the other.

### 3. Analyze

Selecting **Measure candidate** carries the backend candidate ID into the inline analysis panel below the blink review. Each record is tied to the frame ID and backend-retained candidate position in that frame. Keep the observation image and comparison table visible above the measurements, and keep the stationary mosaic spectrum in its separate section on the Explore page.

#### Moving-candidate analysis

For each exposure, measure at the detected position (or at a separately identified ephemeris position for forced photometry):

- UTC observation time, detector, release, exposure/frame ID, RA/Dec, local wavelength and bandwidth.
- Background-subtracted flux, uncertainty where supported by the input variance, SNR, aperture/PSF method, and flags/coverage.
- Centroid and offset from the ephemeris when a prediction is supplied.
- A local cutout with source and background apertures, plus an optional fit/residual view.

Plots and outputs:

- **Target-centered blink/cutouts** to show that the aperture follows the object while stars remain fixed.
- **Track residual plot** (measured minus predicted position versus time) for known-object review.
- **Flux versus time** using consistent units and uncertainty bars; distinguish nondetections/upper limits from zero flux.
- **Flux versus wavelength** using the wavelength and bandpass at each source position. Retain timestamps and show disconnected/uneven sampling; do not interpolate missing channels as measured data.
- **Measurement table and CSV** with per-frame provenance, quality flags, coordinate method, photometry method, and processing version.

Begin with aperture photometry and local background as an explicitly labelled quick-look. Treat PSF fitting, uncertainty propagation, background systematics, and upper-limit calculations as a separately validated measurement implementation. The current candidate peak SNR is a detection statistic, not a flux uncertainty or calibrated measurement.

#### Stationary-region spectrum

Keep the current region selector and 102-channel mosaic spectrum in the Explore page as **Stationary sky region** analysis. Keep its existing fixed-sky behavior, combined-epoch caveats, and channel navigation. Selecting a moving candidate must not silently move this aperture or relabel the mosaic output as moving-object analysis.

## Data and processing design

1. Keep archive discovery, FITS retrieval, image processing, coordinates, and measurements in the backend. The frontend should display product metadata and science status returned by the backend.
2. Retain the source FITS arrays and headers needed for each analysis: IMAGE, VARIANCE where present, FLAGS, spatial WCS, wavelength/bandwidth solution, PSF where available, observation time, detector, and release. Do not infer a per-source wavelength from the frame-center value when local pixel WCS is available.
3. Give each measurement explicit provenance: source URL/product, frame ID, release/pipeline version, selected/predicted position, masks, aperture or PSF settings, and algorithm version.
4. Keep calibrated, clipped/dark-corrected, and raw products distinguishable when adding another archive. Product quality must be visible and comparisons should use compatible processing levels.
5. Save the candidate list and review state with the sequence checkpoint where practical. Make analysis rerunnable from saved frame IDs and settings; do not require users to reproduce an undocumented browser session.

## Inspiration from NEOSSat and CADC

Use these as product and workflow references, not as evidence that their instruments or calibrations match SPHEREx:

- The [NEOSSat mission page](https://www.asc-csa.gc.ca/eng/satellites/neossat/) frames the spacecraft around moving-object surveillance while also supporting astronomy. CADC describes NEOSSat's Track Rate mode, which is designed for moving targets, and its suitability for astrometry and photometry. This motivates making “track the target” a visible analysis concept.
- The [NEOSSat open dataset](https://data.asc-csa.gc.ca/dataset/neossat) and [CADC NEOSSat collection](https://cadcftp.cadc.hia.nrc-cnrc.gc.ca/en/neossat/) expose product distinctions. CADC documents RAW, CLEAN, COR, and CORD files with different cleaning/correction levels. Borrow the explicit product/quality selector and provenance display; do not mix NEOSSat frames into SPHEREx comparisons without a separate cross-instrument workflow.
- The [CSA NEOSSat tutorial](https://github.com/asc-csa/NEOSSAT_Tutorial) teaches archive retrieval, criteria-based filtering, FITS inspection, visualization, and preprocessing in two tutorial paths. Borrow its guided, inspectable sequence: find data, filter it, inspect the FITS metadata, then analyze. Where useful, link a reproducible notebook/export rather than hiding assumptions behind a single “Analyze” action.
- CADC's [Solar System Object Image Search (SSOIS)](https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/ssois/) and [documentation](https://www3.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/ssois/documentation.html) search by object name, orbital elements, or an observed arc and return archive images along a generated ephemeris. This is a strong pattern for a future **Find observations along this path** workflow. CADC's SSOIS supports many observatories and is not itself the SPHEREx data service.
- The SSOIS paper describes moving-object archive search and precovery: [Gwyn, Hill & Kavelaars, “The Solar System Object Search: A precovery search engine”](https://doi.org/10.1017/S1743921315002179). This supports adding archival path searches as a later feature, distinct from blind track linking in already-loaded frames.

## Delivery phases

### Phase 0 — Product and coordinate audit

- Confirm which retained FITS extensions and WCS objects are available for every analyzed frame and release.
- Verify that candidate positions map consistently between native and aligned grids, including edges and partial coverage.
- Define measurement units, null/upper-limit semantics, supported aperture sizes, quality masks, and provenance schema before exposing measurements.
- Produce a small, manually checked fixture with a known mover, stationary controls, masked pixels, and at least one low-SNR detection.

**Exit:** source-pixel position and metadata can be reconstructed from a candidate detection and original frame; known limitations are documented.

### Phase 1 — Verify handoff and evidence

- Make candidate selection state explicit: candidate, current detection, frame, and review state.
- Add candidate-only stepping, side-by-side stationary controls, quality/coverage at the marker, and measured-versus-predicted overlays when predictions exist.
- Add a clear **Analyze candidate** action while preserving the existing blink and return-to-native controls.

**Exit:** a user can follow and assess a candidate without losing its frame IDs, measurements, or current spectrum selection.

**Stage 1 review reference:** select a candidate in Explore after Auto observation completes. Confirm the Verify label and candidate summary appear, the violet marker and candidate measurements remain synchronized with blink playback, and **Return to observations** restores native browse mode. Confirm the Home **Validate** workflow still opens the prepared known-object examples with its predicted/known-position overlays.

### Phase 2 — Per-exposure moving-target quick-look

- Implement a backend measurement endpoint for a selected candidate and its supporting frames.
- Start with masked fractional-aperture photometry, local background, calibrated flux, approximate variance-plane statistical uncertainty when available, local wavelength/bandwidth, and explicit coverage/quality flags.
- Render the marked aperture, measurement table, flux-versus-time, and sparse sampled flux-versus-local-wavelength.
- Add CSV export with the full provenance and method description.

**Exit:** the same candidate and saved inputs reproduce the same per-frame measurements; incomplete or invalid samples are visible, not silently dropped.

**Stage 2 implementation checkpoint:** open an auto-detected candidate in Verify and select **Measure candidate**. Review the UTC rows, local wavelength/bandwidth, flux, uncertainty availability, coverage and quality reason. Confirm partial/unavailable measurements stay explicit, plots distinguish partial coverage, and CSV export includes frame-level provenance. Compare the displayed aperture radius and source position with the blink frames; the local background annulus is used in extraction but is not drawn yet. The uncertainty omits covariance and calibration systematics, so this is not PSF-matched or publication-grade photometry.

### Phase 3 — Stationary spectrum placement and analysis chooser

- Keep **Moving candidate** analysis inline under the full-width viewer and comparison table, with clear navigation to the stationary spectrum.
- Keep **Stationary sky region** spectrum and channel measurements in the same vertical Explore page; on mobile, expose them through Spectrum and Measurements tabs.
- Add concise cross-links between the two analysis panels without combining their data or aperture state.
- Provide cross-links and responsive tabs without combining the two measurement targets or aperture states.

**Stage 3 implementation checkpoint:** verify the spectrum link from moving-candidate analysis and the candidate link from the stationary spectrum. On mobile, confirm the tabs expose image region selection, the spectrum plot, and its measurements table; selecting or updating a region should open Spectrum.
**Exit:** users can access both analyses in the current layout and can tell at a glance whether measurements follow a moving candidate or remain fixed on the sky.

### Phase 4 — Known-object archive search and advanced methods

- Add name/orbit/ephemeris search and archive intersection for exposures along a path, including uncertainty and coverage display.
- Explore known-object cross-matching and retrieval of missed/prediscovery observations where archive access and data rights permit.
- Evaluate difference imaging, PSF-matched photometry, shift-and-stack, upper limits, and orbit/ephemeris residual products on held-out fields before ranking or scientific claims depend on them.
- Consider an optional NEOSSat archive adapter only as a separately labelled cross-mission dataset, with its own FITS processing and calibration contract.

**Exit:** a documented validation set reports completeness, false candidates, astrometric residuals, and photometric behavior for each method.

## Validation and safeguards

- Keep the existing Vesta and known-source examples as regression fixtures for marker placement and frame order.
- Compare quick-look measurements against manually inspected FITS apertures and, where applicable, IRSA's official SPHEREx spectrophotometry products. Record that extended or moving targets may require a different aperture and model.
- Test masked/flagged pixels, edges, gaps, incomplete retained science, blended sources, and large motion between frames.
- Report whether a plotted point is detected, a forced measurement, or an upper limit. Keep algorithm rank, user review, and physical interpretation as distinct fields.
- Do not claim discovery or scientific significance from a candidate rank alone. Provide frame IDs, data release, methods, and reproducible exports for follow-up.

## Deferred / out of scope for the first release

- Real-time spacecraft telemetry or guaranteed near-real-time alerts.
- Treating a sparse sequence of SPHEREx LVF samples as a continuous spectrum without validated spectral reconstruction.
- Chemical identification, abundance inference, orbit determination, or a claim that the app confirms a new object.
- Combining SPHEREx and NEOSSat pixel data as if their optics, bandpasses, calibrations, or measurement units were interchangeable.

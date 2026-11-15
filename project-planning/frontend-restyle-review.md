# Frontend restyle integration review

Reviewed after rebasing onto `aa455ac` (Polish the frontend dark theme).
The new shell uses charcoal surfaces, blue primary actions, rounded panels,
and system typography. Existing analysis components inherit parts of that theme,
but their component-specific styles have not all been updated. The initial review identified the gaps below. The follow-up consistency pass now implements shared theme variables for these components, preserves scientific overlay colors, and removes the fixed-height empty spectrum panel. The broader workflow questions remain open.

| Component | Remaining styling gap | Source |
| --- | --- | --- |
| Auto observation and Brightness over time | Their shared inner container retains the older blue border and 8 px corners, unlike the new panel surfaces. Light-curve chart grid/text styles also remain separate. | `frontend/src/App.css` (`.auto-observation`, `.light-curve-chart`); `frontend/src/components/LightCurve.tsx` |
| Motion candidate cards | Navy card backgrounds, older blue borders, dense metadata, and a separately styled selected state. | `frontend/src/MovingCandidates.tsx`; `frontend/src/App.css` (`.moving-candidates`) |
| Candidate review and measurement panel | Older navy/violet review banner, blue dividers, compact form and 10 px measurement table. Flux charts use independent hard-coded colors and typography. | `frontend/src/MovingCandidateAnalysis.tsx`; `frontend/src/App.css` (`.candidate-review-state`, `.motion-analysis`) |
| Spectrum channel controls and linked observations | The outer panel inherits the new theme, but channel buttons still use green/mint tiles and linked-frame cards retain navy backgrounds. Channel labels are particularly small. | `frontend/src/components/FingerprintExplorer.css` |
| Channel measurements | Older table borders, green selected rows, compact buttons, and a wide table requiring horizontal scrolling. | `frontend/src/components/FingerprintExplorer.tsx` (`ChannelMeasurements`); `frontend/src/components/SpectralExplorer.css` |
| Frame-marker detail cards | Tooltip surfaces retain the previous navy background, blue border, and small corner radius. Scientific overlay colors can remain distinct from action colors. | `frontend/src/components/FrameMarker.tsx`; `frontend/src/App.css` (`.marker-details`) |
| Mobile Image / Spectrum / Measurements tabs | Older navy backgrounds and mint active borders rather than the new action treatment. | `frontend/src/components/SpectralExplorer.css` (`.mobile-tabs`) |
| Missing-selection and recovery messages | Newly added recovery banner and cache/full-field actions lack a shared treatment with other loading, warning and error states. | `frontend/src/components/RegionImage.tsx`; `frontend/src/components/SpectralExplorer.css`; `frontend/src/App.tsx` |

## UX questions to resolve before styling

1. **Choose data, then choose the analysis task.** Known Objects and coordinate
   entry are two ways to select data. Should both lead to one workspace offering
   motion comparison, stellar brightness, and stationary-region spectrum, rather
   than requiring a switch to Explore for spectrum selection?
2. **Make selection an explicit action near the image.** A Select spectrum region
   action could enter native-image mode and reveal aperture controls together.
   Advanced annulus settings can remain collapsed until needed.
3. **Keep image and result connected.** Region controls currently live in a
   separate collapsible observation-settings panel. Clicking a region then scrolls
   to a spectrum panel whose fixed 900 px height also produces a large empty
   state. Decide whether results belong beside the image or in a task panel below.
4. **Explain snapshot coverage separately from readiness.** Curated exposures,
   full saved fields, missing selection coordinates, and live archive loading
   should have distinct, concise states and a clear next action.
5. **Separate scientific result types.** Moving-candidate per-exposure flux,
   stellar brightness over time, and the stationary 102-channel mosaic spectrum
   need clear names and entry points. Styling alone will not explain the
   differences.

The native radius inputs already inherit the new form styling; their principal
problem is placement and discoverability, not missing visual styling. Likewise,
the outer spectrum panel and main primary buttons are already themed.

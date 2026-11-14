# SPHEREx observation viewer

Start the backend on port 8000, then from `frontend/`:

```sh
npm install
npm run dev
```

Open the Vite URL (normally http://localhost:5173). Vite proxies `/api` to
http://127.0.0.1:8000, so the browser only calls its own origin. This is a development
proxy; production hosting must route `/api` to the backend separately.

Enter ICRS RA, Dec and FOV in degrees, then choose **Find observations**. The default
is WISE 0855, with a 0.05-degree (3 arcminute) field. Submission creates one backend
job; automatic polling merges frames by ID and sorts by observation time. Polling
honors backend delays, drains each batch, and retries transient
poll failures up to three times. POST is not automatically retried to avoid creating
duplicate jobs. New queries abort old browser requests, and unmounting stops polling.
**Stop loading** stops polling and prevents additional batch requests. The current
backend batch may finish. **Resume loading** reconnects to the same sequence and
completion cursor, preserving received images; no new discovery job is created.

Use Previous/Next, the slider, arrow keys while the viewer is focused, or the
horizontally scrolling thumbnail strip. Selected frames remain selected as earlier
observations arrive. Failed frames are listed separately. The frontend displays
inline images and metadata only; discovery/rendering remain in the backend.

The viewer defaults to **Locked by detector**, which keeps the brightness scale
fixed as more frames load. Choose **Auto per frame** to inspect individual
exposures. Wavelength at the target appears when available. Native previews are
unaligned, and different wavelengths can still show brightness changes. No
images are requested directly from IRSA or S3.

```sh
npm run build
npm run lint
npm test
```

## Browser checks and screenshots

Playwright + Chromium are installed for browser testing. From `frontend/`:

```sh
npm run test:e2e
npm run test:e2e:ui
npm run test:e2e:report
```

The runner starts Vite automatically (or reuses port 5173). Tests mock API responses,
so they need no backend and never launch archive downloads. They cover desktop and
mobile layouts, form submission, progressive polling, final-page draining, and image
navigation. Screenshots are saved after each test under `test-results/`; the HTML
report links them. Failures also retain traces. Generated artifacts are gitignored.
`npm test` continues to run only the Vitest unit tests.

On a fresh machine, run `npm install` then `npx playwright install chromium`.
Use `npx playwright test --headed --project=desktop` for a visible test browser.

## Batches and display size

The backend initially downloads 12 exposures, not the whole discovered sequence.
At `awaiting_more`, the frontend automatically requests the next batch and keeps
polling until all exposures have results. **Stop loading** pauses this loop;
**Resume loading** continues from the saved sequence and completion cursor.
The backend reports remaining exposures, selects each batch, and keeps visit labels
consistent across batches. Configure `FRAME_BATCH_SIZE` on the backend to change 12.

Display size offers native pixels, 4x, or fit-to-viewer. Scaling adds no detail.
The WISE preset uses a 3-arcminute field (about 29 pixels across); the M101 preset
uses 6 arcminutes (about 59 pixels across), matching the tutorial field size more
closely. Changing FOV changes sky coverage, not the instrument resolution.

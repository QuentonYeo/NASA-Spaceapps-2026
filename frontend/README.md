# SPHEREx observation viewer

Start the backend on port 8000, then from `frontend/`:

```sh
npm install
npm run dev
```

Open the Vite URL (normally http://localhost:5173). Vite proxies `/api` to
http://127.0.0.1:8000, so the browser only calls its own origin. This is a development
proxy; production hosting must route `/api` to the backend separately.

Home offers **Validate a known object** and **Explore for movement**. Validate
loads selected exposure IDs for Arosa, M101 or Barnard’s Star and sets up their
default comparison in Aligned Blink. Explore accepts ICRS RA, Dec and FOV in
degrees and an optional detector filter. It loads one batch at a time.
**Stop loading** stops polling. **Resume loading** reconnects to the same sequence
and cursor, and **Load next batch** requests another batch. The backend may finish
a batch already in progress.

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

## Batches and display size

The backend initially downloads 12 exposures, not the whole discovered sequence.
At `awaiting_more`, Explore waits for **Load next batch**. Validation can finish loading its small requested exposure set automatically. **Stop loading** pauses this loop;
**Resume loading** continues from the saved sequence and completion cursor.
The backend reports remaining exposures, selects each batch, and keeps visit labels
consistent across batches. Configure `FRAME_BATCH_SIZE` on the backend to change 12.

Display size offers native pixels, 4x, or fit-to-viewer. Scaling adds no detail.
The WISE preset uses a 3-arcminute field (about 29 pixels across); the M101 preset
uses 6 arcminutes (about 59 pixels across), matching the tutorial field size more
closely. Changing FOV changes sky coverage, not the instrument resolution.

## Spectral explorer

Explore retains on-demand batching, detector filters and persistent searches, and adds native sky-region selection and the 102-channel spectrum. Validate keeps its guided pairs and Gaia/Arosa overlays. Preview-only restored searches can be reloaded with Start in Explore to recover science coordinates. Current spectral contracts are documented in
[the spectral explorer documentation](../features/spectral-explorer.html).

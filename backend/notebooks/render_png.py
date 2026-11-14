"""Step 5: turn aligned frames into PNGs for the browser.

Run:  uv run python notebooks/render_png.py   (from backend/, after align_diff.py)

The tutorials display data with Firefly/Bokeh/matplotlib figures. The app
does none of that: the backend writes plain PNGs and the browser overlays
them in Aladin Lite. This is the `render` service.

Rules for a blink that doesn't lie:
- ONE stretch for every frame in a sequence. If each frame gets its own
  min/max, the background "breathes" and noise looks like change.
- Bad/missing pixels -> transparent, not black.
- Keep native resolution (~30-60 px). Let the browser upscale with
  CSS `image-rendering: pixelated`, so the PNGs stay tiny (~5-8 KB at 6') and fast
  to preload.
- Difference/significance maps use a diverging, colour-blind-safe map
  (orange/purple), centred on zero.
"""

import json

import matplotlib
import matplotlib.pyplot as plt
import numpy as np
from astropy.visualization import (
    AsinhStretch,
    ImageNormalize,
    LinearStretch,
    ManualInterval,
    PercentileInterval,
)

from find_frames import OUTPUT_DIR


def shared_limits(frames: np.ndarray, percent: float = 99.5) -> tuple[float, float]:
    """Display limits computed over ALL frames of a sequence together."""
    return PercentileInterval(percent).get_limits(frames[np.isfinite(frames)])


def render_png(
    data: np.ndarray,
    path,
    vmin: float,
    vmax: float,
    cmap: str = "gray",
    stretch=AsinhStretch(),
) -> None:
    """Write `data` as an RGBA PNG. NaN pixels become transparent.

    The grid is already top-left origin (row 0 = north, see align_diff.py),
    so rows are written as-is and PNG pixels match array indexes.
    """
    norm = ImageNormalize(interval=ManualInterval(vmin, vmax), stretch=stretch)
    colormap = matplotlib.colormaps[cmap].with_extremes(bad=(0, 0, 0, 0))
    plt.imsave(path, colormap(norm(np.ma.masked_invalid(data))))


if __name__ == "__main__":
    saved = np.load(OUTPUT_DIR / "aligned_wise0855_d6.npz")
    frames, sig = saved["frames"], saved["significance"]
    out_dir = OUTPUT_DIR / "png"
    out_dir.mkdir(exist_ok=True)

    # Blink sequence: same limits for every frame.
    vmin, vmax = shared_limits(frames)
    for i, frame in enumerate(frames):
        render_png(frame, out_dir / f"frame_{i:02d}.png", vmin, vmax)

    # Significance map: symmetric limits, linear stretch, diverging colours.
    render_png(
        sig, out_dir / "significance.png", -5, 5, cmap="PuOr_r", stretch=LinearStretch()
    )

    # The browser needs the grid WCS to place the PNGs on the sky.
    (out_dir / "wcs.json").write_text(json.dumps({"header": str(saved["grid_header"])}))

    sizes = [p.stat().st_size for p in out_dir.glob("*.png")]
    print(f"{len(sizes)} PNGs in {out_dir}, {min(sizes)}-{max(sizes)} bytes each")

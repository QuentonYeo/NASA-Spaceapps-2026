"""Native-grid discovery previews, not aligned science products."""
import base64
import io
import numpy as np
from astropy.io import fits
from PIL import Image
from app.domain.errors import AppError


class FitsRenderer:
    def render(self, cutout: bytes) -> dict:
        try:
            with fits.open(io.BytesIO(cutout), memmap=False) as hdus:
                data = np.array(hdus["IMAGE"].data, dtype=float)
            if data.ndim != 2 or not data.size:
                raise ValueError("Expected a two-dimensional image")
            valid = np.isfinite(data)
            if not valid.any():
                raise ValueError("No valid pixels")
            low, high = np.percentile(data[valid], [0.5, 99.5])
            normalized = np.clip((np.where(valid, data, low) - low) / max(high - low, 1e-12), 0, 1)
            gray = (np.arcsinh(10 * normalized) / np.arcsinh(10) * 255).astype(np.uint8)
            rgba = np.stack([gray, gray, gray, valid.astype(np.uint8) * 255], axis=-1)
            output = io.BytesIO()
            Image.fromarray(rgba).save(output, format="PNG")
            return {"imageData": "data:image/png;base64," + base64.b64encode(output.getvalue()).decode(),
                    "grid": {"width": data.shape[1], "height": data.shape[0], "orientation": "native"},
                    "display": {"stretch": "asinh", "vmin": float(low), "vmax": float(high),
                                "scope": "per-frame", "aligned": False}}
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise AppError("CUTOUT_INVALID", "The archive cutout could not be rendered.") from exc

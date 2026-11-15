"""Native FITS retention and sky-aperture geometry for the mosaic spectrum."""
import io
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from pydantic import BaseModel, ConfigDict, Field, model_validator

class Aperture(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    ra: float = Field(ge=0, lt=360)
    dec: float = Field(ge=-90, le=90)
    radiusArcsec: float = Field(gt=0, le=1800)
    innerArcsec: float = Field(gt=0, le=3600)
    outerArcsec: float = Field(gt=0, le=3600)

    @model_validator(mode="after")
    def ordered(self):
        if not self.radiusArcsec < self.innerArcsec < self.outerArcsec:
            raise ValueError("Require radius < background inner < background outer")
        return self

def compact_science(data: bytes) -> bytes:
    """Drop unused, large PSF tables without changing science planes or WCS."""
    with fits.open(io.BytesIO(data), memmap=False) as hdus:
        if not any(h.name in {"EPSF", "PSF"} for h in hdus):
            return data
        output = io.BytesIO()
        fits.HDUList([h.copy() for h in hdus if h.name not in {"EPSF", "PSF"}]).writeto(output)
        return output.getvalue()

class PixelPosition(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    x: float
    y: float

class NativeCircle(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    x: float = Field(ge=0)
    y: float = Field(ge=0)
    radiusPixels: float = Field(gt=0, le=2048)
    innerRadiusPixels: float | None = Field(default=None, gt=0, le=4096)
    outerRadiusPixels: float | None = Field(default=None, gt=0, le=4096)

    @model_validator(mode="after")
    def ordered(self):
        if (self.innerRadiusPixels is None) != (self.outerRadiusPixels is None):
            raise ValueError("Supply both annulus radii or omit both")
        if self.innerRadiusPixels is None:
            self.innerRadiusPixels = self.radiusPixels * 2
            self.outerRadiusPixels = self.radiusPixels * 3
        if self.outerRadiusPixels > 4096:
            raise ValueError("Background annulus exceeds 4096 pixels")
        if not self.radiusPixels < self.innerRadiusPixels < self.outerRadiusPixels:
            raise ValueError("Require radiusPixels < innerRadiusPixels < outerRadiusPixels")
        return self

def sky_aperture(data: bytes, circle: NativeCircle) -> Aperture:
    """Freeze native selection as a sky circle using local east/north pixel scale.

    This is a local circular approximation, not a claim that distorted pixel
    circles are exact sky circles. The returned ICRS region is authoritative.
    """
    with fits.open(io.BytesIO(data), memmap=False) as hdus:
        ny, nx = hdus["IMAGE"].data.shape
        if circle.x >= nx or circle.y >= ny:
            raise ValueError("Reference centre lies outside the retained native frame")
        wcs = WCS(hdus["IMAGE"].header).celestial
        center = wcs.pixel_to_world(circle.x, circle.y)
        sx = center.separation(wcs.pixel_to_world(circle.x + 1, circle.y)).arcsec
        sy = center.separation(wcs.pixel_to_world(circle.x, circle.y + 1)).arcsec
        scale = float(np.sqrt(sx * sy))
        return Aperture(ra=float(center.ra.deg), dec=float(center.dec.deg),
                        radiusArcsec=circle.radiusPixels*scale,
                        innerArcsec=circle.innerRadiusPixels*scale,
                        outerArcsec=circle.outerRadiusPixels*scale)

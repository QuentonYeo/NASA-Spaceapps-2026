"""Native-pixel aperture means, not point-source fluxes or resampled cubes."""
import io
import numpy as np
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS
from typing import Literal
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


def wavelength_at(hdus, x, y):
    spectral = WCS(hdus["IMAGE"].header, fobj=hdus, key="W")
    spectral.sip = None
    wave, band = spectral.pixel_to_world(x, y)
    return wave.to_value(u.um), band.to_value(u.um)


def extract(data: bytes, region: Aperture):
    with fits.open(io.BytesIO(data), memmap=False) as hdus:
        missing = [name for name in ("IMAGE", "FLAGS", "VARIANCE", "ZODI") if name not in hdus]
        if missing:
            raise ValueError("Missing science extensions: " + ", ".join(missing))
        image, flags, variance, zodi = [np.asarray(hdus[n].data) for n in ("IMAGE", "FLAGS", "VARIANCE", "ZODI")]
        if image.ndim != 2 or any(a.shape != image.shape for a in (flags, variance, zodi)):
            raise ValueError("Science planes must share a two-dimensional native grid")
        header = hdus["IMAGE"].header
        if header.get("BUNIT", "").lower().replace(" ", "") != "mjy/sr":
            raise ValueError("Unsupported or missing IMAGE unit; expected MJy/sr")
        wcs = WCS(header).celestial
        target = SkyCoord(region.ra, region.dec, unit="deg")
        yy, xx = np.indices(image.shape)
        distance = wcs.pixel_to_world(xx, yy).separation(target).arcsec
        aperture = distance <= region.radiusArcsec
        annulus = (distance >= region.innerArcsec) & (distance <= region.outerArcsec)
        # Conservative first policy: reject every flagged pixel, including SOURCE.
        valid = np.isfinite(image) & np.isfinite(zodi) & np.isfinite(variance) & (variance >= 0) & (flags == 0)
        source, background = aperture & valid, annulus & valid
        ns, nb = int(source.sum()), int(background.sum())
        scale_area = abs(np.linalg.det(wcs.pixel_scale_matrix)) * 3600**2
        if not np.isfinite(scale_area) or scale_area <= 0:
            raise ValueError("Invalid spatial pixel scale")
        expected = np.pi * region.radiusArcsec**2 / scale_area
        expected_bg = np.pi * (region.outerArcsec**2 - region.innerArcsec**2) / scale_area
        result = dict(sourcePixels=ns, backgroundPixels=nb,
                      apertureInFramePixels=int(aperture.sum()), annulusInFramePixels=int(annulus.sum()),
                      sourceFlaggedPixels=int((aperture & (flags != 0)).sum()),
                      backgroundFlaggedPixels=int((annulus & (flags != 0)).sum()),
                      pipelineVersion=str(hdus[0].header.get("VERSION", "unknown")),
                      coverage=min(1., ns / expected), backgroundCoverage=min(1., nb / expected_bg),
                      coverageMethod="Approximate valid pixel count / circular sky area at local pixel scale; pixel-centre inclusion, no fractional weights",
                      qualityPolicy="Reject all nonzero FLAGS; finite IMAGE/ZODI/VARIANCE; variance >= 0",
                      unit="MJy/sr", estimator="mean(IMAGE-ZODI) aperture minus annulus mean",
                      value=None, uncertainty=None, wavelengthUm=None, bandwidthUm=None,
                      observedAtUtc=header.get("DATE-AVG"), mjd=header.get("MJD-AVG"),
                      status="unavailable", reasons=[])
        if ns == 0 or nb == 0:
            result["reasons"].append("No usable aperture or background pixels")
            return result
        corrected = image.astype(float) - zodi.astype(float)
        result["value"] = float(corrected[source].mean() - corrected[background].mean())
        result["uncertainty"] = float(np.sqrt(variance[source].astype(float).sum()/ns**2 + variance[background].astype(float).sum()/nb**2))
        if not np.isfinite([result["value"], result["uncertainty"]]).all():
            result.update(value=None, uncertainty=None)
            result["reasons"].append("Non-finite measurement or propagated variance")
            return result
        # Sample local wavelength at each accepted source pixel; no invented band centres.
        try:
            sy, sx = np.where(source)
            values = np.asarray(wavelength_at(hdus, sx.astype(float), sy.astype(float))).T
            if not np.isfinite(values).all() or (values <= 0).any():
                raise ValueError("Invalid spectral coordinates")
            result["wavelengthUm"], result["bandwidthUm"] = values.mean(axis=0).tolist()
            result["wavelengthRangeUm"] = [float(values[:, 0].min()), float(values[:, 0].max())]
        except Exception:
            result.update(value=None, uncertainty=None)
            result["reasons"].append("Spectral WCS unavailable or unsupported")
            return result
        result["status"] = "partial" if result["coverage"] < .95 or result["backgroundCoverage"] < .95 or ns < aperture.sum() or nb < annulus.sum() else "ok"
        if result["status"] == "partial":
            result["reasons"].append("Incomplete or masked aperture/background coverage")
        return result


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


class SpectrumQuery(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    sequenceId: str | None = Field(default=None, min_length=1, max_length=128)
    referenceFrameId: str = Field(min_length=1, max_length=2048)
    circle: NativeCircle
    observationGroupIds: list[int] = Field(min_length=1, max_length=300)

    @model_validator(mode="after")
    def groups(self):
        if any(group < 0 for group in self.observationGroupIds):
            raise ValueError("observationGroupIds must be nonnegative")
        self.observationGroupIds = sorted(set(self.observationGroupIds))
        return self


PROCESSING_VERSION = "native-aperture-mean-v1"
QUALITY_POLICY = "all-nonzero-flags;zodi-subtracted;independent-variance;pixel-centres"


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


def sequence_spectrum(job, query: SpectrumQuery) -> dict:
    from app.domain.errors import AppError
    if query.sequenceId is not None and query.sequenceId != job.id:
        raise AppError("SEQUENCE_MISMATCH", "Body sequenceId does not match the URL sequence.", 422)
    with job.lock:
        reference = job.science.get(query.referenceFrameId)
        if reference is None:
            raise AppError("REFERENCE_UNAVAILABLE", "Reference frame science data is unavailable in this sequence.", 409)
        known_groups = {group for _, group in job.exposures}
        if not set(query.observationGroupIds) <= known_groups:
            raise AppError("INVALID_OBSERVATION_GROUP", "Observation group does not belong to this sequence.", 422)
        frames = [(r.copy(), job.science.get(r["id"]), job.science_versions.get(r["id"]))
                  for r in job.results if r["visit"] in query.observationGroupIds]
        selected_total = sum(group in query.observationGroupIds for _, group in job.exposures)
    try:
        aperture = sky_aperture(reference, query.circle)
    except (ValueError, KeyError, OSError, TypeError) as exc:
        raise AppError("INVALID_REFERENCE_REGION", str(exc), 422) from exc
    region_key = tuple(aperture.model_dump().values())
    samples = []
    hits = 0
    # Serializes duplicate extraction requests for this sequence, without blocking
    # preview downloads or holding the job lock during WCS calculations.
    with job.extraction_lock:
        for frame, data, fingerprint in frames:
            key = (PROCESSING_VERSION, QUALITY_POLICY, region_key, frame["id"], fingerprint)
            with job.lock:
                measurement = job.measurement_cache.get(key)
            if measurement is not None:
                hits += 1
            else:
                try:
                    if data is None:
                        raise ValueError("Science unavailable: failed download or 128 MiB retention budget exceeded")
                    measurement = extract(data, aperture)
                except (ValueError, KeyError, OSError, TypeError) as exc:
                    measurement = dict(status="unavailable", reasons=[str(exc)], value=None,
                                       uncertainty=None, wavelengthUm=None, bandwidthUm=None)
                if data is not None:
                    with job.lock:
                        if len(job.measurement_cache) >= 2048:
                            job.measurement_cache.pop(next(iter(job.measurement_cache)))
                        job.measurement_cache[key] = measurement
            nullable = dict(value=None, uncertainty=None, wavelengthUm=None, bandwidthUm=None,
                            wavelengthRangeUm=None, coverage=None, backgroundCoverage=None,
                            sourcePixels=None, backgroundPixels=None, mjd=None)
            sample = {**nullable, "unit": "MJy/sr", **measurement, "frameId": frame["id"], "observationGroupId": frame["visit"],
                      "observedAtUtc": measurement.get("observedAtUtc") or frame["observedAtUtc"],
                      "sourceFitsUrl": frame["sourceFitsUrl"]}
            samples.append(sample)
    samples.sort(key=lambda sample: (sample["observedAtUtc"], sample["frameId"]))
    return dict(sequenceId=job.id, referenceFrameId=query.referenceFrameId,
                circle=query.circle.model_dump(), region=aperture.model_dump(),
                regionMapping="ICRS sky circle; radius uses geometric mean of local reference pixel scales",
                observationGroupIds=query.observationGroupIds,
                observationGrouping="ten-day-gap heuristic, not verified orbital passes",
                discoveryScope="query-centre-only", pendingFrames=selected_total-len(frames),
                processingVersion=PROCESSING_VERSION, cacheHits=hits, samples=samples,
                uncertaintyNote="Independent pixel variance only; excludes calibration, correlated noise and background-model systematics. No aperture correction.")


class SpectrumSample(BaseModel):
    model_config = ConfigDict(extra="allow", allow_inf_nan=False)
    frameId: str
    observationGroupId: int
    observedAtUtc: str
    sourceFitsUrl: str
    status: Literal["ok", "partial", "unavailable"]
    reasons: list[str]
    unit: Literal["MJy/sr"] = "MJy/sr"
    value: float | None = None
    uncertainty: float | None = None
    wavelengthUm: float | None = None
    bandwidthUm: float | None = None
    wavelengthRangeUm: tuple[float, float] | None = None
    coverage: float | None = None
    backgroundCoverage: float | None = None
    sourcePixels: int | None = None
    backgroundPixels: int | None = None
    mjd: float | None = None


class SpectrumResponse(BaseModel):
    sequenceId: str
    referenceFrameId: str
    circle: NativeCircle
    region: Aperture
    regionMapping: str
    observationGroupIds: list[int]
    observationGrouping: str
    discoveryScope: Literal["query-centre-only"]
    pendingFrames: int
    processingVersion: str
    cacheHits: int
    samples: list[SpectrumSample]
    uncertaintyNote: str
